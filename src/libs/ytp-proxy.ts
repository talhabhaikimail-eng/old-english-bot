/**
 * @file ytp-proxy.ts
 * @description Forwards /api/ytp/* to the Go YouTube resolver and downloader (src-go/ytp,
 * started as `ytp serve`), which listens on loopback only. Dashboard authentication happens
 * in dashboard-server before requests reach here, so the Go service itself needs no auth.
 *
 *  /api/ytp/health                                   →  /health
 *  /api/ytp/resolve?url=…                            →  /api/resolve   (formats, timing)
 *  /api/ytp/download?url=…&height=720 | &audio=1 | &f=b|bv|ba|ITAG  →  /api/download
 *  /api/ytp/s/<key>?range=a-b                        →  /s/<key>       (byte-range proxy)
 *  POST /api/ytp/login   export the YouTube session of the dashboard's remote browser (sign in
 *                        there first) with `ytp login --cdp`, and save it to R2
 */

import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { exportYouTubeCookies, getYouTubeCookiesPath } from './browser';

const PREFIX = '/api/ytp/';
const target = () => new URL(process.env.YTP_URL || 'http://127.0.0.1:8084');

/** Headers worth passing through in each direction (no cookies or dashboard credentials). */
const REQ_HEADERS = ['accept', 'range', 'if-range'];
const RES_HEADERS = [
  'content-type', 'content-length', 'content-disposition', 'cache-control',
  'content-range', 'accept-ranges', 'last-modified', 'x-total-size',
];

let cookiesWritten = false;

export function handleYtpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith(PREFIX)) return false;
  if (req.method === 'POST' && url.pathname === PREFIX + 'login') {
    exportYouTubeCookies()
      .then(result => {
        res.writeHead(result.success ? 200 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: result.success, message: result.message }));
      })
      .catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: (e as Error).message }));
      });
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GET only' }));
    return true;
  }

  // The service reads browser_data/youtube-cookies.txt; make sure YOUTUBE_COOKIES from the
  // environment has been written there (the file is re-read by the service when it changes).
  if (!cookiesWritten) {
    cookiesWritten = true;
    getYouTubeCookiesPath();
  }

  const rest = url.pathname.slice(PREFIX.length);
  const path = rest === 'health' ? '/health' : rest.startsWith('s/') ? '/' + rest : '/api/' + rest;
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
    path: path + url.search,
    headers,
    // A merged download says nothing until both streams are fetched and joined.
    timeout: 900_000,
  }, up => {
    const out: Record<string, string> = {};
    for (const h of RES_HEADERS) {
      const v = up.headers[h];
      if (typeof v === 'string') out[h] = v;
    }
    res.writeHead(up.statusCode || 502, out);
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('ytp timed out')));
  upstream.on('error', e => {
    if (res.headersSent) { res.end(); return; }
    const offline = (e as NodeJS.ErrnoException).code === 'ECONNREFUSED';
    res.writeHead(offline ? 503 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: offline
        ? 'YouTube downloader service is not running (start src-go/ytp with `ytp serve -p 8084`)'
        : `YouTube downloader error: ${e.message}`,
    }));
  });
  // Stop the download when the caller goes away.
  res.on('close', () => upstream.destroy());
  upstream.end();
  return true;
}
