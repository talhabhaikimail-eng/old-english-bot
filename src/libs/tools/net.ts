/**
 * @file tools/net.ts
 * @description /api/tools/net/* — IP / geolocation, DNS, TLS certificate inspection, WHOIS + RDAP,
 * TCP port scanning, ping / traceroute and an HTTP header + redirect-chain inspector.
 *
 * Every user-supplied target goes through `resolveTarget`, which validates the name, resolves it
 * and refuses loopback / private / link-local / metadata addresses (unless
 * TOOLS_ALLOW_PRIVATE_TARGETS=1). Connections are then made to the vetted IP, so a DNS answer
 * that changes between check and use (rebinding) cannot redirect us to an internal host.
 * External programs (ping, traceroute) are spawned with argument arrays — never through a shell.
 */

import { spawn } from 'child_process';
import { X509Certificate } from 'crypto';
import * as dns from 'dns';
import * as http from 'http';
import * as http2 from 'http2';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { domainToASCII } from 'url';
import * as zlib from 'zlib';
import type { IncomingMessage } from 'http';
import { isBlockedHostname, isBlockedIp } from '../web-proxy-guard';
import { HttpError, readJson, sendJson, str, type ToolRoute } from './http';
import type { ConverterSpec } from './jobs';

// ── Target validation / SSRF guard ───────────────────────────────────────────

/** Some public APIs (rdap.org behind Cloudflare) reject Node's default fetch user agent. */
const FETCH_UA = 'Mozilla/5.0 (compatible; DevTools-NetTools/1.0)';

/**
 * isBlockedIp from the shared guard, minus its over-broad 192.0.0.0/16 rule: only 192.0.0.0/24
 * (IETF protocol assignments) and 192.0.2.0/24 (TEST-NET-1) are special — the rest of 192.0.x.x is
 * ordinary public space (e.g. whois.iana.org is 192.0.32.59).
 */
export function isBlocked(ip: string): boolean {
  const m = /^(?:::ffff:)?192\.0\.(\d+)\.(\d+)$/i.exec(ip.replace(/^\[|\]$/g, ''));
  if (m && m[1] !== '0' && m[1] !== '2' && Number(m[1]) <= 255 && Number(m[2]) <= 255) return false;
  return isBlockedIp(ip);
}

/** isBlockedHostname for names, the precise isBlocked for IP literals. */
export function isBlockedHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return net.isIP(h) ? isBlocked(h) : isBlockedHostname(h);
}

const allowPrivate = () => process.env.TOOLS_ALLOW_PRIVATE_TARGETS === '1';

const LABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const HOST_RE = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)*${LABEL}$`);

/**
 * Accepts a host name, IP, `host:port`, `[v6]:port` or a pasted URL and returns the bare host
 * (punycode for IDNs). Throws 400 for anything that isn't a plausible public host name.
 */
export function normalizeHost(input: unknown, name = 'host'): string {
  let s = str(input, name, { max: 2048 }).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { s = new URL(s).hostname; } catch { throw new HttpError(400, `"${s}" is not a valid URL`); }
  } else {
    s = s.replace(/[/?#].*$/, '');
  }
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  if (net.isIP(s)) return s.toLowerCase();
  s = s.replace(/:\d{1,5}$/, '').replace(/\.$/, '').toLowerCase();
  if (net.isIP(s)) return s;
  const ascii = domainToASCII(s);
  if (!ascii || !HOST_RE.test(ascii) || /^\d+$/.test(ascii.split('.').pop()!)) {
    throw new HttpError(400, `"${String(input).slice(0, 100)}" is not a valid host name or IP address`);
  }
  if (!allowPrivate() && isBlockedHost(ascii)) refuse(ascii);
  if (!ascii.includes('.') && !allowPrivate()) {
    throw new HttpError(400, `"${ascii}" is a single-label name — use a fully-qualified domain (e.g. example.com)`);
  }
  return ascii;
}

function refuse(host: string, ip?: string): never {
  throw new HttpError(403, ip && ip !== host
    ? `Refused: ${host} resolves to ${ip}, a private / loopback / link-local address`
    : `Refused: ${host} is a private / loopback / link-local / internal address`);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

export interface Target { host: string; ip: string; family: 4 | 6; addresses: string[] }

/** Resolve a (normalized) host and refuse internal addresses. Prefers IPv4 by default. */
export async function resolveTarget(host: string, { preferV4 = true } = {}): Promise<Target> {
  if (!allowPrivate() && isBlockedHost(host)) refuse(host);
  let list: { address: string; family: number }[];
  const fam = net.isIP(host);
  if (fam) list = [{ address: host, family: fam }];
  else {
    try {
      list = await withTimeout(dns.promises.lookup(host, { all: true, verbatim: true }), 8000, 'DNS lookup timed out');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new HttpError(422, code === 'ENOTFOUND' ? `${host} does not resolve (NXDOMAIN)` : `Could not resolve ${host}: ${code || (e as Error).message}`);
    }
  }
  if (!list.length) throw new HttpError(422, `${host} has no addresses`);
  if (!allowPrivate()) {
    const bad = list.find(a => isBlocked(a.address));
    if (bad) refuse(host, bad.address);
  }
  const pick = (preferV4 && list.find(a => a.family === 4)) || list[0];
  return { host, ip: pick.address, family: pick.family as 4 | 6, addresses: list.map(a => a.address) };
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ── IP / geolocation ─────────────────────────────────────────────────────────

let serverIpCache: { ip: string; at: number } | null = null;

async function serverPublicIp(): Promise<string | null> {
  if (serverIpCache && Date.now() - serverIpCache.at < 5 * 60_000) return serverIpCache.ip;
  let ip: string | null = null;
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    ip = ((await r.json()) as any).ip || null;
  } catch {
    try {
      const r = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) });
      ip = /^ip=(.+)$/m.exec(await r.text())?.[1].trim() || null;
    } catch { /* offline */ }
  }
  if (ip) serverIpCache = { ip, at: Date.now() };
  return ip;
}

function callerIp(req: IncomingMessage): { ip: string; source: string } {
  const h = req.headers;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
  const cf = first(h['cf-connecting-ip']);
  if (cf) return { ip: cf, source: 'CF-Connecting-IP' };
  const xff = first(h['x-forwarded-for']);
  if (xff) return { ip: xff, source: 'X-Forwarded-For' };
  const real = first(h['x-real-ip']);
  if (real) return { ip: real, source: 'X-Real-IP' };
  return { ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), source: 'socket' };
}

export interface GeoInfo {
  ip: string;
  type?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  postal?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  asn?: string;
  org?: string;
  isp?: string;
  domain?: string;
  flags?: { proxy?: boolean; hosting?: boolean; mobile?: boolean };
  source: string;
}

async function geolocate(ip: string): Promise<GeoInfo> {
  const errors: string[] = [];
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { headers: { 'User-Agent': FETCH_UA }, signal: AbortSignal.timeout(6000) });
    const j: any = await r.json();
    if (j.success) {
      return {
        ip: j.ip, type: j.type, country: j.country, countryCode: j.country_code, region: j.region, city: j.city,
        postal: j.postal || undefined, latitude: j.latitude, longitude: j.longitude, timezone: j.timezone?.id,
        asn: j.connection?.asn ? `AS${j.connection.asn}` : undefined, org: j.connection?.org, isp: j.connection?.isp,
        domain: j.connection?.domain || undefined, source: 'ipwho.is',
      };
    }
    errors.push(`ipwho.is: ${j.message || 'lookup failed'}`);
  } catch (e) {
    errors.push(`ipwho.is: ${(e as Error).message}`);
  }
  try {
    const fields = 'status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query';
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`, { signal: AbortSignal.timeout(6000) });
    const j: any = await r.json();
    if (j.status === 'success') {
      return {
        ip: j.query, type: net.isIP(ip) === 6 ? 'IPv6' : 'IPv4', country: j.country, countryCode: j.countryCode,
        region: j.regionName, city: j.city, postal: j.zip || undefined, latitude: j.lat, longitude: j.lon,
        timezone: j.timezone, asn: String(j.as || '').split(' ')[0] || undefined, org: j.org || undefined, isp: j.isp,
        flags: { proxy: j.proxy, hosting: j.hosting, mobile: j.mobile }, source: 'ip-api.com',
      };
    }
    errors.push(`ip-api.com: ${j.message || 'lookup failed'}`);
  } catch (e) {
    errors.push(`ip-api.com: ${(e as Error).message}`);
  }
  throw new HttpError(502, `Geolocation failed — ${errors.join('; ')}`);
}

async function reverseName(ip: string): Promise<string[]> {
  try { return await withTimeout(dns.promises.reverse(ip), 4000, 'timeout'); } catch { return []; }
}

// ── DNS ──────────────────────────────────────────────────────────────────────

const RESOLVERS: Record<string, { label: string; servers: string[] }> = {
  system: { label: 'System resolver', servers: [] },
  cloudflare: { label: 'Cloudflare (1.1.1.1)', servers: ['1.1.1.1', '1.0.0.1'] },
  google: { label: 'Google (8.8.8.8)', servers: ['8.8.8.8', '8.8.4.4'] },
  quad9: { label: 'Quad9 (9.9.9.9)', servers: ['9.9.9.9', '149.112.112.112'] },
};

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'SRV', 'PTR'] as const;
type DnsType = typeof DNS_TYPES[number];

const DNS_ERRORS: Record<string, string> = {
  ENODATA: 'No records of this type',
  ENOTFOUND: 'Domain does not exist (NXDOMAIN)',
  ESERVFAIL: 'Server failure (SERVFAIL) — often a broken DNSSEC chain or lame delegation',
  EREFUSED: 'Query refused by the resolver',
  ETIMEOUT: 'Timed out',
  ECONNREFUSED: 'Could not contact the resolver',
  EBADNAME: 'Invalid name',
  EFORMERR: 'Malformed query',
};

const DOH: Record<string, string> = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query',
  quad9: 'https://dns.quad9.net/dns-query',
};
const TYPE_NUM: Record<DnsType, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };
const RCODES: Record<number, string> = { 1: 'EFORMERR', 2: 'ESERVFAIL', 3: 'ENOTFOUND', 4: 'ENOTIMP', 5: 'EREFUSED' };

class DnsError extends Error { constructor(public code: string, message?: string) { super(message || code); } }

export function arpaName(ip: string): string {
  if (net.isIP(ip) === 4) return ip.split('.').reverse().join('.') + '.in-addr.arpa';
  const [a, b] = ip.includes('::') ? ip.split('::') : [ip, undefined];
  const l = a ? a.split(':') : [];
  const r = b ? b.split(':') : [];
  const groups = b === undefined ? l : [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  return groups.map(g => g.padStart(4, '0')).join('').split('').reverse().join('.') + '.ip6.arpa';
}

/** Build an RFC 1035 query (id 0 per RFC 8484, RD + AD bits, EDNS0 OPT with a 4096-byte buffer). */
export function encodeDnsQuery(name: string, type: number): Buffer {
  const labels = name.replace(/\.$/, '').split('.').filter(Boolean).map(l => {
    const b = Buffer.from(l, 'latin1');
    if (b.length > 63) throw new DnsError('EBADNAME');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  const header = Buffer.from([0, 0, 0x01, 0x20, 0, 1, 0, 0, 0, 0, 0, 1]);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(1, 2);
  const opt = Buffer.from([0, 0, 41, 0x10, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, ...labels, Buffer.from([0]), q, opt]);
}

function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let end = -1;
  for (let jumps = 0; jumps < 64; jumps++) {
    const len = buf[pos];
    if (len === undefined) throw new Error('truncated name');
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (len === 0) return [labels.join('.'), end < 0 ? pos + 1 : end];
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('latin1'));
    pos += 1 + len;
  }
  throw new Error('name compression loop');
}

function formatV6(b: Buffer): string {
  const g = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16));
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return g.join(':');
  return `${g.slice(0, best).join(':')}::${g.slice(best + bestLen).join(':')}`;
}

/** Parse the answer section of a DNS response for one record type. */
export function decodeDnsResponse(buf: Buffer, type: number): { rcode: number; ad: boolean; answers: { ttl: number; data: any }[] } {
  if (buf.length < 12) throw new Error('short DNS response');
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  let pos = 12;
  for (let i = 0; i < qd; i++) { pos = readName(buf, pos)[1] + 4; }
  const answers: { ttl: number; data: any }[] = [];
  for (let i = 0; i < an; i++) {
    const [, p] = readName(buf, pos);
    const rtype = buf.readUInt16BE(p);
    const ttl = buf.readUInt32BE(p + 4);
    const rdlen = buf.readUInt16BE(p + 8);
    const rd = p + 10;
    pos = rd + rdlen;
    if (rtype !== type) continue;
    const rdata = buf.subarray(rd, rd + rdlen);
    let data: any;
    switch (rtype) {
      case 1: data = Array.from(rdata).join('.'); break;
      case 28: data = formatV6(rdata); break;
      case 2: case 5: case 12: data = readName(buf, rd)[0]; break;
      case 15: data = { priority: buf.readUInt16BE(rd), exchange: readName(buf, rd + 2)[0] }; break;
      case 16: {
        const chunks: string[] = [];
        for (let o = 0; o < rdata.length;) { const l = rdata[o]; chunks.push(rdata.subarray(o + 1, o + 1 + l).toString('utf8')); o += 1 + l; }
        data = chunks;
        break;
      }
      case 6: {
        const [mname, p1] = readName(buf, rd);
        const [rname, p2] = readName(buf, p1);
        data = { nsname: mname, hostmaster: rname, serial: buf.readUInt32BE(p2), refresh: buf.readUInt32BE(p2 + 4), retry: buf.readUInt32BE(p2 + 8), expire: buf.readUInt32BE(p2 + 12), minttl: buf.readUInt32BE(p2 + 16) };
        break;
      }
      case 33: data = { priority: buf.readUInt16BE(rd), weight: buf.readUInt16BE(rd + 2), port: buf.readUInt16BE(rd + 4), name: readName(buf, rd + 6)[0] }; break;
      case 257: {
        const tl = rdata[1];
        data = { critical: rdata[0], tag: rdata.subarray(2, 2 + tl).toString('latin1'), tagValue: rdata.subarray(2 + tl).toString('utf8') };
        break;
      }
      default: data = rdata.toString('hex');
    }
    answers.push({ ttl, data });
  }
  return { rcode: flags & 0x0f, ad: !!(flags & 0x20), answers };
}

const h2Sessions = new Map<string, http2.ClientHttp2Session>();

/** GET over HTTP/2 (Quad9's DoH endpoint only speaks h2), reusing one session per origin. */
function h2Get(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let session = h2Sessions.get(url.origin);
    if (!session || session.closed || session.destroyed) {
      session = http2.connect(url.origin);
      session.on('error', () => h2Sessions.delete(url.origin));
      session.on('close', () => h2Sessions.delete(url.origin));
      session.setTimeout(30_000, () => session!.close());
      session.unref();
      h2Sessions.set(url.origin, session);
    }
    const req = session.request({ ':method': 'GET', ':path': url.pathname + url.search, ...headers });
    const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); reject(new Error('DoH request timed out')); }, timeoutMs);
    let status = 0;
    const chunks: Buffer[] = [];
    req.on('response', h => { status = Number(h[':status']); });
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => { clearTimeout(timer); resolve({ status, body: Buffer.concat(chunks) }); });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

/** RFC 8484 DNS-over-HTTPS (GET, application/dns-message). */
async function dohQuery(endpoint: string, name: string, type: DnsType): Promise<{ records: any[]; ad: boolean }> {
  const qname = type === 'PTR' ? arpaName(name) : name;
  const q = encodeDnsQuery(qname, TYPE_NUM[type]).toString('base64url');
  const r = await h2Get(new URL(`${endpoint}?dns=${q}`), { accept: 'application/dns-message' }, 6000);
  if (r.status !== 200) throw new Error(`DoH HTTP ${r.status}`);
  const { rcode, ad, answers } = decodeDnsResponse(r.body, TYPE_NUM[type]);
  if (rcode) throw new DnsError(RCODES[rcode] || `RCODE${rcode}`);
  if (!answers.length) throw new DnsError('ENODATA');
  const records = answers.map(({ ttl, data }) => {
    switch (type) {
      case 'MX': return { value: data.exchange, priority: data.priority, ttl };
      case 'TXT': return { value: data.join(''), chunks: data.length, ttl };
      case 'SOA': return { value: `${data.nsname} ${data.hostmaster} ${data.serial} ${data.refresh} ${data.retry} ${data.expire} ${data.minttl}`, ...data, ttl };
      case 'CAA': return { value: `${data.critical} ${data.tag} "${data.tagValue}"`, ...data, ttl };
      case 'SRV': return { value: `${data.priority} ${data.weight} ${data.port} ${data.name}`, ...data, ttl };
      default: return { value: data, ttl };
    }
  });
  if (type === 'MX' || type === 'SRV') records.sort((a: any, b: any) => a.priority - b.priority);
  if (type === 'NS') records.sort((a: any, b: any) => a.value.localeCompare(b.value));
  return { records, ad };
}

async function queryType(r: dns.promises.Resolver, name: string, type: DnsType): Promise<any[]> {
  switch (type) {
    case 'A': return (await r.resolve4(name, { ttl: true })).map(x => ({ value: x.address, ttl: x.ttl }));
    case 'AAAA': return (await r.resolve6(name, { ttl: true })).map(x => ({ value: x.address, ttl: x.ttl }));
    case 'CNAME': return (await r.resolveCname(name)).map(value => ({ value }));
    case 'NS': return (await r.resolveNs(name)).sort().map(value => ({ value }));
    case 'MX': return (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map(x => ({ value: x.exchange, priority: x.priority }));
    case 'TXT': return (await r.resolveTxt(name)).map(chunks => ({ value: chunks.join(''), chunks: chunks.length }));
    case 'SOA': {
      const s = await r.resolveSoa(name);
      return [{ value: `${s.nsname} ${s.hostmaster} ${s.serial} ${s.refresh} ${s.retry} ${s.expire} ${s.minttl}`, ...s }];
    }
    case 'CAA': return (await r.resolveCaa(name)).map((x: any) => {
      const tag = ['issue', 'issuewild', 'iodef', 'contactemail', 'contactphone'].find(t => x[t] !== undefined) || 'unknown';
      return { value: `${x.critical} ${tag} "${x[tag] ?? ''}"`, critical: x.critical, tag, tagValue: x[tag] };
    });
    case 'SRV': return (await r.resolveSrv(name)).sort((a, b) => a.priority - b.priority || b.weight - a.weight)
      .map(x => ({ value: `${x.priority} ${x.weight} ${x.port} ${x.name}`, ...x }));
    case 'PTR': return (await r.reverse(name)).map(value => ({ value }));
  }
}

// ── TLS ──────────────────────────────────────────────────────────────────────

function parseDn(dn: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (dn || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) {
      const k = line.slice(0, i);
      out[k] = out[k] ? `${out[k]}, ${line.slice(i + 1)}` : line.slice(i + 1);
    }
  }
  return out;
}

function certInfo(x: X509Certificate) {
  const pk = x.publicKey;
  const d = pk.asymmetricKeyDetails || {};
  const validTo = new Date(x.validTo);
  const validFrom = new Date(x.validFrom);
  let selfSigned = false;
  try { selfSigned = x.checkIssued(x) && x.verify(pk); } catch { /* ignore */ }
  return {
    subject: parseDn(x.subject),
    issuer: parseDn(x.issuer),
    sans: (x.subjectAltName || '').split(/,\s*/).filter(Boolean),
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    daysRemaining: Math.floor((validTo.getTime() - Date.now()) / 86400000),
    serialNumber: x.serialNumber,
    fingerprint256: x.fingerprint256,
    fingerprint1: x.fingerprint,
    keyType: pk.asymmetricKeyType,
    keyBits: d.modulusLength ?? (d.namedCurve ? { prime256v1: 256, secp384r1: 384, secp521r1: 521 }[d.namedCurve as string] : pk.asymmetricKeyType === 'ed25519' ? 256 : undefined),
    curve: d.namedCurve,
    signatureAlgorithm: (x as any).signatureAlgorithm as string | undefined,
    isCA: x.ca,
    selfSigned,
    keyUsage: x.keyUsage,
    infoAccess: x.infoAccess?.split('\n').filter(Boolean),
    pem: x.toString(),
  };
}

function tlsConnect(opts: tls.ConnectionOptions, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(opts);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`TLS handshake timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    socket.once('secureConnect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', e => { clearTimeout(timer); socket.destroy(); reject(e); });
  });
}

async function probeProtocol(ip: string, port: number, servername: string | undefined, version: tls.SecureVersion) {
  const legacy = version === 'TLSv1' || version === 'TLSv1.1';
  try {
    const s = await tlsConnect({
      host: ip, port, servername, rejectUnauthorized: false, minVersion: version, maxVersion: version,
      ...(legacy ? { ciphers: 'DEFAULT@SECLEVEL=0' } : {}),
    }, 5000);
    s.destroy();
    return { version, supported: true };
  } catch (e) {
    const msg = (e as Error).message;
    // Our own OpenSSL refusing to even try is not the server's answer.
    if (/no protocols available|unsupported protocol.*(client|ssl_choose_client_version)/i.test(msg) && legacy) {
      return { version, supported: null, note: 'Not testable from this server' };
    }
    return { version, supported: false };
  }
}

// ── WHOIS / RDAP ─────────────────────────────────────────────────────────────

function whoisQuery(server: string, ip: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const socket = net.connect({ host: ip, port: 43 });
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error(`${server} timed out`)); });
    socket.on('connect', () => socket.write(query + '\r\n'));
    socket.on('data', (d: Buffer) => {
      size += d.length;
      if (size <= 256 * 1024) chunks.push(d);
      else socket.destroy();
    });
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', e => reject(new Error(`${server}: ${e.message}`)));
  });
}

function whoisQueryFor(server: string, q: string, isIp: boolean): string {
  if (server === 'whois.arin.net' && isIp) return `n + ${q}`;
  if (server === 'whois.denic.de') return `-T dn,ace ${q}`;
  if (server === 'whois.verisign-grs.com' && !isIp) return `domain ${q}`;
  return q;
}

function findReferral(text: string, current: string): string | null {
  const m = /^\s*(?:refer|whois|ReferralServer|Registrar WHOIS Server|whois server)\s*:\s*(\S+)/im.exec(text);
  if (!m) return null;
  const v = m[1].trim();
  if (/^(rwhois|https?):/i.test(v)) return null;
  let s = v.replace(/^whois:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
  if (!s || s === current) return null;
  try { s = normalizeHost(s); } catch { return null; }
  return s;
}

async function rawWhois(query: string, isIp: boolean) {
  const hops: { server: string; text: string; error?: string }[] = [];
  let server = 'whois.iana.org';
  for (let i = 0; i < 3 && server; i++) {
    try {
      const t = await resolveTarget(server);
      const text = await whoisQuery(server, t.ip, whoisQueryFor(server, query, isIp));
      hops.push({ server, text: text.trim() });
      const next = findReferral(text, server);
      if (!next || hops.some(h => h.server === next)) break;
      server = next;
    } catch (e) {
      hops.push({ server, text: '', error: (e as Error).message });
      break;
    }
  }
  return hops;
}

function vcardField(entity: any, field: string): string | undefined {
  const arr = entity?.vcardArray?.[1];
  if (!Array.isArray(arr)) return undefined;
  const f = arr.find((x: any[]) => x[0] === field);
  if (!f) return undefined;
  const v = f[3];
  if (Array.isArray(v)) return v.filter(Boolean).join(', ') || f[1]?.label;
  return String(v || f[1]?.label || '').replace(/^(mailto|tel):/i, '') || undefined;
}

function flattenEntities(list: any[] = [], out: any[] = []): any[] {
  for (const e of list) { out.push(e); if (e.entities) flattenEntities(e.entities, out); }
  return out;
}

function isRedacted(v: string | undefined) {
  return !v || /redacted|privacy|withheld|not disclosed|data protected|gdpr/i.test(v);
}

function normalizeRdap(j: any) {
  const events: Record<string, string> = {};
  for (const e of j.events || []) if (e.eventAction && e.eventDate) events[e.eventAction] = e.eventDate;
  const ents = flattenEntities(j.entities || []);
  const byRole = (role: string) => ents.find(e => (e.roles || []).includes(role));
  const registrar = byRole('registrar');
  const abuse = byRole('abuse');
  const registrant = byRole('registrant');
  const regOrg = registrant ? (vcardField(registrant, 'org') || vcardField(registrant, 'fn')) : undefined;
  const ianaId = registrar?.publicIds?.find((p: any) => /iana/i.test(p.type))?.identifier;
  const kind = j.objectClassName as string;
  return {
    kind,
    handle: j.handle,
    name: j.ldhName || j.unicodeName || j.name,
    unicodeName: j.unicodeName,
    status: j.status || [],
    created: events.registration,
    updated: events['last changed'],
    expires: events.expiration,
    rdapUpdated: events['last update of RDAP database'],
    registrar: registrar ? { name: vcardField(registrar, 'fn'), ianaId, url: registrar.links?.find((l: any) => l.rel === 'about')?.href } : undefined,
    abuse: abuse ? { email: vcardField(abuse, 'email'), phone: vcardField(abuse, 'tel'), name: vcardField(abuse, 'fn') } : undefined,
    registrant: regOrg && !isRedacted(regOrg) ? { org: regOrg, country: registrant ? vcardField(registrant, 'adr')?.split(', ').pop() : undefined } : undefined,
    nameservers: (j.nameservers || []).map((n: any) => String(n.ldhName || '').toLowerCase()).filter(Boolean),
    dnssec: j.secureDNS ? !!j.secureDNS.delegationSigned : undefined,
    // IP networks
    startAddress: j.startAddress,
    endAddress: j.endAddress,
    cidrs: (j.cidr0_cidrs || []).map((c: any) => `${c.v4prefix || c.v6prefix}/${c.length}`),
    ipVersion: j.ipVersion,
    country: j.country,
    networkType: j.type,
    parentHandle: j.parentHandle,
    orgs: kind === 'ip network' || kind === 'autnum'
      ? [...new Set(ents.filter(e => (e.roles || []).includes('registrant')).map(e => vcardField(e, 'fn')).filter(Boolean))]
      : undefined,
    remarks: (j.remarks || []).map((r: any) => [r.title, ...(r.description || [])].filter(Boolean).join(': ')).slice(0, 5),
    relatedLinks: (j.links || []).filter((l: any) => l.rel === 'related' && /rdap/i.test(String(l.type || l.href))).map((l: any) => l.href),
  };
}

async function fetchRdap(url: string): Promise<{ json: any; url: string }> {
  const r = await fetch(url, { headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': FETCH_UA }, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (r.status === 404) throw new HttpError(404, 'Not found in RDAP');
  if (!r.ok) throw new Error(`RDAP HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('RDAP response too large');
  return { json: JSON.parse(text), url: r.url };
}

/** Fetch an RDAP URL found in a response, only if it is a public https host. */
async function fetchRelatedRdap(href: string) {
  const u = new URL(href);
  if (u.protocol !== 'https:') throw new Error('not https');
  await resolveTarget(normalizeHost(u.hostname));
  return fetchRdap(u.href);
}

// ── Port scanning ────────────────────────────────────────────────────────────

export const SERVICES: Record<number, string> = {
  7: 'echo', 9: 'discard', 13: 'daytime', 20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 26: 'rsftp',
  37: 'time', 53: 'dns', 67: 'dhcp', 69: 'tftp', 79: 'finger', 80: 'http', 81: 'http-alt', 88: 'kerberos', 106: 'pop3pw',
  110: 'pop3', 111: 'rpcbind', 113: 'ident', 119: 'nntp', 123: 'ntp', 135: 'msrpc', 137: 'netbios-ns', 139: 'netbios-ssn',
  143: 'imap', 144: 'news', 161: 'snmp', 179: 'bgp', 199: 'smux', 389: 'ldap', 427: 'svrloc', 443: 'https', 444: 'snpp',
  445: 'smb', 465: 'smtps', 513: 'rlogin', 514: 'shell', 515: 'printer', 543: 'klogin', 544: 'kshell', 548: 'afp',
  554: 'rtsp', 587: 'submission', 631: 'ipp', 636: 'ldaps', 646: 'ldp', 853: 'dns-over-tls', 873: 'rsync', 990: 'ftps',
  993: 'imaps', 995: 'pop3s', 1025: 'nfs-or-iis', 1026: 'lsa-or-nterm', 1027: 'iis', 1028: 'unknown', 1029: 'ms-lsa',
  1080: 'socks', 1110: 'nfsd-status', 1194: 'openvpn', 1433: 'mssql', 1521: 'oracle', 1720: 'h323', 1723: 'pptp',
  1755: 'wms', 1883: 'mqtt', 1900: 'upnp', 2000: 'cisco-sccp', 2001: 'dc', 2049: 'nfs', 2082: 'cpanel', 2083: 'cpanel-ssl',
  2121: 'ccproxy-ftp', 2181: 'zookeeper', 2375: 'docker', 2376: 'docker-tls', 2379: 'etcd', 2717: 'pn-requester',
  3000: 'http-dev', 3128: 'squid-http', 3306: 'mysql', 3389: 'rdp', 3986: 'mapper-ws-ethd', 4369: 'epmd', 4443: 'https-alt',
  4899: 'radmin', 5000: 'upnp/http-dev', 5009: 'airport-admin', 5051: 'ida-agent', 5060: 'sip', 5061: 'sips', 5101: 'admdog',
  5190: 'aol', 5357: 'wsdapi', 5432: 'postgresql', 5631: 'pcanywhere', 5666: 'nrpe', 5672: 'amqp', 5800: 'vnc-http',
  5900: 'vnc', 5984: 'couchdb', 6000: 'x11', 6001: 'x11:1', 6379: 'redis', 6443: 'kubernetes-api', 6646: 'unknown',
  7070: 'realserver', 7474: 'neo4j', 8000: 'http-alt', 8008: 'http', 8009: 'ajp13', 8080: 'http-proxy', 8081: 'http-alt',
  8086: 'influxdb', 8443: 'https-alt', 8888: 'http-alt', 9000: 'http-alt', 9042: 'cassandra', 9092: 'kafka',
  9100: 'jetdirect', 9200: 'elasticsearch', 9300: 'elasticsearch-nodes', 9418: 'git', 9999: 'abyss', 10000: 'webmin',
  11211: 'memcached', 25565: 'minecraft', 27017: 'mongodb', 27018: 'mongodb', 28017: 'mongodb-http', 32768: 'filenet-tms',
  49152: 'msrpc-dyn', 49153: 'msrpc-dyn', 49154: 'msrpc-dyn', 49155: 'msrpc-dyn', 49156: 'msrpc-dyn', 49157: 'msrpc-dyn',
};

export const PORT_PRESETS: Record<string, number[]> = {
  common: [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 587, 993, 995, 3306, 3389, 5432, 6379, 8080, 8443],
  web: [80, 81, 443, 3000, 4443, 5000, 8000, 8008, 8080, 8081, 8443, 8888, 9000],
  databases: [1433, 1521, 2181, 3306, 5432, 5984, 6379, 7474, 8086, 9042, 9092, 9200, 11211, 27017, 27018],
  mail: [25, 110, 143, 465, 587, 993, 995],
  top100: [7, 9, 13, 21, 22, 23, 25, 26, 37, 53, 79, 80, 81, 88, 106, 110, 111, 113, 119, 135, 139, 143, 144, 179, 199, 389,
    427, 443, 444, 445, 465, 513, 514, 515, 543, 544, 548, 554, 587, 631, 646, 873, 990, 993, 995, 1025, 1026, 1027, 1028,
    1029, 1110, 1433, 1720, 1723, 1755, 1900, 2000, 2001, 2049, 2121, 2717, 3000, 3128, 3306, 3389, 3986, 4899, 5000, 5009,
    5051, 5060, 5101, 5190, 5357, 5432, 5631, 5666, 5800, 5900, 6000, 6001, 6646, 7070, 8000, 8008, 8009, 8080, 8081, 8443,
    8888, 9100, 9999, 10000, 32768, 49152, 49153, 49154, 49155, 49156, 49157],
};

export const MAX_PORTS = 1024;

export function parsePorts(spec: string): number[] {
  const preset = PORT_PRESETS[spec.trim().toLowerCase()];
  if (preset) return [...preset];
  const out = new Set<number>();
  for (const raw of spec.split(/[\s,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) throw new HttpError(400, `"${part}" is not a port or range`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b) throw new HttpError(400, `Invalid port range "${part}" (1–65535)`);
    if (b - a + 1 + out.size > MAX_PORTS) throw new HttpError(400, `At most ${MAX_PORTS} ports per scan`);
    for (let p = a; p <= b; p++) out.add(p);
  }
  if (!out.size) throw new HttpError(400, 'No ports given');
  return [...out].sort((x, y) => x - y);
}

const HTTP_PROBE_PORTS = new Set([80, 81, 3000, 5000, 8000, 8008, 8080, 8081, 8888, 9000]);

type PortStatus = 'open' | 'closed' | 'filtered';

function probePort(ip: string, port: number, timeoutMs: number, grabBanner: boolean): Promise<{ port: number; status: PortStatus; ms?: number; banner?: string; error?: string }> {
  return new Promise(resolve => {
    const t0 = performance.now();
    const socket = net.connect({ host: ip, port });
    let done = false;
    const finish = (r: { status: PortStatus; ms?: number; banner?: string; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ port, ...r });
    };
    const timer = setTimeout(() => finish({ status: 'filtered', error: 'timeout' }), timeoutMs);
    socket.once('connect', () => {
      const ms = round(performance.now() - t0, 1);
      clearTimeout(timer);
      if (!grabBanner) return finish({ status: 'open', ms });
      let buf = '';
      const end = () => finish({ status: 'open', ms, banner: sanitizeBanner(buf) || undefined });
      const bt = setTimeout(end, 1000);
      socket.on('data', (d: Buffer) => {
        buf += d.toString('latin1');
        if (buf.length > 512 || buf.includes('\n')) { clearTimeout(bt); end(); }
      });
      socket.on('close', () => { clearTimeout(bt); end(); });
      socket.on('error', () => { clearTimeout(bt); end(); });
      if (HTTP_PROBE_PORTS.has(port)) socket.write(`HEAD / HTTP/1.0\r\nHost: ${ip}\r\nUser-Agent: port-scan\r\n\r\n`);
    });
    socket.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED') finish({ status: 'closed', ms: round(performance.now() - t0, 1) });
      else finish({ status: 'filtered', error: e.code || e.message });
    });
  });
}

function sanitizeBanner(s: string) {
  return s.split(/\r?\n/)[0].replace(/[^\x20-\x7e]/g, '·').trim().slice(0, 200);
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ── Ping / traceroute ────────────────────────────────────────────────────────

function tcpConnectTime(ip: string, port: number, timeoutMs: number): Promise<{ ms: number | null; error?: string }> {
  return new Promise(resolve => {
    const t0 = performance.now();
    const s = net.connect({ host: ip, port });
    const timer = setTimeout(() => { s.destroy(); resolve({ ms: null, error: 'timeout' }); }, timeoutMs);
    s.once('connect', () => { clearTimeout(timer); const ms = performance.now() - t0; s.destroy(); resolve({ ms: round(ms, 2) }); });
    s.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      s.destroy();
      // A RST still proves the host answered — report it as reachable but note the closed port.
      if (e.code === 'ECONNREFUSED') resolve({ ms: round(performance.now() - t0, 2), error: 'refused (port closed, host up)' });
      else resolve({ ms: null, error: e.code || e.message });
    });
  });
}

export function latencyStats(samples: (number | null)[]) {
  const ok = samples.filter((x): x is number => typeof x === 'number');
  const sent = samples.length;
  if (!ok.length) return { sent, received: 0, loss: 100, min: null, avg: null, max: null, stddev: null, jitter: null };
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  const variance = ok.reduce((a, b) => a + (b - avg) ** 2, 0) / ok.length;
  let jitter = 0;
  for (let i = 1; i < ok.length; i++) jitter += Math.abs(ok[i] - ok[i - 1]);
  return {
    sent, received: ok.length, loss: round(((sent - ok.length) / sent) * 100, 1),
    min: round(Math.min(...ok), 2), avg: round(avg, 2), max: round(Math.max(...ok), 2), stddev: round(Math.sqrt(variance), 2),
    jitter: ok.length > 1 ? round(jitter / (ok.length - 1), 2) : 0,
  };
}

interface SpawnResult { code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException; timedOut?: boolean }

/** Spawn without a shell and capture output even when the exit code is non-zero (ping exits 1 on loss). */
function spawnCapture(cmd: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { windowsHide: true, shell: false, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    } catch (e) {
      return resolve({ code: null, stdout, stderr, error: e as NodeJS.ErrnoException });
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 512 * 1024) stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 64 * 1024) stderr += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, stdout, stderr, error: e as NodeJS.ErrnoException }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

const IS_WIN = process.platform === 'win32';

const NOT_PERMITTED = /permission denied|operation not permitted|are you root|must be root|cap_net_raw|socket: /i;

/** Parse Windows / iputils / busybox ping output into per-probe RTTs (null = lost). */
export function parsePingOutput(out: string, count: number) {
  const lines = out.split(/\r?\n/);
  let ttl: number | undefined;
  const rttOf = (line: string) => {
    const t = /time\s*([=<])\s*([\d.]+)\s*ms/i.exec(line);
    if (!t) return undefined;
    const ttlM = /ttl=(\d+)/i.exec(line);
    if (ttlM) ttl = Number(ttlM[1]);
    return t[1] === '<' ? Number(t[2]) / 2 : Number(t[2]);
  };
  let rtts: (number | null)[];
  if (/\b(?:icmp_)?seq=\d+/.test(out)) {
    // iputils numbers probes from 1 (icmp_seq=), busybox from 0 (seq=); missing numbers were lost.
    const base = /icmp_seq=/.test(out) ? 1 : 0;
    const bySeq = new Map<number, number>();
    for (const line of lines) {
      const ms = rttOf(line);
      const seq = /seq=(\d+)/.exec(line);
      if (ms !== undefined && seq && !bySeq.has(Number(seq[1]))) bySeq.set(Number(seq[1]), ms);
    }
    rtts = Array.from({ length: count }, (_, i) => bySeq.get(i + base) ?? null);
  } else {
    // Windows: one line per probe, in order.
    rtts = [];
    for (const line of lines) {
      const ms = rttOf(line);
      if (ms !== undefined) rtts.push(ms);
      else if (/timed out|unreachable|general failure|transmit failed|ttl expired/i.test(line)) rtts.push(null);
    }
    rtts = Array.from({ length: count }, (_, i) => rtts[i] ?? null);
  }
  return { rtts, ttl };
}

export interface Hop { hop: number; ip: string | null; rtts: (number | null)[]; private?: boolean; host?: string }

/** Parse tracert (Windows), traceroute -n (Linux/busybox) or tracepath -n output. */
export function parseTraceOutput(out: string): Hop[] {
  const hops = new Map<number, Hop>();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(\d{1,2})\??[:\s]\s*(.*)$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    const rest = m[2];
    if (/\[LOCALHOST\]|pmtu/i.test(rest) && !/\d+\.\d+\.\d+\.\d+.*ms/.test(rest)) continue;
    const ipM = /(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:]+[0-9a-f])/i.exec(rest.replace(/\d+(?:\.\d+)?\s*ms/gi, ''));
    const rtts: (number | null)[] = [];
    const tokens = rest.match(/<?\d+(?:\.\d+)?\s*ms|\*/gi) || [];
    for (const tok of tokens) {
      if (tok === '*') rtts.push(null);
      else rtts.push(Number(tok.replace(/[<ms\s]/gi, '')) || (tok.startsWith('<') ? 0.5 : 0));
    }
    if (/no reply/i.test(rest) && !rtts.length) rtts.push(null);
    if (!ipM && !rtts.length) continue;
    const ip = ipM ? ipM[1] : null;
    const prev = hops.get(n);
    if (prev) { prev.rtts.push(...rtts); if (!prev.ip && ip) prev.ip = ip; continue; }
    hops.set(n, { hop: n, ip, rtts, private: ip ? isBlocked(ip) : undefined });
  }
  return [...hops.values()].sort((a, b) => a.hop - b.hop);
}

// ── HTTP inspector ───────────────────────────────────────────────────────────

const MAX_BODY = 5 * 1024 * 1024;
const MAX_HOPS = 10;

interface HopResult {
  url: string;
  ip?: string;
  status?: number;
  statusText?: string;
  httpVersion?: string;
  headers: [string, string][];
  location?: string;
  timings: { dns: number; connect: number; tls?: number; ttfb: number; total: number };
  bodyBytes?: number;
  decodedBytes?: number;
  truncated?: boolean;
  contentEncoding?: string;
  tls?: { protocol?: string; cipher?: string; authorized: boolean; error?: string; subject?: string; issuer?: string; validTo?: string; alpn?: string };
  error?: string;
}

function requestOnce(url: URL, ip: string, method: 'GET' | 'HEAD', userAgent: string, readBody: boolean, timeoutMs: number, dnsMs: number): Promise<HopResult> {
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const t0 = performance.now();
    const marks: { connect?: number; tls?: number; ttfb?: number } = {};
    const lib = isHttps ? https : http;
    const result: HopResult = { url: url.href, ip, headers: [], timings: { dns: dnsMs, connect: 0, ttfb: 0, total: 0 } };
    let settled = false;
    const done = (extra: Partial<HopResult> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const end = performance.now();
      result.timings = {
        dns: dnsMs,
        connect: round((marks.connect ?? end) - t0, 1),
        ...(isHttps ? { tls: marks.tls !== undefined && marks.connect !== undefined ? round(marks.tls - marks.connect, 1) : undefined } : {}),
        ttfb: marks.ttfb !== undefined ? round(marks.ttfb - t0, 1) : 0,
        total: round(end - t0 + dnsMs, 1),
      };
      Object.assign(result, extra);
      resolve(result);
    };
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      // Connect to the vetted IP; Host header / SNI keep the original name.
      lookup: ((_h: string, opts: any, cb: any) => {
        const fam = net.isIP(ip);
        if (opts?.all) cb(null, [{ address: ip, family: fam }]);
        else cb(null, ip, fam);
      }) as any,
      servername: isHttps && !net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? url.hostname : undefined,
      rejectUnauthorized: false,
      agent: false,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        Connection: 'close',
      },
    } as https.RequestOptions);
    const timer = setTimeout(() => { req.destroy(new Error(`Timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);

    req.on('socket', socket => {
      socket.once('connect', () => { marks.connect = performance.now(); });
      socket.once('secureConnect', () => { marks.tls = performance.now(); });
    });
    req.on('response', res => {
      marks.ttfb = performance.now();
      result.status = res.statusCode;
      result.statusText = res.statusMessage;
      result.httpVersion = res.httpVersion;
      const raw = res.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) result.headers.push([raw[i].toLowerCase(), raw[i + 1]]);
      const loc = res.headers.location;
      if (loc) result.location = loc;
      if (isHttps) {
        const s = res.socket as tls.TLSSocket;
        const cert = s.getPeerCertificate?.();
        result.tls = {
          protocol: s.getProtocol?.() || undefined,
          cipher: s.getCipher?.()?.name,
          authorized: s.authorized,
          error: s.authorizationError ? String(s.authorizationError) : undefined,
          subject: cert?.subject?.CN as string | undefined,
          issuer: (cert?.issuer?.O || cert?.issuer?.CN) as string | undefined,
          validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : undefined,
          alpn: s.alpnProtocol || undefined,
        };
      }
      if (!readBody || method === 'HEAD') { res.resume(); res.on('end', () => done()); res.on('error', () => done()); return; }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      result.contentEncoding = enc || undefined;
      let bytes = 0;
      let decoded = 0;
      let truncated = false;
      const decoder = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip()
        : enc === 'br' ? zlib.createBrotliDecompress()
          : enc === 'deflate' ? zlib.createInflate() : null;
      decoder?.on('data', (d: Buffer) => { decoded += d.length; if (decoded > 4 * MAX_BODY) decoder.destroy(); });
      decoder?.on('error', () => { /* corrupt or truncated stream: keep the transfer size */ });
      res.on('data', (d: Buffer) => {
        bytes += d.length;
        if (decoder && !decoder.destroyed) decoder.write(d);
        if (bytes > MAX_BODY) { truncated = true; res.destroy(); }
      });
      const finish = () => {
        const fin = () => done({ bodyBytes: bytes, decodedBytes: decoder ? decoded : bytes, truncated });
        if (decoder && !decoder.destroyed && !truncated) { decoder.end(); decoder.once('end', fin); decoder.once('error', fin); setTimeout(fin, 1000); }
        else fin();
      };
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    req.on('error', e => {
      const code = (e as NodeJS.ErrnoException).code;
      done({ error: code ? `${code}: ${e.message}` : e.message });
    });
    req.end();
  });
}

type Check = { id: string; label: string; status: 'pass' | 'warn' | 'fail' | 'info'; points: number; max: number; value?: string; detail: string };

/** Score a response's security headers (securityheaders.com style, 0–100 → A+…F). */
export function securityHeaderReport(headers: [string, string][], isHttps: boolean) {
  const get = (n: string) => headers.filter(([k]) => k === n).map(([, v]) => v);
  const one = (n: string) => get(n)[0];
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const hsts = one('strict-transport-security');
  if (!isHttps) add({ id: 'hsts', label: 'Strict-Transport-Security', status: 'fail', points: 0, max: 20, detail: 'Site is not served over HTTPS, so HSTS cannot apply.' });
  else if (!hsts) add({ id: 'hsts', label: 'Strict-Transport-Security', status: 'fail', points: 0, max: 20, detail: 'Missing — browsers may be downgraded to plain HTTP.' });
  else {
    const maxAge = Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1] ?? 0);
    const sub = /includesubdomains/i.test(hsts);
    const preload = /preload/i.test(hsts);
    const good = maxAge >= 15552000;
    add({
      id: 'hsts', label: 'Strict-Transport-Security', value: hsts, max: 20,
      status: good ? 'pass' : 'warn', points: good ? 20 : 10,
      detail: `max-age ${Math.round(maxAge / 86400)} days${sub ? ', includeSubDomains' : ''}${preload ? ', preload' : ''}${good ? '' : ' — use at least 180 days (1 year recommended)'}.`,
    });
  }

  const csp = one('content-security-policy');
  const cspRo = one('content-security-policy-report-only');
  if (csp) {
    const weak: string[] = [];
    if (/'unsafe-inline'/.test(csp) && !/'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(csp)) weak.push("'unsafe-inline'");
    if (/'unsafe-eval'/.test(csp)) weak.push("'unsafe-eval'");
    if (/(^|[\s;])(default-src|script-src)[^;]*\s\*(\s|;|$)/.test(csp)) weak.push('wildcard source');
    if (!/default-src|script-src/.test(csp)) weak.push('no default-src / script-src');
    add({
      id: 'csp', label: 'Content-Security-Policy', value: csp, max: 25,
      status: weak.length ? 'warn' : 'pass', points: weak.length ? 15 : 25,
      detail: weak.length ? `Present but weakened by ${weak.join(', ')}.` : 'Present.',
    });
  } else {
    add({ id: 'csp', label: 'Content-Security-Policy', status: 'fail', points: cspRo ? 5 : 0, max: 25, value: cspRo, detail: cspRo ? 'Only a report-only policy is set — it does not block anything.' : 'Missing — the main defence against XSS and data injection.' });
  }

  const xfo = one('x-frame-options');
  const frameAncestors = csp && /frame-ancestors/i.test(csp);
  add({
    id: 'xfo', label: 'X-Frame-Options', value: xfo, max: 15,
    status: xfo || frameAncestors ? 'pass' : 'fail', points: xfo || frameAncestors ? 15 : 0,
    detail: xfo ? `${xfo.toUpperCase()}${frameAncestors ? ' (CSP frame-ancestors also set)' : ''}.` : frameAncestors ? 'Covered by CSP frame-ancestors.' : 'Missing — the page can be framed (clickjacking).',
  });

  const xcto = one('x-content-type-options');
  add({
    id: 'xcto', label: 'X-Content-Type-Options', value: xcto, max: 15,
    status: /nosniff/i.test(xcto || '') ? 'pass' : 'fail', points: /nosniff/i.test(xcto || '') ? 15 : 0,
    detail: /nosniff/i.test(xcto || '') ? 'nosniff.' : 'Missing — browsers may MIME-sniff responses.',
  });

  const rp = one('referrer-policy');
  const unsafeRp = /unsafe-url|no-referrer-when-downgrade/i.test(rp || '');
  add({
    id: 'referrer', label: 'Referrer-Policy', value: rp, max: 10,
    status: rp ? (unsafeRp ? 'warn' : 'pass') : 'fail', points: rp ? (unsafeRp ? 5 : 10) : 0,
    detail: rp ? (unsafeRp ? 'Set, but leaks full URLs to other origins.' : 'Set.') : 'Missing — browsers default to strict-origin-when-cross-origin.',
  });

  const pp = one('permissions-policy') || one('feature-policy');
  add({
    id: 'permissions', label: 'Permissions-Policy', value: pp, max: 10,
    status: pp ? 'pass' : 'fail', points: pp ? 10 : 0,
    detail: pp ? 'Set.' : 'Missing — powerful features (camera, geolocation…) are not restricted.',
  });

  const coop = one('cross-origin-opener-policy');
  const coep = one('cross-origin-embedder-policy');
  const corp = one('cross-origin-resource-policy');
  const iso = [coop && 'COOP', coep && 'COEP', corp && 'CORP'].filter(Boolean);
  add({
    id: 'isolation', label: 'Cross-Origin isolation (COOP / COEP / CORP)', max: 5,
    value: [coop && `COOP: ${coop}`, coep && `COEP: ${coep}`, corp && `CORP: ${corp}`].filter(Boolean).join(' · ') || undefined,
    status: coop ? 'pass' : 'info', points: coop ? 5 : 0,
    detail: iso.length ? `${iso.join(', ')} set.` : 'None set (optional, but COOP protects against cross-window attacks).',
  });

  // Cookies
  const cookies = get('set-cookie');
  const cookieReports = cookies.map(c => {
    const name = c.split('=')[0].trim();
    const attrs = c.toLowerCase();
    const secure = /;\s*secure/.test(attrs);
    const httpOnly = /;\s*httponly/.test(attrs);
    const sameSite = /;\s*samesite=(\w+)/.exec(attrs)?.[1];
    const issues: string[] = [];
    if (isHttps && !secure) issues.push('no Secure');
    if (!httpOnly) issues.push('no HttpOnly');
    if (!sameSite) issues.push('no SameSite');
    if (sameSite === 'none' && !secure) issues.push('SameSite=None without Secure');
    if (/^__(secure|host)-/i.test(name) && !secure) issues.push('prefix requires Secure');
    return { name, secure, httpOnly, sameSite: sameSite || null, issues };
  });
  if (cookieReports.length) {
    const bad = cookieReports.filter(c => c.issues.length);
    add({
      id: 'cookies', label: `Cookies (${cookieReports.length})`, max: 0, points: bad.length ? -5 : 0,
      status: bad.length ? 'warn' : 'pass',
      detail: bad.length ? `${bad.length} cookie(s) missing flags: ${bad.map(c => `${c.name} (${c.issues.join(', ')})`).join('; ')}` : 'All cookies have Secure / HttpOnly / SameSite.',
    });
  }

  // Information disclosure
  const server = one('server');
  const powered = one('x-powered-by');
  const aspnet = one('x-aspnet-version') || one('x-aspnetmvc-version');
  const leaks = [server && /\d/.test(server) && `Server: ${server}`, powered && `X-Powered-By: ${powered}`, aspnet && `X-AspNet-Version: ${aspnet}`].filter(Boolean) as string[];
  add({
    id: 'disclosure', label: 'Version disclosure', max: 0, points: leaks.length ? -5 : 0,
    status: leaks.length ? 'warn' : 'pass',
    detail: leaks.length ? `Reveals software versions: ${leaks.join(', ')}.` : 'No version banners.',
  });
  if (one('x-xss-protection') && !/^0/.test(one('x-xss-protection')!)) {
    add({ id: 'xxss', label: 'X-XSS-Protection', value: one('x-xss-protection'), max: 0, points: 0, status: 'info', detail: 'Deprecated; modern guidance is to omit it or set 0 and rely on CSP.' });
  }

  const max = checks.reduce((a, c) => a + c.max, 0);
  const score = Math.max(0, Math.min(100, Math.round((checks.reduce((a, c) => a + c.points, 0) / max) * 100)));
  const allPass = checks.filter(c => c.max > 0 && c.id !== 'isolation').every(c => c.status === 'pass');
  const grade = score >= 95 && allPass && !leaks.length ? 'A+' : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : score >= 25 ? 'E' : 'F';
  return { grade, score, checks, cookies: cookieReports };
}

// ── Routes ───────────────────────────────────────────────────────────────────

const PING_TIMEOUT = 3000;

export const routes: ToolRoute[] = [
  {
    method: 'GET',
    path: '/api/tools/net/ip',
    handler: async ({ req, res, query }) => {
      const q = (query.get('q') || '').trim();
      const [server, caller] = [serverPublicIp(), callerIp(req)];
      let target: string | null = null;
      let addresses: string[] | undefined;
      let host: string | undefined;
      if (q) {
        const h = normalizeHost(q, 'q');
        const t = await resolveTarget(h);
        target = t.ip;
        addresses = t.addresses;
        host = net.isIP(h) ? undefined : h;
      } else {
        target = caller.ip && net.isIP(caller.ip) && !isBlocked(caller.ip) ? caller.ip : await server;
      }
      if (!target) throw new HttpError(502, 'Could not determine an IP to look up');
      const [geo, ptr, serverIp] = await Promise.all([geolocate(target), reverseName(target), server]);
      sendJson(res, {
        server: { ip: serverIp },
        client: { ...caller, private: caller.ip ? isBlocked(caller.ip) : undefined },
        query: q || null,
        host,
        addresses,
        lookup: { ...geo, ptr },
      });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/net/dns',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const name = normalizeHost(body.name, 'name');
      if (!allowPrivate() && isBlockedHost(name)) refuse(name);
      const resolverId = String(body.resolver || 'cloudflare');
      const resolverDef = RESOLVERS[resolverId];
      if (!resolverDef) throw new HttpError(400, `resolver must be one of ${Object.keys(RESOLVERS).join(', ')}`);
      const isIp = !!net.isIP(name);
      let types: DnsType[];
      const requested = (Array.isArray(body.types) ? body.types : String(body.types || '').split(','))
        .map((t: unknown) => String(t).trim().toUpperCase()).filter(Boolean);
      if (isIp) types = ['PTR'];
      else if (!requested.length || requested.includes('ANY') || requested.includes('ALL')) types = DNS_TYPES.filter(t => t !== 'PTR');
      else {
        const bad = requested.filter((t: string) => !(DNS_TYPES as readonly string[]).includes(t));
        if (bad.length) throw new HttpError(400, `Unsupported record type(s): ${bad.join(', ')}`);
        types = [...new Set(requested)] as DnsType[];
        if (types.includes('PTR')) throw new HttpError(400, 'PTR lookups take an IP address as the name');
      }
      const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
      if (resolverDef.servers.length) resolver.setServers(resolverDef.servers);
      // Public resolvers are queried over DNS-over-HTTPS (TTLs for every type, DNSSEC AD flag, works where
      // outbound UDP/53 is filtered); classic UDP is the fallback and the only option for "system".
      const transport = body.transport === 'udp' ? 'udp' : body.transport === 'doh' ? 'doh' : 'auto';
      const doh = resolverId !== 'system' && transport !== 'udp' ? DOH[resolverId] : undefined;
      const t0 = performance.now();
      const results = await Promise.all(types.map(async type => {
        const s = performance.now();
        const fail = (e: unknown, via: string) => {
          const code = (e as NodeJS.ErrnoException).code || 'ERROR';
          return { type, records: [] as any[], ms: round(performance.now() - s, 1), via, code, error: DNS_ERRORS[code] || (e as Error).message };
        };
        if (doh) {
          try {
            const { records, ad } = await dohQuery(doh, name, type);
            return { type, records, ms: round(performance.now() - s, 1), via: 'DoH', dnssec: ad };
          } catch (e) {
            if (e instanceof DnsError || transport === 'doh') return fail(e, 'DoH');
            // network-level DoH failure → fall back to UDP below
          }
        }
        try {
          const records = await queryType(resolver, name, type);
          return { type, records, ms: round(performance.now() - s, 1), via: 'UDP' };
        } catch (e) {
          return fail(e, 'UDP');
        }
      }));
      const nx = results.length > 0 && results.every(r => (r as { code?: string }).code === 'ENOTFOUND');
      sendJson(res, {
        name,
        resolver: { id: resolverId, label: resolverDef.label, servers: resolver.getServers(), doh },
        nxdomain: nx,
        dnssec: results.some(r => (r as any).dnssec) ? true : doh ? false : undefined,
        totalMs: round(performance.now() - t0, 1),
        results,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/net/ssl',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const host = normalizeHost(body.host);
      const port = Number(body.port || 443);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'port must be 1–65535');
      const servername = body.servername ? normalizeHost(body.servername, 'servername') : net.isIP(host) ? undefined : host;
      const target = await resolveTarget(host);
      const t0 = performance.now();
      let socket: tls.TLSSocket;
      try {
        socket = await tlsConnect({
          host: target.ip, port, servername, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'],
        }, 10_000);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        throw new HttpError(502, `TLS connection to ${host}:${port} failed: ${code ? code + ' ' : ''}${(e as Error).message}`);
      }
      const handshakeMs = round(performance.now() - t0, 1);
      try {
        const peer = socket.getPeerCertificate(true) as tls.DetailedPeerCertificate;
        if (!peer || !peer.raw) throw new HttpError(502, 'Server did not present a certificate');
        const chain: ReturnType<typeof certInfo>[] = [];
        const seen = new Set<string>();
        let cur: tls.DetailedPeerCertificate | undefined = peer;
        while (cur && cur.raw && !seen.has(cur.fingerprint256) && chain.length < 10) {
          seen.add(cur.fingerprint256);
          chain.push(certInfo(new X509Certificate(cur.raw)));
          cur = cur.issuerCertificate && cur.issuerCertificate !== cur ? cur.issuerCertificate : undefined;
        }
        const leaf = chain[0];
        let hostnameMatch = true;
        let hostnameError: string | undefined;
        if (servername) {
          const err = tls.checkServerIdentity(servername, peer);
          if (err) { hostnameMatch = false; hostnameError = err.message; }
        }
        const cipher = socket.getCipher();
        const ephemeral = socket.getEphemeralKeyInfo() as any;
        const result = {
          host, port, servername, ip: target.ip, handshakeMs,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : undefined,
          hostnameMatch, hostnameError,
          protocol: socket.getProtocol(),
          cipher: { name: cipher?.name, standardName: (cipher as any)?.standardName, version: cipher?.version },
          ephemeralKey: ephemeral && ephemeral.type ? { type: ephemeral.type, name: ephemeral.name, size: ephemeral.size } : undefined,
          alpn: socket.alpnProtocol || null,
          leaf,
          chain,
          protocols: undefined as unknown,
        };
        socket.destroy();
        if (body.protocols !== false) {
          result.protocols = await Promise.all((['TLSv1.3', 'TLSv1.2', 'TLSv1.1', 'TLSv1'] as tls.SecureVersion[])
            .map(v => probeProtocol(target.ip, port, servername, v)));
        }
        sendJson(res, result);
      } finally {
        socket.destroy();
      }
    },
  },
  {
    method: 'POST',
    path: '/api/tools/net/whois',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const q = normalizeHost(body.query, 'query');
      const isIp = !!net.isIP(q);
      if (!allowPrivate() && (isBlockedHost(q) || (isIp && isBlocked(q)))) refuse(q);
      if (!isIp && !q.includes('.')) throw new HttpError(400, 'Enter a domain name (example.com) or an IP address');

      const rdapTask = (async () => {
        if (isIp) {
          const r = await fetchRdap(`https://rdap.org/ip/${q}`);
          return { url: r.url, data: normalizeRdap(r.json) };
        }
        // Registries only know registered domains: walk www.a.example.com → a.example.com → example.com.
        const labels = q.split('.');
        let lastErr: Error | null = null;
        for (let i = 0; i <= Math.min(labels.length - 2, 3); i++) {
          const d = labels.slice(i).join('.');
          try {
            const r = await fetchRdap(`https://rdap.org/domain/${d}`);
            const data = normalizeRdap(r.json);
            let registrarUrl: string | undefined;
            // The registrar's own RDAP often has the registrant / abuse details the registry omits.
            if (data.relatedLinks[0] && (!data.abuse?.email || !data.registrant)) {
              try {
                const rr = await fetchRelatedRdap(data.relatedLinks[0]);
                registrarUrl = rr.url;
                const extra = normalizeRdap(rr.json);
                data.abuse = data.abuse?.email ? data.abuse : extra.abuse ?? data.abuse;
                data.registrant = data.registrant ?? extra.registrant;
                data.registrar = { ...extra.registrar, ...data.registrar } as any;
              } catch { /* optional */ }
            }
            return { url: r.url, registrarUrl, domain: d, data };
          } catch (e) {
            lastErr = e as Error;
            if (!(e instanceof HttpError && e.status === 404)) break;
          }
        }
        throw lastErr || new Error('RDAP lookup failed');
      })();

      const [rdap, raw] = await Promise.allSettled([rdapTask, rawWhois(q, isIp)]);
      const rawHops = raw.status === 'fulfilled' ? raw.value : [];
      // If the domain isn't registered RDAP says 404 and WHOIS says "No match".
      const available = !isIp && rdap.status === 'rejected' && rawHops.some(h => /no match|not found|no data found|no entries found|status:\s*free|is available/i.test(h.text));
      sendJson(res, {
        query: q,
        type: isIp ? 'ip' : 'domain',
        rdap: rdap.status === 'fulfilled' ? rdap.value : null,
        rdapError: rdap.status === 'rejected' ? (rdap.reason as Error).message : undefined,
        raw: rawHops,
        rawError: raw.status === 'rejected' ? (raw.reason as Error).message : undefined,
        available,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/net/ports',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const host = normalizeHost(body.host);
      const ports = parsePorts(String(body.ports ?? body.preset ?? 'common'));
      const timeoutMs = Math.round(Number(body.timeoutMs ?? 1500));
      if (!(timeoutMs >= 200 && timeoutMs <= 5000)) throw new HttpError(400, 'timeoutMs must be 200–5000');
      const concurrency = Math.max(1, Math.min(64, Number(body.concurrency) || 64));
      const target = await resolveTarget(host);
      const t0 = performance.now();
      const results = await mapPool(ports, concurrency, p => probePort(target.ip, p, timeoutMs, !!body.banner));
      const out = results.map(r => ({ ...r, service: SERVICES[r.port] }));
      sendJson(res, {
        host, ip: target.ip, ms: Math.round(performance.now() - t0),
        summary: {
          scanned: out.length,
          open: out.filter(r => r.status === 'open').length,
          closed: out.filter(r => r.status === 'closed').length,
          filtered: out.filter(r => r.status === 'filtered').length,
        },
        results: out,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/net/ping',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const host = normalizeHost(body.host);
      const count = Math.round(Number(body.count ?? 4));
      if (!(count >= 1 && count <= 20)) throw new HttpError(400, 'count must be 1–20');
      const mode = body.mode === 'icmp' ? 'icmp' : 'tcp';
      const target = await resolveTarget(host);
      if (mode === 'tcp') {
        const port = Number(body.port || 443);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'port must be 1–65535');
        const samples: { seq: number; ms: number | null; error?: string }[] = [];
        for (let i = 0; i < count; i++) {
          const r = await tcpConnectTime(target.ip, port, PING_TIMEOUT);
          samples.push({ seq: i + 1, ...r });
          if (i < count - 1) await new Promise(r2 => setTimeout(r2, 300));
        }
        return sendJson(res, { mode, host, ip: target.ip, port, samples, stats: latencyStats(samples.map(s => s.ms)) });
      }
      const v6 = target.family === 6;
      const args = IS_WIN
        ? ['-n', String(count), '-w', '2000', ...(v6 ? ['-6'] : ['-4']), target.ip]
        : ['-c', String(count), '-W', '2', ...(v6 ? ['-6'] : []), target.ip];
      const r = await spawnCapture('ping', args, count * 3000 + 10_000);
      if (r.error?.code === 'ENOENT') throw new HttpError(501, 'ICMP ping is not available on this server (no ping binary) — use TCP mode instead');
      const text = r.stdout + r.stderr;
      if (NOT_PERMITTED.test(text) && !/time[=<]/i.test(text)) {
        throw new HttpError(501, 'ICMP ping is not permitted for the server\'s user (needs CAP_NET_RAW or ping_group_range) — use TCP mode instead');
      }
      if (r.error) throw new HttpError(500, `ping failed: ${r.error.message}`);
      const parsed = parsePingOutput(r.stdout, count);
      const samples = parsed.rtts.map((ms, i) => ({ seq: i + 1, ms, error: ms === null ? 'no reply' : undefined }));
      sendJson(res, { mode, host, ip: target.ip, ttl: parsed.ttl, samples, stats: latencyStats(parsed.rtts), raw: r.stdout.trim().slice(0, 8000) });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/net/traceroute',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const host = normalizeHost(body.host);
      const maxHops = Math.round(Number(body.maxHops ?? 20));
      if (!(maxHops >= 1 && maxHops <= 30)) throw new HttpError(400, 'maxHops must be 1–30');
      const target = await resolveTarget(host);
      const v6 = target.family === 6;
      const attempts: [string, string[]][] = IS_WIN
        ? [['tracert', ['-d', '-h', String(maxHops), '-w', '700', ...(v6 ? ['-6'] : ['-4']), target.ip]]]
        : [
          ['traceroute', ['-n', '-q', '2', '-w', '1', '-m', String(maxHops), ...(v6 ? ['-6'] : []), target.ip]],
          ['tracepath', ['-n', '-m', String(maxHops), target.ip]],
        ];
      const t0 = performance.now();
      const problems: string[] = [];
      for (const [cmd, args] of attempts) {
        const r = await spawnCapture(cmd, args, 90_000);
        if (r.error?.code === 'ENOENT') { problems.push(`${cmd} not installed`); continue; }
        const text = r.stdout + r.stderr;
        const hops = parseTraceOutput(r.stdout);
        if (!hops.length && NOT_PERMITTED.test(text)) { problems.push(`${cmd} not permitted`); continue; }
        if (!hops.length && r.code !== 0) { problems.push(`${cmd}: ${text.trim().split(/\r?\n/).slice(-2).join(' ') || 'failed'}`); continue; }
        const reached = hops.some(h => h.ip === target.ip);
        return sendJson(res, {
          host, ip: target.ip, tool: cmd, maxHops, reached, timedOut: !!r.timedOut,
          ms: Math.round(performance.now() - t0), hops, raw: r.stdout.trim().slice(0, 20_000),
        });
      }
      throw new HttpError(501, `Traceroute is not available on this server (${problems.join('; ')}). In Docker, install the "traceroute" or "iputils-tracepath" package.`);
    },
  },
  {
    method: 'POST',
    path: '/api/tools/net/http',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      let raw = str(body.url, 'url', { max: 4096 }).trim();
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
      let url: URL;
      try { url = new URL(raw); } catch { throw new HttpError(400, 'Invalid URL'); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Only http:// and https:// URLs are supported');
      if (url.username || url.password) throw new HttpError(400, 'URLs with credentials are not supported');
      const method = body.method === 'HEAD' ? 'HEAD' : 'GET';
      const follow = body.followRedirects !== false;
      const userAgent = String(body.userAgent || 'Mozilla/5.0 (compatible; DevTools-HeaderInspector/1.0)').slice(0, 400);

      const hops: HopResult[] = [];
      const visited = new Set<string>();
      let error: string | undefined;
      let current = url;
      for (let i = 0; i < MAX_HOPS + 1; i++) {
        if (visited.has(current.href)) { error = `Redirect loop detected at ${current.href}`; break; }
        visited.add(current.href);
        const d0 = performance.now();
        let target: Target;
        try {
          target = await resolveTarget(normalizeHost(current.hostname));
        } catch (e) {
          if (i === 0) throw e;
          error = `Redirect to ${current.href} was not followed — ${(e as Error).message}`;
          break;
        }
        const dnsMs = net.isIP(current.hostname.replace(/^\[|\]$/g, '')) ? 0 : round(performance.now() - d0, 1);
        const hop = await requestOnce(current, target.ip, method, userAgent, true, 15_000, dnsMs);
        hops.push(hop);
        if (hop.error) { error = hop.error; break; }
        const isRedirect = hop.status && [301, 302, 303, 307, 308].includes(hop.status) && hop.location;
        if (!isRedirect || !follow) break;
        if (i === MAX_HOPS) { error = `Stopped after ${MAX_HOPS} redirects`; break; }
        let next: URL;
        try { next = new URL(hop.location!, current); } catch { error = `Invalid Location header: ${hop.location}`; break; }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') { error = `Redirect to unsupported scheme ${next.protocol}`; break; }
        current = next;
      }
      const final = hops[hops.length - 1];
      const finalUrl = final ? new URL(final.url) : url;
      sendJson(res, {
        url: url.href,
        method,
        finalUrl: finalUrl.href,
        redirects: Math.max(0, hops.length - 1),
        upgradedToHttps: url.protocol === 'http:' && finalUrl.protocol === 'https:',
        totalMs: round(hops.reduce((a, h) => a + h.timings.total, 0), 1),
        hops,
        error,
        security: final && final.status ? securityHeaderReport(final.headers, finalUrl.protocol === 'https:') : null,
      });
    },
  },
];

export const converters: ConverterSpec[] = [];
