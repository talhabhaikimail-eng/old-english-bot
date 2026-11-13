/**
 * @file ytp-keys.ts
 * @description Secret access keys for the public YouTube downloader API (/api/ytp/*).
 * The keys are kept in R2 (ytp/api-keys.json), so they survive the bridge's restarts; without
 * R2 they are kept in data/ytp-api-keys.json on this machine.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface YtpApiKey {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt?: string;
  uses: number;
}

const R2_KEY = 'ytp/api-keys.json';
const LOCAL_FILE = path.join(process.cwd(), 'data', 'ytp-api-keys.json');

let keys: YtpApiKey[] | null = null;
let loading: Promise<YtpApiKey[]> | null = null;
let usageDirty = false;

function r2(): { client: S3Client; bucket: string } | null {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ACCOUNT_ID } = process.env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_ACCOUNT_ID) return null;
  return {
    bucket: R2_BUCKET_NAME,
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    }),
  };
}

async function load(): Promise<YtpApiKey[]> {
  if (keys) return keys;
  if (!loading) {
    loading = (async () => {
      let found: YtpApiKey[] = [];
      const store = r2();
      try {
        if (store) {
          const res = await store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: R2_KEY }));
          found = JSON.parse((await res.Body?.transformToString()) || '[]');
        } else if (fs.existsSync(LOCAL_FILE)) {
          found = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
        }
      } catch (e: any) {
        // No file yet is the normal first run; anything else must not wipe the stored keys.
        if (e?.name !== 'NoSuchKey' && e?.$metadata?.httpStatusCode !== 404) {
          loading = null;
          throw new Error(`could not read the API keys: ${e?.message || e}`);
        }
      }
      keys = Array.isArray(found) ? found : [];
      return keys;
    })();
  }
  return loading;
}

async function save(): Promise<void> {
  const body = JSON.stringify(keys || [], null, 2);
  const store = r2();
  if (store) {
    await store.client.send(new PutObjectCommand({ Bucket: store.bucket, Key: R2_KEY, Body: body, ContentType: 'application/json' }));
  } else {
    fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_FILE, body, { mode: 0o600 });
  }
}

export async function listKeys(): Promise<YtpApiKey[]> {
  return [...(await load())];
}

export async function createKey(name: string): Promise<YtpApiKey> {
  const all = await load();
  const key: YtpApiKey = {
    id: crypto.randomBytes(6).toString('hex'),
    name: name.trim().slice(0, 60) || 'API key',
    key: 'ytp_' + crypto.randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
    uses: 0,
  };
  all.push(key);
  await save();
  return key;
}

export async function deleteKey(id: string): Promise<boolean> {
  const all = await load();
  const at = all.findIndex(k => k.id === id);
  if (at < 0) return false;
  all.splice(at, 1);
  await save();
  return true;
}

/** Is this a valid key? Counts the use; the count is written to storage now and then. */
export async function verifyKey(candidate: string): Promise<boolean> {
  if (!candidate || !candidate.startsWith('ytp_')) return false;
  let all: YtpApiKey[];
  try { all = await load(); } catch { return false; }
  const given = Buffer.from(candidate);
  let match: YtpApiKey | undefined;
  for (const k of all) {
    const own = Buffer.from(k.key);
    if (own.length === given.length && crypto.timingSafeEqual(own, given)) match = k;
  }
  if (!match) return false;
  match.uses = (match.uses || 0) + 1;
  match.lastUsedAt = new Date().toISOString();
  if (!usageDirty) {
    usageDirty = true;
    setTimeout(() => {
      usageDirty = false;
      save().catch(e => console.warn('[ytp-keys] could not save key usage:', e?.message || e));
    }, 60_000).unref();
  }
  return true;
}
