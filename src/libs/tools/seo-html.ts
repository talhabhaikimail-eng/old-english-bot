/**
 * @file tools/seo-html.ts
 * @description HTML → SEO facts extraction (jsdom, scripts never executed, no subresources loaded).
 */

// jsdom ships no bundled types and @types/jsdom isn't installed.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JSDOM, VirtualConsole } = require('jsdom');

export type Doc = Document;

/** Parse HTML into a DOM; call `close()` when done to free memory. */
export function parseHtml(html: string, url: string): { doc: Doc; close: () => void } {
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole(), contentType: 'text/html' });
  return { doc: dom.window.document as Doc, close: () => dom.window.close() };
}

export const collapse = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

export function relTokens(el: Element): string[] {
  return (el.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
}

export function absUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try { return new URL(href.trim(), base).href; } catch { return null; }
}

/** Visible-ish text of the body: scripts, styles, templates, SVG and hidden inputs removed. */
export function bodyText(doc: Doc, { dropBoilerplate = false } = {}): string {
  const body = doc.body;
  if (!body) return '';
  const clone = body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script,style,noscript,template,svg,iframe,object,canvas,select,[hidden],[aria-hidden="true"]').forEach(n => n.remove());
  if (dropBoilerplate) clone.querySelectorAll('nav,footer,aside,[role="navigation"],[role="contentinfo"]').forEach(n => n.remove());
  // Separate block elements so words don't glue together.
  clone.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,td,th,br,section,article,header,footer,tr,blockquote,dt,dd,figcaption').forEach(n => n.appendChild(n.ownerDocument.createTextNode('\n')));
  return (clone.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
}

/** The base URL for resolving links (honours <base href>). */
export function baseUrlOf(doc: Doc, pageUrl: string): string {
  const b = doc.querySelector('base[href]')?.getAttribute('href');
  return (b && absUrl(b, pageUrl)) || pageUrl;
}

/** Pick the largest candidate from a srcset (by w descriptor, then x). */
export function largestFromSrcset(srcset: string | null, base: string): string | null {
  if (!srcset) return null;
  let best: { url: string; score: number } | null = null;
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [u, d] = part.trim().split(/\s+/);
    if (!u) continue;
    const n = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1;
    const abs = absUrl(u, base);
    if (abs && (!best || n > best.score)) best = { url: abs, score: n };
  }
  return best?.url ?? null;
}

/** Collect @type values from parsed JSON-LD (handles @graph, arrays and nesting). */
export function jsonLdTypes(data: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || data === null || typeof data !== 'object') return out;
  if (Array.isArray(data)) { data.forEach(d => jsonLdTypes(d, out, depth + 1)); return out; }
  const obj = data as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) t.forEach(x => typeof x === 'string' && out.add(x));
  for (const [k, v] of Object.entries(obj)) if (k !== '@context' && typeof v === 'object') jsonLdTypes(v, out, depth + 1);
  return out;
}

export function sameSite(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
  return strip(a) === strip(b);
}
