import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import { resolve } from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const {
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_ACCOUNT_ID
} = process.env;

interface ScrapedJob {
  jk: string;
  title: string;
  company: string;
  location: string;
  salary: string;
  snippet: string;
  description: string;
  url: string;
  source: 'indeed' | 'google';
  scrapedAt: string;
}

// All keywords we look for in job descriptions
const KEYWORDS_TO_CHECK = [
  'golang', 'go', 'react', 'nextjs', 'next.js', 'python', 'fastapi', 'django',
  'laravel', 'php', 'mobile', 'react-native', 'expo', 'flutter', 'aws', 'cloud',
  'nodejs', 'express', 'postgresql', 'postgres', 'mongodb', 'mongo', 'sql',
  'tailwind', 'typescript', 'ts', 'javascript', 'js', 'docker', 'devops',
  'kubernetes', 'k8s', 'redis', 'graphql', 'nest.js', 'nestjs', 'vue', 'angular',
  'ci/cd', 'github actions', 'stripe', 'firebase', 'supabase', 'prisma', 'drizzle'
];

// Keywords currently supported/present in our CV's default pools (Summary, Experience, Projects, Skills)
const SUPPORTED_CV_KEYWORDS = new Set([
  'golang', 'go', 'react', 'nextjs', 'next.js', 'python', 'fastapi',
  'laravel', 'php', 'mobile', 'react-native', 'expo', 'aws', 'cloud',
  'nodejs', 'express', 'postgresql', 'postgres', 'mongodb', 'mongo', 'sql',
  'tailwind', 'typescript', 'ts', 'javascript', 'js', 'docker', 'devops',
  'redis', 'graphql', 'ci/cd', 'github actions', 'stripe', 'firebase', 'supabase',
  'prisma', 'drizzle', 'fargate', 'ec2', 's3', 'alb', 'puppeteer', 'selenium',
  'scraping', 'murn', 'mui', 'shadcn', 'html', 'css',
  'vue', 'angular', 'django', 'kubernetes', 'k8s', 'nestjs', 'nest.js', 'flutter'
]);

function analyzeJob(job: ScrapedJob) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  
  // Find demanded keywords from the job description
  const demanded = KEYWORDS_TO_CHECK.filter(kw => {
    if (kw === 'go') {
      return /\bgo\b/i.test(text);
    }
    if (kw === 'ts') {
      return /\bts\b/i.test(text);
    }
    if (kw === 'js') {
      return /\bjs\b/i.test(text);
    }
    return text.includes(kw);
  });

  // Check how many of the demanded keywords are supported by our CV
  const covered = demanded.filter(kw => {
    // Normalize aliases (e.g. postgres -> postgresql)
    let checkKw = kw;
    if (kw === 'postgres') checkKw = 'postgresql';
    if (kw === 'mongo') checkKw = 'mongodb';
    if (kw === 'next.js') checkKw = 'nextjs';
    if (kw === 'react-native') checkKw = 'mobile';
    if (kw === 'ts') checkKw = 'typescript';
    if (kw === 'js') checkKw = 'javascript';
    if (kw === 'k8s') checkKw = 'kubernetes';
    if (kw === 'nest.js') checkKw = 'nestjs';
    
    return SUPPORTED_CV_KEYWORDS.has(checkKw);
  });

  const missing = demanded.filter(kw => !covered.includes(kw));
  const score = demanded.length > 0 ? (covered.length / demanded.length) * 100 : 100;

  return {
    demanded,
    covered,
    missing,
    score
  };
}

async function run() {
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_ACCOUNT_ID) {
    console.error('❌ Missing R2 configuration in environment variables.');
    process.exit(1);
  }

  const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  try {
    const getCommand = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: 'jobs_data.json',
    });

    const res = await s3Client.send(getCommand);
    if (!res.Body) {
      console.log('❌ No jobs_data.json body returned from Cloudflare R2.');
      return;
    }

    let buffer: Buffer;
    if (typeof (res.Body as any).transformToByteArray === 'function') {
      const byteArray = await (res.Body as any).transformToByteArray();
      buffer = Buffer.from(byteArray);
    } else {
      const stream = res.Body as any;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    }

    const jobs: ScrapedJob[] = JSON.parse(buffer.toString('utf-8'));
    console.log(`Loaded ${jobs.length} jobs from R2 for evaluation.\n`);

    // Evaluate a representative sample of 15 jobs for display
    const sampleJobs = jobs.slice(0, 15);
    let sampleTotalScore = 0;
    const sampleMissingKeywords = new Set<string>();

    console.log('========================================================================================');
    console.log('| COMPANY            | JOB TITLE                                | SCORE | MISSING KEYS |');
    console.log('========================================================================================');

    for (const job of sampleJobs) {
      const { demanded, covered, missing, score } = analyzeJob(job);
      sampleTotalScore += score;
      missing.forEach(kw => sampleMissingKeywords.add(kw));

      const truncatedCompany = job.company.substring(0, 18).padEnd(18);
      const truncatedTitle = job.title.substring(0, 40).padEnd(40);
      const formattedScore = `${score.toFixed(0)}%`.padStart(5);
      const missingStr = missing.length > 0 ? missing.join(', ') : 'None';

      console.log(`| ${truncatedCompany} | ${truncatedTitle} | ${formattedScore} | ${missingStr}`);
    }

    console.log('========================================================================================');
    const sampleAverageScore = sampleTotalScore / sampleJobs.length;
    console.log(`Sample CV Match Score: ${sampleAverageScore.toFixed(1)}%\n`);

    // Now evaluate ALL jobs in the database to find general gaps
    let globalTotalScore = 0;
    const globalMissingCount: Record<string, number> = {};
    let globalJobsCount = 0;

    for (const job of jobs) {
      const { demanded, covered, missing, score } = analyzeJob(job);
      globalTotalScore += score;
      globalJobsCount++;
      missing.forEach(kw => {
        globalMissingCount[kw] = (globalMissingCount[kw] || 0) + 1;
      });
    }

    const globalAverageScore = globalTotalScore / globalJobsCount;
    console.log(`Global Average CV Match Score (across all ${globalJobsCount} jobs): ${globalAverageScore.toFixed(1)}%\n`);

    const missingEntries = Object.entries(globalMissingCount).sort((a, b) => b[1] - a[1]);

    if (missingEntries.length > 0) {
      console.log('⚠️ Missing Stack Keywords Found Across All Jobs (Ranked by Frequency):');
      missingEntries.forEach(([kw, count]) => {
        console.log(` - ${kw.padEnd(15)} : demanded in ${count} jobs`);
      });
    } else {
      console.log('🎉 Global Perfect Coverage! Our CV supports every single keyword found in all jobs.');
    }

  } catch (err: any) {
    console.error('❌ Evaluation failed:', err);
  }
}

run();
