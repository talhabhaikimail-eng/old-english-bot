/**
 * @file tools/seo-checks.ts
 * @description Indexability (robots.txt + robots directives + status + canonical + sitemaps) and canonical audits.
 */

import { gunzipSync } from 'zlib';
import { canonicalTags, effectiveDirectives, linkHeaderCanonical, robotsMetas, sameUrl } from './seo-analyze';
import { errMsg, fetchPage, headerList, mapLimit, type PageResult, type UaKey } from './seo-fetch';
import { parseHtml, sameSite } from './seo-html';
import {
  isAllowed, looseUrlKey, normalizeUrl, parseRobots, parseSitemapXml, selectGroup, type ParsedRobots, type RobotsRule,
} from './seo-robots';

export type Status = 'pass' | 'warn' | 'fail' | 'info';
export interface Item { id: string; label: string; status: Status; message: string; detail?: string }

// ── robots.txt ───────────────────────────────────────────────────────────────

export interface RobotsInfo {
  url: string;
  status: number | null;
  error?: string;
  /** How the response is interpreted, per Google's documentation. */
  mode: 'parsed' | 'allow-all' | 'disallow-all';
  note: string;
  text: string;
  parsed: ParsedRobots;
  bytes: number;
}

export async function fetchRobots(origin: string, ua: UaKey, signal?: AbortSignal): Promise<RobotsInfo> {
  const url = origin.replace(/\/+$/, '') + '/robots.txt';
  const empty: ParsedRobots = { groups: [], sitemaps: [], invalid: [] };
  try {
    const r = await fetchPage(url, { userAgent: ua, maxRedirects: 5, timeoutMs: 15_000, maxBytes: 1024 * 1024, signal, headers: { Accept: 'text/plain,*/*' } });
    if (r.status >= 200 && r.status < 300) {
      const text = r.text;
      const isHtml = /<html|<!doctype html/i.test(text.slice(0, 500));
      return {
        url, status: r.status, mode: 'parsed', text: text.slice(0, 100_000), parsed: isHtml ? empty : parseRobots(text), bytes: r.body.length,
        note: isHtml ? 'robots.txt returned an HTML page — treated as having no rules.' : `Fetched ${r.finalUrl !== url ? `(via redirect to ${r.finalUrl}) ` : ''}and parsed.`,
      };
    }
    if (r.status === 429 || r.status >= 500) {
      return { url, status: r.status, mode: 'disallow-all', text: '', parsed: empty, bytes: 0, note: `HTTP ${r.status}: Google treats a server error on robots.txt as "disallow everything" until it can fetch it again.` };
    }
    if (r.status >= 400) return { url, status: r.status, mode: 'allow-all', text: '', parsed: empty, bytes: 0, note: `HTTP ${r.status}: no robots.txt — everything may be crawled.` };
    return { url, status: r.status, mode: 'allow-all', text: '', parsed: empty, bytes: 0, note: `HTTP ${r.status}${r.redirectError ? ` (${r.redirectError})` : ''}: treated as no robots.txt.` };
  } catch (e) {
    return { url, status: null, error: errMsg(e), mode: 'disallow-all', text: '', parsed: empty, bytes: 0, note: 'robots.txt is unreachable — Google stops crawling the site until it can fetch it.' };
  }
}

export function robotsVerdict(info: RobotsInfo, crawler: string, url: string): { allowed: boolean; agent: string | null; rule?: RobotsRule; reason: string } {
  if (info.mode === 'allow-all') return { allowed: true, agent: null, reason: info.note };
  if (info.mode === 'disallow-all') return { allowed: false, agent: null, reason: info.note };
  const r = isAllowed(info.parsed, crawler, url);
  const who = r.agent ? `user-agent: ${r.agent}` : 'no matching group';
  if (!r.rule) return { ...r, reason: `No rule matches (${who}) — allowed.` };
  return { ...r, reason: `${r.rule.type === 'allow' ? 'Allowed' : 'Blocked'} by "${r.rule.type === 'allow' ? 'Allow' : 'Disallow'}: ${r.rule.path}" (line ${r.rule.line}, ${who}).` };
}

// ── sitemaps ─────────────────────────────────────────────────────────────────

export interface SitemapInfo {
  url: string;
  source: 'robots' | 'default' | 'index';
  status: number | null;
  kind?: 'index' | 'urlset' | 'unknown';
  urlCount: number;
  error?: string;
  containsTarget?: 'exact' | 'variant';
  parent?: string;
}

async function fetchSitemap(url: string, ua: UaKey): Promise<{ status: number; locs: string[]; kind: 'index' | 'urlset' | 'unknown'; error?: string }> {
  const r = await fetchPage(url, { userAgent: ua, maxRedirects: 5, maxBytes: 10 * 1024 * 1024, timeoutMs: 20_000, headers: { Accept: 'application/xml,text/xml,*/*' } });
  if (r.status !== 200) return { status: r.status, locs: [], kind: 'unknown', error: `HTTP ${r.status}` };
  let body = r.body;
  if (body[0] === 0x1f && body[1] === 0x8b) {
    try { body = gunzipSync(body, { maxOutputLength: 50 * 1024 * 1024 }); } catch (e) { return { status: r.status, locs: [], kind: 'unknown', error: `Bad gzip: ${errMsg(e)}` }; }
  }
  const text = body.toString('utf-8');
  const parsed = parseSitemapXml(text);
  if (parsed.kind === 'unknown' && !parsed.locs.length) {
    return { status: r.status, locs: [], kind: 'unknown', error: /<html/i.test(text.slice(0, 1000)) ? 'Not a sitemap (HTML page returned)' : 'Not a sitemap' };
  }
  return { status: r.status, ...parsed };
}

export async function discoverSitemaps(origin: string, robotsSitemaps: string[], targets: string[], ua: UaKey, maxChildren = 20) {
  const seen = new Set<string>();
  const list: SitemapInfo[] = [];
  const exact = new Set(targets.map(t => normalizeUrl(t) || t));
  const loose = new Set(targets.map(looseUrlKey));
  const candidates: { url: string; source: SitemapInfo['source'] }[] = [];
  for (const s of robotsSitemaps.slice(0, 10)) candidates.push({ url: s, source: 'robots' });
  for (const p of ['/sitemap.xml', '/sitemap_index.xml']) candidates.push({ url: origin + p, source: 'default' });
  let children = 0;
  let listed: { sitemap: string; match: 'exact' | 'variant' } | null = null;

  const check = (info: SitemapInfo, locs: string[]) => {
    if (info.kind !== 'urlset' && info.kind !== 'unknown') return;
    if (locs.some(l => exact.has(normalizeUrl(l) || l))) info.containsTarget = 'exact';
    else if (locs.some(l => loose.has(looseUrlKey(l)))) info.containsTarget = 'variant';
    if (info.containsTarget && (!listed || (listed.match === 'variant' && info.containsTarget === 'exact'))) listed = { sitemap: info.url, match: info.containsTarget };
  };

  for (const c of candidates) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    const info: SitemapInfo = { url: c.url, source: c.source, status: null, urlCount: 0 };
    list.push(info);
    try {
      const r = await fetchSitemap(c.url, ua);
      Object.assign(info, { status: r.status, kind: r.kind, urlCount: r.locs.length, error: r.error });
      check(info, r.locs);
      if (r.kind === 'index') {
        const kids = r.locs.filter(l => !seen.has(l)).slice(0, Math.max(0, maxChildren - children));
        children += kids.length;
        await mapLimit(kids, 4, async kid => {
          seen.add(kid);
          const ci: SitemapInfo = { url: kid, source: 'index', parent: c.url, status: null, urlCount: 0 };
          list.push(ci);
          try {
            const cr = await fetchSitemap(kid, ua);
            Object.assign(ci, { status: cr.status, kind: cr.kind, urlCount: cr.locs.length, error: cr.error });
            check(ci, cr.locs);
          } catch (e) { ci.error = errMsg(e); }
        });
      }
    } catch (e) { info.error = errMsg(e); }
  }
  const found = list.filter(s => !s.error && s.urlCount > 0);
  return { sitemaps: list, listed: listed as { sitemap: string; match: 'exact' | 'variant' } | null, found: found.length, childLimitReached: children >= maxChildren };
}

// ── indexability ─────────────────────────────────────────────────────────────

export async function checkIndexability(url: URL, crawler: 'googlebot' | 'bingbot' | '*') {
  const ua: UaKey = crawler === 'googlebot' ? 'googlebot' : crawler === 'bingbot' ? 'bingbot' : 'chrome-desktop';
  const items: Item[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];

  const robots = await fetchRobots(url.origin, ua);
  const rv = robotsVerdict(robots, crawler, url.href);
  const group = robots.mode === 'parsed' ? selectGroup(robots.parsed, crawler) : null;
  items.push({ id: 'robots', label: 'robots.txt', status: rv.allowed ? 'pass' : 'fail', message: rv.reason, detail: robots.note });
  if (!rv.allowed) reasons.push(`robots.txt blocks crawling (${rv.rule ? `Disallow: ${rv.rule.path}` : robots.note})`);

  let page: PageResult | null = null;
  let fetchError: string | undefined;
  try { page = await fetchPage(url, { userAgent: ua }); } catch (e) { fetchError = errMsg(e); }

  let finalRobots: ReturnType<typeof robotsVerdict> | null = null;
  let directives = null as ReturnType<typeof effectiveDirectives> | null;
  let directiveSources: { source: string; value: string; applies: boolean }[] = [];
  let canonical: string | null = null;
  let title = '';

  if (!page) {
    items.push({ id: 'status', label: 'HTTP status', status: 'fail', message: `Fetch failed: ${fetchError}` });
    reasons.push(`the page could not be fetched (${fetchError})`);
  } else {
    const redirected = page.chain.length > 1;
    if (redirected) {
      items.push({ id: 'redirect', label: 'Redirect', status: 'warn', message: `URL redirects (${page.chain.map(h => h.status).join(' → ')}) to ${page.finalUrl}. Search engines index the destination, not this URL.` });
      warnings.push(`the URL redirects to ${page.finalUrl}`);
      const finalU = new URL(page.finalUrl);
      if (finalU.origin !== url.origin) {
        const fr = await fetchRobots(finalU.origin, ua);
        finalRobots = robotsVerdict(fr, crawler, page.finalUrl);
      } else finalRobots = robotsVerdict(robots, crawler, page.finalUrl);
      items.push({ id: 'robots-final', label: 'robots.txt (destination)', status: finalRobots.allowed ? 'pass' : 'fail', message: finalRobots.reason });
      if (!finalRobots.allowed) reasons.push('robots.txt blocks the redirect destination');
    }
    if (page.redirectError) {
      items.push({ id: 'status', label: 'HTTP status', status: 'fail', message: page.redirectError });
      reasons.push(page.redirectError);
    } else if (page.status >= 200 && page.status < 300) {
      items.push({ id: 'status', label: 'HTTP status', status: 'pass', message: `${page.status} ${page.statusText}` });
    } else {
      items.push({ id: 'status', label: 'HTTP status', status: 'fail', message: `${page.status} ${page.statusText} — only 2xx pages are indexed.` });
      reasons.push(`the page returns HTTP ${page.status}`);
    }

    const isHtml = /html/i.test(page.contentType) || /<html/i.test(page.text.slice(0, 1000));
    const xr = headerList(page.headers, 'x-robots-tag');
    const { doc, close } = parseHtml(isHtml ? page.text : '', page.finalUrl);
    try {
      title = (doc.querySelector('title')?.textContent || '').trim().slice(0, 200);
      const metas = robotsMetas(doc);
      directives = effectiveDirectives(metas, xr, crawler);
      directiveSources = [
        ...metas.map(m => ({ source: `<meta name="${m.name}">`, value: m.content, applies: m.name === 'robots' || m.name === crawler })),
        ...xr.map(v => {
          const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(v);
          const bot = m && !/^(noindex|nofollow|none|unavailable_after|max-\w+|noarchive|nosnippet|noimageindex|all|index|follow)$/i.test(m[1]) ? m[1].toLowerCase() : null;
          return { source: 'X-Robots-Tag header', value: v, applies: !bot || bot === crawler };
        }),
      ];
      const tags = canonicalTags(doc, page.finalUrl);
      canonical = tags.find(t => t.inHead)?.resolved || linkHeaderCanonical(headerList(page.headers, 'link'), page.finalUrl);
      if (tags.length > 1) {
        items.push({ id: 'canonical', label: 'Canonical', status: 'warn', message: `${tags.length} canonical tags — Google may ignore them all.` });
      }
    } finally { close(); }

    if (directives.noindex) {
      const why = directives.expired ? `unavailable_after (${directives.unavailableAfter}) has passed` : `noindex (${directiveSources.filter(s => s.applies && /noindex|none|unavailable/i.test(s.value)).map(s => s.source).join(', ') || 'robots directive'})`;
      items.push({ id: 'directives', label: 'Robots directives', status: 'fail', message: `Page is ${why}.` });
      reasons.push(why);
      if (!rv.allowed) items.push({ id: 'noindex-blocked', label: 'noindex + robots.txt', status: 'info', message: 'Because robots.txt blocks crawling, crawlers never see this noindex — the URL can still be indexed without content if linked from elsewhere.' });
    } else {
      items.push({ id: 'directives', label: 'Robots directives', status: 'pass', message: directiveSources.length ? `No noindex for ${crawler === '*' ? 'generic crawlers' : crawler}. (${directives.raw.join(', ') || 'index, follow'})` : 'No robots meta tag or X-Robots-Tag header (defaults to index, follow).' });
      if (directives.unavailableAfter) items.push({ id: 'unavailable', label: 'unavailable_after', status: 'warn', message: `Will drop out of the index after ${directives.unavailableAfter}.` });
    }
    if (directives.nofollow) items.push({ id: 'nofollow', label: 'nofollow', status: 'warn', message: 'Links on this page will not be followed.' });

    if (canonical && !sameUrl(canonical, page.finalUrl)) {
      items.push({ id: 'canonical', label: 'Canonical', status: 'warn', message: `Canonical points to ${canonical} — search engines will usually index that URL instead.` });
      warnings.push(`canonicalised to ${canonical}`);
    } else if (canonical) items.push({ id: 'canonical', label: 'Canonical', status: 'pass', message: 'Self-referencing canonical.' });
    else items.push({ id: 'canonical', label: 'Canonical', status: 'info', message: 'No canonical — search engines pick one themselves.' });
  }

  const sm = await discoverSitemaps(url.origin, robots.parsed.sitemaps, [url.href, ...(page ? [page.finalUrl] : [])], ua);
  if (sm.listed) items.push({ id: 'sitemap', label: 'XML sitemap', status: sm.listed.match === 'exact' ? 'pass' : 'warn', message: sm.listed.match === 'exact' ? `Listed in ${sm.listed.sitemap}` : `A variant of this URL (www / trailing slash) is listed in ${sm.listed.sitemap} — list the exact canonical URL.` });
  else if (sm.found) items.push({ id: 'sitemap', label: 'XML sitemap', status: 'warn', message: `Not listed in the ${sm.found} sitemap(s) found${sm.childLimitReached ? ' (only the first 20 child sitemaps were checked)' : ''}. Sitemaps help discovery but aren't required.` });
  else items.push({ id: 'sitemap', label: 'XML sitemap', status: 'warn', message: 'No sitemap found in robots.txt, /sitemap.xml or /sitemap_index.xml.' });

  const blocked = reasons.length > 0;
  const verdict = {
    indexable: !blocked,
    status: blocked ? 'blocked' : warnings.length ? 'warning' : 'indexable',
    summary: blocked
      ? `Not indexable because ${reasons.join('; ')}.`
      : warnings.length ? `Indexable, but ${warnings.join('; ')}.` : `Indexable by ${crawler === '*' ? 'generic crawlers' : crawler === 'googlebot' ? 'Googlebot' : 'Bingbot'}.`,
    reasons, warnings,
  };

  return {
    url: url.href, crawler, verdict, items, title,
    finalUrl: page?.finalUrl ?? null, status: page?.status ?? null, chain: page?.chain ?? [],
    robots: {
      url: robots.url, status: robots.status, mode: robots.mode, note: robots.note, error: robots.error, text: robots.text,
      matchedAgent: rv.agent, matchedRule: rv.rule ?? null, allowed: rv.allowed,
      groupRules: group?.rules.slice(0, 200) ?? [], crawlDelay: group?.crawlDelay, sitemaps: robots.parsed.sitemaps, invalid: robots.parsed.invalid.slice(0, 50),
      finalAllowed: finalRobots?.allowed ?? null,
    },
    directives, directiveSources, canonical,
    sitemaps: sm,
  };
}

// ── canonical audit ──────────────────────────────────────────────────────────

const TRACKING = /^(utm_\w+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|ref|yclid|dclid|igshid)$/i;

async function canonicalOf(url: string, ua: UaKey) {
  const page = await fetchPage(url, { userAgent: ua, timeoutMs: 15_000 });
  const { doc, close } = parseHtml(/html/i.test(page.contentType) ? page.text : '', page.finalUrl);
  try {
    const tags = canonicalTags(doc, page.finalUrl);
    const header = linkHeaderCanonical(headerList(page.headers, 'link'), page.finalUrl);
    const directives = effectiveDirectives(robotsMetas(doc), headerList(page.headers, 'x-robots-tag'), 'googlebot');
    return { page, tags, header, canonical: tags.find(t => t.inHead)?.resolved || header, noindex: directives.noindex };
  } finally { close(); }
}

export async function checkCanonical(url: URL) {
  const ua: UaKey = 'chrome-desktop';
  const items: Item[] = [];
  const first = await canonicalOf(url.href, ua);
  const { page, tags, header } = first;
  const finalUrl = page.finalUrl;
  const canonical = first.canonical;

  if (page.chain.length > 1) items.push({ id: 'redirect', label: 'Requested URL redirects', status: 'info', message: `${url.href} → ${finalUrl} (${page.chain.map(h => h.status).join(' → ')}). Checks below apply to the final URL.` });
  if (page.status !== 200) items.push({ id: 'status', label: 'Page status', status: 'fail', message: `Final URL returns HTTP ${page.status}.` });

  // Tag-level checks
  if (!tags.length && !header) items.push({ id: 'present', label: 'Canonical present', status: 'warn', message: 'No canonical tag or Link header.', detail: 'Add <link rel="canonical" href="https://…"> pointing at the preferred URL (self-referencing on the preferred page).' });
  else items.push({ id: 'present', label: 'Canonical present', status: 'pass', message: tags.length ? `${tags.length} <link rel="canonical"> tag(s)${header ? ' + HTTP Link header' : ''}.` : 'Set via HTTP Link header.' });
  if (tags.length > 1) {
    const distinct = new Set(tags.map(t => t.resolved));
    items.push({ id: 'multiple', label: 'Single canonical', status: 'fail', message: `${tags.length} canonical tags${distinct.size > 1 ? ' with different targets' : ''} — Google ignores conflicting canonicals.`, detail: tags.map(t => t.href).join('\n') });
  }
  if (header && tags[0]?.resolved && !sameUrl(header, tags[0].resolved)) items.push({ id: 'conflict', label: 'Header vs tag', status: 'fail', message: `Link header (${header}) and <link> tag (${tags[0].resolved}) disagree.` });
  if (tags.some(t => !t.inHead)) items.push({ id: 'in-head', label: 'Placed in <head>', status: 'fail', message: 'A canonical tag is in <body> — it is ignored there.', detail: 'Often caused by invalid elements in <head> (e.g. <img>, <div>) that implicitly close it.' });
  const t0 = tags[0];
  if (t0) {
    if (!t0.href.trim()) items.push({ id: 'empty', label: 'href value', status: 'fail', message: 'Canonical href is empty.' });
    else if (!/^https?:\/\//i.test(t0.href.trim())) items.push({ id: 'absolute', label: 'Absolute URL', status: 'warn', message: `Relative href "${t0.href}" — use an absolute URL to avoid mistakes.` });
    else items.push({ id: 'absolute', label: 'Absolute URL', status: 'pass', message: t0.href });
  }

  if (canonical) {
    const c = new URL(canonical);
    const f = new URL(finalUrl);
    items.push({ id: 'self', label: 'Self-referencing', status: sameUrl(canonical, finalUrl) ? 'pass' : 'info', message: sameUrl(canonical, finalUrl) ? 'Canonical points to this page.' : `Canonical points to another URL: ${canonical}` });
    if (c.protocol === 'http:' && f.protocol === 'https:') items.push({ id: 'protocol', label: 'Protocol', status: 'fail', message: 'Canonical uses http:// on an https:// page.' });
    else items.push({ id: 'protocol', label: 'Protocol', status: c.protocol === 'https:' ? 'pass' : 'warn', message: c.protocol === 'https:' ? 'https' : 'Canonical is http:// — prefer https.' });
    if (c.hostname !== f.hostname) {
      items.push({ id: 'host', label: 'Host', status: sameSite(c.hostname, f.hostname) ? 'warn' : 'info', message: sameSite(c.hostname, f.hostname) ? `www mismatch: canonical host ${c.hostname}, page host ${f.hostname}.` : `Cross-domain canonical to ${c.hostname}.` });
    } else items.push({ id: 'host', label: 'Host', status: 'pass', message: c.hostname });
    const cp = c.pathname, fp = f.pathname;
    if (cp !== fp && cp.replace(/\/$/, '') === fp.replace(/\/$/, '')) items.push({ id: 'slash', label: 'Trailing slash', status: 'warn', message: `Trailing slash differs: canonical "${cp}" vs page "${fp}".` });
    if (cp !== fp && cp.toLowerCase() === fp.toLowerCase()) items.push({ id: 'case', label: 'Letter case', status: 'warn', message: 'Canonical differs from the URL only in letter case.' });
    else if (/[A-Z]/.test(cp)) items.push({ id: 'case', label: 'Letter case', status: 'info', message: 'Canonical path contains uppercase letters; lowercase URLs are less error-prone.' });
    const params = [...c.searchParams.keys()];
    const tracking = params.filter(p => TRACKING.test(p));
    if (tracking.length) items.push({ id: 'query', label: 'Query string', status: 'fail', message: `Canonical contains tracking parameters: ${tracking.join(', ')}.` });
    else if (params.length) items.push({ id: 'query', label: 'Query string', status: 'info', message: `Canonical has query parameters (${params.join(', ')}). Fine if they change the content.` });
    if (c.hash || (t0?.href || '').includes('#')) items.push({ id: 'fragment', label: 'Fragment', status: 'warn', message: 'Canonical contains a #fragment — fragments are ignored.' });
    if (page.chain.length > 1 && sameUrl(canonical, url.href)) items.push({ id: 'to-redirect', label: 'Canonical target', status: 'fail', message: 'Canonical points to the URL that redirects to this page.' });
  }

  // Follow the canonical chain
  const chain: { url: string; status: number | null; finalUrl?: string; redirects: number; canonical: string | null; noindex?: boolean; error?: string }[] = [];
  let loop = false;
  if (canonical && !sameUrl(canonical, finalUrl)) {
    const visited = new Set([normalizeUrl(finalUrl)]);
    let next: string | null = canonical;
    for (let i = 0; next && i < 5; i++) {
      const key = normalizeUrl(next);
      if (visited.has(key)) { loop = true; break; }
      visited.add(key);
      try {
        const r = await canonicalOf(next, ua);
        chain.push({ url: next, status: r.page.status, finalUrl: r.page.finalUrl, redirects: r.page.chain.length - 1, canonical: r.canonical, noindex: r.noindex });
        if (!r.canonical || sameUrl(r.canonical, r.page.finalUrl)) break;
        next = r.canonical;
      } catch (e) { chain.push({ url: next, status: null, redirects: 0, canonical: null, error: errMsg(e) }); break; }
    }
    const tgt = chain[0];
    if (tgt) {
      if (tgt.error) items.push({ id: 'target', label: 'Canonical target', status: 'fail', message: `Target can't be fetched: ${tgt.error}` });
      else if (tgt.redirects > 0) items.push({ id: 'target', label: 'Canonical target', status: 'fail', message: `Target redirects to ${tgt.finalUrl} — point the canonical directly at the final URL.` });
      else if (tgt.status !== 200) items.push({ id: 'target', label: 'Canonical target', status: 'fail', message: `Target returns HTTP ${tgt.status}.` });
      else if (tgt.noindex) items.push({ id: 'target', label: 'Canonical target', status: 'fail', message: 'Target is noindex — conflicting signals.' });
      else items.push({ id: 'target', label: 'Canonical target', status: 'pass', message: 'Target returns 200 and is indexable.' });
    }
    if (loop) items.push({ id: 'chain', label: 'Canonical chain', status: 'fail', message: 'Canonical loop: the chain points back to an earlier URL.' });
    else if (chain.length > 1) items.push({ id: 'chain', label: 'Canonical chain', status: 'warn', message: `Canonical chain of ${chain.length} hops — the target canonicalises again to ${chain[chain.length - 1].canonical ?? chain[chain.length - 1].url}.` });
  }

  // URL variants: http/https × www/non-www, plus trailing-slash variant
  const f = new URL(finalUrl);
  const bare = f.hostname.replace(/^www\./, '');
  const isIpOrSingle = /^[\d.]+$/.test(bare) || bare.includes(':') || !bare.includes('.');
  const hosts = isIpOrSingle ? [f.host] : [bare + (f.port ? ':' + f.port : ''), 'www.' + bare + (f.port ? ':' + f.port : '')];
  const pathQ = f.pathname + f.search;
  const variantUrls = new Set<string>();
  for (const proto of ['https:', 'http:']) for (const h of hosts) variantUrls.add(`${proto}//${h}${pathQ}`);
  if (f.pathname !== '/') {
    const alt = f.pathname.endsWith('/') ? f.pathname.slice(0, -1) : f.pathname + '/';
    variantUrls.add(`${f.protocol}//${f.host}${alt}${f.search}`);
  }
  const variants = await mapLimit([...variantUrls], 5, async v => {
    try {
      const r = await fetchPage(v, { userAgent: ua, timeoutMs: 10_000 });
      return { url: v, finalUrl: r.finalUrl, status: r.status, hops: r.chain.map(h => ({ status: h.status, url: h.url })), error: r.redirectError };
    } catch (e) { return { url: v, finalUrl: null as string | null, status: null as number | null, hops: [] as { status: number; url: string }[], error: errMsg(e) }; }
  });
  const preferred = canonical || finalUrl;
  const reachable = variants.filter(v => v.finalUrl && v.status && v.status < 400);
  const destinations = new Set(reachable.map(v => normalizeUrl(v.finalUrl!)));
  if (reachable.length > 1) {
    if (destinations.size === 1) items.push({ id: 'variants', label: 'URL variants', status: 'pass', message: `All ${reachable.length} reachable variants end at ${[...destinations][0]}.` });
    else {
      const notRedirecting = reachable.filter(v => v.hops.length === 1 && !sameUrl(v.url, preferred));
      items.push({ id: 'variants', label: 'URL variants', status: 'warn', message: `Variants resolve to ${destinations.size} different URLs${notRedirecting.length ? ` — ${notRedirecting.length} serve content without redirecting to the preferred URL` : ''}.`, detail: 'Redirect http→https and www/non-www (301) to one version, and rely on canonicals for the rest.' });
    }
  }
  const slowVariants = reachable.filter(v => v.hops.length > 2);
  if (slowVariants.length) items.push({ id: 'variant-chains', label: 'Variant redirect chains', status: 'warn', message: `${slowVariants.length} variant(s) take 2+ redirects (e.g. ${slowVariants[0].url}).` });

  const fails = items.filter(i => i.status === 'fail').length;
  const warns = items.filter(i => i.status === 'warn').length;
  return {
    url: url.href, finalUrl, status: page.status, redirectChain: page.chain,
    canonical, tags, header, selfReferential: canonical ? sameUrl(canonical, finalUrl) : null,
    items, chain, loop, variants,
    verdict: { status: fails ? 'fail' : warns ? 'warn' : 'pass', summary: fails ? `${fails} problem(s) found.` : warns ? `${warns} warning(s).` : 'Canonical setup looks correct.' },
  };
}


