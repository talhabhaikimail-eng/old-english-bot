/**
 * @file ytp-proxy.ts
 * @description The YouTube downloader API: forwards /api/ytp/* to the Go resolver and downloader
 * (src-go/ytp, started as `ytp serve`), which listens on loopback only.
 *
 * Public API. These need either the dashboard login or a secret access key, sent as
 * `Authorization: Bearer KEY`, `X-API-Key: KEY` or `?key=KEY`:
 *
 *  GET /api/ytp/health                               is the service up, does it have a session
 *  GET /api/ytp/search?q=…&limit=20                  search YouTube
 *  GET /api/ytp/info?url=…                           title, live, every quality with its size
 *  GET /api/ytp/resolve?url=…                        raw formats and stream addresses
 *  GET /api/ytp/download?url=…&height=2160           video up to that height, merged with audio
 *  GET /api/ytp/download?url=…&audio=1[&ext=webm]    audio only (m4a, or Opus)
 *  GET /api/ytp/download?url=…&f=b|bv|ba|ITAG        one specific format
 *  GET /api/ytp/record?url=…&minutes=5&height=720    record a live stream from now
 *  GET /api/ytp/progress?id=…                        progress of a download started with &id=…
 *  GET /api/ytp/playlist?url=…                       the videos of a playlist
 *  POST /api/ytp/jobs?url=…&height=…                 start a download job (a playlist link: one per video)
 *  GET /api/ytp/jobs, /api/ytp/jobs/ID               list jobs, follow one; DELETE removes one
 *  GET /api/ytp/files/ID                             the finished file of a job (supports Range)
 *  GET /api/ytp/docs                                 the full documentation (Markdown)
 *  (jobs, files and docs are answered by dashboard-server, where the jobs live)
 *  GET /api/ytp/s/<key>?range=a-b                    byte-range proxy for /resolve's formats
 *
 * Dashboard only:
 *
 *  GET|POST|DELETE /api/ytp/keys     list, create ({name}) and delete (?id=) access keys
 *  POST /api/ytp/login/start         open the remote browser on Google's sign-in page, without a
 *                                    DevTools port (Google refuses sign-in when there is one)
 *  POST /api/ytp/login               after signing in there: restart that browser with the port,
 *                                    export its YouTube session with `ytp login --cdp`, save it to R2
 */

import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { exportYouTubeCookies, getYouTubeCookiesPath, startYouTubeSignIn } from './browser';
import { createKey, deleteKey, listKeys, verifyKey } from './ytp-keys';
import { searchYouTube } from './youtube-dl';

const PREFIX = '/api/ytp/';
const target = () => new URL(process.env.YTP_URL || 'http://127.0.0.1:8084');

/** What an access key may call. Keys and sign-in stay with the dashboard login. */
const PUBLIC = /^\/api\/ytp\/(health|search|info|resolve|debug|download|record|progress|playlist|docs|s\/[\w-]+|jobs|jobs\/[a-z0-9]+|files\/[a-z0-9]+)$/;
/** Of those, the ones a key may also POST to or DELETE. */
const PUBLIC_WRITE = /^\/api\/ytp\/(jobs|jobs\/[a-z0-9]+)$/;

/** Headers worth passing through in each direction (no cookies or dashboard credentials). */
const REQ_HEADERS = ['accept', 'range', 'if-range'];
const RES_HEADERS = [
  'content-type', 'content-length', 'content-disposition', 'cache-control',
  'content-range', 'accept-ranges', 'last-modified', 'x-total-size',
];

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', c => { if (chunks.length < 64) chunks.push(c); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * True when the request is for the public downloader API and carries a valid access key, in
 * which case it does not need the dashboard login.
 */
export async function ytpPublicAccess(req: IncomingMessage, pathname: string): Promise<boolean> {
  if (!PUBLIC.test(pathname)) return false;
  const reads = req.method === 'GET' || req.method === 'HEAD';
  if (!reads && !((req.method === 'POST' || req.method === 'DELETE') && PUBLIC_WRITE.test(pathname))) return false;
  const auth = req.headers['authorization'];
  const header = req.headers['x-api-key'];
  let key = typeof header === 'string' ? header : '';
  if (!key && typeof auth === 'string' && auth.startsWith('Bearer ')) key = auth.slice(7).trim();
  if (!key) {
    try { key = new URL(req.url || '/', 'http://localhost').searchParams.get('key') || ''; } catch { /* no key */ }
  }
  return verifyKey(key);
}

let cookiesWritten = false;

export function handleYtpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith(PREFIX)) return false;
  const route = url.pathname.slice(PREFIX.length);

  // ── access keys ──────────────────────────────────────────────────────────────
  if (route === 'keys') {
    (async () => {
      if (req.method === 'GET') return send(res, 200, { keys: await listKeys() });
      if (req.method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { key: await createKey(String(body.name || '')) });
      }
      if (req.method === 'DELETE') {
        const ok = await deleteKey(url.searchParams.get('id') || '');
        return send(res, ok ? 200 : 404, ok ? { success: true } : { error: 'no such key' });
      }
      send(res, 405, { error: 'GET, POST or DELETE' });
    })().catch(e => send(res, 500, { error: (e as Error).message }));
    return true;
  }

  // ── sign-in ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && route === 'login/start') {
    startYouTubeSignIn()
      .then(result => send(res, result.error ? 500 : 200, result))
      .catch(e => send(res, 500, { error: (e as Error).message }));
    return true;
  }
  if (req.method === 'POST' && route === 'login') {
    exportYouTubeCookies('.youtube.com', true)
      .then(result => send(res, result.success ? 200 : 409, { success: result.success, message: result.message }))
      .catch(e => send(res, 500, { success: false, message: (e as Error).message }));
    return true;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { error: 'GET only' });
    return true;
  }

  // ── search (answered here, not by the Go service) ───────────────────────────
  if (route === 'search') {
    const q = url.searchParams.get('q') || '';
    if (!q) { send(res, 400, { error: 'q is required' }); return true; }
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 50);
    searchYouTube(q, limit)
      .then(results => send(res, 200, { results }))
      .catch(e => send(res, 500, { error: (e as Error).message }));
    return true;
  }

  // The service reads browser_data/youtube-cookies.txt; make sure YOUTUBE_COOKIES from the
  // environment has been written there (the file is re-read by the service when it changes).
  if (!cookiesWritten) {
    cookiesWritten = true;
    getYouTubeCookiesPath();
  }

  // The signed-in client is what works from a server address, so it goes first unless the
  // caller says otherwise.
  // Putting files on this machine is for the server's own jobs, never for a caller.
  url.searchParams.delete('save');
  if (/^(info|resolve|debug|download|record)$/.test(route) && !url.searchParams.has('cookie_first')) {
    url.searchParams.set('cookie_first', '1');
  }
  url.searchParams.delete('key');
  url.searchParams.delete('token');
  const query = url.searchParams.toString();
  const path = (route === 'health' ? '/health' : route.startsWith('s/') ? '/' + route : '/api/' + route) + (query ? '?' + query : '');
  const base = target();
  const headers: Record<string, string> = {};
  for (const h of REQ_HEADERS) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  const upstream = http.request({
    hostname: base.hostname,
    port: base.port || 80,
    method: req.method,
    path,
    headers,
    // A merged download or a recording says nothing until the file is ready.
    timeout: 3 * 60 * 60_000,
  }, up => {
    const out: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
    for (const h of RES_HEADERS) {
      const v = up.headers[h];
      if (typeof v === 'string') out[h] = v;
    }
    // Cloudflare swaps the body of a 502 or 504 for its own error page, which would hide the
    // reason (for example "YouTube refused this video"): those go out as 500.
    const status = up.statusCode || 500;
    res.writeHead(status === 502 || status === 504 ? 500 : status, out);
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('ytp timed out')));
  upstream.on('error', e => {
    if (res.headersSent) { res.end(); return; }
    const offline = (e as NodeJS.ErrnoException).code === 'ECONNREFUSED';
    send(res, offline ? 503 : 500, {
      error: offline
        ? 'YouTube downloader service is not running (start src-go/ytp with `ytp serve -p 8084`)'
        : `YouTube downloader error: ${e.message}`,
    });
  });
  // Stop the download when the caller goes away.
  res.on('close', () => upstream.destroy());
  upstream.end();
  return true;
}
