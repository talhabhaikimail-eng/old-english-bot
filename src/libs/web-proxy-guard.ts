/**
 * @file web-proxy-guard.ts
 * @description Safety layer for the "lite" Corrosion web proxy.
 *
 *  - SSRF protection: loopback / private / link-local / cloud-metadata targets are refused, checked at connect time
 *    (guarded DNS lookup) so DNS-rebinding tricks cannot slip past a pre-check.
 *  - TLS verification stays ON (Corrosion hard-codes rejectUnauthorized:false; we override it per connection).
 *  - Per-session capability prefix: every proxy session gets its own random URL prefix and Corrosion instance, so the
 *    proxy never needs the dashboard credential in a URL and proxied pages can be sandboxed without same-origin.
 */

import * as dns from 'dns';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import { randomBytes } from 'crypto';

const Corrosion = require('corrosion');

// ── SSRF guard ───────────────────────────────────────────────────────────────

function ipv4Blocked(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||     // CGNAT
    (a === 169 && b === 254) ||               // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments + TEST-NET-1 (not all of 192.0/16)
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224                                  // multicast / reserved
  );
}

export function isBlockedIp(ipRaw: string): boolean {
  const ip = ipRaw.replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) return ipv4Blocked(ip.split('.').map(Number));
  if (family === 6) {
    if (ip === '::' || ip === '::1') return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4Blocked(mapped[1].split('.').map(Number));
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip)) return true; // hex-form mapped address: refuse
    return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('64:ff9b:') || ip.startsWith('ff');
  }
  return false;
}

export function isBlockedHostname(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || isBlockedIp(h);
}

/** DNS lookup that refuses to resolve to a blocked address. */
function guardedLookup(hostname: string, options: any, callback: any) {
  const opts = typeof options === 'function' ? {} : options || {};
  const cb = typeof options === 'function' ? options : callback;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses: any) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
    if (!list.length || list.some((a: any) => isBlockedIp(a.address))) {
      return cb(new Error(`Blocked: ${hostname} resolves to a private or internal address`));
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

class GuardedHttpAgent extends http.Agent {
  createConnection(options: any, cb?: any): any {
    if (options.host && isBlockedHostname(String(options.host))) {
      throw new Error(`Blocked target ${options.host}`);
    }
    return net.createConnection({ ...options, lookup: guardedLookup }, cb);
  }
}

class GuardedHttpsAgent extends https.Agent {
  createConnection(options: any, cb?: any): any {
    if (options.host && isBlockedHostname(String(options.host))) {
      throw new Error(`Blocked target ${options.host}`);
    }
    options.rejectUnauthorized = true; // Corrosion passes false; certificates must be valid
    options.lookup = guardedLookup;
    return (https.Agent.prototype as any).createConnection.call(this, options, cb);
  }
}

export const guardedHttpAgent = new GuardedHttpAgent({ keepAlive: false });
export const guardedHttpsAgent = new GuardedHttpsAgent({ keepAlive: false });

/** Throws if a URL string must not be fetched through the proxy. */
export function assertProxyTarget(target: string): URL {
  let u: URL;
  try { u = new URL(target); } catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs can be proxied');
  if (isBlockedHostname(u.hostname)) throw new Error('Blocked: private or internal addresses cannot be proxied');
  return u;
}

// ── Per-session capability prefix ───────────────────────────────────────────

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 12;

interface ProxySession { corrosion: any; prefix: string; created: number }
const sessions = new Map<string, ProxySession>();

function sweep(): void {
  const now = Date.now();
  for (const [tok, s] of sessions) {
    if (now - s.created > SESSION_TTL_MS) sessions.delete(tok);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

export function createProxySession(): { token: string; prefix: string; corrosion: any } {
  sweep();
  const token = randomBytes(18).toString('base64url');
  const prefix = `/api/web-proxy/${token}/`;
  const corrosion = new Corrosion({ prefix, codec: 'base64' });

  corrosion.config.requestMiddleware.push((ctx: any) => {
    // Runs after Corrosion's own header middleware: pin our guarded agent and reject blocked literals early.
    if (isBlockedHostname(ctx.url.hostname)) {
      if (ctx.clientResponse) {
        ctx.clientResponse.writeHead(403, { 'Content-Type': 'text/plain' });
        ctx.clientResponse.end('Blocked: private or internal addresses cannot be proxied');
        return;
      }
      throw new Error('Blocked: private or internal addresses cannot be proxied'); // websocket upgrade path
    }
    ctx.agent = ctx.url.protocol === 'https:' ? guardedHttpsAgent : guardedHttpAgent;
  });

  sessions.set(token, { corrosion, prefix, created: Date.now() });
  return { token, prefix, corrosion };
}

export function getProxySession(token: string): { corrosion: any; prefix: string } | null {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/** Extract the session token from /api/web-proxy/<token>/… */
export function proxyTokenFromUrl(url: string): string | null {
  const m = url.match(/^\/api\/web-proxy\/([A-Za-z0-9_-]{20,})(?:[/?]|$)/);
  return m ? m[1] : null;
}
