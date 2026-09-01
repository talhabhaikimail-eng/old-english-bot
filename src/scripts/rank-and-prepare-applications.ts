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
  companyWebsite?: string;
  contacts?: {
    emails: string[];
    phones: string[];
    socials: Record<string, string[]>;
  };
}

interface RankedJob extends ScrapedJob {
  techScore: number;
  contactScore: number;
  recencyScore: number;
  totalScore: number;
  extractedTags: string[];
}

const STACK_KEYWORDS = [
  { tag: 'golang', patterns: [/golang/i, /\bgo\b/i], weight: 25 },
  { tag: 'react', patterns: [/react/i, /reactjs/i], weight: 20 },
  { tag: 'nextjs', patterns: [/nextjs/i, /next\.js/i], weight: 25 },
  { tag: 'python', patterns: [/python/i], weight: 15 },
  { tag: 'fastapi', patterns: [/fastapi/i, /fast-api/i], weight: 15 },
  { tag: 'laravel', patterns: [/laravel/i], weight: 10 },
  { tag: 'php', patterns: [/php/i], weight: 10 },
  { tag: 'mobile', patterns: [/mobile/i, /react-native/i, /reactnative/i, /expo/i, /flutter/i], weight: 15 },
  { tag: 'aws', patterns: [/aws/i, /amazon web services/i, /fargate/i], weight: 15 },
  { tag: 'nodejs', patterns: [/node/i, /nodejs/i, /express/i], weight: 15 },
  { tag: 'postgresql', patterns: [/postgres/i, /postgresql/i], weight: 10 },
  { tag: 'mongodb', patterns: [/mongo/i, /mongodb/i], weight: 10 },
  { tag: 'typescript', patterns: [/typescript/i, /\bts\b/i], weight: 15 },
  { tag: 'docker', patterns: [/docker/i], weight: 10 },
  { tag: 'kubernetes', patterns: [/kubernetes/i, /k8s/i], weight: 10 },
  { tag: 'nestjs', patterns: [/nestjs/i, /nest\.js/i], weight: 15 },
  { tag: 'vue', patterns: [/vue/i, /vuejs/i], weight: 15 },
  { tag: 'angular', patterns: [/angular/i], weight: 15 },
];

function extractTagsAndScore(job: ScrapedJob): { tags: string[]; score: number } {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const tags: string[] = [];
  let score = 0;

  for (const item of STACK_KEYWORDS) {
    for (const pattern of item.patterns) {
      if (pattern.test(text)) {
        tags.push(item.tag);
        score += item.weight;
        break;
      }
    }
  }

  // Cap tech score at 100
  return { tags, score: Math.min(score, 100) };
}

function calculateRank(job: ScrapedJob): RankedJob {
  const { tags, score: techScore } = extractTagsAndScore(job);

  // 1. Contact Score (max 35)
  let contactScore = 0;
  if (job.contacts) {
    if (job.contacts.emails && job.contacts.emails.length > 0) {
      contactScore += 20; // Direct email is gold!
    }
    if (job.contacts.socials && job.contacts.socials.linkedin && job.contacts.socials.linkedin.length > 0) {
      contactScore += 10; // Recruiter LinkedIn profile
    }
    if (job.contacts.phones && job.contacts.phones.length > 0) {
      contactScore += 5; // Phone number
    }
  }

  // 2. Recency Score (max 15)
  const ageInMs = Date.now() - new Date(job.scrapedAt).getTime();
  const ageInDays = ageInMs / (1000 * 60 * 60 * 24);
  let recencyScore = 0;
  if (ageInDays <= 1) {
    recencyScore = 15;
  } else if (ageInDays <= 3) {
    recencyScore = 10;
  } else if (ageInDays <= 7) {
    recencyScore = 5;
  }

  // Overall Score (out of 150)
  const totalScore = techScore + contactScore + recencyScore;

  return {
    ...job,
    techScore,
    contactScore,
    recencyScore,
    totalScore,
    extractedTags: tags
  };
}

function generatePitchEmail(job: RankedJob): string {
  const recipientName = "Hiring Team";
  const companyName = job.company !== "Unknown Company" ? job.company : "your team";

  // Customize description matching
  let projectBullets = "";
  if (job.extractedTags.includes('golang') || job.extractedTags.includes('aws')) {
    projectBullets += `- **Golang Distributed Chat System / Bridge**: Architected a real-time chat bridging network deployed on AWS Fargate serverless containers with ALB, PostgreSQL, and Redis.\n`;
  }
  if (job.extractedTags.includes('nextjs') || job.extractedTags.includes('react') || job.extractedTags.includes('stripe')) {
    projectBullets += `- **Vine LMS (vinelms.com)**: Built a dynamic LMS using Next.js, Node.js/Express, PostgreSQL, and TanStack Query, integrating Stripe Connect, Reader Pay, and Stripe Meter.\n`;
  }
  if (job.extractedTags.includes('python') || job.extractedTags.includes('fastapi') || job.extractedTags.includes('scraping')) {
    projectBullets += `- **Anti-Bot Google Search Scraper**: Built a robust bypass/scraping engine in Python (FastAPI) and React utilizing Puppeteer and SeleniumBase.\n`;
  }
  if (job.extractedTags.includes('nestjs') || job.extractedTags.includes('vue') || job.extractedTags.includes('kubernetes')) {
    projectBullets += `- **Enterprise E-Commerce Dashboard**: Created an administration panel using Vue.js 3, Pinia, NestJS, and containerized deployment with Kubernetes (K8s).\n`;
  }
  if (job.extractedTags.includes('mobile') || job.extractedTags.includes('flutter') || job.extractedTags.includes('react-native')) {
    projectBullets += `- **Cross-Platform Mobile Apps**: Designed and deployed client applications using React Native, Expo, and Flutter with Redux Toolkit.\n`;
  }

  // Fallback project bullets if no specific stack matches
  if (!projectBullets) {
    projectBullets += `- **Vine LMS (vinelms.com)**: High-performance Next.js and Node.js LMS with PostgreSQL and Stripe Connect.\n`;
    projectBullets += `- **Golang Distributed Chat System**: Scalable messaging bridge using Go, WebSockets, Redis, and AWS Fargate.\n`;
  }

  return `Subject: Application for ${job.title} - Talha Riaz

Dear ${recipientName},

I am writing to express my strong interest in the ${job.title} position at ${companyName}. As a Senior Full-Stack Developer with 2+ years of hands-on experience building enterprise management systems, scaling backend architectures, and designing responsive frontends, I am confident I can add immediate value to your team.

My technical background aligns closely with the requirements outlined in your job description. Here are a few relevant projects I have delivered:

${projectBullets}
I pride myself on writing clean, maintainable code in TypeScript, Golang, and Python, containerizing services via Docker/Kubernetes, and setting up automated CI/CD pipelines via GitHub Actions.

I have attached my tailored resume (which outlines my detailed experiences with Woltrio and Swismax) for your review. I would love the opportunity to discuss how my skill set can support ${companyName}'s engineering goals.

Thank you for your time and consideration.

Best regards,

Talha Riaz
Islamabad, Pakistan
+92 318 585347
talhariaz5425869@gmail.com
GitHub: github.com/talhary
Portfolio: talhacodes.site
`;
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
    console.log(`Analyzing and ranking ${jobs.length} jobs...`);

    // Rank all jobs using our multi-factor scoring algorithm
    const rankedJobs: RankedJob[] = jobs.map(calculateRank);

    // Sort by rank descending
    rankedJobs.sort((a, b) => b.totalScore - a.totalScore);

    // Select the top 5 most actionable/best match jobs
    const topJobs = rankedJobs.slice(0, 5);

    console.log('\n🏆 TOP 5 ACTIONABLE JOBS FOUND FOR TALHA RIAZ:');
    console.log('====================================================================================================');
    console.log('| RANK | COMPANY            | TITLE                                      | TOTAL | TECH | CONTACT |');
    console.log('====================================================================================================');
    topJobs.forEach((job, idx) => {
      const r = `${idx + 1}`.padEnd(4);
      const comp = job.company.substring(0, 18).padEnd(18);
      const title = job.title.substring(0, 42).padEnd(42);
      const tot = `${job.totalScore}`.padStart(5);
      const tech = `${job.techScore}`.padStart(4);
      const cont = `${job.contactScore}`.padStart(7);
      console.log(`| ${r} | ${comp} | ${title} | ${tot} | ${tech} | ${cont} |`);
    });
    console.log('====================================================================================================');

    const appBaseDir = resolve(process.cwd(), 'applications');
    fs.mkdirSync(appBaseDir, { recursive: true });

    console.log('\n📂 Generating tailored applications (Resume PDF & Pitch Email) in the "applications/" directory...');

    for (let i = 0; i < topJobs.length; i++) {
      const job = topJobs[i];
      const safeCompany = job.company.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const safeTitle = job.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const folderName = `${safeCompany}_${safeTitle}`;
      const folderPath = resolve(appBaseDir, folderName);

      fs.mkdirSync(folderPath, { recursive: true });

      // 1. Save Job Details
      const jobDetailsPath = resolve(folderPath, 'job_details.json');
      fs.writeFileSync(jobDetailsPath, JSON.stringify({
        title: job.title,
        company: job.company,
        url: job.url,
        description: job.description,
        scrapedAt: job.scrapedAt,
        contacts: job.contacts,
        source: job.source,
        extractedTags: job.extractedTags,
        scores: {
          total: job.totalScore,
          tech: job.techScore,
          contact: job.contactScore,
          recency: job.recencyScore
        }
      }, null, 2));

      // 2. Save Pitch Email
      const emailContent = generatePitchEmail(job);
      const emailPath = resolve(folderPath, 'pitch_email.txt');
      fs.writeFileSync(emailPath, emailContent);

      // 3. Request PDF generation from Go server
      try {
        const response = await fetch('http://localhost:8080/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: job.extractedTags }),
        });

        if (!response.ok) {
          throw new Error(`API server returned status ${response.status}: ${await response.text()}`);
        }

        const pdfBuffer = await response.arrayBuffer();
        const resumePath = resolve(folderPath, 'tailored_resume.pdf');
        fs.writeFileSync(resumePath, Buffer.from(pdfBuffer));
        console.log(`✅ [Job ${i + 1}] Application prepared at: applications/${folderName}/`);
      } catch (err: any) {
        console.error(`❌ [Job ${i + 1}] Failed to generate PDF resume:`, err.message);
      }
    }

    console.log('\n🎉 Finished preparing applications! Review folders under the "applications/" directory.');
  } catch (err: any) {
    console.error('❌ Error executing rank and prepare:', err);
  }
}

run();
