/**
 * @file tools/seo-fetch.ts
 * @description SSRF-guarded HTTP fetcher shared by the SEO tools.
 *
 *  - Every request (and every redirect hop) is checked: http(s) only, hostname not internal, and the DNS answer
 *    is verified at connect time by a guarded `lookup`, so DNS rebinding can't reach private addresses.
 *    TOOLS_ALLOW_PRIVATE_TARGETS=1 disables the private-address check (local development / tests only).
 *  - Redirects are followed manually (≤ 10) so each hop is recorded and re-guarded.
 *  - Bodies are capped (5 MB on the wire by default), decompressed (gzip/deflate/br) and charset-decoded.
 *  - TTFB and total time are measured per hop.
 */

import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { isBlockedHostname, isBlockedIp } from '../web-proxy-guard';
import { HttpError } from './http';

export const USER_AGENTS = {
  'chrome-desktop': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'chrome-mobile': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  googlebot: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
} as const;

export type UaKey = keyof typeof USER_AGENTS;

export function uaKey(v: unknown, fallback: UaKey = 'chrome-desktop'): UaKey {
  return typeof v === 'string' && v in USER_AGENTS ? (v as UaKey) : fallback;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DECODED_BYTES = 50 * 1024 * 1024;

export function allowPrivateTargets(): boolean {
  return process.env.TOOLS_ALLOW_PRIVATE_TARGETS === '1';
}

/** Validate a user-supplied URL string; throws HttpError(400) when it must not be fetched. */
export function checkTarget(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, `Invalid URL: ${raw.slice(0, 200)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, `Only http(s) URLs are supported: ${raw.slice(0, 200)}`);
  if (u.username || u.password) throw new HttpError(400, 'URLs with credentials are not supported');
  if (!allowPrivateTargets() && isBlockedHostname(u.hostname)) {
    throw new HttpError(400, `Blocked: ${u.hostname} is a private or internal address`);
  }
  return u;
}

/** Accept "example.com" as well as full URLs. */
export function normalizeInputUrl(raw: unknown, name = 'url'): URL {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw new HttpError(400, `Missing "${name}"`);
  if (s.length > 4000) throw new HttpError(400, `"${name}" is too long`);
  return checkTarget(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
}

function guardedLookup(hostname: string, options: any, callback: any): void {
  const opts = typeof options === 'function' ? {} : options || {};
  const cb = typeof options === 'function' ? options : callback;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses: any) => {
    if (err) return cb(err);
    const list: { address: string; family: number }[] = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
    if (!list.length) return cb(new Error(`No addresses for ${hostname}`));
    if (!allowPrivateTargets() && list.some(a => isBlockedIp(a.address))) {
      return cb(new Error(`Blocked: ${hostname} resolves to a private or internal address`));
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

export interface RawResponse {
  url: string;
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  /** Decoded (decompressed) body; empty for HEAD. */
  body: Buffer;
  /** Bytes received on the wire (compressed), excluding headers. */
  transferBytes: number;
  /** True when the body hit maxBytes and was cut off. */
  truncated: boolean;
  ttfbMs: number;
  totalMs: number;
  remoteAddress?: string;
  httpVersion: string;
}

export interface RequestOptions {
  method?: 'GET' | 'HEAD';
  userAgent?: UaKey;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Max bytes read from the wire. */
  maxBytes?: number;
  /** Decompress the body (default true). */
  decode?: boolean;
  signal?: AbortSignal;
}

function decompress(buf: Buffer, encoding: string, truncated: boolean): Buffer {
  const enc = encoding.toLowerCase().trim();
  if (!buf.length || !enc || enc === 'identity') return buf;
  const opts = { maxOutputLength: MAX_DECODED_BYTES };
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, { ...opts, finishFlush: truncated ? zlib.constants.Z_SYNC_FLUSH : undefined });
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buf, { ...opts, finishFlush: truncated ? zlib.constants.Z_SYNC_FLUSH : undefined }); } catch { return zlib.inflateRawSync(buf, opts); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf, { maxOutputLength: MAX_DECODED_BYTES, finishFlush: truncated ? zlib.constants.BROTLI_OPERATION_FLUSH : undefined });
  } catch (e) {
    throw new Error(`Could not decode ${enc} body: ${(e as Error).message}`);
  }
  return buf;
}

/** One HTTP request, no redirect following. */
export function rawRequest(target: string | URL, o: RequestOptions = {}): Promise<RawResponse> {
  const u = typeof target === 'string' ? checkTarget(target) : checkTarget(target.href);
  const method = o.method || 'GET';
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lib = u.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENTS[o.userAgent || 'chrome-desktop'],
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    ...o.headers,
  };

  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let ttfb = 0;
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); fn(); } };
    const req = lib.request(u, { method, headers, lookup: guardedLookup as any, agent: false });
    const timer = setTimeout(() => {
      req.destroy(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const onAbort = () => req.destroy(new Error('Aborted'));
    if (o.signal) {
      if (o.signal.aborted) { onAbort(); } else o.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', err => done(() => reject(friendlyError(err, u))));
    req.on('response', res => {
      ttfb = performance.now() - t0;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const finish = () => done(() => {
        const wire = Buffer.concat(chunks);
        let body: Buffer = wire;
        if (o.decode !== false && method !== 'HEAD') {
          try { body = decompress(wire, String(res.headers['content-encoding'] || ''), truncated); } catch (e) { return reject(e); }
        }
        resolve({
          url: u.href, status: res.statusCode || 0, statusText: res.statusMessage || '', headers: res.headers, body,
          transferBytes: size, truncated, ttfbMs: Math.round(ttfb), totalMs: Math.round(performance.now() - t0),
          remoteAddress: res.socket?.remoteAddress, httpVersion: res.httpVersion,
        });
      });
      res.on('data', (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) {
          const keep = c.length - (size - maxBytes);
          chunks.push(c.subarray(0, keep));
          size = maxBytes;
          truncated = true;
          finish();
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', err => done(() => reject(friendlyError(err, u))));
    });
    req.end();
  });
}

function friendlyError(err: Error & { code?: string }, u: URL): Error {
  const code = err.code || '';
  if (/^Blocked/.test(err.message)) return new HttpError(400, err.message);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`DNS lookup failed for ${u.hostname}`);
  if (code === 'ECONNREFUSED') return new Error(`Connection refused by ${u.host}`);
  if (code === 'ECONNRESET') return new Error(`Connection reset by ${u.host}`);
  if (code === 'CERT_HAS_EXPIRED') return new Error(`TLS certificate of ${u.hostname} has expired`);
  if (/certificate|SSL|TLS/i.test(err.message) || /^ERR_TLS|CERT|SELF_SIGNED/.test(code)) return new Error(`TLS error for ${u.hostname}: ${err.message}`);
  return new Error(`${u.host}: ${err.message}`);
}

export interface Hop {
  url: string;
  status: number;
  statusText: string;
  location?: string;
  ttfbMs: number;
  totalMs: number;
}

export interface PageResult extends RawResponse {
  requestedUrl: string;
  finalUrl: string;
  chain: Hop[];
  /** Sum over all hops. */
  totalMsAll: number;
  contentType: string;
  /** Charset-decoded body (only for text responses). */
  text: string;
  charset: string;
  charsetSource: 'header' | 'bom' | 'meta' | 'default';
  redirectError?: string;
}

export const isRedirect = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

/** GET (or HEAD) following up to `maxRedirects` redirects, each hop re-guarded and recorded. */
export async function fetchPage(target: string | URL, o: RequestOptions & { maxRedirects?: number } = {}): Promise<PageResult> {
  const maxRedirects = o.maxRedirects ?? 10;
  const requestedUrl = typeof target === 'string' ? target : target.href;
  let current = checkTarget(requestedUrl);
  const chain: Hop[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (;;) {
    seen.add(current.href);
    const res = await rawRequest(current, o);
    total += res.totalMs;
    const loc = res.headers.location;
    const hop: Hop = { url: current.href, status: res.status, statusText: res.statusText, ttfbMs: res.ttfbMs, totalMs: res.totalMs };
    chain.push(hop);
    let redirectError: string | undefined;
    if (isRedirect(res.status) && loc) {
      let next: URL | null = null;
      try { next = new URL(loc, current); } catch { redirectError = `Invalid Location header: ${loc}`; }
      if (next) {
        next.hash = '';
        hop.location = next.href;
        if (next.protocol !== 'http:' && next.protocol !== 'https:') redirectError = `Redirect to unsupported scheme ${next.protocol}`;
        else if (seen.has(next.href)) redirectError = `Redirect loop detected at ${next.href}`;
        else if (chain.length > maxRedirects) redirectError = `More than ${maxRedirects} redirects`;
        if (!redirectError) {
          current = checkTarget(next.href);
          continue;
        }
      }
    }
    const contentType = String(res.headers['content-type'] || '');
    const isText = !contentType || /text\/|html|xml|json|javascript|css/i.test(contentType);
    const dec = isText ? decodeText(res.body, contentType) : { text: '', charset: '', source: 'default' as const };
    return {
      ...res, requestedUrl, finalUrl: current.href, chain, totalMsAll: total, contentType,
      text: dec.text, charset: dec.charset, charsetSource: dec.source, redirectError,
    };
  }
}

/** Decode bytes using the Content-Type charset, a BOM, or a <meta charset> sniffed from the first 4 KB. */
export function decodeText(buf: Buffer, contentType: string): { text: string; charset: string; source: 'header' | 'bom' | 'meta' | 'default' } {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  let source: 'header' | 'bom' | 'meta' | 'default' = charset ? 'header' : 'default';
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { charset = 'utf-8'; source = 'bom'; }
  else if (buf[0] === 0xff && buf[1] === 0xfe) { charset = 'utf-16le'; source = 'bom'; }
  else if (buf[0] === 0xfe && buf[1] === 0xff) { charset = 'utf-16be'; source = 'bom'; }
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
    if (m) { charset = m[1]; source = 'meta'; }
  }
  charset = (charset || 'utf-8').toLowerCase();
  try {
    return { text: new TextDecoder(charset).decode(buf), charset, source };
  } catch {
    return { text: new TextDecoder('utf-8').decode(buf), charset: 'utf-8', source: 'default' };
  }
}

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function headerList(h: http.IncomingHttpHeaders, name: string): string[] {
  const v = h[name.toLowerCase()];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [String(v)];
}

export function errMsg(e: unknown): string {
  return (e as Error)?.message || String(e);
}
