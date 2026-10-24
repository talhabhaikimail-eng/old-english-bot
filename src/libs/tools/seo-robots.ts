/**
 * @file tools/seo-robots.ts
 * @description Pure robots.txt (RFC 9309 + Google's extensions) and robots-directive logic.
 *
 * Matching follows Google's documented behaviour:
 *  - The crawler obeys the single most specific user-agent group that matches its product token
 *    (groups that name the same agent are merged); otherwise the `*` group; otherwise everything is allowed.
 *  - Within the group the rule with the longest path pattern wins; on a tie `allow` wins.
 *  - `*` matches any sequence of characters and a trailing `$` anchors the end of the URL.
 *  - An empty `Disallow:` matches nothing. `/robots.txt` itself is always allowed.
 */

export interface RobotsRule { type: 'allow' | 'disallow'; path: string; line: number }
export interface RobotsGroup { agents: string[]; rules: RobotsRule[]; crawlDelay?: number; line: number }
export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  /** Lines that couldn't be understood. */
  invalid: { line: number; text: string }[];
}

export function parseRobots(text: string): ParsedRobots {
  // Google only reads the first 500 KiB.
  const body = text.length > 512_000 ? text.slice(0, 512_000) : text;
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const invalid: { line: number; text: string }[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  body.replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) { invalid.push({ line: lineNo, text: raw.slice(0, 200) }); return; }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent' || key === 'useragent' || key === 'user agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], line: lineNo };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      return; // sitemap lines don't end a user-agent block
    }
    lastWasAgent = false;
    if (key === 'allow' || key === 'disallow') {
      if (!current) { invalid.push({ line: lineNo, text: raw.slice(0, 200) + '  (rule outside any user-agent group)' }); return; }
      current.rules.push({ type: key, path: value, line: lineNo });
      return;
    }
    if (key === 'crawl-delay') {
      if (current && Number.isFinite(Number(value))) current.crawlDelay = Number(value);
      return;
    }
    if (key === 'host' || key === 'clean-param' || key === 'request-rate' || key === 'visit-time' || key === 'content-signal') return;
    invalid.push({ line: lineNo, text: raw.slice(0, 200) });
  });
  return { groups, sitemaps, invalid };
}

export interface GroupSelection {
  /** The user-agent value that was selected (`*` or a specific token), or null when no group applies. */
  agent: string | null;
  rules: RobotsRule[];
  crawlDelay?: number;
  groupLines: number[];
}

/** Pick the rules that apply to a crawler product token such as "googlebot" (or "*" for generic crawlers). */
export function selectGroup(parsed: ParsedRobots, crawler: string): GroupSelection {
  const token = crawler.toLowerCase();
  let best: string | null = null;
  if (token !== '*') {
    for (const g of parsed.groups) {
      for (const a of g.agents) {
        if (a !== '*' && a && token.startsWith(a) && (!best || a.length > best.length)) best = a;
      }
    }
  }
  if (!best && parsed.groups.some(g => g.agents.includes('*'))) best = '*';
  if (!best) return { agent: null, rules: [], groupLines: [] };
  const groups = parsed.groups.filter(g => g.agents.includes(best!));
  return {
    agent: best,
    rules: groups.flatMap(g => g.rules),
    crawlDelay: groups.find(g => g.crawlDelay !== undefined)?.crawlDelay,
    groupLines: groups.map(g => g.line),
  };
}

/** Percent-encode characters that browsers/crawlers would encode, leaving existing %XX escapes alone. */
function normalizeForMatch(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c > 0x7e || c < 0x21) out += encodeURIComponent(ch);
    else out += ch;
  }
  // Uppercase existing escapes so %2f and %2F compare equal.
  return out.replace(/%[0-9a-f]{2}/gi, m => m.toUpperCase());
}

const patternCache = new Map<string, RegExp>();
export function patternToRegExp(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (re) return re;
  const p = normalizeForMatch(pattern);
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p)
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  re = new RegExp('^' + body + (anchored ? '$' : ''));
  if (patternCache.size > 2000) patternCache.clear();
  patternCache.set(pattern, re);
  return re;
}

export interface MatchResult {
  allowed: boolean;
  /** The winning rule, if any matched. */
  rule?: RobotsRule;
}

/** Evaluate rules for a URL path (+ query). */
export function matchRules(rules: RobotsRule[], pathAndQuery: string): MatchResult {
  const target = normalizeForMatch(pathAndQuery || '/');
  if (target === '/robots.txt') return { allowed: true };
  let best: RobotsRule | undefined;
  let bestLen = -1;
  for (const r of rules) {
    if (!r.path) continue; // "Disallow:" with no value means nothing is disallowed
    if (!patternToRegExp(r.path).test(target)) continue;
    const len = r.path.length;
    if (len > bestLen || (len === bestLen && r.type === 'allow' && best?.type === 'disallow')) {
      best = r;
      bestLen = len;
    }
  }
  return { allowed: !best || best.type === 'allow', rule: best };
}

export function isAllowed(parsed: ParsedRobots, crawler: string, url: string): MatchResult & { agent: string | null } {
  const sel = selectGroup(parsed, crawler);
  let pq = '/';
  try { const u = new URL(url); pq = u.pathname + u.search; } catch { pq = url; }
  return { ...matchRules(sel.rules, pq), agent: sel.agent };
}

// ── robots meta / X-Robots-Tag directives ────────────────────────────────────

export interface Directives {
  noindex: boolean;
  nofollow: boolean;
  noarchive: boolean;
  nosnippet: boolean;
  noimageindex: boolean;
  unavailableAfter?: string;
  /** unavailable_after date has passed → treated as noindex. */
  expired?: boolean;
  maxSnippet?: number;
  maxImagePreview?: string;
  maxVideoPreview?: number;
  raw: string[];
}

export function emptyDirectives(): Directives {
  return { noindex: false, nofollow: false, noarchive: false, nosnippet: false, noimageindex: false, raw: [] };
}

/** Parse a robots meta content value or X-Robots-Tag value (without bot prefix) into directives. */
export function applyDirectives(d: Directives, value: string, now = Date.now()): Directives {
  // unavailable_after values contain commas/colons, so peel it off first.
  const ua = /unavailable_after\s*:\s*([^,]+(?:,\s*\d{1,2}[^,]*)?)/i.exec(value);
  let rest = value;
  if (ua) {
    d.unavailableAfter = ua[1].trim();
    const t = Date.parse(d.unavailableAfter);
    if (Number.isFinite(t) && t < now) { d.expired = true; d.noindex = true; }
    rest = value.replace(ua[0], '');
  }
  for (const part of rest.split(',')) {
    const tok = part.trim().toLowerCase();
    if (!tok) continue;
    d.raw.push(tok);
    const [k, v] = tok.split(/\s*:\s*/);
    switch (k) {
      case 'noindex': d.noindex = true; break;
      case 'nofollow': d.nofollow = true; break;
      case 'none': d.noindex = true; d.nofollow = true; break;
      case 'noarchive': case 'nocache': d.noarchive = true; break;
      case 'nosnippet': d.nosnippet = true; break;
      case 'noimageindex': d.noimageindex = true; break;
      case 'max-snippet': d.maxSnippet = Number(v); break;
      case 'max-image-preview': d.maxImagePreview = v; break;
      case 'max-video-preview': d.maxVideoPreview = Number(v); break;
    }
  }
  if (ua) d.raw.push(`unavailable_after: ${d.unavailableAfter}`);
  return d;
}

/**
 * Split X-Robots-Tag header values into { bot | null, value } entries.
 * "googlebot: noindex" targets googlebot; "noindex, nofollow" targets everyone.
 */
export function parseXRobotsTag(values: string[]): { bot: string | null; value: string }[] {
  const out: { bot: string | null; value: string }[] = [];
  const directiveNames = /^(noindex|nofollow|none|noarchive|nocache|nosnippet|noimageindex|notranslate|all|index|follow|max-snippet|max-image-preview|max-video-preview|unavailable_after|indexifembedded|noodp|noydir)$/i;
  for (const v of values) {
    for (const piece of v.split(/\n/)) {
      const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(piece);
      if (m && !directiveNames.test(m[1])) out.push({ bot: m[1].toLowerCase(), value: m[2] });
      else out.push({ bot: null, value: piece });
    }
  }
  return out;
}

// ── sitemaps ─────────────────────────────────────────────────────────────────

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function parseSitemapXml(xml: string): { kind: 'index' | 'urlset' | 'unknown'; locs: string[] } {
  const kind = /<(?:\w+:)?sitemapindex[\s>]/i.test(xml) ? 'index' : /<(?:\w+:)?urlset[\s>]/i.test(xml) ? 'urlset' : 'unknown';
  const locs: string[] = [];
  // Only top-level <loc> inside <url>/<sitemap>, not image:loc / video:loc.
  const re = /<(?:\w+:)?(url|sitemap)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(m[2]);
    if (loc) locs.push(decodeXmlEntities(loc[1].trim()));
  }
  if (!locs.length && kind === 'unknown') {
    // Plain-text sitemap: one URL per line.
    for (const l of xml.split(/\r?\n/)) if (/^https?:\/\/\S+$/.test(l.trim())) locs.push(l.trim());
  }
  return { kind, locs };
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface SitemapEntry { loc: string; lastmod?: string; changefreq?: string; priority?: string }

export const CHANGEFREQS = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'];

export function buildUrlset(entries: SitemapEntry[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const e of entries) {
    lines.push('  <url>');
    lines.push(`    <loc>${escapeXml(e.loc)}</loc>`);
    if (e.lastmod) lines.push(`    <lastmod>${escapeXml(e.lastmod)}</lastmod>`);
    if (e.changefreq) lines.push(`    <changefreq>${e.changefreq}</changefreq>`);
    if (e.priority) lines.push(`    <priority>${e.priority}</priority>`);
    lines.push('  </url>');
  }
  lines.push('</urlset>', '');
  return lines.join('\n');
}

export function buildSitemapIndex(locs: string[], lastmod?: string): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const l of locs) {
    lines.push('  <sitemap>', `    <loc>${escapeXml(l)}</loc>`);
    if (lastmod) lines.push(`    <lastmod>${lastmod}</lastmod>`);
    lines.push('  </sitemap>');
  }
  lines.push('</sitemapindex>', '');
  return lines.join('\n');
}

/**
 * Split entries into files of ≤ 50,000 URLs (and ≤ ~50 MB). One file → { 'sitemap.xml' }.
 * More → sitemap-1.xml… plus a sitemap.xml index pointing at `${baseUrl}/sitemap-N.xml`.
 */
export function buildSitemapFiles(entries: SitemapEntry[], baseUrl: string, perFile = 50_000): { name: string; xml: string }[] {
  if (entries.length <= perFile) return [{ name: 'sitemap.xml', xml: buildUrlset(entries) }];
  const files: { name: string; xml: string }[] = [];
  for (let i = 0; i < entries.length; i += perFile) {
    files.push({ name: `sitemap-${files.length + 1}.xml`, xml: buildUrlset(entries.slice(i, i + perFile)) });
  }
  const base = baseUrl.replace(/\/+$/, '');
  files.unshift({ name: 'sitemap.xml', xml: buildSitemapIndex(files.map(f => `${base}/${f.name}`), new Date().toISOString().slice(0, 10)) });
  return files;
}

/** Normalise a URL for crawl de-duplication: drop fragment, default port, lowercase host. */
export function normalizeUrl(raw: string, base?: string, { stripQuery = false } = {}): string | null {
  let u: URL;
  try { u = base ? new URL(raw, base) : new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  if (stripQuery) u.search = '';
  if (u.search === '?') u.search = '';
  if (!u.pathname) u.pathname = '/';
  return u.href;
}

/** Same URL ignoring scheme-insensitive bits, trailing slash and fragment — for "is it listed?" checks. */
export function looseUrlKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    let p = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.hostname.replace(/^www\./, '')}${p}${u.search}`;
  } catch { return raw; }
}
