/**
 * @file tools/dev.ts
 * @description Developer utilities for the Dev Tools panel:
 *   POST /api/tools/dev/minify-js    Terser (run in a worker thread with a timeout)
 *   POST /api/tools/dev/minify-html  tokenizer-based HTML minifier (inline JS via Terser, inline CSS via minifyCss)
 *   POST /api/tools/dev/minify-css   CSS minifier (string / url() / calc() safe)
 *
 * The CSS parser/minifier below mirrors dashboard/src/components/devtools/lib/dev.ts (the backend can't import
 * from the dashboard package) — keep the two in sync.
 */

import { Worker } from 'worker_threads';
import { gzipSync } from 'zlib';
import { HttpError, readJson, sendJson, str, type ToolRoute } from './http';
import type { ConverterSpec } from './jobs';

const MAX_SOURCE = 5 * 1024 * 1024;
const JSON_LIMIT = 24 * 1024 * 1024; // 5M chars can grow a lot once JSON-escaped
const TERSER_TIMEOUT_MS = 90_000;

// ─────────────────────────────────────────────────────────────────────────────
// Terser in a worker (a pathological input can't block the event loop forever)
// ─────────────────────────────────────────────────────────────────────────────

interface TerserTask { code: string; options: Record<string, unknown> }
interface TerserResult { code?: string; map?: string; error?: { message: string; line?: number; col?: number } }

const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const { minify } = require(workerData.terserPath);
parentPort.once('message', async (tasks) => {
  const out = [];
  for (const t of tasks) {
    try {
      const r = await minify(t.code, t.options);
      out.push({ code: r.code, map: typeof r.map === 'string' ? r.map : undefined });
    } catch (e) {
      out.push({ error: { message: String(e && e.message || e), line: e && e.line, col: e && e.col } });
    }
  }
  parentPort.postMessage(out);
});`;

let terserPath: string | null = null;
let running = 0;
const waiters: (() => void)[] = [];
const MAX_WORKERS = 2;

async function runTerser(tasks: TerserTask[]): Promise<TerserResult[]> {
  if (!tasks.length) return [];
  if (!terserPath) terserPath = require.resolve('terser');
  if (running >= MAX_WORKERS) await new Promise<void>(r => waiters.push(r));
  running++;
  try {
    return await new Promise<TerserResult[]>((resolve, reject) => {
      const worker = new Worker(WORKER_SRC, { eval: true, workerData: { terserPath }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
      const timer = setTimeout(() => { worker.terminate(); reject(new HttpError(504, 'Minification timed out')); }, TERSER_TIMEOUT_MS);
      worker.once('message', (r: TerserResult[]) => { clearTimeout(timer); worker.terminate(); resolve(r); });
      worker.once('error', e => { clearTimeout(timer); reject(e); });
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0 && code !== 1) reject(new Error(`terser worker exited with ${code}`)); });
      worker.postMessage(tasks);
    });
  } finally {
    running--;
    waiters.shift()?.();
  }
}

function sizes(original: string, minified: string) {
  const a = Buffer.from(original, 'utf-8');
  const b = Buffer.from(minified, 'utf-8');
  return {
    original: a.length,
    minified: b.length,
    gzipOriginal: gzipSync(a, { level: 9 }).length,
    gzipMinified: gzipSync(b, { level: 9 }).length,
  };
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

interface JsOptions {
  compress?: boolean; mangle?: boolean; module?: boolean; ecma?: number; keepFnames?: boolean; keepClassnames?: boolean;
  dropConsole?: boolean; dropDebugger?: boolean; passes?: number; comments?: 'none' | 'license' | 'all'; sourceMap?: boolean; toplevel?: boolean;
}

const LICENSE_COMMENT = /^\**!|@preserve|@license|@cc_on/i;

function terserOptions(o: JsOptions, { sourceMap = false } = {}): Record<string, unknown> {
  const ecma = [5, 2015, 2016, 2017, 2018, 2019, 2020].includes(Number(o.ecma)) ? Number(o.ecma) : 2020;
  const compress = bool(o.compress, true)
    ? {
      ecma,
      drop_console: bool(o.dropConsole, false),
      drop_debugger: bool(o.dropDebugger, true),
      passes: Math.min(3, Math.max(1, Number(o.passes) || 1)),
      keep_fnames: bool(o.keepFnames, false),
      keep_classnames: bool(o.keepClassnames, false),
    }
    : false;
  const mangle = bool(o.mangle, true) ? { keep_fnames: bool(o.keepFnames, false), keep_classnames: bool(o.keepClassnames, false) } : false;
  const comments = o.comments === 'all' ? 'all' : o.comments === 'none' ? false : LICENSE_COMMENT;
  return {
    ecma,
    module: bool(o.module, false),
    toplevel: bool(o.toplevel, bool(o.module, false)),
    compress,
    mangle,
    keep_fnames: bool(o.keepFnames, false),
    keep_classnames: bool(o.keepClassnames, false),
    format: { comments, ecma },
    ...(sourceMap ? { sourceMap: { filename: 'script.min.js', url: 'script.min.js.map', includeSources: true } } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS (mirrors the dashboard lib)
// ─────────────────────────────────────────────────────────────────────────────

class SourceError extends Error {
  constructor(message: string, public line?: number, public col?: number) {
    super(line ? `${message} (line ${line}${col ? `, column ${col}` : ''})` : message);
  }
}

/** 1-based line/column of an offset in `src`. */
function lineCol(src: string, pos: number): { line: number; col: number } {
  const before = src.slice(0, Math.max(0, pos));
  const line = before.split('\n').length;
  return { line, col: before.length - before.lastIndexOf('\n') };
}


type CssNode =
  | { type: 'rule'; prelude: string; children: CssNode[] }
  | { type: 'decl'; prop: string; value: string }
  | { type: 'at'; text: string }
  | { type: 'comment'; text: string };

/** Parse CSS (incl. nesting) into a tree. Comments between statements are kept; comments inside values are dropped. */
function parseCss(src: string): CssNode[] {
  let i = 0;
  const err = (msg: string, pos = i): never => { const p = lineCol(src, pos); throw new SourceError(msg, p.line, p.col); };

  const parseBlock = (nested: boolean, openPos: number): CssNode[] => {
    const nodes: CssNode[] = [];
    let buf = '';
    let paren = 0;
    let bracket = 0;
    let segStart = i;
    const flushStatement = () => {
      const t = buf.trim();
      buf = '';
      if (!t) return;
      if (t.startsWith('@')) { nodes.push({ type: 'at', text: t }); return; }
      const c = t.indexOf(':');
      if (c <= 0) err(`Expected "property: value" but found "${t.slice(0, 40)}"`, segStart);
      nodes.push({ type: 'decl', prop: t.slice(0, c).trim(), value: t.slice(c + 1).trim() });
    };
    while (i < src.length) {
      const ch = src[i];
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) err('Unterminated comment');
        const text = src.slice(i + 2, end);
        if (!buf.trim()) nodes.push({ type: 'comment', text });
        else buf += ' ';
        i = end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const s = i;
        i++;
        while (i < src.length && src[i] !== ch) {
          if (src[i] === '\\') i++;
          else if (src[i] === '\n') err('Unterminated string', s);
          i++;
        }
        if (i >= src.length) err('Unterminated string', s);
        i++;
        buf += src.slice(s, i);
        continue;
      }
      if (/^url\(/i.test(src.slice(i, i + 4)) && !/[\w-]/.test(src[i - 1] ?? '')) {
        // unquoted url(...) can contain ; { } etc. Quoted urls are handled as strings.
        let j = i + 4;
        while (/\s/.test(src[j] ?? '')) j++;
        if (src[j] !== '"' && src[j] !== "'") {
          const end = src.indexOf(')', j);
          if (end < 0) err('Unterminated url(');
          buf += src.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      if (!buf.trim()) segStart = i;
      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '[') bracket++;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      if (paren || bracket) { buf += ch; i++; continue; }
      if (ch === '{') {
        const prelude = buf.trim();
        const bracePos = i;
        buf = '';
        i++;
        if (!prelude) err('Missing selector before "{"', bracePos);
        const children = parseBlock(true, bracePos);
        nodes.push({ type: 'rule', prelude, children });
        continue;
      }
      if (ch === ';') { flushStatement(); i++; continue; }
      if (ch === '}') {
        if (!nested) err('Unexpected "}"');
        flushStatement();
        i++;
        return nodes;
      }
      buf += ch;
      i++;
    }
    if (nested) err('Unclosed "{"', openPos);
    if (buf.trim()) {
      if (buf.trim().startsWith('@')) nodes.push({ type: 'at', text: buf.trim() });
      else err(`Unexpected "${buf.trim().slice(0, 40)}" at end of file`, segStart);
    }
    return nodes;
  };
  return parseBlock(false, 0);
}

/**
 * Walk text, calling `fn` only on the parts that are outside strings and url(...),
 * and passing protected parts through verbatim.
 */
function mapOutsideStrings(text: string, fn: (s: string) => string): string {
  let out = '';
  let chunk = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const s = i;
      i++;
      while (i < text.length && text[i] !== ch) { if (text[i] === '\\') i++; i++; }
      i++;
      out += fn(chunk) + text.slice(s, i);
      chunk = '';
      continue;
    }
    if (/^url\(/i.test(text.slice(i, i + 4)) && !/[\w-]/.test(text[i - 1] ?? '')) {
      let j = i + 4;
      while (/\s/.test(text[j] ?? '')) j++;
      if (text[j] !== '"' && text[j] !== "'") {
        const end = text.indexOf(')', j);
        const e = end < 0 ? text.length : end + 1;
        out += fn(chunk + 'url(') + text.slice(i + 4, e).trim().replace(/\)$/, '').trim() + ')';
        chunk = '';
        i = e;
        continue;
      }
    }
    chunk += ch;
    i++;
  }
  return out + fn(chunk);
}

const collapse = (s: string) => s.replace(/\s+/g, ' ');

/** Normalise "a : b" → `a${sep}b` only inside parentheses (media features), leaving "@page :first" alone. */
function colonInParens(s: string, sep: string): string {
  let depth = 0; let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ':' && depth > 0) { out = out.replace(/\s+$/, '') + sep; while (s[i + 1] === ' ') i++; continue; }
    out += c;
  }
  return out;
}

/** Minify a declaration value (calc-safe: never touches spaces around + and -). */
function minifyCssValue(v: string): string {
  return mapOutsideStrings(v.trim(), s => collapse(s)
    .replace(/\s*,\s*/g, ',')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*!\s*important/gi, '!important')
    .replace(/(^|[^\w.#-])(-?)0+\.(\d)/g, '$1$2.$3')  // 0.5 → .5
    .replace(/(\.\d*?[1-9])0+(?=[a-z%]*(?:[^\w.]|$))/gi, '$1'), // 1.50 → 1.5
  );
}

/** Minify a rule prelude. Selectors drop spaces around combinators; at-rule preludes stay conservative. */
function minifyCssPrelude(p: string): string {
  const at = p.trim().startsWith('@');
  return mapOutsideStrings(p.trim(), s => {
    const r = collapse(s).replace(/\s*,\s*/g, ',').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
    if (at) return colonInParens(r, ':');
    // Careful: "a :hover" ≠ "a:hover", so we never remove a space *before* ":".
    return r.replace(/\s*([>~+])\s*/g, '$1');
  });
}

function minifyCss(src: string, { keepLicense = true } = {}): string {
  const nodes = parseCss(src);
  const ser = (list: CssNode[]): string => {
    const parts: string[] = [];
    let prevDecl = false;
    for (const n of list) {
      if (n.type === 'comment') { if (keepLicense && n.text.startsWith('!')) parts.push(`/*${n.text}*/`); continue; }
      if (n.type === 'decl') {
        parts.push((prevDecl ? ';' : '') + `${n.prop.trim()}:${n.prop.startsWith('--') ? n.value.trim() : minifyCssValue(n.value)}`);
        prevDecl = true;
        continue;
      }
      if (prevDecl) parts.push(';');
      prevDecl = false;
      if (n.type === 'at') { parts.push(minifyCssPrelude(n.text) + ';'); continue; }
      const body = ser(n.children);
      if (!body && !n.prelude.startsWith('@')) continue; // drop empty rules
      parts.push(`${minifyCssPrelude(n.prelude)}{${body}}`);
    }
    return parts.join('');
  };
  return ser(nodes);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML minifier
// ─────────────────────────────────────────────────────────────────────────────

export interface HtmlMinifyOptions {
  removeComments?: boolean;
  collapseWhitespace?: boolean;
  conservativeCollapse?: boolean;
  minifyJs?: boolean;
  minifyCss?: boolean;
  removeOptionalQuotes?: boolean;
  removeEmptyAttributes?: boolean;
  collapseBooleanAttributes?: boolean;
  removeScriptTypes?: boolean;
}

interface HAttr { name: string; value: string | null; quote: '"' | "'" | '' }
type HTok =
  | { t: 'text'; v: string }
  | { t: 'comment'; v: string }          // full raw comment incl. <!-- -->
  | { t: 'decl'; v: string }             // <!doctype …>, <?…>, <![CDATA[…]]>
  | { t: 'open'; name: string; raw: string; attrs: HAttr[]; selfClose: boolean }
  | { t: 'close'; name: string; raw: string }
  | { t: 'raw'; v: string; parent: string; attrs: HAttr[] };

/** Elements whose content is not HTML (scanned verbatim up to the matching end tag). */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'plaintext', 'noembed', 'noframes']);

/** Whitespace next to these tags is not rendered, so it can be dropped entirely. */
const BLOCK = new Set([
  'html', 'head', 'body', 'meta', 'link', 'title', 'base', 'script', 'style', 'noscript', 'template',
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ul', 'legend',
  'option', 'optgroup', 'datalist', 'source', 'track', 'param', 'picture', 'video', 'audio', 'canvas', 'map', 'area',
  'svg', 'math', 'iframe', 'object', 'embed', 'search',
]);

const BOOLEAN_ATTRS = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'formnovalidate',
  'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline', 'readonly',
  'required', 'reversed', 'selected', 'shadowrootdelegatesfocus', 'shadowrootclonable', 'shadowrootserializable',
]);

const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript', 'application/ecmascript',
  'application/x-javascript', 'text/x-javascript', 'text/jscript', 'text/livescript']);
const JSON_TYPES = new Set(['application/json', 'application/ld+json', 'importmap', 'speculationrules', 'application/manifest+json']);

export function tokenizeHtml(src: string): HTok[] {
  const out: HTok[] = [];
  let i = 0;
  const n = src.length;
  const pushText = (v: string) => {
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.v += v; else out.push({ t: 'text', v });
  };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end < 0 ? n : end + 3;
      out.push({ t: 'comment', v: src.slice(i, stop) });
      i = stop;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i);
      const stop = end < 0 ? n : end + 3;
      out.push({ t: 'decl', v: src.slice(i, stop) });
      i = stop;
      continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      const end = src.indexOf('>', i);
      const stop = end < 0 ? n : end + 1;
      out.push({ t: 'decl', v: src.slice(i, stop) });
      i = stop;
      continue;
    }
    if (src[i + 1] === '/' && /[A-Za-z]/.test(src[i + 2] ?? '')) {
      const end = src.indexOf('>', i);
      const stop = end < 0 ? n : end + 1;
      const raw = /^<\/([^\s/>]+)/.exec(src.slice(i, stop))![1];
      out.push({ t: 'close', name: raw.toLowerCase(), raw });
      i = stop;
      continue;
    }
    if (!/[A-Za-z]/.test(src[i + 1] ?? '')) { pushText('<'); i++; continue; }

    // start tag
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const rawName = src.slice(i + 1, j);
    const attrs: HAttr[] = [];
    let selfClose = false;
    for (;;) {
      while (j < n && (/\s/.test(src[j]) || (src[j] === '/' && src[j + 1] !== '>'))) j++;
      if (j >= n) break;
      if (src[j] === '>') { j++; break; }
      if (src[j] === '/' && src[j + 1] === '>') { selfClose = true; j += 2; break; }
      const an = j;
      j++; // the first character may be anything except whitespace, / and >
      while (j < n && !/[\s/>=]/.test(src[j])) j++;
      const name = src.slice(an, j);
      let k = j;
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] !== '=') { attrs.push({ name, value: null, quote: '' }); continue; }
      k++;
      while (k < n && /\s/.test(src[k])) k++;
      const q = src[k];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, k + 1);
        const stop = end < 0 ? n : end;
        attrs.push({ name, value: src.slice(k + 1, stop), quote: q });
        j = stop + 1;
      } else {
        let e = k;
        while (e < n && !/[\s>]/.test(src[e])) e++;
        attrs.push({ name, value: src.slice(k, e), quote: '' });
        j = e;
      }
    }
    const name = rawName.toLowerCase();
    out.push({ t: 'open', name, raw: rawName, attrs, selfClose });
    i = j;
    if (RAW_TEXT.has(name) && !selfClose) {
      // Content runs to the first matching end tag — "</div>" inside a script string is just text.
      const re = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
      re.lastIndex = i;
      const m = re.exec(src);
      const end = m ? m.index : n;
      out.push({ t: 'raw', v: src.slice(i, end), parent: name, attrs });
      i = end;
    }
  }
  return out;
}

const isConditionalComment = (c: string) => /^<!--\[if\s|^<!--\s*<!\[endif\]|^<!--\[endif\]|<!\[endif\]-->$/i.test(c) || c.startsWith('<!--!');

function attrValue(attrs: HAttr[], name: string): string | null {
  const a = attrs.find(x => x.name.toLowerCase() === name);
  return a ? (a.value ?? '') : null;
}

function serializeAttr(a: HAttr, o: HtmlMinifyOptions, isLastOfSelfClosing: boolean): string | null {
  const lname = a.name.toLowerCase();
  let v = a.value;
  if (v === null) return a.name;
  if (o.collapseBooleanAttributes && BOOLEAN_ATTRS.has(lname)) return a.name;
  if (o.removeEmptyAttributes && !v.trim() && (/^on/.test(lname) || ['class', 'id', 'style', 'title', 'lang', 'dir', 'action'].includes(lname))) return null;
  if (o.collapseWhitespace && lname === 'class') v = v.trim().replace(/\s+/g, ' ');
  if (o.minifyCss && lname === 'style' && v.trim() && !/&|\{\{|<%|\$\{/.test(v)) {
    try { v = minifyCss(`x{${v}}`).replace(/^x\{/, '').replace(/\}$/, ''); } catch { /* keep as-is */ }
  }
  if (o.collapseWhitespace && /^on/.test(lname)) v = v.trim();
  if (o.removeOptionalQuotes && v !== '' && /^[^ \t\n\f\r"'`=<>]+$/.test(v) && !(isLastOfSelfClosing && v.endsWith('/'))) {
    return `${a.name}=${v}`;
  }
  if (!v.includes('"')) return `${a.name}="${v}"`;
  if (!v.includes("'")) return `${a.name}='${v}'`;
  return `${a.name}="${v.replace(/"/g, '&#34;')}"`;
}

export async function minifyHtml(src: string, o: HtmlMinifyOptions): Promise<{ html: string; warnings: string[] }> {
  const warnings: string[] = [];
  let toks = tokenizeHtml(src);
  if (o.removeComments) toks = toks.filter(t => t.t !== 'comment' || isConditionalComment(t.v));
  // Merge text nodes that became adjacent after removing comments.
  const merged: HTok[] = [];
  for (const t of toks) {
    const last = merged[merged.length - 1];
    if (t.t === 'text' && last?.t === 'text') last.v += t.v; else merged.push(t.t === 'text' ? { ...t } : t);
  }
  toks = merged;

  // Inline scripts → Terser (batched into one worker), JSON scripts → JSON.stringify, styles → minifyCss.
  const jsJobs: { idx: number; module: boolean }[] = [];
  toks.forEach((t, idx) => {
    if (t.t !== 'raw' || !t.v.trim()) return;
    if (t.parent === 'script') {
      const type = (attrValue(t.attrs, 'type') ?? '').trim().toLowerCase().split(';')[0];
      if (o.minifyJs && JS_TYPES.has(type) && attrValue(t.attrs, 'src') === null) jsJobs.push({ idx, module: type === 'module' });
      else if ((o.minifyJs || o.collapseWhitespace) && JSON_TYPES.has(type)) {
        try { t.v = JSON.stringify(JSON.parse(t.v)).replace(/<\//g, '<\\/'); } catch { warnings.push(`A <script type="${type}"> block is not valid JSON and was left as-is.`); }
      }
    } else if (t.parent === 'style' && o.minifyCss) {
      const type = (attrValue(t.attrs, 'type') ?? '').trim().toLowerCase();
      if (!type || type === 'text/css') {
        try { t.v = minifyCss(t.v); } catch (e) { warnings.push(`Inline <style> left unminified: ${(e as Error).message}`); }
      }
    } else if (t.parent === 'title' && o.collapseWhitespace) {
      t.v = t.v.replace(/\s+/g, ' ').trim();
    }
  });
  if (jsJobs.length) {
    const results = await runTerser(jsJobs.map(j => {
      const raw = (toks[j.idx] as { v: string }).v;
      // Legacy <!-- … --> wrappers inside scripts are not valid module code; strip them.
      const code = raw.replace(/^\s*<!--.*\n?/, '').replace(/\n?\s*\/\/\s*-->\s*$/, '');
      return { code, options: { ...terserOptions({ module: j.module }), format: { comments: LICENSE_COMMENT, inline_script: true } } };
    }));
    results.forEach((r, k) => {
      const tok = toks[jsJobs[k].idx] as { v: string };
      if (r.error) warnings.push(`Inline script #${k + 1} left unminified: ${r.error.message}${r.error.line ? ` (line ${r.error.line}, col ${r.error.col})` : ''}`);
      else if (r.code !== undefined) tok.v = r.code;
    });
  }

  // Whitespace
  const isBlockTok = (t: HTok | undefined) => !t || ((t.t === 'open' || t.t === 'close') && BLOCK.has(t.name)) || t.t === 'decl';
  let pre = 0;
  const out: string[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    switch (t.t) {
      case 'text': {
        if (!o.collapseWhitespace || pre > 0) { out.push(t.v); break; }
        let v = t.v.replace(/[ \t\n\r\f]+/g, ' ');
        if (!o.conservativeCollapse) {
          // Look through kept comments for the real neighbours.
          let p = k - 1; while (p >= 0 && toks[p].t === 'comment') p--;
          let nx = k + 1; while (nx < toks.length && toks[nx].t === 'comment') nx++;
          if (v.startsWith(' ') && isBlockTok(toks[p])) v = v.slice(1);
          if (v.endsWith(' ') && isBlockTok(toks[nx])) v = v.slice(0, -1);
        }
        out.push(v);
        break;
      }
      case 'comment': case 'decl':
        out.push(t.t === 'decl' && o.collapseWhitespace && /^<!doctype/i.test(t.v) ? t.v.replace(/\s+/g, ' ') : t.v);
        break;
      case 'raw':
        out.push(t.v);
        break;
      case 'open': {
        if (t.name === 'pre' || t.name === 'textarea') pre++;
        let attrs = t.attrs;
        if (o.removeScriptTypes && t.name === 'script') attrs = attrs.filter(a => !(a.name.toLowerCase() === 'type' && ['text/javascript', 'application/javascript'].includes((a.value ?? '').trim().toLowerCase())));
        if (o.removeScriptTypes && (t.name === 'style' || t.name === 'link')) attrs = attrs.filter(a => !(a.name.toLowerCase() === 'type' && (a.value ?? '').trim().toLowerCase() === 'text/css'));
        const parts = attrs.map((a, idx) => serializeAttr(a, o, t.selfClose && idx === attrs.length - 1)).filter((x): x is string => x !== null);
        const sep = o.collapseWhitespace ? '' : ' ';
        out.push(`<${t.raw}${parts.length ? ' ' + parts.join(' ') : ''}${t.selfClose ? sep + '/>' : '>'}`);
        break;
      }
      case 'close':
        if ((t.name === 'pre' || t.name === 'textarea') && pre > 0) pre--;
        out.push(`</${t.raw}>`);
        break;
    }
  }
  let html = out.join('');
  if (o.collapseWhitespace) html = html.trim();
  return { html, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

export const routes: ToolRoute[] = [
  {
    method: 'POST',
    path: '/api/tools/dev/minify-js',
    handler: async ({ req, res }) => {
      const body = await readJson(req, JSON_LIMIT);
      const code = str(body.code, 'code', { max: MAX_SOURCE });
      const o = (body.options ?? {}) as JsOptions;
      const t0 = Date.now();
      const [r] = await runTerser([{ code, options: terserOptions(o, { sourceMap: !!o.sourceMap }) }]);
      if (r.error) {
        const { message, line, col } = r.error;
        sendJson(res, { error: line ? `${message} (line ${line}, column ${(col ?? 0) + 1})` : message, line, col: col !== undefined ? col + 1 : undefined }, 400);
        return;
      }
      const out = r.code ?? '';
      sendJson(res, { code: out, map: r.map, sizes: sizes(code, out), ms: Date.now() - t0 });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/dev/minify-html',
    handler: async ({ req, res }) => {
      const body = await readJson(req, JSON_LIMIT);
      const html = str(body.html, 'html', { max: MAX_SOURCE });
      const raw = (body.options ?? {}) as Record<string, unknown>;
      const o: HtmlMinifyOptions = {
        removeComments: bool(raw.removeComments, true),
        collapseWhitespace: bool(raw.collapseWhitespace, true),
        conservativeCollapse: bool(raw.conservativeCollapse, false),
        minifyJs: bool(raw.minifyJs, true),
        minifyCss: bool(raw.minifyCss, true),
        removeOptionalQuotes: bool(raw.removeOptionalQuotes, false),
        removeEmptyAttributes: bool(raw.removeEmptyAttributes, true),
        collapseBooleanAttributes: bool(raw.collapseBooleanAttributes, true),
        removeScriptTypes: bool(raw.removeScriptTypes, true),
      };
      const t0 = Date.now();
      const r = await minifyHtml(html, o);
      sendJson(res, { html: r.html, warnings: r.warnings, sizes: sizes(html, r.html), ms: Date.now() - t0 });
    },
  },
  {
    method: 'POST',
    path: '/api/tools/dev/minify-css',
    handler: async ({ req, res }) => {
      const body = await readJson(req, JSON_LIMIT);
      const css = str(body.css, 'css', { max: MAX_SOURCE });
      const t0 = Date.now();
      let out: string;
      try {
        out = minifyCss(css, { keepLicense: bool(body.options?.keepLicense, true) });
      } catch (e) {
        const se = e as SourceError;
        sendJson(res, { error: se.message, line: se.line, col: se.col }, 400);
        return;
      }
      sendJson(res, { css: out, sizes: sizes(css, out), ms: Date.now() - t0 });
    },
  },
];

export const converters: ConverterSpec[] = [];
