/**
 * @file tools/seo-analyze.ts
 * @description On-page SEO audit: fetch a URL, extract every SEO-relevant fact and score a checklist.
 */

import { errMsg, fetchPage, headerList, rawRequest, type PageResult, type UaKey } from './seo-fetch';
import {
  absUrl, baseUrlOf, bodyText, collapse, countWords, jsonLdTypes, largestFromSrcset, parseHtml, relTokens, sameSite, type Doc,
} from './seo-html';
import { applyDirectives, emptyDirectives, parseXRobotsTag, type Directives } from './seo-robots';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';
export type Category = 'meta' | 'content' | 'links' | 'images' | 'technical' | 'social';

export interface Check {
  id: string;
  category: Category;
  label: string;
  status: CheckStatus;
  message: string;
  advice?: string;
  weight: number;
}

export const CATEGORY_LABELS: Record<Category, string> = {
  meta: 'Meta tags', content: 'Content', links: 'Links', images: 'Images', technical: 'Technical', social: 'Social',
};

// ── shared fact extraction (also used by indexability / canonical / backlinks) ──

export interface CanonicalTag { href: string; resolved: string | null; inHead: boolean }

export function canonicalTags(doc: Doc, pageUrl: string): CanonicalTag[] {
  const base = baseUrlOf(doc, pageUrl);
  return Array.from(doc.querySelectorAll('link[rel]'))
    .filter(l => relTokens(l).includes('canonical'))
    .map(l => ({ href: l.getAttribute('href') || '', resolved: absUrl(l.getAttribute('href'), base), inHead: !!l.closest('head') }));
}

/** Canonical from an HTTP `Link: <url>; rel="canonical"` header. */
export function linkHeaderCanonical(values: string[], pageUrl: string): string | null {
  for (const v of values) {
    for (const part of v.split(/,(?=\s*<)/)) {
      const m = /<([^>]*)>\s*;(.*)$/.exec(part.trim());
      if (m && /rel\s*=\s*"?([^";]*\s)?canonical(\s[^";]*)?"?/i.test(m[2])) return absUrl(m[1], pageUrl);
    }
  }
  return null;
}

export interface RobotsMeta { name: string; content: string }

export function robotsMetas(doc: Doc): RobotsMeta[] {
  return Array.from(doc.querySelectorAll('meta[name]'))
    .map(m => ({ name: (m.getAttribute('name') || '').toLowerCase().trim(), content: m.getAttribute('content') || '' }))
    .filter(m => m.name === 'robots' || /bot|slurp|crawler|spider/.test(m.name));
}

/** Effective directives for a crawler token ("googlebot", "bingbot" or "*"). */
export function effectiveDirectives(metas: RobotsMeta[], xRobots: string[], crawler: string): Directives {
  const d = emptyDirectives();
  const bot = crawler.toLowerCase();
  for (const m of metas) if (m.name === 'robots' || (bot !== '*' && m.name === bot)) applyDirectives(d, m.content);
  for (const x of parseXRobotsTag(xRobots)) if (x.bot === null || (bot !== '*' && x.bot === bot)) applyDirectives(d, x.value);
  return d;
}

/** Comparable form of a URL for "is this canonical self-referencing?" checks. */
export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    const x = new URL(a); const y = new URL(b);
    x.hash = ''; y.hash = '';
    return x.href === y.href;
  } catch { return a === b; }
}

// ── image dimension sniffing ─────────────────────────────────────────────────

export function imageSize(buf: Buffer): { width: number; height: number; format: string } | null {
  if (buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
    if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: 'webp' };
    }
    if (kind === 'VP8X' && buf.length >= 30) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1, format: 'webp' };
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: 'jpeg' };
      }
      i += 2 + len;
    }
    return null;
  }
  const ftyp = buf.toString('latin1', 4, 12);
  if (ftyp === 'ftypavif' || ftyp === 'ftypavis') {
    const at = buf.indexOf('ispe');
    if (at > 0 && at + 16 <= buf.length) return { width: buf.readUInt32BE(at + 8), height: buf.readUInt32BE(at + 12), format: 'avif' };
  }
  const head = buf.toString('utf8', 0, Math.min(buf.length, 2048));
  if (/<svg[\s>]/i.test(head)) {
    const w = /<svg[^>]*\swidth\s*=\s*["']?([\d.]+)/i.exec(head)?.[1];
    const h = /<svg[^>]*\sheight\s*=\s*["']?([\d.]+)/i.exec(head)?.[1];
    const vb = /viewBox\s*=\s*["']?\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
    return { width: Number(w || vb?.[1] || 0), height: Number(h || vb?.[2] || 0), format: 'svg' };
  }
  return null;
}

export interface ImageProbe {
  url: string;
  status?: number;
  contentType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  format?: string;
  error?: string;
}

/** Download the start of an image (≤ 1 MB) to learn its type, size and dimensions. */
export async function probeImage(url: string, ua: UaKey): Promise<ImageProbe> {
  try {
    const res = await fetchPage(url, { userAgent: ua, maxBytes: 1024 * 1024, timeoutMs: 10_000, maxRedirects: 5, headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } });
    const len = Number(res.headers['content-length']);
    const dims = imageSize(res.body);
    return {
      url: res.finalUrl, status: res.status, contentType: String(res.headers['content-type'] || ''),
      bytes: Number.isFinite(len) && len > 0 ? len : res.truncated ? undefined : res.transferBytes,
      width: dims?.width, height: dims?.height, format: dims?.format,
    };
  } catch (e) {
    return { url, error: errMsg(e) };
  }
}

// ── full analysis ────────────────────────────────────────────────────────────

const GENERIC_ANCHORS = new Set(['click here', 'here', 'read more', 'more', 'learn more', 'this', 'link', 'click', 'details', 'more info', 'continue', 'go', 'this page']);
const HREFLANG_RE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

function pick(h: PageResult['headers'], names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = h[n];
    if (v !== undefined) out[n] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

export async function analyzePage(url: string, ua: UaKey, { probeOgImage = true } = {}) {
  const page = await fetchPage(url, { userAgent: ua });
  return analyzeFetched(page, ua, { probeOgImage });
}

export async function analyzeFetched(page: PageResult, ua: UaKey, { probeOgImage = true } = {}) {
  const data = await extractFacts(page, ua, { probeOgImage });
  const checks = buildChecks(data);
  return { ...data, checks, ...scoreChecks(checks) };
}

async function extractFacts(page: PageResult, ua: UaKey, { probeOgImage = true } = {}) {
  const isHtml = /html|xml/i.test(page.contentType) || (!page.contentType && /<html|<head|<body/i.test(page.text.slice(0, 2000)));
  const { doc, close } = parseHtml(isHtml ? page.text : '', page.finalUrl);
  try {
    const base = baseUrlOf(doc, page.finalUrl);
    const finalU = new URL(page.finalUrl);
    const html = page.text;

    // ── head / meta ──
    const titles = Array.from(doc.querySelectorAll('title')).filter(t => !t.closest('svg'));
    const title = collapse(titles[0]?.textContent);
    const descs = Array.from(doc.querySelectorAll('meta[name]')).filter(m => (m.getAttribute('name') || '').toLowerCase() === 'description');
    const description = collapse(descs[0]?.getAttribute('content'));
    const metas = robotsMetas(doc);
    const xRobots = headerList(page.headers, 'x-robots-tag');
    const directives = effectiveDirectives(metas, xRobots, ua === 'bingbot' ? 'bingbot' : 'googlebot');

    const canon = canonicalTags(doc, page.finalUrl);
    const headerCanonical = linkHeaderCanonical(headerList(page.headers, 'link'), page.finalUrl);
    const canonicalResolved = canon[0]?.resolved || headerCanonical;

    const allMeta = Array.from(doc.querySelectorAll('meta')).map(m => {
      for (const attr of ['name', 'property', 'http-equiv', 'itemprop']) {
        const k = m.getAttribute(attr);
        if (k) return { attr, key: k, value: m.getAttribute('content') || '' };
      }
      if (m.hasAttribute('charset')) return { attr: 'charset', key: 'charset', value: m.getAttribute('charset') || '' };
      return null;
    }).filter(Boolean) as { attr: string; key: string; value: string }[];

    const og: Record<string, string> = {};
    const ogImages: string[] = [];
    const twitter: Record<string, string> = {};
    for (const m of allMeta) {
      const k = m.key.toLowerCase();
      if ((m.attr === 'property' || m.attr === 'name') && (k.startsWith('og:') || k.startsWith('article:') || k.startsWith('fb:'))) {
        if (k === 'og:image' || k === 'og:image:url' || k === 'og:image:secure_url') { const a = absUrl(m.value, base); if (a && !ogImages.includes(a)) ogImages.push(a); }
        if (!(k in og)) og[k] = m.value;
      }
      if ((m.attr === 'name' || m.attr === 'property') && k.startsWith('twitter:') && !(k in twitter)) twitter[k] = m.value;
    }

    const viewport = doc.querySelector('meta[name="viewport" i]')?.getAttribute('content') ?? null;
    const metaCharset = doc.querySelector('meta[charset]')?.getAttribute('charset')
      ?? /charset=([\w-]+)/i.exec(doc.querySelector('meta[http-equiv="content-type" i]')?.getAttribute('content') || '')?.[1] ?? null;
    const lang = doc.documentElement?.getAttribute('lang') || null;
    const metaRefresh = doc.querySelector('meta[http-equiv="refresh" i]')?.getAttribute('content') ?? null;
    const hasDoctype = !!doc.doctype;

    const favicons = Array.from(doc.querySelectorAll('link[rel]'))
      .filter(l => relTokens(l).some(r => r === 'icon' || r === 'apple-touch-icon' || r === 'mask-icon' || r === 'shortcut'))
      .map(l => ({ rel: relTokens(l).join(' '), href: absUrl(l.getAttribute('href'), base) || '', sizes: l.getAttribute('sizes') || '', type: l.getAttribute('type') || '' }));

    const hreflang = Array.from(doc.querySelectorAll('link[rel][hreflang]'))
      .filter(l => relTokens(l).includes('alternate'))
      .map(l => {
        const code = l.getAttribute('hreflang') || '';
        return { lang: code, href: absUrl(l.getAttribute('href'), base) || '', valid: HREFLANG_RE.test(code) };
      });

    // ── headings ──
    const outline = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({ level: Number(h.tagName[1]), text: collapse(h.textContent).slice(0, 200) }));
    const headingCounts = [1, 2, 3, 4, 5, 6].map(l => outline.filter(h => h.level === l).length);
    const skipped: string[] = [];
    let prev = 0;
    for (const h of outline) {
      if (prev && h.level > prev + 1) skipped.push(`H${prev} → H${h.level} ("${h.text.slice(0, 40)}")`);
      prev = h.level;
    }

    // ── content ──
    const text = bodyText(doc);
    const wordCount = countWords(text);
    const ratio = html.length ? Math.round((text.length / html.length) * 1000) / 10 : 0;

    // ── images ──
    const imgs = Array.from(doc.querySelectorAll('img'));
    const imageList = imgs.map(img => {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      return {
        src: absUrl(src, base) || src,
        srcsetLargest: largestFromSrcset(img.getAttribute('srcset'), base),
        alt: img.hasAttribute('alt') ? img.getAttribute('alt') : null,
        width: img.getAttribute('width'),
        height: img.getAttribute('height'),
        loading: img.getAttribute('loading'),
      };
    });
    const formats: Record<string, number> = {};
    for (const i of imageList) {
      const ext = /\.(avif|webp|png|jpe?g|gif|svg|ico|bmp)(?:[?#]|$)/i.exec(i.src)?.[1].toLowerCase().replace('jpeg', 'jpg') || (i.src.startsWith('data:') ? 'data-uri' : 'other');
      formats[ext] = (formats[ext] || 0) + 1;
    }
    const missingAlt = imageList.filter(i => i.alt === null).length;
    const missingDims = imageList.filter(i => !i.width || !i.height).length;
    const lazy = imageList.filter(i => i.loading === 'lazy').length;

    // ── links ──
    const anchors = Array.from(doc.querySelectorAll('a[href]'));
    const linkList: { href: string; text: string; rel: string[]; internal: boolean }[] = [];
    let empty = 0, generic = 0, nofollow = 0, sponsored = 0, ugc = 0, internalNofollow = 0;
    for (const a of anchors) {
      const raw = (a.getAttribute('href') || '').trim();
      if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|sms|data):/i.test(raw)) continue;
      const href = absUrl(raw, base);
      if (!href || !/^https?:/.test(href)) continue;
      const rel = relTokens(a);
      const internal = sameSite(new URL(href).hostname, finalU.hostname);
      const t = collapse(a.textContent) || collapse(a.querySelector('img[alt]')?.getAttribute('alt')) || collapse(a.getAttribute('aria-label')) || collapse(a.getAttribute('title'));
      if (!t) empty++;
      else if (GENERIC_ANCHORS.has(t.toLowerCase())) generic++;
      if (rel.includes('nofollow')) { nofollow++; if (internal) internalNofollow++; }
      if (rel.includes('sponsored')) sponsored++;
      if (rel.includes('ugc')) ugc++;
      linkList.push({ href, text: t.slice(0, 120), rel, internal });
    }
    const internalCount = linkList.filter(l => l.internal).length;

    // ── structured data ──
    const jsonLd = Array.from(doc.querySelectorAll('script[type="application/ld+json" i]')).map(s => {
      const raw = (s.textContent || '').trim();
      try {
        const data = JSON.parse(raw);
        return { types: [...jsonLdTypes(data)], error: null as string | null, snippet: raw.slice(0, 2000) };
      } catch (e) {
        return { types: [] as string[], error: errMsg(e), snippet: raw.slice(0, 2000) };
      }
    });
    const microdata = [...new Set(Array.from(doc.querySelectorAll('[itemtype]')).flatMap(e => (e.getAttribute('itemtype') || '').split(/\s+/).filter(Boolean).map(t => t.replace(/^https?:\/\/schema\.org\//i, ''))))];
    const rdfa = [...new Set(Array.from(doc.querySelectorAll('[typeof]')).map(e => e.getAttribute('typeof') || '').filter(Boolean))];
    const sdTypes = [...new Set([...jsonLd.flatMap(j => j.types), ...microdata, ...rdfa])];

    // ── resources ──
    const scripts = Array.from(doc.querySelectorAll('script'));
    const extScripts = scripts.filter(s => s.hasAttribute('src'));
    const stylesheets = Array.from(doc.querySelectorAll('link[rel]')).filter(l => relTokens(l).includes('stylesheet'));
    const renderBlocking = [
      ...Array.from(doc.querySelectorAll('head script[src]')).filter(s => !s.hasAttribute('async') && !s.hasAttribute('defer') && (s.getAttribute('type') || '').toLowerCase() !== 'module')
        .map(s => absUrl(s.getAttribute('src'), base) || ''),
      ...stylesheets.filter(l => l.closest('head') && !/^\s*print\s*$/i.test(l.getAttribute('media') || '') && !l.hasAttribute('disabled'))
        .map(l => absUrl(l.getAttribute('href'), base) || ''),
    ].filter(Boolean);

    const mixedContent: { tag: string; url: string }[] = [];
    if (finalU.protocol === 'https:') {
      const sel: [string, string][] = [['img', 'src'], ['script', 'src'], ['iframe', 'src'], ['source', 'src'], ['video', 'src'], ['audio', 'src'], ['embed', 'src'], ['object', 'data'], ['video', 'poster']];
      for (const [tag, attr] of sel) {
        doc.querySelectorAll(`${tag}[${attr}]`).forEach(el => {
          const u = absUrl(el.getAttribute(attr), base);
          if (u?.startsWith('http:')) mixedContent.push({ tag, url: u });
        });
      }
      stylesheets.forEach(l => { const u = absUrl(l.getAttribute('href'), base); if (u?.startsWith('http:')) mixedContent.push({ tag: 'link[stylesheet]', url: u }); });
      doc.querySelectorAll('img[srcset],source[srcset]').forEach(el => {
        for (const part of (el.getAttribute('srcset') || '').split(',')) {
          const u = absUrl(part.trim().split(/\s+/)[0], base);
          if (u?.startsWith('http:')) mixedContent.push({ tag: `${el.tagName.toLowerCase()}[srcset]`, url: u });
        }
      });
    }

    // ── favicon fallback / og:image probe ──
    let faviconFallback: { url: string; status: number | null; error?: string } | null = null;
    if (!favicons.length && isHtml) {
      const fav = new URL('/favicon.ico', page.finalUrl).href;
      try {
        const r = await rawRequest(fav, { method: 'GET', maxBytes: 256 * 1024, timeoutMs: 6000, userAgent: ua });
        faviconFallback = { url: fav, status: r.status };
      } catch (e) { faviconFallback = { url: fav, status: null, error: errMsg(e) }; }
    }
    const ogImageUrl = ogImages[0] || absUrl(twitter['twitter:image'] || twitter['twitter:image:src'], base);
    const ogImage = probeOgImage && ogImageUrl ? await probeImage(ogImageUrl, ua) : null;
    const twitterImageUrl = absUrl(twitter['twitter:image'] || twitter['twitter:image:src'], base);
    const twitterImage = probeOgImage && twitterImageUrl && twitterImageUrl !== ogImageUrl ? await probeImage(twitterImageUrl, ua) : null;

    const data = {
      url: page.requestedUrl,
      finalUrl: page.finalUrl,
      status: page.status,
      statusText: page.statusText,
      chain: page.chain,
      redirectError: page.redirectError,
      timing: { ttfbMs: page.ttfbMs, totalMs: page.totalMs, totalAllMs: page.totalMsAll },
      size: { transferBytes: page.transferBytes, htmlBytes: page.body.length, encoding: String(page.headers['content-encoding'] || ''), truncated: page.truncated },
      httpVersion: page.httpVersion,
      ip: page.remoteAddress,
      contentType: page.contentType,
      isHtml,
      headers: pick(page.headers, ['content-type', 'content-encoding', 'content-length', 'cache-control', 'expires', 'last-modified', 'etag', 'vary', 'server', 'x-powered-by', 'strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'x-robots-tag', 'link', 'age', 'via', 'cf-cache-status', 'x-cache']),
      charset: { value: page.charset, source: page.charsetSource, meta: metaCharset },
      title: { text: title, length: title.length, count: titles.length },
      description: { text: description, length: description.length, count: descs.length },
      robots: { meta: metas, xRobotsTag: xRobots, directives },
      canonical: {
        tags: canon,
        header: headerCanonical,
        resolved: canonicalResolved,
        selfReferential: canonicalResolved ? sameUrl(canonicalResolved, page.finalUrl) : null,
      },
      lang, viewport, metaRefresh, hasDoctype,
      favicons, faviconFallback,
      og, ogImages, twitter, ogImage, twitterImage,
      meta: allMeta.slice(0, 300),
      hreflang,
      headings: { outline: outline.slice(0, 400), counts: headingCounts, skipped },
      content: {
        wordCount, textLength: text.length, htmlLength: html.length, ratio,
        readingMinutes: Math.max(1, Math.round(wordCount / 230)),
        excerpt: text.slice(0, 600),
      },
      images: {
        total: imageList.length, missingAlt, emptyAlt: imageList.filter(i => i.alt === '').length, missingDimensions: missingDims, lazy,
        withSrcset: imageList.filter(i => i.srcsetLargest).length, formats, list: imageList.slice(0, 150),
      },
      links: {
        total: linkList.length, internal: internalCount, external: linkList.length - internalCount,
        nofollow, sponsored, ugc, internalNofollow, empty, generic, list: linkList.slice(0, 400),
      },
      structuredData: { jsonLd, microdata, rdfa, types: sdTypes },
      resources: {
        scripts: extScripts.length, inlineScripts: scripts.length - extScripts.length,
        stylesheets: stylesheets.length, inlineStyles: doc.querySelectorAll('style').length,
        iframes: doc.querySelectorAll('iframe').length, renderBlocking,
      },
      mixedContent: mixedContent.slice(0, 100),
    };
    return data;
  } finally {
    close();
  }
}

export type Analysis = Awaited<ReturnType<typeof analyzeFetched>>;

// ── checklist ────────────────────────────────────────────────────────────────

type AnalysisData = Awaited<ReturnType<typeof extractFacts>>;

export function buildChecks(d: AnalysisData): Check[] {
  const c: Check[] = [];
  const add = (id: string, category: Category, label: string, status: CheckStatus, message: string, weight: number, advice?: string) =>
    c.push({ id, category, label, status, message, weight: status === 'info' ? 0 : weight, advice: status === 'pass' ? undefined : advice });

  // meta
  const tl = d.title.length;
  if (!d.title.text) add('title', 'meta', 'Title tag', 'fail', 'No <title> found.', 10, 'Add a unique, descriptive <title> of 30–60 characters with the main keyword near the start.');
  else add('title', 'meta', 'Title tag', 'pass', `"${d.title.text.slice(0, 80)}"`, 10);
  if (d.title.text) {
    if (tl < 30) add('title-length', 'meta', 'Title length', 'warn', `${tl} characters — short.`, 5, 'Aim for 30–60 characters so the title is descriptive but not truncated in search results.');
    else if (tl > 60) add('title-length', 'meta', 'Title length', 'warn', `${tl} characters — likely truncated in Google (≈600 px).`, 5, 'Shorten the title to about 60 characters; put the most important words first.');
    else add('title-length', 'meta', 'Title length', 'pass', `${tl} characters.`, 5);
  }
  if (d.title.count > 1) add('title-multiple', 'meta', 'Single title', 'warn', `${d.title.count} <title> elements.`, 2, 'Keep exactly one <title> in <head>.');

  const dl = d.description.length;
  if (!d.description.text) add('description', 'meta', 'Meta description', 'fail', 'No meta description.', 8, 'Add <meta name="description"> (70–160 chars) summarising the page — Google often uses it as the snippet.');
  else if (dl < 70) add('description', 'meta', 'Meta description', 'warn', `${dl} characters — short.`, 8, 'Expand the description to 70–160 characters with a clear benefit and call to action.');
  else if (dl > 160) add('description', 'meta', 'Meta description', 'warn', `${dl} characters — will be truncated (≈920 px).`, 8, 'Trim the description to ~155 characters.');
  else add('description', 'meta', 'Meta description', 'pass', `${dl} characters.`, 8);
  if (d.description.count > 1) add('description-multiple', 'meta', 'Single description', 'warn', `${d.description.count} meta descriptions.`, 2, 'Remove duplicate description tags; search engines may pick either.');

  if (d.robots.directives.noindex) add('noindex', 'meta', 'Indexable', 'fail', `Page is marked noindex (${d.robots.directives.raw.join(', ')}).`, 10, 'Remove noindex from the robots meta tag / X-Robots-Tag header if this page should appear in search.');
  else add('noindex', 'meta', 'Indexable', 'pass', 'No noindex directive.', 10);
  if (d.robots.directives.nofollow) add('nofollow', 'meta', 'Links followed', 'warn', 'Page-level nofollow: crawlers won\'t follow any link on this page.', 3, 'Remove "nofollow" from the robots meta unless intentional.');

  const tags = d.canonical.tags;
  if (tags.length > 1) add('canonical', 'meta', 'Canonical URL', 'fail', `${tags.length} canonical tags — search engines may ignore all of them.`, 6, 'Keep a single <link rel="canonical"> in <head>.');
  else if (!d.canonical.resolved) add('canonical', 'meta', 'Canonical URL', 'warn', 'No canonical URL declared.', 6, 'Add a self-referencing <link rel="canonical" href="…"> to consolidate duplicate URLs (tracking params, http/https, www).');
  else if (d.canonical.selfReferential) add('canonical', 'meta', 'Canonical URL', 'pass', 'Self-referencing canonical.', 6);
  else add('canonical', 'meta', 'Canonical URL', 'warn', `Canonical points to another URL: ${d.canonical.resolved}`, 6, 'If this page should rank itself, make the canonical self-referencing. Otherwise this is expected for duplicates.');
  if (tags.length && tags.some(t => !t.inHead)) add('canonical-body', 'meta', 'Canonical in <head>', 'warn', 'A canonical tag is outside <head> and will be ignored.', 2, 'Move the canonical link into <head>.');

  if (!d.lang) add('lang', 'meta', 'Language attribute', 'warn', '<html> has no lang attribute.', 3, 'Add lang="en" (or the right language) to <html> for accessibility and language targeting.');
  else add('lang', 'meta', 'Language attribute', 'pass', `lang="${d.lang}"`, 3);

  // content
  const h1 = d.headings.counts[0];
  if (h1 === 0) add('h1', 'content', 'H1 heading', 'fail', 'No <h1> on the page.', 6, 'Add one <h1> describing the page topic (usually similar to the title).');
  else if (h1 > 1) add('h1', 'content', 'H1 heading', 'warn', `${h1} <h1> elements.`, 6, 'Use a single <h1> and structure sub-sections with <h2>–<h3>.');
  else add('h1', 'content', 'H1 heading', 'pass', `"${d.headings.outline.find(h => h.level === 1)?.text.slice(0, 80) || ''}"`, 6);
  if (d.headings.skipped.length) add('heading-order', 'content', 'Heading hierarchy', 'warn', `Skipped levels: ${d.headings.skipped.slice(0, 3).join('; ')}${d.headings.skipped.length > 3 ? '…' : ''}`, 2, 'Don\'t skip heading levels (e.g. H2 → H4); nest headings in order.');
  else if (d.headings.outline.length) add('heading-order', 'content', 'Heading hierarchy', 'pass', `${d.headings.outline.length} headings in a logical order.`, 2);
  const wc = d.content.wordCount;
  if (wc < 100) add('word-count', 'content', 'Content length', 'fail', `${wc} words — thin content.`, 6, 'Pages with very little text rarely rank. Add useful, original content (300+ words for most pages).');
  else if (wc < 300) add('word-count', 'content', 'Content length', 'warn', `${wc} words.`, 6, 'Consider expanding the content to 300+ words if the topic warrants it.');
  else add('word-count', 'content', 'Content length', 'pass', `${wc} words (~${d.content.readingMinutes} min read).`, 6);
  if (d.content.ratio < 10) add('text-ratio', 'content', 'Text to HTML ratio', 'warn', `${d.content.ratio}% — markup-heavy page.`, 2, 'Reduce inline scripts/styles and boilerplate markup, or add more text content.');
  else add('text-ratio', 'content', 'Text to HTML ratio', 'pass', `${d.content.ratio}%`, 2);
  if (d.title.text && h1 === 1) {
    const h1Text = d.headings.outline.find(h => h.level === 1)?.text || '';
    if (h1Text && h1Text.toLowerCase() === d.title.text.toLowerCase()) add('title-h1', 'content', 'Title vs H1', 'info', 'Title and H1 are identical — fine, but you can use the H1 to target a variation.', 0);
  }

  // links
  if (d.links.internal === 0) add('internal-links', 'links', 'Internal links', 'warn', 'No internal links found.', 4, 'Link to related pages on your site to help crawling and distribute link equity.');
  else add('internal-links', 'links', 'Internal links', 'pass', `${d.links.internal} internal, ${d.links.external} external.`, 4);
  if (d.links.empty) add('empty-anchors', 'links', 'Anchor text', 'warn', `${d.links.empty} link(s) without anchor text, image alt or aria-label.`, 3, 'Give every link descriptive text (or alt text on a linked image / aria-label).');
  else if (d.links.total) add('empty-anchors', 'links', 'Anchor text', 'pass', 'All links have accessible text.', 3);
  if (d.links.generic) add('generic-anchors', 'links', 'Descriptive anchors', 'warn', `${d.links.generic} link(s) use generic text like "click here".`, 1, 'Use descriptive anchor text that tells users and crawlers what the target is about.');
  if (d.links.internalNofollow) add('internal-nofollow', 'links', 'Internal nofollow', 'warn', `${d.links.internalNofollow} internal link(s) are rel="nofollow".`, 2, 'Avoid nofollow on internal links — it wastes internal link equity.');
  if (d.links.total > 300) add('too-many-links', 'links', 'Link count', 'warn', `${d.links.total} links on one page.`, 1, 'Very large numbers of links dilute their value; prune navigation/footers where possible.');

  // images
  const ti = d.images.total;
  if (!ti) add('img-alt', 'images', 'Image alt text', 'info', 'No <img> elements.', 0);
  else if (!d.images.missingAlt) add('img-alt', 'images', 'Image alt text', 'pass', `All ${ti} images have an alt attribute.`, 5);
  else add('img-alt', 'images', 'Image alt text', d.images.missingAlt / ti > 0.2 ? 'fail' : 'warn', `${d.images.missingAlt} of ${ti} images have no alt attribute.`, 5, 'Add alt text describing each meaningful image (alt="" for purely decorative ones).');
  if (ti) {
    if (d.images.missingDimensions) add('img-dims', 'images', 'Image dimensions', 'warn', `${d.images.missingDimensions} of ${ti} images lack width/height attributes.`, 3, 'Set width and height on <img> to reserve space and avoid layout shift (CLS).');
    else add('img-dims', 'images', 'Image dimensions', 'pass', 'All images declare width and height.', 3);
    if (ti > 5 && !d.images.lazy) add('img-lazy', 'images', 'Lazy loading', 'warn', `${ti} images and none use loading="lazy".`, 2, 'Add loading="lazy" to below-the-fold images to speed up initial load.');
    else if (ti > 5) add('img-lazy', 'images', 'Lazy loading', 'pass', `${d.images.lazy} lazy-loaded image(s).`, 2);
    const modern = (d.images.formats.webp || 0) + (d.images.formats.avif || 0) + (d.images.formats.svg || 0);
    const raster = (d.images.formats.jpg || 0) + (d.images.formats.png || 0) + (d.images.formats.gif || 0);
    if (raster > 3 && !modern) add('img-format', 'images', 'Modern formats', 'warn', `${raster} JPEG/PNG/GIF images, no WebP/AVIF.`, 1, 'Serve WebP or AVIF (e.g. via <picture>) for 25–50% smaller images.');
  }

  // technical
  const https = d.finalUrl.startsWith('https:');
  add('https', 'technical', 'HTTPS', https ? 'pass' : 'fail', https ? 'Served over HTTPS.' : 'Served over plain HTTP.', 8, 'Serve the site over HTTPS and redirect HTTP to HTTPS.');
  if (d.status >= 200 && d.status < 300) add('status', 'technical', 'HTTP status', 'pass', `${d.status} ${d.statusText}`, 10);
  else add('status', 'technical', 'HTTP status', 'fail', `${d.status} ${d.statusText}${d.redirectError ? ` — ${d.redirectError}` : ''}`, 10, 'The final URL must return 200 to be indexed.');
  const hops = d.chain.length - 1;
  if (hops >= 2) add('redirects', 'technical', 'Redirects', 'warn', `${hops} redirects before the final URL.`, 3, 'Link directly to the final URL and collapse redirect chains into a single 301.');
  else if (hops === 1) add('redirects', 'technical', 'Redirects', 'pass', `1 redirect (${d.chain[0].status}) → ${d.finalUrl}`, 3);
  else add('redirects', 'technical', 'Redirects', 'pass', 'No redirects.', 3);
  const ttfb = d.timing.ttfbMs;
  add('ttfb', 'technical', 'Server response (TTFB)', ttfb < 800 ? 'pass' : ttfb < 1800 ? 'warn' : 'fail', `${ttfb} ms (from this server).`, 4, 'Speed up the backend: caching, a CDN, fewer DB queries. Google recommends TTFB under 0.8 s.');
  const tb = d.size.transferBytes;
  add('html-size', 'technical', 'HTML size', tb < 100_000 ? 'pass' : tb < 500_000 ? 'warn' : 'fail', `${Math.round(tb / 1024)} KB transferred, ${Math.round(d.size.htmlBytes / 1024)} KB uncompressed.`, 3, 'Reduce HTML size: remove inline data blobs, large inline SVG/CSS/JS and unused markup.');
  if (d.size.htmlBytes > 1024) {
    add('compression', 'technical', 'Compression', d.size.encoding ? 'pass' : 'warn', d.size.encoding ? `${d.size.encoding} enabled.` : 'HTML is not compressed.', 3, 'Enable gzip or Brotli on the web server / CDN.');
  }
  if (!d.viewport) add('viewport', 'technical', 'Mobile viewport', 'fail', 'No viewport meta tag — page won\'t render properly on mobile.', 6, 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  else add('viewport', 'technical', 'Mobile viewport', /width\s*=\s*device-width/i.test(d.viewport) ? 'pass' : 'warn', d.viewport, 6, 'Use width=device-width in the viewport meta.');
  if (!d.charset.meta && d.charset.source !== 'header') add('charset', 'technical', 'Character encoding', 'warn', 'No charset declared in headers or <meta charset>.', 2, 'Add <meta charset="utf-8"> as the first element in <head>.');
  else add('charset', 'technical', 'Character encoding', 'pass', `${d.charset.value} (${d.charset.source === 'header' ? 'HTTP header' : d.charset.source === 'meta' ? 'meta tag' : d.charset.source})`, 2);
  if (!d.hasDoctype) add('doctype', 'technical', 'Doctype', 'warn', 'No <!DOCTYPE html> — page renders in quirks mode.', 1, 'Start the document with <!DOCTYPE html>.');
  if (d.mixedContent.length) add('mixed', 'technical', 'Mixed content', 'fail', `${d.mixedContent.length} resource(s) loaded over http:// on an https page.`, 5, 'Change those URLs to https:// — browsers block or warn about mixed content.');
  else if (https) add('mixed', 'technical', 'Mixed content', 'pass', 'No insecure subresources.', 5);
  const jsonErr = d.structuredData.jsonLd.filter(j => j.error).length;
  if (jsonErr) add('jsonld-errors', 'technical', 'Structured data syntax', 'fail', `${jsonErr} JSON-LD block(s) failed to parse.`, 4, 'Fix the JSON syntax (validate with Google\'s Rich Results Test).');
  if (d.structuredData.types.length) add('structured-data', 'technical', 'Structured data', 'pass', d.structuredData.types.slice(0, 8).join(', '), 3);
  else add('structured-data', 'technical', 'Structured data', 'warn', 'No JSON-LD, microdata or RDFa found.', 3, 'Add schema.org JSON-LD (Organization, WebSite, Article, Product, BreadcrumbList…) to qualify for rich results.');
  const rb = d.resources.renderBlocking.length;
  if (rb > 3) add('render-blocking', 'technical', 'Render-blocking resources', 'warn', `${rb} render-blocking scripts/stylesheets in <head>.`, 2, 'Add defer/async to scripts and inline critical CSS; load the rest asynchronously.');
  else add('render-blocking', 'technical', 'Render-blocking resources', 'pass', `${rb} render-blocking resource(s).`, 2);
  const favOk = d.favicons.length > 0 || (d.faviconFallback?.status ?? 0) === 200;
  add('favicon', 'technical', 'Favicon', favOk ? 'pass' : 'warn', d.favicons.length ? `${d.favicons.length} icon link(s).` : favOk ? '/favicon.ico exists (no <link rel="icon">).' : 'No favicon found.', 1, 'Add <link rel="icon" href="/favicon.svg"> (Google shows favicons in mobile results).');
  if (d.metaRefresh) add('meta-refresh', 'technical', 'Meta refresh', 'warn', `meta refresh: "${d.metaRefresh}"`, 2, 'Use a server-side 301 redirect instead of meta refresh.');
  if (d.hreflang.length) {
    const bad = d.hreflang.filter(h => !h.valid);
    const self = d.hreflang.some(h => sameUrl(h.href, d.finalUrl) || sameUrl(h.href, d.canonical.resolved));
    if (bad.length) add('hreflang', 'technical', 'hreflang', 'warn', `Invalid codes: ${bad.map(b => b.lang).join(', ')}`, 2, 'Use ISO 639-1 language (+ optional ISO 3166-1 region) codes, e.g. en, en-GB, x-default.');
    else if (!self) add('hreflang', 'technical', 'hreflang', 'warn', `${d.hreflang.length} alternates, but none points back to this URL.`, 2, 'Each hreflang set must include a self-referencing entry.');
    else add('hreflang', 'technical', 'hreflang', 'pass', `${d.hreflang.length} valid alternates.`, 2);
  }

  // social
  const has = (k: string) => !!(d.og[k] || '').trim();
  add('og-title', 'social', 'og:title', has('og:title') ? 'pass' : 'warn', has('og:title') ? d.og['og:title'].slice(0, 90) : 'Missing — platforms fall back to <title>.', 3, 'Add <meta property="og:title" content="…">.');
  add('og-description', 'social', 'og:description', has('og:description') ? 'pass' : 'warn', has('og:description') ? d.og['og:description'].slice(0, 120) : 'Missing.', 2, 'Add <meta property="og:description" content="…">.');
  if (!d.ogImages.length) add('og-image', 'social', 'og:image', 'warn', 'Missing — shared links will have no preview image.', 4, 'Add a 1200×630 px og:image (absolute URL, < 5 MB, JPG/PNG/WebP).');
  else if (d.ogImage?.error || (d.ogImage?.status && d.ogImage.status >= 400)) add('og-image', 'social', 'og:image', 'fail', `Image can't be loaded: ${d.ogImage?.error || `HTTP ${d.ogImage?.status}`}`, 4, 'Make sure the og:image URL is public and returns 200.');
  else {
    const w = d.ogImage?.width, h = d.ogImage?.height;
    if (w && h && (w < 600 || h < 315)) add('og-image', 'social', 'og:image', 'warn', `${w}×${h} px — too small for large previews.`, 4, 'Use at least 1200×630 px for large link previews.');
    else if (d.ogImage?.bytes && d.ogImage.bytes > 5 * 1024 * 1024) add('og-image', 'social', 'og:image', 'warn', `${Math.round(d.ogImage.bytes / 1024)} KB — over most platforms' limits.`, 4, 'Keep og:image under 5 MB (ideally < 300 KB).');
    else add('og-image', 'social', 'og:image', 'pass', w && h ? `${w}×${h} px` : d.ogImages[0], 4);
  }
  add('og-url', 'social', 'og:url', has('og:url') ? 'pass' : 'warn', has('og:url') ? d.og['og:url'] : 'Missing.', 1, 'Add og:url with the canonical URL.');
  add('og-type', 'social', 'og:type', has('og:type') ? 'pass' : 'warn', has('og:type') ? d.og['og:type'] : 'Missing (defaults to "website").', 1, 'Add og:type (website, article, product…).');
  add('twitter-card', 'social', 'twitter:card', d.twitter['twitter:card'] ? 'pass' : 'warn', d.twitter['twitter:card'] || 'Missing — X shows a small or no card.', 2, 'Add <meta name="twitter:card" content="summary_large_image">.');
  return c;
}

export function scoreChecks(checks: Check[]) {
  const factor = (s: CheckStatus) => (s === 'pass' ? 1 : s === 'warn' ? 0.5 : 0);
  const sum = (list: Check[]) => {
    const w = list.reduce((a, x) => a + x.weight, 0);
    return w ? Math.round((list.reduce((a, x) => a + x.weight * factor(x.status), 0) / w) * 100) : 100;
  };
  const categories = (Object.keys(CATEGORY_LABELS) as Category[]).map(id => {
    const list = checks.filter(x => x.category === id && x.status !== 'info');
    return {
      id, label: CATEGORY_LABELS[id], score: sum(list),
      pass: list.filter(x => x.status === 'pass').length,
      warn: list.filter(x => x.status === 'warn').length,
      fail: list.filter(x => x.status === 'fail').length,
    };
  });
  return { score: sum(checks.filter(x => x.status !== 'info')), categories };
}
