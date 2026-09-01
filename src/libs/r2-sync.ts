import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { execSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';

export async function saveStateToR2(): Promise<{ success: boolean; message: string }> {
  const {
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_ACCOUNT_ID
  } = process.env;

  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_ACCOUNT_ID) {
    console.warn('[R2-Sync] Missing R2 configuration. Skipping backup.');
    return { success: false, message: 'Missing R2 configuration environment variables.' };
  }

  try {
    const rootDir = resolve(__dirname, '../../');
    const authExists = existsSync(resolve(rootDir, 'auth_info'));

    if (!authExists) {
      return { success: false, message: 'Nothing to back up (auth_info does not exist).' };
    }

    const filesToArchive = ['auth_info'];

    console.log(`[R2-Sync] Creating state archive with: ${filesToArchive.join(', ')}`);
    
    // Windows vs Linux tar compatibility
    const tarCmd = `tar -czf state.tar.gz ${filesToArchive.join(' ')}`;
      
    execSync(tarCmd, { cwd: rootDir });

    const tarPath = resolve(rootDir, 'state.tar.gz');
    if (!existsSync(tarPath)) {
      return { success: false, message: 'Failed to create state.tar.gz' };
    }

    const buffer = readFileSync(tarPath);

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });

    const uploadCommand = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: 'state.tar.gz',
      Body: buffer,
      ContentType: 'application/gzip',
    });

    await s3Client.send(uploadCommand);
    console.log('✅ Successfully uploaded state.tar.gz to Cloudflare R2.');

    // Clean up temporary local archive
    try {
      unlinkSync(tarPath);
    } catch (e) {
      // ignore
    }

    return { success: true, message: 'State successfully synced to Cloudflare R2.' };
  } catch (err: any) {
    console.error('❌ Failed to upload state.tar.gz to R2:', err);
    return { success: false, message: err.message || 'Error occurred during R2 sync.' };
  }
}

export async function saveLiveUrlToR2(url: string): Promise<boolean> {
  const {
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_ACCOUNT_ID
  } = process.env;

  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_ACCOUNT_ID) {
    console.warn('[R2-Sync] Missing R2 configuration for saving live URL.');
    return false;
  }

  try {
    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });

    const uploadCommand = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: 'live_url.txt',
      Body: Buffer.from(url),
      ContentType: 'text/plain',
    });

    await s3Client.send(uploadCommand);
    console.log('✅ Successfully uploaded live_url.txt to Cloudflare R2.');
    return true;
  } catch (err) {
    console.error('❌ Failed to upload live_url.txt to R2:', err);
    return false;
  }
}

export async function fetchLiveUrlFromR2(): Promise<string | null> {
  const {
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_ACCOUNT_ID
  } = process.env;

  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_ACCOUNT_ID) {
    return null;
  }

  try {
    const s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });

    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: 'live_url.txt',
    });

    const response = await s3Client.send(command);
    const text = await response.Body?.transformToString();
    return text || null;
  } catch (err) {
    return null;
  }
}
