import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight, ChevronDown, ChevronUp, Copy, Download, Eraser, Eye, FileDown, Import, Loader2, Moon, Pause, Play, Plug, Plus,
  RefreshCw, RotateCcw, Save, Send, Sun, Trash2, Unplug, Upload, Wand2, X,
} from 'lucide-react';
import { Marked } from 'marked';
import { format as formatSqlLib } from 'sql-formatter';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  MONO, FIXED, copyText, downloadBlob, formatBytes, toolsApi, CopyButton, ErrorBox, InfoBox, FieldLabel, Segmented, Checkbox,
  NumberField, Stat,
} from './shared';
import * as L from './lib/dev';

// Developer tools. Everything except the JS/HTML minifiers runs in the browser.

// ═════════════════════════════════════════════════════════════════════════════
// Local UI helpers
// ═════════════════════════════════════════════════════════════════════════════

const SELECT = 'h-8 w-full rounded-md border border-input bg-card px-2 text-xs outline-none focus:border-primary';

function Sel<T extends string>({ value, onChange, options, className, title }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[] | readonly T[]; className?: string; title?: string;
}) {
  const opts = (options as (T | { value: T; label: string })[]).map(o => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <select className={cn(SELECT, className)} value={value} title={title} onChange={e => onChange(e.target.value as T)}>
      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Field({ label, children, className, hint }: { label: React.ReactNode; children: React.ReactNode; className?: string; hint?: React.ReactNode }) {
  return (
    <div className={cn('space-y-1.5 min-w-0', className)}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Slider({ label, value, onChange, min, max, step = 1, suffix = '' }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string;
}) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        <span className="flex items-center gap-1">
          <input
            type="number" value={value} min={min} max={max} step={step}
            onChange={e => e.target.value !== '' && onChange(Number(e.target.value))}
            className="w-16 h-6 rounded border border-input bg-transparent px-1.5 text-right text-xs tabular-nums outline-none focus:border-primary"
          />
          {suffix && <span className="text-[11px] text-muted-foreground w-5">{suffix}</span>}
        </span>
      </div>
      <input type="range" className="w-full accent-[var(--color-primary,currentColor)]" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={e => onChange(e.target.value)}
          className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5" />
        <Input className={MONO} value={text} onChange={e => {
          setText(e.target.value);
          let v = e.target.value.trim();
          if (/^[0-9a-f]{6}$/i.test(v) || /^[0-9a-f]{3}$/i.test(v)) v = '#' + v;
          if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v.slice(1).split('').map(c => c + c).join('');
          if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v.toLowerCase());
        }} />
      </div>
    </Field>
  );
}

/** Read-only code output with copy + optional download. */
function CodeOut({ label, value, filename, mime = 'text/plain', className, extra }: {
  label: React.ReactNode; value: string; filename?: string; mime?: string; className?: string; extra?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 min-w-0">
      <FieldLabel action={
        <span className="flex items-center gap-1">
          {extra}
          {filename && <Button variant="ghost" size="xs" disabled={!value} onClick={() => downloadBlob(value, filename, mime)}><Download /> {filename.startsWith('.') ? filename : 'Download'}</Button>}
          <CopyButton value={value} label="Copy" />
        </span>
      }>{label}</FieldLabel>
      <Textarea readOnly spellCheck={false} className={cn(MONO, FIXED, 'h-72 bg-secondary/40 whitespace-pre', className)} value={value} />
    </div>
  );
}

/** Same look as the shadcn Textarea, but forwards refs (needed for "go to line"). */
const TA_CLASS = 'flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-40';
const RefTextarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(({ className, ...props }, ref) => (
  <textarea ref={ref} data-slot="textarea" className={cn(TA_CLASS, className)} {...props} />
));
RefTextarea.displayName = 'RefTextarea';

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Select a 1-based line in a textarea so users can jump to an error. */
function jumpToLine(ta: HTMLTextAreaElement | null, line?: number, col?: number) {
  if (!ta || !line) return;
  const lines = ta.value.split('\n');
  let start = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
  const end = start + (lines[line - 1]?.length ?? 0);
  ta.focus();
  ta.setSelectionRange(col ? Math.min(start + col - 1, end) : start, end);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  ta.scrollTop = Math.max(0, (line - 4) * lh);
}

function ErrorWithJump({ message, line, col, target }: { message: string; line?: number; col?: number; target: React.RefObject<HTMLTextAreaElement | null> }) {
  return (
    <div className="space-y-1.5">
      <ErrorBox message={message} />
      {line ? <Button variant="outline" size="xs" onClick={() => jumpToLine(target.current, line, col)}>Go to line {line}{col ? `:${col}` : ''}</Button> : null}
    </div>
  );
}

function pickTextFile(accept: string, cb: (text: string, name: string) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) cb(await f.text(), f.name);
  };
  input.click();
}

function LoadFileButton({ accept, onLoad, label = 'Open file' }: { accept: string; onLoad: (text: string, name: string) => void; label?: string }) {
  return <Button variant="ghost" size="xs" onClick={() => pickTextFile(accept, onLoad)}><Upload /> {label}</Button>;
}

const pct = (a: number, b: number) => (a > 0 ? `${Math.round((1 - b / a) * 1000) / 10}%` : '—');

function SizeStats({ sizes, ms }: { sizes: { original: number; minified: number; gzipOriginal?: number; gzipMinified?: number }; ms?: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Original" value={formatBytes(sizes.original)} hint={sizes.gzipOriginal !== undefined ? `${formatBytes(sizes.gzipOriginal)} gzipped` : undefined} />
      <Stat label="Minified" value={formatBytes(sizes.minified)} hint={sizes.gzipMinified !== undefined ? `${formatBytes(sizes.gzipMinified)} gzipped` : undefined} />
      <Stat label="Saved" value={pct(sizes.original, sizes.minified)} hint={`${formatBytes(sizes.original - sizes.minified)} smaller`} />
      <Stat label={sizes.gzipOriginal !== undefined ? 'Saved (gzip)' : 'Time'} value={sizes.gzipOriginal !== undefined ? pct(sizes.gzipOriginal, sizes.gzipMinified ?? 0) : `${ms ?? 0} ms`} hint={ms !== undefined && sizes.gzipOriginal !== undefined ? `${ms} ms` : undefined} />
    </div>
  );
}

/** Editable key / value rows with enable toggles. */
function KvTable({ rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', addLabel = 'Add', suggestions }: {
  rows: L.KV[]; onChange: (rows: L.KV[]) => void; keyPlaceholder?: string; valuePlaceholder?: string; addLabel?: string; suggestions?: string[];
}) {
  const listId = useMemo(() => `kv-${Math.random().toString(36).slice(2)}`, []);
  const set = (i: number, patch: Partial<L.KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {suggestions && <datalist id={listId}>{suggestions.map(s => <option key={s} value={s} />)}</datalist>}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input type="checkbox" title="Enabled" checked={r.enabled !== false} onChange={e => set(i, { enabled: e.target.checked })} />
          <Input className={cn(MONO, 'flex-1 min-w-0')} placeholder={keyPlaceholder} value={r.key} list={suggestions ? listId : undefined} onChange={e => set(i, { key: e.target.value })} />
          <Input className={cn(MONO, 'flex-[1.4] min-w-0')} placeholder={valuePlaceholder} value={r.value} onChange={e => set(i, { value: e.target.value })} />
          <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X /></Button>
        </div>
      ))}
      <Button variant="outline" size="xs" onClick={() => onChange([...rows, { key: '', value: '', enabled: true }])}><Plus /> {addLabel}</Button>
    </div>
  );
}

/** Simple list of strings. */
function ListEditor({ items, onChange, placeholder, addLabel = 'Add' }: { items: string[]; onChange: (v: string[]) => void; placeholder?: string; addLabel?: string }) {
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input className={cn(MONO, 'flex-1 min-w-0')} placeholder={placeholder} value={it} onChange={e => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
          <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}><X /></Button>
        </div>
      ))}
      <Button variant="outline" size="xs" onClick={() => onChange([...items, ''])}><Plus /> {addLabel}</Button>
    </div>
  );
}

function Section({ title, description, children, action, className }: { title: string; description?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0">
            <CardTitle className="text-sm">{title}</CardTitle>
            {description && <CardDescription className="text-xs">{description}</CardDescription>}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

const INDENTS = [{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }, { value: 'tab', label: 'Tab' }] as const;
type IndentKey = typeof INDENTS[number]['value'];
const indentStr = (k: IndentKey) => (k === 'tab' ? '\t' : ' '.repeat(Number(k)));

// ═════════════════════════════════════════════════════════════════════════════
// XML formatter
// ═════════════════════════════════════════════════════════════════════════════

const XML_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns:dc="http://purl.org/dc/elements/1.1/"><!-- Books in stock -->
<book id="bk101" lang="en"><dc:title>XML Developer's Guide</dc:title><author>Gambardella, Matthew</author>
<price currency="USD">44.95</price><tags><tag>xml</tag><tag>reference</tag></tags>
<description>An in-depth look at creating applications with <em>XML</em>.</description><cover/></book>
<book id="bk102" lang="en"><dc:title>Midnight Rain</dc:title><author>Ralls, Kim</author><price currency="USD">5.95</price>
<notes><![CDATA[Contains <markup> & special chars]]></notes></book></catalog>`;

export function XmlFormatter() {
  const [input, setInput] = useState(XML_SAMPLE);
  const [mode, setMode] = useState<'format' | 'minify'>('format');
  const [indent, setIndent] = useState<IndentKey>('2');
  const [attrsPerLine, setAttrsPerLine] = useState(false);
  const [collapseEmpty, setCollapseEmpty] = useState(true);
  const [removeComments, setRemoveComments] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const src = useDebounced(input, 150);

  const result = useMemo(() => {
    if (!src.trim()) return { output: '', error: null as L.SourceError | null, stats: null, warning: '' };
    try {
      const nodes = L.parseXml(src);
      const output = mode === 'minify'
        ? L.minifyXml(src, { removeComments })
        : L.formatXml(src, { indent: indentStr(indent), attrsPerLine, collapseEmpty, removeComments });
      // Second opinion from the browser's XML parser (catches undefined entities etc.).
      let warning = '';
      const doc = new DOMParser().parseFromString(src, 'application/xml');
      const pe = doc.getElementsByTagName('parsererror')[0];
      if (pe) warning = (pe.textContent || 'XML parser error').replace(/\s+/g, ' ').replace(/^.*?error/i, 'Browser parser: error').slice(0, 300);
      return { output, error: null, stats: L.xmlStats(nodes), warning };
    } catch (e) {
      return { output: '', error: e instanceof L.SourceError ? e : new L.SourceError((e as Error).message), stats: null, warning: '' };
    }
  }, [src, mode, indent, attrsPerLine, collapseEmpty, removeComments]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'format', label: 'Pretty print' }, { value: 'minify', label: 'Minify' }]} />
        {mode === 'format' && <Segmented value={indent} onChange={setIndent} options={[...INDENTS]} />}
        {mode === 'format' && <Checkbox checked={attrsPerLine} onChange={setAttrsPerLine}>Attribute per line</Checkbox>}
        {mode === 'format' && <Checkbox checked={collapseEmpty} onChange={setCollapseEmpty}>Self-close empty</Checkbox>}
        <Checkbox checked={removeComments} onChange={setRemoveComments}>Remove comments</Checkbox>
        {input.trim() && (result.error ? <Badge variant="destructive">Invalid</Badge> : <Badge>Well-formed</Badge>)}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<span className="flex gap-1"><LoadFileButton accept=".xml,.svg,.xsd,.xsl,.rss,.atom,.plist,.config,text/xml" onLoad={t => setInput(t)} /><Button variant="ghost" size="xs" onClick={() => setInput('')}>Clear</Button></span>}>Input</FieldLabel>
          <RefTextarea ref={taRef} className={cn(MONO, FIXED, 'h-96')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} placeholder="Paste XML…" />
        </div>
        <div className="space-y-2 min-w-0">
          {result.error
            ? <ErrorWithJump message={result.error.message} line={result.error.line} col={result.error.col} target={taRef} />
            : <CodeOut label="Output" value={result.output} filename={mode === 'minify' ? 'output.min.xml' : 'output.xml'} mime="application/xml" className="h-96" />}
          {result.warning && <InfoBox>{result.warning}</InfoBox>}
        </div>
      </div>
      {result.stats && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Elements" value={result.stats.elements} />
          <Stat label="Attributes" value={result.stats.attributes} />
          <Stat label="Max depth" value={result.stats.maxDepth} />
          <Stat label="Size" value={formatBytes(L.utf8Len(result.output))} hint={`input ${formatBytes(L.utf8Len(input))}`} />
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CSS formatter
// ═════════════════════════════════════════════════════════════════════════════

const CSS_SAMPLE = `/*! Theme v2 */
:root{--brand:#4f46e5;--radius:.5rem}
.card , .panel>.body{padding:1rem 1.25rem;border-radius:var(--radius);color:#111827;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.card:hover{box-shadow:0 4px 12px rgba(0,0,0,0.12)!important;transform:translateY(-1px)}
.btn{display:inline-flex;align-items:center;gap:.5rem;background:var(--brand);color:white;transition:background .2s ease-in-out}
.btn::after{content:"→";margin-left:4px}
@media (max-width:640px){.card{padding:.75rem}.btn{width:100%;justify-content:center}}
@supports (backdrop-filter:blur(4px)){.glass{backdrop-filter:blur(4px);background:hsl(0 0% 100% / .6)}}`;

export function CssFormatter() {
  const [input, setInput] = useState(CSS_SAMPLE);
  const [mode, setMode] = useState<'beautify' | 'minify'>('beautify');
  const [indent, setIndent] = useState<IndentKey>('2');
  const [sort, setSort] = useState(false);
  const [selectorPerLine, setSelectorPerLine] = useState(true);
  const [removeComments, setRemoveComments] = useState(false);
  const [keepLicense, setKeepLicense] = useState(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const src = useDebounced(input, 150);

  const result = useMemo(() => {
    if (!src.trim()) return { output: '', error: null as L.SourceError | null, stats: null as ReturnType<typeof L.cssStats> | null, minLen: 0 };
    try {
      const output = mode === 'minify'
        ? L.minifyCss(src, { keepLicense })
        : L.beautifyCss(src, { indent: indentStr(indent), sortProperties: sort, selectorPerLine, removeComments });
      const minLen = L.utf8Len(mode === 'minify' ? output : L.minifyCss(src, { keepLicense }));
      return { output, error: null, stats: L.cssStats(src), minLen };
    } catch (e) {
      return { output: '', error: e instanceof L.SourceError ? e : new L.SourceError((e as Error).message), stats: null, minLen: 0 };
    }
  }, [src, mode, indent, sort, selectorPerLine, removeComments, keepLicense]);

  const inLen = L.utf8Len(src);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'beautify', label: 'Beautify' }, { value: 'minify', label: 'Minify' }]} />
        {mode === 'beautify' ? (
          <>
            <Segmented value={indent} onChange={setIndent} options={[...INDENTS]} />
            <Checkbox checked={sort} onChange={setSort}>Sort properties</Checkbox>
            <Checkbox checked={selectorPerLine} onChange={setSelectorPerLine}>Selector per line</Checkbox>
            <Checkbox checked={removeComments} onChange={setRemoveComments}>Remove comments</Checkbox>
          </>
        ) : <Checkbox checked={keepLicense} onChange={setKeepLicense}>Keep /*! license */ comments</Checkbox>}
        {input.trim() && (result.error ? <Badge variant="destructive">Syntax error</Badge> : <Badge>Valid</Badge>)}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<span className="flex gap-1"><LoadFileButton accept=".css,text/css" onLoad={t => setInput(t)} /><Button variant="ghost" size="xs" onClick={() => setInput('')}>Clear</Button></span>}>Input</FieldLabel>
          <RefTextarea ref={taRef} className={cn(MONO, FIXED, 'h-96')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} placeholder="Paste CSS…" />
        </div>
        {result.error
          ? <ErrorWithJump message={result.error.message} line={result.error.line} col={result.error.col} target={taRef} />
          : <CodeOut label="Output" value={result.output} filename={mode === 'minify' ? 'styles.min.css' : 'styles.css'} mime="text/css" className="h-96" />}
      </div>
      {result.stats && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            <Stat label="Rules" value={result.stats.rules} hint={`${result.stats.selectors} selectors`} />
            <Stat label="Declarations" value={result.stats.declarations} />
            <Stat label="At-rules" value={result.stats.atRules} hint={`${result.stats.media} @media`} />
            <Stat label="!important" value={result.stats.important} />
            <Stat label="Input size" value={formatBytes(inLen)} />
            <Stat label="Minified" value={formatBytes(result.minLen)} hint={`${pct(inLen, result.minLen)} smaller`} />
          </div>
          {result.stats.colors.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground mr-1">Colours ({result.stats.colors.length}):</span>
              {result.stats.colors.slice(0, 40).map(c => (
                <button key={c} type="button" title={`Copy ${c}`} onClick={() => copyText(c)}
                  className="flex items-center gap-1 rounded border border-border bg-secondary/40 px-1.5 py-0.5 text-[11px] font-mono cursor-pointer hover:border-primary">
                  <span className="size-3 rounded-sm border border-border" style={{ background: c }} />{c}
                </button>
              ))}
            </div>
          )}
          {result.stats.topProps.length > 0 && (
            <p className="text-[11px] text-muted-foreground">Most used: {result.stats.topProps.map(([p, n]) => `${p} ×${n}`).join(' · ')}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// HTML entities
// ═════════════════════════════════════════════════════════════════════════════

let decoderDoc: Document | null = null;
/** Decode every HTML5 named + numeric reference using the browser's own parser, in an inert document. */
function decodeHtml(s: string): string {
  decoderDoc ??= document.implementation.createHTMLDocument('');
  const ta = decoderDoc.createElement('textarea');
  ta.innerHTML = s; // textarea content is RCDATA: tags stay text, only character references are decoded
  return ta.value;
}

const COMMON_ENTITIES: [string, string][] = [
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&nbsp;', ' '], ['&copy;', '©'], ['&reg;', '®'],
  ['&trade;', '™'], ['&euro;', '€'], ['&pound;', '£'], ['&yen;', '¥'], ['&deg;', '°'], ['&plusmn;', '±'], ['&times;', '×'], ['&divide;', '÷'],
  ['&mdash;', '—'], ['&ndash;', '–'], ['&hellip;', '…'], ['&laquo;', '«'], ['&raquo;', '»'], ['&ldquo;', '“'], ['&rdquo;', '”'], ['&bull;', '•'],
  ['&larr;', '←'], ['&rarr;', '→'], ['&uarr;', '↑'], ['&darr;', '↓'], ['&hearts;', '♥'], ['&check;', '✓'], ['&infin;', '∞'], ['&ne;', '≠'],
];

export function HtmlEntities() {
  const [mode, setMode] = useState<'encode' | 'decode'>('encode');
  const [encMode, setEncMode] = useState<L.EntityMode>('named');
  const [hex, setHex] = useState(true);
  const [quotes, setQuotes] = useState(true);
  const [input, setInput] = useState('<p class="note">Café & crème brûlée — only €4.50 © 2025 ✓ 😀</p>');

  const output = useMemo(() => (mode === 'encode' ? L.encodeEntities(input, encMode, { hex, quotes }) : decodeHtml(input)), [input, mode, encMode, hex, quotes]);
  const refs = mode === 'decode' ? (input.match(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi)?.length ?? 0) : (output.match(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi)?.length ?? 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'encode', label: 'Encode' }, { value: 'decode', label: 'Decode' }]} />
        {mode === 'encode' && (
          <>
            <Segmented value={encMode} onChange={setEncMode} options={[
              { value: 'minimal', label: 'Minimal (& < > " \')' }, { value: 'named', label: 'Named + non-ASCII' }, { value: 'numeric', label: 'All non-ASCII numeric' },
            ]} />
            {encMode !== 'minimal' && <Checkbox checked={hex} onChange={setHex}>Hex (&amp;#x…;)</Checkbox>}
            <Checkbox checked={quotes} onChange={setQuotes}>Escape quotes</Checkbox>
          </>
        )}
        <Button variant="outline" size="sm" disabled={!output} onClick={() => { setInput(output); setMode(mode === 'encode' ? 'decode' : 'encode'); }}>
          <ArrowLeftRight /> Swap
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setInput('')}>Clear</Button>}>{mode === 'encode' ? 'Text / HTML' : 'Encoded HTML'}</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-56')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5 min-w-0">
          <CodeOut label={<>{mode === 'encode' ? 'Encoded' : 'Decoded'} <span className="font-normal">· {refs} reference{refs === 1 ? '' : 's'} · {output.length} chars</span></>} value={output} className="h-56 whitespace-pre-wrap" />
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Common entities — click to copy</p>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-8">
          {COMMON_ENTITIES.map(([ent, ch]) => (
            <button key={ent} type="button" onClick={() => copyText(ent)} title={`Copy ${ent}`}
              className="flex items-center justify-between gap-2 rounded border border-border bg-secondary/30 px-2 py-1 text-xs cursor-pointer hover:border-primary min-w-0">
              <span className="text-sm w-4 text-center">{ch === ' ' ? '␣' : ch}</span>
              <code className="font-mono text-[11px] text-muted-foreground truncate">{ent}</code>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Markdown → HTML
// ═════════════════════════════════════════════════════════════════════════════

const MD_SAMPLE = `# Project title

A short description with **bold**, _italic_, \`inline code\` and a [link](https://example.com).

## Features

- [x] GitHub-flavoured Markdown
- [x] Tables, task lists, ~~strikethrough~~
- [ ] Your next idea

| Command | Description |
| ------- | ----------- |
| \`npm run dev\` | Start the dev server |
| \`npm test\` | Run the tests |

\`\`\`ts
export function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

> **Note**
> Raw HTML is rendered in a sandboxed frame, so scripts never run here.

1. First
2. Second
   - nested item

---

![Placeholder](https://placehold.co/320x80/png)
`;

const MD_CSS = `:root{color-scheme:light dark}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;max-width:820px;margin:0 auto;padding:24px;color:#1f2328;background:#fff;word-wrap:break-word}
h1,h2,h3,h4{line-height:1.25;margin:1.5em 0 .5em}h1,h2{border-bottom:1px solid #d1d9e0;padding-bottom:.3em}
a{color:#0969da}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:85%}
code{background:rgba(129,139,152,.15);padding:.2em .4em;border-radius:6px}pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:0;padding:0 1em;color:#59636e;border-left:.25em solid #d1d9e0}table{border-collapse:collapse;display:block;overflow:auto}
th,td{border:1px solid #d1d9e0;padding:6px 13px}tr:nth-child(2n){background:#f6f8fa}img{max-width:100%}hr{border:0;border-top:1px solid #d1d9e0;margin:24px 0}
ul.contains-task-list,li:has(>input[type=checkbox]){list-style:none}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#4493f8}pre,tr:nth-child(2n){background:#161b22}th,td,h1,h2,hr{border-color:#3d444d}blockquote{color:#9198a1;border-color:#3d444d}}`;

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function MarkdownToHtml() {
  const [md, setMd] = useState(MD_SAMPLE);
  const [gfm, setGfm] = useState(true);
  const [breaks, setBreaks] = useState(false);
  const [escapeRaw, setEscapeRaw] = useState(false);
  const [view, setView] = useState<'split' | 'edit' | 'preview' | 'html'>('split');
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const src = useDebounced(md, 120);

  const html = useMemo(() => {
    const m = new Marked({ gfm, breaks, async: false });
    if (escapeRaw) m.use({ renderer: { html: (tok: { text: string }) => escHtml(tok.text) } as never });
    try { return m.parse(src) as string; } catch (e) { return `<pre>${escHtml((e as Error).message)}</pre>`; }
  }, [src, gfm, breaks, escapeRaw]);

  const fullDoc = (themeCss = true) => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escHtml((/^#\s+(.+)$/m.exec(src)?.[1] ?? 'Document').trim())}</title>\n${themeCss ? `<style>\n${MD_CSS}\n</style>\n` : ''}</head>\n<body>\n${html}\n</body>\n</html>\n`;
  // Preview: forced colour scheme so it matches the dashboard theme toggle; links open in a new tab.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${MD_CSS}</style><style>:root{color-scheme:${dark ? 'dark' : 'light'}}</style>${dark ? `<style>body{color:#e6edf3;background:#0d1117}a{color:#4493f8}pre,tr:nth-child(2n){background:#161b22}th,td,h1,h2,hr{border-color:#3d444d}blockquote{color:#9198a1;border-color:#3d444d}</style>` : '<style>body{color:#1f2328;background:#fff}pre,tr:nth-child(2n){background:#f6f8fa}</style>'}</head><body>${html}</body></html>`;

  const words = src.trim() ? src.trim().split(/\s+/).length : 0;
  const editor = <Textarea className={cn(MONO, FIXED, 'h-[28rem]')} value={md} onChange={e => setMd(e.target.value)} spellCheck={false} placeholder="Write Markdown…" />;
  const preview = (
    <iframe title="Markdown preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc}
      className="h-[28rem] w-full rounded-md border border-border bg-white" />
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={view} onChange={setView} options={[{ value: 'split', label: 'Split' }, { value: 'edit', label: 'Editor' }, { value: 'preview', label: 'Preview' }, { value: 'html', label: 'HTML' }]} />
        <Checkbox checked={gfm} onChange={setGfm}>GFM</Checkbox>
        <Checkbox checked={breaks} onChange={setBreaks}>Line breaks → &lt;br&gt;</Checkbox>
        <Checkbox checked={escapeRaw} onChange={setEscapeRaw}>Escape raw HTML</Checkbox>
        <Button variant="ghost" size="icon-xs" title="Toggle preview theme" onClick={() => setDark(d => !d)}>{dark ? <Sun /> : <Moon />}</Button>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <LoadFileButton accept=".md,.markdown,.txt,text/markdown" onLoad={t => setMd(t)} />
          <CopyButton value={html} label="Copy HTML" />
          <Button variant="outline" size="xs" onClick={() => downloadBlob(fullDoc(), 'document.html', 'text/html')}><Download /> .html</Button>
          <Button variant="ghost" size="xs" onClick={() => downloadBlob(md, 'document.md', 'text/markdown')}><Download /> .md</Button>
        </span>
      </div>
      {view === 'split' && <div className="grid gap-3 lg:grid-cols-2">{editor}{preview}</div>}
      {view === 'edit' && editor}
      {view === 'preview' && preview}
      {view === 'html' && <CodeOut label="HTML" value={html} filename="fragment.html" mime="text/html" className="h-[28rem]" />}
      <p className="text-[11px] text-muted-foreground">{words} words · {src.length} characters · ~{Math.max(1, Math.round(words / 230))} min read · preview is sandboxed (no scripts)</p>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// JSON ⇄ YAML
// ═════════════════════════════════════════════════════════════════════════════

const JY_JSON = `{
  "name": "my-service",
  "version": "1.4.0",
  "replicas": 3,
  "enabled": true,
  "tags": ["api", "public"],
  "env": { "NODE_ENV": "production", "PORT": "8080", "GREETING": "yes: really" },
  "probes": [{ "path": "/health", "interval": 10 }, { "path": "/ready", "interval": 5 }],
  "notes": "multi-line\\ntext block",
  "owner": null
}`;

export function JsonYamlConverter() {
  const [dir, setDir] = useState<'json2yaml' | 'yaml2json'>('json2yaml');
  const [input, setInput] = useState(JY_JSON);
  const [indent, setIndent] = useState<'2' | '4' | 'tab' | 'min'>('2');
  const [sortKeys, setSortKeys] = useState(false);
  const [multiDoc, setMultiDoc] = useState(false);
  const [quote, setQuote] = useState<'single' | 'double'>('single');
  const [flow, setFlow] = useState(false);
  const [multi, setMulti] = useState<'array' | 'first'>('array');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const src = useDebounced(input, 150);

  const res = useMemo<L.YamlResult>(() => {
    if (!src.trim()) return { output: '' };
    if (dir === 'json2yaml') {
      return L.jsonToYaml(src, { indent: indent === 'tab' || indent === 'min' ? 2 : Number(indent), sortKeys, multiDoc, quoteStyle: quote, flowLevel: flow ? 2 : -1 });
    }
    return L.yamlToJson(src, { indent: indent === 'min' ? 0 : indent === 'tab' ? -1 : Number(indent), multi });
  }, [src, dir, indent, sortKeys, multiDoc, quote, flow, multi]);

  const swap = () => {
    if (res.error || !res.output) { setDir(d => (d === 'json2yaml' ? 'yaml2json' : 'json2yaml')); return; }
    setInput(res.output);
    setDir(d => (d === 'json2yaml' ? 'yaml2json' : 'json2yaml'));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={dir} onChange={setDir} options={[{ value: 'json2yaml', label: 'JSON → YAML' }, { value: 'yaml2json', label: 'YAML → JSON' }]} />
        <Button variant="outline" size="sm" onClick={swap}><ArrowLeftRight /> Swap</Button>
        <Segmented value={indent} onChange={setIndent} options={dir === 'json2yaml'
          ? [{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }]
          : [{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }, { value: 'tab', label: 'Tab' }, { value: 'min', label: 'Minify' }]} />
        {dir === 'json2yaml' ? (
          <>
            <Checkbox checked={sortKeys} onChange={setSortKeys}>Sort keys</Checkbox>
            <Checkbox checked={multiDoc} onChange={setMultiDoc}>Top-level array → documents</Checkbox>
            <Checkbox checked={flow} onChange={setFlow}>Inline deep collections</Checkbox>
            <Sel className="w-auto" value={quote} onChange={setQuote} options={[{ value: 'single', label: "'single' quotes" }, { value: 'double', label: '"double" quotes' }]} />
          </>
        ) : (
          <Sel className="w-auto" value={multi} onChange={setMulti} options={[{ value: 'array', label: 'Multiple docs → array' }, { value: 'first', label: 'Only first document' }]} />
        )}
        {src.trim() && (res.error ? <Badge variant="destructive">Invalid {dir === 'json2yaml' ? 'JSON' : 'YAML'}</Badge> : <Badge>{res.docs && res.docs > 1 ? `${res.docs} documents` : 'Valid'}</Badge>)}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<span className="flex gap-1"><LoadFileButton accept=".json,.yaml,.yml" onLoad={(t, n) => { setInput(t); setDir(/\.ya?ml$/i.test(n) ? 'yaml2json' : 'json2yaml'); }} /><Button variant="ghost" size="xs" onClick={() => setInput('')}>Clear</Button></span>}>{dir === 'json2yaml' ? 'JSON' : 'YAML'}</FieldLabel>
          <RefTextarea ref={taRef} className={cn(MONO, FIXED, 'h-96')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} />
        </div>
        {res.error
          ? <ErrorWithJump message={res.error} line={res.line} col={res.col} target={taRef} />
          : <CodeOut label={dir === 'json2yaml' ? 'YAML' : 'JSON'} value={res.output} filename={dir === 'json2yaml' ? 'output.yaml' : 'output.json'} mime={dir === 'json2yaml' ? 'application/yaml' : 'application/json'} className="h-96" />}
      </div>
      <InfoBox>YAML is parsed with the YAML 1.2 core schema: <code>yes</code>/<code>no</code>/<code>on</code> stay strings, dates stay strings, and anchors/aliases are expanded. Strings that would be ambiguous are quoted on output.</InfoBox>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SQL formatter & sanitizer
// ═════════════════════════════════════════════════════════════════════════════

type SqlLang = NonNullable<Parameters<typeof formatSqlLib>[1]>['language'] & string;
const SQL_DIALECTS: { value: SqlLang; label: string }[] = [
  { value: 'sql', label: 'Standard SQL' }, { value: 'postgresql', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' },
  { value: 'mariadb', label: 'MariaDB' }, { value: 'sqlite', label: 'SQLite' }, { value: 'transactsql', label: 'SQL Server (T-SQL)' },
  { value: 'plsql', label: 'Oracle PL/SQL' }, { value: 'bigquery', label: 'BigQuery' }, { value: 'snowflake', label: 'Snowflake' },
  { value: 'redshift', label: 'Redshift' }, { value: 'clickhouse', label: 'ClickHouse' }, { value: 'duckdb', label: 'DuckDB' },
  { value: 'trino', label: 'Trino / Presto' }, { value: 'spark', label: 'Spark SQL' }, { value: 'hive', label: 'Hive' },
  { value: 'db2', label: 'DB2' }, { value: 'singlestoredb', label: 'SingleStore' }, { value: 'tidb', label: 'TiDB' }, { value: 'n1ql', label: 'N1QL (Couchbase)' },
];

const SQL_SAMPLE = `-- active customers with their latest order
select c.id, c.name, c.email, count(o.id) as orders, max(o.created_at) as last_order /* newest */
from customers c left join orders o on o.customer_id = c.id and o.status in ('paid','shipped')
where c.created_at >= '2024-01-01' and c.country = 'DE' and c.score > 4.5
group by c.id, c.name, c.email having count(o.id) > 2 order by last_order desc limit 50;
update customers set last_seen = now() where id = 42;`;

export function SqlFormatter() {
  const [input, setInput] = useState(SQL_SAMPLE);
  const [tab, setTab] = useState<'format' | 'sanitize' | 'parameterize'>('format');
  const [lang, setLang] = useState<SqlLang>('postgresql');
  const [kwCase, setKwCase] = useState<'preserve' | 'upper' | 'lower'>('upper');
  const [fnCase, setFnCase] = useState<'preserve' | 'upper' | 'lower'>('preserve');
  const [indent, setIndent] = useState<IndentKey>('2');
  const [linesBetween, setLinesBetween] = useState(1);
  const [indentStyle, setIndentStyle] = useState<'standard' | 'tabularLeft' | 'tabularRight'>('standard');
  const [logicalNl, setLogicalNl] = useState<'before' | 'after'>('before');
  const [dense, setDense] = useState(false);
  const [stripFirst, setStripFirst] = useState(false);
  const [san, setSan] = useState<L.SqlSanitizeOptions>({ stripComments: true, collapseWhitespace: true, smartQuotes: true, identifierQuotes: 'keep' });
  const [pStyle, setPStyle] = useState<L.ParamStyle>('$n');
  const [pNumbers, setPNumbers] = useState(true);
  const src = useDebounced(input, 200);
  const hash = lang === 'mysql' || lang === 'mariadb';

  const res = useMemo(() => {
    if (!src.trim()) return { output: '', error: '', params: null as (string | number)[] | null };
    try {
      if (tab === 'format') {
        const s = stripFirst ? L.sanitizeSql(src, { stripComments: true, hashComments: hash }) : src;
        const output = formatSqlLib(s, {
          language: lang, keywordCase: kwCase, functionCase: fnCase, dataTypeCase: kwCase, tabWidth: indent === 'tab' ? 2 : Number(indent), useTabs: indent === 'tab',
          linesBetweenQueries: linesBetween, indentStyle, logicalOperatorNewline: logicalNl, denseOperators: dense,
        });
        return { output, error: '', params: null };
      }
      if (tab === 'sanitize') return { output: L.sanitizeSql(src, { ...san, hashComments: hash }), error: '', params: null };
      const clean = L.sanitizeSql(src, { stripComments: true, hashComments: hash });
      const r = L.parameterizeSql(clean, pStyle, { numbers: pNumbers });
      let output = r.sql;
      try { output = formatSqlLib(r.sql, { language: lang, keywordCase: kwCase, paramTypes: { positional: true, numbered: ['$'], named: [':', '@'] } }); } catch { /* keep unformatted */ }
      return { output, error: '', params: r.params };
    } catch (e) {
      return { output: '', error: (e as Error).message, params: null };
    }
  }, [src, tab, lang, kwCase, fnCase, indent, linesBetween, indentStyle, logicalNl, dense, stripFirst, san, pStyle, pNumbers, hash]);

  const statements = useMemo(() => L.tokenizeSql(src, { hashComments: hash }).filter(t => t.t === 'op' && t.v === ';').length, [src, hash]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'format', label: 'Format' }, { value: 'sanitize', label: 'Sanitize' }, { value: 'parameterize', label: 'Parameterize' }]} />
        <Sel className="w-48" value={lang} onChange={setLang} options={SQL_DIALECTS} title="Dialect" />
      </div>
      <div className="rounded-md border border-border bg-secondary/20 p-3">
        {tab === 'format' && (
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Field label="Keyword case"><Sel value={kwCase} onChange={setKwCase} options={[{ value: 'upper', label: 'UPPER' }, { value: 'lower', label: 'lower' }, { value: 'preserve', label: 'Preserve' }]} /></Field>
            <Field label="Function case"><Sel value={fnCase} onChange={setFnCase} options={[{ value: 'preserve', label: 'Preserve' }, { value: 'upper', label: 'UPPER' }, { value: 'lower', label: 'lower' }]} /></Field>
            <Field label="Indent"><Sel value={indent} onChange={setIndent} options={[...INDENTS]} /></Field>
            <Field label="Indent style"><Sel value={indentStyle} onChange={setIndentStyle} options={[{ value: 'standard', label: 'Standard' }, { value: 'tabularLeft', label: 'Tabular left' }, { value: 'tabularRight', label: 'Tabular right' }]} /></Field>
            <Field label="AND / OR"><Sel value={logicalNl} onChange={setLogicalNl} options={[{ value: 'before', label: 'Newline before' }, { value: 'after', label: 'Newline after' }]} /></Field>
            <NumberField label="Lines between queries" value={linesBetween} min={0} max={5} onChange={v => setLinesBetween(Number.isFinite(v) ? Math.max(0, Math.min(5, v)) : 1)} />
            <div className="col-span-full flex flex-wrap gap-3">
              <Checkbox checked={dense} onChange={setDense}>Dense operators (a=b)</Checkbox>
              <Checkbox checked={stripFirst} onChange={setStripFirst}>Strip comments first</Checkbox>
            </div>
          </div>
        )}
        {tab === 'sanitize' && (
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox checked={!!san.stripComments} onChange={v => setSan({ ...san, stripComments: v })}>Strip comments</Checkbox>
            <Checkbox checked={!!san.collapseWhitespace} onChange={v => setSan({ ...san, collapseWhitespace: v })}>Collapse whitespace</Checkbox>
            <Checkbox checked={!!san.smartQuotes} onChange={v => setSan({ ...san, smartQuotes: v })}>Smart quotes → straight</Checkbox>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">Identifier quotes
              <Sel className="w-44" value={san.identifierQuotes ?? 'keep'} onChange={v => setSan({ ...san, identifierQuotes: v })} options={[
                { value: 'keep', label: 'Keep as written' }, { value: 'ansi', label: '"ANSI" (Postgres…)' }, { value: 'mysql', label: '`backticks` (MySQL)' }, { value: 'tsql', label: '[brackets] (SQL Server)' },
              ]} />
            </span>
          </div>
        )}
        {tab === 'parameterize' && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">Placeholder
              <Sel className="w-48" value={pStyle} onChange={setPStyle} options={[
                { value: '$n', label: '$1, $2 (Postgres)' }, { value: '?', label: '? (MySQL, SQLite, JDBC)' }, { value: ':name', label: ':p1 (Oracle, SQLAlchemy)' },
                { value: '@name', label: '@p1 (SQL Server)' }, { value: '%s', label: '%s (psycopg / MySQLdb)' },
              ]} />
            </span>
            <Checkbox checked={pNumbers} onChange={setPNumbers}>Numbers too (not just strings)</Checkbox>
            <span className="text-[11px] text-muted-foreground">Comments are stripped; literals become bind parameters — useful for logging, query fingerprinting and fixing injection-prone code.</span>
          </div>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<span className="flex gap-1"><LoadFileButton accept=".sql,.txt" onLoad={t => setInput(t)} /><Button variant="ghost" size="xs" onClick={() => setInput('')}>Clear</Button></span>}>
            SQL <span className="font-normal">· {statements || (src.trim() ? 1 : 0)} statement{statements === 1 ? '' : 's'}</span>
          </FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-96')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-2 min-w-0">
          {res.error ? <ErrorBox message={`Could not parse as ${SQL_DIALECTS.find(d => d.value === lang)?.label}: ${res.error}`} /> : (
            <CodeOut label="Result" value={res.output} filename="query.sql" mime="application/sql" className={res.params ? 'h-60' : 'h-96'} />
          )}
          {res.params && (
            <CodeOut label={`Parameters (${res.params.length})`} value={JSON.stringify(res.params, null, 2)} className="h-28" />
          )}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// cURL builder
// ═════════════════════════════════════════════════════════════════════════════

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const HEADER_SUGGESTIONS = ['Accept', 'Accept-Language', 'Accept-Encoding', 'Authorization', 'Cache-Control', 'Content-Type', 'Cookie', 'If-None-Match', 'Origin', 'Referer', 'User-Agent', 'X-Requested-With', 'X-API-Key', 'X-Request-ID'];

const sampleRequest = (): L.HttpRequestModel => ({
  ...L.emptyRequest(),
  method: 'POST',
  url: 'https://api.example.com/v1/users',
  query: [{ key: 'notify', value: 'true', enabled: true }],
  headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
  bodyType: 'json',
  body: '{\n  "name": "Ada Lovelace",\n  "email": "ada@example.com",\n  "roles": ["admin"]\n}',
  auth: { type: 'bearer', user: '', pass: '', token: '<YOUR_TOKEN>', keyName: 'X-API-Key', keyValue: '' },
  flags: { location: true, insecure: false, verbose: false, compressed: true, include: false, silent: false },
  timeout: 30,
});

type CodeTarget = 'curl' | 'fetch' | 'axios' | 'python' | 'httpie' | 'go';

export function CurlBuilder() {
  const [m, setM] = useState<L.HttpRequestModel>(sampleRequest);
  const [tab, setTab] = useState<'params' | 'headers' | 'body' | 'auth' | 'options'>('body');
  const [target, setTarget] = useState<CodeTarget>('curl');
  const [shell, setShell] = useState<L.Shell>('bash');
  const [multiline, setMultiline] = useState(true);
  const [importText, setImportText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importMsg, setImportMsg] = useState<{ error?: string; warnings?: string[]; ok?: boolean }>({});
  const set = (patch: Partial<L.HttpRequestModel>) => setM(prev => ({ ...prev, ...patch }));

  const jsonError = useMemo(() => {
    if (m.bodyType !== 'json' || !m.body.trim()) return '';
    try { JSON.parse(m.body); return ''; } catch (e) { return (e as Error).message; }
  }, [m.bodyType, m.body]);
  const urlError = useMemo(() => {
    if (!m.url.trim()) return 'Enter a URL';
    try { const u = new URL(m.url); return /^https?:$/.test(u.protocol) ? '' : 'Only http(s) URLs'; } catch { return 'Not a valid absolute URL'; }
  }, [m.url]);

  const code = useMemo(() => {
    switch (target) {
      case 'curl': return L.toCurl(m, shell, { multiline });
      case 'fetch': return L.toFetch(m);
      case 'axios': return L.toAxios(m);
      case 'python': return L.toPython(m);
      case 'httpie': return L.toHttpie(m);
      case 'go': return L.toGo(m);
    }
  }, [m, target, shell, multiline]);

  /** Move a query string typed into the URL box into the params table. */
  const extractQuery = () => {
    const qi = m.url.indexOf('?');
    if (qi < 0) return;
    const hash = m.url.indexOf('#', qi);
    const qs = m.url.slice(qi + 1, hash < 0 ? undefined : hash);
    const dec = (x: string) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
    const rows = qs.split('&').filter(Boolean).map(p => { const e = p.indexOf('='); return { key: dec(e < 0 ? p : p.slice(0, e)), value: e < 0 ? '' : dec(p.slice(e + 1)), enabled: true }; });
    set({ url: m.url.slice(0, qi) + (hash < 0 ? '' : m.url.slice(hash)), query: [...m.query, ...rows] });
  };

  const doImport = () => {
    try {
      const { model, warnings } = L.parseCurl(importText);
      setM(model);
      setTab(model.bodyType !== 'none' ? 'body' : model.headers.length ? 'headers' : 'params');
      setImportMsg({ ok: true, warnings });
    } catch (e) {
      setImportMsg({ error: (e as Error).message });
    }
  };

  const count = (l: { key: string; enabled?: boolean }[]) => l.filter(x => x.enabled !== false && x.key.trim()).length;
  const tabs: { value: typeof tab; label: string }[] = [
    { value: 'params', label: `Params${count(m.query) ? ` (${count(m.query)})` : ''}` },
    { value: 'headers', label: `Headers${count(m.headers) ? ` (${count(m.headers)})` : ''}` },
    { value: 'body', label: `Body${m.bodyType !== 'none' ? ' •' : ''}` },
    { value: 'auth', label: `Auth${m.auth.type !== 'none' ? ' •' : ''}` },
    { value: 'options', label: 'Options' },
  ];

  return (
    <div className="space-y-3">
      <Section
        title="Import cURL"
        description="Paste a command from DevTools (“Copy as cURL” — bash or cmd), docs or a terminal."
        action={<Button variant="ghost" size="xs" onClick={() => setImportOpen(o => !o)}>{importOpen ? <ChevronUp /> : <ChevronDown />}{importOpen ? 'Hide' : 'Show'}</Button>}
      >
        {importOpen && (
          <div className="space-y-2">
            <Textarea className={cn(MONO, FIXED, 'h-28')} spellCheck={false} value={importText} onChange={e => setImportText(e.target.value)}
              placeholder={`curl 'https://api.example.com/items?page=2' \\\n  -H 'Authorization: Bearer abc' \\\n  --data-raw '{"name":"x"}'`} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!importText.trim()} onClick={doImport}><Import /> Import into builder</Button>
              {importMsg.ok && <Badge>Imported</Badge>}
              {importMsg.warnings?.map((w, i) => <Badge key={i} variant="outline">{w}</Badge>)}
            </div>
            {importMsg.error && <ErrorBox message={importMsg.error} />}
          </div>
        )}
      </Section>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="space-y-3 min-w-0">
          <div className="flex gap-1.5">
            <Sel className="w-28 shrink-0 font-semibold" value={m.method} onChange={v => set({ method: v })} options={METHODS} />
            <Input className={cn(MONO, 'flex-1 min-w-0')} value={m.url} placeholder="https://api.example.com/path" onChange={e => set({ url: e.target.value })} onBlur={extractQuery} spellCheck={false} />
          </div>
          {urlError && m.url && <p className="text-[11px] text-destructive">{urlError}</p>}
          <Segmented value={tab} onChange={setTab} options={tabs} />
          <div className="rounded-md border border-border p-3 min-h-40">
            {tab === 'params' && <KvTable rows={m.query} onChange={query => set({ query })} keyPlaceholder="name" valuePlaceholder="value" addLabel="Add parameter" />}
            {tab === 'headers' && (
              <div className="space-y-2">
                <KvTable rows={m.headers} onChange={headers => set({ headers })} keyPlaceholder="Header" valuePlaceholder="Value" addLabel="Add header" suggestions={HEADER_SUGGESTIONS} />
                <div className="flex flex-wrap gap-1">
                  {[['Accept', 'application/json'], ['User-Agent', 'Mozilla/5.0'], ['Cache-Control', 'no-cache'], ['Accept-Encoding', 'gzip, deflate, br']].map(([k, v]) => (
                    <Button key={k} variant="secondary" size="xs" onClick={() => set({ headers: [...m.headers, { key: k, value: v, enabled: true }] })}><Plus /> {k}</Button>
                  ))}
                </div>
              </div>
            )}
            {tab === 'body' && (
              <div className="space-y-2">
                <Segmented value={m.bodyType} onChange={bodyType => set({ bodyType })} options={[
                  { value: 'none', label: 'None' }, { value: 'json', label: 'JSON' }, { value: 'form', label: 'Form (urlencoded)' }, { value: 'multipart', label: 'Multipart' }, { value: 'raw', label: 'Raw' },
                ]} />
                {(m.bodyType === 'json' || m.bodyType === 'raw') && (
                  <>
                    <Textarea className={cn(MONO, FIXED, 'h-48')} spellCheck={false} value={m.body} onChange={e => set({ body: e.target.value })} />
                    {m.bodyType === 'json' && (
                      <div className="flex flex-wrap items-center gap-2">
                        {jsonError ? <span className="text-[11px] text-destructive">Invalid JSON: {jsonError}</span> : <Badge variant="outline">Valid JSON</Badge>}
                        <Button variant="ghost" size="xs" disabled={!!jsonError} onClick={() => set({ body: JSON.stringify(JSON.parse(m.body), null, 2) })}><Wand2 /> Pretty</Button>
                        <Button variant="ghost" size="xs" disabled={!!jsonError} onClick={() => set({ body: JSON.stringify(JSON.parse(m.body)) })}>Compact</Button>
                      </div>
                    )}
                  </>
                )}
                {m.bodyType === 'form' && <KvTable rows={m.form} onChange={form => set({ form })} keyPlaceholder="field" addLabel="Add field" />}
                {m.bodyType === 'multipart' && (
                  <div className="space-y-1.5">
                    {m.multipart.map((f, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <input type="checkbox" checked={f.enabled !== false} onChange={e => set({ multipart: m.multipart.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)) })} />
                        <Input className={cn(MONO, 'flex-1 min-w-0')} placeholder="field" value={f.key} onChange={e => set({ multipart: m.multipart.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                        <Sel className="w-20 shrink-0" value={f.isFile ? 'file' : 'text'} onChange={v => set({ multipart: m.multipart.map((x, j) => (j === i ? { ...x, isFile: v === 'file' } : x)) })} options={[{ value: 'text', label: 'Text' }, { value: 'file', label: 'File' }]} />
                        <Input className={cn(MONO, 'flex-[1.4] min-w-0')} placeholder={f.isFile ? '/path/to/file.png' : 'value'} value={f.value} onChange={e => set({ multipart: m.multipart.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                        <Button variant="ghost" size="icon-xs" onClick={() => set({ multipart: m.multipart.filter((_, j) => j !== i) })}><X /></Button>
                      </div>
                    ))}
                    <Button variant="outline" size="xs" onClick={() => set({ multipart: [...m.multipart, { key: '', value: '', enabled: true }] })}><Plus /> Add field</Button>
                  </div>
                )}
                {m.bodyType === 'none' && <p className="text-xs text-muted-foreground">No request body.</p>}
              </div>
            )}
            {tab === 'auth' && (
              <div className="space-y-3">
                <Segmented value={m.auth.type} onChange={type => set({ auth: { ...m.auth, type } })} options={[
                  { value: 'none', label: 'None' }, { value: 'basic', label: 'Basic' }, { value: 'bearer', label: 'Bearer token' }, { value: 'apikey', label: 'API key header' },
                ]} />
                {m.auth.type === 'basic' && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Username"><Input value={m.auth.user} onChange={e => set({ auth: { ...m.auth, user: e.target.value } })} /></Field>
                    <Field label="Password"><Input type="password" value={m.auth.pass} onChange={e => set({ auth: { ...m.auth, pass: e.target.value } })} /></Field>
                  </div>
                )}
                {m.auth.type === 'bearer' && <Field label="Token"><Input className={MONO} value={m.auth.token} onChange={e => set({ auth: { ...m.auth, token: e.target.value } })} /></Field>}
                {m.auth.type === 'apikey' && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Header name"><Input className={MONO} value={m.auth.keyName} onChange={e => set({ auth: { ...m.auth, keyName: e.target.value } })} /></Field>
                    <Field label="Key"><Input className={MONO} value={m.auth.keyValue} onChange={e => set({ auth: { ...m.auth, keyValue: e.target.value } })} /></Field>
                  </div>
                )}
                {m.auth.type === 'none' && <p className="text-xs text-muted-foreground">No authentication. You can also add an Authorization header manually.</p>}
              </div>
            )}
            {tab === 'options' && (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Checkbox checked={m.flags.location} onChange={v => set({ flags: { ...m.flags, location: v } })}><b className="font-mono">-L</b> follow redirects</Checkbox>
                  <Checkbox checked={m.flags.insecure} onChange={v => set({ flags: { ...m.flags, insecure: v } })}><b className="font-mono">-k</b> skip TLS verification</Checkbox>
                  <Checkbox checked={m.flags.verbose} onChange={v => set({ flags: { ...m.flags, verbose: v } })}><b className="font-mono">-v</b> verbose</Checkbox>
                  <Checkbox checked={m.flags.include} onChange={v => set({ flags: { ...m.flags, include: v } })}><b className="font-mono">-i</b> include response headers</Checkbox>
                  <Checkbox checked={m.flags.compressed} onChange={v => set({ flags: { ...m.flags, compressed: v } })}><b className="font-mono">--compressed</b> accept gzip/br</Checkbox>
                  <Checkbox checked={m.flags.silent} onChange={v => set({ flags: { ...m.flags, silent: v } })}><b className="font-mono">-s</b> silent</Checkbox>
                </div>
                <NumberField className="max-w-48" label="Timeout (--max-time)" suffix="s" min={0} value={m.timeout} onChange={v => set({ timeout: Number.isFinite(v) ? Math.max(0, v) : 0 })} />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="xs" onClick={() => setM(L.emptyRequest())}><Eraser /> Reset</Button>
            <Button variant="ghost" size="xs" onClick={() => setM(sampleRequest())}><RotateCcw /> Example</Button>
          </div>
        </div>
        <div className="space-y-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={target} onChange={setTarget} options={[
              { value: 'curl', label: 'cURL' }, { value: 'fetch', label: 'fetch' }, { value: 'axios', label: 'axios' }, { value: 'python', label: 'Python' }, { value: 'httpie', label: 'HTTPie' }, { value: 'go', label: 'Go' },
            ]} />
            {target === 'curl' && <Segmented value={shell} onChange={setShell} options={[{ value: 'bash', label: 'bash/zsh' }, { value: 'powershell', label: 'PowerShell' }, { value: 'cmd', label: 'cmd.exe' }]} />}
            {target === 'curl' && <Checkbox checked={multiline} onChange={setMultiline}>Multi-line</Checkbox>}
          </div>
          <CodeOut label="Code" value={code} className="h-[26rem]" filename={{ curl: shell === 'bash' ? 'request.sh' : shell === 'powershell' ? 'request.ps1' : 'request.cmd', fetch: 'request.js', axios: 'request.mjs', python: 'request.py', httpie: 'request.sh', go: 'main.go' }[target]} />
          {target === 'curl' && shell === 'powershell' && <InfoBox>Uses <code>curl.exe</code> (in Windows PowerShell, <code>curl</code> is an alias for Invoke-WebRequest). Windows PowerShell 5.1 strips embedded double quotes from native arguments — use PowerShell 7.3+ or the cmd variant for JSON bodies.</InfoBox>}
          {target === 'fetch' && m.flags.insecure && <InfoBox>Browsers can’t skip TLS verification; in Node set <code>NODE_TLS_REJECT_UNAUTHORIZED=0</code> (dev only).</InfoBox>}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// WebSocket client
// ═════════════════════════════════════════════════════════════════════════════

interface WsLogEntry { id: number; dir: 'in' | 'out' | 'sys' | 'err'; time: number; text: string; size: number; binary?: boolean }
type WsStatus = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'waiting';

const LS_WS = 'devtools.ws.saved';
function loadSaved(): { name: string; body: string }[] {
  try { const v = JSON.parse(localStorage.getItem(LS_WS) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function storeSaved(v: { name: string; body: string }[]) { try { localStorage.setItem(LS_WS, JSON.stringify(v)); } catch { /* storage unavailable */ } }

const fmtTime = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

export function WebSocketClient() {
  const [url, setUrl] = useState('wss://echo.websocket.org');
  const [protocols, setProtocols] = useState('');
  const [status, setStatus] = useState<WsStatus>('idle');
  const [log, setLog] = useState<WsLogEntry[]>([]);
  const [msg, setMsg] = useState('{\n  "type": "subscribe",\n  "channel": "ticker"\n}');
  const [msgMode, setMsgMode] = useState<'text' | 'json'>('json');
  const [autoReconnect, setAutoReconnect] = useState(false);
  const [pingEvery, setPingEvery] = useState(0);
  const [pingText, setPingText] = useState('ping');
  const [filter, setFilter] = useState('');
  const [prettyIn, setPrettyIn] = useState(true);
  const [follow, setFollow] = useState(true);
  const [saved, setSaved] = useState(loadSaved);
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const [, tick] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const idRef = useRef(0);
  const manualClose = useRef(false);
  const attempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const opts = useRef({ autoReconnect, url, protocols });
  opts.current = { autoReconnect, url, protocols };

  const add = useCallback((dir: WsLogEntry['dir'], text: string, size = new TextEncoder().encode(text).length, binary = false) => {
    setLog(l => {
      const next = [...l, { id: ++idRef.current, dir, time: Date.now(), text, size, binary }];
      return next.length > 2000 ? next.slice(-2000) : next;
    });
  }, []);

  const connect = useCallback(() => {
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    setRetryIn(null);
    const { url: u, protocols: p } = opts.current;
    let sock: WebSocket;
    try {
      const protos = p.split(',').map(s => s.trim()).filter(Boolean);
      sock = protos.length ? new WebSocket(u, protos) : new WebSocket(u);
    } catch (e) {
      add('err', `Could not connect: ${(e as Error).message}`);
      setStatus('closed');
      return;
    }
    sock.binaryType = 'arraybuffer';
    ws.current = sock;
    manualClose.current = false;
    setStatus('connecting');
    add('sys', `Connecting to ${u}…`);
    sock.onopen = () => {
      attempts.current = 0;
      setStatus('open');
      setOpenedAt(Date.now());
      add('sys', `Connected${sock.protocol ? ` · subprotocol "${sock.protocol}"` : ''}${sock.extensions ? ` · extensions ${sock.extensions}` : ''}`);
    };
    sock.onmessage = ev => {
      if (typeof ev.data === 'string') add('in', ev.data);
      else {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        const hex = Array.from(bytes.slice(0, 64), b => b.toString(16).padStart(2, '0')).join(' ');
        add('in', `${hex}${bytes.length > 64 ? ' …' : ''}`, bytes.length, true);
      }
    };
    sock.onerror = () => add('err', 'Connection error (browsers don’t expose details — check the URL, TLS certificate, server logs, or mixed-content rules).');
    sock.onclose = ev => {
      if (ws.current !== sock) return;
      ws.current = null;
      setOpenedAt(null);
      add('sys', `Closed · code ${ev.code}${ev.reason ? ` “${ev.reason}”` : ''} — ${L.describeCloseCode(ev.code)}`);
      if (!manualClose.current && opts.current.autoReconnect) {
        const delay = Math.min(30_000, 1000 * 2 ** attempts.current) + Math.round(Math.random() * 300);
        attempts.current++;
        setStatus('waiting');
        setRetryIn(Date.now() + delay);
        add('sys', `Reconnecting in ${(delay / 1000).toFixed(1)} s (attempt ${attempts.current})…`);
        retryTimer.current = setTimeout(connect, delay);
      } else setStatus('closed');
    };
  }, [add]);

  const disconnect = () => {
    manualClose.current = true;
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; setRetryIn(null); setStatus('closed'); }
    if (ws.current) { setStatus('closing'); ws.current.close(1000, 'Closed by user'); }
  };

  useEffect(() => () => { manualClose.current = true; if (retryTimer.current) clearTimeout(retryTimer.current); ws.current?.close(); }, []);

  // Ping interval
  useEffect(() => {
    if (status !== 'open' || !pingEvery) return;
    const t = setInterval(() => { if (ws.current?.readyState === WebSocket.OPEN) { ws.current.send(pingText); add('out', pingText); } }, pingEvery * 1000);
    return () => clearInterval(t);
  }, [status, pingEvery, pingText, add]);

  // Live timers for uptime / retry countdown
  useEffect(() => {
    if (status !== 'open' && status !== 'waiting') return;
    const t = setInterval(() => tick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => { if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log, follow]);

  const jsonErr = useMemo(() => {
    if (msgMode !== 'json' || !msg.trim()) return '';
    try { JSON.parse(msg); return ''; } catch (e) { return (e as Error).message; }
  }, [msg, msgMode]);

  const send = () => {
    if (ws.current?.readyState !== WebSocket.OPEN || (msgMode === 'json' && jsonErr)) return;
    const payload = msgMode === 'json' ? JSON.stringify(JSON.parse(msg)) : msg;
    ws.current.send(payload);
    add('out', payload);
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? log.filter(e => e.text.toLowerCase().includes(f)) : log;
  }, [log, filter]);

  const stats = useMemo(() => ({
    in: log.filter(e => e.dir === 'in').length, out: log.filter(e => e.dir === 'out').length,
    bytesIn: log.filter(e => e.dir === 'in').reduce((s, e) => s + e.size, 0), bytesOut: log.filter(e => e.dir === 'out').reduce((s, e) => s + e.size, 0),
  }), [log]);

  const isOpen = status === 'open';
  const busy = status === 'connecting' || status === 'closing';
  const mixed = typeof location !== 'undefined' && location.protocol === 'https:' && /^ws:/i.test(url);
  const statusBadge = {
    idle: <Badge variant="outline">Not connected</Badge>,
    connecting: <Badge variant="secondary"><Loader2 className="animate-spin" /> Connecting</Badge>,
    open: <Badge>Connected{openedAt ? ` · ${Math.floor((Date.now() - openedAt) / 1000)}s` : ''}</Badge>,
    closing: <Badge variant="secondary">Closing…</Badge>,
    closed: <Badge variant="outline">Closed</Badge>,
    waiting: <Badge variant="secondary">Retrying{retryIn ? ` in ${Math.max(0, Math.ceil((retryIn - Date.now()) / 1000))}s` : ''}</Badge>,
  }[status];

  const renderText = (e: WsLogEntry) => {
    if (e.binary) return `[binary ${e.size} B] ${e.text}`;
    if (prettyIn && (e.dir === 'in' || e.dir === 'out') && /^\s*[[{]/.test(e.text)) {
      try { return JSON.stringify(JSON.parse(e.text), null, 2); } catch { /* not JSON */ }
    }
    return e.text;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input className={cn(MONO, 'flex-1 min-w-0')} value={url} onChange={e => setUrl(e.target.value)} placeholder="wss://example.com/socket" disabled={isOpen || busy}
          onKeyDown={e => { if (e.key === 'Enter' && !isOpen && !busy) connect(); }} spellCheck={false} />
        <Input className={cn(MONO, 'sm:w-48')} value={protocols} onChange={e => setProtocols(e.target.value)} placeholder="subprotocols (comma-sep.)" disabled={isOpen || busy} />
        {isOpen || busy || status === 'waiting'
          ? <Button variant="destructive" onClick={disconnect}><Unplug /> Disconnect</Button>
          : <Button disabled={!/^wss?:\/\/.+/i.test(url.trim())} onClick={connect}><Plug /> Connect</Button>}
      </div>
      {mixed && <ErrorBox message="This dashboard is served over HTTPS, so the browser will block insecure ws:// connections (mixed content). Use wss://." />}
      <div className="flex flex-wrap items-center gap-3">
        {statusBadge}
        <Checkbox checked={autoReconnect} onChange={setAutoReconnect}>Auto-reconnect (exp. backoff)</Checkbox>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Ping every
          <input type="number" min={0} className="w-14 h-7 rounded border border-input bg-transparent px-1.5 text-xs" value={pingEvery} onChange={e => setPingEvery(Math.max(0, Number(e.target.value) || 0))} />
          s with
          <input className="w-24 h-7 rounded border border-input bg-transparent px-1.5 text-xs font-mono" value={pingText} onChange={e => setPingText(e.target.value)} />
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">↓ {stats.in} msgs · {formatBytes(stats.bytesIn)} &nbsp; ↑ {stats.out} msgs · {formatBytes(stats.bytesOut)}</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <div className="space-y-1.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-7 flex-1 min-w-32 text-xs" placeholder="Filter messages…" value={filter} onChange={e => setFilter(e.target.value)} />
            <Checkbox checked={prettyIn} onChange={setPrettyIn}>Pretty JSON</Checkbox>
            <Button variant="ghost" size="xs" onClick={() => setFollow(f => !f)} title="Auto-scroll">{follow ? <Pause /> : <Play />}{follow ? 'Pause scroll' : 'Follow'}</Button>
            <Button variant="ghost" size="xs" disabled={!log.length} onClick={() => downloadBlob(JSON.stringify(log.map(({ id, ...e }) => ({ ...e, time: new Date(e.time).toISOString() })), null, 2), 'websocket-log.json', 'application/json')}><FileDown /> Export</Button>
            <Button variant="ghost" size="xs" disabled={!log.length} onClick={() => setLog([])}><Trash2 /> Clear</Button>
          </div>
          <div ref={logRef} className="h-[26rem] overflow-auto rounded-md border border-border bg-secondary/20 p-1.5 space-y-1">
            {!shown.length && <p className="p-3 text-xs text-muted-foreground">{log.length ? 'No messages match the filter.' : 'Messages will appear here. Try connecting to the echo server and sending something.'}</p>}
            {shown.map(e => (
              <div key={e.id} className={cn('group rounded border px-2 py-1 text-xs',
                e.dir === 'in' && 'border-border bg-card', e.dir === 'out' && 'border-primary/30 bg-primary/5',
                e.dir === 'sys' && 'border-transparent text-muted-foreground', e.dir === 'err' && 'border-destructive/30 bg-destructive/10 text-destructive')}>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className={cn('font-semibold', e.dir === 'in' && 'text-foreground', e.dir === 'out' && 'text-primary')}>{{ in: '↓ IN', out: '↑ OUT', sys: '• INFO', err: '! ERROR' }[e.dir]}</span>
                  <span className="tabular-nums">{fmtTime(e.time)}</span>
                  {(e.dir === 'in' || e.dir === 'out') && <span className="tabular-nums">{formatBytes(e.size)}</span>}
                  <span className="ml-auto opacity-0 group-hover:opacity-100 flex gap-0.5">
                    <Button variant="ghost" size="icon-xs" title="Copy" onClick={() => copyText(e.text)}><Copy /></Button>
                    {e.dir !== 'sys' && e.dir !== 'err' && !e.binary && <Button variant="ghost" size="icon-xs" title="Load into composer" onClick={() => { setMsg(renderText(e)); setMsgMode(/^\s*[[{]/.test(e.text) ? 'json' : 'text'); }}><RotateCcw /></Button>}
                  </span>
                </div>
                <pre className="font-mono whitespace-pre-wrap break-all leading-relaxed">{renderText(e)}</pre>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3 min-w-0">
          <div className="space-y-1.5">
            <FieldLabel action={<Segmented value={msgMode} onChange={setMsgMode} options={[{ value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' }]} />}>Message</FieldLabel>
            <Textarea className={cn(MONO, FIXED, 'h-40')} value={msg} onChange={e => setMsg(e.target.value)} spellCheck={false}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
            {jsonErr && <p className="text-[11px] text-destructive">Invalid JSON: {jsonErr}</p>}
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled={!isOpen || !msg || !!jsonErr} onClick={send}><Send /> Send <span className="text-[10px] opacity-70">Ctrl+↵</span></Button>
              {msgMode === 'json' && <Button variant="outline" size="sm" disabled={!!jsonErr || !msg.trim()} onClick={() => setMsg(JSON.stringify(JSON.parse(msg), null, 2))}><Wand2 /> Pretty</Button>}
              <Button variant="outline" size="sm" disabled={!msg.trim()} onClick={() => {
                const name = (msg.trim().split('\n')[0] || 'message').slice(0, 40);
                const next = [{ name, body: msg }, ...saved.filter(s => s.body !== msg)].slice(0, 30);
                setSaved(next); storeSaved(next);
              }}><Save /> Save</Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Saved messages</p>
            {!saved.length && <p className="text-[11px] text-muted-foreground">Save frequently used payloads here (stored in this browser).</p>}
            <div className="space-y-1 max-h-48 overflow-auto">
              {saved.map((s, i) => (
                <div key={i} className="flex items-center gap-1 rounded border border-border px-2 py-1">
                  <button type="button" className="flex-1 truncate text-left text-xs font-mono cursor-pointer hover:text-primary" title={s.body}
                    onClick={() => { setMsg(s.body); setMsgMode(/^\s*[[{]/.test(s.body) ? 'json' : 'text'); }}>{s.name}</button>
                  <Button variant="ghost" size="icon-xs" title="Send now" disabled={!isOpen} onClick={() => { ws.current?.send(s.body); add('out', s.body); }}><Send /></Button>
                  <Button variant="ghost" size="icon-xs" title="Delete" onClick={() => { const next = saved.filter((_, j) => j !== i); setSaved(next); storeSaved(next); }}><X /></Button>
                </div>
              ))}
            </div>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Close codes reference</summary>
            <div className="mt-1.5 space-y-1">
              {Object.entries(L.WS_CLOSE_CODES).map(([c, d]) => <p key={c}><code className="font-mono font-semibold">{c}</code> <span className="text-muted-foreground">{d}</span></p>)}
              <p><code className="font-mono font-semibold">4000–4999</code> <span className="text-muted-foreground">Application-defined.</span></p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// JS minifier (server, Terser)
// ═════════════════════════════════════════════════════════════════════════════

const JS_SAMPLE = `/*! my-lib v1.2.0 | MIT */
// Debounce helper with leading/trailing options
export function debounce(callback, waitMilliseconds = 200, { leading = false } = {}) {
  let timeoutHandle = null;
  let lastArguments;
  function invoke() {
    console.log('invoking debounced function');
    callback.apply(this, lastArguments);
  }
  return function debounced(...args) {
    lastArguments = args;
    const shouldCallNow = leading && timeoutHandle === null;
    clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (!leading) invoke.call(this);
    }, waitMilliseconds);
    if (shouldCallNow) invoke.call(this);
  };
}

export const formatCurrency = (amount, currency = 'USD', locale = 'en-US') =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
`;

interface JsMinResult { code: string; map?: string; sizes: { original: number; minified: number; gzipOriginal: number; gzipMinified: number }; ms: number }

export function JsMinifier() {
  const [code, setCode] = useState(JS_SAMPLE);
  const [o, setO] = useState({ compress: true, mangle: true, module: true, ecma: '2020', keepFnames: false, dropConsole: false, comments: 'license', sourceMap: false, passes: '1' });
  const [res, setRes] = useState<JsMinResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('script.js');
  const set = (p: Partial<typeof o>) => setO(prev => ({ ...prev, ...p }));

  const run = async () => {
    setBusy(true); setErr('');
    try {
      const r = await toolsApi.post<JsMinResult>('/dev/minify-js', { code, options: { ...o, ecma: Number(o.ecma), passes: Number(o.passes) } });
      setRes(r);
    } catch (e) { setErr((e as Error).message); setRes(null); } finally { setBusy(false); }
  };
  useEffect(() => { run(); /* show a result for the sample immediately */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const minName = name.replace(/(\.m?js)?$/i, '.min.js');
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-3">
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <Field label="ECMAScript target"><Sel value={o.ecma} onChange={ecma => set({ ecma })} options={['5', '2015', '2016', '2017', '2018', '2019', '2020'].map(v => ({ value: v, label: v === '5' ? 'ES5' : `ES${v}` }))} /></Field>
          <Field label="Comments"><Sel value={o.comments} onChange={comments => set({ comments })} options={[{ value: 'license', label: 'Keep /*! license */' }, { value: 'none', label: 'Remove all' }, { value: 'all', label: 'Keep all' }]} /></Field>
          <Field label="Compress passes"><Sel value={o.passes} onChange={passes => set({ passes })} options={[{ value: '1', label: '1 (fast)' }, { value: '2', label: '2' }, { value: '3', label: '3 (smallest)' }]} /></Field>
          <Field label="Source"><Sel value={o.module ? 'module' : 'script'} onChange={v => set({ module: v === 'module' })} options={[{ value: 'module', label: 'ES module' }, { value: 'script', label: 'Classic script' }]} /></Field>
        </div>
        <div className="flex flex-wrap gap-3">
          <Checkbox checked={o.compress} onChange={compress => set({ compress })}>Compress</Checkbox>
          <Checkbox checked={o.mangle} onChange={mangle => set({ mangle })}>Mangle names</Checkbox>
          <Checkbox checked={o.keepFnames} onChange={keepFnames => set({ keepFnames })}>Keep function names</Checkbox>
          <Checkbox checked={o.dropConsole} onChange={dropConsole => set({ dropConsole })}>Drop console.*</Checkbox>
          <Checkbox checked={o.sourceMap} onChange={sourceMap => set({ sourceMap })}>Source map</Checkbox>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || !code.trim()} onClick={run}>{busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Minify</Button>
        <span className="text-[11px] text-muted-foreground">Ctrl+Enter in the editor · up to 5 MB · runs Terser on the server</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<span className="flex gap-1"><LoadFileButton accept=".js,.mjs,.cjs,.jsx,text/javascript" onLoad={(t, n) => { setCode(t); setName(n); }} /><Button variant="ghost" size="xs" onClick={() => setCode('')}>Clear</Button></span>}>
            JavaScript <span className="font-normal">· {formatBytes(L.utf8Len(code))}</span>
          </FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-96')} value={code} onChange={e => setCode(e.target.value)} spellCheck={false}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } }} />
        </div>
        <div className="space-y-2 min-w-0">
          {err ? <ErrorBox message={err} /> : (
            <CodeOut label="Minified" value={res?.code ?? ''} filename={minName} mime="text/javascript" className="h-96 whitespace-pre-wrap break-all"
              extra={res?.map ? <Button variant="ghost" size="xs" onClick={() => downloadBlob(res.map!, 'script.min.js.map', 'application/json')}><Download /> .map</Button> : undefined} />
          )}
        </div>
      </div>
      {res && !err && <SizeStats sizes={res.sizes} ms={res.ms} />}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// HTML minifier (server)
// ═════════════════════════════════════════════════════════════════════════════

const HTML_SAMPLE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>  Landing page  </title>
    <!-- Styles -->
    <style type="text/css">
      body { margin : 0 ; font-family : system-ui , sans-serif ; }
      .hero > h1 { font-size : clamp( 2rem , 5vw , 4rem ) ; }
    </style>
  </head>
  <body>
    <section class="  hero   main  " id="">
      <h1>Hello,   <em>world</em>!</h1>
      <p>
        Fast, small pages load quicker.
      </p>
      <input type="checkbox" checked="checked" disabled="disabled">
      <pre>
  Whitespace   in pre
      is preserved
</pre>
    </section>
    <script type="text/javascript">
      // greet the visitor
      const message = "</div> inside a string is fine";
      document.querySelector('h1').addEventListener('click', function () { alert(message); });
    </script>
    <script type="application/ld+json">
      { "@context": "https://schema.org", "@type": "WebPage", "name": "Landing page" }
    </script>
  </body>
</html>`;

interface HtmlMinResult { html: string; warnings: string[]; sizes: JsMinResult['sizes']; ms: number }

const HTML_OPTS: { key: string; label: string; help: string }[] = [
  { key: 'removeComments', label: 'Remove comments', help: 'Keeps IE conditional comments and <!--! … -->' },
  { key: 'collapseWhitespace', label: 'Collapse whitespace', help: 'Never touches <pre>, <textarea>, scripts' },
  { key: 'conservativeCollapse', label: 'Conservative collapse', help: 'Always leave one space (safest)' },
  { key: 'minifyJs', label: 'Minify inline JS', help: 'Terser; JSON-LD is compacted' },
  { key: 'minifyCss', label: 'Minify inline CSS', help: '<style> and style="" attributes' },
  { key: 'collapseBooleanAttributes', label: 'Collapse boolean attrs', help: 'checked="checked" → checked' },
  { key: 'removeEmptyAttributes', label: 'Remove empty attrs', help: 'class="", id="", style=""…' },
  { key: 'removeScriptTypes', label: 'Remove default type=', help: 'text/javascript, text/css' },
  { key: 'removeOptionalQuotes', label: 'Remove attribute quotes', help: 'Only where HTML allows it' },
];

export function HtmlMinifier() {
  const [html, setHtml] = useState(HTML_SAMPLE);
  const [o, setO] = useState<Record<string, boolean>>({
    removeComments: true, collapseWhitespace: true, conservativeCollapse: false, minifyJs: true, minifyCss: true,
    collapseBooleanAttributes: true, removeEmptyAttributes: true, removeScriptTypes: true, removeOptionalQuotes: false,
  });
  const [res, setRes] = useState<HtmlMinResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);

  const run = async (opts = o) => {
    setBusy(true); setErr('');
    try { setRes(await toolsApi.post<HtmlMinResult>('/dev/minify-html', { html, options: opts })); } catch (e) { setErr((e as Error).message); setRes(null); } finally { setBusy(false); }
  };
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3">
      <div className="grid gap-2 rounded-md border border-border bg-secondary/20 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {HTML_OPTS.map(x => (
          <div key={x.key} className="min-w-0">
            <Checkbox checked={!!o[x.key]} onChange={v => { const next = { ...o, [x.key]: v }; setO(next); if (res) run(next); }}>{x.label}</Checkbox>
            <p className="pl-5 text-[11px] text-muted-foreground/80">{x.help}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || !html.trim()} onClick={() => run()}>{busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Minify</Button>
        <Button variant="outline" size="sm" disabled={!res} onClick={() => setPreview(p => !p)}><Eye /> {preview ? 'Hide preview' : 'Preview result'}</Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<span className="flex gap-1"><LoadFileButton accept=".html,.htm,text/html" onLoad={t => setHtml(t)} /><Button variant="ghost" size="xs" onClick={() => setHtml('')}>Clear</Button></span>}>
            HTML <span className="font-normal">· {formatBytes(L.utf8Len(html))}</span>
          </FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-96')} value={html} onChange={e => setHtml(e.target.value)} spellCheck={false}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } }} />
        </div>
        <div className="space-y-2 min-w-0">
          {err ? <ErrorBox message={err} /> : preview && res
            ? <iframe title="Minified preview" sandbox="" srcDoc={res.html} className="h-96 w-full rounded-md border border-border bg-white" />
            : <CodeOut label="Minified" value={res?.html ?? ''} filename="index.min.html" mime="text/html" className="h-96 whitespace-pre-wrap break-all" />}
        </div>
      </div>
      {res?.warnings.map((w, i) => <InfoBox key={i}>⚠ {w}</InfoBox>)}
      {res && !err && <SizeStats sizes={res.sizes} ms={res.ms} />}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SVG → JSX
// ═════════════════════════════════════════════════════════════════════════════

const SVG_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="24" height="24" viewBox="0 0 24 24" class="icon icon-bell">
  <!-- Generator: Sketch -->
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <path fill="none" stroke="#111827" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
  <path fill="none" stroke="#111827" stroke-width="2" stroke-linecap="round" d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
  <circle cx="18" cy="5" r="3" fill="url(#g)" style="stroke: white; stroke-width: 1.5"/>
</svg>`;

/** Parse untrusted SVG and strip anything active (scripts, handlers, foreignObject, javascript: links). */
function sanitizeSvg(svg: string): { svg: string; error: string } {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const pe = doc.getElementsByTagName('parsererror')[0];
  if (pe || doc.documentElement.nodeName.toLowerCase() !== 'svg') return { svg: '', error: pe ? (pe.textContent || 'Invalid SVG').trim().slice(0, 200) : 'Root element is not <svg>' };
  doc.querySelectorAll('script, foreignObject, iframe, embed, object').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(el => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || (/href$/i.test(a.name) && /^\s*(javascript|data:text\/html)/i.test(a.value))) el.removeAttribute(a.name);
    }
  });
  return { svg: new XMLSerializer().serializeToString(doc), error: '' };
}
const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function SvgToJsx() {
  const [svg, setSvg] = useState(SVG_SAMPLE);
  const [o, setO] = useState<L.SvgJsxOptions>({
    name: 'BellIcon', typescript: true, memo: false, forwardRef: false, spreadProps: true, removeDimensions: true, removeXmlns: true,
    currentColor: true, removeEditorData: true, exportDefault: true,
  });
  const [color, setColor] = useState('#4f46e5');
  const set = (p: Partial<L.SvgJsxOptions>) => setO(prev => ({ ...prev, ...p }));
  const src = useDebounced(svg, 150);

  const out = useMemo(() => {
    if (!src.trim()) return { code: '', error: '' };
    try { return { code: L.svgToJsx(src, o), error: '' }; } catch (e) { return { code: '', error: (e as Error).message }; }
  }, [src, o]);
  const preview = useMemo(() => (src.trim() ? sanitizeSvg(src) : { svg: '', error: '' }), [src]);
  // <img> can't inherit currentColor, so substitute the picked colour for the preview.
  const previewColored = useMemo(() => {
    if (!preview.svg) return '';
    let s = preview.svg;
    if (o.currentColor) s = s.replace(/(fill|stroke)="(?!none|url\()[^"]*"/g, `$1="${color}"`).replace(/currentColor/g, color);
    return s;
  }, [preview.svg, o.currentColor, color]);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Component name" className="w-48"><Input className={MONO} value={o.name} onChange={e => set({ name: e.target.value })} /></Field>
          <Segmented value={o.typescript ? 'tsx' : 'jsx'} onChange={v => set({ typescript: v === 'tsx' })} options={[{ value: 'tsx', label: 'TypeScript' }, { value: 'jsx', label: 'JavaScript' }]} />
        </div>
        <div className="flex flex-wrap gap-3">
          <Checkbox checked={o.spreadProps} onChange={spreadProps => set({ spreadProps })}>Spread {'{...props}'}</Checkbox>
          <Checkbox checked={o.forwardRef} onChange={forwardRef => set({ forwardRef })}>forwardRef</Checkbox>
          <Checkbox checked={o.memo} onChange={memo => set({ memo })}>React.memo</Checkbox>
          <Checkbox checked={o.exportDefault} onChange={exportDefault => set({ exportDefault })}>Default export</Checkbox>
          <Checkbox checked={o.currentColor} onChange={currentColor => set({ currentColor })}>fill/stroke → currentColor</Checkbox>
          <Checkbox checked={o.removeDimensions} onChange={removeDimensions => set({ removeDimensions })}>Remove width/height</Checkbox>
          <Checkbox checked={o.removeXmlns} onChange={removeXmlns => set({ removeXmlns })}>Remove xmlns</Checkbox>
          <Checkbox checked={o.removeEditorData} onChange={removeEditorData => set({ removeEditorData })}>Strip editor metadata</Checkbox>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<span className="flex gap-1"><LoadFileButton accept=".svg,image/svg+xml" onLoad={(t, n) => { setSvg(t); set({ name: L.toComponentName(n) }); }} /><Button variant="ghost" size="xs" onClick={() => setSvg('')}>Clear</Button></span>}>SVG</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-80')} value={svg} onChange={e => setSvg(e.target.value)} spellCheck={false} placeholder="Paste <svg>…</svg>" />
        </div>
        {out.error ? <ErrorBox message={out.error} /> : <CodeOut label="Component" value={out.code} filename={`${o.name || 'Icon'}.${o.typescript ? 'tsx' : 'jsx'}`} className="h-80" />}
      </div>
      <div className="flex flex-wrap items-end gap-4 rounded-md border border-border p-3">
        {preview.error ? <ErrorBox message={`Preview: ${preview.error}`} /> : previewColored ? (
          <>
            {[16, 24, 48, 96].map(s => (
              <div key={s} className="flex flex-col items-center gap-1">
                <div className="grid place-items-center rounded-md bg-[repeating-conic-gradient(#8882_0_25%,transparent_0_50%)] bg-[length:12px_12px] p-2">
                  <img src={svgDataUrl(previewColored)} width={s} height={s} alt="" />
                </div>
                <span className="text-[10px] text-muted-foreground">{s}px</span>
              </div>
            ))}
            {o.currentColor && <div className="w-40"><ColorField label="Preview colour" value={color} onChange={setColor} /></div>}
          </>
        ) : <p className="text-xs text-muted-foreground">Paste an SVG to preview.</p>}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// QR code generator
// ═════════════════════════════════════════════════════════════════════════════

type QrKind = 'url' | 'text' | 'wifi' | 'vcard' | 'email' | 'sms' | 'phone' | 'geo';

function dataUrlToBlob(url: string): Blob {
  const [head, data] = url.split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  const bin = atob(data);
  return new Blob([Uint8Array.from(bin, c => c.charCodeAt(0))], { type: mime });
}

function luminance(hex: string) {
  const [r, g, b] = L.hexToRgb(hex).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function QrCodeGenerator() {
  const [kind, setKind] = useState<QrKind>('url');
  const [url, setUrl] = useState('https://example.com/?utm_source=qr');
  const [text, setText] = useState('Hello from the QR generator!');
  const [wifi, setWifi] = useState({ ssid: 'Office-Guest', password: 'correct horse battery', security: 'WPA' as 'WPA' | 'WEP' | 'nopass', hidden: false });
  const [vc, setVc] = useState<L.VCard>({ first: 'Ada', last: 'Lovelace', org: 'Analytical Engines Ltd', title: 'Engineer', phone: '', mobile: '+44 20 7946 0000', email: 'ada@example.com', url: 'https://example.com', street: '', city: 'London', zip: '', country: 'UK', note: '' });
  const [mail, setMail] = useState({ to: 'hello@example.com', subject: 'Hello', body: '' });
  const [sms, setSms] = useState({ num: '+15551234567', msg: 'Hi!' });
  const [phone, setPhone] = useState('+15551234567');
  const [geo, setGeo] = useState({ lat: 48.8584, lng: 2.2945 });
  const [ec, setEc] = useState<'L' | 'M' | 'Q' | 'H'>('M');
  const [size, setSize] = useState(320);
  const [margin, setMargin] = useState(2);
  const [fg, setFg] = useState('#111827');
  const [bg, setBg] = useState('#ffffff');
  const [transparent, setTransparent] = useState(false);
  const [png, setPng] = useState('');
  const [svgStr, setSvgStr] = useState('');
  const [err, setErr] = useState('');
  const [version, setVersion] = useState<number | null>(null);

  const payload = useMemo(() => {
    switch (kind) {
      case 'url': return url.trim();
      case 'text': return text;
      case 'wifi': return L.wifiPayload(wifi.ssid, wifi.password, wifi.security, wifi.hidden);
      case 'vcard': return L.vcardPayload(vc);
      case 'email': return L.mailtoPayload(mail.to, mail.subject, mail.body);
      case 'sms': return L.smsPayload(sms.num, sms.msg);
      case 'phone': return L.telPayload(phone);
      case 'geo': return L.geoPayload(geo.lat, geo.lng);
    }
  }, [kind, url, text, wifi, vc, mail, sms, phone, geo]);
  const dPayload = useDebounced(payload, 120);

  useEffect(() => {
    let alive = true;
    if (!dPayload) { setPng(''); setSvgStr(''); setErr(''); return; }
    const color = { dark: fg, light: transparent ? '#ffffff00' : bg };
    Promise.all([
      QRCode.toDataURL(dPayload, { errorCorrectionLevel: ec, width: size, margin, color }),
      QRCode.toString(dPayload, { type: 'svg', errorCorrectionLevel: ec, margin, color, width: size }),
    ]).then(([p, s]) => {
      if (!alive) return;
      setPng(p); setSvgStr(s); setErr('');
      try { setVersion(QRCode.create(dPayload, { errorCorrectionLevel: ec }).version); } catch { setVersion(null); }
    }).catch(e => { if (alive) { setErr((e as Error).message); setPng(''); setSvgStr(''); } });
    return () => { alive = false; };
  }, [dPayload, ec, size, margin, fg, bg, transparent]);

  const contrast = useMemo(() => {
    const a = luminance(fg); const b = transparent ? 1 : luminance(bg);
    return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), inverted: a > b };
  }, [fg, bg, transparent]);

  const kinds: { value: QrKind; label: string }[] = [
    { value: 'url', label: 'URL' }, { value: 'text', label: 'Text' }, { value: 'wifi', label: 'Wi-Fi' }, { value: 'vcard', label: 'vCard' },
    { value: 'email', label: 'Email' }, { value: 'sms', label: 'SMS' }, { value: 'phone', label: 'Phone' }, { value: 'geo', label: 'Location' },
  ];
  const vcField = (k: keyof L.VCard, label: string, cls = '') => <Field key={k} label={label} className={cls}><Input value={vc[k]} onChange={e => setVc({ ...vc, [k]: e.target.value })} /></Field>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="space-y-3 min-w-0">
        <Segmented value={kind} onChange={setKind} options={kinds} />
        <div className="rounded-md border border-border p-3 space-y-3">
          {kind === 'url' && (
            <Field label="URL" hint={url && !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? 'Tip: include https:// so phones open it as a link.' : undefined}>
              <Input className={MONO} value={url} onChange={e => setUrl(e.target.value)} />
            </Field>
          )}
          {kind === 'text' && <Field label="Text"><Textarea className={cn(FIXED, 'h-28')} value={text} onChange={e => setText(e.target.value)} /></Field>}
          {kind === 'wifi' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Network name (SSID)"><Input value={wifi.ssid} onChange={e => setWifi({ ...wifi, ssid: e.target.value })} /></Field>
              <Field label="Security"><Sel value={wifi.security} onChange={security => setWifi({ ...wifi, security })} options={[{ value: 'WPA', label: 'WPA / WPA2 / WPA3' }, { value: 'WEP', label: 'WEP' }, { value: 'nopass', label: 'None (open)' }]} /></Field>
              {wifi.security !== 'nopass' && <Field label="Password"><Input value={wifi.password} onChange={e => setWifi({ ...wifi, password: e.target.value })} /></Field>}
              <div className="flex items-end pb-2"><Checkbox checked={wifi.hidden} onChange={hidden => setWifi({ ...wifi, hidden })}>Hidden network</Checkbox></div>
            </div>
          )}
          {kind === 'vcard' && (
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
              {vcField('first', 'First name')}{vcField('last', 'Last name')}{vcField('org', 'Organisation')}
              {vcField('title', 'Job title')}{vcField('mobile', 'Mobile')}{vcField('phone', 'Work phone')}
              {vcField('email', 'Email')}{vcField('url', 'Website')}{vcField('street', 'Street')}
              {vcField('city', 'City')}{vcField('zip', 'Postcode')}{vcField('country', 'Country')}
              {vcField('note', 'Note', 'col-span-full')}
            </div>
          )}
          {kind === 'email' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="To"><Input value={mail.to} onChange={e => setMail({ ...mail, to: e.target.value })} /></Field>
              <Field label="Subject"><Input value={mail.subject} onChange={e => setMail({ ...mail, subject: e.target.value })} /></Field>
              <Field label="Body" className="sm:col-span-2"><Textarea className={cn(FIXED, 'h-20')} value={mail.body} onChange={e => setMail({ ...mail, body: e.target.value })} /></Field>
            </div>
          )}
          {kind === 'sms' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Phone number"><Input value={sms.num} onChange={e => setSms({ ...sms, num: e.target.value })} /></Field>
              <Field label="Message"><Input value={sms.msg} onChange={e => setSms({ ...sms, msg: e.target.value })} /></Field>
            </div>
          )}
          {kind === 'phone' && <Field label="Phone number"><Input value={phone} onChange={e => setPhone(e.target.value)} /></Field>}
          {kind === 'geo' && (
            <div className="grid gap-3 grid-cols-2">
              <NumberField label="Latitude" value={geo.lat} step={0.0001} min={-90} max={90} onChange={lat => setGeo({ ...geo, lat })} />
              <NumberField label="Longitude" value={geo.lng} step={0.0001} min={-180} max={180} onChange={lng => setGeo({ ...geo, lng })} />
            </div>
          )}
        </div>
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <Field label="Error correction"><Sel value={ec} onChange={setEc} options={[{ value: 'L', label: 'L · 7%' }, { value: 'M', label: 'M · 15%' }, { value: 'Q', label: 'Q · 25%' }, { value: 'H', label: 'H · 30% (logos)' }]} /></Field>
          <ColorField label="Foreground" value={fg} onChange={setFg} />
          <ColorField label="Background" value={bg} onChange={setBg} />
          <div className="flex items-end pb-2"><Checkbox checked={transparent} onChange={setTransparent}>Transparent background</Checkbox></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Slider label="Size" value={size} onChange={setSize} min={128} max={1024} step={16} suffix="px" />
          <Slider label="Quiet zone (margin)" value={margin} onChange={setMargin} min={0} max={10} suffix="mod" />
        </div>
        {(contrast.ratio < 3 || contrast.inverted) && (
          <InfoBox>⚠ {contrast.inverted ? 'Light-on-dark codes are not supported by some scanners. ' : ''}{contrast.ratio < 3 ? `Low contrast (${contrast.ratio.toFixed(1)}:1) — aim for at least 4:1.` : ''}</InfoBox>
        )}
        <div className="space-y-1.5">
          <FieldLabel action={<CopyButton value={payload} label="Copy" />}>Encoded payload <span className="font-normal">· {L.utf8Len(payload)} bytes</span></FieldLabel>
          <pre className={cn(MONO, 'rounded-md border border-border bg-secondary/40 p-2 whitespace-pre-wrap break-all max-h-32 overflow-auto')}>{payload || '—'}</pre>
        </div>
      </div>
      <div className="space-y-3 min-w-0">
        <div className="grid place-items-center rounded-lg border border-border bg-[repeating-conic-gradient(#8882_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-4 min-h-64">
          {err ? <ErrorBox message={err} /> : png ? <img src={png} alt="QR code" className="max-w-full h-auto" style={{ width: Math.min(size, 320) }} /> : <p className="text-xs text-muted-foreground">Enter content to generate a code.</p>}
        </div>
        {version && <p className="text-center text-[11px] text-muted-foreground">Version {version} · {17 + version * 4}×{17 + version * 4} modules · EC {ec}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button disabled={!png} onClick={() => downloadBlob(dataUrlToBlob(png), `qr-${kind}.png`)}><Download /> PNG</Button>
          <Button variant="outline" disabled={!svgStr} onClick={() => downloadBlob(svgStr, `qr-${kind}.svg`, 'image/svg+xml')}><Download /> SVG</Button>
          <Button variant="ghost" size="sm" disabled={!svgStr} onClick={() => copyText(svgStr)}><Copy /> Copy SVG</Button>
          <Button variant="ghost" size="sm" disabled={!png} onClick={async () => {
            try {
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': dataUrlToBlob(png) })]);
            } catch { copyText(png); }
          }}><Copy /> Copy image</Button>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// .htaccess generator
// ═════════════════════════════════════════════════════════════════════════════

const DURATIONS = ['', '0 seconds', '1 hour', '1 day', '1 week', '1 month', '6 months', '1 year'];

function Opt({ checked, onChange, title, children }: { checked: boolean; onChange: (v: boolean) => void; title: string; children?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <Checkbox checked={checked} onChange={onChange}><span className="text-foreground font-medium">{title}</span></Checkbox>
      {children && <p className="pl-5 text-[11px] text-muted-foreground">{children}</p>}
    </div>
  );
}

export function HtaccessGenerator() {
  const [o, setO] = useState<L.HtaccessOptions>({
    forceHttps: true, www: 'non-www', trailingSlash: 'none',
    redirects: [{ from: '/old-page.html', to: '/new-page', code: '301' }],
    errorPages: [{ code: '404', path: '/404.html' }],
    compression: true, caching: true,
    cache: { html: '0 seconds', css: '1 year', js: '1 year', images: '1 year', fonts: '1 year', media: '1 month' },
    hsts: true, hstsPreload: false, nosniff: true, frameOptions: 'SAMEORIGIN', referrerPolicy: 'strict-origin-when-cross-origin',
    permissionsPolicy: false, csp: '', noIndexes: true, blockIps: [], hotlink: false, hotlinkDomain: 'example.com', hotlinkExts: 'jpg jpeg png gif webp svg',
    spaFallback: false, protectDotfiles: true, noSignature: true, charset: true,
  });
  const set = (p: Partial<L.HtaccessOptions>) => setO(prev => ({ ...prev, ...p }));
  const out = useMemo(() => L.generateHtaccess(o), [o]);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-3 min-w-0">
        <Section title="URLs & redirects">
          <Opt checked={o.forceHttps} onChange={forceHttps => set({ forceHttps })} title="Force HTTPS">301-redirect every http:// request (proxy-aware via X-Forwarded-Proto).</Opt>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="www handling"><Sel value={o.www} onChange={www => set({ www })} options={[{ value: 'none', label: 'Leave as is' }, { value: 'non-www', label: 'Redirect www → bare domain' }, { value: 'www', label: 'Redirect bare → www' }]} /></Field>
            <Field label="Trailing slash"><Sel value={o.trailingSlash} onChange={trailingSlash => set({ trailingSlash })} options={[{ value: 'none', label: 'Leave as is' }, { value: 'add', label: 'Always add /' }, { value: 'remove', label: 'Always remove /' }]} /></Field>
          </div>
          <Opt checked={o.spaFallback} onChange={spaFallback => set({ spaFallback })} title="Single-page app fallback">Serve index.html for paths that aren’t real files (React/Vue/Angular routers).</Opt>
          <div className="space-y-1.5">
            <FieldLabel>Custom redirects</FieldLabel>
            {o.redirects.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input className={cn(MONO, 'flex-1 min-w-0')} placeholder="/old" value={r.from} onChange={e => set({ redirects: o.redirects.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
                <span className="text-muted-foreground text-xs">→</span>
                <Input className={cn(MONO, 'flex-1 min-w-0')} placeholder="/new or https://…" value={r.to} onChange={e => set({ redirects: o.redirects.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
                <Sel className="w-20 shrink-0" value={r.code} onChange={code => set({ redirects: o.redirects.map((x, j) => (j === i ? { ...x, code } : x)) })} options={['301', '302', '307', '308']} />
                <Button variant="ghost" size="icon-xs" onClick={() => set({ redirects: o.redirects.filter((_, j) => j !== i) })}><X /></Button>
              </div>
            ))}
            <Button variant="outline" size="xs" onClick={() => set({ redirects: [...o.redirects, { from: '', to: '', code: '301' }] })}><Plus /> Add redirect</Button>
          </div>
          <div className="space-y-1.5">
            <FieldLabel>Custom error pages</FieldLabel>
            {o.errorPages.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Sel className="w-24 shrink-0" value={r.code} onChange={code => set({ errorPages: o.errorPages.map((x, j) => (j === i ? { ...x, code } : x)) })} options={['400', '401', '403', '404', '410', '500', '502', '503']} />
                <Input className={cn(MONO, 'flex-1 min-w-0')} placeholder="/errors/404.html" value={r.path} onChange={e => set({ errorPages: o.errorPages.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} />
                <Button variant="ghost" size="icon-xs" onClick={() => set({ errorPages: o.errorPages.filter((_, j) => j !== i) })}><X /></Button>
              </div>
            ))}
            <Button variant="outline" size="xs" onClick={() => set({ errorPages: [...o.errorPages, { code: '500', path: '/500.html' }] })}><Plus /> Add error page</Button>
          </div>
        </Section>
        <Section title="Performance">
          <Opt checked={o.compression} onChange={compression => set({ compression })} title="Compression">Brotli where available, gzip/deflate otherwise — typically 60-80% smaller text assets.</Opt>
          <Opt checked={o.caching} onChange={caching => set({ caching })} title="Browser caching (mod_expires)">Long cache lifetimes for fingerprinted assets; keep HTML short so deploys show up.</Opt>
          {o.caching && (
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
              {(['html', 'css', 'js', 'images', 'fonts', 'media'] as const).map(k => (
                <Field key={k} label={{ html: 'HTML', css: 'CSS', js: 'JavaScript', images: 'Images', fonts: 'Fonts', media: 'Audio / video' }[k]}>
                  <Sel value={o.cache[k]} onChange={v => set({ cache: { ...o.cache, [k]: v } })} options={DURATIONS.map(d => ({ value: d, label: d || '— (skip)' }))} />
                </Field>
              ))}
            </div>
          )}
        </Section>
        <Section title="Security">
          <div className="grid gap-2 sm:grid-cols-2">
            <Opt checked={o.hsts} onChange={hsts => set({ hsts })} title="HSTS">Browsers only use HTTPS for a year. Enable only once HTTPS works everywhere.</Opt>
            {o.hsts && <Opt checked={o.hstsPreload} onChange={hstsPreload => set({ hstsPreload })} title="HSTS preload">Required for hstspreload.org — hard to undo.</Opt>}
            <Opt checked={o.nosniff} onChange={nosniff => set({ nosniff })} title="X-Content-Type-Options">Stops MIME sniffing.</Opt>
            <Opt checked={o.permissionsPolicy} onChange={permissionsPolicy => set({ permissionsPolicy })} title="Permissions-Policy">Disable camera, mic, geolocation, FLoC.</Opt>
            <Opt checked={o.noIndexes} onChange={noIndexes => set({ noIndexes })} title="Disable directory listing">No auto-generated file indexes.</Opt>
            <Opt checked={o.protectDotfiles} onChange={protectDotfiles => set({ protectDotfiles })} title="Block hidden files">.git, .env, .htpasswd… return 403/404.</Opt>
            <Opt checked={o.noSignature} onChange={noSignature => set({ noSignature })} title="Hide server signature">Removes version info and X-Powered-By.</Opt>
            <Opt checked={o.charset} onChange={charset => set({ charset })} title="Default charset UTF-8" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="X-Frame-Options (clickjacking)"><Sel value={o.frameOptions} onChange={frameOptions => set({ frameOptions })} options={[{ value: 'SAMEORIGIN', label: 'SAMEORIGIN' }, { value: 'DENY', label: 'DENY' }, { value: 'none', label: '— (skip)' }]} /></Field>
            <Field label="Referrer-Policy"><Sel value={o.referrerPolicy} onChange={referrerPolicy => set({ referrerPolicy })} options={['', 'no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'no-referrer-when-downgrade'].map(v => ({ value: v, label: v || '— (skip)' }))} /></Field>
          </div>
          <Field label="Content-Security-Policy (optional)" hint="Test with Content-Security-Policy-Report-Only first — a strict CSP easily breaks pages.">
            <Input className={MONO} placeholder="default-src 'self'; img-src 'self' data: https:" value={o.csp} onChange={e => set({ csp: e.target.value })} />
          </Field>
          <Field label="Block IP addresses / ranges" hint="One per line — IPv4, IPv6 or CIDR (203.0.113.0/24).">
            <Textarea className={cn(MONO, FIXED, 'h-20')} value={o.blockIps.join('\n')} onChange={e => set({ blockIps: e.target.value.split('\n') })} />
          </Field>
          <Opt checked={o.hotlink} onChange={hotlink => set({ hotlink })} title="Hotlink protection">Other sites can’t embed your images (empty referrers still allowed).</Opt>
          {o.hotlink && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Your domain"><Input className={MONO} value={o.hotlinkDomain} onChange={e => set({ hotlinkDomain: e.target.value })} /></Field>
              <Field label="Protected extensions"><Input className={MONO} value={o.hotlinkExts} onChange={e => set({ hotlinkExts: e.target.value })} /></Field>
            </div>
          )}
        </Section>
      </div>
      <div className="space-y-2 min-w-0 xl:sticky xl:top-2 self-start">
        <CodeOut label=".htaccess" value={out} filename=".htaccess" className="h-[40rem]" />
        <InfoBox>Requires Apache with <code>AllowOverride All</code> and mod_rewrite / mod_headers / mod_expires / mod_deflate enabled — each block is wrapped in <code>&lt;IfModule&gt;</code> so missing modules don’t cause a 500.</InfoBox>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// robots.txt generator & tester
// ═════════════════════════════════════════════════════════════════════════════

const ROBOTS_PRESETS: Record<string, { label: string; make: () => L.RobotsModel }> = {
  allow: { label: 'Allow all', make: () => ({ groups: [{ agents: ['*'], allow: [], disallow: [] }], sitemaps: ['https://example.com/sitemap.xml'] }) },
  block: { label: 'Block all', make: () => ({ groups: [{ agents: ['*'], allow: [], disallow: ['/'] }], sitemaps: [] }) },
  ai: {
    label: 'Block AI crawlers',
    make: () => ({
      groups: [
        { agents: ['*'], allow: [], disallow: [] },
        { agents: [...L.AI_CRAWLERS], allow: [], disallow: ['/'], comment: 'AI training & answer-engine crawlers' },
      ],
      sitemaps: ['https://example.com/sitemap.xml'],
    }),
  },
  wordpress: {
    label: 'WordPress',
    make: () => ({
      groups: [{ agents: ['*'], allow: ['/wp-admin/admin-ajax.php'], disallow: ['/wp-admin/', '/wp-login.php', '/?s=', '/search/', '/*?replytocom=', '/trackback/'] }],
      sitemaps: ['https://example.com/wp-sitemap.xml'],
    }),
  },
  shop: {
    label: 'E-commerce',
    make: () => ({
      groups: [{ agents: ['*'], allow: [], disallow: ['/cart', '/checkout', '/account', '/*?*sort=', '/*?*filter=', '/search'] }],
      sitemaps: ['https://example.com/sitemap.xml'],
    }),
  },
};

const TEST_AGENTS = ['Googlebot', 'Bingbot', 'GPTBot', 'ClaudeBot', 'CCBot', 'PerplexityBot', 'Google-Extended', 'DuckDuckBot', 'YandexBot', 'Applebot', '*'];

export function RobotsTxtGenerator() {
  const [m, setM] = useState<L.RobotsModel>(() => ({
    groups: [
      { agents: ['*'], allow: ['/admin/public/'], disallow: ['/admin/', '/api/', '/*.pdf$'] },
      { agents: ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended'], allow: [], disallow: ['/'], comment: 'No AI training' },
    ],
    sitemaps: ['https://example.com/sitemap.xml'],
  }));
  const [importText, setImportText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [ua, setUa] = useState('Googlebot');
  const [path, setPath] = useState('/admin/settings');
  const out = useMemo(() => L.generateRobots(m), [m]);
  const verdict = useMemo(() => L.robotsAllows(out, ua, path), [out, ua, path]);
  const setGroup = (i: number, p: Partial<L.RobotsGroup>) => setM({ ...m, groups: m.groups.map((g, j) => (j === i ? { ...g, ...p } : g)) });
  const lines = (s: string) => s.split('\n');

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-3 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground mr-1">Presets:</span>
          {Object.entries(ROBOTS_PRESETS).map(([k, p]) => <Button key={k} variant="secondary" size="xs" onClick={() => setM(p.make())}>{p.label}</Button>)}
          <Button variant="ghost" size="xs" onClick={() => setImportOpen(o => !o)}><Import /> Import</Button>
        </div>
        {importOpen && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <Textarea className={cn(MONO, FIXED, 'h-32')} placeholder="Paste an existing robots.txt…" value={importText} onChange={e => setImportText(e.target.value)} />
            <Button size="sm" disabled={!importText.trim()} onClick={() => { setM(L.parseRobots(importText)); setImportOpen(false); }}>Load into editor</Button>
          </div>
        )}
        {m.groups.map((g, i) => (
          <Card size="sm" key={i}>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Input className={cn(MONO, 'flex-1 min-w-0')} value={g.agents.join(', ')} placeholder="User-agents, comma-separated (* = all)"
                  onChange={e => setGroup(i, { agents: e.target.value.split(',').map(s => s.trimStart()) })} />
                <Button variant="ghost" size="icon-xs" title="Remove group" onClick={() => setM({ ...m, groups: m.groups.filter((_, j) => j !== i) })}><Trash2 /></Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Disallow (one path per line)"><Textarea className={cn(MONO, FIXED, 'h-24')} value={g.disallow.join('\n')} onChange={e => setGroup(i, { disallow: lines(e.target.value) })} /></Field>
                <Field label="Allow (overrides when more specific)"><Textarea className={cn(MONO, FIXED, 'h-24')} value={g.allow.join('\n')} onChange={e => setGroup(i, { allow: lines(e.target.value) })} /></Field>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <NumberField className="w-36" label="Crawl-delay" suffix="s" min={0} value={g.crawlDelay ?? 0} onChange={v => setGroup(i, { crawlDelay: Number.isFinite(v) && v > 0 ? v : null })} />
                <Field label="Comment" className="flex-1 min-w-40"><Input value={g.comment ?? ''} onChange={e => setGroup(i, { comment: e.target.value })} /></Field>
              </div>
            </CardContent>
          </Card>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setM({ ...m, groups: [...m.groups, { agents: [''], allow: [], disallow: [] }] })}><Plus /> Add user-agent group</Button>
          <Button variant="outline" size="sm" onClick={() => setM({ ...m, groups: [...m.groups, { agents: [...L.AI_CRAWLERS], allow: [], disallow: ['/'], comment: 'AI crawlers' }] })}><Plus /> Block AI crawlers group</Button>
        </div>
        <Field label="Sitemaps"><ListEditor items={m.sitemaps} onChange={sitemaps => setM({ ...m, sitemaps })} placeholder="https://example.com/sitemap.xml" addLabel="Add sitemap" /></Field>
        <InfoBox>Crawl-delay is ignored by Google (use Search Console). robots.txt is advisory — it doesn’t protect private content and listed paths are public. Google-Extended and Applebot-Extended only control AI training use, not search indexing.</InfoBox>
      </div>
      <div className="space-y-3 min-w-0">
        <CodeOut label="robots.txt" value={out} filename="robots.txt" className="h-80" />
        <Section title="Tester" description="Checks the generated file using Google’s rules: most specific user-agent group, longest matching path wins, Allow wins ties, * and $ wildcards.">
          <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
            <Field label="User-agent">
              <Input className={MONO} value={ua} list="robots-uas" onChange={e => setUa(e.target.value)} />
              <datalist id="robots-uas">{TEST_AGENTS.map(a => <option key={a} value={a} />)}</datalist>
            </Field>
            <Field label="URL or path"><Input className={MONO} value={path} onChange={e => setPath(e.target.value)} /></Field>
          </div>
          <div className={cn('flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm', verdict.allowed ? 'border-primary/40 bg-primary/5' : 'border-destructive/40 bg-destructive/10')}>
            <Badge variant={verdict.allowed ? 'default' : 'destructive'}>{verdict.allowed ? 'Allowed' : 'Blocked'}</Badge>
            <span className="text-xs text-muted-foreground">
              group <code className="font-mono">User-agent: {verdict.agent}</code>
              {verdict.rule ? <> · matched <code className="font-mono">{verdict.rule.type === 'allow' ? 'Allow' : 'Disallow'}: {verdict.rule.pattern}</code></> : ' · no rule matched'}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {TEST_AGENTS.slice(0, -1).map(a => {
              const v = L.robotsAllows(out, a, path).allowed;
              return <button key={a} type="button" onClick={() => setUa(a)} className={cn('rounded border px-1.5 py-0.5 text-[11px] cursor-pointer', v ? 'border-border text-muted-foreground' : 'border-destructive/40 text-destructive')}>{v ? '✓' : '✕'} {a}</button>;
            })}
          </div>
        </Section>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Meta tag generator
// ═════════════════════════════════════════════════════════════════════════════

function LengthMeter({ value, min, max, hardMax }: { value: string; min: number; max: number; hardMax: number }) {
  const n = value.length;
  const status = n === 0 ? 'empty' : n < min ? 'short' : n <= max ? 'good' : n <= hardMax ? 'long' : 'cut';
  const color = status === 'good' ? 'bg-primary' : status === 'cut' ? 'bg-destructive' : 'bg-muted-foreground';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 rounded-full bg-secondary overflow-hidden"><div className={cn('h-full transition-all', color)} style={{ width: `${Math.min(100, (n / hardMax) * 100)}%` }} /></div>
      <span className={cn('text-[11px] tabular-nums', status === 'cut' ? 'text-destructive' : 'text-muted-foreground')}>
        {n} / {min}–{max} {status === 'short' ? '· short' : status === 'long' ? '· may be truncated' : status === 'cut' ? '· will be truncated' : ''}
      </span>
    </div>
  );
}

export function MetaTagGenerator() {
  const [m, setM] = useState<L.MetaModel>({
    title: 'Acme Analytics — Real-time dashboards for growing teams',
    description: 'Track every metric that matters in one place. Connect your data in minutes, share live dashboards and get alerts before problems hit customers.',
    keywords: '', author: 'Acme Inc.', canonical: 'https://acme.example/', robotsIndex: true, robotsFollow: true, viewport: true, charset: true,
    themeColor: '#4f46e5', lang: 'en', ogType: 'website', ogImage: 'https://placehold.co/1200x630/4f46e5/ffffff/png?text=Acme+Analytics', ogImageAlt: 'Acme Analytics dashboard',
    siteName: 'Acme Analytics', locale: 'en_US', url: '', twitterCard: 'summary_large_image', twitterSite: '@acme', twitterCreator: '',
    favicon: '/favicon.svg', appleTouchIcon: '/apple-touch-icon.png', manifest: '/site.webmanifest',
  });
  const [preview, setPreview] = useState<'google' | 'social' | 'x'>('google');
  const set = (p: Partial<L.MetaModel>) => setM(prev => ({ ...prev, ...p }));
  const out = useMemo(() => L.generateMetaTags(m), [m]);
  const host = useMemo(() => { try { return new URL(m.canonical || m.url).host; } catch { return 'example.com'; } }, [m.canonical, m.url]);
  const crumbs = useMemo(() => { try { const u = new URL(m.canonical || m.url); return u.pathname.split('/').filter(Boolean).join(' › '); } catch { return ''; } }, [m.canonical, m.url]);
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const txt = (k: keyof L.MetaModel, label: string, ph = '') => <Field label={label}><Input value={String(m[k])} placeholder={ph} onChange={e => set({ [k]: e.target.value } as Partial<L.MetaModel>)} /></Field>;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-3 min-w-0">
        <Section title="Search">
          <Field label="Title"><Input value={m.title} onChange={e => set({ title: e.target.value })} /><LengthMeter value={m.title} min={30} max={60} hardMax={70} /></Field>
          <Field label="Description"><Textarea className={cn(FIXED, 'h-20')} value={m.description} onChange={e => set({ description: e.target.value })} /><LengthMeter value={m.description} min={70} max={160} hardMax={200} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            {txt('canonical', 'Canonical URL', 'https://example.com/page')}
            {txt('author', 'Author')}
          </div>
          <div className="flex flex-wrap gap-3">
            <Checkbox checked={m.robotsIndex} onChange={robotsIndex => set({ robotsIndex })}>index</Checkbox>
            <Checkbox checked={m.robotsFollow} onChange={robotsFollow => set({ robotsFollow })}>follow links</Checkbox>
            <Checkbox checked={m.viewport} onChange={viewport => set({ viewport })}>viewport</Checkbox>
            <Checkbox checked={m.charset} onChange={charset => set({ charset })}>charset</Checkbox>
          </div>
        </Section>
        <Section title="Social (Open Graph & X)">
          <div className="grid gap-3 sm:grid-cols-2">
            {txt('siteName', 'Site name')}
            <Field label="og:type"><Sel value={m.ogType} onChange={ogType => set({ ogType })} options={['website', 'article', 'product', 'profile', 'video.other', 'music.song', 'book']} /></Field>
            {txt('ogImage', 'Image URL (1200×630)', 'https://…/og.png')}
            {txt('ogImageAlt', 'Image alt text')}
            {txt('locale', 'Locale', 'en_US')}
            <Field label="Twitter card"><Sel value={m.twitterCard} onChange={twitterCard => set({ twitterCard })} options={[{ value: 'summary_large_image', label: 'Large image' }, { value: 'summary', label: 'Summary' }, { value: 'none', label: 'None' }]} /></Field>
            {txt('twitterSite', 'X / Twitter @site')}
            {txt('twitterCreator', 'X / Twitter @creator')}
          </div>
        </Section>
        <Section title="Icons & theme">
          <div className="grid gap-3 sm:grid-cols-2">
            {txt('favicon', 'Favicon')}
            {txt('appleTouchIcon', 'Apple touch icon (180×180)')}
            {txt('manifest', 'Web manifest')}
            <ColorField label="theme-color" value={m.themeColor || '#000000'} onChange={themeColor => set({ themeColor })} />
          </div>
        </Section>
      </div>
      <div className="space-y-3 min-w-0">
        <Segmented value={preview} onChange={setPreview} options={[{ value: 'google', label: 'Google' }, { value: 'social', label: 'Facebook / LinkedIn' }, { value: 'x', label: 'X' }]} />
        {/* Previews deliberately use the platforms' own colours. */}
        {preview === 'google' && (
          <div className="rounded-lg border border-border bg-white p-4 text-left" style={{ fontFamily: 'arial, sans-serif' }}>
            <div className="flex items-center gap-2">
              <div className="grid size-7 place-items-center rounded-full bg-[#f1f3f4] text-[11px] text-[#4d5156]">{(m.siteName || host)[0]?.toUpperCase()}</div>
              <div className="min-w-0"><p className="text-[14px] text-[#202124] truncate">{m.siteName || host}</p><p className="text-[12px] text-[#4d5156] truncate">https://{host}{crumbs ? ` › ${crumbs}` : ''}</p></div>
            </div>
            <p className="mt-1 text-[20px] leading-[1.3] text-[#1a0dab] hover:underline cursor-pointer break-words">{trunc(m.title || 'Page title', 60)}</p>
            <p className="text-[14px] leading-[1.58] text-[#4d5156] break-words">{trunc(m.description || 'Add a description to control the snippet shown in search results.', 158)}</p>
            {!m.robotsIndex && <p className="mt-2 text-xs text-[#d93025]">noindex — this page won’t appear in search results.</p>}
          </div>
        )}
        {preview === 'social' && (
          <div className="overflow-hidden rounded-lg border border-[#dadde1] bg-white max-w-lg">
            {m.ogImage ? <img src={m.ogImage} alt={m.ogImageAlt} className="aspect-[1.91/1] w-full object-cover bg-[#f0f2f5]" /> : <div className="aspect-[1.91/1] w-full bg-[#f0f2f5] grid place-items-center text-xs text-[#606770]">No og:image</div>}
            <div className="border-t border-[#dadde1] bg-[#f0f2f5] px-3 py-2" style={{ fontFamily: 'Helvetica, Arial, sans-serif' }}>
              <p className="text-[12px] uppercase text-[#606770] truncate">{host}</p>
              <p className="text-[16px] font-semibold leading-5 text-[#1d2129] line-clamp-2">{m.title}</p>
              <p className="text-[14px] leading-5 text-[#606770] line-clamp-1">{m.description}</p>
            </div>
          </div>
        )}
        {preview === 'x' && (
          m.twitterCard === 'summary' ? (
            <div className="flex overflow-hidden rounded-2xl border border-[#cfd9de] bg-white max-w-lg">
              {m.ogImage && <img src={m.ogImage} alt="" className="size-32 shrink-0 object-cover" />}
              <div className="min-w-0 p-3"><p className="text-[13px] text-[#536471]">{host}</p><p className="text-[15px] text-[#0f1419] truncate">{m.title}</p><p className="text-[15px] text-[#536471] line-clamp-2">{m.description}</p></div>
            </div>
          ) : (
            <div className="max-w-lg">
              <div className="relative overflow-hidden rounded-2xl border border-[#cfd9de]">
                {m.ogImage ? <img src={m.ogImage} alt="" className="aspect-[1.91/1] w-full object-cover" /> : <div className="aspect-[1.91/1] bg-[#f7f9f9]" />}
                <span className="absolute bottom-3 left-3 max-w-[85%] truncate rounded bg-black/70 px-1.5 text-[13px] text-white">{m.title}</span>
              </div>
              <p className="mt-1 text-[13px] text-[#536471]">From {host}</p>
            </div>
          )
        )}
        <CodeOut label="HTML <head> tags" value={out} filename="meta-tags.html" mime="text/html" className="h-80" />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// docker-compose generator
// ═════════════════════════════════════════════════════════════════════════════

function composeWarnings(m: L.ComposeModel): string[] {
  const w: string[] = [];
  const names = m.services.map(s => s.name.trim());
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) w.push(`Duplicate service name: ${[...new Set(dup)].join(', ')}`);
  const hostPorts = new Map<string, string>();
  for (const s of m.services) {
    if (!s.name.trim()) w.push('A service has no name.');
    else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s.name.trim())) w.push(`"${s.name}" isn’t a valid service name (letters, digits, _ . -).`);
    if (!s.image.trim() && !s.build) w.push(`${s.name}: needs an image or a build context.`);
    for (const d of s.dependsOn) if (d.name && !names.includes(d.name)) w.push(`${s.name}: depends_on "${d.name}" doesn’t exist.`);
    for (const d of s.dependsOn) if (d.condition === 'service_healthy' && !m.services.find(x => x.name === d.name)?.healthcheck) w.push(`${s.name}: waits for "${d.name}" to be healthy, but it has no healthcheck.`);
    for (const p of s.ports.filter(Boolean)) {
      if (!/^(\[?[\d.:a-fA-F]+\]?:)?(\d+(-\d+)?:)?\d+(-\d+)?(\/(tcp|udp|sctp))?$/.test(p.trim()) && !/^\$\{/.test(p)) w.push(`${s.name}: port "${p}" looks wrong (use HOST:CONTAINER, e.g. 8080:80).`);
      const host = p.trim().split(':').length > 1 ? p.trim().split(':').slice(-2, -1)[0] : '';
      if (host) { if (hostPorts.has(host)) w.push(`Host port ${host} is used by both ${hostPorts.get(host)} and ${s.name}.`); else hostPorts.set(host, s.name); }
    }
    if (s.env.some(e => /password|secret|token/i.test(e.key) && /^(change-me|password|secret|admin|root)$/i.test(e.value))) w.push(`${s.name}: placeholder secret — move secrets to an env_file or Docker secrets.`);
    if (/:latest$/.test(s.image.trim()) || (s.image.trim() && !s.image.includes(':') && !s.image.includes('@'))) w.push(`${s.name}: pin an image tag instead of latest for reproducible deploys.`);
  }
  return w;
}

function ServiceEditor({ s, all, onChange, onRemove, onDuplicate }: {
  s: L.ComposeService; all: string[]; onChange: (s: L.ComposeService) => void; onRemove: () => void; onDuplicate: () => void;
}) {
  const [open, setOpen] = useState(true);
  const set = (p: Partial<L.ComposeService>) => onChange({ ...s, ...p });
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-xs" onClick={() => setOpen(o => !o)}>{open ? <ChevronUp /> : <ChevronDown />}</Button>
          <Input className={cn(MONO, 'h-7 w-40 font-semibold')} value={s.name} onChange={e => set({ name: e.target.value })} />
          <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">{s.image || (s.build ? `build: ${s.build.context}` : '')}</span>
          <Button variant="ghost" size="icon-xs" title="Duplicate" onClick={onDuplicate}><Copy /></Button>
          <Button variant="ghost" size="icon-xs" title="Remove service" onClick={onRemove}><Trash2 /></Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Image"><Input className={MONO} placeholder="postgres:17-alpine" value={s.image} onChange={e => set({ image: e.target.value })} /></Field>
            <Field label="Restart policy"><Sel value={s.restart} onChange={restart => set({ restart })} options={[{ value: '', label: '— (default: no)' }, { value: 'unless-stopped', label: 'unless-stopped' }, { value: 'always', label: 'always' }, { value: 'on-failure', label: 'on-failure' }, { value: 'no', label: 'no' }]} /></Field>
          </div>
          <div className="space-y-2">
            <Checkbox checked={!!s.build} onChange={v => set({ build: v ? { context: '.', dockerfile: 'Dockerfile' } : null })}>Build from a Dockerfile</Checkbox>
            {s.build && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Build context"><Input className={MONO} value={s.build.context} onChange={e => set({ build: { ...s.build!, context: e.target.value } })} /></Field>
                <Field label="Dockerfile"><Input className={MONO} value={s.build.dockerfile} onChange={e => set({ build: { ...s.build!, dockerfile: e.target.value } })} /></Field>
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Container name (optional)"><Input className={MONO} value={s.containerName} onChange={e => set({ containerName: e.target.value })} /></Field>
            <Field label="Command (optional)"><Input className={MONO} value={s.command} onChange={e => set({ command: e.target.value })} /></Field>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Ports (HOST:CONTAINER)"><ListEditor items={s.ports} onChange={ports => set({ ports })} placeholder="8080:80" addLabel="Add port" /></Field>
            <Field label="Networks"><ListEditor items={s.networks} onChange={networks => set({ networks })} placeholder="backend" addLabel="Add network" /></Field>
          </div>
          <Field label="Environment"><KvTable rows={s.env} onChange={env => set({ env })} keyPlaceholder="KEY" valuePlaceholder="value" addLabel="Add variable" /></Field>
          <Field label="env_file"><ListEditor items={s.envFile} onChange={envFile => set({ envFile })} placeholder=".env" addLabel="Add env file" /></Field>
          <Field label="Volumes" hint="A name (pgdata) creates a named volume; a path (./data, /srv/x) is a bind mount.">
            <div className="space-y-1.5">
              {s.volumes.map((v, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input className={cn(MONO, 'flex-1 min-w-0')} placeholder="pgdata or ./data" value={v.source} onChange={e => set({ volumes: s.volumes.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)) })} />
                  <span className="text-xs text-muted-foreground">:</span>
                  <Input className={cn(MONO, 'flex-1 min-w-0')} placeholder="/container/path" value={v.target} onChange={e => set({ volumes: s.volumes.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)) })} />
                  <Badge variant="outline" className="hidden sm:inline-flex">{v.source ? (L.isNamedVolume(v.source) ? 'named' : 'bind') : 'anon'}</Badge>
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground"><input type="checkbox" checked={!!v.readOnly} onChange={e => set({ volumes: s.volumes.map((x, j) => (j === i ? { ...x, readOnly: e.target.checked } : x)) })} />ro</label>
                  <Button variant="ghost" size="icon-xs" onClick={() => set({ volumes: s.volumes.filter((_, j) => j !== i) })}><X /></Button>
                </div>
              ))}
              <Button variant="outline" size="xs" onClick={() => set({ volumes: [...s.volumes, { source: '', target: '' }] })}><Plus /> Add volume</Button>
            </div>
          </Field>
          <Field label="depends_on">
            <div className="space-y-1.5">
              {s.dependsOn.map((d, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Sel className="flex-1" value={d.name} onChange={name => set({ dependsOn: s.dependsOn.map((x, j) => (j === i ? { ...x, name } : x)) })} options={[{ value: '', label: '— service —' }, ...all.filter(n => n !== s.name).map(n => ({ value: n, label: n }))]} />
                  <Sel className="flex-1" value={d.condition} onChange={condition => set({ dependsOn: s.dependsOn.map((x, j) => (j === i ? { ...x, condition } : x)) })} options={[{ value: 'service_started', label: 'started' }, { value: 'service_healthy', label: 'healthy' }, { value: 'service_completed_successfully', label: 'completed successfully' }]} />
                  <Button variant="ghost" size="icon-xs" onClick={() => set({ dependsOn: s.dependsOn.filter((_, j) => j !== i) })}><X /></Button>
                </div>
              ))}
              <Button variant="outline" size="xs" disabled={all.length < 2} onClick={() => set({ dependsOn: [...s.dependsOn, { name: all.find(n => n !== s.name) ?? '', condition: 'service_started' }] })}><Plus /> Add dependency</Button>
            </div>
          </Field>
          <div className="space-y-2">
            <Checkbox checked={!!s.healthcheck} onChange={v => set({ healthcheck: v ? { test: 'curl -fsS http://localhost/ || exit 1', interval: '30s', timeout: '5s', retries: 3, startPeriod: '10s' } : null })}>Healthcheck</Checkbox>
            {s.healthcheck && (
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
                <Field label="Test (shell)" className="col-span-full"><Input className={MONO} value={s.healthcheck.test} onChange={e => set({ healthcheck: { ...s.healthcheck!, test: e.target.value } })} /></Field>
                <Field label="Interval"><Input className={MONO} value={s.healthcheck.interval} onChange={e => set({ healthcheck: { ...s.healthcheck!, interval: e.target.value } })} /></Field>
                <Field label="Timeout"><Input className={MONO} value={s.healthcheck.timeout} onChange={e => set({ healthcheck: { ...s.healthcheck!, timeout: e.target.value } })} /></Field>
                <Field label="Retries"><Input type="number" min={0} value={s.healthcheck.retries} onChange={e => set({ healthcheck: { ...s.healthcheck!, retries: Number(e.target.value) || 0 } })} /></Field>
                <Field label="Start period"><Input className={MONO} value={s.healthcheck.startPeriod} onChange={e => set({ healthcheck: { ...s.healthcheck!, startPeriod: e.target.value } })} /></Field>
              </div>
            )}
          </div>
          <div className="grid gap-3 grid-cols-2">
            <Field label="CPU limit"><Input className={MONO} placeholder="0.5" value={s.cpus} onChange={e => set({ cpus: e.target.value })} /></Field>
            <Field label="Memory limit"><Input className={MONO} placeholder="512M" value={s.memory} onChange={e => set({ memory: e.target.value })} /></Field>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export function DockerComposeGenerator() {
  const [m, setM] = useState<L.ComposeModel>(() => {
    const app = L.COMPOSE_TEMPLATES.node.make();
    const db = L.COMPOSE_TEMPLATES.postgres.make();
    const redis = L.COMPOSE_TEMPLATES.redis.make();
    app.dependsOn = [{ name: 'db', condition: 'service_healthy' }, { name: 'redis', condition: 'service_started' }];
    app.env.push({ key: 'DATABASE_URL', value: 'postgres://app:change-me@db:5432/app' }, { key: 'REDIS_URL', value: 'redis://redis:6379' });
    db.ports = []; redis.ports = [];
    return { name: 'myapp', services: [app, db, redis] };
  });
  const [tpl, setTpl] = useState('postgres');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState('');
  const yamlOut = useMemo(() => { try { return L.composeToYaml(m); } catch (e) { return `# ${(e as Error).message}`; } }, [m]);
  const warnings = useMemo(() => composeWarnings(m), [m]);
  const names = m.services.map(s => s.name);
  const uniqueName = (base: string) => { let n = base; let i = 2; while (names.includes(n)) n = `${base}${i++}`; return n; };

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-3 min-w-0">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Project name" className="w-40"><Input className={MONO} value={m.name} onChange={e => setM({ ...m, name: e.target.value })} /></Field>
          <Field label="Add from template" className="w-44"><Sel value={tpl} onChange={setTpl} options={Object.entries(L.COMPOSE_TEMPLATES).map(([k, t]) => ({ value: k, label: t.label }))} /></Field>
          <Button size="sm" onClick={() => { const s = L.COMPOSE_TEMPLATES[tpl].make(); s.name = uniqueName(s.name); setM({ ...m, services: [...m.services, s] }); }}><Plus /> Add</Button>
          <Button variant="outline" size="sm" onClick={() => setM({ ...m, services: [...m.services, L.newService(uniqueName('service'))] })}><Plus /> Blank service</Button>
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(o => !o)}><Import /> Import YAML</Button>
        </div>
        {importOpen && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <Textarea className={cn(MONO, FIXED, 'h-40')} placeholder="Paste an existing docker-compose.yml…" value={importText} onChange={e => setImportText(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" disabled={!importText.trim()} onClick={() => {
                try { setM(L.composeFromYaml(importText)); setImportErr(''); setImportOpen(false); } catch (e) { setImportErr((e as Error).message); }
              }}>Load into editor</Button>
              <LoadFileButton accept=".yml,.yaml" onLoad={t => setImportText(t)} />
            </div>
            {importErr && <ErrorBox message={importErr} />}
          </div>
        )}
        {m.services.map((s, i) => (
          <ServiceEditor key={i} s={s} all={names}
            onChange={ns => setM(prev => {
              // Keep depends_on references in sync when a service is renamed.
              const old = prev.services[i].name;
              const services = prev.services.map((x, j) => (j === i ? ns : old !== ns.name ? { ...x, dependsOn: x.dependsOn.map(d => (d.name === old ? { ...d, name: ns.name } : d)) } : x));
              return { ...prev, services };
            })}
            onRemove={() => setM({ ...m, services: m.services.filter((_, j) => j !== i) })}
            onDuplicate={() => setM({ ...m, services: [...m.services, { ...structuredClone(s), name: uniqueName(s.name) }] })} />
        ))}
        {!m.services.length && <InfoBox>No services yet — add one from a template.</InfoBox>}
      </div>
      <div className="space-y-2 min-w-0 xl:sticky xl:top-2 self-start">
        <CodeOut label="docker-compose.yml" value={yamlOut} filename="docker-compose.yml" mime="application/yaml" className="h-[36rem]" />
        {warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-border bg-secondary/30 px-3 py-2">
            <p className="text-xs font-medium">Checks</p>
            {warnings.map((w, i) => <p key={i} className="text-[11px] text-muted-foreground">⚠ {w}</p>)}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">Compose Specification format (no <code>version:</code> key). Run with <code>docker compose up -d</code>.</p>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Box shadow
// ═════════════════════════════════════════════════════════════════════════════

const L0 = (p: Partial<L.ShadowLayer>): L.ShadowLayer => ({ x: 0, y: 4, blur: 12, spread: 0, color: '#000000', alpha: 0.15, inset: false, enabled: true, ...p });
const SHADOW_PRESETS: Record<string, L.ShadowLayer[]> = {
  'Tailwind sm': [L0({ y: 1, blur: 2, alpha: 0.05 })],
  'Tailwind md': [L0({ y: 4, blur: 6, spread: -1, alpha: 0.1 }), L0({ y: 2, blur: 4, spread: -2, alpha: 0.1 })],
  'Tailwind lg': [L0({ y: 10, blur: 15, spread: -3, alpha: 0.1 }), L0({ y: 4, blur: 6, spread: -4, alpha: 0.1 })],
  'Tailwind xl': [L0({ y: 20, blur: 25, spread: -5, alpha: 0.1 }), L0({ y: 8, blur: 10, spread: -6, alpha: 0.1 })],
  'Tailwind 2xl': [L0({ y: 25, blur: 50, spread: -12, alpha: 0.25 })],
  'Smooth layered': [1, 2, 4, 8, 16].map(n => L0({ y: n, blur: n * 2, alpha: 0.06 })),
  'Material 2dp': [L0({ y: 2, blur: 2, alpha: 0.14 }), L0({ y: 3, blur: 1, spread: -2, alpha: 0.12 }), L0({ y: 1, blur: 5, alpha: 0.2 })],
  'Material 8dp': [L0({ y: 8, blur: 10, spread: 1, alpha: 0.14 }), L0({ y: 3, blur: 14, spread: 2, alpha: 0.12 }), L0({ y: 5, blur: 5, spread: -3, alpha: 0.2 })],
  'Hard offset': [L0({ x: 6, y: 6, blur: 0, alpha: 1, color: '#111827' })],
  'Inner': [L0({ y: 2, blur: 4, alpha: 0.12, inset: true })],
  'Neon glow': [L0({ y: 0, blur: 8, alpha: 0.9, color: '#22d3ee' }), L0({ y: 0, blur: 24, alpha: 0.6, color: '#22d3ee' })],
  'Focus ring': [L0({ y: 0, blur: 0, spread: 3, alpha: 0.45, color: '#6366f1' })],
};

export function BoxShadowGenerator() {
  const [layers, setLayers] = useState<L.ShadowLayer[]>(SHADOW_PRESETS['Tailwind lg']);
  const [active, setActive] = useState(0);
  const [boxColor, setBoxColor] = useState('#ffffff');
  const [radius, setRadius] = useState(12);
  const css = L.shadowCss(layers);
  const cur = layers[Math.min(active, layers.length - 1)];
  const upd = (p: Partial<L.ShadowLayer>) => setLayers(ls => ls.map((l, i) => (i === Math.min(active, ls.length - 1) ? { ...l, ...p } : l)));
  const box = (bg: string, label: string, dark: boolean) => (
    <div className="grid place-items-center rounded-lg p-10 min-h-56" style={{ background: bg }}>
      <div className="grid size-32 place-items-center text-xs" style={{ background: dark && boxColor === '#ffffff' ? '#1f2937' : boxColor, borderRadius: radius, boxShadow: css, color: dark ? '#e5e7eb' : '#374151' }}>{label}</div>
    </div>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <div className="space-y-3 min-w-0">
        <div className="flex flex-wrap gap-1">
          {layers.map((l, i) => (
            <button key={i} type="button" onClick={() => setActive(i)}
              className={cn('flex items-center gap-1 rounded border px-2 py-1 text-xs cursor-pointer', i === active ? 'border-primary bg-primary/10' : 'border-border', l.enabled === false && 'opacity-50')}>
              <span className="size-3 rounded-sm border border-border" style={{ background: l.color, opacity: l.alpha }} />Layer {i + 1}{l.inset ? ' (inset)' : ''}
            </button>
          ))}
          <Button variant="outline" size="xs" onClick={() => { setLayers([...layers, L0({})]); setActive(layers.length); }}><Plus /> Layer</Button>
        </div>
        {cur && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox checked={cur.enabled !== false} onChange={enabled => upd({ enabled })}>Visible</Checkbox>
              <Checkbox checked={cur.inset} onChange={inset => upd({ inset })}>Inset</Checkbox>
              <span className="ml-auto flex gap-1">
                <Button variant="ghost" size="icon-xs" title="Duplicate" onClick={() => { setLayers([...layers.slice(0, active + 1), { ...cur }, ...layers.slice(active + 1)]); setActive(active + 1); }}><Copy /></Button>
                <Button variant="ghost" size="icon-xs" title="Move up" disabled={active === 0} onClick={() => { const l = [...layers]; [l[active - 1], l[active]] = [l[active], l[active - 1]]; setLayers(l); setActive(active - 1); }}><ChevronUp /></Button>
                <Button variant="ghost" size="icon-xs" title="Move down" disabled={active >= layers.length - 1} onClick={() => { const l = [...layers]; [l[active + 1], l[active]] = [l[active], l[active + 1]]; setLayers(l); setActive(active + 1); }}><ChevronDown /></Button>
                <Button variant="ghost" size="icon-xs" title="Delete" disabled={layers.length < 2} onClick={() => { setLayers(layers.filter((_, i) => i !== active)); setActive(Math.max(0, active - 1)); }}><Trash2 /></Button>
              </span>
            </div>
            <Slider label="Offset X" value={cur.x} onChange={x => upd({ x })} min={-100} max={100} suffix="px" />
            <Slider label="Offset Y" value={cur.y} onChange={y => upd({ y })} min={-100} max={100} suffix="px" />
            <Slider label="Blur" value={cur.blur} onChange={blur => upd({ blur })} min={0} max={150} suffix="px" />
            <Slider label="Spread" value={cur.spread} onChange={spread => upd({ spread })} min={-50} max={50} suffix="px" />
            <div className="grid grid-cols-2 gap-3 items-end">
              <ColorField label="Colour" value={cur.color} onChange={color => upd({ color })} />
              <Slider label="Opacity" value={Math.round(cur.alpha * 100)} onChange={a => upd({ alpha: a / 100 })} min={0} max={100} suffix="%" />
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 items-end">
          <ColorField label="Box colour" value={boxColor} onChange={setBoxColor} />
          <Slider label="Box radius" value={radius} onChange={setRadius} min={0} max={64} suffix="px" />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Presets</p>
          <div className="flex flex-wrap gap-1">
            {Object.keys(SHADOW_PRESETS).map(k => <Button key={k} variant="secondary" size="xs" onClick={() => { setLayers(SHADOW_PRESETS[k].map(l => ({ ...l }))); setActive(0); }}>{k}</Button>)}
          </div>
        </div>
      </div>
      <div className="space-y-3 min-w-0">
        <div className="grid gap-3 sm:grid-cols-2">
          {box('#f3f4f6', 'Light', false)}
          {box('#0b1120', 'Dark', true)}
        </div>
        <CodeOut label="CSS" value={`box-shadow: ${css};`} className="h-24 whitespace-pre-wrap" />
        <CodeOut label="Tailwind (arbitrary value)" value={L.tailwindArbitrary('shadow', css)} className="h-20 whitespace-pre-wrap break-all" />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Border radius
// ═════════════════════════════════════════════════════════════════════════════

const BLOB_PRESETS: [number[], number[]][] = [
  [[30, 70, 70, 30], [30, 30, 70, 70]], [[60, 40, 30, 70], [60, 30, 70, 40]], [[40, 60, 60, 40], [60, 30, 70, 40]], [[73, 27, 59, 41], [57, 43, 57, 43]],
];

export function BorderRadiusGenerator() {
  const [mode, setMode] = useState<'simple' | 'blob'>('simple');
  const [r, setR] = useState<L.RadiusModel>({ tl: 24, tr: 24, br: 24, bl: 4, unit: 'px' });
  const [linked, setLinked] = useState(false);
  const [h, setH] = useState([30, 70, 70, 30]);
  const [v, setV] = useState([30, 30, 70, 70]);
  const [color, setColor] = useState('#6366f1');
  const css = mode === 'simple' ? L.radiusCss(r) : L.blobRadiusCss(h, v);
  const max = r.unit === '%' ? 50 : r.unit === 'rem' ? 8 : 200;
  const step = r.unit === 'rem' ? 0.125 : 1;
  const setCorner = (k: 'tl' | 'tr' | 'br' | 'bl', val: number) => setR(linked ? { ...r, tl: val, tr: val, br: val, bl: val } : { ...r, [k]: val });
  const corners: { k: 'tl' | 'tr' | 'br' | 'bl'; label: string }[] = [{ k: 'tl', label: 'Top left' }, { k: 'tr', label: 'Top right' }, { k: 'br', label: 'Bottom right' }, { k: 'bl', label: 'Bottom left' }];
  const random = () => {
    const rnd = () => 20 + Math.round(Math.random() * 60);
    const a = [rnd(), rnd(), rnd(), rnd()];
    setH([a[0], 100 - a[0], a[1], 100 - a[1]]);
    setV([a[2], a[3], 100 - a[3], 100 - a[2]]);
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <div className="space-y-3 min-w-0">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'simple', label: 'Per corner' }, { value: 'blob', label: 'Blob (8-value)' }]} />
        {mode === 'simple' ? (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox checked={linked} onChange={l => { setLinked(l); if (l) setR({ ...r, tr: r.tl, br: r.tl, bl: r.tl }); }}>Link all corners</Checkbox>
              <Segmented value={r.unit} onChange={unit => setR({ ...r, unit, ...(unit === '%' ? { tl: Math.min(r.tl, 50), tr: Math.min(r.tr, 50), br: Math.min(r.br, 50), bl: Math.min(r.bl, 50) } : unit === 'rem' ? { tl: Math.min(r.tl, 8), tr: Math.min(r.tr, 8), br: Math.min(r.br, 8), bl: Math.min(r.bl, 8) } : {}) })}
                options={[{ value: 'px', label: 'px' }, { value: '%', label: '%' }, { value: 'rem', label: 'rem' }]} />
            </div>
            {corners.map(c => <Slider key={c.k} label={c.label} value={r[c.k]} onChange={x => setCorner(c.k, x)} min={0} max={max} step={step} suffix={r.unit} />)}
          </div>
        ) : (
          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-[11px] text-muted-foreground">Horizontal / vertical radii per corner — great for organic “blob” shapes.</p>
            {['Top left', 'Top right', 'Bottom right', 'Bottom left'].map((label, i) => (
              <div key={i} className="grid grid-cols-2 gap-2">
                <Slider label={`${label} ↔`} value={h[i]} onChange={x => setH(h.map((y, j) => (j === i ? x : y)))} min={0} max={100} suffix="%" />
                <Slider label="↕" value={v[i]} onChange={x => setV(v.map((y, j) => (j === i ? x : y)))} min={0} max={100} suffix="%" />
              </div>
            ))}
            <div className="flex flex-wrap gap-1">
              <Button variant="outline" size="xs" onClick={random}><RefreshCw /> Randomise</Button>
              {BLOB_PRESETS.map(([a, b], i) => (
                <button key={i} type="button" title="Preset" onClick={() => { setH([...a]); setV([...b]); }} className="size-7 cursor-pointer border border-border bg-primary/60" style={{ borderRadius: L.blobRadiusCss(a, b) }} />
              ))}
            </div>
          </div>
        )}
        <ColorField label="Preview colour" value={color} onChange={setColor} />
      </div>
      <div className="space-y-3 min-w-0">
        <div className="grid place-items-center rounded-lg border border-border bg-secondary/30 p-8 min-h-72">
          <div className="size-56 max-w-full transition-[border-radius] duration-200" style={{ borderRadius: css, background: `linear-gradient(135deg, ${color}, ${L.shade(color, -0.35)})` }} />
        </div>
        <CodeOut label="CSS" value={`border-radius: ${css};`} className="h-16" />
        <CodeOut label="Tailwind" value={mode === 'simple' && css === '0' ? 'rounded-none' : L.tailwindArbitrary('rounded', css)} className="h-16 break-all whitespace-pre-wrap" />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Glassmorphism / Neumorphism
// ═════════════════════════════════════════════════════════════════════════════

export function GlassmorphismGenerator() {
  const [tab, setTab] = useState<'glass' | 'neu'>('glass');
  const [g, setG] = useState<L.GlassModel>({ blur: 12, transparency: 0.25, saturation: 180, color: '#ffffff', border: true, borderOpacity: 0.3, radius: 16, shadow: true });
  const [bgKind, setBgKind] = useState<'gradient' | 'photo' | 'dark'>('gradient');
  const [n, setN] = useState<L.NeuModel>({ color: '#e0e5ec', distance: 12, intensity: 0.15, blur: 24, radius: 32, shape: 'flat' });
  const glass = L.glassCss(g);
  const neu = L.neumorphismCss(n);
  const toStyle = (css: string): React.CSSProperties => Object.fromEntries(css.split('\n').map(l => l.replace(/;$/, '').split(/:\s(.+)/)).filter(([k]) => k).map(([k, val]) => [
    k.startsWith('-webkit-') ? 'WebkitBackdropFilter' : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), val,
  ]));
  const bgs = {
    gradient: 'radial-gradient(circle at 20% 30%, #f472b6 0, transparent 40%), radial-gradient(circle at 80% 20%, #60a5fa 0, transparent 45%), radial-gradient(circle at 60% 80%, #34d399 0, transparent 40%), linear-gradient(135deg, #312e81, #7c3aed)',
    photo: 'url(https://picsum.photos/seed/glass/900/600) center/cover, linear-gradient(135deg, #0ea5e9, #f97316)',
    dark: 'radial-gradient(circle at 30% 40%, #22d3ee 0, transparent 35%), radial-gradient(circle at 75% 65%, #a855f7 0, transparent 35%), #0b1120',
  };
  return (
    <div className="space-y-3">
      <Segmented value={tab} onChange={setTab} options={[{ value: 'glass', label: 'Glassmorphism' }, { value: 'neu', label: 'Neumorphism' }]} />
      {tab === 'glass' ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <div className="space-y-3 rounded-md border border-border p-3 min-w-0">
            <Slider label="Blur" value={g.blur} onChange={blur => setG({ ...g, blur })} min={0} max={40} suffix="px" />
            <Slider label="Transparency (fill opacity)" value={Math.round(g.transparency * 100)} onChange={t => setG({ ...g, transparency: t / 100 })} min={0} max={100} suffix="%" />
            <Slider label="Saturation" value={g.saturation} onChange={saturation => setG({ ...g, saturation })} min={100} max={300} suffix="%" />
            <Slider label="Radius" value={g.radius} onChange={radius => setG({ ...g, radius })} min={0} max={48} suffix="px" />
            <ColorField label="Tint colour" value={g.color} onChange={color => setG({ ...g, color })} />
            <div className="flex flex-wrap gap-3">
              <Checkbox checked={g.border} onChange={border => setG({ ...g, border })}>Light border</Checkbox>
              <Checkbox checked={g.shadow} onChange={shadow => setG({ ...g, shadow })}>Shadow</Checkbox>
            </div>
            {g.border && <Slider label="Border opacity" value={Math.round(g.borderOpacity * 100)} onChange={b => setG({ ...g, borderOpacity: b / 100 })} min={0} max={100} suffix="%" />}
            <Field label="Backdrop"><Segmented value={bgKind} onChange={setBgKind} options={[{ value: 'gradient', label: 'Gradient' }, { value: 'photo', label: 'Photo' }, { value: 'dark', label: 'Dark' }]} /></Field>
          </div>
          <div className="space-y-3 min-w-0">
            <div className="relative grid place-items-center overflow-hidden rounded-lg p-8 min-h-80" style={{ background: bgs[bgKind] }}>
              <div className="w-full max-w-sm p-6 text-white" style={toStyle(glass)}>
                <p className="text-lg font-semibold">Glass card</p>
                <p className="mt-1 text-sm opacity-90">backdrop-filter blurs whatever is behind this element.</p>
                <div className="mt-4 h-2 w-2/3 rounded-full bg-white/50" />
              </div>
            </div>
            <CodeOut label="CSS" value={glass} className="h-40" />
            <InfoBox>backdrop-filter is supported in all evergreen browsers (Safari needs the -webkit- prefix, included). It only shows when there is something colourful behind the element.</InfoBox>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <div className="space-y-3 rounded-md border border-border p-3 min-w-0">
            <Field label="Shape"><Segmented value={n.shape} onChange={shape => setN({ ...n, shape })} options={[{ value: 'flat', label: 'Flat' }, { value: 'concave', label: 'Concave' }, { value: 'convex', label: 'Convex' }, { value: 'pressed', label: 'Pressed' }]} /></Field>
            <ColorField label="Base colour" value={n.color} onChange={color => setN({ ...n, color })} />
            <Slider label="Distance" value={n.distance} onChange={distance => setN({ ...n, distance, blur: Math.max(n.blur, distance) })} min={1} max={50} suffix="px" />
            <Slider label="Intensity" value={Math.round(n.intensity * 100)} onChange={i => setN({ ...n, intensity: i / 100 })} min={1} max={60} suffix="%" />
            <Slider label="Blur" value={n.blur} onChange={blur => setN({ ...n, blur })} min={0} max={100} suffix="px" />
            <Slider label="Radius" value={n.radius} onChange={radius => setN({ ...n, radius })} min={0} max={150} suffix="px" />
            <div className="flex flex-wrap gap-1">
              {['#e0e5ec', '#f0f0f3', '#dde1e7', '#2b2f36', '#ffd6e0', '#d6e4ff'].map(c => (
                <button key={c} type="button" title={c} onClick={() => setN({ ...n, color: c })} className="size-6 rounded-full border border-border cursor-pointer" style={{ background: c }} />
              ))}
            </div>
          </div>
          <div className="space-y-3 min-w-0">
            <div className="grid place-items-center rounded-lg p-10 min-h-80" style={{ background: n.color }}>
              <div className="grid size-48 place-items-center text-sm font-medium" style={{ ...toStyle(neu), color: L.shade(n.color, luminance(n.color) > 0.4 ? -0.55 : 0.6) }}>{n.shape}</div>
            </div>
            <CodeOut label="CSS" value={neu} className="h-32" />
            <InfoBox>Neumorphism has low contrast by nature — add clear focus states and don’t rely on the shadow alone to show interactive elements.</InfoBox>
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Cubic-bezier visualizer
// ═════════════════════════════════════════════════════════════════════════════

const BZ_W = 300; // drawing area (unit square) in SVG units
const BZ_PAD_Y = 150; // room above/below for y outside 0..1

export function CubicBezierVisualizer() {
  const [b, setB] = useState<L.Bezier>([0.68, -0.6, 0.32, 1.6]);
  const [paste, setPaste] = useState('');
  const [pasteErr, setPasteErr] = useState('');
  const [duration, setDuration] = useState(1.2);
  const [run, setRun] = useState(0);
  const [moved, setMoved] = useState(false);
  const [compare, setCompare] = useState<string>('linear');
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<0 | 1 | null>(null);

  const toSvg = (x: number, y: number) => [x * BZ_W, BZ_PAD_Y + (1 - y) * BZ_W] as const;
  const fromEvent = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    const x = Math.min(1, Math.max(0, p.x / BZ_W));
    const y = Math.min(2, Math.max(-1, 1 - (p.y - BZ_PAD_Y) / BZ_W));
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as const;
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current === null) return;
    const [x, y] = fromEvent(e);
    setB(prev => (drag.current === 0 ? [x, y, prev[2], prev[3]] : [prev[0], prev[1], x, y]));
  };
  const [p0x, p0y] = toSvg(0, 0); const [p3x, p3y] = toSvg(1, 1);
  const [c1x, c1y] = toSvg(b[0], b[1]); const [c2x, c2y] = toSvg(b[2], b[3]);
  const css = L.bezierCss(b);
  const cmp = L.BEZIER_PRESETS[compare] ?? L.BEZIER_PRESETS.linear;

  // Restart the comparison animation whenever the curve or duration changes.
  useEffect(() => { setMoved(false); const t = setTimeout(() => setMoved(true), 50); return () => clearTimeout(t); }, [run, css, duration, compare]);

  const thumb = (v: L.Bezier) => `M0,20 C${v[0] * 20},${20 - v[1] * 20} ${v[2] * 20},${20 - v[3] * 20} 20,0`;
  const setIdx = (i: number, val: number) => {
    if (!Number.isFinite(val)) return;
    const next = [...b] as L.Bezier;
    next[i] = i % 2 === 0 ? Math.min(1, Math.max(0, val)) : val;
    setB(next);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_1fr]">
      <div className="space-y-3 min-w-0">
        <div className="rounded-lg border border-border bg-card p-2">
          <svg ref={svgRef} viewBox={`-20 -10 ${BZ_W + 40} ${BZ_W + BZ_PAD_Y * 2 + 20}`} className="w-full touch-none select-none"
            onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
            <rect x={0} y={BZ_PAD_Y} width={BZ_W} height={BZ_W} className="fill-secondary/60 stroke-border" />
            {[0.25, 0.5, 0.75].map(t => (
              <g key={t} className="stroke-border" strokeDasharray="3 4">
                <line x1={t * BZ_W} y1={BZ_PAD_Y} x2={t * BZ_W} y2={BZ_PAD_Y + BZ_W} />
                <line x1={0} y1={BZ_PAD_Y + t * BZ_W} x2={BZ_W} y2={BZ_PAD_Y + t * BZ_W} />
              </g>
            ))}
            <line x1={p0x} y1={p0y} x2={p3x} y2={p3y} className="stroke-muted-foreground/40" strokeDasharray="4 4" />
            <line x1={p0x} y1={p0y} x2={c1x} y2={c1y} className="stroke-primary/70" strokeWidth={2} />
            <line x1={p3x} y1={p3y} x2={c2x} y2={c2y} className="stroke-primary/70" strokeWidth={2} />
            <path d={`M${p0x},${p0y} C${c1x},${c1y} ${c2x},${c2y} ${p3x},${p3y}`} fill="none" className="stroke-foreground" strokeWidth={3} />
            <circle cx={p0x} cy={p0y} r={5} className="fill-foreground" />
            <circle cx={p3x} cy={p3y} r={5} className="fill-foreground" />
            {[[c1x, c1y], [c2x, c2y]].map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={11} className="fill-primary stroke-card cursor-grab active:cursor-grabbing" strokeWidth={3}
                onPointerDown={e => { drag.current = i as 0 | 1; (e.target as Element).setPointerCapture?.(e.pointerId); e.preventDefault(); }} />
            ))}
            <text x={0} y={BZ_PAD_Y + BZ_W + 16} className="fill-muted-foreground text-[11px]">time →</text>
            <text x={-14} y={BZ_PAD_Y - 6} className="fill-muted-foreground text-[11px]">progress</text>
          </svg>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {(['x1', 'y1', 'x2', 'y2'] as const).map((k, i) => (
            <Field key={k} label={k}><Input type="number" step={0.01} min={i % 2 === 0 ? 0 : undefined} max={i % 2 === 0 ? 1 : undefined} className={MONO} value={b[i]} onChange={e => setIdx(i, Number(e.target.value))} /></Field>
          ))}
        </div>
      </div>
      <div className="space-y-3 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <code className={cn(MONO, 'rounded-md border border-border bg-secondary/40 px-3 py-1.5 text-sm')}>{css}</code>
          <CopyButton value={css} label="Copy" />
          <CopyButton value={`transition: all ${duration}s ${css};`} label="Copy transition" />
        </div>
        <div className="flex gap-1.5">
          <Input className={cn(MONO, 'flex-1 min-w-0')} placeholder="Paste cubic-bezier(…), 4 numbers or a keyword (ease-in-out)" value={paste}
            onChange={e => { setPaste(e.target.value); setPasteErr(''); }}
            onKeyDown={e => { if (e.key === 'Enter') { const p = L.parseBezier(paste); if (p) { setB(p); setPaste(''); } else setPasteErr('Not a valid cubic-bezier (x values must be 0–1).'); } }} />
          <Button variant="outline" onClick={() => { const p = L.parseBezier(paste); if (p) { setB(p); setPaste(''); } else setPasteErr('Not a valid cubic-bezier (x values must be 0–1).'); }}>Apply</Button>
        </div>
        {pasteErr && <p className="text-[11px] text-destructive">{pasteErr}</p>}
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => setRun(r => r + 1)}><Play /> Replay</Button>
            <div className="w-48"><Slider label="Duration" value={duration} onChange={setDuration} min={0.2} max={4} step={0.1} suffix="s" /></div>
            <Field label="Compare with" className="w-40"><Sel value={compare} onChange={setCompare} options={Object.keys(L.BEZIER_PRESETS)} /></Field>
          </div>
          {[{ label: 'Your curve', curve: css, cls: 'bg-primary' }, { label: compare, curve: L.bezierCss(cmp), cls: 'bg-muted-foreground' }].map(row => (
            <div key={row.label} className="space-y-1">
              <p className="text-[11px] text-muted-foreground">{row.label}</p>
              <div className="relative h-8 rounded-md bg-secondary/50">
                <div className={cn('absolute top-1 size-6 rounded-full', row.cls)}
                  style={{ left: moved ? 'calc(100% - 1.75rem)' : '0.25rem', transition: moved ? `left ${duration}s ${row.curve}` : 'none' }} />
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Presets</p>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 xl:grid-cols-7">
            {Object.entries(L.BEZIER_PRESETS).map(([k, v]) => (
              <button key={k} type="button" onClick={() => setB([...v] as L.Bezier)} title={L.bezierCss(v)}
                className={cn('flex flex-col items-center gap-1 rounded-md border p-1.5 cursor-pointer hover:border-primary', L.bezierCss(v) === css ? 'border-primary bg-primary/10' : 'border-border')}>
                <svg viewBox="-4 -10 28 40" className="h-8 w-8 overflow-visible"><path d={thumb(v)} fill="none" className="stroke-foreground" strokeWidth={2} /></svg>
                <span className="text-[10px] text-muted-foreground truncate max-w-full">{k}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
