/**
 * @file tools/seo-content.ts
 * @description Keyword density (text or URL) and backlink verification.
 */

import { effectiveDirectives, canonicalTags, robotsMetas, sameUrl } from './seo-analyze';
import { errMsg, fetchPage, headerList, mapLimit, normalizeInputUrl } from './seo-fetch';
import { absUrl, baseUrlOf, bodyText, collapse, parseHtml, relTokens } from './seo-html';
import { HttpError } from './http';
import { looseUrlKey } from './seo-robots';

// ── keywords ─────────────────────────────────────────────────────────────────

export const STOPWORDS = new Set(`a about above after again against all almost also am among an and any are aren't as at be because been before
being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each either else
even ever every few for from further get gets got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself
him himself his how how's however i i'd i'll i'm i've if in into is isn't it it's its itself just let let's like may me might more most
much must mustn't my myself neither no nor not now of off often on once one only or other others ought our ours ourselves out over own
per perhaps rather really same say says shall shan't she she'd she'll she's should shouldn't since so some still such than that that's the
their theirs them themselves then there there's these they they'd they'll they're they've this those though through thus to too under
until up upon us use used using very via was wasn't we we'd we'll we're we've well were weren't what what's whatever when when's where
where's whether which while who who's whom whose why why's will with within without won't would wouldn't yet you you'd you'll you're
you've your yours yourself yourselves also may new get one two three s t etc`.split(/\s+/).filter(Boolean));

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+|-[\p{L}\p{N}]+)*/gu;

/** Lower-cased tokens, split into runs that never cross sentence / block boundaries. */
export function tokenize(text: string): string[][] {
  return text
    .split(/[.!?;:\n\r|•·()[\]{}"“”«»]+/)
    .map(seg => (seg.toLocaleLowerCase().replace(/’/g, "'").match(WORD_RE) || []))
    .filter(r => r.length);
}

export interface KeywordOptions {
  minLength: number;
  stopwords: boolean;
  maxN: number;
  includeNumbers: boolean;
  top: number;
}

export function keywordStats(runs: string[][], o: KeywordOptions) {
  const words = runs.flat();
  const total = words.length;
  const isNum = (w: string) => /^\p{N}+$/u.test(w);
  const ok1 = (w: string) => w.length >= o.minLength && (!o.stopwords || !STOPWORDS.has(w)) && (o.includeNumbers || !isNum(w));
  const edgeOk = (w: string) => (!o.stopwords || !STOPWORDS.has(w)) && (o.includeNumbers || !isNum(w)) && w.length >= Math.min(2, o.minLength);
  const grams: Record<number, Map<string, number>> = { 1: new Map(), 2: new Map(), 3: new Map() };
  let stopRemoved = 0;
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      if (ok1(run[i])) grams[1].set(run[i], (grams[1].get(run[i]) || 0) + 1);
      else if (o.stopwords && STOPWORDS.has(run[i])) stopRemoved++;
      for (let n = 2; n <= o.maxN; n++) {
        if (i + n > run.length) break;
        const g = run.slice(i, i + n);
        // Phrases may contain stopwords inside ("return on investment") but not at either edge.
        if (!edgeOk(g[0]) || !edgeOk(g[n - 1])) continue;
        if (new Set(g).size === 1) continue; // "very very"
        const k = g.join(' ');
        grams[n].set(k, (grams[n].get(k) || 0) + 1);
      }
    }
  }
  const result: Record<number, { term: string; count: number; density: number }[]> = {};
  for (let n = 1; n <= o.maxN; n++) {
    result[n] = [...grams[n].entries()]
      .filter(([, c]) => n === 1 || c > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, o.top)
      // density = share of all words covered by this term: count × n / total words
      .map(([term, count]) => ({ term, count, density: total ? Math.round((count * n / total) * 10000) / 100 : 0 }));
  }
  return { total, unique: new Set(words).size, stopRemoved, grams: result };
}

const norm = (s: string) => ' ' + tokenize(s).map(r => r.join(' ')).join(' | ') + ' ';

export async function keywordAnalysis(body: Record<string, any>) {
  const o: KeywordOptions = {
    minLength: Math.min(20, Math.max(1, Number(body.minLength) || 3)),
    stopwords: body.stopwords !== false,
    maxN: Math.min(3, Math.max(1, Number(body.ngrams ?? body.maxN) || 3)),
    includeNumbers: !!body.includeNumbers,
    top: Math.min(200, Math.max(5, Number(body.top) || 50)),
  };
  let text = typeof body.text === 'string' ? body.text : '';
  let source: { url?: string; finalUrl?: string; status?: number; title: string; description: string; h1: string[]; h2: string[] } = { title: '', description: '', h1: [], h2: [] };
  if (body.url) {
    const u = normalizeInputUrl(body.url);
    const page = await fetchPage(u);
    if (page.status >= 400) throw new HttpError(502, `Page returned HTTP ${page.status}`);
    const { doc, close } = parseHtml(page.text, page.finalUrl);
    try {
      source = {
        url: u.href, finalUrl: page.finalUrl, status: page.status,
        title: collapse(doc.querySelector('title')?.textContent),
        description: collapse(Array.from(doc.querySelectorAll('meta[name]')).find(m => m.getAttribute('name')?.toLowerCase() === 'description')?.getAttribute('content')),
        h1: Array.from(doc.querySelectorAll('h1')).map(h => collapse(h.textContent)).filter(Boolean).slice(0, 10),
        h2: Array.from(doc.querySelectorAll('h2')).map(h => collapse(h.textContent)).filter(Boolean).slice(0, 50),
      };
      text = bodyText(doc, { dropBoilerplate: body.dropBoilerplate !== false });
    } finally { close(); }
  } else if (!text.trim()) {
    throw new HttpError(400, 'Provide "text" or "url"');
  }
  if (text.length > 2_000_000) text = text.slice(0, 2_000_000);
  const runs = tokenize(text);
  const stats = keywordStats(runs, o);
  const first100 = ' ' + runs.flat().slice(0, 100).join(' ') + ' ';
  let urlWords = '';
  if (source.finalUrl) {
    const u = new URL(source.finalUrl);
    urlWords = ' ' + decodeURIComponent(u.pathname).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ') + ' ';
  }
  const places = {
    title: norm(source.title), description: norm(source.description), h1: norm(source.h1.join('\n')), h2: norm(source.h2.join('\n')),
    first100, url: urlWords,
  };
  const prominence = (term: string) => {
    const t = ' ' + term + ' ';
    return {
      title: places.title.includes(t), description: places.description.includes(t), h1: places.h1.includes(t),
      h2: places.h2.includes(t), first100: places.first100.includes(t), url: !!urlWords && urlWords.includes(t),
    };
  };
  const grams: Record<string, { term: string; count: number; density: number; prominence: ReturnType<typeof prominence> }[]> = {};
  for (const [n, list] of Object.entries(stats.grams)) grams[n] = list.map(k => ({ ...k, prominence: prominence(k.term) }));
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter(s => s.trim().length > 2).length;
  return {
    source: body.url ? source : null,
    options: o,
    stats: {
      totalWords: stats.total, uniqueWords: stats.unique, stopwordsRemoved: stats.stopRemoved, sentences,
      characters: text.length, readingMinutes: Math.max(1, Math.round(stats.total / 230)),
      avgWordsPerSentence: sentences ? Math.round((stats.total / sentences) * 10) / 10 : 0,
    },
    grams,
  };
}

// ── backlinks ────────────────────────────────────────────────────────────────

export function targetMatcher(rawTarget: string) {
  const s = rawTarget.trim();
  if (!s) throw new HttpError(400, 'Missing "target"');
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); } catch { throw new HttpError(400, 'Invalid target'); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const mode: 'domain' | 'url' = (u.pathname !== '/' || u.search) ? 'url' : 'domain';
  const key = looseUrlKey(u.href);
  return {
    mode, host, display: mode === 'domain' ? host : u.href,
    matches(href: string): boolean {
      let h: URL;
      try { h = new URL(href); } catch { return false; }
      const hh = h.hostname.toLowerCase().replace(/^www\./, '');
      if (mode === 'domain') return hh === host || hh.endsWith('.' + host);
      return looseUrlKey(h.href) === key;
    },
  };
}

function contextSnippet(a: Element, anchorText: string): string {
  let block: Element | null = a.parentElement;
  while (block && !/^(P|LI|TD|TH|DD|DT|BLOCKQUOTE|FIGCAPTION|H[1-6]|SECTION|ARTICLE|DIV|FOOTER|NAV|HEADER|ASIDE|BODY)$/.test(block.tagName)) block = block.parentElement;
  const text = collapse(block?.textContent);
  if (!text) return anchorText;
  const at = anchorText ? text.indexOf(anchorText) : -1;
  if (at < 0) return text.slice(0, 220) + (text.length > 220 ? '…' : '');
  const start = Math.max(0, at - 100);
  const end = Math.min(text.length, at + anchorText.length + 100);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function blockKind(a: Element): string {
  if (a.closest('nav,[role="navigation"]')) return 'navigation';
  if (a.closest('footer,[role="contentinfo"]')) return 'footer';
  if (a.closest('header')) return 'header';
  if (a.closest('aside')) return 'sidebar';
  if (a.closest('.comment,.comments,#comments,[class*="comment"]')) return 'comments';
  return 'content';
}

export async function checkBacklinks(target: string, pages: string[]) {
  const m = targetMatcher(target);
  const list = [...new Set(pages.map(p => String(p).trim()).filter(Boolean))];
  if (!list.length) throw new HttpError(400, 'Add at least one referring page URL');
  if (list.length > 50) throw new HttpError(400, 'At most 50 pages per check');
  const results = await mapLimit(list, 5, async raw => {
    let u: URL;
    try { u = normalizeInputUrl(raw, 'page'); } catch (e) { return { url: raw, error: errMsg(e), status: null, links: [] as any[], found: false }; }
    try {
      const page = await fetchPage(u);
      const { doc, close } = parseHtml(/html/i.test(page.contentType) ? page.text : '', page.finalUrl);
      try {
        const base = baseUrlOf(doc, page.finalUrl);
        const directives = effectiveDirectives(robotsMetas(doc), headerList(page.headers, 'x-robots-tag'), 'googlebot');
        const canonical = canonicalTags(doc, page.finalUrl).find(t => t.inHead)?.resolved ?? null;
        let totalLinks = 0;
        const links = [];
        for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
          const href = absUrl(a.getAttribute('href'), base);
          if (!href || !/^https?:/.test(href)) continue;
          totalLinks++;
          if (!m.matches(href)) continue;
          const rel = relTokens(a);
          const img = a.querySelector('img');
          const text = collapse(a.textContent);
          links.push({
            href, anchor: text || (img ? `[image: ${collapse(img.getAttribute('alt')) || 'no alt'}]` : ''), rel,
            nofollow: rel.includes('nofollow'), sponsored: rel.includes('sponsored'), ugc: rel.includes('ugc'),
            image: !!img && !text, placement: blockKind(a), context: contextSnippet(a, text),
          });
          if (links.length >= 100) break;
        }
        const indexable = page.status === 200 && !directives.noindex;
        return {
          url: u.href, finalUrl: page.finalUrl, status: page.status, title: collapse(doc.querySelector('title')?.textContent).slice(0, 200),
          indexable, noindex: directives.noindex, pageNofollow: directives.nofollow,
          canonical, canonicalElsewhere: !!canonical && !sameUrl(canonical, page.finalUrl),
          totalLinks, links, found: links.length > 0,
          // The referring page is itself on the target site: these are internal links, not backlinks.
          internal: targetMatcher(m.host).matches(page.finalUrl),
          followed: links.filter(l => !l.nofollow && !l.sponsored && !l.ugc).length,
        };
      } finally { close(); }
    } catch (e) {
      return { url: u.href, error: errMsg(e), status: null, links: [] as any[], found: false };
    }
  });
  const ok = results.filter(r => !('error' in r && r.error));
  const allLinks = results.flatMap(r => r.links);
  return {
    target: m.display, mode: m.mode,
    summary: {
      pages: results.length, fetched: ok.length, errors: results.length - ok.length,
      pagesWithLinks: results.filter(r => r.found).length,
      internalPages: results.filter(r => 'internal' in r && r.internal).length,
      links: allLinks.length,
      followed: allLinks.filter((l: any) => !l.nofollow && !l.sponsored && !l.ugc).length,
      nofollow: allLinks.filter((l: any) => l.nofollow).length,
      sponsored: allLinks.filter((l: any) => l.sponsored).length,
      ugc: allLinks.filter((l: any) => l.ugc).length,
    },
    results,
  };
}
