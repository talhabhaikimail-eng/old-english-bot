/**
 * @file tools/seo-crawl.ts
 * @description BFS site crawler that produces sitemap.xml (+ urls.txt). Runs as the `sitemap-crawl` job.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { fetchRobots, robotsVerdict, type RobotsInfo } from './seo-checks';
import { canonicalTags, effectiveDirectives, robotsMetas, sameUrl } from './seo-analyze';
import { errMsg, fetchPage, headerList, normalizeInputUrl, uaKey } from './seo-fetch';
import { absUrl, baseUrlOf, parseHtml, relTokens } from './seo-html';
import { buildSitemapFiles, CHANGEFREQS, normalizeUrl, type SitemapEntry } from './seo-robots';
import type { ConverterSpec, JobRunCtx } from './jobs';

const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|gz|tgz|rar|7z|tar|mp3|mp4|m4a|wav|ogg|webm|mov|avi|mkv|css|js|mjs|json|xml|txt|csv|woff2?|ttf|otf|eot|exe|dmg|apk|msi|docx?|xlsx?|pptx?|rss|atom)$/i;

export interface CrawlOptions {
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  sameHostOnly: boolean;
  respectRobots: boolean;
  includeLastmod: boolean;
  changefreq: string;
  priority: string;
  userAgent: string;
  ignoreQuery: boolean;
}

function priorityFor(setting: string, depth: number): string | undefined {
  if (setting === 'none') return undefined;
  if (setting === 'auto') return depth === 0 ? '1.0' : depth === 1 ? '0.8' : depth === 2 ? '0.6' : '0.5';
  return setting;
}

export async function crawlSite(o: CrawlOptions, ctx: Pick<JobRunCtx, 'progress' | 'signal'>) {
  const t0 = Date.now();
  const start = normalizeInputUrl(o.startUrl, 'startUrl');
  const ua = uaKey(o.userAgent);
  const crawler = ua === 'googlebot' ? 'googlebot' : ua === 'bingbot' ? 'bingbot' : '*';
  const maxPages = Math.min(500, Math.max(1, Math.floor(o.maxPages) || 100));
  const maxDepth = Math.min(50, Math.max(0, Math.floor(o.maxDepth)));
  const startHost = start.hostname.toLowerCase();
  const bareHost = startHost.replace(/^www\./, '');
  const inScope = (u: string) => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      if (o.sameHostOnly) return h === startHost;
      const b = h.replace(/^www\./, '');
      return b === bareHost || b.endsWith('.' + bareHost);
    } catch { return false; }
  };
  const norm = (u: string, base?: string) => normalizeUrl(u, base, { stripQuery: o.ignoreQuery });

  const robots = new Map<string, Promise<RobotsInfo>>();
  const robotsFor = (origin: string) => {
    let p = robots.get(origin);
    if (!p) { p = fetchRobots(origin, ua, ctx.signal); robots.set(origin, p); }
    return p;
  };

  const startKey = norm(start.href)!;
  const queue: { url: string; depth: number }[] = [{ url: startKey, depth: 0 }];
  const seen = new Set([startKey]);
  const included = new Map<string, SitemapEntry & { depth: number }>();
  const excluded: { url: string; reason: string }[] = [];
  const errors: { url: string; status?: number; error?: string }[] = [];
  let fetched = 0;
  let active = 0;
  let queueCapped = false;
  const fetchMs: number[] = [];

  const enqueue = (u: string | null, depth: number) => {
    if (!u || seen.has(u) || !inScope(u)) return;
    try { if (SKIP_EXT.test(new URL(u).pathname)) return; } catch { return; }
    if (seen.size > maxPages * 30) { queueCapped = true; return; }
    seen.add(u);
    queue.push({ url: u, depth });
  };

  const report = () => ctx.progress(Math.min(99, Math.round((fetched / maxPages) * 100)), `Crawled ${fetched} page(s) · ${included.size} in sitemap · ${queue.length} queued`);

  async function processItem(item: { url: string; depth: number }) {
    let url = item.url;
    if (o.respectRobots) {
      const v = robotsVerdict(await robotsFor(new URL(url).origin), crawler, url);
      if (!v.allowed) { excluded.push({ url, reason: `robots.txt${v.rule ? ` (Disallow: ${v.rule.path})` : ''}` }); return; }
    }
    const page = await fetchPage(url, { userAgent: ua, signal: ctx.signal, timeoutMs: 20_000 });
    fetchMs.push(page.totalMsAll);
    if (page.chain.length > 1) {
      const final = norm(page.finalUrl);
      if (!final || !inScope(final)) { excluded.push({ url, reason: `redirects off-site to ${page.finalUrl}` }); return; }
      if (final !== url) {
        excluded.push({ url, reason: `redirects to ${final}` });
        if (seen.has(final)) return; // processed (or queued) on its own
        seen.add(final);
        url = final;
      }
    }
    if (page.redirectError) { errors.push({ url, error: page.redirectError }); return; }
    if (page.status !== 200) { errors.push({ url, status: page.status }); return; }
    if (!/html/i.test(page.contentType)) { excluded.push({ url, reason: `not HTML (${page.contentType.split(';')[0] || 'unknown type'})` }); return; }
    if (o.respectRobots && url !== item.url) {
      const v = robotsVerdict(await robotsFor(new URL(url).origin), crawler, url);
      if (!v.allowed) { excluded.push({ url, reason: 'robots.txt' }); return; }
    }
    const { doc, close } = parseHtml(page.text, page.finalUrl);
    try {
      const d = effectiveDirectives(robotsMetas(doc), headerList(page.headers, 'x-robots-tag'), crawler);
      const canonical = canonicalTags(doc, page.finalUrl).find(t => t.inHead)?.resolved;
      const canonKey = canonical ? norm(canonical) : null;
      if (d.noindex) excluded.push({ url, reason: 'noindex' });
      else if (canonKey && !sameUrl(canonKey, url)) {
        excluded.push({ url, reason: `canonical → ${canonKey}` });
        enqueue(canonKey, item.depth);
      } else {
        const lm = page.headers['last-modified'];
        const lmDate = o.includeLastmod && lm ? new Date(String(lm)) : null;
        included.set(url, {
          loc: url, depth: item.depth,
          lastmod: lmDate && Number.isFinite(lmDate.getTime()) ? lmDate.toISOString().replace(/\.\d{3}Z$/, '+00:00') : undefined,
          changefreq: CHANGEFREQS.includes(o.changefreq) ? o.changefreq : undefined,
          priority: priorityFor(o.priority, item.depth),
        });
      }
      if (d.nofollow || item.depth >= maxDepth) return;
      const base = baseUrlOf(doc, page.finalUrl);
      for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
        if (relTokens(a).includes('nofollow')) continue;
        const raw = a.getAttribute('href') || '';
        if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(raw)) continue;
        enqueue(norm(absUrl(raw, base) || ''), item.depth + 1);
      }
    } finally { close(); }
  }

  async function worker() {
    while (!ctx.signal.aborted) {
      if (fetched >= maxPages) return;
      const item = queue.shift();
      if (!item) {
        if (active === 0) return;
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      active++;
      fetched++;
      try { await processItem(item); } catch (e) {
        if (ctx.signal.aborted) return;
        errors.push({ url: item.url, error: errMsg(e) });
      } finally { active--; report(); }
    }
  }

  report();
  await Promise.all(Array.from({ length: 4 }, worker));
  if (ctx.signal.aborted) throw new Error('Crawl cancelled');

  const entries = [...included.values()].sort((a, b) => a.depth - b.depth || a.loc.localeCompare(b.loc));
  const avg = fetchMs.length ? Math.round(fetchMs.reduce((a, b) => a + b, 0) / fetchMs.length) : 0;
  return {
    start: startKey,
    entries,
    meta: {
      startUrl: startKey,
      discovered: seen.size,
      crawled: fetched,
      included: entries.length,
      queued: queue.length,
      limitReached: fetched >= maxPages && queue.length > 0,
      queueCapped,
      excluded: excluded.slice(0, 500),
      excludedCount: excluded.length,
      errors: errors.slice(0, 500),
      errorCount: errors.length,
      durationMs: Date.now() - t0,
      avgFetchMs: avg,
      maxDepthReached: entries.reduce((m, e) => Math.max(m, e.depth), 0),
    },
  };
}

export const sitemapCrawlConverter: ConverterSpec = {
  id: 'sitemap-crawl',
  label: 'Crawl site → sitemap.xml',
  group: 'other',
  inputs: [],
  output: 'xml',
  minFiles: 0,
  maxFiles: 0,
  timeoutMs: 15 * 60_000,
  options: [
    { key: 'startUrl', label: 'Start URL', type: 'text', default: 'https://example.com', placeholder: 'https://example.com' },
    { key: 'maxPages', label: 'Max pages', type: 'number', default: 100, min: 1, max: 500 },
    { key: 'maxDepth', label: 'Max depth', type: 'number', default: 5, min: 0, max: 20 },
    { key: 'sameHostOnly', label: 'Same host only', type: 'boolean', default: true, help: 'Off: include subdomains of the start host.' },
    { key: 'respectRobots', label: 'Respect robots.txt', type: 'boolean', default: true },
    { key: 'includeLastmod', label: 'lastmod from Last-Modified', type: 'boolean', default: true },
    { key: 'ignoreQuery', label: 'Ignore query strings', type: 'boolean', default: false },
    {
      key: 'changefreq', label: 'changefreq', type: 'select', default: 'none',
      choices: [{ value: 'none', label: '(omit)' }, ...CHANGEFREQS.map(c => ({ value: c, label: c }))],
    },
    {
      key: 'priority', label: 'priority', type: 'select', default: 'none',
      choices: [{ value: 'none', label: '(omit)' }, { value: 'auto', label: 'By depth (1.0 → 0.5)' }, ...['1.0', '0.9', '0.8', '0.7', '0.6', '0.5', '0.4', '0.3', '0.2', '0.1'].map(v => ({ value: v, label: v }))],
    },
    {
      key: 'userAgent', label: 'User agent', type: 'select', default: 'chrome-desktop',
      choices: [{ value: 'chrome-desktop', label: 'Chrome desktop' }, { value: 'chrome-mobile', label: 'Chrome mobile' }, { value: 'googlebot', label: 'Googlebot smartphone' }, { value: 'bingbot', label: 'Bingbot' }],
    },
  ],
  async run(ctx) {
    const o = ctx.options as CrawlOptions;
    const res = await crawlSite(o, ctx);
    if (!res.entries.length) {
      const why = res.meta.errors[0] ? `${res.meta.errors[0].url}: ${res.meta.errors[0].error || `HTTP ${res.meta.errors[0].status}`}` : res.meta.excluded[0] ? `${res.meta.excluded[0].url}: ${res.meta.excluded[0].reason}` : 'no pages found';
      throw new Error(`No indexable pages found (${why})`);
    }
    ctx.progress(99, 'Writing sitemap…');
    const origin = new URL(res.start).origin;
    const files = buildSitemapFiles(res.entries, origin);
    const outputs = [];
    for (const f of files) {
      const p = join(ctx.workDir, f.name);
      await fs.writeFile(p, f.xml, 'utf-8');
      outputs.push({ path: p, filename: f.name, mimeType: 'application/xml' });
    }
    const txt = join(ctx.workDir, 'urls.txt');
    await fs.writeFile(txt, res.entries.map(e => e.loc).join('\n') + '\n', 'utf-8');
    outputs.push({ path: txt, filename: 'urls.txt', mimeType: 'text/plain' });
    return { outputs, meta: res.meta };
  },
};
