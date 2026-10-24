// Pure helpers for the SEO tools UI (no React, no path aliases — tested with node:assert).

export type Tone = 'good' | 'ok' | 'poor';

export function scoreTone(score: number): Tone {
  return score >= 80 ? 'good' : score >= 50 ? 'ok' : 'poor';
}

export function scoreLabel(score: number): string {
  return score >= 90 ? 'Excellent' : score >= 80 ? 'Good' : score >= 65 ? 'Needs work' : score >= 50 ? 'Poor' : 'Critical';
}

/** Rate a length against a recommended [min, max] window. */
export function lengthStatus(len: number, min: number, max: number): 'missing' | 'short' | 'ok' | 'long' {
  if (len <= 0) return 'missing';
  if (len < min) return 'short';
  if (len > max) return 'long';
  return 'ok';
}

// Approximate Arial advance widths (em units). Good enough to predict SERP truncation.
const NARROW = new Set("il.,;:'|!`ijI ".split(''));
const SEMI = new Set('frtJ()[]{}-/\\"*'.split(''));
const WIDE = new Set('mwMW@%'.split(''));

export function charWidthEm(ch: string): number {
  if (NARROW.has(ch)) return ch === ' ' ? 0.278 : 0.24;
  if (SEMI.has(ch)) return 0.333;
  if (WIDE.has(ch)) return 0.86;
  const c = ch.codePointAt(0) || 0;
  if (c >= 0x2e80) return 1; // CJK & friends: full width
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[0-9]/.test(ch)) return 0.556;
  return 0.54;
}

export function textWidthPx(text: string, fontPx: number): number {
  let w = 0;
  for (const ch of text) w += charWidthEm(ch);
  return Math.round(w * fontPx);
}

/** Cut text so it fits in maxPx at fontPx, adding an ellipsis (as Google does) when truncated. */
export function truncateToWidth(text: string, maxPx: number, fontPx: number): { text: string; truncated: boolean; widthPx: number } {
  const full = textWidthPx(text, fontPx);
  if (full <= maxPx) return { text, truncated: false, widthPx: full };
  const ell = charWidthEm('…') * fontPx;
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = charWidthEm(ch) * fontPx;
    if (w + cw + ell > maxPx) break;
    out += ch;
    w += cw;
  }
  // Prefer breaking at a word boundary like Google.
  const sp = out.lastIndexOf(' ');
  if (sp > out.length * 0.6) out = out.slice(0, sp);
  return { text: out.replace(/[\s,;:.-]+$/, '') + ' …', truncated: true, widthPx: full };
}

/** Google desktop limits (approximate). */
export const SERP = { titlePx: 580, titleFont: 20, descPx: 920, descFont: 14 };

/** "https://www.example.com/blog/post?x" → "example.com › blog › post" (Google-style breadcrumb). */
export function serpBreadcrumb(url: string): { site: string; crumbs: string } {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
    return { site: u.hostname.replace(/^www\./, ''), crumbs: [u.origin, ...parts].join(' › ') };
  } catch {
    return { site: url, crumbs: url };
  }
}

// ── load-time model (mirrors src/libs/tools/seo-weight.ts) ──────────────────

export interface NetProfile { id: string; label: string; kbps: number; rttMs: number }

export const PROFILES: NetProfile[] = [
  { id: '2g', label: '2G', kbps: 250, rttMs: 800 },
  { id: '3g', label: '3G', kbps: 1600, rttMs: 300 },
  { id: '4g', label: '4G / LTE', kbps: 9000, rttMs: 170 },
  { id: 'cable', label: 'Cable', kbps: 30000, rttMs: 40 },
  { id: 'fibre', label: 'Fibre / WiFi', kbps: 100000, rttMs: 20 },
];

export interface LoadModel {
  origins: number; https: boolean; requests: number; bytes: number;
  criticalOrigins: number; criticalBytes: number; hasBlocking: boolean;
}

/**
 * full load    = origins × setupRTTs × RTT + (1 + ceil((requests-1)/6)) × RTT + bytes × 8 / bandwidth
 * first render = criticalOrigins × setupRTTs × RTT + (1 + blocking?1:0) × RTT + criticalBytes × 8 / bandwidth
 * setupRTTs: 3 for https (DNS + TCP + TLS), 2 for http.
 */
export function estimateLoad(p: { kbps: number; rttMs: number }, m: LoadModel) {
  const setup = m.https ? 3 : 2;
  const bw = (p.kbps * 1000) / 8;
  const full = m.origins * setup * p.rttMs + (1 + Math.ceil(Math.max(0, m.requests - 1) / 6)) * p.rttMs + (m.bytes / bw) * 1000;
  const render = m.criticalOrigins * setup * p.rttMs + (1 + (m.hasBlocking ? 1 : 0)) * p.rttMs + (m.criticalBytes / bw) * 1000;
  return { fullMs: Math.round(full), renderMs: Math.round(render) };
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

// ── CSV / URL lists ──────────────────────────────────────────────────────────

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join(' ') : String(v);
  // Neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Split pasted text into unique http(s) URLs (bare domains get https://). */
export function parseUrlList(text: string, { max = Infinity } = {}): { urls: string[]; invalid: string[]; duplicates: number } {
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const raw of text.split(/[\r\n]+|\s+(?=https?:\/\/)/)) {
    const s = raw.trim().replace(/^[<"']|[>"',]$/g, '');
    if (!s || s.startsWith('#')) continue;
    let u: URL;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); } catch { invalid.push(s); continue; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname.includes('.') && u.hostname !== 'localhost') { invalid.push(s); continue; }
    u.hash = '';
    if (seen.has(u.href)) { duplicates++; continue; }
    seen.add(u.href);
    if (urls.length < max) urls.push(u.href);
  }
  return { urls, invalid, duplicates };
}

// ── social preview images ────────────────────────────────────────────────────

export type Platform = 'facebook' | 'x-large' | 'x-summary' | 'linkedin' | 'slack' | 'discord' | 'whatsapp' | 'imessage';

interface ImageSpec { label: string; ratio: number; minW: number; minH: number; recW: number; recH: number; maxBytes: number }

export const IMAGE_SPECS: Record<Platform, ImageSpec> = {
  facebook: { label: 'Facebook', ratio: 1.91, minW: 600, minH: 315, recW: 1200, recH: 630, maxBytes: 8 * 1024 * 1024 },
  'x-large': { label: 'X large image', ratio: 2, minW: 300, minH: 157, recW: 1200, recH: 600, maxBytes: 5 * 1024 * 1024 },
  'x-summary': { label: 'X summary', ratio: 1, minW: 144, minH: 144, recW: 400, recH: 400, maxBytes: 5 * 1024 * 1024 },
  linkedin: { label: 'LinkedIn', ratio: 1.91, minW: 1200, minH: 627, recW: 1200, recH: 627, maxBytes: 5 * 1024 * 1024 },
  slack: { label: 'Slack', ratio: 1.91, minW: 200, minH: 200, recW: 1200, recH: 630, maxBytes: 5 * 1024 * 1024 },
  discord: { label: 'Discord', ratio: 1.91, minW: 200, minH: 200, recW: 1200, recH: 630, maxBytes: 8 * 1024 * 1024 },
  whatsapp: { label: 'WhatsApp', ratio: 1.91, minW: 300, minH: 200, recW: 1200, recH: 630, maxBytes: 600 * 1024 },
  imessage: { label: 'iMessage', ratio: 1.91, minW: 300, minH: 157, recW: 1200, recH: 630, maxBytes: 5 * 1024 * 1024 },
};

/** Problems with an image for a platform (empty = fine). Unknown dimensions/bytes are not judged. */
export function imageIssues(platform: Platform, img: { width?: number; height?: number; bytes?: number; contentType?: string } | null | undefined): string[] {
  const spec = IMAGE_SPECS[platform];
  if (!img) return ['No image — the card shows text only.'];
  const out: string[] = [];
  const { width: w, height: h, bytes } = img;
  if (w && h) {
    if (w < spec.minW || h < spec.minH) out.push(`${w}×${h} is below ${spec.label}'s minimum ${spec.minW}×${spec.minH}.`);
    const r = w / h;
    if (Math.abs(r - spec.ratio) / spec.ratio > 0.12) out.push(`Aspect ratio ${r.toFixed(2)}:1 will be cropped (expects ${spec.ratio}:1, e.g. ${spec.recW}×${spec.recH}).`);
  }
  if (bytes && bytes > spec.maxBytes) out.push(`${Math.round(bytes / 1024)} KB exceeds ${spec.label}'s ~${Math.round(spec.maxBytes / 1024)} KB limit.`);
  if (img.contentType && /svg/i.test(img.contentType)) out.push('SVG images are not supported for link previews.');
  return out;
}

/** Hostname for card footers ("www.example.com" → "example.com"). */
export function siteName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Normalise user input to a URL string the backend accepts (adds https://). */
export function normalizeInput(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s;
}
