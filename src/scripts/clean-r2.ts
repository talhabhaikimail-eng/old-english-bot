import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { execSync } from 'child_process';
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

  console.log('🧹 Fetching state.tar.gz from Cloudflare R2 to clean WhatsApp credentials...');

  try {
    const getCommand = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: 'state.tar.gz',
    });

    const res = await s3Client.send(getCommand);
    if (!res.Body) {
      console.log('⚠️ No state.tar.gz body returned from Cloudflare R2.');
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

    const tempDir = resolve(process.cwd(), `temp-r2-clean-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const tempTarPath = resolve(tempDir, 'state.tar.gz');
    fs.writeFileSync(tempTarPath, buffer);

    console.log('📦 Extracting state archive...');
    execSync('tar -xzf state.tar.gz', { cwd: tempDir });

    const authInfoDir = resolve(tempDir, 'auth_info');
    if (fs.existsSync(authInfoDir)) {
      console.log('🧹 Removing WhatsApp auth files from state...');
      const filesToKeep = ['sessions.json', 'go_sessions.json', 'go_deployments.json', 'processed_message_ids.json'];
      let deletedCount = 0;

      for (const entry of fs.readdirSync(authInfoDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          if (!filesToKeep.includes(entry.name)) {
            fs.unlinkSync(resolve(authInfoDir, entry.name));
            deletedCount++;
          }
        } else if (entry.isDirectory()) {
          fs.rmSync(resolve(authInfoDir, entry.name), { recursive: true, force: true });
          deletedCount++;
        }
      }
      console.log(`🧹 Deleted ${deletedCount} WhatsApp-related files/folders.`);
      
      console.log('📦 Re-archiving state...');
      execSync('tar -czf state.tar.gz auth_info', { cwd: tempDir });

      const newBuffer = fs.readFileSync(tempTarPath);

      console.log('📤 Uploading updated state.tar.gz back to Cloudflare R2...');
      const uploadCommand = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: 'state.tar.gz',
        Body: newBuffer,
        ContentType: 'application/gzip',
      });

      await s3Client.send(uploadCommand);
      console.log('✅ Successfully cleaned WhatsApp auth info and updated state.tar.gz in Cloudflare R2.');
    } else {
      console.log('⚠️ auth_info folder not found inside state.tar.gz. No changes made.');
    }

    // Clean up local temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });

  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.log('ℹ️ No state.tar.gz exists in Cloudflare R2. Nothing to clean.');
    } else {
      console.error('❌ Failed to clean WhatsApp auth info in Cloudflare R2:', err.message || err);
    }
  }
}

run();

