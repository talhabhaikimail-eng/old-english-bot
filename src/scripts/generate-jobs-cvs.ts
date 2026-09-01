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

const STACK_KEYWORDS = [
  { tag: 'golang', patterns: [/golang/i, /\bgo\b/i] },
  { tag: 'react', patterns: [/react/i, /reactjs/i] },
  { tag: 'nextjs', patterns: [/nextjs/i, /next\.js/i] },
  { tag: 'python', patterns: [/python/i] },
  { tag: 'fastapi', patterns: [/fastapi/i, /fast-api/i] },
  { tag: 'laravel', patterns: [/laravel/i] },
  { tag: 'php', patterns: [/php/i] },
  { tag: 'mobile', patterns: [/mobile/i, /react-native/i, /reactnative/i, /expo/i, /flutter/i, /android/i, /ios/i] },
  { tag: 'aws', patterns: [/aws/i, /amazon web services/i, /lambda/i, /fargate/i, /ec2/i, /s3/i, /alb/i] },
  { tag: 'nodejs', patterns: [/node/i, /nodejs/i, /express/i] },
  { tag: 'postgresql', patterns: [/postgres/i, /postgresql/i] },
  { tag: 'mongodb', patterns: [/mongo/i, /mongodb/i] },
  { tag: 'sql', patterns: [/\bsql\b/i] },
  { tag: 'tailwind', patterns: [/tailwind/i] },
  { tag: 'typescript', patterns: [/typescript/i, /\bts\b/i] },
  { tag: 'javascript', patterns: [/javascript/i, /\bjs\b/i] },
  { tag: 'docker', patterns: [/docker/i] },
  { tag: 'devops', patterns: [/devops/i, /ci\/cd/i, /github actions/i] },
];

function extractTags(title: string, description: string): string[] {
  const text = `${title} ${description}`;
  const tags: string[] = [];
  for (const item of STACK_KEYWORDS) {
    for (const pattern of item.patterns) {
      if (pattern.test(text)) {
        tags.push(item.tag);
        break;
      }
    }
  }
  return tags;
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

  console.log('Fetching jobs_data.json from Cloudflare R2...');

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
    console.log(`Loaded ${jobs.length} jobs from R2.`);

    if (jobs.length === 0) {
      console.log('No jobs to process.');
      return;
    }

    const selectedJobs: ScrapedJob[] = [];
    const stacks = [
      { name: 'Golang', check: (j: ScrapedJob) => /golang/i.test(j.title) || /golang/i.test(j.description) },
      { name: 'React/Next.js', check: (j: ScrapedJob) => /react/i.test(j.title) || /next/i.test(j.title) },
      { name: 'Python', check: (j: ScrapedJob) => /python/i.test(j.title) || /python/i.test(j.description) },
      { name: 'Mobile', check: (j: ScrapedJob) => /mobile/i.test(j.title) || /react native/i.test(j.title) || /expo/i.test(j.title) },
    ];

    for (const stack of stacks) {
      const job = jobs.find(j => stack.check(j) && !selectedJobs.some(sj => sj.jk === j.jk));
      if (job) {
        selectedJobs.push(job);
      }
    }

    for (const j of jobs) {
      if (selectedJobs.length >= 4) break;
      if (!selectedJobs.some(sj => sj.jk === j.jk)) {
        selectedJobs.push(j);
      }
    }

    console.log(`\nSelected ${selectedJobs.length} jobs for CV generation:`);
    selectedJobs.forEach((job, index) => {
      console.log(`[${index + 1}] Company: ${job.company} | Title: ${job.title} | Source: ${job.source}`);
    });

    const storageDir = resolve(process.cwd(), 'src-go/create-cv/storage');
    fs.mkdirSync(storageDir, { recursive: true });

    for (let i = 0; i < selectedJobs.length; i++) {
      const job = selectedJobs[i];
      const tags = extractTags(job.title, job.description);
      console.log(`\nProcessing Job [${i + 1}]: "${job.title}" at "${job.company}"`);
      console.log(`Extracted Tags: ${tags.length > 0 ? tags.join(', ') : 'None (generating general CV)'}`);

      try {
        const cvPort = process.env.CV_GENERATOR_PORT || '8082';
        const response = await fetch(`http://localhost:${cvPort}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags }),
        });

        if (!response.ok) {
          throw new Error(`API server returned status ${response.status}: ${await response.text()}`);
        }

        const pdfBuffer = await response.arrayBuffer();
        const safeCompany = job.company.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const safeTitle = job.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const fileName = `cv_${safeCompany}_${safeTitle}.pdf`;
        const filePath = resolve(storageDir, fileName);

        fs.writeFileSync(filePath, Buffer.from(pdfBuffer));
        console.log(`✅ Saved customized CV to: src-go/create-cv/storage/${fileName}`);
      } catch (err: any) {
        console.error(`❌ Failed to generate CV for "${job.title}":`, err.message);
      }
    }
  } catch (err: any) {
    console.error('❌ Error executing generation script:', err);
  }
}

run();
