/**
 * @file tools/seo-weight.ts
 * @description Page weight: the HTML plus its discovered subresources, measured over the network, with
 * load-time estimates for typical connection profiles.
 */

import { errMsg, fetchPage, mapLimit, rawRequest, type UaKey } from './seo-fetch';
import { HttpError } from './http';
import { absUrl, baseUrlOf, largestFromSrcset, parseHtml, relTokens, sameSite } from './seo-html';

export type ResType = 'html' | 'css' | 'js' | 'image' | 'font' | 'other';

export interface Resource {
  url: string;
  type: ResType;
  status: number | null;
  /** Bytes on the wire (compressed). */
  bytes: number;
  /** Size could only be partially measured (capped / unknown). */
  approximate?: boolean;
  encoding: string;
  cacheControl: string;
  contentType: string;
  thirdParty: boolean;
  renderBlocking: boolean;
  ms: number;
  method: 'GET' | 'HEAD';
  error?: string;
  initiator: string;
}

export const MAX_RESOURCES = 100;
const CONCURRENCY = 8;

/**
 * Network profiles. Bandwidth in kbit/s, RTT in ms. Same figures as the UI.
 */
export const PROFILES = [
  { id: '2g', label: '2G', kbps: 250, rttMs: 800 },
  { id: '3g', label: '3G', kbps: 1600, rttMs: 300 },
  { id: '4g', label: '4G / LTE', kbps: 9000, rttMs: 170 },
  { id: 'cable', label: 'Cable', kbps: 30000, rttMs: 40 },
  { id: 'fibre', label: 'Fibre / WiFi', kbps: 100000, rttMs: 20 },
];

/**
 * Deliberately simple load-time model (no TCP slow start, no HTTP/2 multiplexing gains, no CPU time):
 *
 *   connection setup = origins × setupRtts × RTT        (DNS + TCP [+ TLS] ≈ 3 RTT for https, 2 for http)
 *   request waves    = (1 + ceil(subrequests / 6)) × RTT (HTML, then resources ~6 parallel per wave)
 *   transfer         = bytes × 8 / bandwidth
 *
 *   full load    = setup(all origins) + waves(all requests) + transfer(all bytes)
 *   first render = setup(origins of HTML + render-blocking) + (1 + [blocking ? 1 : 0]) × RTT + transfer(HTML + blocking)
 */
export function estimateLoad(p: { kbps: number; rttMs: number }, m: {
  origins: number; https: boolean; requests: number; bytes: number;
  criticalOrigins: number; criticalBytes: number; hasBlocking: boolean;
}) {
  const setup = m.https ? 3 : 2;
  const bw = (p.kbps * 1000) / 8; // bytes per second
  const full = m.origins * setup * p.rttMs + (1 + Math.ceil(Math.max(0, m.requests - 1) / 6)) * p.rttMs + (m.bytes / bw) * 1000;
  const render = m.criticalOrigins * setup * p.rttMs + (1 + (m.hasBlocking ? 1 : 0)) * p.rttMs + (m.criticalBytes / bw) * 1000;
  return { fullMs: Math.round(full), renderMs: Math.round(render) };
}

function typeFromContentType(ct: string): ResType | null {
  if (/text\/css/i.test(ct)) return 'css';
  if (/javascript|ecmascript/i.test(ct)) return 'js';
  if (/^image\//i.test(ct)) return 'image';
  if (/font|woff|opentype|truetype/i.test(ct)) return 'font';
  if (/text\/html/i.test(ct)) return 'html';
  return null;
}

function typeFromUrl(u: string): ResType | null {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(new URL(u).pathname)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs') return 'js';
  if (/^(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(ext)) return 'image';
  if (/^(woff2?|ttf|otf|eot)$/.test(ext)) return 'font';
  return null;
}

/** First usable font URL per @font-face (prefers woff2, as browsers do), plus @import URLs. */
export function cssDependencies(css: string, base: string): { fonts: string[]; imports: string[] } {
  const fonts: string[] = [];
  const imports: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/@font-face\s*{([^}]*)}/gi)) {
    const srcs = [...m[1].matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*['"]?([\w-]+)['"]?\s*\))?/gi)]
      .map(x => ({ url: x[2], format: (x[3] || '').toLowerCase() }))
      .filter(x => !x.url.startsWith('data:'));
    const pickOne = srcs.find(s => s.format === 'woff2' || /\.woff2(\?|#|$)/i.test(s.url)) || srcs[0];
    const abs = pickOne && absUrl(pickOne.url, base);
    if (abs && !fonts.includes(abs)) fonts.push(abs);
  }
  for (const m of clean.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?/gi)) {
    const abs = absUrl(m[2], base);
    if (abs) imports.push(abs);
  }
  return { fonts, imports };
}

async function measure(url: string, type: ResType, ua: UaKey, pageHost: string, initiator: string, renderBlocking: boolean, needBody: boolean): Promise<Resource & { body?: string }> {
  const r: Resource & { body?: string } = {
    url, type, status: null, bytes: 0, encoding: '', cacheControl: '', contentType: '', thirdParty: !sameSite(new URL(url).hostname, pageHost),
    renderBlocking, ms: 0, method: 'HEAD', initiator,
  };
  const accept = type === 'css' ? 'text/css,*/*;q=0.1' : type === 'image' ? 'image/avif,image/webp,image/*,*/*;q=0.8' : '*/*';
  const fill = (res: Awaited<ReturnType<typeof rawRequest>>) => {
    r.status = res.status;
    r.encoding = String(res.headers['content-encoding'] || '');
    r.cacheControl = String(res.headers['cache-control'] || '');
    r.contentType = String(res.headers['content-type'] || '').split(';')[0];
    r.ms = res.totalMs;
    const t = typeFromContentType(r.contentType);
    if (t && r.type === 'other') r.type = t;
  };
  try {
    if (!needBody) {
      const head = await fetchPage(url, { method: 'HEAD', userAgent: ua, timeoutMs: 10_000, maxRedirects: 5, headers: { Accept: accept } }).catch(() => null);
      const len = head ? Number(head.headers['content-length']) : NaN;
      if (head && head.status >= 200 && head.status < 300 && Number.isFinite(len) && len > 0) {
        fill(head);
        r.bytes = len;
        return r;
      }
    }
    r.method = 'GET';
    const res = await fetchPage(url, { userAgent: ua, timeoutMs: 20_000, maxRedirects: 5, decode: needBody, headers: { Accept: accept } });
    fill(res);
    r.bytes = res.transferBytes;
    r.approximate = res.truncated || undefined;
    if (needBody && res.status < 400) r.body = res.text;
  } catch (e) {
    r.error = errMsg(e);
  }
  return r;
}

export async function pageWeight(url: URL, ua: UaKey = 'chrome-desktop') {
  const page = await fetchPage(url, { userAgent: ua });
  if (page.status >= 400) throw new HttpError(502, `Page returned HTTP ${page.status}`);
  const finalU = new URL(page.finalUrl);
  const { doc, close } = parseHtml(page.text, page.finalUrl);

  type Pending = { url: string; type: ResType; renderBlocking: boolean; initiator: string };
  const pending = new Map<string, Pending>();
  const iframes: string[] = [];
  let skipped = 0;
  const add = (u: string | null, type: ResType, initiator: string, renderBlocking = false) => {
    if (!u || !/^https?:/i.test(u)) return;
    const key = u.split('#')[0];
    const existing = pending.get(key);
    if (existing) { if (renderBlocking) existing.renderBlocking = true; return; }
    if (pending.size >= MAX_RESOURCES) { skipped++; return; }
    pending.set(key, { url: key, type: type === 'other' ? typeFromUrl(key) || 'other' : type, renderBlocking, initiator });
  };

  try {
    const base = baseUrlOf(doc, page.finalUrl);
    doc.querySelectorAll('link[rel][href]').forEach(l => {
      const rel = relTokens(l);
      const href = absUrl(l.getAttribute('href'), base);
      if (rel.includes('stylesheet')) {
        const blocking = !!l.closest('head') && !/^\s*print\s*$/i.test(l.getAttribute('media') || '') && !l.hasAttribute('disabled');
        add(href, 'css', '<link rel=stylesheet>', blocking);
      } else if (rel.includes('preload') || rel.includes('modulepreload')) {
        const as = (l.getAttribute('as') || '').toLowerCase();
        add(href, rel.includes('modulepreload') || as === 'script' ? 'js' : as === 'style' ? 'css' : as === 'font' ? 'font' : as === 'image' ? 'image' : 'other', `<link rel=${rel.join(' ')}>`);
      } else if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
        add(href, 'image', '<link rel=icon>');
      }
    });
    doc.querySelectorAll('script[src]').forEach(s => {
      const blocking = !!s.closest('head') && !s.hasAttribute('async') && !s.hasAttribute('defer') && (s.getAttribute('type') || '').toLowerCase() !== 'module';
      add(absUrl(s.getAttribute('src'), base), 'js', '<script>', blocking);
    });
    doc.querySelectorAll('img').forEach(img => {
      const u = largestFromSrcset(img.getAttribute('srcset'), base) || absUrl(img.getAttribute('src') || img.getAttribute('data-src'), base);
      add(u, 'image', img.hasAttribute('srcset') ? '<img srcset> (largest)' : '<img>');
    });
    doc.querySelectorAll('video[poster]').forEach(v => add(absUrl(v.getAttribute('poster'), base), 'image', '<video poster>'));
    doc.querySelectorAll('input[type="image" i][src]').forEach(v => add(absUrl(v.getAttribute('src'), base), 'image', '<input type=image>'));
    doc.querySelectorAll('iframe[src]').forEach(f => { const u = absUrl(f.getAttribute('src'), base); if (u && /^https?:/.test(u)) iframes.push(u); });
  } finally { close(); }

  // Stylesheets first (their bodies reveal fonts and @imports), then everything else.
  const list = [...pending.values()];
  const css = list.filter(p => p.type === 'css');
  const others = list.filter(p => p.type !== 'css');
  const results: Resource[] = [];
  const fontQueue: Pending[] = [];
  const cssResults = await mapLimit(css, CONCURRENCY, p => measure(p.url, 'css', ua, finalU.hostname, p.initiator, p.renderBlocking, true));
  const importQueue: Pending[] = [];
  for (const r of cssResults) {
    if (r.body && sameSite(new URL(r.url).hostname, finalU.hostname)) {
      const deps = cssDependencies(r.body, r.url);
      for (const f of deps.fonts) if (!pending.has(f) && pending.size + fontQueue.length < MAX_RESOURCES) fontQueue.push({ url: f, type: 'font', renderBlocking: false, initiator: '@font-face' });
      for (const i of deps.imports) if (!pending.has(i) && pending.size + importQueue.length < MAX_RESOURCES) importQueue.push({ url: i, type: 'css', renderBlocking: r.renderBlocking, initiator: '@import' });
    }
    delete r.body;
    results.push(r);
  }
  for (const i of importQueue) pending.set(i.url, i);
  const importResults = await mapLimit(importQueue, CONCURRENCY, p => measure(p.url, 'css', ua, finalU.hostname, p.initiator, p.renderBlocking, true));
  for (const r of importResults) {
    if (r.body) for (const f of cssDependencies(r.body, r.url).fonts) if (!pending.has(f) && pending.size + fontQueue.length < MAX_RESOURCES) fontQueue.push({ url: f, type: 'font', renderBlocking: false, initiator: '@font-face' });
    delete r.body;
    results.push(r);
  }
  const uniqFonts = [...new Map(fontQueue.map(f => [f.url, f])).values()];
  for (const f of uniqFonts) pending.set(f.url, f);
  const rest = await mapLimit([...others, ...uniqFonts], CONCURRENCY, p => measure(p.url, p.type, ua, finalU.hostname, p.initiator, p.renderBlocking, false));
  results.push(...rest);

  const html: Resource = {
    url: page.finalUrl, type: 'html', status: page.status, bytes: page.transferBytes, encoding: String(page.headers['content-encoding'] || ''),
    cacheControl: String(page.headers['cache-control'] || ''), contentType: page.contentType.split(';')[0], thirdParty: false, renderBlocking: true,
    ms: page.totalMs, method: 'GET', initiator: 'document', approximate: page.truncated || undefined,
  };
  const all = [html, ...results];
  const ok = all.filter(r => !r.error && (r.status ?? 0) < 400);
  const types: ResType[] = ['html', 'css', 'js', 'image', 'font', 'other'];
  const byType = types.map(t => {
    const l = ok.filter(r => r.type === t);
    return { type: t, count: l.length, bytes: l.reduce((a, r) => a + r.bytes, 0) };
  });
  const totalBytes = ok.reduce((a, r) => a + r.bytes, 0);
  const thirdParty = ok.filter(r => r.thirdParty);
  const tpHosts = new Map<string, { host: string; count: number; bytes: number }>();
  for (const r of thirdParty) {
    const h = new URL(r.url).hostname;
    const e = tpHosts.get(h) || { host: h, count: 0, bytes: 0 };
    e.count++; e.bytes += r.bytes;
    tpHosts.set(h, e);
  }
  const origins = new Set(ok.map(r => new URL(r.url).origin));
  const blocking = ok.filter(r => r.renderBlocking && r.type !== 'html');
  const criticalOrigins = new Set([finalU.origin, ...blocking.map(r => new URL(r.url).origin)]);
  const model = {
    origins: origins.size, https: finalU.protocol === 'https:', requests: ok.length, bytes: totalBytes,
    criticalOrigins: criticalOrigins.size, criticalBytes: html.bytes + blocking.reduce((a, r) => a + r.bytes, 0), hasBlocking: blocking.length > 0,
  };
  const estimates = PROFILES.map(p => ({ ...p, ...estimateLoad(p, model) }));

  // Suggestions
  const s: { severity: 'high' | 'medium' | 'low'; title: string; detail: string; savingsBytes?: number }[] = [];
  const bigImages = ok.filter(r => r.type === 'image' && r.bytes > 200 * 1024);
  if (bigImages.length) s.push({ severity: 'high', title: `Compress ${bigImages.length} large image(s)`, detail: `Images over 200 KB: ${bigImages.slice(0, 3).map(r => r.url.split('/').pop()?.slice(0, 40)).join(', ')}. Resize to display size and serve WebP/AVIF.`, savingsBytes: Math.round(bigImages.reduce((a, r) => a + r.bytes, 0) * 0.5) });
  const legacy = ok.filter(r => r.type === 'image' && /image\/(jpeg|png|gif)/.test(r.contentType) && r.bytes > 30 * 1024);
  if (legacy.length >= 3) s.push({ severity: 'medium', title: 'Serve images in modern formats', detail: `${legacy.length} JPEG/PNG/GIF images over 30 KB. WebP/AVIF are typically 25–50% smaller.`, savingsBytes: Math.round(legacy.reduce((a, r) => a + r.bytes, 0) * 0.3) });
  const uncompressed = ok.filter(r => (r.type === 'js' || r.type === 'css' || r.type === 'html' || /svg|json|xml|text/.test(r.contentType)) && !r.encoding && r.bytes > 2048);
  if (uncompressed.length) s.push({ severity: 'high', title: `Enable compression for ${uncompressed.length} text resource(s)`, detail: `gzip/Brotli typically shrink JS/CSS/HTML by 60–80%: ${uncompressed.slice(0, 3).map(r => r.url.split('/').pop()?.slice(0, 40)).join(', ')}.`, savingsBytes: Math.round(uncompressed.reduce((a, r) => a + r.bytes, 0) * 0.7) });
  const noCache = ok.filter(r => r.type !== 'html' && !r.thirdParty && (!r.cacheControl || /no-cache|no-store|max-age=(\d{1,4}|[1-7]\d{4})\b/.test(r.cacheControl)));
  if (noCache.length) s.push({ severity: 'medium', title: `Cache ${noCache.length} static asset(s) longer`, detail: 'Use fingerprinted file names with Cache-Control: public, max-age=31536000, immutable.' });
  if (blocking.length > 2) s.push({ severity: 'medium', title: `Reduce ${blocking.length} render-blocking resources`, detail: 'Add defer to scripts, inline critical CSS and load the rest asynchronously.' });
  const js = byType.find(t => t.type === 'js')!;
  if (js.bytes > 500 * 1024) s.push({ severity: 'high', title: 'Reduce JavaScript', detail: `${Math.round(js.bytes / 1024)} KB of JS (compressed). Code-split, tree-shake and drop unused libraries.` });
  const fonts = byType.find(t => t.type === 'font')!;
  if (fonts.count > 4) s.push({ severity: 'low', title: 'Limit web fonts', detail: `${fonts.count} font files. Subset fonts, use font-display: swap and fewer weights/families.` });
  if (ok.length > 80) s.push({ severity: 'medium', title: 'Reduce the number of requests', detail: `${ok.length} requests. Bundle small files, sprite icons or inline tiny assets.` });
  if (totalBytes > 3 * 1024 * 1024) s.push({ severity: 'high', title: 'Page is heavy', detail: `${(totalBytes / 1024 / 1024).toFixed(1)} MB total. The median mobile page is ~2 MB; aim for under 1.5 MB.` });
  const tpBytes = thirdParty.reduce((a, r) => a + r.bytes, 0);
  if (totalBytes && tpBytes / totalBytes > 0.4) s.push({ severity: 'medium', title: 'Heavy third-party content', detail: `${Math.round((tpBytes / totalBytes) * 100)}% of bytes come from other domains. Audit tags/widgets and load them lazily.` });
  if (origins.size > 8) s.push({ severity: 'low', title: 'Many origins', detail: `${origins.size} origins — each costs DNS+TCP+TLS. Self-host critical assets and add <link rel="preconnect"> for the rest.` });
  if (html.bytes > 100 * 1024) s.push({ severity: 'medium', title: 'Large HTML document', detail: `${Math.round(html.bytes / 1024)} KB of HTML (compressed). Remove inlined data and unused markup.` });

  return {
    url: url.href, finalUrl: page.finalUrl, status: page.status, ttfbMs: page.ttfbMs,
    totals: { bytes: totalBytes, requests: ok.length, failed: all.length - ok.length, origins: origins.size, skipped },
    byType, thirdParty: { count: thirdParty.length, bytes: tpBytes, share: totalBytes ? tpBytes / totalBytes : 0, hosts: [...tpHosts.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 15) },
    largest: [...ok].sort((a, b) => b.bytes - a.bytes).slice(0, 15),
    renderBlocking: blocking,
    resources: all,
    iframes: [...new Set(iframes)].slice(0, 50),
    model, estimates, suggestions: s,
  };
}
