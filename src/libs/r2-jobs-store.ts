import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export interface ScrapedJob {
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
    socials: Record<string, any>;
    pagesCrawled: number;
  };
  appliedAt?: string;
}

export interface JobsStatus {
  lastRun: string | null;
  status: 'idle' | 'scraping' | 'completed' | 'failed';
  error?: string;
  startedAt?: string;
  stats: {
    totalJobs: number;
    companiesScraped: number;
    lastRunCount: number;
  };
  lastAutoBlogRun?: string;
  lastCommunityBlogRun?: string;
}

function getS3Client() {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID } = process.env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
    return null;
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

async function getObjectText(key: string): Promise<string | null> {
  const client = getS3Client();
  const bucket = process.env.R2_BUCKET_NAME;
  if (!client || !bucket) return null;
  try {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const res = await client.send(cmd);
    if (!res.Body) return null;
    
    if (typeof (res.Body as any).transformToString === 'function') {
      return await (res.Body as any).transformToString();
    }
    
    const stream = res.Body as any;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    console.error(`[R2 Jobs Store] Error reading ${key} from R2:`, err);
    return null;
  }
}

async function putObjectText(key: string, text: string, contentType: string): Promise<boolean> {
  const client = getS3Client();
  const bucket = process.env.R2_BUCKET_NAME;
  if (!client || !bucket) return false;
  try {
    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(text, 'utf-8'),
      ContentType: contentType,
    });
    await client.send(cmd);
    return true;
  } catch (err) {
    console.error(`[R2 Jobs Store] Error writing ${key} to R2:`, err);
    return false;
  }
}

export async function getJobsFromR2(): Promise<ScrapedJob[]> {
  const data = await getObjectText('jobs_data.json');
  if (!data) return [];
  try {
    return JSON.parse(data) as ScrapedJob[];
  } catch {
    return [];
  }
}

export async function saveJobsToR2(jobs: ScrapedJob[]): Promise<boolean> {
  return putObjectText('jobs_data.json', JSON.stringify(jobs, null, 2), 'application/json');
}

export async function getJobsStatusFromR2(): Promise<JobsStatus> {
  const data = await getObjectText('jobs_status.json');
  if (!data) {
    return {
      lastRun: null,
      status: 'idle',
      stats: { totalJobs: 0, companiesScraped: 0, lastRunCount: 0 }
    };
  }
  try {
    return JSON.parse(data) as JobsStatus;
  } catch {
    return {
      lastRun: null,
      status: 'idle',
      stats: { totalJobs: 0, companiesScraped: 0, lastRunCount: 0 }
    };
  }
}

export async function saveJobsStatusToR2(status: JobsStatus): Promise<boolean> {
  return putObjectText('jobs_status.json', JSON.stringify(status, null, 2), 'application/json');
}

export interface ReceivedEmail {
  id: string;
  from: { name?: string; address: string };
  to: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  receivedAt: string;
}

export async function getReceivedEmailsFromR2(): Promise<ReceivedEmail[]> {
  const data = await getObjectText('received_emails.json');
  if (!data) return [];
  try {
    return JSON.parse(data) as ReceivedEmail[];
  } catch {
    return [];
  }
}

export async function saveReceivedEmailsToR2(emails: ReceivedEmail[]): Promise<boolean> {
  return putObjectText('received_emails.json', JSON.stringify(emails, null, 2), 'application/json');
}

