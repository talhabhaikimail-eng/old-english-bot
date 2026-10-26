/**
 * @file site-audit-proxy.ts
 * @description Forwards /api/site-audit/* to the Go site-auditor service (src-go/site-auditor),
 * which listens on loopback only. Dashboard authentication happens in dashboard-server before
 * requests reach here, so the Go service itself needs no auth.
 *
 *  /api/site-audit/<path>  →  ${SITE_AUDITOR_URL}/api/<path>
 */

import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';

const PREFIX = '/api/site-audit/';
const target = () => new URL(process.env.SITE_AUDITOR_URL || 'http://127.0.0.1:8083');

/** Headers worth passing through in each direction (no cookies or dashboard credentials). */
const REQ_HEADERS = ['content-type', 'content-length', 'accept'];
const RES_HEADERS = ['content-type', 'content-length', 'content-disposition', 'cache-control'];

export function handleSiteAuditRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith(PREFIX)) return false;

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
    path: '/api/' + url.pathname.slice(PREFIX.length) + url.search,
    headers,
    timeout: 120_000,
  }, up => {
    const out: Record<string, string> = {};
    for (const h of RES_HEADERS) {
      const v = up.headers[h];
      if (typeof v === 'string') out[h] = v;
    }
    res.writeHead(up.statusCode || 502, out);
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('site auditor timed out')));
  upstream.on('error', e => {
    if (res.headersSent) { res.end(); return; }
    const offline = (e as NodeJS.ErrnoException).code === 'ECONNREFUSED';
    res.writeHead(offline ? 503 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: offline
        ? 'Site auditor service is not running (start src-go/site-auditor on port 8083)'
        : `Site auditor error: ${e.message}`,
    }));
  });
  req.pipe(upstream);
  return true;
}
