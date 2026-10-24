// Pure (React-free, DOM-free) logic for the Developer tools. Unit-tested by dev.test.ts.
// Keep this file free of `@/` imports so it runs under plain tsx/node.
import * as yaml from 'js-yaml';

// ═════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═════════════════════════════════════════════════════════════════════════════

export interface KV { key: string; value: string; enabled?: boolean }

export class SourceError extends Error {
  constructor(message: string, public line?: number, public col?: number) {
    super(line ? `${message} (line ${line}${col ? `, column ${col}` : ''})` : message);
  }
}

/** 1-based line/column of an offset in `src`. */
export function lineCol(src: string, pos: number): { line: number; col: number } {
  const before = src.slice(0, Math.max(0, pos));
  const line = before.split('\n').length;
  return { line, col: before.length - before.lastIndexOf('\n') };
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;
export { utf8Len };

// ═════════════════════════════════════════════════════════════════════════════
// XML tokenizer / tree (shared by the XML formatter and SVG → JSX)
// ═════════════════════════════════════════════════════════════════════════════

export interface XmlAttr { name: string; value: string; quote: '"' | "'" | '' }
export type XmlNode =
  | { type: 'element'; name: string; attrs: XmlAttr[]; children: XmlNode[]; selfClosing: boolean }
  | { type: 'text'; value: string }
  | { type: 'comment'; value: string }
  | { type: 'cdata'; value: string }
  | { type: 'pi'; value: string }
  | { type: 'doctype'; value: string };
export type XmlElement = Extract<XmlNode, { type: 'element' }>;

const NAME_START = /[A-Za-z_:\u00C0-\uFFFF]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-\u00B7\u00C0-\uFFFF]/;

/** Parse XML into a list of top-level nodes. Throws SourceError with line/column on malformed input. */
export function parseXml(src: string): XmlNode[] {
  let i = 0;
  const root: XmlNode[] = [];
  const stack: { el: XmlElement; pos: number }[] = [];
  const err = (msg: string, pos = i): never => {
    const { line, col } = lineCol(src, pos);
    throw new SourceError(msg, line, col);
  };
  const push = (n: XmlNode) => (stack.length ? stack[stack.length - 1].el.children : root).push(n);
  const readUntil = (end: string, what: string) => {
    const j = src.indexOf(end, i);
    if (j < 0) err(`Unterminated ${what}`);
    const v = src.slice(i, j);
    i = j + end.length;
    return v;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0 || lt > i) {
      const text = src.slice(i, lt < 0 ? src.length : lt);
      if (!stack.length && text.trim()) err('Text outside of the root element', i + text.search(/\S/));
      push({ type: 'text', value: text });
      i = lt < 0 ? src.length : lt;
      continue;
    }
    const start = i;
    if (src.startsWith('<!--', i)) { i += 4; push({ type: 'comment', value: readUntil('-->', 'comment') }); continue; }
    if (src.startsWith('<![CDATA[', i)) { i += 9; push({ type: 'cdata', value: readUntil(']]>', 'CDATA section') }); continue; }
    if (src.startsWith('<?', i)) { i += 2; push({ type: 'pi', value: readUntil('?>', 'processing instruction') }); continue; }
    if (/^<!DOCTYPE/i.test(src.slice(i, i + 9))) {
      // DOCTYPE may contain an internal subset in [...]
      let depth = 0; let j = i + 9;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= src.length) err('Unterminated DOCTYPE');
      push({ type: 'doctype', value: src.slice(i + 2, j) });
      i = j + 1;
      continue;
    }
    if (src[i + 1] === '/') {
      i += 2;
      const nameStart = i;
      while (i < src.length && NAME_CHAR.test(src[i])) i++;
      const name = src.slice(nameStart, i);
      while (/\s/.test(src[i] ?? '')) i++;
      if (src[i] !== '>') err(`Malformed closing tag </${name}`);
      i++;
      const open = stack.pop();
      if (!open) err(`Unexpected closing tag </${name}>`, start);
      if (open!.el.name !== name) {
        const p = lineCol(src, open!.pos);
        err(`Closing tag </${name}> does not match <${open!.el.name}> opened on line ${p.line}`, start);
      }
      continue;
    }
    // start tag
    i++;
    if (!NAME_START.test(src[i] ?? '')) err('Invalid tag name (a literal "<" must be escaped as &lt;)');
    const nameStart = i;
    while (i < src.length && NAME_CHAR.test(src[i])) i++;
    const el: XmlElement = { type: 'element', name: src.slice(nameStart, i), attrs: [], children: [], selfClosing: false };
    const seen = new Set<string>();
    for (;;) {
      const ws = i;
      while (/\s/.test(src[i] ?? '')) i++;
      if (i >= src.length) err(`Unterminated tag <${el.name}`, start);
      if (src[i] === '>') { i++; break; }
      if (src[i] === '/' && src[i + 1] === '>') { i += 2; el.selfClosing = true; break; }
      if (ws === i) err(`Expected whitespace before attribute in <${el.name}>`);
      if (!NAME_START.test(src[i])) err(`Invalid character "${src[i]}" in <${el.name}>`);
      const an = i;
      while (i < src.length && NAME_CHAR.test(src[i])) i++;
      const name = src.slice(an, i);
      while (/\s/.test(src[i] ?? '')) i++;
      if (src[i] !== '=') err(`Attribute "${name}" has no value`);
      i++;
      while (/\s/.test(src[i] ?? '')) i++;
      const q = src[i];
      if (q !== '"' && q !== "'") err(`Attribute "${name}" value must be quoted`);
      i++;
      const end = src.indexOf(q, i);
      if (end < 0) err(`Unterminated attribute value for "${name}"`);
      const value = src.slice(i, end);
      if (value.includes('<')) err(`"<" is not allowed in attribute values ("${name}")`);
      i = end + 1;
      if (seen.has(name)) err(`Duplicate attribute "${name}"`, an);
      seen.add(name);
      el.attrs.push({ name, value, quote: q as '"' | "'" });
    }
    if (!stack.length && root.some(n => n.type === 'element')) err('Only one root element is allowed', start);
    push(el);
    if (!el.selfClosing) stack.push({ el, pos: start });
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    const p = lineCol(src, open.pos);
    throw new SourceError(`Unclosed element <${open.el.name}>`, p.line, p.col);
  }
  if (!root.some(n => n.type === 'element')) throw new SourceError('No root element found');
  return root;
}

export interface XmlFormatOptions {
  indent: string;            // '  ', '    ', '\t'
  attrsPerLine?: boolean;    // one attribute per line when an element has more than one
  collapseEmpty?: boolean;   // <a></a> → <a/>
  removeComments?: boolean;
}

function attrsToString(attrs: XmlAttr[]) {
  return attrs.map(a => `${a.name}=${a.quote === "'" ? `'${a.value}'` : `"${a.value}"`}`);
}

function serializeInline(n: XmlNode): string {
  switch (n.type) {
    case 'text': return n.value;
    case 'comment': return `<!--${n.value}-->`;
    case 'cdata': return `<![CDATA[${n.value}]]>`;
    case 'pi': return `<?${n.value}?>`;
    case 'doctype': return `<!${n.value}>`;
    case 'element': {
      const a = n.attrs.length ? ' ' + attrsToString(n.attrs).join(' ') : '';
      if (!n.children.length && n.selfClosing) return `<${n.name}${a}/>`;
      return `<${n.name}${a}>${n.children.map(serializeInline).join('')}</${n.name}>`;
    }
  }
}

export function formatXml(src: string, opts: XmlFormatOptions): string {
  const nodes = parseXml(src);
  const out: string[] = [];
  const pad = (d: number) => opts.indent.repeat(d);

  const openTag = (el: XmlElement, d: number, close: string) => {
    const attrs = attrsToString(el.attrs);
    if (opts.attrsPerLine && attrs.length > 1) {
      return `<${el.name}\n${attrs.map(a => pad(d + 1) + a).join('\n')}${close === '/>' ? '\n' + pad(d) + '/>' : '>'}`;
    }
    return `<${el.name}${attrs.length ? ' ' + attrs.join(' ') : ''}${close}`;
  };

  const walk = (n: XmlNode, d: number, preserve: boolean) => {
    if (n.type === 'text') {
      const t = n.value.trim();
      if (t) out.push(pad(d) + t);
      return;
    }
    if (n.type === 'comment') { if (!opts.removeComments) out.push(pad(d) + `<!--${n.value}-->`); return; }
    if (n.type !== 'element') { out.push(pad(d) + serializeInline(n)); return; }
    const keep = preserve || n.attrs.some(a => a.name === 'xml:space' && a.value === 'preserve');
    const kids = opts.removeComments ? n.children.filter(c => c.type !== 'comment') : n.children;
    const meaningful = kids.filter(c => !(c.type === 'text' && !c.value.trim()));
    if (!meaningful.length) {
      out.push(pad(d) + (opts.collapseEmpty || n.selfClosing ? openTag(n, d, '/>') : openTag(n, d, '>') + `</${n.name}>`));
      return;
    }
    const mixed = meaningful.some(c => c.type === 'text' || c.type === 'cdata');
    if (keep || mixed) {
      // Mixed content / xml:space="preserve": whitespace is significant, keep the subtree inline.
      const inner = keep ? kids.map(serializeInline).join('') : (() => {
        const s = kids.map(serializeInline).join('');
        return meaningful.length === 1 && meaningful[0].type === 'text' ? s.trim() : s;
      })();
      out.push(pad(d) + openTag(n, d, '>') + inner + `</${n.name}>`);
      return;
    }
    out.push(pad(d) + openTag(n, d, '>'));
    for (const c of meaningful) walk(c, d + 1, keep);
    out.push(pad(d) + `</${n.name}>`);
  };
  for (const n of nodes) walk(n, 0, false);
  return out.join('\n');
}

export function minifyXml(src: string, { removeComments = true } = {}): string {
  const nodes = parseXml(src);
  const ser = (n: XmlNode, preserve: boolean): string => {
    if (n.type === 'text') return preserve ? n.value : n.value.trim() ? n.value.replace(/\s+/g, ' ') : '';
    if (n.type === 'comment') return removeComments ? '' : `<!--${n.value}-->`;
    if (n.type !== 'element') return serializeInline(n);
    const keep = preserve || n.attrs.some(a => a.name === 'xml:space' && a.value === 'preserve');
    const a = n.attrs.length ? ' ' + attrsToString(n.attrs).join(' ') : '';
    const inner = n.children.map(c => ser(c, keep)).join('');
    return inner ? `<${n.name}${a}>${inner}</${n.name}>` : `<${n.name}${a}/>`;
  };
  return nodes.map(n => ser(n, false)).join('');
}

/** Count elements / attributes / depth for stats. */
export function xmlStats(nodes: XmlNode[]) {
  let elements = 0; let attributes = 0; let maxDepth = 0;
  const walk = (n: XmlNode, d: number) => {
    if (n.type !== 'element') return;
    elements++; attributes += n.attrs.length; maxDepth = Math.max(maxDepth, d);
    n.children.forEach(c => walk(c, d + 1));
  };
  nodes.forEach(n => walk(n, 1));
  return { elements, attributes, maxDepth };
}

// ═════════════════════════════════════════════════════════════════════════════
// CSS parser / printer / minifier
// ═════════════════════════════════════════════════════════════════════════════

export type CssNode =
  | { type: 'rule'; prelude: string; children: CssNode[] }
  | { type: 'decl'; prop: string; value: string }
  | { type: 'at'; text: string }
  | { type: 'comment'; text: string };

/** Parse CSS (incl. nesting) into a tree. Comments between statements are kept; comments inside values are dropped. */
export function parseCss(src: string): CssNode[] {
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
export function minifyCssValue(v: string): string {
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
export function minifyCssPrelude(p: string): string {
  const at = p.trim().startsWith('@');
  return mapOutsideStrings(p.trim(), s => {
    const r = collapse(s).replace(/\s*,\s*/g, ',').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
    if (at) return colonInParens(r, ':');
    // Careful: "a :hover" ≠ "a:hover", so we never remove a space *before* ":".
    return r.replace(/\s*([>~+])\s*/g, '$1');
  });
}

export function minifyCss(src: string, { keepLicense = true } = {}): string {
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

/** Split on commas that are not inside parens/brackets/strings. */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0; let quote = ''; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; continue; } if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const stripPrefix = (p: string) => p.replace(/^-(webkit|moz|ms|o)-/, '');

export interface CssFormatOptions { indent: string; sortProperties?: boolean; selectorPerLine?: boolean; removeComments?: boolean }

export function beautifyCss(src: string, opts: CssFormatOptions): string {
  const nodes = parseCss(src);
  const pad = (d: number) => opts.indent.repeat(d);
  const fmtValue = (v: string) => mapOutsideStrings(v.trim(), s => collapse(s).replace(/\s*,\s*/g, ', ').replace(/\s*!\s*important/gi, ' !important'));
  const fmtPrelude = (p: string, d: number) => {
    const c = p.trim();
    if (c.startsWith('@')) return mapOutsideStrings(c, s => colonInParens(collapse(s).replace(/\(\s*/g, '(').replace(/\s*\)/g, ')'), ': '));
    const sels = splitTopLevel(c).map(x => mapOutsideStrings(x.trim(), s => collapse(s).replace(/\s*([>~+])\s*(?![^(]*\))/g, ' $1 ')));
    return sels.join(opts.selectorPerLine !== false ? ',\n' + pad(d) : ', ');
  };
  const sortDecls = (list: CssNode[]) => {
    if (!opts.sortProperties) return list;
    const out: CssNode[] = [];
    // Sort each run of declarations separately so nested rules / comments keep their positions.
    let run: Extract<CssNode, { type: 'decl' }>[] = [];
    const flush = () => {
      const custom = run.filter(d => d.prop.startsWith('--'));
      const rest = run.filter(d => !d.prop.startsWith('--')).sort((a, b) => {
        const x = stripPrefix(a.prop.toLowerCase()); const y = stripPrefix(b.prop.toLowerCase());
        if (x !== y) return x < y ? -1 : 1;
        // vendor-prefixed versions before the standard one
        return (b.prop.startsWith('-') ? 1 : 0) - (a.prop.startsWith('-') ? 1 : 0);
      });
      out.push(...custom, ...rest);
      run = [];
    };
    for (const n of list) { if (n.type === 'decl') run.push(n); else { flush(); out.push(n); } }
    flush();
    return out;
  };
  const lines: string[] = [];
  const walk = (list: CssNode[], d: number) => {
    let prev: CssNode['type'] | null = null;
    for (const n of sortDecls(list)) {
      if (n.type === 'comment') {
        if (opts.removeComments) continue;
        if (prev === 'rule' && d === 0) lines.push('');
        lines.push(pad(d) + `/*${n.text}*/`);
      } else if (n.type === 'decl') {
        lines.push(pad(d) + `${n.prop.trim()}: ${n.prop.startsWith('--') ? n.value.trim() : fmtValue(n.value)};`);
      } else if (n.type === 'at') {
        if (prev === 'rule') lines.push('');
        lines.push(pad(d) + fmtPrelude(n.text, d) + ';');
      } else {
        if (prev && prev !== 'comment') lines.push('');
        lines.push(pad(d) + fmtPrelude(n.prelude, d) + ' {');
        walk(n.children, d + 1);
        lines.push(pad(d) + '}');
      }
      prev = n.type;
    }
  };
  walk(nodes, 0);
  return lines.join('\n');
}

export function cssStats(src: string) {
  const nodes = parseCss(src);
  let rules = 0; let selectors = 0; let declarations = 0; let important = 0; let atRules = 0; let media = 0;
  const colors = new Set<string>();
  const props = new Map<string, number>();
  const walk = (list: CssNode[]) => {
    for (const n of list) {
      if (n.type === 'rule') {
        if (n.prelude.startsWith('@')) { atRules++; if (/^@media/i.test(n.prelude)) media++; } else { rules++; selectors += splitTopLevel(n.prelude).length; }
        walk(n.children);
      } else if (n.type === 'at') atRules++;
      else if (n.type === 'decl') {
        declarations++;
        if (/!\s*important/i.test(n.value)) important++;
        props.set(n.prop.toLowerCase(), (props.get(n.prop.toLowerCase()) ?? 0) + 1);
        for (const m of n.value.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\([^)]*\)/gi)) colors.add(m[0].toLowerCase().replace(/\s+/g, ''));
      }
    }
  };
  walk(nodes);
  const topProps = [...props.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { rules, selectors, declarations, important, atRules, media, colors: [...colors], topProps };
}

// ═════════════════════════════════════════════════════════════════════════════
// HTML entities
// ═════════════════════════════════════════════════════════════════════════════

// HTML 4 named entities (the set every browser and email client understands).
const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
const GREEK_UP = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho _ Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ');
const GREEK_LO = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega'.split(' ');
const OTHER_ENTITIES: [string, number][] = [
  ['quot', 34], ['amp', 38], ['apos', 39], ['lt', 60], ['gt', 62],
  ['OElig', 338], ['oelig', 339], ['Scaron', 352], ['scaron', 353], ['Yuml', 376], ['fnof', 402], ['circ', 710], ['tilde', 732],
  ['thetasym', 977], ['upsih', 978], ['piv', 982],
  ['ensp', 8194], ['emsp', 8195], ['thinsp', 8201], ['zwnj', 8204], ['zwj', 8205], ['lrm', 8206], ['rlm', 8207],
  ['ndash', 8211], ['mdash', 8212], ['lsquo', 8216], ['rsquo', 8217], ['sbquo', 8218], ['ldquo', 8220], ['rdquo', 8221], ['bdquo', 8222],
  ['dagger', 8224], ['Dagger', 8225], ['bull', 8226], ['hellip', 8230], ['permil', 8240], ['prime', 8242], ['Prime', 8243],
  ['lsaquo', 8249], ['rsaquo', 8250], ['oline', 8254], ['frasl', 8260], ['euro', 8364], ['image', 8465], ['weierp', 8472], ['real', 8476],
  ['trade', 8482], ['alefsym', 8501], ['larr', 8592], ['uarr', 8593], ['rarr', 8594], ['darr', 8595], ['harr', 8596], ['crarr', 8629],
  ['lArr', 8656], ['uArr', 8657], ['rArr', 8658], ['dArr', 8659], ['hArr', 8660], ['forall', 8704], ['part', 8706], ['exist', 8707],
  ['empty', 8709], ['nabla', 8711], ['isin', 8712], ['notin', 8713], ['ni', 8715], ['prod', 8719], ['sum', 8721], ['minus', 8722],
  ['lowast', 8727], ['radic', 8730], ['prop', 8733], ['infin', 8734], ['ang', 8736], ['and', 8743], ['or', 8744], ['cap', 8745],
  ['cup', 8746], ['int', 8747], ['there4', 8756], ['sim', 8764], ['cong', 8773], ['asymp', 8776], ['ne', 8800], ['equiv', 8801],
  ['le', 8804], ['ge', 8805], ['sub', 8834], ['sup', 8835], ['nsub', 8836], ['sube', 8838], ['supe', 8839], ['oplus', 8853],
  ['otimes', 8855], ['perp', 8869], ['sdot', 8901], ['lceil', 8968], ['rceil', 8969], ['lfloor', 8970], ['rfloor', 8971],
  ['lang', 9001], ['rang', 9002], ['loz', 9674], ['spades', 9824], ['clubs', 9827], ['hearts', 9829], ['diams', 9830],
];
export const NAMED_ENTITIES: Map<number, string> = (() => {
  const m = new Map<number, string>();
  LATIN1.forEach((n, i) => m.set(160 + i, n));
  GREEK_UP.forEach((n, i) => { if (n !== '_') m.set(913 + i, n); });
  GREEK_LO.forEach((n, i) => m.set(945 + i, n));
  OTHER_ENTITIES.forEach(([n, c]) => m.set(c, n));
  return m;
})();
const ENTITY_TO_CHAR = new Map([...NAMED_ENTITIES].map(([c, n]) => [n, String.fromCodePoint(c)]));

export type EntityMode = 'minimal' | 'named' | 'numeric';

/**
 * minimal: only & < > " '  ·  named: minimal + named entities where one exists, numeric for the rest of non-ASCII
 * numeric: minimal + every non-ASCII code point as a numeric reference.
 */
export function encodeEntities(s: string, mode: EntityMode, { hex = true, quotes = true } = {}): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"' && quotes) out += '&quot;';
    else if (ch === "'" && quotes) out += '&#39;';
    else if (cp < 128 || mode === 'minimal') out += ch;
    else if (mode === 'named' && NAMED_ENTITIES.has(cp)) out += `&${NAMED_ENTITIES.get(cp)};`;
    else out += hex ? `&#x${cp.toString(16).toUpperCase()};` : `&#${cp};`;
  }
  return out;
}

/** Decode numeric + HTML4 named entities (the dashboard uses the browser parser for the full HTML5 set). */
export function decodeEntitiesBasic(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITY_TO_CHAR.get(body) ?? m;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// JSON ⇄ YAML
// ═════════════════════════════════════════════════════════════════════════════

export interface YamlResult { output: string; error?: string; line?: number; col?: number; docs?: number }

export function yamlToJson(src: string, { indent = 2, multi = 'auto' as 'auto' | 'array' | 'first' } = {}): YamlResult {
  try {
    const docs = yaml.loadAll(src);
    const space = indent === 0 ? undefined : indent < 0 ? '\t' : indent;
    if (docs.length === 0) return { output: '', docs: 0 };
    const value = docs.length === 1 || multi === 'first' ? docs[0] : docs;
    return { output: JSON.stringify(value, null, space) ?? 'null', docs: docs.length };
  } catch (e) {
    const ex = e as { reason?: string; mark?: { line: number; column: number }; message: string };
    if (ex.mark) return { output: '', error: ex.reason || ex.message, line: ex.mark.line + 1, col: ex.mark.column + 1 };
    return { output: '', error: ex.message };
  }
}

export function jsonToYaml(src: string, { indent = 2, multiDoc = false, sortKeys = false, quoteStyle = 'single' as 'single' | 'double', flowLevel = -1 } = {}): YamlResult {
  let value: unknown;
  try {
    value = JSON.parse(src);
  } catch (e) {
    const msg = (e as Error).message;
    const pos = /position (\d+)/.exec(msg);
    if (pos) { const p = lineCol(src, Number(pos[1])); return { output: '', error: msg, line: p.line, col: p.col }; }
    const lc = /line (\d+) column (\d+)/.exec(msg);
    return { output: '', error: msg, line: lc ? Number(lc[1]) : undefined, col: lc ? Number(lc[2]) : undefined };
  }
  const opts = { indent, sortKeys, quoteStyle, flowLevel, lineWidth: -1, noRefs: true };
  if (multiDoc && Array.isArray(value)) {
    return { output: value.map(v => '---\n' + yaml.dump(v, opts)).join(''), docs: value.length };
  }
  return { output: yaml.dump(value, opts), docs: 1 };
}

// ═════════════════════════════════════════════════════════════════════════════
// SQL sanitizing / parameterizing
// ═════════════════════════════════════════════════════════════════════════════

export type SqlTok = { t: 'str' | 'ident' | 'comment' | 'ws' | 'word' | 'num' | 'param' | 'op'; v: string };

/** Lightweight SQL lexer: strings ('' escapes, E'' backslash), quoted identifiers, comments, $tag$ quoting. */
export function tokenizeSql(sql: string, { hashComments = false } = {}): SqlTok[] {
  const out: SqlTok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const s = i;
    if (c === '-' && sql[i + 1] === '-' || hashComments && c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out.push({ t: 'comment', v: sql.slice(s, i) });
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? sql.length : e + 2;
      out.push({ t: 'comment', v: sql.slice(s, i) });
    } else if (c === "'" || ((c === 'E' || c === 'e' || c === 'N' || c === 'n') && sql[i + 1] === "'" && !/[\w$]/.test(sql[i - 1] ?? ''))) {
      const backslash = c === 'E' || c === 'e';
      if (c !== "'") i++;
      i++;
      while (i < sql.length) {
        if (backslash && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      out.push({ t: 'str', v: sql.slice(s, i) });
    } else if (c === '"' || c === '`') {
      i++;
      while (i < sql.length) { if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } i++; break; } i++; }
      out.push({ t: 'ident', v: sql.slice(s, i) });
    } else if (c === '[') {
      const e = sql.indexOf(']', i);
      i = e < 0 ? sql.length : e + 1;
      out.push({ t: 'ident', v: sql.slice(s, i) });
    } else if (c === '$' && /^\$([A-Za-z_]\w*)?\$/.test(sql.slice(i))) {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))![0];
      const e = sql.indexOf(tag, i + tag.length);
      i = e < 0 ? sql.length : e + tag.length;
      out.push({ t: 'str', v: sql.slice(s, i) });
    } else if (/\s/.test(c)) {
      while (i < sql.length && /\s/.test(sql[i])) i++;
      out.push({ t: 'ws', v: sql.slice(s, i) });
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      if (c === '0' && /[xX]/.test(sql[i + 1] ?? '')) { i += 2; while (/[0-9a-fA-F]/.test(sql[i] ?? '')) i++; }
      else {
        while (/[0-9]/.test(sql[i] ?? '')) i++;
        if (sql[i] === '.') { i++; while (/[0-9]/.test(sql[i] ?? '')) i++; }
        if (/[eE]/.test(sql[i] ?? '') && /[-+0-9]/.test(sql[i + 1] ?? '')) { i += 2; while (/[0-9]/.test(sql[i] ?? '')) i++; }
      }
      out.push({ t: 'num', v: sql.slice(s, i) });
    } else if (/[A-Za-z_\u0080-\uFFFF]/.test(c)) {
      while (i < sql.length && /[\w$\u0080-\uFFFF]/.test(sql[i])) i++;
      out.push({ t: 'word', v: sql.slice(s, i) });
    } else if ((c === '?' ) || ((c === ':' || c === '@' || c === '$') && /[A-Za-z0-9_]/.test(sql[i + 1] ?? '') && sql[i - 1] !== ':')) {
      i++;
      while (/[\w]/.test(sql[i] ?? '')) i++;
      out.push({ t: 'param', v: sql.slice(s, i) });
    } else {
      i++;
      out.push({ t: 'op', v: c });
    }
  }
  return out;
}

export interface SqlSanitizeOptions {
  stripComments?: boolean;
  collapseWhitespace?: boolean;
  smartQuotes?: boolean;               // ’ ‘ “ ” → ' "
  identifierQuotes?: 'keep' | 'ansi' | 'mysql' | 'tsql';
  hashComments?: boolean;
}

function unquoteIdent(v: string): string {
  if (v[0] === '[') return v.slice(1, -1);
  const q = v[0];
  return v.slice(1, -1).split(q + q).join(q);
}

export function sanitizeSql(sql: string, o: SqlSanitizeOptions): string {
  if (o.smartQuotes) sql = sql.replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u201F\u2033]/g, '"');
  let toks = tokenizeSql(sql, { hashComments: o.hashComments });
  if (o.stripComments) {
    // Keep a space where a comment separated two tokens.
    toks = toks.map(t => (t.t === 'comment' ? { t: 'ws', v: t.v.startsWith('--') || t.v.startsWith('#') ? '\n' : ' ' } : t));
  }
  if (o.identifierQuotes && o.identifierQuotes !== 'keep') {
    toks = toks.map(t => {
      if (t.t !== 'ident') return t;
      const name = unquoteIdent(t.v);
      if (o.identifierQuotes === 'ansi') return { t: 'ident', v: `"${name.replace(/"/g, '""')}"` };
      if (o.identifierQuotes === 'mysql') return { t: 'ident', v: '`' + name.replace(/`/g, '``') + '`' };
      return { t: 'ident', v: `[${name.replace(/]/g, ']]')}]` };
    });
  }
  const out = toks.map(t => t.v).join('');
  return o.collapseWhitespace ? collapseSqlWhitespace(out, o.hashComments && !o.stripComments) : out;
}

function collapseSqlWhitespace(sql: string, hashComments?: boolean): string {
  const toks = tokenizeSql(sql, { hashComments });
  let out = '';
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'ws') {
      const prev = toks[k - 1]; const next = toks[k + 1];
      if (!prev || !next) continue;
      if (prev.t === 'comment' && (prev.v.startsWith('--') || prev.v.startsWith('#'))) { out += '\n'; continue; }
      if (prev.v === '(' || next.v === ')' || next.v === ',' || next.v === ';' || prev.v === '.' || next.v === '.') continue;
      out += ' ';
    } else if (t.t === 'comment' && (t.v.startsWith('--') || t.v.startsWith('#'))) {
      out += t.v; // a line comment must stay terminated by a newline
      if (k + 1 < toks.length && toks[k + 1].t !== 'ws') out += '\n';
    } else out += t.v;
  }
  return out.trim();
}

export type ParamStyle = '?' | '$n' | ':name' | '@name' | '%s';

/** Replace string and numeric literals with placeholders. Returns the new SQL and the extracted values. */
export function parameterizeSql(sql: string, style: ParamStyle, { numbers = true, hashComments = false } = {}): { sql: string; params: (string | number)[] } {
  const toks = tokenizeSql(sql, { hashComments });
  const params: (string | number)[] = [];
  const ph = () => {
    const n = params.length;
    return style === '?' ? '?' : style === '$n' ? `$${n}` : style === '%s' ? '%s' : style === ':name' ? `:p${n}` : `@p${n}`;
  };
  let out = '';
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'str') {
      let v = t.v;
      if (v.startsWith('$')) { const tag = /^\$[^$]*\$/.exec(v)![0]; v = v.slice(tag.length, -tag.length); }
      else {
        const backslash = /^[Ee]'/.test(v);
        if (/^[EeNn]'/.test(v)) v = v.slice(1);
        v = v.slice(1, -1).replace(/''/g, "'");
        if (backslash) v = v.replace(/\\(.)/g, '$1');
      }
      params.push(v);
      out += ph();
      continue;
    }
    if (t.t === 'num' && numbers) {
      // Skip numbers that are part of an identifier-ish expression like t1.col or a column position after ORDER BY/GROUP BY/LIMIT? Keep LIMIT/ORDER as params too — they are literals.
      const prevSig = [...toks.slice(0, k)].reverse().find(x => x.t !== 'ws');
      if (prevSig && prevSig.t === 'op' && prevSig.v === '-' ) {
        const before = [...toks.slice(0, toks.indexOf(prevSig))].reverse().find(x => x.t !== 'ws');
        // unary minus: fold into the literal
        if (!before || (before.t === 'op' && before.v !== ')') || (before.t === 'word' && /^(select|where|and|or|by|values|in|set|then|else|when|return|limit|offset|not|is|between)$/i.test(before.v))) {
          out = out.replace(/-\s*$/, '');
          params.push(-Number(t.v));
          out += ph();
          continue;
        }
      }
      params.push(Number(t.v));
      out += ph();
      continue;
    }
    out += t.v;
  }
  return { sql: out, params };
}

// ═════════════════════════════════════════════════════════════════════════════
// HTTP request model → cURL / fetch / axios / requests / HTTPie / Go, and cURL import
// ═════════════════════════════════════════════════════════════════════════════

export type BodyType = 'none' | 'json' | 'form' | 'multipart' | 'raw';
export type AuthType = 'none' | 'basic' | 'bearer' | 'apikey';
export interface MultipartField { key: string; value: string; isFile?: boolean; enabled?: boolean }

export interface HttpRequestModel {
  method: string;
  url: string;
  query: KV[];
  headers: KV[];
  bodyType: BodyType;
  body: string;
  form: KV[];
  multipart: MultipartField[];
  auth: { type: AuthType; user: string; pass: string; token: string; keyName: string; keyValue: string };
  flags: { location: boolean; insecure: boolean; verbose: boolean; compressed: boolean; include: boolean; silent: boolean };
  timeout: number; // seconds, 0 = none
}

export const emptyRequest = (): HttpRequestModel => ({
  method: 'GET', url: '', query: [], headers: [], bodyType: 'none', body: '', form: [], multipart: [],
  auth: { type: 'none', user: '', pass: '', token: '', keyName: 'X-API-Key', keyValue: '' },
  flags: { location: false, insecure: false, verbose: false, compressed: false, include: false, silent: false },
  timeout: 0,
});

const on = <T extends { enabled?: boolean; key: string }>(l: T[]) => l.filter(x => x.enabled !== false && x.key.trim());

export function fullUrl(m: HttpRequestModel): string {
  const q = on(m.query).map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
  if (!q) return m.url;
  const [base, hash] = m.url.split('#');
  return base + (base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?') + q + (hash !== undefined ? '#' + hash : '');
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

const hasHeader = (h: [string, string][], name: string) => h.some(([k]) => k.toLowerCase() === name.toLowerCase());

/** Headers as sent (user headers + auth + implied content-type). `basicAsHeader` false keeps basic auth separate. */
export function effectiveHeaders(m: HttpRequestModel, { basicAsHeader = true, contentType = true } = {}): [string, string][] {
  const h: [string, string][] = on(m.headers).map(x => [x.key.trim(), x.value]);
  const a = m.auth;
  if (a.type === 'bearer' && a.token && !hasHeader(h, 'authorization')) h.push(['Authorization', `Bearer ${a.token}`]);
  if (a.type === 'basic' && basicAsHeader && (a.user || a.pass) && !hasHeader(h, 'authorization')) h.push(['Authorization', `Basic ${b64(`${a.user}:${a.pass}`)}`]);
  if (a.type === 'apikey' && a.keyName && !hasHeader(h, a.keyName)) h.push([a.keyName, a.keyValue]);
  if (contentType && !hasHeader(h, 'content-type')) {
    if (m.bodyType === 'json') h.push(['Content-Type', 'application/json']);
    if (m.bodyType === 'form') h.push(['Content-Type', 'application/x-www-form-urlencoded']);
  }
  return h;
}


export function formBody(m: HttpRequestModel) {
  return on(m.form).map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
}

export type Shell = 'bash' | 'powershell' | 'cmd';

export function shellQuote(s: string, shell: Shell): string {
  if (shell === 'bash') return /^[A-Za-z0-9_\-.,:/@%+=]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
  if (shell === 'powershell') return /^[A-Za-z0-9_\-.,:/%+=]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
  // cmd.exe: double quotes; inner quotes as \" for curl.exe's argv parser; % doubled is only needed in .bat files
  return /^[A-Za-z0-9_\-.,:/@+=]+$/.test(s) ? s : `"${s.replace(/\\(?=\\*")/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function toCurl(m: HttpRequestModel, shell: Shell = 'bash', { multiline = true } = {}): string {
  const q = (s: string) => shellQuote(s, shell);
  const args: string[] = [];
  const f = m.flags;
  const shortFlags = [f.location && 'L', f.insecure && 'k', f.verbose && 'v', f.include && 'i', f.silent && 's'].filter(Boolean).join('');
  const implicitMethod = m.bodyType === 'none' ? 'GET' : 'POST';
  if (m.method !== implicitMethod) args.push(`-X ${m.method}`);
  args.push(q(fullUrl(m)));
  if (shortFlags) args.splice(m.method !== implicitMethod ? 1 : 0, 0, `-${shortFlags}`);
  for (const [k, v] of effectiveHeaders(m, { basicAsHeader: false, contentType: m.bodyType === 'json' })) args.push(`-H ${q(`${k}: ${v}`)}`);
  if (m.auth.type === 'basic' && (m.auth.user || m.auth.pass)) args.push(`-u ${q(`${m.auth.user}:${m.auth.pass}`)}`);
  if (m.bodyType === 'json' || m.bodyType === 'raw') args.push(`--data-raw ${q(m.body)}`);
  if (m.bodyType === 'form') for (const p of on(m.form)) args.push(`--data-urlencode ${q(`${p.key}=${p.value}`)}`);
  if (m.bodyType === 'multipart') for (const p of on(m.multipart)) args.push(`-F ${q(`${p.key}=${p.isFile ? '@' : ''}${p.value}`)}`);
  if (f.compressed) args.push('--compressed');
  if (m.timeout > 0) args.push(`--max-time ${m.timeout}`);
  const exe = shell === 'bash' ? 'curl' : 'curl.exe';
  if (!multiline) return [exe, ...args].join(' ');
  const cont = shell === 'bash' ? ' \\\n  ' : shell === 'powershell' ? ' `\n  ' : ' ^\n  ';
  // Keep the first couple of args on the first line, then one option per line.
  const [first, ...rest] = args;
  return `${exe} ${first}` + (rest.length ? cont + rest.join(cont) : '');
}

const jsStr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
function jsObj(entries: [string, string][], indent: string): string {
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${indent}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : jsStr(k)}: ${jsStr(v)},`).join('\n')}\n${indent}}`;
}
function tryJson(s: string): unknown | undefined { try { return JSON.parse(s); } catch { return undefined; } }
function indentLines(s: string, pad: string) { return s.split('\n').map((l, i) => (i ? pad + l : l)).join('\n'); }

export function toFetch(m: HttpRequestModel): string {
  const lines: string[] = [];
  const h = effectiveHeaders(m, { contentType: m.bodyType !== 'multipart' });
  const opts: string[] = [`  method: ${jsStr(m.method)},`];
  if (h.length) opts.push(`  headers: ${jsObj(h, '  ')},`);
  if (m.bodyType === 'json') {
    const v = tryJson(m.body);
    opts.push(v !== undefined ? `  body: JSON.stringify(${indentLines(JSON.stringify(v, null, 2), '  ')}),` : `  body: ${jsStr(m.body)},`);
  } else if (m.bodyType === 'raw') opts.push(`  body: ${jsStr(m.body)},`);
  else if (m.bodyType === 'form') opts.push(`  body: new URLSearchParams(${jsObj(on(m.form).map(p => [p.key, p.value]), '  ')}),`);
  else if (m.bodyType === 'multipart') {
    lines.push('const form = new FormData();');
    for (const p of on(m.multipart)) {
      lines.push(p.isFile
        ? `form.append(${jsStr(p.key)}, fileInput.files[0]); // ${p.value}`
        : `form.append(${jsStr(p.key)}, ${jsStr(p.value)});`);
    }
    lines.push('');
    opts.push('  body: form,');
  }
  if (!m.flags.location) opts.push(`  redirect: 'manual',`);
  if (m.timeout > 0) opts.push(`  signal: AbortSignal.timeout(${m.timeout * 1000}),`);
  lines.push(`const res = await fetch(${jsStr(fullUrl(m))}, {\n${opts.join('\n')}\n});`);
  lines.push('');
  lines.push(`if (!res.ok) throw new Error(\`HTTP \${res.status}\`);`);
  lines.push(`const data = await res.${/json/i.test(h.find(([k]) => k.toLowerCase() === 'accept')?.[1] ?? 'json') ? 'json' : 'text'}();`);
  lines.push('console.log(data);');
  return lines.join('\n');
}

export function toAxios(m: HttpRequestModel): string {
  const out: string[] = [`import axios from 'axios';`];
  if (m.flags.insecure) out.push(`import https from 'node:https';`);
  if (m.bodyType === 'multipart') out.push(`import fs from 'node:fs';`);
  out.push('');
  const h = effectiveHeaders(m, { basicAsHeader: false, contentType: m.bodyType === 'json' || m.bodyType === 'form' });
  const cfg: string[] = [`  method: ${jsStr(m.method.toLowerCase())},`, `  url: ${jsStr(m.url)},`];
  const params = on(m.query);
  if (params.length) cfg.push(`  params: ${jsObj(params.map(p => [p.key, p.value]), '  ')},`);
  if (h.length) cfg.push(`  headers: ${jsObj(h, '  ')},`);
  if (m.auth.type === 'basic') cfg.push(`  auth: { username: ${jsStr(m.auth.user)}, password: ${jsStr(m.auth.pass)} },`);
  if (m.bodyType === 'json') {
    const v = tryJson(m.body);
    cfg.push(`  data: ${v !== undefined ? indentLines(JSON.stringify(v, null, 2), '  ') : jsStr(m.body)},`);
  } else if (m.bodyType === 'raw') cfg.push(`  data: ${jsStr(m.body)},`);
  else if (m.bodyType === 'form') cfg.push(`  data: new URLSearchParams(${jsObj(on(m.form).map(p => [p.key, p.value]), '  ')}),`);
  else if (m.bodyType === 'multipart') {
    out.push('const form = new FormData();');
    for (const p of on(m.multipart)) {
      out.push(p.isFile
        ? `form.append(${jsStr(p.key)}, new Blob([fs.readFileSync(${jsStr(p.value)})]), ${jsStr(p.value.split(/[\\/]/).pop() || 'file')});`
        : `form.append(${jsStr(p.key)}, ${jsStr(p.value)});`);
    }
    out.push('');
    cfg.push('  data: form,');
  }
  if (m.timeout > 0) cfg.push(`  timeout: ${m.timeout * 1000},`);
  if (!m.flags.location) cfg.push('  maxRedirects: 0,');
  if (m.flags.compressed) cfg.push(`  decompress: true,`);
  if (m.flags.insecure) cfg.push('  httpsAgent: new https.Agent({ rejectUnauthorized: false }),');
  out.push(`const res = await axios({\n${cfg.join('\n')}\n});`);
  out.push('console.log(res.status, res.data);');
  return out.join('\n');
}

/** JSON value → Python literal. */
export function pyRepr(v: unknown, indent = ''): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  const inner = indent + '    ';
  if (Array.isArray(v)) return v.length ? `[\n${v.map(x => inner + pyRepr(x, inner)).join(',\n')},\n${indent}]` : '[]';
  const e = Object.entries(v as Record<string, unknown>);
  return e.length ? `{\n${e.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pyRepr(x, inner)}`).join(',\n')},\n${indent}}` : '{}';
}

export function toPython(m: HttpRequestModel): string {
  const out = ['import requests', ''];
  const h = effectiveHeaders(m, { basicAsHeader: false, contentType: m.bodyType === 'raw' ? false : false });
  if (m.bodyType === 'raw' && !hasHeader(h, 'content-type')) { /* leave it to requests */ }
  const args: string[] = [JSON.stringify(m.method), 'url'];
  out.push(`url = ${JSON.stringify(m.url)}`);
  const params = on(m.query);
  if (params.length) { out.push(`params = ${pyRepr(Object.fromEntries(params.map(p => [p.key, p.value])))}`); args.push('params=params'); }
  if (h.length) { out.push(`headers = ${pyRepr(Object.fromEntries(h))}`); args.push('headers=headers'); }
  if (m.bodyType === 'json') {
    const v = tryJson(m.body);
    if (v !== undefined) { out.push(`payload = ${pyRepr(v)}`); args.push('json=payload'); }
    else { out.push(`payload = ${JSON.stringify(m.body)}`); args.push('data=payload'); }
  } else if (m.bodyType === 'raw') { out.push(`payload = ${JSON.stringify(m.body)}`); args.push('data=payload.encode("utf-8")'); }
  else if (m.bodyType === 'form') { out.push(`payload = ${pyRepr(Object.fromEntries(on(m.form).map(p => [p.key, p.value])))}`); args.push('data=payload'); }
  else if (m.bodyType === 'multipart') {
    const fields = on(m.multipart);
    const data = fields.filter(f => !f.isFile); const files = fields.filter(f => f.isFile);
    if (data.length) { out.push(`data = ${pyRepr(Object.fromEntries(data.map(p => [p.key, p.value])))}`); args.push('data=data'); }
    if (files.length) {
      out.push(`files = {\n${files.map(f => `    ${JSON.stringify(f.key)}: open(${JSON.stringify(f.value)}, "rb"),`).join('\n')}\n}`);
      args.push('files=files');
    }
  }
  if (m.auth.type === 'basic') args.push(`auth=(${JSON.stringify(m.auth.user)}, ${JSON.stringify(m.auth.pass)})`);
  if (m.timeout > 0) args.push(`timeout=${m.timeout}`);
  if (m.flags.insecure) args.push('verify=False');
  if (!m.flags.location) args.push('allow_redirects=False');
  out.push('');
  out.push(`response = requests.request(${args.join(', ')})`);
  out.push('print(response.status_code)');
  out.push('print(response.text)');
  return out.join('\n');
}

export function toHttpie(m: HttpRequestModel): string {
  const q = (s: string) => shellQuote(s, 'bash');
  const parts = ['http'];
  if (m.flags.location) parts.push('--follow');
  if (m.flags.insecure) parts.push('--verify=no');
  if (m.flags.verbose) parts.push('--verbose');
  else if (m.flags.include) parts.push('--print=hb');
  if (m.timeout > 0) parts.push(`--timeout=${m.timeout}`);
  if (m.bodyType === 'form') parts.push('--form');
  if (m.bodyType === 'multipart') parts.push('--multipart');
  if (m.auth.type === 'basic') parts.push(`--auth ${q(`${m.auth.user}:${m.auth.pass}`)}`);
  if (m.auth.type === 'bearer') parts.push(`--auth-type=bearer --auth ${q(m.auth.token)}`);
  if (m.bodyType === 'json' || m.bodyType === 'raw') parts.push(`--raw ${q(m.body)}`);
  parts.push(m.method, q(m.url));
  for (const p of on(m.query)) parts.push(q(`${p.key}==${p.value}`));
  const h = effectiveHeaders(m, { basicAsHeader: false, contentType: m.bodyType === 'json' }).filter(([k]) => !(m.auth.type === 'bearer' && k === 'Authorization'));
  for (const [k, v] of h) parts.push(q(`${k}:${v}`));
  if (m.bodyType === 'form') for (const p of on(m.form)) parts.push(q(`${p.key}=${p.value}`));
  if (m.bodyType === 'multipart') for (const p of on(m.multipart)) parts.push(q(`${p.key}${p.isFile ? '@' : '='}${p.value}`));
  return parts.join(' ');
}

const goStr = (s: string) => (s.includes('`') || /[\r]/.test(s) ? JSON.stringify(s) : s.includes('\n') || s.includes('"') ? '`' + s + '`' : JSON.stringify(s));

export function toGo(m: HttpRequestModel): string {
  const imports = new Set(['fmt', 'io', 'net/http']);
  const body: string[] = [];
  let bodyExpr = 'nil';
  if (m.bodyType === 'json' || m.bodyType === 'raw') { imports.add('strings'); bodyExpr = `strings.NewReader(${goStr(m.body)})`; }
  if (m.bodyType === 'form') {
    imports.add('net/url'); imports.add('strings');
    body.push('\tform := url.Values{}');
    for (const p of on(m.form)) body.push(`\tform.Set(${JSON.stringify(p.key)}, ${JSON.stringify(p.value)})`);
    bodyExpr = 'strings.NewReader(form.Encode())';
  }
  if (m.bodyType === 'multipart') {
    imports.add('bytes'); imports.add('mime/multipart');
    body.push('\tvar buf bytes.Buffer', '\tw := multipart.NewWriter(&buf)');
    for (const p of on(m.multipart)) {
      if (p.isFile) {
        imports.add('os');
        body.push(`\tif f, err := os.Open(${JSON.stringify(p.value)}); err == nil {`, `\t\tpart, _ := w.CreateFormFile(${JSON.stringify(p.key)}, f.Name())`, '\t\tio.Copy(part, f)', '\t\tf.Close()', '\t}');
      } else body.push(`\tw.WriteField(${JSON.stringify(p.key)}, ${JSON.stringify(p.value)})`);
    }
    body.push('\tw.Close()');
    bodyExpr = '&buf';
  }
  const client: string[] = [];
  if (m.timeout > 0) { imports.add('time'); client.push(`\t\tTimeout: ${m.timeout} * time.Second,`); }
  if (m.flags.insecure) { imports.add('crypto/tls'); client.push('\t\tTransport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},'); }
  if (!m.flags.location) client.push('\t\tCheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse },');
  body.push('', `\treq, err := http.NewRequest(${JSON.stringify(m.method)}, ${JSON.stringify(fullUrl(m))}, ${bodyExpr})`, '\tif err != nil {', '\t\tpanic(err)', '\t}');
  for (const [k, v] of effectiveHeaders(m, { basicAsHeader: false })) body.push(`\treq.Header.Set(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
  if (m.bodyType === 'multipart') body.push('\treq.Header.Set("Content-Type", w.FormDataContentType())');
  if (m.auth.type === 'basic') body.push(`\treq.SetBasicAuth(${JSON.stringify(m.auth.user)}, ${JSON.stringify(m.auth.pass)})`);
  body.push('', client.length ? `\tclient := &http.Client{\n${client.join('\n')}\n\t}` : '\tclient := &http.Client{}');
  body.push('\tres, err := client.Do(req)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer res.Body.Close()', '', '\tdata, _ := io.ReadAll(res.Body)', '\tfmt.Println(res.Status)', '\tfmt.Println(string(data))');
  return `package main\n\nimport (\n${[...imports].sort().map(i => `\t"${i}"`).join('\n')}\n)\n\nfunc main() {\n${body.join('\n')}\n}\n`;
}

/** Split a shell command line into words (bash-like quoting, plus PowerShell/cmd continuations). */
export function shellSplit(cmd: string): string[] {
  let s = cmd.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  // Chrome's "Copy as cURL (cmd)" escapes with carets: ^" ^& ^% … — undo them.
  if (/\^"/.test(s)) s = s.replace(/\^(.)/g, '$1');
  const out: string[] = [];
  let cur = ''; let has = false; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } i++; continue; }
    has = true;
    if (c === "'" ) {
      const e = s.indexOf("'", i + 1);
      if (e < 0) throw new Error('Unterminated single quote');
      cur += s.slice(i + 1, e);
      i = e + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\') {
          const n = s[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0', e: '\x1b', a: '\x07' };
          if (n === 'x') { cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 4; continue; }
          if (n === 'u') { cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue; }
          cur += map[n] ?? n; i += 2; continue;
        }
        cur += s[i++];
      }
      if (i >= s.length) throw new Error('Unterminated $\'…\' string');
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && /["\\$`\n]/.test(s[i + 1] ?? '')) { cur += s[i + 1]; i += 2; continue; }
        cur += s[i++];
      }
      if (i >= s.length) throw new Error('Unterminated double quote');
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
    cur += c;
    i++;
  }
  if (has) out.push(cur);
  return out;
}

const FLAG_ARGS = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode',
  '-F', '--form', '--form-string', '-u', '--user', '-b', '--cookie', '-A', '--user-agent', '-e', '--referer', '-m', '--max-time',
  '--connect-timeout', '--url', '-o', '--output', '--oauth2-bearer', '--json', '-x', '--proxy', '-c', '--cookie-jar', '-w', '--write-out',
  '--retry', '-T', '--upload-file', '-E', '--cert', '--cacert', '--key', '-r', '--range', '-z', '--time-cond', '--resolve', '--limit-rate']);

/** Parse a pasted curl command into the request model. */
export function parseCurl(cmd: string): { model: HttpRequestModel; warnings: string[] } {
  const words = shellSplit(cmd.trim());
  const warnings: string[] = [];
  if (!words.length) throw new Error('Empty command');
  if (/^(curl|curl\.exe)$/i.test(words[0].split(/[\\/]/).pop()!)) words.shift();
  else throw new Error('Command must start with "curl"');
  const m = emptyRequest();
  let method = '';
  const data: { kind: 'raw' | 'urlencode'; v: string }[] = [];
  const forms: MultipartField[] = [];
  let get = false; let head = false; let jsonFlag = false;
  let url = '';
  const expanded: string[] = [];
  for (const w of words) {
    // -sSL → -s -S -L ; -XPOST → -X POST ; -H'x' handled since quotes are gone
    if (/^-[A-Za-z]{2,}$/.test(w) && !FLAG_ARGS.has(w)) {
      const letters = w.slice(1);
      let k = 0;
      for (; k < letters.length; k++) {
        const f = '-' + letters[k];
        if (FLAG_ARGS.has(f)) { expanded.push(f); if (k + 1 < letters.length) expanded.push(letters.slice(k + 1)); break; }
        expanded.push(f);
      }
      continue;
    }
    const attached = /^(-[XHdFuAbem])(.+)$/.exec(w);
    if (attached && !w.startsWith('--')) { expanded.push(attached[1], attached[2]); continue; }
    expanded.push(w);
  }
  for (let k = 0; k < expanded.length; k++) {
    const w = expanded[k];
    const next = () => {
      if (k + 1 >= expanded.length) throw new Error(`Option ${w} needs a value`);
      return expanded[++k];
    };
    switch (w) {
      case '-X': case '--request': method = next().toUpperCase(); break;
      case '-H': case '--header': {
        const h = next();
        const c = h.indexOf(':');
        if (c > 0) m.headers.push({ key: h.slice(0, c).trim(), value: h.slice(c + 1).trim(), enabled: true });
        break;
      }
      case '-d': case '--data': case '--data-ascii': case '--data-binary': case '--data-raw': data.push({ kind: 'raw', v: next() }); break;
      case '--json': data.push({ kind: 'raw', v: next() }); jsonFlag = true; break;
      case '--data-urlencode': data.push({ kind: 'urlencode', v: next() }); break;
      case '-F': case '--form': case '--form-string': {
        const f = next();
        const eq = f.indexOf('=');
        const key = eq < 0 ? f : f.slice(0, eq);
        let value = eq < 0 ? '' : f.slice(eq + 1);
        const isFile = w !== '--form-string' && (value.startsWith('@') || value.startsWith('<'));
        if (isFile) value = value.slice(1).replace(/;type=.*$/, '');
        forms.push({ key, value, isFile, enabled: true });
        break;
      }
      case '-u': case '--user': {
        const u = next();
        const c = u.indexOf(':');
        m.auth = { ...m.auth, type: 'basic', user: c < 0 ? u : u.slice(0, c), pass: c < 0 ? '' : u.slice(c + 1) };
        break;
      }
      case '--oauth2-bearer': m.auth = { ...m.auth, type: 'bearer', token: next() }; break;
      case '-b': case '--cookie': m.headers.push({ key: 'Cookie', value: next(), enabled: true }); break;
      case '-A': case '--user-agent': m.headers.push({ key: 'User-Agent', value: next(), enabled: true }); break;
      case '-e': case '--referer': m.headers.push({ key: 'Referer', value: next(), enabled: true }); break;
      case '-L': case '--location': m.flags.location = true; break;
      case '-k': case '--insecure': m.flags.insecure = true; break;
      case '-v': case '--verbose': m.flags.verbose = true; break;
      case '-i': case '--include': m.flags.include = true; break;
      case '-s': case '--silent': m.flags.silent = true; break;
      case '--compressed': m.flags.compressed = true; break;
      case '-I': case '--head': head = true; break;
      case '-G': case '--get': get = true; break;
      case '-m': case '--max-time': m.timeout = Number(next()) || 0; break;
      case '--url': url = next(); break;
      case '-S': case '--show-error': case '-f': case '--fail': case '--fail-with-body': case '-N': case '--no-buffer':
      case '--http1.1': case '--http2': case '-g': case '--globoff': case '-#': case '--progress-bar': break;
      default:
        if (FLAG_ARGS.has(w)) { k++; warnings.push(`Ignored option ${w}`); }
        else if (w.startsWith('-')) warnings.push(`Ignored option ${w}`);
        else if (!url) url = w;
        else warnings.push(`Ignored extra argument ${w}`);
    }
  }
  if (!url) throw new Error('No URL found in the command');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url;

  // Split query parameters into rows.
  const qi = url.indexOf('?');
  if (qi >= 0) {
    const hashIdx = url.indexOf('#', qi);
    const qs = url.slice(qi + 1, hashIdx < 0 ? undefined : hashIdx);
    m.url = url.slice(0, qi) + (hashIdx < 0 ? '' : url.slice(hashIdx));
    for (const part of qs.split('&').filter(Boolean)) {
      const eq = part.indexOf('=');
      const dec = (x: string) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
      m.query.push({ key: dec(eq < 0 ? part : part.slice(0, eq)), value: eq < 0 ? '' : dec(part.slice(eq + 1)), enabled: true });
    }
  } else m.url = url;

  // Authorization header → auth section
  const authIdx = m.headers.findIndex(h => h.key.toLowerCase() === 'authorization');
  if (authIdx >= 0 && m.auth.type === 'none') {
    const v = m.headers[authIdx].value;
    const bearer = /^Bearer\s+(.+)$/i.exec(v);
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(v);
    if (bearer) { m.auth = { ...m.auth, type: 'bearer', token: bearer[1] }; m.headers.splice(authIdx, 1); }
    else if (basic) {
      try {
        const bin = atob(basic[1]);
        const dec = new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
        const c = dec.indexOf(':');
        m.auth = { ...m.auth, type: 'basic', user: c < 0 ? dec : dec.slice(0, c), pass: c < 0 ? '' : dec.slice(c + 1) };
        m.headers.splice(authIdx, 1);
      } catch { /* keep the header */ }
    }
  }

  const ct = m.headers.find(h => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (jsonFlag) {
    if (!m.headers.some(h => h.key.toLowerCase() === 'accept')) m.headers.push({ key: 'Accept', value: 'application/json', enabled: true });
  }
  if (get && data.length) {
    for (const d of data) {
      for (const part of d.v.split('&')) {
        const eq = part.indexOf('=');
        m.query.push({ key: eq < 0 ? part : part.slice(0, eq), value: eq < 0 ? '' : part.slice(eq + 1), enabled: true });
      }
    }
  } else if (forms.length) {
    m.bodyType = 'multipart';
    m.multipart = forms;
  } else if (data.length) {
    const allUrlencode = data.every(d => d.kind === 'urlencode');
    const joined = data.map(d => d.v).join('&');
    const trimmed = joined.trim();
    if (!allUrlencode && (jsonFlag || ct.includes('json') || ((trimmed.startsWith('{') || trimmed.startsWith('[')) && tryJson(trimmed) !== undefined))) {
      m.bodyType = 'json';
      const v = tryJson(joined);
      m.body = v !== undefined ? JSON.stringify(v, null, 2) : joined;
      if (ct.includes('application/json')) m.headers = m.headers.filter(h => h.key.toLowerCase() !== 'content-type');
    } else if (allUrlencode || ((!ct || ct.includes('x-www-form-urlencoded')) && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(joined))) {
      m.bodyType = 'form';
      for (const d of data) {
        if (d.kind === 'urlencode') {
          const eq = d.v.indexOf('=');
          m.form.push({ key: eq < 0 ? '' : d.v.slice(0, eq), value: eq < 0 ? d.v : d.v.slice(eq + 1), enabled: true });
        } else {
          for (const part of d.v.split('&')) {
            const eq = part.indexOf('=');
            const dec = (x: string) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
            m.form.push({ key: dec(part.slice(0, eq)), value: dec(part.slice(eq + 1)), enabled: true });
          }
        }
      }
      if (ct.includes('x-www-form-urlencoded')) m.headers = m.headers.filter(h => h.key.toLowerCase() !== 'content-type');
    } else {
      m.bodyType = 'raw';
      m.body = joined;
    }
  }
  m.method = method || (head ? 'HEAD' : (m.bodyType !== 'none' ? 'POST' : 'GET'));
  return { model: m, warnings };
}

// ═════════════════════════════════════════════════════════════════════════════
// robots.txt
// ═════════════════════════════════════════════════════════════════════════════

export interface RobotsGroup { agents: string[]; allow: string[]; disallow: string[]; crawlDelay?: number | null; comment?: string }
export interface RobotsModel { groups: RobotsGroup[]; sitemaps: string[]; host?: string }

export const AI_CRAWLERS = [
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'CCBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'Google-Extended',
  'PerplexityBot', 'Perplexity-User', 'Bytespider', 'Applebot-Extended', 'meta-externalagent', 'Meta-ExternalFetcher', 'FacebookBot',
  'Amazonbot', 'cohere-ai', 'cohere-training-data-crawler', 'Diffbot', 'ImagesiftBot', 'Omgilibot', 'YouBot', 'Timpibot', 'AI2Bot',
  'DuckAssistBot', 'MistralAI-User', 'PetalBot',
];

export function generateRobots(m: RobotsModel): string {
  const out: string[] = [];
  for (const g of m.groups) {
    const agents = g.agents.map(a => a.trim()).filter(Boolean);
    if (!agents.length) continue;
    if (out.length) out.push('');
    if (g.comment) out.push(`# ${g.comment}`);
    for (const a of agents) out.push(`User-agent: ${a}`);
    const allow = g.allow.map(x => x.trim()).filter(Boolean);
    const disallow = g.disallow.map(x => x.trim()).filter(Boolean);
    for (const p of allow) out.push(`Allow: ${p}`);
    for (const p of disallow) out.push(`Disallow: ${p}`);
    if (!allow.length && !disallow.length) out.push('Disallow:');
    if (g.crawlDelay) out.push(`Crawl-delay: ${g.crawlDelay}`);
  }
  const sm = m.sitemaps.map(s => s.trim()).filter(Boolean);
  if (sm.length) { out.push(''); for (const s of sm) out.push(`Sitemap: ${s}`); }
  if (m.host?.trim()) out.push(`Host: ${m.host.trim()}`);
  return out.join('\n') + '\n';
}

export function parseRobots(text: string): RobotsModel {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let host = '';
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const c = line.indexOf(':');
    if (c < 0) continue;
    const key = line.slice(0, c).trim().toLowerCase();
    const val = line.slice(c + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(val);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') { sitemaps.push(val); continue; }
    if (key === 'host') { host = val; continue; }
    if (!cur) continue;
    if (key === 'allow') { if (val) cur.allow.push(val); }
    else if (key === 'disallow') { if (val) cur.disallow.push(val); }
    else if (key === 'crawl-delay') cur.crawlDelay = Number(val) || null;
  }
  return { groups, sitemaps, host };
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = '^' + body.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : '');
  return new RegExp(re).test(path);
}

export interface RobotsVerdict { allowed: boolean; rule?: { type: 'allow' | 'disallow'; pattern: string }; agent: string }

/** RFC 9309: pick the most specific matching user-agent group(s), then the longest matching rule; ties go to Allow. */
export function robotsAllows(robots: string | RobotsModel, userAgent: string, path: string): RobotsVerdict {
  const m = typeof robots === 'string' ? parseRobots(robots) : robots;
  let p = path.trim() || '/';
  try { if (/^https?:\/\//i.test(p)) { const u = new URL(p); p = u.pathname + u.search; } } catch { /* use as-is */ }
  if (!p.startsWith('/')) p = '/' + p;
  if (p === '/robots.txt') return { allowed: true, agent: '*' };
  const ua = userAgent.toLowerCase();
  // The product token is the part before "/" ("Googlebot/2.1" → "googlebot"); also match tokens inside full UA strings.
  let best = '';
  for (const g of m.groups) {
    for (const a of g.agents) {
      const al = a.toLowerCase();
      if (al === '*') continue;
      if ((ua === al || ua.split(/[\s/;()]+/).includes(al) || ua.startsWith(al)) && al.length > best.length) best = al;
    }
  }
  const agent = best || '*';
  const groups = m.groups.filter(g => g.agents.some(a => a.toLowerCase() === agent));
  let verdict: RobotsVerdict = { allowed: true, agent: best ? m.groups.flatMap(g => g.agents).find(a => a.toLowerCase() === best)! : '*' };
  if (!groups.length) return verdict;
  let bestLen = -1;
  for (const g of groups) {
    for (const [type, list] of [['allow', g.allow], ['disallow', g.disallow]] as const) {
      for (const pat of list) {
        if (!pat || !robotsPatternMatches(pat, p)) continue;
        const len = pat.length;
        if (len > bestLen || (len === bestLen && type === 'allow')) {
          bestLen = len;
          verdict = { ...verdict, allowed: type === 'allow', rule: { type, pattern: pat } };
        }
      }
    }
  }
  return verdict;
}

// ═════════════════════════════════════════════════════════════════════════════
// .htaccess
// ═════════════════════════════════════════════════════════════════════════════

export interface HtaccessOptions {
  forceHttps: boolean;
  www: 'none' | 'www' | 'non-www';
  trailingSlash: 'none' | 'add' | 'remove';
  redirects: { from: string; to: string; code: '301' | '302' | '307' | '308' }[];
  errorPages: { code: string; path: string }[];
  compression: boolean;
  caching: boolean;
  cache: { html: string; css: string; js: string; images: string; fonts: string; media: string };
  hsts: boolean;
  hstsPreload: boolean;
  nosniff: boolean;
  frameOptions: 'none' | 'DENY' | 'SAMEORIGIN';
  referrerPolicy: string;
  permissionsPolicy: boolean;
  csp: string;
  noIndexes: boolean;
  blockIps: string[];
  hotlink: boolean;
  hotlinkDomain: string;
  hotlinkExts: string;
  spaFallback: boolean;
  protectDotfiles: boolean;
  noSignature: boolean;
  charset: boolean;
}

export function generateHtaccess(o: HtaccessOptions): string {
  const out: string[] = [];
  const sec = (title: string) => { if (out.length) out.push(''); out.push(`# ── ${title} ${'─'.repeat(Math.max(3, 60 - title.length))}`); };
  const rewrite: string[] = [];
  const domain = o.hotlinkDomain.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (o.charset) { sec('Charset'); out.push('AddDefaultCharset UTF-8'); }
  if (o.noIndexes) { sec('Disable directory listing'); out.push('Options -Indexes'); }
  if (o.noSignature) { sec('Hide server version'); out.push('ServerSignature Off'); }
  if (o.protectDotfiles) {
    sec('Block access to hidden files (.git, .env …)');
    out.push('<FilesMatch "^\\.">', '  Require all denied', '</FilesMatch>', 'RedirectMatch 404 /\\.git');
  }
  const ips = o.blockIps.map(s => s.trim()).filter(Boolean);
  if (ips.length) {
    sec('Block IP addresses');
    out.push('<RequireAll>', '  Require all granted', ...ips.map(ip => `  Require not ip ${ip}`), '</RequireAll>');
  }
  if (o.forceHttps) {
    rewrite.push('# Force HTTPS (also works behind proxies that set X-Forwarded-Proto)');
    rewrite.push('RewriteCond %{HTTPS} off', 'RewriteCond %{HTTP:X-Forwarded-Proto} !https', 'RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]');
  }
  if (o.www === 'www') {
    rewrite.push('', '# Add www', 'RewriteCond %{HTTP_HOST} !^www\\. [NC]', 'RewriteCond %{HTTP_HOST} !^localhost [NC]', `RewriteRule ^ ${o.forceHttps ? 'https' : '%{REQUEST_SCHEME}'}://www.%{HTTP_HOST}%{REQUEST_URI} [L,R=301]`);
  } else if (o.www === 'non-www') {
    rewrite.push('', '# Remove www', 'RewriteCond %{HTTP_HOST} ^www\\.(.+)$ [NC]', `RewriteRule ^ ${o.forceHttps ? 'https' : '%{REQUEST_SCHEME}'}://%1%{REQUEST_URI} [L,R=301]`);
  }
  if (o.trailingSlash === 'add') {
    rewrite.push('', '# Add a trailing slash to URLs that are not files', 'RewriteCond %{REQUEST_FILENAME} !-f', 'RewriteCond %{REQUEST_URI} !/$', 'RewriteCond %{REQUEST_URI} !\\.[a-zA-Z0-9]{1,5}$', 'RewriteRule ^(.*)$ /$1/ [L,R=301]');
  } else if (o.trailingSlash === 'remove') {
    rewrite.push('', '# Remove trailing slashes (except for real directories)', 'RewriteCond %{REQUEST_FILENAME} !-d', 'RewriteCond %{REQUEST_URI} (.+)/$', 'RewriteRule ^ %1 [L,R=301]');
  }
  if (o.hotlink && domain) {
    const exts = o.hotlinkExts.split(/[\s,|]+/).map(e => e.replace(/^\./, '')).filter(Boolean).join('|') || 'jpe?g|png|gif|webp|svg';
    rewrite.push('', '# Hotlink protection', 'RewriteCond %{HTTP_REFERER} !^$', `RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?${domain.replace(/\./g, '\\.')}/ [NC]`, `RewriteRule \\.(${exts})$ - [F,NC,L]`);
  }
  const redirects = o.redirects.filter(r => r.from.trim() && r.to.trim());
  if (redirects.length) {
    rewrite.push('', '# Custom redirects');
    for (const r of redirects) {
      const from = r.from.trim().replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
      const esc = from.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      rewrite.push(`RewriteRule ^${esc}/?$ ${r.to.trim()} [L,R=${r.code}]`);
    }
  }
  if (o.spaFallback) {
    rewrite.push('', '# Single-page app: serve index.html for unknown paths', 'RewriteCond %{REQUEST_FILENAME} !-f', 'RewriteCond %{REQUEST_FILENAME} !-d', 'RewriteRule ^ index.html [L]');
  }
  if (rewrite.length) {
    sec('Rewrites');
    out.push('<IfModule mod_rewrite.c>', '  RewriteEngine On', '  RewriteBase /', ...rewrite.map(l => (l ? '  ' + l : '')), '</IfModule>');
  }
  const errs = o.errorPages.filter(e => e.code.trim() && e.path.trim());
  if (errs.length) { sec('Custom error pages'); for (const e of errs) out.push(`ErrorDocument ${e.code.trim()} ${e.path.trim()}`); }
  if (o.compression) {
    sec('Compression');
    out.push('<IfModule mod_brotli.c>', '  AddOutputFilterByType BROTLI_COMPRESS text/html text/plain text/css text/xml application/javascript application/json application/xml image/svg+xml font/ttf font/otf', '</IfModule>');
    out.push('<IfModule mod_deflate.c>', '  AddOutputFilterByType DEFLATE text/html text/plain text/css text/xml text/javascript', '  AddOutputFilterByType DEFLATE application/javascript application/json application/xml application/rss+xml application/atom+xml', '  AddOutputFilterByType DEFLATE image/svg+xml image/x-icon font/ttf font/otf application/vnd.ms-fontobject', '</IfModule>');
  }
  if (o.caching) {
    sec('Browser caching');
    const c = o.cache;
    out.push('<IfModule mod_expires.c>', '  ExpiresActive On', '  ExpiresDefault "access plus 1 month"');
    if (c.html) out.push(`  ExpiresByType text/html "access plus ${c.html}"`);
    if (c.css) out.push(`  ExpiresByType text/css "access plus ${c.css}"`);
    if (c.js) out.push(`  ExpiresByType application/javascript "access plus ${c.js}"`, `  ExpiresByType text/javascript "access plus ${c.js}"`);
    if (c.images) for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/x-icon']) out.push(`  ExpiresByType ${t} "access plus ${c.images}"`);
    if (c.fonts) for (const t of ['font/woff2', 'font/woff', 'font/ttf', 'font/otf']) out.push(`  ExpiresByType ${t} "access plus ${c.fonts}"`);
    if (c.media) for (const t of ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg']) out.push(`  ExpiresByType ${t} "access plus ${c.media}"`);
    out.push('</IfModule>');
  }
  const headers: string[] = [];
  if (o.hsts) headers.push(`  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains${o.hstsPreload ? '; preload' : ''}"`);
  if (o.nosniff) headers.push('  Header always set X-Content-Type-Options "nosniff"');
  if (o.frameOptions !== 'none') headers.push(`  Header always set X-Frame-Options "${o.frameOptions}"`);
  if (o.referrerPolicy) headers.push(`  Header always set Referrer-Policy "${o.referrerPolicy}"`);
  if (o.permissionsPolicy) headers.push('  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()"');
  if (o.csp.trim()) headers.push(`  Header always set Content-Security-Policy "${o.csp.trim().replace(/"/g, "'")}"`);
  if (o.noSignature) headers.push('  Header unset X-Powered-By');
  if (headers.length) { sec('Security headers'); out.push('<IfModule mod_headers.c>', ...headers, '</IfModule>'); }
  return out.join('\n') + '\n';
}

// ═════════════════════════════════════════════════════════════════════════════
// Meta tags
// ═════════════════════════════════════════════════════════════════════════════

export interface MetaModel {
  title: string; description: string; keywords: string; author: string; canonical: string;
  robotsIndex: boolean; robotsFollow: boolean; viewport: boolean; charset: boolean; themeColor: string; lang: string;
  ogType: string; ogImage: string; ogImageAlt: string; siteName: string; locale: string; url: string;
  twitterCard: 'summary' | 'summary_large_image' | 'none'; twitterSite: string; twitterCreator: string;
  favicon: string; appleTouchIcon: string; manifest: string;
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function generateMetaTags(m: MetaModel): string {
  const L: string[] = [];
  const meta = (attr: 'name' | 'property', key: string, v: string) => { if (v.trim()) L.push(`<meta ${attr}="${key}" content="${escAttr(v.trim())}">`); };
  if (m.charset) L.push('<meta charset="utf-8">');
  if (m.viewport) L.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  if (m.title.trim()) L.push(`<title>${escText(m.title.trim())}</title>`);
  meta('name', 'description', m.description);
  meta('name', 'keywords', m.keywords);
  meta('name', 'author', m.author);
  if (!m.robotsIndex || !m.robotsFollow) meta('name', 'robots', `${m.robotsIndex ? 'index' : 'noindex'}, ${m.robotsFollow ? 'follow' : 'nofollow'}`);
  else meta('name', 'robots', 'index, follow, max-image-preview:large');
  if (m.canonical.trim()) L.push(`<link rel="canonical" href="${escAttr(m.canonical.trim())}">`);
  meta('name', 'theme-color', m.themeColor);
  if (m.favicon.trim()) L.push(`<link rel="icon" href="${escAttr(m.favicon.trim())}"${/\.svg($|\?)/i.test(m.favicon) ? ' type="image/svg+xml"' : ''}>`);
  if (m.appleTouchIcon.trim()) L.push(`<link rel="apple-touch-icon" href="${escAttr(m.appleTouchIcon.trim())}">`);
  if (m.manifest.trim()) L.push(`<link rel="manifest" href="${escAttr(m.manifest.trim())}">`);
  L.push('');
  L.push('<!-- Open Graph -->');
  meta('property', 'og:type', m.ogType);
  meta('property', 'og:title', m.title);
  meta('property', 'og:description', m.description);
  meta('property', 'og:url', m.url || m.canonical);
  meta('property', 'og:site_name', m.siteName);
  meta('property', 'og:locale', m.locale);
  meta('property', 'og:image', m.ogImage);
  meta('property', 'og:image:alt', m.ogImage.trim() ? m.ogImageAlt : '');
  if (m.twitterCard !== 'none') {
    L.push('');
    L.push('<!-- Twitter / X -->');
    meta('name', 'twitter:card', m.twitterCard);
    meta('name', 'twitter:site', m.twitterSite && !m.twitterSite.startsWith('@') ? '@' + m.twitterSite : m.twitterSite);
    meta('name', 'twitter:creator', m.twitterCreator && !m.twitterCreator.startsWith('@') ? '@' + m.twitterCreator : m.twitterCreator);
    meta('name', 'twitter:title', m.title);
    meta('name', 'twitter:description', m.description);
    meta('name', 'twitter:image', m.ogImage);
    meta('name', 'twitter:image:alt', m.ogImage.trim() ? m.ogImageAlt : '');
  }
  while (L.length && !L[L.length - 1]) L.pop();
  return L.filter((l, i) => !(l.startsWith('<!--') && (!L[i + 1] || L[i + 1] === ''))).join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════
// docker-compose
// ═════════════════════════════════════════════════════════════════════════════

export interface ComposeVolume { source: string; target: string; readOnly?: boolean }
export interface ComposeService {
  name: string;
  image: string;
  build: { context: string; dockerfile: string } | null;
  containerName: string;
  ports: string[];
  env: KV[];
  envFile: string[];
  volumes: ComposeVolume[];
  dependsOn: { name: string; condition: 'service_started' | 'service_healthy' | 'service_completed_successfully' }[];
  restart: '' | 'no' | 'always' | 'unless-stopped' | 'on-failure';
  healthcheck: { test: string; interval: string; timeout: string; retries: number; startPeriod: string } | null;
  command: string;
  networks: string[];
  cpus: string;
  memory: string;
}
export interface ComposeModel { name: string; services: ComposeService[] }

export const newService = (name = 'app'): ComposeService => ({
  name, image: '', build: null, containerName: '', ports: [], env: [], envFile: [], volumes: [], dependsOn: [], restart: 'unless-stopped',
  healthcheck: null, command: '', networks: [], cpus: '', memory: '',
});

/** Named volume = a source that isn't a path. */
export const isNamedVolume = (src: string) => !!src && !/^[./~]|^[A-Za-z]:[\\/]|^\$\{?/.test(src) && !src.includes('/');

export function composeToObject(m: ComposeModel): Record<string, unknown> {
  const services: Record<string, unknown> = {};
  const namedVolumes = new Set<string>();
  const networks = new Set<string>();
  for (const s of m.services) {
    const o: Record<string, unknown> = {};
    if (s.image.trim()) o.image = s.image.trim();
    if (s.build) {
      const ctx = s.build.context.trim() || '.';
      o.build = s.build.dockerfile.trim() && s.build.dockerfile.trim() !== 'Dockerfile' ? { context: ctx, dockerfile: s.build.dockerfile.trim() } : ctx;
    }
    if (s.containerName.trim()) o.container_name = s.containerName.trim();
    if (s.restart) o.restart = s.restart;
    if (s.command.trim()) o.command = s.command.trim();
    const ports = s.ports.map(p => p.trim()).filter(Boolean);
    if (ports.length) o.ports = ports;
    const envFile = s.envFile.map(p => p.trim()).filter(Boolean);
    if (envFile.length) o.env_file = envFile.length === 1 ? envFile[0] : envFile;
    const env = on(s.env);
    if (env.length) o.environment = Object.fromEntries(env.map(e => [e.key.trim(), e.value]));
    const vols = s.volumes.filter(v => v.target.trim());
    if (vols.length) {
      o.volumes = vols.map(v => {
        const src = v.source.trim();
        if (isNamedVolume(src)) namedVolumes.add(src);
        return (src ? `${src}:` : '') + v.target.trim() + (v.readOnly ? ':ro' : '');
      });
    }
    const deps = s.dependsOn.filter(d => d.name.trim());
    if (deps.length) {
      o.depends_on = deps.every(d => d.condition === 'service_started')
        ? deps.map(d => d.name)
        : Object.fromEntries(deps.map(d => [d.name, { condition: d.condition }]));
    }
    if (s.healthcheck && s.healthcheck.test.trim()) {
      const h = s.healthcheck;
      const hc: Record<string, unknown> = { test: ['CMD-SHELL', h.test.trim()] };
      if (h.interval) hc.interval = h.interval;
      if (h.timeout) hc.timeout = h.timeout;
      if (h.retries) hc.retries = h.retries;
      if (h.startPeriod) hc.start_period = h.startPeriod;
      o.healthcheck = hc;
    }
    const nets = s.networks.map(n => n.trim()).filter(Boolean);
    if (nets.length) { o.networks = nets; nets.forEach(n => networks.add(n)); }
    if (s.cpus.trim() || s.memory.trim()) {
      const limits: Record<string, string> = {};
      if (s.cpus.trim()) limits.cpus = s.cpus.trim();
      if (s.memory.trim()) limits.memory = s.memory.trim();
      o.deploy = { resources: { limits } };
    }
    services[s.name.trim() || 'service'] = o;
  }
  const doc: Record<string, unknown> = {};
  if (m.name.trim()) doc.name = m.name.trim();
  doc.services = services;
  if (namedVolumes.size) doc.volumes = Object.fromEntries([...namedVolumes].map(v => [v, {}]));
  if (networks.size) doc.networks = Object.fromEntries([...networks].map(n => [n, {}]));
  return doc;
}

export function composeToYaml(m: ComposeModel): string {
  // `{}` values render as `name: {}` — the conventional docker style is an empty mapping value.
  return yaml.dump(composeToObject(m), { indent: 2, lineWidth: -1, noRefs: true }).replace(/: \{\}$/gm, ':');
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

export function composeFromYaml(text: string): ComposeModel {
  const doc = yaml.load(text) as Record<string, any> | null;
  if (!doc || typeof doc !== 'object') throw new Error('Not a docker-compose document');
  const svcs = doc.services as Record<string, any> | undefined;
  if (!svcs || typeof svcs !== 'object') throw new Error('No "services:" section found');
  const services: ComposeService[] = Object.entries(svcs).map(([name, raw]) => {
    const r = (raw ?? {}) as Record<string, any>;
    const s = newService(name);
    s.restart = '';
    s.image = r.image ? String(r.image) : '';
    if (r.build) s.build = typeof r.build === 'string' ? { context: r.build, dockerfile: '' } : { context: String(r.build.context ?? '.'), dockerfile: String(r.build.dockerfile ?? '') };
    s.containerName = r.container_name ? String(r.container_name) : '';
    s.restart = (r.restart ? String(r.restart) : '') as ComposeService['restart'];
    s.command = Array.isArray(r.command) ? r.command.map((c: unknown) => (/\s/.test(String(c)) ? JSON.stringify(String(c)) : String(c))).join(' ') : r.command ? String(r.command) : '';
    s.ports = (Array.isArray(r.ports) ? r.ports : []).map((p: any) => (typeof p === 'object' && p
      ? `${p.host_ip ? p.host_ip + ':' : ''}${p.published ? p.published + ':' : ''}${p.target}${p.protocol && p.protocol !== 'tcp' ? '/' + p.protocol : ''}`
      : String(p)));
    s.envFile = asList(r.env_file).map(e => (typeof e === 'object' ? String((e as any).path) : e));
    if (Array.isArray(r.environment)) {
      s.env = r.environment.map((e: string) => { const i = String(e).indexOf('='); return i < 0 ? { key: String(e), value: '', enabled: true } : { key: String(e).slice(0, i), value: String(e).slice(i + 1), enabled: true }; });
    } else if (r.environment && typeof r.environment === 'object') {
      s.env = Object.entries(r.environment).map(([k, v]) => ({ key: k, value: v == null ? '' : String(v), enabled: true }));
    }
    s.volumes = (Array.isArray(r.volumes) ? r.volumes : []).map((v: any) => {
      if (typeof v === 'object' && v) return { source: String(v.source ?? ''), target: String(v.target ?? ''), readOnly: !!v.read_only };
      const parts = String(v).split(':');
      // Windows drive letters (C:\x:/data) — rejoin the first two parts
      if (parts.length > 2 && /^[A-Za-z]$/.test(parts[0])) parts.splice(0, 2, parts[0] + ':' + parts[1]);
      if (parts.length === 1) return { source: '', target: parts[0] };
      return { source: parts[0], target: parts[1], readOnly: parts[2] === 'ro' };
    });
    if (Array.isArray(r.depends_on)) s.dependsOn = r.depends_on.map((d: string) => ({ name: String(d), condition: 'service_started' as const }));
    else if (r.depends_on && typeof r.depends_on === 'object') {
      s.dependsOn = Object.entries(r.depends_on).map(([k, v]: [string, any]) => ({ name: k, condition: (v?.condition ?? 'service_started') }));
    }
    if (r.healthcheck && !r.healthcheck.disable) {
      const t = r.healthcheck.test;
      const test = Array.isArray(t) ? (t[0] === 'CMD-SHELL' ? t.slice(1).join(' ') : t[0] === 'CMD' ? t.slice(1).join(' ') : t.join(' ')) : String(t ?? '');
      s.healthcheck = { test, interval: String(r.healthcheck.interval ?? ''), timeout: String(r.healthcheck.timeout ?? ''), retries: Number(r.healthcheck.retries ?? 0), startPeriod: String(r.healthcheck.start_period ?? '') };
    }
    s.networks = Array.isArray(r.networks) ? r.networks.map(String) : r.networks && typeof r.networks === 'object' ? Object.keys(r.networks) : [];
    const lim = r.deploy?.resources?.limits;
    if (lim) { s.cpus = lim.cpus != null ? String(lim.cpus) : ''; s.memory = lim.memory != null ? String(lim.memory) : ''; }
    if (!s.cpus && r.cpus != null) s.cpus = String(r.cpus);
    if (!s.memory && r.mem_limit != null) s.memory = String(r.mem_limit);
    return s;
  });
  return { name: doc.name ? String(doc.name) : '', services };
}

export const COMPOSE_TEMPLATES: Record<string, { label: string; make: () => ComposeService }> = {
  postgres: {
    label: 'PostgreSQL',
    make: () => ({
      ...newService('db'), image: 'postgres:17-alpine', ports: ['5432:5432'],
      env: [{ key: 'POSTGRES_USER', value: 'app' }, { key: 'POSTGRES_PASSWORD', value: 'change-me' }, { key: 'POSTGRES_DB', value: 'app' }],
      volumes: [{ source: 'pgdata', target: '/var/lib/postgresql/data' }],
      healthcheck: { test: 'pg_isready -U app -d app', interval: '10s', timeout: '5s', retries: 5, startPeriod: '10s' },
    }),
  },
  mysql: {
    label: 'MySQL',
    make: () => ({
      ...newService('mysql'), image: 'mysql:8.4', ports: ['3306:3306'],
      env: [{ key: 'MYSQL_ROOT_PASSWORD', value: 'change-me' }, { key: 'MYSQL_DATABASE', value: 'app' }, { key: 'MYSQL_USER', value: 'app' }, { key: 'MYSQL_PASSWORD', value: 'change-me' }],
      volumes: [{ source: 'mysqldata', target: '/var/lib/mysql' }],
      healthcheck: { test: 'mysqladmin ping -h localhost', interval: '10s', timeout: '5s', retries: 5, startPeriod: '20s' },
    }),
  },
  mariadb: {
    label: 'MariaDB',
    make: () => ({
      ...newService('mariadb'), image: 'mariadb:11', ports: ['3306:3306'],
      env: [{ key: 'MARIADB_ROOT_PASSWORD', value: 'change-me' }, { key: 'MARIADB_DATABASE', value: 'app' }],
      volumes: [{ source: 'mariadbdata', target: '/var/lib/mysql' }],
      healthcheck: { test: 'healthcheck.sh --connect --innodb_initialized', interval: '10s', timeout: '5s', retries: 5, startPeriod: '20s' },
    }),
  },
  redis: {
    label: 'Redis',
    make: () => ({
      ...newService('redis'), image: 'redis:7-alpine', ports: ['6379:6379'], command: 'redis-server --appendonly yes',
      volumes: [{ source: 'redisdata', target: '/data' }],
      healthcheck: { test: 'redis-cli ping', interval: '10s', timeout: '3s', retries: 5, startPeriod: '' },
    }),
  },
  mongo: {
    label: 'MongoDB',
    make: () => ({
      ...newService('mongo'), image: 'mongo:8', ports: ['27017:27017'],
      env: [{ key: 'MONGO_INITDB_ROOT_USERNAME', value: 'root' }, { key: 'MONGO_INITDB_ROOT_PASSWORD', value: 'change-me' }],
      volumes: [{ source: 'mongodata', target: '/data/db' }],
      healthcheck: { test: 'mongosh --quiet --eval "db.adminCommand(\'ping\')"', interval: '10s', timeout: '5s', retries: 5, startPeriod: '20s' },
    }),
  },
  nginx: {
    label: 'Nginx',
    make: () => ({
      ...newService('nginx'), image: 'nginx:alpine', ports: ['80:80', '443:443'],
      volumes: [{ source: './nginx.conf', target: '/etc/nginx/conf.d/default.conf', readOnly: true }, { source: './public', target: '/usr/share/nginx/html', readOnly: true }],
    }),
  },
  node: {
    label: 'Node.js app',
    make: () => ({
      ...newService('app'), build: { context: '.', dockerfile: 'Dockerfile' }, ports: ['3000:3000'],
      env: [{ key: 'NODE_ENV', value: 'production' }, { key: 'PORT', value: '3000' }], envFile: ['.env'],
      healthcheck: { test: 'wget -qO- http://localhost:3000/health || exit 1', interval: '30s', timeout: '5s', retries: 3, startPeriod: '10s' },
    }),
  },
  adminer: { label: 'Adminer', make: () => ({ ...newService('adminer'), image: 'adminer:latest', ports: ['8080:8080'] }) },
  minio: {
    label: 'MinIO',
    make: () => ({
      ...newService('minio'), image: 'minio/minio:latest', ports: ['9000:9000', '9001:9001'], command: 'server /data --console-address ":9001"',
      env: [{ key: 'MINIO_ROOT_USER', value: 'minioadmin' }, { key: 'MINIO_ROOT_PASSWORD', value: 'change-me-please' }],
      volumes: [{ source: 'miniodata', target: '/data' }],
      healthcheck: { test: 'mc ready local', interval: '30s', timeout: '5s', retries: 3, startPeriod: '' },
    }),
  },
  rabbitmq: {
    label: 'RabbitMQ',
    make: () => ({
      ...newService('rabbitmq'), image: 'rabbitmq:4-management-alpine', ports: ['5672:5672', '15672:15672'],
      volumes: [{ source: 'rabbitdata', target: '/var/lib/rabbitmq' }],
      healthcheck: { test: 'rabbitmq-diagnostics -q ping', interval: '30s', timeout: '10s', retries: 5, startPeriod: '' },
    }),
  },
  mailpit: { label: 'Mailpit (SMTP testing)', make: () => ({ ...newService('mailpit'), image: 'axllent/mailpit:latest', ports: ['8025:8025', '1025:1025'] }) },
};

// ═════════════════════════════════════════════════════════════════════════════
// SVG → JSX
// ═════════════════════════════════════════════════════════════════════════════

export interface SvgJsxOptions {
  name: string;
  typescript: boolean;
  memo: boolean;
  forwardRef: boolean;
  spreadProps: boolean;
  removeDimensions: boolean;
  removeXmlns: boolean;
  currentColor: boolean;
  removeEditorData: boolean;
  exportDefault: boolean;
}

// Attributes React keeps with special casing (beyond simple kebab → camel).
const SVG_ATTR_MAP: Record<string, string> = {
  class: 'className', for: 'htmlFor', 'xlink:href': 'xlinkHref', 'xlink:title': 'xlinkTitle', 'xlink:role': 'xlinkRole',
  'xlink:show': 'xlinkShow', 'xlink:actuate': 'xlinkActuate', 'xlink:arcrole': 'xlinkArcrole', 'xlink:type': 'xlinkType',
  'xml:space': 'xmlSpace', 'xml:lang': 'xmlLang', 'xml:base': 'xmlBase', 'xmlns:xlink': 'xmlnsXlink', tabindex: 'tabIndex',
};

export function svgAttrToJsx(name: string): string {
  if (SVG_ATTR_MAP[name]) return SVG_ATTR_MAP[name];
  if (/^(data|aria)-/.test(name)) return name;
  return name.replace(/[-:]([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function styleToObject(style: string): string {
  const entries = splitTopLevel(style, ';').map(d => d.trim()).filter(Boolean).map(d => {
    const c = d.indexOf(':');
    if (c < 0) return null;
    const prop = d.slice(0, c).trim();
    const val = d.slice(c + 1).trim();
    const key = prop.startsWith('--') ? `'${prop}'` : prop.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, x: string) => x.toUpperCase());
    const num = /^-?\d*\.?\d+$/.test(val) ? val : jsStr(val);
    return `${key}: ${num}`;
  }).filter(Boolean);
  return `{ ${entries.join(', ')} }`;
}

const COMPONENT_NAME = /^[A-Z][A-Za-z0-9_]*$/;

export function toComponentName(s: string): string {
  const n = s.replace(/\.[a-z]+$/i, '').replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string) => (c ? c.toUpperCase() : '')).replace(/^[^A-Za-z]+/, '');
  const name = n.charAt(0).toUpperCase() + n.slice(1);
  return COMPONENT_NAME.test(name) ? name : 'SvgIcon';
}

export function svgToJsx(svg: string, o: SvgJsxOptions): string {
  const nodes = parseXml(svg.trim());
  const root = nodes.find((n): n is XmlElement => n.type === 'element');
  if (!root || root.name.replace(/^.*:/, '') !== 'svg') throw new Error('The root element must be <svg>');
  const name = COMPONENT_NAME.test(o.name) ? o.name : toComponentName(o.name || 'SvgIcon');
  const editorNs = /^(sodipodi|inkscape|sketch|serif|figma|xmlns:(sodipodi|inkscape|sketch|serif|dc|cc|rdf|svg))(:|$)/;

  const renderAttrs = (el: XmlElement, isRoot: boolean): string[] => {
    const out: string[] = [];
    for (const a of el.attrs) {
      const n = a.name;
      if (/^on/i.test(n)) continue; // event handlers never belong in a static icon
      if (o.removeXmlns && (n === 'xmlns' || n.startsWith('xmlns:'))) continue;
      if (o.removeEditorData && (editorNs.test(n) || n === 'data-name' && false)) continue;
      if (isRoot && o.removeDimensions && (n === 'width' || n === 'height')) continue;
      if (isRoot && n === 'version') continue;
      let value = decodeEntitiesBasic(a.value);
      if (o.currentColor && (n === 'fill' || n === 'stroke') && value !== 'none' && !value.startsWith('url(') && value !== 'currentColor') value = 'currentColor';
      const jsx = svgAttrToJsx(n);
      if (n === 'style') {
        let st = value;
        if (o.currentColor) st = st.replace(/(^|;)\s*(fill|stroke)\s*:\s*(?!none|url\()[^;]+/g, '$1$2:currentColor');
        out.push(`style={${styleToObject(st)}}`);
        continue;
      }
      out.push(value.includes('"') || value.includes('\n') ? `${jsx}={${jsStr(value)}}` : `${jsx}="${value}"`);
    }
    if (isRoot) {
      if (o.removeDimensions && !el.attrs.some(a => a.name === 'viewBox')) {
        const w = el.attrs.find(a => a.name === 'width')?.value; const h = el.attrs.find(a => a.name === 'height')?.value;
        if (w && h && /^\d+(\.\d+)?(px)?$/.test(w) && /^\d+(\.\d+)?(px)?$/.test(h)) out.push(`viewBox="0 0 ${parseFloat(w)} ${parseFloat(h)}"`);
      }
      if (o.forwardRef) out.push('ref={ref}');
      if (o.spreadProps) out.push('{...props}');
    }
    return out;
  };

  const lines: string[] = [];
  const walk = (el: XmlElement, depth: number, isRoot: boolean) => {
    const pad = '  '.repeat(depth);
    const tag = el.name;
    if (o.removeEditorData && (/^(sodipodi|inkscape|sketch|serif):/.test(tag) || tag === 'metadata')) return;
    if (tag === 'script' || tag.endsWith(':script')) return;
    const attrs = renderAttrs(el, isRoot);
    const kids = el.children.filter(c => c.type === 'element' || ((c.type === 'text' || c.type === 'cdata') && c.value.trim()));
    const open = attrs.length > 3 || (attrs.join(' ').length > 80)
      ? `${pad}<${tag}\n${attrs.map(a => `${pad}  ${a}`).join('\n')}\n${pad}`
      : `${pad}<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
    if (!kids.length) { lines.push(open + (open.endsWith('\n' + pad) ? '/>' : ' />')); return; }
    if (tag === 'style') {
      const css = kids.map(k => (k.type === 'text' || k.type === 'cdata' ? k.value : '')).join('').trim();
      lines.push(`${open}>{\`${css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\`}</${tag}>`);
      return;
    }
    lines.push(open + '>');
    for (const k of kids) {
      if (k.type === 'element') walk(k, depth + 1, false);
      else if (k.type === 'text' || k.type === 'cdata') {
        const t = (k.type === 'text' ? decodeEntitiesBasic(k.value) : k.value).trim().replace(/\s+/g, ' ');
        lines.push(`${pad}  ${/[{}<>]/.test(t) ? `{${jsStr(t)}}` : t}`);
      }
    }
    lines.push(`${pad}</${tag}>`);
  };
  walk(root, 2, true);
  const body = lines.join('\n');

  const ts = o.typescript;
  const imports: string[] = [];
  if (o.forwardRef) imports.push('forwardRef');
  if (o.memo) imports.push('memo');
  const importLines: string[] = [];
  if (imports.length) importLines.push(`import { ${imports.join(', ')} } from 'react';`);
  if (ts) importLines.push(`import type { SVGProps } from 'react';`);
  if (!imports.length && !ts) importLines.push(`import * as React from 'react';`);
  const propsType = ts ? ': SVGProps<SVGSVGElement>' : '';
  const params = o.spreadProps ? `props${propsType}` : '';
  let comp: string;
  const inner = o.memo ? `${name}Base` : name;
  if (o.forwardRef) {
    const gen = ts ? '<SVGSVGElement, SVGProps<SVGSVGElement>>' : '';
    comp = `const ${inner} = forwardRef${gen}((${o.spreadProps ? 'props' : '_props'}, ref) => (\n${body}\n));\n${inner}.displayName = '${name}';`;
  } else {
    comp = `const ${inner} = (${params}) => (\n${body}\n);`;
  }
  if (o.memo) comp += `\n\nconst ${name} = memo(${inner});`;
  const exp = o.exportDefault ? `\n\nexport default ${name};` : '';
  const named = o.exportDefault ? comp : comp.replace(new RegExp(`^const ${name} =`, 'm'), `export const ${name} =`);
  return `${importLines.join('\n')}\n\n${named}${exp}\n`;
}

// ═════════════════════════════════════════════════════════════════════════════
// QR payloads
// ═════════════════════════════════════════════════════════════════════════════

const wifiEsc = (s: string) => s.replace(/([\\;,:"])/g, '\\$1');

export function wifiPayload(ssid: string, password: string, security: 'WPA' | 'WEP' | 'nopass', hidden: boolean): string {
  return `WIFI:T:${security};S:${wifiEsc(ssid)};${security === 'nopass' ? '' : `P:${wifiEsc(password)};`}${hidden ? 'H:true;' : ''};`;
}

export interface VCard { first: string; last: string; org: string; title: string; phone: string; mobile: string; email: string; url: string; street: string; city: string; zip: string; country: string; note: string }

const vEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

export function vcardPayload(v: VCard): string {
  const L = ['BEGIN:VCARD', 'VERSION:3.0', `N:${vEsc(v.last)};${vEsc(v.first)};;;`, `FN:${vEsc([v.first, v.last].filter(Boolean).join(' '))}`];
  if (v.org) L.push(`ORG:${vEsc(v.org)}`);
  if (v.title) L.push(`TITLE:${vEsc(v.title)}`);
  if (v.phone) L.push(`TEL;TYPE=WORK,VOICE:${v.phone}`);
  if (v.mobile) L.push(`TEL;TYPE=CELL:${v.mobile}`);
  if (v.email) L.push(`EMAIL:${v.email}`);
  if (v.url) L.push(`URL:${v.url}`);
  if (v.street || v.city || v.zip || v.country) L.push(`ADR;TYPE=WORK:;;${vEsc(v.street)};${vEsc(v.city)};;${vEsc(v.zip)};${vEsc(v.country)}`);
  if (v.note) L.push(`NOTE:${vEsc(v.note)}`);
  L.push('END:VCARD');
  return L.join('\n');
}

export function mailtoPayload(to: string, subject: string, body: string): string {
  const q = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body)}`].filter(Boolean).join('&');
  return `mailto:${to}${q ? '?' + q : ''}`;
}
export const smsPayload = (num: string, msg: string) => `SMSTO:${num.replace(/[^\d+]/g, '')}:${msg}`;
export const telPayload = (num: string) => `tel:${num.replace(/[^\d+*#]/g, '')}`;
export const geoPayload = (lat: number, lng: number) => `geo:${lat},${lng}`;

// ═════════════════════════════════════════════════════════════════════════════
// CSS generators: shadows, radius, glass, neumorphism, cubic-bezier
// ═════════════════════════════════════════════════════════════════════════════

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3 || h.length === 4) h = h.split('').slice(0, 3).map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r: number, g: number, b: number) {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
const round = (n: number, d = 2) => Number(n.toFixed(d));
export function rgba(hex: string, alpha: number) {
  const [r, g, b] = hexToRgb(hex);
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${round(alpha)})`;
}
/** Lighten (amount > 0) or darken (amount < 0) a colour, amount in -1..1. */
export function shade(hex: string, amount: number) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number) => (amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return rgbToHex(f(r), f(g), f(b));
}

export interface ShadowLayer { x: number; y: number; blur: number; spread: number; color: string; alpha: number; inset: boolean; enabled?: boolean }

export function shadowCss(layers: ShadowLayer[]): string {
  const on2 = layers.filter(l => l.enabled !== false);
  if (!on2.length) return 'none';
  return on2.map(l => `${l.inset ? 'inset ' : ''}${l.x}px ${l.y}px ${l.blur}px ${l.spread}px ${rgba(l.color, l.alpha)}`).join(', ');
}
/** Tailwind arbitrary value: spaces → underscores. */
export const tailwindArbitrary = (prefix: string, css: string) => `${prefix}-[${css.replace(/,\s+/g, ',').replace(/\s+/g, '_')}]`;

export interface RadiusModel { tl: number; tr: number; br: number; bl: number; unit: 'px' | '%' | 'rem' }
export function radiusCss(r: RadiusModel): string {
  const v = [r.tl, r.tr, r.br, r.bl].map(n => (n === 0 ? '0' : `${n}${r.unit}`));
  if (v.every(x => x === v[0])) return v[0];
  if (v[0] === v[2] && v[1] === v[3]) return `${v[0]} ${v[1]}`;
  if (v[1] === v[3]) return `${v[0]} ${v[1]} ${v[2]}`;
  return v.join(' ');
}
/** 8-value elliptical radius: horizontal (top-left, top-right, bottom-right, bottom-left) / vertical (same order). */
export function blobRadiusCss(h: number[], v: number[]): string {
  return `${h.map(n => `${round(n, 1)}%`).join(' ')} / ${v.map(n => `${round(n, 1)}%`).join(' ')}`;
}

export interface GlassModel { blur: number; transparency: number; saturation: number; color: string; border: boolean; borderOpacity: number; radius: number; shadow: boolean }
export function glassCss(g: GlassModel): string {
  const L = [
    `background: ${rgba(g.color, g.transparency)};`,
    `backdrop-filter: blur(${g.blur}px) saturate(${g.saturation}%);`,
    `-webkit-backdrop-filter: blur(${g.blur}px) saturate(${g.saturation}%);`,
    `border-radius: ${g.radius}px;`,
  ];
  if (g.border) L.push(`border: 1px solid ${rgba('#ffffff', g.borderOpacity)};`);
  if (g.shadow) L.push('box-shadow: 0 8px 32px rgb(0 0 0 / 0.15);');
  return L.join('\n');
}

export type NeuShape = 'flat' | 'concave' | 'convex' | 'pressed';
export interface NeuModel { color: string; distance: number; intensity: number; blur: number; radius: number; shape: NeuShape }
export function neumorphismCss(n: NeuModel): string {
  const light = shade(n.color, n.intensity);
  const dark = shade(n.color, -n.intensity);
  const d = n.distance;
  const L = [`border-radius: ${n.radius}px;`];
  if (n.shape === 'flat') L.push(`background: ${n.color};`);
  else if (n.shape === 'concave') L.push(`background: linear-gradient(145deg, ${shade(n.color, -0.1 * (n.intensity / 0.15))}, ${shade(n.color, 0.07 * (n.intensity / 0.15))});`);
  else if (n.shape === 'convex') L.push(`background: linear-gradient(145deg, ${shade(n.color, 0.07 * (n.intensity / 0.15))}, ${shade(n.color, -0.1 * (n.intensity / 0.15))});`);
  else L.push(`background: ${n.color};`);
  if (n.shape === 'pressed') L.push(`box-shadow: inset ${d}px ${d}px ${n.blur}px ${dark}, inset -${d}px -${d}px ${n.blur}px ${light};`);
  else L.push(`box-shadow: ${d}px ${d}px ${n.blur}px ${dark}, -${d}px -${d}px ${n.blur}px ${light};`);
  return L.join('\n');
}

export type Bezier = [number, number, number, number];
export const BEZIER_PRESETS: Record<string, Bezier> = {
  linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1],
  easeInSine: [0.12, 0, 0.39, 0], easeOutSine: [0.61, 1, 0.88, 1], easeInOutSine: [0.37, 0, 0.63, 1],
  easeInQuad: [0.11, 0, 0.5, 0], easeOutQuad: [0.5, 1, 0.89, 1], easeInOutQuad: [0.45, 0, 0.55, 1],
  easeInCubic: [0.32, 0, 0.67, 0], easeOutCubic: [0.33, 1, 0.68, 1], easeInOutCubic: [0.65, 0, 0.35, 1],
  easeInQuart: [0.5, 0, 0.75, 0], easeOutQuart: [0.25, 1, 0.5, 1], easeInOutQuart: [0.76, 0, 0.24, 1],
  easeInExpo: [0.7, 0, 0.84, 0], easeOutExpo: [0.16, 1, 0.3, 1], easeInOutExpo: [0.87, 0, 0.13, 1],
  easeInCirc: [0.55, 0, 1, 0.45], easeOutCirc: [0, 0.55, 0.45, 1], easeInOutCirc: [0.85, 0, 0.15, 1],
  easeInBack: [0.36, 0, 0.66, -0.56], easeOutBack: [0.34, 1.56, 0.64, 1], easeInOutBack: [0.68, -0.6, 0.32, 1.6],
};

export function parseBezier(s: string): Bezier | null {
  const t = s.trim().replace(/;$/, '').replace(/^(transition-timing-function|animation-timing-function)\s*:\s*/i, '');
  const preset = Object.entries(BEZIER_PRESETS).find(([k]) => k.toLowerCase() === t.toLowerCase());
  if (preset) return [...preset[1]] as Bezier;
  const m = /^(?:cubic-bezier\s*\()?\s*([-\d.eE]+)\s*[, ]\s*([-\d.eE]+)\s*[, ]\s*([-\d.eE]+)\s*[, ]\s*([-\d.eE]+)\s*\)?$/.exec(t) ;
  if (!m) return null;
  const v = m.slice(1, 5).map(Number) as Bezier;
  if (v.some(n => !Number.isFinite(n))) return null;
  if (v[0] < 0 || v[0] > 1 || v[2] < 0 || v[2] > 1) return null;
  return v;
}
export const bezierCss = (b: Bezier) => `cubic-bezier(${b.map(n => round(n, 3)).join(', ')})`;

/** y for a given x (0..1), via Newton-Raphson + bisection, like browsers do. */
export function bezierY(b: Bezier, x: number): number {
  const [x1, y1, x2, y2] = b;
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dsx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const e = sx(t) - x;
    if (Math.abs(e) < 1e-6) return sy(t);
    const d = dsx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= e / d;
  }
  let lo = 0; let hi = 1; t = x;
  for (let i = 0; i < 40; i++) {
    const v = sx(t);
    if (Math.abs(v - x) < 1e-6) break;
    if (x > v) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return sy(t);
}

// ═════════════════════════════════════════════════════════════════════════════
// WebSocket close codes
// ═════════════════════════════════════════════════════════════════════════════

export const WS_CLOSE_CODES: Record<number, string> = {
  1000: 'Normal closure — the connection completed its purpose.',
  1001: 'Going away — server shutting down or the browser navigated away.',
  1002: 'Protocol error.',
  1003: 'Unsupported data — e.g. binary received by a text-only endpoint.',
  1005: 'No status code was provided (closed without a code).',
  1006: 'Abnormal closure — the connection dropped without a close frame (network error, TLS/CORS/handshake failure, server unreachable).',
  1007: 'Invalid frame payload data — e.g. non-UTF-8 text.',
  1008: 'Policy violation — e.g. failed auth or origin check.',
  1009: 'Message too big.',
  1010: 'Missing extension — the client expected an extension the server didn’t negotiate.',
  1011: 'Internal server error.',
  1012: 'Service restart.',
  1013: 'Try again later (server overloaded).',
  1014: 'Bad gateway.',
  1015: 'TLS handshake failure.',
};
export function describeCloseCode(code: number): string {
  if (WS_CLOSE_CODES[code]) return WS_CLOSE_CODES[code];
  if (code >= 3000 && code <= 3999) return 'Registered by a library/framework (3000–3999).';
  if (code >= 4000 && code <= 4999) return 'Application-specific code (4000–4999) — see the server’s docs.';
  return 'Unknown close code.';
}
