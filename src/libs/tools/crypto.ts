/**
 * @file tools/crypto.ts
 * @description /api/tools/crypto/* — hashing (text + files), bcrypt, key-pair generation
 * (PEM / OpenSSH / JWK) and JWT signing / verification, all with node:crypto (+ bcryptjs).
 */

import {
  createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPair, getHashes,
  sign as cryptoSign, verify as cryptoVerify, timingSafeEqual, constants as cryptoConstants,
  type KeyObject,
} from 'crypto';
import { promisify } from 'util';
import bcrypt from 'bcryptjs';
import { HttpError, readJson, readMultipart, sendJson, str, type ToolRoute } from './http';
import type { ConverterSpec } from './jobs';

const generateKeyPairAsync = promisify(generateKeyPair);

// ── Hashing ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Incremental CRC-32 (IEEE 802.3, as used by zip / gzip / PNG). */
export class Crc32 {
  private crc = 0xffffffff;
  update(buf: Uint8Array): this {
    let c = this.crc;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    this.crc = c;
    return this;
  }
  digest(): Buffer {
    const out = Buffer.alloc(4);
    out.writeUInt32BE((this.crc ^ 0xffffffff) >>> 0);
    return out;
  }
}

/** Display name → node:crypto algorithm. */
const HASH_ALGOS: Record<string, string> = {
  md5: 'md5',
  sha1: 'sha1',
  sha224: 'sha224',
  sha256: 'sha256',
  sha384: 'sha384',
  sha512: 'sha512',
  'sha512-256': 'sha512-256',
  'sha3-256': 'sha3-256',
  'sha3-384': 'sha3-384',
  'sha3-512': 'sha3-512',
  ripemd160: 'ripemd160',
  blake2b512: 'blake2b512',
  blake2s256: 'blake2s256',
};
const NODE_HASHES = new Set(getHashes());
const AVAILABLE_HASHES = [...Object.keys(HASH_ALGOS).filter(a => NODE_HASHES.has(HASH_ALGOS[a])), 'crc32'];
const DEFAULT_HASHES = ['md5', 'sha1', 'sha256', 'sha512'];

function pickAlgorithms(v: unknown): string[] {
  let list: string[] = [];
  if (Array.isArray(v)) list = v.map(String);
  else if (typeof v === 'string' && v.trim()) {
    try { const j = JSON.parse(v); list = Array.isArray(j) ? j.map(String) : [String(j)]; }
    catch { list = v.split(','); }
  }
  list = [...new Set(list.map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) list = DEFAULT_HASHES;
  const bad = list.filter(a => !AVAILABLE_HASHES.includes(a));
  if (bad.length) throw new HttpError(400, `Unsupported algorithm(s): ${bad.join(', ')}. Available: ${AVAILABLE_HASHES.join(', ')}`);
  return list;
}

type Encoding = 'hex' | 'base64';

interface Hasher { update(b: Uint8Array): unknown; digest(): Buffer }

function makeHasher(alg: string, hmacKey?: string): Hasher {
  if (alg === 'crc32') return new Crc32();
  return hmacKey ? createHmac(HASH_ALGOS[alg], hmacKey) : createHash(HASH_ALGOS[alg]);
}

/** Normalise an expected digest for comparison (hex is case-insensitive, base64 isn't). */
function digestMatches(expected: string, digest: Buffer): boolean {
  const e = expected.trim().replace(/^[a-z0-9-]+[:=]/i, '').replace(/\s+/g, '');
  if (!e) return false;
  if (/^[0-9a-f]+$/i.test(e) && e.length === digest.length * 2) return e.toLowerCase() === digest.toString('hex');
  try {
    const b = Buffer.from(e.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return b.length === digest.length && timingSafeEqual(b, digest);
  } catch {
    return false;
  }
}

const CHUNK = 4 * 1024 * 1024;

function hashBuffer(buf: Buffer, algorithms: string[], hmacKey?: string) {
  const hashers = algorithms.map(a => [a, makeHasher(a, a === 'crc32' ? undefined : hmacKey)] as const);
  // Feed in slices so very large uploads behave like a stream (bounded per-call work).
  for (let off = 0; off < buf.length; off += CHUNK) {
    const slice = buf.subarray(off, Math.min(off + CHUNK, buf.length));
    for (const [, h] of hashers) h.update(slice);
  }
  if (!buf.length) for (const [, h] of hashers) h.update(Buffer.alloc(0));
  return Object.fromEntries(hashers.map(([a, h]) => [a, h.digest()]));
}

function encodeDigests(d: Record<string, Buffer>, enc: Encoding) {
  return Object.fromEntries(Object.entries(d).map(([a, b]) => [a, b.toString(enc)]));
}

function findMatch(expected: string, digests: Record<string, Buffer>): string | null {
  if (!expected.trim()) return null;
  for (const [a, d] of Object.entries(digests)) if (digestMatches(expected, d)) return a;
  return null;
}

// ── bcrypt ───────────────────────────────────────────────────────────────────

const BCRYPT_RE = /^\$(2[abxy])\$(\d{2})\$([./A-Za-z0-9]{22})([./A-Za-z0-9]{31})$/;

// ── SSH wire encoding ───────────────────────────────────────────────────────

function sshString(b: Buffer | string): Buffer {
  const buf = typeof b === 'string' ? Buffer.from(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

/** SSH mpint: big-endian two's complement, minimal, with a leading 0 when the high bit is set. */
function sshMpint(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.subarray(i);
  if (v.length === 1 && v[0] === 0) v = Buffer.alloc(0);
  if (v.length && v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return sshString(v);
}

const b64u = (s: string) => Buffer.from(s, 'base64url');

const SSH_CURVES: Record<string, { ssh: string; size: number }> = {
  'P-256': { ssh: 'nistp256', size: 32 },
  'P-384': { ssh: 'nistp384', size: 48 },
  'P-521': { ssh: 'nistp521', size: 66 },
};

function padLeft(b: Buffer, size: number) {
  return b.length >= size ? b : Buffer.concat([Buffer.alloc(size - b.length), b]);
}

/** OpenSSH public key blob + key type name for an RSA / EC / Ed25519 public key. */
export function sshPublicBlob(pub: KeyObject): { type: string; blob: Buffer } {
  const jwk = pub.export({ format: 'jwk' }) as any;
  if (jwk.kty === 'RSA') {
    return { type: 'ssh-rsa', blob: Buffer.concat([sshString('ssh-rsa'), sshMpint(b64u(jwk.e)), sshMpint(b64u(jwk.n))]) };
  }
  if (jwk.kty === 'EC') {
    const c = SSH_CURVES[jwk.crv];
    if (!c) throw new HttpError(400, `Curve ${jwk.crv} has no OpenSSH encoding`);
    const q = Buffer.concat([Buffer.from([4]), padLeft(b64u(jwk.x), c.size), padLeft(b64u(jwk.y), c.size)]);
    const type = `ecdsa-sha2-${c.ssh}`;
    return { type, blob: Buffer.concat([sshString(type), sshString(c.ssh), sshString(q)]) };
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    return { type: 'ssh-ed25519', blob: Buffer.concat([sshString('ssh-ed25519'), sshString(b64u(jwk.x))]) };
  }
  throw new HttpError(400, `Unsupported key type for OpenSSH: ${jwk.kty}`);
}

/** Unencrypted "-----BEGIN OPENSSH PRIVATE KEY-----" (openssh-key-v1, cipher none). */
export function sshPrivateKey(priv: KeyObject, comment: string): string {
  const jwk = priv.export({ format: 'jwk' }) as any;
  const pub = createPublicKey(priv);
  const { type, blob } = sshPublicBlob(pub);
  let privFields: Buffer;
  if (jwk.kty === 'RSA') {
    privFields = Buffer.concat([
      sshMpint(b64u(jwk.n)), sshMpint(b64u(jwk.e)), sshMpint(b64u(jwk.d)),
      sshMpint(b64u(jwk.qi)), sshMpint(b64u(jwk.p)), sshMpint(b64u(jwk.q)),
    ]);
  } else if (jwk.kty === 'EC') {
    const c = SSH_CURVES[jwk.crv];
    const q = Buffer.concat([Buffer.from([4]), padLeft(b64u(jwk.x), c.size), padLeft(b64u(jwk.y), c.size)]);
    privFields = Buffer.concat([sshString(c.ssh), sshString(q), sshMpint(b64u(jwk.d))]);
  } else {
    const pk = b64u(jwk.x);
    privFields = Buffer.concat([sshString(pk), sshString(Buffer.concat([b64u(jwk.d), pk]))]);
  }
  const check = Buffer.alloc(4);
  check.writeUInt32BE(Math.floor(Math.random() * 0xffffffff) >>> 0);
  let section = Buffer.concat([check, check, sshString(type), privFields, sshString(comment)]);
  const pad: number[] = [];
  for (let i = 1; (section.length + pad.length) % 8; i++) pad.push(i);
  section = Buffer.concat([section, Buffer.from(pad)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'), sshString('none'), sshString(''),
    Buffer.from([0, 0, 0, 1]),
    sshString(blob),
    sshString(section),
  ]);
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n').trim();
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url). */
function jwkThumbprint(jwk: any): string {
  const members = jwk.kty === 'RSA' ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
    : jwk.kty === 'EC' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
      : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  return createHash('sha256').update(JSON.stringify(members)).digest('base64url');
}

function keyDescription(k: KeyObject) {
  const d = k.asymmetricKeyDetails || {};
  return { keyType: k.asymmetricKeyType, bits: d.modulusLength, curve: d.namedCurve };
}

// ── JWT ──────────────────────────────────────────────────────────────────────

const JWT_ALGS: Record<string, { kind: 'hmac' | 'rsa' | 'pss' | 'ec' | 'eddsa'; hash: string | null; curve?: string }> = {
  HS256: { kind: 'hmac', hash: 'sha256' },
  HS384: { kind: 'hmac', hash: 'sha384' },
  HS512: { kind: 'hmac', hash: 'sha512' },
  RS256: { kind: 'rsa', hash: 'sha256' },
  RS384: { kind: 'rsa', hash: 'sha384' },
  RS512: { kind: 'rsa', hash: 'sha512' },
  PS256: { kind: 'pss', hash: 'sha256' },
  PS384: { kind: 'pss', hash: 'sha384' },
  PS512: { kind: 'pss', hash: 'sha512' },
  ES256: { kind: 'ec', hash: 'sha256', curve: 'prime256v1' },
  ES384: { kind: 'ec', hash: 'sha384', curve: 'secp384r1' },
  ES512: { kind: 'ec', hash: 'sha512', curve: 'secp521r1' },
  EdDSA: { kind: 'eddsa', hash: null },
};

/** "3600", "90s", "15m", "12h", "7d", "2w", "1y" → seconds. */
export function parseDuration(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?|y|years?)?\s*$/i.exec(String(v));
  if (!m) throw new HttpError(400, `Can't parse duration "${v}" — use e.g. 3600, 15m, 12h, 7d`);
  const n = Number(m[1]);
  const u = (m[2] || 's').toLowerCase()[0];
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31557600 }[u as 's'] ?? 1;
  return Math.round(n * mult);
}

function parseJsonObject(v: unknown, name: string): Record<string, any> {
  if (v === undefined || v === null || v === '') return {};
  let o = v;
  if (typeof v === 'string') {
    try { o = JSON.parse(v); } catch (e) { throw new HttpError(400, `${name} is not valid JSON: ${(e as Error).message}`); }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, `${name} must be a JSON object`);
  return o as Record<string, any>;
}

function loadPrivateKey(pem: string, passphrase?: string): KeyObject {
  try {
    return createPrivateKey({ key: pem, format: 'pem', passphrase: passphrase || undefined });
  } catch (e) {
    const msg = (e as Error).message;
    if (/passphrase|bad decrypt/i.test(msg)) throw new HttpError(400, 'Private key is encrypted — the passphrase is missing or wrong');
    throw new HttpError(400, `Could not read private key: ${msg}`);
  }
}

function loadPublicKey(input: string): KeyObject {
  const s = input.trim();
  try {
    if (s.startsWith('{')) return createPublicKey({ key: JSON.parse(s), format: 'jwk' });
    return createPublicKey(s); // also accepts a private key / certificate PEM
  } catch (e) {
    throw new HttpError(400, `Could not read public key: ${(e as Error).message}`);
  }
}

function checkKeyForAlg(alg: string, key: KeyObject) {
  const spec = JWT_ALGS[alg];
  const t = key.asymmetricKeyType;
  if ((spec.kind === 'rsa' || spec.kind === 'pss') && t !== 'rsa' && t !== 'rsa-pss') throw new HttpError(400, `${alg} needs an RSA key (got ${t})`);
  if (spec.kind === 'ec') {
    if (t !== 'ec') throw new HttpError(400, `${alg} needs an EC key (got ${t})`);
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve !== spec.curve) throw new HttpError(400, `${alg} needs curve ${spec.curve} (key uses ${curve})`);
  }
  if (spec.kind === 'eddsa' && t !== 'ed25519' && t !== 'ed448') throw new HttpError(400, `EdDSA needs an Ed25519 key (got ${t})`);
  if (spec.kind === 'rsa' || spec.kind === 'pss') {
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < 2048) return [`RSA key is only ${bits} bits — RFC 7518 requires ≥ 2048`];
  }
  return [];
}

function signingOptions(alg: string, key: KeyObject) {
  const spec = JWT_ALGS[alg];
  if (spec.kind === 'pss') return { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST };
  if (spec.kind === 'ec') return { key, dsaEncoding: 'ieee-p1363' as const };
  return { key };
}

function hmacSecret(secret: string, encoding: string): Buffer {
  if (encoding === 'base64') return Buffer.from(secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (encoding === 'hex') {
    if (!/^([0-9a-f]{2})*$/i.test(secret)) throw new HttpError(400, 'Secret is not valid hex');
    return Buffer.from(secret, 'hex');
  }
  return Buffer.from(secret, 'utf8');
}

const b64uJson = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ── Routes ───────────────────────────────────────────────────────────────────

export const routes: ToolRoute[] = [
  {
    method: 'GET',
    path: '/api/tools/crypto/algorithms',
    handler: ({ res }) => sendJson(res, { hashes: AVAILABLE_HASHES, defaults: DEFAULT_HASHES, jwt: Object.keys(JWT_ALGS) }),
  },
  {
    method: 'POST',
    path: '/api/tools/crypto/hash',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const text = typeof body.text === 'string' ? body.text : '';
      if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new HttpError(413, 'Text is larger than 10 MB — use the file tab');
      const algorithms = pickAlgorithms(body.algorithms);
      const encoding: Encoding = body.encoding === 'base64' ? 'base64' : 'hex';
      const hmacKey = typeof body.hmacKey === 'string' && body.hmacKey ? body.hmacKey : undefined;
      const inputEncoding = body.inputEncoding === 'hex' ? 'hex' : body.inputEncoding === 'base64' ? 'base64' : 'utf8';
      if (inputEncoding === 'hex' && !/^([0-9a-f]{2})*$/i.test(text.replace(/\s+/g, ''))) throw new HttpError(400, 'Input is not valid hex');
      const data = Buffer.from(inputEncoding === 'utf8' ? text : text.replace(/\s+/g, ''), inputEncoding);
      const t0 = performance.now();
      const digests = hashBuffer(data, algorithms, hmacKey);
      const expected = typeof body.expected === 'string' ? body.expected : '';
      sendJson(res, {
        bytes: data.length,
        hmac: !!hmacKey,
        encoding,
        hashes: encodeDigests(digests, encoding),
        match: expected ? findMatch(expected, digests) : undefined,
        notes: hmacKey && algorithms.includes('crc32') ? ['CRC-32 is not keyed — shown as a plain checksum.'] : [],
        ms: +(performance.now() - t0).toFixed(2),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/crypto/hash-file',
    handler: async ({ req, res }) => {
      const { fields, files } = await readMultipart(req);
      if (!files.length) throw new HttpError(400, 'Upload at least one file');
      if (files.length > 50) throw new HttpError(400, 'At most 50 files per request');
      const algorithms = pickAlgorithms(fields.algorithms);
      const encoding: Encoding = fields.encoding === 'base64' ? 'base64' : 'hex';
      const hmacKey = fields.hmacKey || undefined;
      const expected = (fields.expected || '').trim();
      const results = files.map(f => {
        const t0 = performance.now();
        const digests = hashBuffer(f.buffer, algorithms, hmacKey);
        const ms = performance.now() - t0;
        return {
          name: f.filename,
          size: f.buffer.length,
          mimeType: f.mimeType,
          hashes: encodeDigests(digests, encoding),
          match: expected ? findMatch(expected, digests) : undefined,
          ms: +ms.toFixed(1),
          mbps: ms > 0 ? +((f.buffer.length / 1024 / 1024) / (ms / 1000)).toFixed(1) : null,
        };
      });
      sendJson(res, { encoding, algorithms, hmac: !!hmacKey, expected: expected || undefined, files: results });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/crypto/bcrypt/hash',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const password = str(body.password, 'password', { max: 4096 });
      const rounds = Number(body.rounds ?? 10);
      if (!Number.isInteger(rounds) || rounds < 4 || rounds > 15) throw new HttpError(400, 'rounds must be an integer between 4 and 15');
      const bytes = Buffer.byteLength(password);
      const warnings: string[] = [];
      if (bytes > 72) warnings.push(`Password is ${bytes} bytes — bcrypt only uses the first 72 bytes; the rest is ignored.`);
      if (rounds < 10) warnings.push(`Cost ${rounds} is fast to brute-force; OWASP recommends at least 10.`);
      const t0 = performance.now();
      const hash = await bcrypt.hash(password, rounds);
      sendJson(res, { hash, rounds, bytes, ms: Math.round(performance.now() - t0), warnings });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/crypto/bcrypt/verify',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const password = str(body.password, 'password', { required: false, max: 4096 });
      const hash = str(body.hash, 'hash', { max: 200 }).trim();
      const m = BCRYPT_RE.exec(hash);
      if (!m) throw new HttpError(400, 'Not a bcrypt hash — expected $2a$/$2b$/$2y$, a 2-digit cost and 53 characters of salt+hash');
      const cost = Number(m[2]);
      if (cost < 4 || cost > 15) throw new HttpError(400, `Cost ${cost} is out of the supported range (4–15)`);
      const t0 = performance.now();
      // bcryptjs understands $2a$/$2b$; $2y$ (PHP) is the same algorithm.
      const match = await bcrypt.compare(password, hash.replace(/^\$2[xy]\$/, '$2b$'));
      sendJson(res, {
        match,
        ms: Math.round(performance.now() - t0),
        info: { version: m[1], cost, salt: m[3], digest: m[4] },
        warnings: Buffer.byteLength(password) > 72 ? ['Only the first 72 bytes of the password are significant to bcrypt.'] : [],
      });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/crypto/keypair',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const type = String(body.type || 'rsa');
      const passphrase = typeof body.passphrase === 'string' && body.passphrase ? body.passphrase : undefined;
      if (passphrase && passphrase.length > 1024) throw new HttpError(400, 'Passphrase is too long');
      const comment = String(body.comment ?? '').replace(/[\r\n]/g, ' ').slice(0, 200);
      const t0 = performance.now();
      let pair: { publicKey: KeyObject; privateKey: KeyObject };
      if (type === 'rsa') {
        const bits = Number(body.bits || 2048);
        if (![2048, 3072, 4096].includes(bits)) throw new HttpError(400, 'bits must be 2048, 3072 or 4096');
        pair = await generateKeyPairAsync('rsa', { modulusLength: bits, publicExponent: 0x10001 }) as any;
      } else if (type === 'ec') {
        const curve = String(body.curve || 'P-256');
        const named = { 'P-256': 'prime256v1', 'P-384': 'secp384r1', 'P-521': 'secp521r1' }[curve];
        if (!named) throw new HttpError(400, 'curve must be P-256, P-384 or P-521');
        pair = await generateKeyPairAsync('ec', { namedCurve: named }) as any;
      } else if (type === 'ed25519') {
        pair = await generateKeyPairAsync('ed25519', {}) as any;
      } else {
        throw new HttpError(400, 'type must be rsa, ec or ed25519');
      }
      const { publicKey, privateKey } = pair;
      const enc = passphrase ? { cipher: 'aes-256-cbc', passphrase } : {};
      const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem', ...enc }) as string;
      const spki = publicKey.export({ type: 'spki', format: 'pem' }) as string;
      const { type: sshType, blob } = sshPublicBlob(publicKey);
      const sshPublic = `${sshType} ${blob.toString('base64')}${comment ? ' ' + comment : ''}`;
      const fingerprint = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
      const md5 = 'MD5:' + (createHash('md5').update(blob).digest('hex').match(/../g) || []).join(':');
      const publicJwk = publicKey.export({ format: 'jwk' }) as any;
      const kid = jwkThumbprint(publicJwk);
      const alg = type === 'rsa' ? 'RS256' : type === 'ed25519' ? 'EdDSA'
        : { 'P-256': 'ES256', 'P-384': 'ES384', 'P-521': 'ES512' }[String(body.curve || 'P-256')];
      const out: Record<string, any> = {
        type,
        ...keyDescription(publicKey),
        encrypted: !!passphrase,
        privatePem: pkcs8,
        publicPem: spki,
        sshPublic,
        fingerprint,
        fingerprintMd5: md5,
        jwk: {
          public: { ...publicJwk, kid, alg, use: 'sig' },
          private: passphrase ? null : { ...(privateKey.export({ format: 'jwk' }) as any), kid, alg, use: 'sig' },
        },
        ms: Math.round(performance.now() - t0),
      };
      // OpenSSH's own private format; we only write it unencrypted (encryption needs bcrypt_pbkdf).
      out.sshPrivate = passphrase ? null : sshPrivateKey(privateKey, comment);
      if (type === 'rsa') {
        out.pkcs1Private = privateKey.export({ type: 'pkcs1', format: 'pem', ...enc }) as string;
        out.pkcs1Public = publicKey.export({ type: 'pkcs1', format: 'pem' }) as string;
      } else if (type === 'ec') {
        out.sec1Private = privateKey.export({ type: 'sec1', format: 'pem', ...enc }) as string;
      }
      sendJson(res, out);
    },
  },
  {
    method: 'POST',
    path: '/api/tools/crypto/jwt/sign',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const alg = String(body.alg || 'HS256');
      const spec = JWT_ALGS[alg];
      if (!spec) throw new HttpError(400, `Unsupported alg "${alg}". Use one of ${Object.keys(JWT_ALGS).join(', ')}`);
      const header: Record<string, any> = { ...parseJsonObject(body.header, "Header"), alg };
      if (!header.typ) header.typ = 'JWT';
      const payload = parseJsonObject(body.payload, 'Payload');
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = parseDuration(body.expiresIn);
      if (expiresIn !== null) {
        if (payload.iat === undefined) payload.iat = now;
        payload.exp = (typeof payload.iat === 'number' ? payload.iat : now) + expiresIn;
      }
      const notBefore = parseDuration(body.notBefore);
      if (notBefore !== null) payload.nbf = now + notBefore;
      if (body.kid) header.kid = String(body.kid);

      const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
      const warnings: string[] = [];
      let sig: Buffer;
      if (spec.kind === 'hmac') {
        const secret = str(body.secret, 'secret', { max: 10_000 });
        const key = hmacSecret(secret, String(body.secretEncoding || 'utf8'));
        const minBytes = Number(alg.slice(2)) / 8;
        if (key.length < minBytes) warnings.push(`Secret is ${key.length} bytes; ${alg} should use at least ${minBytes} bytes (RFC 7518 §3.2).`);
        sig = createHmac(spec.hash!, key).update(signingInput).digest();
      } else {
        const key = loadPrivateKey(str(body.privateKeyPem, 'privateKeyPem', { max: 20_000 }), body.passphrase);
        warnings.push(...checkKeyForAlg(alg, key));
        sig = cryptoSign(spec.hash, Buffer.from(signingInput), signingOptions(alg, key));
      }
      const token = `${signingInput}.${sig.toString('base64url')}`;
      sendJson(res, { token, header, payload, warnings, length: token.length });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/crypto/jwt/verify',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const token = str(body.token, 'token', { max: 100_000 }).trim().replace(/^Bearer\s+/i, '');
      const parts = token.split('.');
      if (parts.length !== 3) throw new HttpError(400, `A JWS has 3 dot-separated parts — this has ${parts.length}`);
      const errors: string[] = [];
      const warnings: string[] = [];
      let header: any;
      let payload: any;
      try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw new HttpError(400, 'Header is not valid base64url JSON'); }
      try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { errors.push('Payload is not JSON (it may be an encrypted or detached payload)'); }
      const alg = String(header?.alg ?? '');
      const spec = JWT_ALGS[alg];
      let signatureValid = false;
      if (alg.toLowerCase() === 'none') errors.push('alg "none" — unsigned tokens must never be accepted');
      else if (!spec) errors.push(`Unsupported alg "${alg}"`);
      else {
        const input = Buffer.from(`${parts[0]}.${parts[1]}`);
        const sig = Buffer.from(parts[2], 'base64url');
        if (spec.kind === 'hmac') {
          const secret = str(body.secret, 'secret', { max: 10_000 });
          const expected = createHmac(spec.hash!, hmacSecret(secret, String(body.secretEncoding || 'utf8'))).update(input).digest();
          signatureValid = expected.length === sig.length && timingSafeEqual(expected, sig);
        } else {
          const keyText = str(body.publicKeyPem ?? body.publicKey, 'publicKeyPem', { max: 50_000 });
          const key = loadPublicKey(keyText);
          try { warnings.push(...checkKeyForAlg(alg, key)); } catch (e) { errors.push((e as Error).message); }
          if (!errors.length) {
            try {
              signatureValid = cryptoVerify(spec.hash, input, signingOptions(alg, key) as any, sig);
            } catch (e) {
              errors.push(`Signature check failed: ${(e as Error).message}`);
            }
          }
        }
        if (!signatureValid && !errors.length) errors.push('Signature does not match — wrong key/secret or the token was modified');
      }

      const leeway = Math.max(0, Math.min(Number(body.leewaySeconds) || 0, 86400));
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, { value: number; date: string; ok: boolean; note: string }> = {};
      if (payload && typeof payload === 'object') {
        for (const k of ['exp', 'nbf', 'iat'] as const) {
          const v = payload[k];
          if (v === undefined) continue;
          if (typeof v !== 'number') { errors.push(`"${k}" must be a NumericDate (seconds since epoch)`); continue; }
          const date = new Date(v * 1000).toISOString();
          if (k === 'exp') {
            const ok = now <= v + leeway;
            claims.exp = { value: v, date, ok, note: ok ? `expires in ${v - now}s` : `expired ${now - v}s ago` };
            if (!ok) errors.push('Token has expired (exp)');
          } else if (k === 'nbf') {
            const ok = now + leeway >= v;
            claims.nbf = { value: v, date, ok, note: ok ? 'active' : `not valid for another ${v - now}s` };
            if (!ok) errors.push('Token is not valid yet (nbf)');
          } else {
            const ok = v <= now + leeway + 60;
            claims.iat = { value: v, date, ok, note: ok ? `issued ${now - v}s ago` : 'issued in the future' };
            if (!ok) warnings.push('iat is in the future — check the issuer\'s clock');
          }
        }
        if (body.issuer && payload.iss !== body.issuer) errors.push(`iss is "${payload.iss}", expected "${body.issuer}"`);
        if (body.audience) {
          const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
          if (!aud.includes(body.audience)) errors.push(`aud does not include "${body.audience}"`);
        }
        if (payload.exp === undefined) warnings.push('No exp claim — this token never expires');
      }
      sendJson(res, { valid: signatureValid && !errors.length, signatureValid, alg, header, payload, claims, errors, warnings });
    },
  },
];

export const converters: ConverterSpec[] = [];
