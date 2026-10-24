/**
 * @file tools/seo.ts
 * @description SEO tools backend: on-page audit, indexability, canonical, page weight, backlinks, keywords,
 * sitemap building/crawling. Every outbound fetch goes through the SSRF-guarded fetcher in seo-fetch.ts.
 *
 *  POST /api/tools/seo/analyze        {url, userAgent?}
 *  POST /api/tools/seo/indexability   {url, userAgent: googlebot|bingbot|*}
 *  POST /api/tools/seo/canonical      {url}
 *  POST /api/tools/seo/page-weight    {url, userAgent?}
 *  POST /api/tools/seo/backlinks      {target, pages[]}
 *  POST /api/tools/seo/keywords       {text? | url?, minLength, stopwords, ngrams, includeNumbers}
 *  POST /api/tools/seo/sitemap-build  {urls[] | string, changefreq, priority, lastmod}
 *  job  sitemap-crawl                  (see seo-crawl.ts)
 */

import { HttpError, readJson, sendJson, type ToolRoute } from './http';
import type { ConverterSpec } from './jobs';
import { analyzePage } from './seo-analyze';
import { checkCanonical, checkIndexability } from './seo-checks';
import { checkBacklinks, keywordAnalysis } from './seo-content';
import { sitemapCrawlConverter } from './seo-crawl';
import { errMsg, normalizeInputUrl, uaKey } from './seo-fetch';
import { buildUrlset, CHANGEFREQS, type SitemapEntry } from './seo-robots';
import { pageWeight } from './seo-weight';

const JSON_LIMIT = 2 * 1024 * 1024;

/** Turn network failures of the *target* into 502s with a readable message (blocked targets stay 400). */
async function upstream<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, errMsg(e));
  }
}

export function buildManualSitemap(body: Record<string, any>) {
  const raw: string[] = Array.isArray(body.urls) ? body.urls.map(String) : String(body.urls || '').split(/[\r\n,\s]+/);
  const changefreq = CHANGEFREQS.includes(String(body.changefreq)) ? String(body.changefreq) : undefined;
  const pr = Number(body.priority);
  const priority = body.priority !== undefined && body.priority !== '' && body.priority !== 'none' && Number.isFinite(pr) && pr >= 0 && pr <= 1 ? pr.toFixed(1) : undefined;
  let lastmod: string | undefined;
  if (body.lastmod === 'today') lastmod = new Date().toISOString().slice(0, 10);
  else if (typeof body.lastmod === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(body.lastmod)) lastmod = body.lastmod;
  else if (body.lastmod && body.lastmod !== 'none') throw new HttpError(400, 'lastmod must be "none", "today" or a W3C date (YYYY-MM-DD)');

  const invalid: string[] = [];
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];
  for (const r of raw) {
    const s = r.trim();
    if (!s) continue;
    let u: URL;
    try { u = new URL(s); } catch { invalid.push(s); continue; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || s.length > 2048) { invalid.push(s); continue; }
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    entries.push({ loc: u.href, lastmod, changefreq, priority });
  }
  if (!entries.length) throw new HttpError(400, invalid.length ? `No valid URLs (${invalid.length} invalid)` : 'Add at least one URL');
  if (entries.length > 50_000) throw new HttpError(400, 'A sitemap file may contain at most 50,000 URLs');
  const hosts = new Set(entries.map(e => new URL(e.loc).host));
  return { xml: buildUrlset(entries), count: entries.length, invalid: invalid.slice(0, 200), invalidCount: invalid.length, duplicates: raw.filter(x => x.trim()).length - entries.length - invalid.length, hosts: [...hosts] };
}

export const routes: ToolRoute[] = [
  {
    method: 'POST', path: '/api/tools/seo/analyze',
    async handler({ req, res }) {
      const body = await readJson(req, JSON_LIMIT);
      const url = normalizeInputUrl(body.url);
      sendJson(res, await upstream(() => analyzePage(url.href, uaKey(body.userAgent))));
    },
  },
  {
    method: 'POST', path: '/api/tools/seo/indexability',
    async handler({ req, res }) {
      const body = await readJson(req, JSON_LIMIT);
      const url = normalizeInputUrl(body.url);
      const ua = String(body.userAgent || 'googlebot').toLowerCase();
      const crawler = ua === 'bingbot' ? 'bingbot' : ua === '*' || ua === 'any' ? '*' : 'googlebot';
      sendJson(res, await upstream(() => checkIndexability(url, crawler)));
    },
  },
  {
    method: 'POST', path: '/api/tools/seo/canonical',
    async handler({ req, res }) {
      const body = await readJson(req, JSON_LIMIT);
      const url = normalizeInputUrl(body.url);
      sendJson(res, await upstream(() => checkCanonical(url)));
    },
  },
  {
    method: 'POST', path: '/api/tools/seo/page-weight',
    async handler({ req, res }) {
      const body = await readJson(req, JSON_LIMIT);
      const url = normalizeInputUrl(body.url);
      sendJson(res, await upstream(() => pageWeight(url, uaKey(body.userAgent))));
    },
  },
  {
    method: 'POST', path: '/api/tools/seo/backlinks',
    async handler({ req, res }) {
      const body = await readJson(req, JSON_LIMIT);
      const pages: unknown = body.pages;
      const list = Array.isArray(pages) ? pages.map(String) : String(pages || '').split(/[\r\n]+/);
      if (typeof body.target !== 'string') throw new HttpError(400, 'Missing "target"');
      sendJson(res, await upstream(() => checkBacklinks(body.target, list.filter(s => s.trim()))));
    },
  },
  {
    method: 'POST', path: '/api/tools/seo/keywords',
    async handler({ req, res }) {
      const body = await readJson(req, 5 * 1024 * 1024);
      if (body.text !== undefined && typeof body.text !== 'string') throw new HttpError(400, '"text" must be a string');
      sendJson(res, await upstream(() => keywordAnalysis(body)));
    },
  },
  {
    method: 'POST', path: '/api/tools/seo/sitemap-build',
    async handler({ req, res }) {
      const body = await readJson(req, 8 * 1024 * 1024);
      sendJson(res, buildManualSitemap(body));
    },
  },
];

export const converters: ConverterSpec[] = [sitemapCrawlConverter];
