import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown, Check, ChevronDown, Delete, Download, History, Loader2, Plus, RefreshCw, Search, Trash2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  MONO, CopyButton, ErrorBox, InfoBox, FieldLabel, Segmented, Checkbox, NumberField, Stat, downloadBlob, toolsApi,
} from './shared';
import * as C from './lib/calc';

// ═════════════════════════════════════════════════════════════════════════════
// Shared helpers for this file (also used by datetime.tsx)
// ═════════════════════════════════════════════════════════════════════════════

export const SELECT = 'h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-primary';

/** Fixed decimals with grouping; '—' for non-finite. */
export const fmt = (n: number, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
/** Up to `max` decimals. */
export const fmtN = (n: number, max = 4) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: max }) : '—';
const compact = (n: number) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 }) : '—';
const uid = () => Math.random().toString(36).slice(2, 10);

/** useState persisted to localStorage (silently in-memory when storage is unavailable). */
export function usePersisted<T>(key: string, initial: T | (() => T), valid?: (v: unknown) => boolean) {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      if (s != null) {
        const parsed = JSON.parse(s);
        if (!valid || valid(parsed)) return parsed as T;
      }
    } catch { /* ignore */ }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
  }, [key, v]);
  return [v, setV] as const;
}

export interface PickOption { value: string; label: string; hint?: string }

/** Searchable dropdown (button + popover with filter). */
export function SearchSelect({ value, options, onChange, placeholder = 'Select…', className, renderValue }: {
  value: string; options: PickOption[]; onChange: (v: string) => void; placeholder?: string; className?: string;
  renderValue?: (o: PickOption | undefined) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/[\s_/]+/g, ' ');
    if (!s) return options;
    const norm = (x: string) => x.toLowerCase().replace(/[\s_/]+/g, ' ');
    const starts: PickOption[] = [];
    const contains: PickOption[] = [];
    for (const o of options) {
      const a = norm(o.value);
      const b = norm(o.label + ' ' + (o.hint ?? ''));
      if (a.startsWith(s) || norm(o.label).startsWith(s)) starts.push(o);
      else if (a.includes(s) || b.includes(s)) contains.push(o);
    }
    return [...starts, ...contains];
  }, [q, options]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => { setHi(0); }, [q, open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const pick = (v: string) => { onChange(v); setOpen(false); setQ(''); };

  return (
    <div ref={root} className={cn('relative min-w-0', className)}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="h-8 w-full flex items-center gap-1.5 rounded-md border border-input bg-transparent px-2 text-xs text-left outline-none focus:border-primary cursor-pointer"
      >
        <span className="flex-1 min-w-0 truncate">{renderValue ? renderValue(selected) : selected ? selected.label : <span className="text-muted-foreground">{placeholder}</span>}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-30 left-0 mt-1 w-full min-w-[15rem] max-w-[calc(100vw-2rem)] rounded-md border border-border bg-card shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border px-2">
            <Search className="size-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search…"
              className="h-8 w-full bg-transparent text-xs outline-none"
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(filtered.length - 1, h + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
                else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) pick(filtered[hi].value); }
                else if (e.key === 'Escape') { setOpen(false); }
              }}
            />
          </div>
          <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No matches</p>}
            {filtered.slice(0, 400).map((o, i) => (
              <button
                key={o.value}
                type="button"
                data-i={i}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o.value)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left cursor-pointer',
                  i === hi ? 'bg-secondary' : '',
                )}
              >
                <span className="flex-1 min-w-0 truncate">{o.label}</span>
                {o.hint && <span className="text-[11px] text-muted-foreground shrink-0">{o.hint}</span>}
                {o.value === value && <Check className="size-3.5 text-primary shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, description, children, action, className }: {
  title: string; description?: string; children: React.ReactNode; action?: React.ReactNode; className?: string;
}) {
  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
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

function toCsv(header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map(r => r.map(esc).join(',')).join('\n') + '\n';
}

function DataTable({ head, rows, className, highlight }: {
  head: React.ReactNode[]; rows: React.ReactNode[][]; className?: string; highlight?: (i: number) => boolean;
}) {
  return (
    <div className={cn('overflow-auto rounded-md border border-border', className)}>
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 bg-secondary text-muted-foreground">
          <tr>{head.map((h, i) => <th key={i} className={cn('px-2.5 py-1.5 font-medium whitespace-nowrap', i ? 'text-right' : 'text-left')}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn('border-t border-border', highlight?.(i) && 'bg-primary/5 font-medium')}>
              {r.map((c, j) => <td key={j} className={cn('px-2.5 py-1 whitespace-nowrap', j ? 'text-right' : 'text-left')}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Small text input that keeps its own string state but reports numbers. */
function NumInput({ value, onChange, className, step, min, placeholder }: {
  value: number; onChange: (v: number) => void; className?: string; step?: number; min?: number; placeholder?: string;
}) {
  return (
    <Input type="number" inputMode="decimal" className={cn('h-7 text-xs', className)} step={step} min={min} placeholder={placeholder}
      value={Number.isFinite(value) ? value : ''} onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Basic calculator
// ═════════════════════════════════════════════════════════════════════════════

const BINARY_OPS = ['+', '−', '×', '÷', '^'];

export function BasicCalculator() {
  const [expr, setExpr] = useState('12 × (3 + 4.5) − 18%');
  const [history, setHistory] = usePersisted<{ expr: string; result: string }[]>('devtools.calc.history', [], Array.isArray);
  const [memory, setMemory] = useState(0);
  const [deg, setDeg] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const preview = useMemo(() => {
    if (!expr.trim()) return { v: NaN, e: '' };
    try { return { v: C.evaluate(expr, { degrees: deg }), e: '' }; } catch (e) { return { v: NaN, e: (e as Error).message }; }
  }, [expr, deg]);

  const equals = useCallback(() => {
    if (!expr.trim()) return;
    try {
      const v = C.evaluate(expr, { degrees: deg });
      const s = String(v);
      setHistory(h => [{ expr, result: s }, ...h.filter(x => x.expr !== expr)].slice(0, 50));
      setExpr(s);
      setFresh(true);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [expr, deg, setHistory]);

  const press = useCallback((k: string) => {
    setError('');
    if (k === '=') { equals(); return; }
    if (k === 'AC') { setExpr(''); setFresh(false); return; }
    if (k === '⌫') { setExpr(e => (fresh ? '' : e.replace(/\s+$/, '').slice(0, -1).replace(/\s+$/, ''))); setFresh(false); return; }
    if (k === '±') {
      setExpr(e => {
        const m = /\(−(\d*\.?\d+(?:e[+-]?\d+)?)\)$/.exec(e);
        if (m) return e.slice(0, m.index) + m[1];
        const n = /(-?)(\d*\.?\d+(?:e[+-]?\d+)?)$/.exec(e);
        if (!n) return e ? `−(${e})` : '−';
        if (n.index === 0) return n[1] ? n[2] : '-' + n[2];
        return e.slice(0, n.index) + `(−${n[2]})`;
      });
      setFresh(false);
      return;
    }
    const isDigit = /^[0-9.]$/.test(k) || k === 'π';
    setExpr(e => {
      let base = fresh && (isDigit || k === '(' || k === '√(') ? '' : e;
      if (k === '.') {
        const last = /(\d*\.?\d*)$/.exec(base)?.[1] ?? '';
        if (last.includes('.')) return base;
        if (!last) base += '0';
      }
      const t = base.replace(/\s+$/, '');
      if (BINARY_OPS.includes(k)) {
        if (!t && k !== '−') return base;
        const lastCh = t.slice(-1);
        if (BINARY_OPS.includes(lastCh) && !(k === '−' && lastCh !== '−')) return `${t.slice(0, -1).trimEnd()} ${k} `;
        return `${t} ${k} `;
      }
      return base + k;
    });
    setFresh(false);
  }, [equals, fresh]);

  // Keyboard support when focus isn't in another field (the display itself handles typing natively).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== inputRef.current && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (el === inputRef.current) return;
      const map: Record<string, string> = { '*': '×', x: '×', '/': '÷', '-': '−', Enter: '=', '=': '=', Backspace: '⌫', Escape: 'AC', Delete: 'AC', p: 'π' };
      const k = map[e.key] ?? (/^[0-9.+^%()]$/.test(e.key) ? e.key : null);
      if (!k) return;
      e.preventDefault();
      press(k);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  const memVal = Number.isFinite(preview.v) ? preview.v : 0;
  const recall = () => {
    const m = memory < 0 ? `(−${-memory})` : String(memory);
    setExpr(e => {
      if (fresh || !e.trim()) return m;
      // Insert after an operator / "(" — otherwise multiply implicitly.
      return /[+−×÷^(\s]$/.test(e) ? e + m : `${e} × ${m}`;
    });
    setFresh(false);
    setError('');
  };
  const pad: { k: string; label?: React.ReactNode; kind?: 'op' | 'eq' | 'fn' }[] = [
    { k: 'AC', kind: 'fn' }, { k: '⌫', label: <Delete className="size-4" />, kind: 'fn' }, { k: '%', kind: 'fn' }, { k: '÷', kind: 'op' },
    { k: '7' }, { k: '8' }, { k: '9' }, { k: '×', kind: 'op' },
    { k: '4' }, { k: '5' }, { k: '6' }, { k: '−', kind: 'op' },
    { k: '1' }, { k: '2' }, { k: '3' }, { k: '+', kind: 'op' },
    { k: '±', kind: 'fn' }, { k: '0' }, { k: '.' }, { k: '=', kind: 'eq' },
  ];
  const sci: { k: string; label: string; title: string }[] = [
    { k: '(', label: '(', title: 'Open parenthesis' }, { k: ')', label: ')', title: 'Close parenthesis' },
    { k: '√(', label: '√', title: 'Square root' }, { k: '^2', label: 'x²', title: 'Square' },
    { k: '^', label: 'xʸ', title: 'Power' }, { k: 'π', label: 'π', title: 'Pi' },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <div className="space-y-3 w-full max-w-md">
        <div className="rounded-lg border border-border bg-secondary/40 p-3 space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground min-h-4">
            <span>{memory !== 0 ? `M = ${C.formatCalc(memory)}` : ' '}</span>
            <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => setDeg(d => !d)} title="Angle unit for sin/cos/tan">
              {deg ? 'DEG' : 'RAD'}
            </button>
          </div>
          <input
            ref={inputRef}
            value={expr}
            onChange={e => { setExpr(e.target.value); setFresh(false); setError(''); }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); equals(); }
              else if (e.key === 'Escape') { e.preventDefault(); setExpr(''); }
            }}
            spellCheck={false}
            aria-label="Expression"
            placeholder="0"
            className="w-full bg-transparent text-right text-lg font-mono outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-end gap-1 min-h-8">
            {error
              ? <span className="text-xs text-destructive text-right">{error}</span>
              : <span className={cn('text-2xl font-semibold tabular-nums text-right break-all', fresh ? 'text-foreground' : 'text-muted-foreground')}>
                  {Number.isFinite(preview.v) ? `${fresh ? '' : '= '}${C.formatCalc(preview.v)}` : ' '}
                </span>}
            {Number.isFinite(preview.v) && <CopyButton value={String(preview.v)} />}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {[
            { k: 'MC', f: () => setMemory(0), t: 'Clear memory' },
            { k: 'MR', f: () => recall(), t: 'Recall memory' },
            { k: 'M+', f: () => setMemory(m => C.clean(m + memVal)), t: 'Add current value to memory' },
            { k: 'M−', f: () => setMemory(m => C.clean(m - memVal)), t: 'Subtract current value from memory' },
          ].map(b => (
            <Button key={b.k} variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" title={b.t} onClick={b.f}>{b.k}</Button>
          ))}
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {sci.map(b => (
            <Button key={b.k} variant="secondary" size="sm" className="h-8" title={b.title} onClick={() => press(b.k)}>{b.label}</Button>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {pad.map(b => (
            <Button
              key={b.k}
              variant={b.kind === 'eq' ? 'default' : b.kind ? 'secondary' : 'outline'}
              className={cn('h-12 text-base', b.kind === 'op' && 'text-primary text-lg')}
              onClick={() => press(b.k)}
            >
              {b.label ?? b.k}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Type directly or use the keyboard (Enter = equals, Esc = clear). Also understands <code>sin cos tan log ln sqrt abs mod !</code>, <code>pi</code>, <code>e</code>; <code>200 + 10%</code> = 220.
        </p>
      </div>

      <div className="space-y-1.5 min-w-0">
        <FieldLabel action={history.length > 0 && <Button variant="ghost" size="xs" onClick={() => setHistory([])}><Trash2 /> Clear</Button>}>
          <span className="inline-flex items-center gap-1.5"><History className="size-3.5" /> History</span>
        </FieldLabel>
        {history.length === 0
          ? <InfoBox>Calculations you finish with <b>=</b> appear here. Click one to reuse it.</InfoBox>
          : (
            <div className="rounded-md border border-border divide-y divide-border max-h-[28rem] overflow-y-auto">
              {history.map((h, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/50">
                  <button type="button" className="flex-1 min-w-0 text-left cursor-pointer" onClick={() => { setExpr(h.expr); setFresh(false); setError(''); }}>
                    <p className={cn(MONO, 'text-muted-foreground truncate')}>{h.expr}</p>
                    <p className="text-sm font-semibold tabular-nums break-all">= {C.formatCalc(Number(h.result))}</p>
                  </button>
                  <CopyButton value={h.result} />
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Percentage
// ═════════════════════════════════════════════════════════════════════════════

function Answer({ value, suffix = '', note }: { value: number; suffix?: string; note?: React.ReactNode }) {
  const s = Number.isFinite(value) ? `${fmtN(C.clean(value), 6)}${suffix}` : '';
  return (
    <div className="flex items-center gap-2 rounded-md bg-secondary/50 border border-border px-3 py-2 min-h-11">
      <div className="flex-1 min-w-0">
        <p className="text-lg font-semibold tabular-nums break-all">{s || <span className="text-muted-foreground text-sm">Enter values</span>}</p>
        {note && s && <p className="text-[11px] text-muted-foreground">{note}</p>}
      </div>
      <CopyButton value={Number.isFinite(value) ? String(C.clean(value)) : ''} />
    </div>
  );
}

function Inline({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground [&_input]:w-28">{children}</div>;
}

export function PercentageCalculator() {
  const [a1, setA1] = useState(15); const [b1, setB1] = useState(250);
  const [a2, setA2] = useState(45); const [b2, setB2] = useState(180);
  const [a3, setA3] = useState(80); const [b3, setB3] = useState(100);
  const [a4, setA4] = useState(20); const [b4, setB4] = useState(150); const [inc4, setInc4] = useState<'add' | 'sub'>('add');
  const [a5, setA5] = useState(120); const [b5, setB5] = useState(25);
  const [a6, setA6] = useState(80); const [b6, setB6] = useState(100);

  const change = C.percentChange(a3, b3);
  const r4 = b4 * (1 + (inc4 === 'add' ? 1 : -1) * a4 / 100);
  // X is P% of what?  →  X / (P/100)
  const r5 = b5 === 0 ? NaN : a5 / (b5 / 100);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Section title="What is X% of Y?">
        <Inline>What is <NumInput value={a1} onChange={setA1} /> % of <NumInput value={b1} onChange={setB1} /></Inline>
        <Answer value={C.percentOf(a1, b1)} />
      </Section>
      <Section title="X is what percent of Y?">
        <Inline><NumInput value={a2} onChange={setA2} /> is what % of <NumInput value={b2} onChange={setB2} /></Inline>
        <Answer value={C.whatPercent(a2, b2)} suffix="%" />
      </Section>
      <Section title="Percentage change">
        <Inline>From <NumInput value={a3} onChange={setA3} /> to <NumInput value={b3} onChange={setB3} /></Inline>
        <Answer value={change} suffix="%" note={Number.isFinite(change) ? `${change >= 0 ? 'Increase' : 'Decrease'} of ${fmtN(Math.abs(b3 - a3), 6)}` : undefined} />
      </Section>
      <Section title="Add or subtract a percentage">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground [&_input]:w-28">
          <NumInput value={b4} onChange={setB4} />
          <Segmented value={inc4} onChange={setInc4} options={[{ value: 'add', label: '+' }, { value: 'sub', label: '−' }]} />
          <NumInput value={a4} onChange={setA4} /> %
        </div>
        <Answer value={r4} note={`${inc4 === 'add' ? '+' : '−'}${fmtN(Math.abs(r4 - b4), 6)}`} />
      </Section>
      <Section title="X is P% of what?" description="Find the whole from a part.">
        <Inline><NumInput value={a5} onChange={setA5} /> is <NumInput value={b5} onChange={setB5} /> % of</Inline>
        <Answer value={r5} />
      </Section>
      <Section title="Percentage difference" description="|A − B| relative to their average.">
        <Inline>Between <NumInput value={a6} onChange={setA6} /> and <NumInput value={b6} onChange={setB6} /></Inline>
        <Answer value={C.percentDifference(a6, b6)} suffix="%" />
      </Section>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Discount
// ═════════════════════════════════════════════════════════════════════════════

export function DiscountCalculator() {
  const [price, setPrice] = useState(129.99);
  const [qty, setQty] = useState(1);
  const [steps, setSteps] = useState<(C.DiscountStep & { id: string })[]>([
    { id: uid(), kind: 'percent', value: 25 },
    { id: uid(), kind: 'percent', value: 10 },
  ]);
  const [tax, setTax] = useState(8.25);
  const [sale, setSale] = useState(79.99);
  const [salePct, setSalePct] = useState(20);

  const unit = C.applyDiscounts(price, steps, tax);
  const q = Math.max(1, Math.floor(C.num(qty, 1)));
  const naive = steps.filter(s => s.kind === 'percent').reduce((s, x) => s + C.num(x.value), 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Section title="Price & discounts" description="Discounts stack in order — each applies to the already-reduced price.">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <NumberField label="Original price" value={price} onChange={setPrice} min={0} step={0.01} />
          <NumberField label="Quantity" value={qty} onChange={setQty} min={1} step={1} />
          <NumberField label="Sales tax" value={tax} onChange={setTax} min={0} step={0.25} suffix="%" />
        </div>
        <div className="space-y-1.5">
          <FieldLabel action={
            <Button variant="ghost" size="xs" onClick={() => setSteps(s => [...s, { id: uid(), kind: 'percent', value: 5 }])}><Plus /> Add discount</Button>
          }>Discounts</FieldLabel>
          {steps.length === 0 && <p className="text-xs text-muted-foreground">No discounts — add one.</p>}
          {steps.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className="w-5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
              <NumInput value={s.value} min={0} onChange={v => setSteps(st => st.map(x => x.id === s.id ? { ...x, value: v } : x))} className="w-24" />
              <Segmented value={s.kind} onChange={k => setSteps(st => st.map(x => x.id === s.id ? { ...x, kind: k } : x))}
                options={[{ value: 'percent', label: '% off' }, { value: 'fixed', label: 'amount off' }]} />
              <span className="ml-auto text-xs text-muted-foreground tabular-nums hidden sm:inline">−{fmt(unit.steps[i]?.amount ?? 0)}</span>
              <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => setSteps(st => st.filter(x => x.id !== s.id))}><X /></Button>
            </div>
          ))}
        </div>
        {steps.filter(s => s.kind === 'percent').length > 1 && (
          <InfoBox>Stacked {steps.filter(s => s.kind === 'percent').map(s => `${s.value}%`).join(' + ')} is <b>{fmtN(unit.effectivePct, 2)}%</b> off in total, not {fmtN(naive, 2)}%.</InfoBox>
        )}
      </Section>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat label={q > 1 ? `Final price (×${q})` : 'Final price'} value={fmt(unit.total * q)} hint={tax ? `incl. ${fmt(unit.tax * q)} tax` : undefined} />
          <Stat label="You save" value={fmt(unit.discount * q)} hint={`${fmtN(unit.effectivePct, 2)}% off`} />
          <Stat label="Price after discounts" value={fmt(unit.subtotal * q)} hint="before tax" />
          <Stat label="Original total" value={fmt(C.num(price) * q * (1 + C.num(tax) / 100))} hint={tax ? 'incl. tax' : undefined} />
        </div>
        <DataTable
          head={['Step', 'Discount', 'Price after']}
          rows={[
            ['Original', '', fmt(C.num(price))],
            ...unit.steps.map(s => [s.label, `−${fmt(s.amount)}`, fmt(s.after)]),
            ...(tax ? [[`Tax ${tax}%`, `+${fmt(unit.tax)}`, fmt(unit.total)]] : []),
          ]}
        />
        <Section title="Reverse: original price" description="Know the sale price and the discount? Find what it cost before.">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Sale price" value={sale} onChange={setSale} min={0} step={0.01} />
            <NumberField label="Discount" value={salePct} onChange={setSalePct} min={0} max={99.99} suffix="%" />
          </div>
          <Answer value={salePct < 100 ? sale / (1 - salePct / 100) : NaN} note={`Saved ${fmt(sale / (1 - salePct / 100) - sale)}`} />
        </Section>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Tip
// ═════════════════════════════════════════════════════════════════════════════

export function TipCalculator() {
  const [bill, setBill] = useState(86.4);
  const [pct, setPct] = useState(18);
  const [people, setPeople] = useState(3);
  const [rounding, setRounding] = useState<C.TipRounding>('none');
  const [preTax, setPreTax] = useState(false);
  const [taxAmt, setTaxAmt] = useState(6.9);

  const tipBase = preTax ? Math.max(0, bill - C.num(taxAmt)) : bill;
  const raw = C.computeTip(tipBase, pct, people, 'none');
  // Rounding acts on the full bill (the tip base may exclude tax).
  const r = useMemo(() => {
    const b = C.num(bill);
    const n = Math.max(1, Math.floor(C.num(people, 1)));
    let tip = raw.tip;
    let total = b + tip;
    if (rounding === 'tip') { tip = Math.ceil(tip - 1e-9); total = b + tip; }
    if (rounding === 'total') { total = Math.ceil(total - 1e-9); tip = total - b; }
    let per = total / n;
    if (rounding === 'person') { per = Math.ceil(per - 1e-9); total = per * n; tip = total - b; }
    return { tip, total, per, tipPer: tip / n, eff: tipBase ? (tip / tipBase) * 100 : 0 };
  }, [bill, people, raw.tip, rounding, tipBase]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Bill">
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Bill amount" value={bill} onChange={setBill} min={0} step={0.01} />
          <div className="space-y-1.5">
            <FieldLabel>People</FieldLabel>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="icon-sm" onClick={() => setPeople(p => Math.max(1, (p || 1) - 1))}>−</Button>
              <Input type="number" className="text-center" min={1} value={Number.isFinite(people) ? people : ''} onChange={e => setPeople(e.target.value === '' ? NaN : Math.max(1, Math.floor(Number(e.target.value))))} />
              <Button variant="outline" size="icon-sm" onClick={() => setPeople(p => (p || 1) + 1)}>+</Button>
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Tip</FieldLabel>
          <div className="flex flex-wrap items-center gap-1.5">
            {[10, 12, 15, 18, 20, 25].map(p => (
              <Button key={p} size="sm" variant={pct === p ? 'default' : 'outline'} onClick={() => setPct(p)}>{p}%</Button>
            ))}
            <div className="flex items-center gap-1 w-28">
              <NumInput value={pct} onChange={setPct} min={0} step={0.5} className="h-8" /><span className="text-xs text-muted-foreground">%</span>
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Round up</FieldLabel>
          <Segmented value={rounding} onChange={setRounding} options={[
            { value: 'none', label: 'No rounding' }, { value: 'tip', label: 'Tip' }, { value: 'total', label: 'Total' }, { value: 'person', label: 'Per person' },
          ]} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Checkbox checked={preTax} onChange={setPreTax}>Tip on pre-tax amount</Checkbox>
          {preTax && <div className="flex items-center gap-1.5 text-xs text-muted-foreground">Tax included in bill <NumInput value={taxAmt} onChange={setTaxAmt} className="w-24" /></div>}
        </div>
      </Section>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Each person pays" value={fmt(r.per)} hint={people > 1 ? `incl. ${fmt(r.tipPer)} tip` : undefined} />
          <Stat label="Total" value={fmt(r.total)} />
          <Stat label="Tip" value={fmt(r.tip)} hint={`${fmtN(r.eff, 2)}% effective`} />
          <Stat label="Bill per person" value={fmt(C.num(bill) / Math.max(1, people || 1))} />
        </div>
        <DataTable
          head={['Tip %', 'Tip', 'Total', 'Per person']}
          highlight={i => [10, 15, 18, 20, 25][i] === pct}
          rows={[10, 15, 18, 20, 25].map(p => {
            const t = C.computeTip(tipBase, p, people, 'none');
            return [`${p}%`, fmt(t.tip), fmt(C.num(bill) + t.tip), fmt((C.num(bill) + t.tip) / Math.max(1, people || 1))];
          })}
        />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Loan
// ═════════════════════════════════════════════════════════════════════════════

const monthLabel = (startYm: string, offset: number) => {
  const m = /^(\d{4})-(\d{2})$/.exec(startYm);
  if (!m) return `#${offset + 1}`;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + offset, 1);
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};

export function LoanCalculator() {
  const now = new Date();
  const [amount, setAmount] = useState(250_000);
  const [rate, setRate] = useState(6.5);
  const [term, setTerm] = useState(30);
  const [unit, setUnit] = useState<'years' | 'months'>('years');
  const [extra, setExtra] = useState(0);
  const [start, setStart] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [view, setView] = useState<'yearly' | 'monthly'>('yearly');

  const months = unit === 'years' ? Math.round(C.num(term) * 12) : Math.round(C.num(term));
  const invalid = !(amount > 0) ? 'Enter a loan amount.' : !(months >= 1) ? 'Enter a term of at least 1 month.' : months > 1200 ? 'Term is limited to 100 years.' : rate < 0 ? 'Rate cannot be negative.' : '';
  const r = useMemo(() => (invalid ? null : C.amortize(amount, rate, months, extra)), [amount, rate, months, extra, invalid]);
  const yearly = useMemo(() => (r ? C.yearlyAmortization(r.rows) : []), [r]);

  const csv = () => {
    if (!r) return;
    const rows = view === 'monthly'
      ? r.rows.map(x => [x.period, monthLabel(start, x.period - 1), x.payment.toFixed(2), x.principal.toFixed(2), x.interest.toFixed(2), x.extra.toFixed(2), x.balance.toFixed(2)])
      : yearly.map(x => [x.period, '', x.payment.toFixed(2), x.principal.toFixed(2), x.interest.toFixed(2), x.extra.toFixed(2), x.balance.toFixed(2)]);
    downloadBlob(toCsv([view === 'monthly' ? 'Month' : 'Year', 'Date', 'Payment', 'Principal', 'Interest', 'Extra', 'Balance'], rows), `amortization-${view}.csv`, 'text/csv');
  };

  const principalShare = r ? C.num(amount) / r.totalPaid : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Section title="Loan details">
          <NumberField label="Loan amount" value={amount} onChange={setAmount} min={0} step={1000} />
          <NumberField label="Interest rate (annual)" value={rate} onChange={setRate} min={0} step={0.05} suffix="%" />
          <div className="space-y-1.5">
            <FieldLabel action={<Segmented value={unit} onChange={u => { setUnit(u); setTerm(t => u === 'months' ? Math.round(t * 12) : +(t / 12).toFixed(2)); }} options={[{ value: 'years', label: 'Years' }, { value: 'months', label: 'Months' }]} />}>Term</FieldLabel>
            <Input type="number" min={1} value={Number.isFinite(term) ? term : ''} onChange={e => setTerm(e.target.value === '' ? NaN : Number(e.target.value))} />
          </div>
          <NumberField label="Extra payment per month" value={extra} onChange={setExtra} min={0} step={50} />
          <div className="space-y-1.5">
            <FieldLabel>First payment</FieldLabel>
            <Input type="month" value={start} onChange={e => setStart(e.target.value)} />
          </div>
        </Section>
        <div className="space-y-3 min-w-0">
          {invalid && <ErrorBox message={invalid} />}
          {r && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Stat label="Monthly payment" value={fmt(r.payment + (extra || 0))} hint={extra ? `${fmt(r.payment)} + ${fmt(extra)} extra` : undefined} />
                <Stat label="Total interest" value={fmt(r.totalInterest)} />
                <Stat label="Total paid" value={fmt(r.totalPaid)} />
                <Stat label="Payoff" value={monthLabel(start, r.months - 1)} hint={`${Math.floor(r.months / 12)}y ${r.months % 12}m · ${r.months} payments`} />
                {extra > 0 && <Stat label="Interest saved" value={fmt(r.interestSaved)} hint={`${Math.floor(r.monthsSaved / 12)}y ${r.monthsSaved % 12}m sooner`} />}
              </div>
              <div className="space-y-1">
                <div className="flex h-3 rounded-full overflow-hidden bg-secondary">
                  <div className="bg-primary" style={{ width: `${principalShare * 100}%` }} title="Principal" />
                  <div className="bg-amber-500" style={{ width: `${(1 - principalShare) * 100}%` }} title="Interest" />
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-primary" /> Principal {fmtN(principalShare * 100, 1)}%</span>
                  <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-amber-500" /> Interest {fmtN((1 - principalShare) * 100, 1)}%</span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {r && (
        <Section
          title="Amortization schedule"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Segmented value={view} onChange={setView} options={[{ value: 'yearly', label: 'Yearly' }, { value: 'monthly', label: 'Monthly' }]} />
              <Button variant="outline" size="sm" onClick={csv}><Download /> CSV</Button>
            </div>
          }
        >
          <DataTable
            className="max-h-96"
            head={[view === 'monthly' ? 'Month' : 'Year', 'Payment', 'Principal', 'Interest', ...(extra > 0 ? ['Extra'] : []), 'Balance']}
            rows={(view === 'monthly' ? r.rows : yearly).map(x => [
              view === 'monthly' ? `${x.period} · ${monthLabel(start, x.period - 1)}` : `Year ${x.period}`,
              fmt(x.payment + x.extra), fmt(x.principal), fmt(x.interest), ...(extra > 0 ? [fmt(x.extra)] : []), fmt(x.balance),
            ])}
          />
        </Section>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Compound interest
// ═════════════════════════════════════════════════════════════════════════════

function niceCeil(v: number) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function GrowthChart({ rows }: { rows: C.GrowthRow[] }) {
  if (!rows.length) return null;
  const W = 640, H = 220, L = 48, R = 6, T = 10, B = 22;
  const max = niceCeil(Math.max(...rows.map(r => Math.max(r.balance, r.deposits))));
  const bw = (W - L - R) / rows.length;
  const gap = Math.min(6, bw * 0.25);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const every = Math.ceil(rows.length / 12);
  return (
    <div className="space-y-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Balance by year">
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="currentColor" strokeOpacity={0.12} />
            <text x={L - 6} y={y(max * f) + 3} textAnchor="end" fontSize={10} fill="currentColor" fillOpacity={0.6}>{compact(max * f)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = L + i * bw + gap / 2;
          const dep = Math.max(0, r.deposits);
          const intr = Math.max(0, r.interest);
          return (
            <g key={r.year}>
              <title>{`Year ${r.year}\nDeposits: ${fmt(r.deposits)}\nInterest: ${fmt(r.interest)}\nBalance: ${fmt(r.balance)}`}</title>
              <rect x={x} width={Math.max(1, bw - gap)} y={y(dep)} height={Math.max(0, y(0) - y(dep))} fill="#94a3b8" rx={1} />
              <rect x={x} width={Math.max(1, bw - gap)} y={y(dep + intr)} height={Math.max(0, y(dep) - y(dep + intr))} fill="var(--primary)" rx={1} />
              {(i % every === 0 || i === rows.length - 1) && (
                <text x={x + (bw - gap) / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="currentColor" fillOpacity={0.6}>{r.year}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: '#94a3b8' }} /> Principal + contributions</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-primary" /> Interest earned</span>
      </div>
    </div>
  );
}

export function CompoundInterestCalculator() {
  const [principal, setPrincipal] = useState(10_000);
  const [rate, setRate] = useState(7);
  const [freq, setFreq] = useState('12');
  const [years, setYears] = useState(20);
  const [monthly, setMonthly] = useState(300);
  const [atStart, setAtStart] = useState(false);
  const [inflation, setInflation] = useState(0);

  const invalid = !(years >= 1) ? 'Enter at least 1 year.' : years > 100 ? 'Up to 100 years.' : '';
  const g = useMemo(() => C.compoundGrowth(principal, rate, Number(freq), years, monthly, atStart), [principal, rate, freq, years, monthly, atStart]);
  const real = inflation > 0 ? g.final / Math.pow(1 + inflation / 100, years) : NaN;

  const csv = () => downloadBlob(
    toCsv(['Year', 'Total deposits', 'Interest this year', 'Total interest', 'Balance'], g.rows.map(r => [r.year, r.deposits.toFixed(2), r.yearInterest.toFixed(2), r.interest.toFixed(2), r.balance.toFixed(2)])),
    'compound-interest.csv', 'text/csv');

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Section title="Investment">
          <NumberField label="Initial amount" value={principal} onChange={setPrincipal} min={0} step={500} />
          <NumberField label="Monthly contribution" value={monthly} onChange={setMonthly} step={50} />
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Annual rate" value={rate} onChange={setRate} step={0.1} suffix="%" />
            <NumberField label="Years" value={years} onChange={setYears} min={1} max={100} />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>Compounding</FieldLabel>
            <select className={SELECT} value={freq} onChange={e => setFreq(e.target.value)}>
              <option value="1">Annually</option><option value="2">Semi-annually</option><option value="4">Quarterly</option>
              <option value="12">Monthly</option><option value="52">Weekly</option><option value="365">Daily</option>
            </select>
          </div>
          <Checkbox checked={atStart} onChange={setAtStart}>Contribute at the start of each month</Checkbox>
          <NumberField label="Inflation (optional)" value={inflation} onChange={setInflation} min={0} step={0.1} suffix="%" />
        </Section>
        <div className="space-y-3 min-w-0">
          {invalid ? <ErrorBox message={invalid} /> : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Stat label="Future value" value={fmt(g.final)} />
                <Stat label="Total contributed" value={fmt(g.totalDeposits)} />
                <Stat label="Interest earned" value={fmt(g.totalInterest)} hint={g.totalDeposits ? `${fmtN((g.totalInterest / g.totalDeposits) * 100, 1)}% of deposits` : undefined} />
                <Stat label={Number.isFinite(real) ? "In today's money" : 'Effective annual rate'} value={Number.isFinite(real) ? fmt(real) : `${fmtN(g.effectiveAnnualRate, 3)}%`} hint={Number.isFinite(real) ? `APY ${fmtN(g.effectiveAnnualRate, 3)}%` : undefined} />
              </div>
              <Card size="sm"><CardContent><GrowthChart rows={g.rows} /></CardContent></Card>
            </>
          )}
        </div>
      </div>
      {!invalid && (
        <Section title="Year by year" action={<Button variant="outline" size="sm" onClick={csv}><Download /> CSV</Button>}>
          <DataTable
            className="max-h-96"
            head={['Year', 'Deposits', 'Interest (year)', 'Total interest', 'Balance']}
            rows={g.rows.map(r => [r.year, fmt(r.deposits), fmt(r.yearInterest), fmt(r.interest), fmt(r.balance)])}
          />
        </Section>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Salary
// ═════════════════════════════════════════════════════════════════════════════

export function SalaryCalculator() {
  const [amount, setAmount] = useState(85_000);
  const [period, setPeriod] = useState<C.PayPeriod>('annual');
  const [hours, setHours] = useState(40);
  const [days, setDays] = useState(5);
  const [weeks, setWeeks] = useState(52);
  const [taxPct, setTaxPct] = useState(22);
  const [deductions, setDeductions] = useState(3000);
  const [preTax, setPreTax] = useState(true);

  const invalid = !(hours > 0 && hours <= 168) ? 'Hours per week must be between 0 and 168.'
    : !(weeks > 0 && weeks <= 52.18) ? 'Weeks per year must be between 1 and 52.'
    : !(days > 0 && days <= 7) ? 'Days per week must be between 1 and 7.' : '';
  const gross = C.convertSalary(amount, period, hours, weeks, days);
  const G = gross.annual;
  const D = Math.max(0, C.num(deductions));
  const taxable = Math.max(0, preTax ? G - D : G);
  const tax = taxable * Math.max(0, C.num(taxPct)) / 100;
  const net = G - tax - D;
  const ratio = G ? net / G : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Section title="Pay">
        <div className="grid grid-cols-[1fr_8rem] gap-2 items-end">
          <NumberField label="Amount" value={amount} onChange={setAmount} min={0} step={100} />
          <select className={SELECT} value={period} onChange={e => setPeriod(e.target.value as C.PayPeriod)}>
            {C.PAY_PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <NumberField label="Hours / week" value={hours} onChange={setHours} min={1} max={168} />
          <NumberField label="Days / week" value={days} onChange={setDays} min={1} max={7} />
          <NumberField label="Weeks / year" value={weeks} onChange={setWeeks} min={1} max={52} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Flat tax rate" value={taxPct} onChange={setTaxPct} min={0} max={100} step={0.5} suffix="%" />
          <NumberField label="Deductions / year" value={deductions} onChange={setDeductions} min={0} step={100} />
        </div>
        <Checkbox checked={preTax} onChange={setPreTax}>Deductions are pre-tax (401k, pension…)</Checkbox>
        <p className="text-[11px] text-muted-foreground">A flat rate is an estimate — real income tax is usually progressive. Use your effective rate for a closer number.</p>
      </Section>
      <div className="space-y-3 min-w-0">
        {invalid ? <ErrorBox message={invalid} /> : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Gross / year" value={fmt(G)} />
              <Stat label="Net / year" value={fmt(net)} />
              <Stat label="Take-home / month" value={fmt(net / 12)} />
              <Stat label="Effective tax" value={`${fmtN(G ? (tax / G) * 100 : 0, 1)}%`} hint={`${fmt(tax)} tax`} />
            </div>
            <DataTable
              head={['Period', 'Gross', 'Tax', 'Deductions', 'Net']}
              highlight={i => C.PAY_PERIODS[i].id === period}
              rows={C.PAY_PERIODS.map(p => {
                const n = G ? gross[p.id] / G : 0;
                return [p.label, fmt(gross[p.id]), fmt(tax * n), fmt(D * n), fmt(gross[p.id] * ratio)];
              })}
            />
            <p className="text-[11px] text-muted-foreground">
              Based on {fmtN(hours * weeks, 1)} working hours and {fmtN(days * weeks, 1)} working days per year.
              Bi-weekly = 26 and semi-monthly = 24 pay periods.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Currency
// ═════════════════════════════════════════════════════════════════════════════

interface RatesResponse { base: string; rates: Record<string, number>; updatedAt: string; source: string; cached?: boolean; stale?: boolean; names?: Record<string, string> }

const currencyName = (() => {
  let dn: Intl.DisplayNames | null = null;
  return (code: string, names?: Record<string, string>) => {
    if (names?.[code]) return names[code];
    try { dn ??= new Intl.DisplayNames(undefined, { type: 'currency' }); return dn.of(code) ?? code; } catch { return code; }
  };
})();

function formatMoney(v: number, code: string) {
  if (!Number.isFinite(v)) return '—';
  const digits = Math.abs(v) < 1 && v !== 0 ? 6 : undefined;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol', maximumFractionDigits: digits }).format(v);
  } catch {
    return `${fmt(v)} ${code}`;
  }
}

const POPULAR = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'PKR', 'AED', 'SAR', 'CAD', 'AUD', 'CHF', 'SGD', 'HKD', 'TRY', 'BRL', 'MXN', 'ZAR', 'KRW', 'SEK', 'NOK'];

export function CurrencyConverter() {
  const [data, setData] = useState<RatesResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState(100);
  const [from, setFrom] = usePersisted('devtools.currency.from', 'USD', v => typeof v === 'string');
  const [to, setTo] = usePersisted('devtools.currency.to', 'EUR', v => typeof v === 'string');
  const [targets, setTargets] = usePersisted<string[]>('devtools.currency.targets', ['EUR', 'GBP', 'JPY', 'PKR', 'INR', 'AED', 'CAD', 'AUD'], Array.isArray);
  const [addCode, setAddCode] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await toolsApi.get<RatesResponse>('/rates?base=USD'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const codes = useMemo(() => (data ? Object.keys(data.rates).sort() : []), [data]);
  const options = useMemo<PickOption[]>(() => {
    const popular = POPULAR.filter(c => data?.rates[c]);
    const rest = codes.filter(c => !popular.includes(c));
    return [...popular, ...rest].map(c => ({ value: c, label: `${c} — ${currencyName(c, data?.names)}`, hint: popular.includes(c) ? '★' : undefined }));
  }, [codes, data]);

  const rate = (a: string, b: string) => (data && data.rates[a] && data.rates[b] ? data.rates[b] / data.rates[a] : NaN);
  const r = rate(from, to);
  const result = C.num(amount) * r;
  const missing = data && (!data.rates[from] || !data.rates[to]);

  return (
    <div className="space-y-4">
      {error && <ErrorBox message={`Could not load exchange rates: ${error}`} />}
      {!data && loading && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading rates…</p>}
      {data && (
        <>
          <Card size="sm">
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto_minmax(0,1fr)] items-end">
                <NumberField label="Amount" value={amount} onChange={setAmount} min={0} step={1} />
                <div className="space-y-1.5 min-w-0"><FieldLabel>From</FieldLabel><SearchSelect value={from} options={options} onChange={setFrom} /></div>
                <Button variant="outline" size="icon" className="justify-self-center" title="Swap" onClick={() => { setFrom(to); setTo(from); }}><ArrowUpDown className="sm:rotate-90" /></Button>
                <div className="space-y-1.5 min-w-0"><FieldLabel>To</FieldLabel><SearchSelect value={to} options={options} onChange={setTo} /></div>
              </div>
              {missing ? <ErrorBox message="One of the selected currencies is not available from the rate provider." /> : (
                <div className="rounded-md border border-border bg-secondary/40 px-3 py-3 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted-foreground">{formatMoney(amount, from)} =</p>
                    <p className="text-2xl font-semibold tabular-nums break-all">{formatMoney(result, to)}</p>
                    <p className="text-[11px] text-muted-foreground tabular-nums">1 {from} = {fmtN(r, 6)} {to} · 1 {to} = {fmtN(1 / r, 6)} {from}</p>
                  </div>
                  <CopyButton value={Number.isFinite(result) ? result.toFixed(result < 1 ? 6 : 2) : ''} label="Copy" />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>Rates updated {new Date(data.updatedAt).toLocaleString()} · {data.source}</span>
                {data.stale && <Badge variant="destructive">stale — provider unreachable</Badge>}
                <Button variant="ghost" size="xs" onClick={load} disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh</Button>
              </div>
            </CardContent>
          </Card>

          <Section
            title={`${formatMoney(amount, from)} in other currencies`}
            action={
              <div className="w-48">
                <SearchSelect value={addCode} placeholder="Add currency…" options={options.filter(o => !targets.includes(o.value))}
                  onChange={c => { setTargets(t => [...t, c]); setAddCode(''); }} renderValue={() => <span className="text-muted-foreground flex items-center gap-1"><Plus className="size-3.5" /> Add currency…</span>} />
              </div>
            }
          >
            <div className="rounded-md border border-border divide-y divide-border">
              {targets.filter(c => data.rates[c] && c !== from).map(c => (
                <div key={c} className="flex items-center gap-2 px-3 py-1.5">
                  <button type="button" className="w-12 shrink-0 text-left font-mono text-xs font-semibold cursor-pointer hover:text-primary" title="Convert to this" onClick={() => setTo(c)}>{c}</button>
                  <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground hidden sm:block">{currencyName(c, data.names)}</span>
                  <span className="ml-auto text-sm font-medium tabular-nums text-right break-all">{formatMoney(C.num(amount) * rate(from, c), c)}</span>
                  <span className="w-24 text-right text-[11px] text-muted-foreground tabular-nums hidden md:block">@ {fmtN(rate(from, c), 4)}</span>
                  <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => setTargets(t => t.filter(x => x !== c))}><X /></Button>
                </div>
              ))}
              {targets.filter(c => data.rates[c] && c !== from).length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">Add currencies to compare.</p>}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// BMI
// ═════════════════════════════════════════════════════════════════════════════

const BMI_BANDS = [
  { from: 12, to: 18.5, color: '#60a5fa', label: 'Under' },
  { from: 18.5, to: 25, color: '#22c55e', label: 'Normal' },
  { from: 25, to: 30, color: '#f59e0b', label: 'Over' },
  { from: 30, to: 42, color: '#ef4444', label: 'Obese' },
];

export function BmiCalculator() {
  const [units, setUnits] = usePersisted<'metric' | 'imperial'>('devtools.bmi.units', 'metric', v => v === 'metric' || v === 'imperial');
  const [kg, setKg] = useState(72);
  const [cm, setCm] = useState(176);
  const [lb, setLb] = useState(160);
  const [ft, setFt] = useState(5);
  const [inch, setInch] = useState(9);

  const heightCm = units === 'metric' ? cm : C.inToCm(C.num(ft) * 12 + C.num(inch));
  const weightKg = units === 'metric' ? kg : C.lbToKg(lb);
  const valid = heightCm >= 50 && heightCm <= 272 && weightKg >= 10 && weightKg <= 650;
  const v = valid ? C.bmi(weightKg, heightCm) : NaN;
  const [lo, hi] = C.healthyWeightRange(heightCm);
  const w = (x: number) => (units === 'metric' ? `${fmtN(x, 1)} kg` : `${fmtN(C.kgToLb(x), 1)} lb`);
  const pos = Number.isFinite(v) ? Math.min(100, Math.max(0, ((v - 12) / 30) * 100)) : 0;
  const delta = v < 18.5 ? lo - weightKg : v >= 25 ? weightKg - hi : 0;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <Section title="Your measurements" action={<Segmented value={units} onChange={setUnits} options={[{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }]} />}>
        {units === 'metric' ? (
          <>
            <NumberField label="Height" value={cm} onChange={setCm} min={50} max={272} suffix="cm" />
            <NumberField label="Weight" value={kg} onChange={setKg} min={10} max={650} step={0.1} suffix="kg" />
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="Height" value={ft} onChange={setFt} min={1} max={8} suffix="ft" />
              <NumberField label={" "} value={inch} onChange={setInch} min={0} max={11.9} suffix="in" />
            </div>
            <NumberField label="Weight" value={lb} onChange={setLb} min={20} max={1400} step={0.1} suffix="lb" />
          </>
        )}
        {!valid && <ErrorBox message="Enter a realistic height and weight." />}
      </Section>
      <div className="space-y-3 min-w-0">
        {valid && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="BMI" value={fmtN(v, 1)} hint={C.bmiCategory(v)} />
              <Stat label="Healthy weight" value={`${w(lo)} – ${w(hi)}`} hint="BMI 18.5 – 24.9" />
              <Stat label="BMI Prime" value={fmtN(v / 25, 2)} hint={delta > 0 ? `${v < 18.5 ? 'Gain' : 'Lose'} ${w(delta)} to reach range` : 'Within healthy range'} />
            </div>
            <div className="space-y-1">
              <div className="relative h-3 rounded-full overflow-hidden flex">
                {BMI_BANDS.map(b => <div key={b.label} style={{ width: `${((b.to - b.from) / 30) * 100}%`, background: b.color }} />)}
              </div>
              <div className="relative h-4">
                <div className="absolute -top-1 -translate-x-1/2 text-xs" style={{ left: `${pos}%` }}>▲</div>
              </div>
              <div className="flex text-[11px] text-muted-foreground">
                {BMI_BANDS.map(b => <span key={b.label} style={{ width: `${((b.to - b.from) / 30) * 100}%` }} className="text-center">{b.label}</span>)}
              </div>
            </div>
          </>
        )}
        <DataTable
          head={['Category', 'BMI']}
          highlight={i => valid && C.BMI_CATEGORIES[i].label === C.bmiCategory(v)}
          rows={C.BMI_CATEGORIES.map((c, i) => [c.label, i === 0 ? `< ${c.max}` : c.max === Infinity ? `≥ ${C.BMI_CATEGORIES[i - 1].max}` : `${C.BMI_CATEGORIES[i - 1].max} – ${c.max}`])}
        />
        <p className="text-[11px] text-muted-foreground">WHO adult categories (age 20+). BMI doesn't distinguish muscle from fat — athletes and older adults may be misclassified.</p>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Age
// ═════════════════════════════════════════════════════════════════════════════

export function AgeCalculator() {
  const today = C.fmtYMD(C.todayYMD());
  const [birth, setBirth] = useState('1994-07-23');
  const [asOf, setAsOf] = useState(today);

  const b = C.parseYMD(birth);
  const a = C.parseYMD(asOf);
  const err = !b ? 'Enter a valid date of birth.' : !a ? 'Enter a valid "as of" date.' : C.dayNumber(b) > C.dayNumber(a) ? 'Date of birth is after the "as of" date.' : '';

  const res = useMemo(() => {
    if (err || !a || !b) return null;
    const d = C.diffYMD(b, a);
    const days = C.dayNumber(a) - C.dayNumber(b);
    const nb = C.nextBirthday(b, a);
    const nextK = Math.ceil((days + 1) / 1000) * 1000;
    return { d, days, months: C.totalMonths(b, a), nb, nextK, nextKDate: C.addDays(b, nextK) };
  }, [err, a?.y, a?.m, a?.d, b?.y, b?.m, b?.d]);

  const long = (v: C.YMD) => new Date(v.y, v.m - 1, v.d).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <Section title="Dates">
        <div className="space-y-1.5"><FieldLabel>Date of birth</FieldLabel><Input type="date" value={birth} onChange={e => setBirth(e.target.value)} /></div>
        <div className="space-y-1.5">
          <FieldLabel action={asOf !== today && <Button variant="ghost" size="xs" onClick={() => setAsOf(today)}>Today</Button>}>Age as of</FieldLabel>
          <Input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} />
        </div>
      </Section>
      <div className="space-y-3 min-w-0">
        {err && <ErrorBox message={err} />}
        {res && b && (
          <>
            <div className="rounded-lg border border-border bg-secondary/40 p-4">
              <p className="text-xs text-muted-foreground">Age</p>
              <p className="text-2xl font-semibold tabular-nums">
                {res.d.years} <span className="text-sm font-normal text-muted-foreground">years</span>{' '}
                {res.d.months} <span className="text-sm font-normal text-muted-foreground">months</span>{' '}
                {res.d.days} <span className="text-sm font-normal text-muted-foreground">days</span>
              </p>
              <p className="text-xs text-muted-foreground mt-1">Born on a {C.WEEKDAYS[C.weekday(b)]}</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="Total months" value={fmtN(res.months, 0)} />
              <Stat label="Total weeks" value={fmtN(Math.floor(res.days / 7), 0)} hint={res.days % 7 ? `+ ${res.days % 7} days` : undefined} />
              <Stat label="Total days" value={fmtN(res.days, 0)} />
              <Stat label="Total hours" value={fmtN(res.days * 24, 0)} />
              <Stat label="Total minutes" value={fmtN(res.days * 1440, 0)} />
              <Stat label={`Day ${fmtN(res.nextK, 0)}`} value={new Date(res.nextKDate.y, res.nextKDate.m - 1, res.nextKDate.d).toLocaleDateString()} hint={`in ${fmtN(res.nextK - res.days, 0)} days`} />
            </div>
            <InfoBox>
              {res.nb.days === 0
                ? <>Happy birthday — turning <b>{res.nb.turning}</b> today!</>
                : <>Next birthday: <b>{long(res.nb.date)}</b> — turning <b>{res.nb.turning}</b> in <b>{res.nb.days}</b> day{res.nb.days === 1 ? '' : 's'}
                  {res.nb.days > 31 && <> ({C.diffYMD(a!, res.nb.date).months} months {C.diffYMD(a!, res.nb.date).days} days)</>}.</>}
            </InfoBox>
          </>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// GPA
// ═════════════════════════════════════════════════════════════════════════════

interface Course { id: string; name: string; credits: number; grade: string }

export function GpaCalculator() {
  const [mode, setMode] = useState<'letter' | 'percent' | 'points'>('letter');
  const [courses, setCourses] = useState<Course[]>([
    { id: uid(), name: 'Calculus II', credits: 4, grade: 'A-' },
    { id: uid(), name: 'Data Structures', credits: 3, grade: 'A' },
    { id: uid(), name: 'Physics I', credits: 4, grade: 'B+' },
    { id: uid(), name: 'Technical Writing', credits: 2, grade: 'B' },
  ]);
  const [prevGpa, setPrevGpa] = useState(3.4);
  const [prevCredits, setPrevCredits] = useState(30);

  const toPoints = (g: string) => {
    if (mode === 'letter') return C.letterPoints(g);
    const n = Number(g);
    if (g.trim() === '' || !Number.isFinite(n)) return NaN;
    if (mode === 'percent') return n < 0 || n > 100 ? NaN : C.letterPoints(C.pctToLetter(n));
    return n < 0 || n > 4.0 ? NaN : n;
  };
  const switchMode = (m: typeof mode) => {
    // Convert grades so switching keeps rows meaningful.
    setCourses(cs => cs.map(c => {
      const pts = toPoints(c.grade);
      if (m === 'letter') {
        const g = mode === 'percent' && Number.isFinite(Number(c.grade)) ? C.pctToLetter(Number(c.grade)) : C.LETTER_GRADES.find(x => x.points <= pts + 1e-9)?.letter ?? 'A';
        return { ...c, grade: g };
      }
      if (m === 'percent') {
        const lg = mode === 'letter' ? c.grade : C.LETTER_GRADES.find(x => x.points <= pts + 1e-9)?.letter ?? 'A';
        const min = C.LETTER_GRADES.find(x => x.letter === lg)?.minPct ?? 90;
        return { ...c, grade: String(Math.min(100, min + 2)) };
      }
      return { ...c, grade: Number.isFinite(pts) ? String(pts) : '' };
    }));
    setMode(m);
  };

  const pts = courses.map(c => toPoints(c.grade));
  const r = C.gpa(courses.map((c, i) => ({ credits: c.credits, points: pts[i] })), prevGpa, prevCredits);
  const update = (id: string, patch: Partial<Course>) => setCourses(cs => cs.map(c => (c.id === id ? { ...c, ...patch } : c)));
  const bad = courses.some((c, i) => c.credits > 0 && !Number.isFinite(pts[i]));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
      <Section
        title="Courses"
        action={<Segmented value={mode} onChange={switchMode} options={[{ value: 'letter', label: 'Letter' }, { value: 'percent', label: '%' }, { value: 'points', label: 'Points' }]} />}
      >
        <div className="space-y-1.5">
          <div className="grid grid-cols-[minmax(0,1fr)_4rem_5.5rem_2.5rem_1.5rem] gap-1.5 text-[11px] text-muted-foreground px-0.5">
            <span>Course</span><span>Credits</span><span>{mode === 'letter' ? 'Grade' : mode === 'percent' ? 'Score %' : 'Points'}</span><span className="text-right">Pts</span><span />
          </div>
          {courses.map((c, i) => (
            <div key={c.id} className="grid grid-cols-[minmax(0,1fr)_4rem_5.5rem_2.5rem_1.5rem] gap-1.5 items-center">
              <Input className="h-7 text-xs" placeholder={`Course ${i + 1}`} value={c.name} onChange={e => update(c.id, { name: e.target.value })} />
              <NumInput value={c.credits} min={0} step={0.5} onChange={v => update(c.id, { credits: v })} />
              {mode === 'letter' ? (
                <select className={cn(SELECT, 'h-7')} value={c.grade} onChange={e => update(c.id, { grade: e.target.value })}>
                  {C.LETTER_GRADES.map(g => <option key={g.letter} value={g.letter}>{g.letter} ({g.points.toFixed(1)})</option>)}
                </select>
              ) : (
                <Input type="number" className={cn('h-7 text-xs', !Number.isFinite(pts[i]) && 'border-destructive')} step={mode === 'points' ? 0.1 : 1}
                  value={c.grade} onChange={e => update(c.id, { grade: e.target.value })} />
              )}
              <span className="text-xs text-right tabular-nums text-muted-foreground" title={mode === 'percent' && Number.isFinite(Number(c.grade)) ? C.pctToLetter(Number(c.grade)) : undefined}>
                {Number.isFinite(pts[i]) ? pts[i].toFixed(1) : '—'}
              </span>
              <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => setCourses(cs => cs.filter(x => x.id !== c.id))}><X /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setCourses(cs => [...cs, { id: uid(), name: '', credits: 3, grade: mode === 'letter' ? 'A' : mode === 'percent' ? '90' : '4' }])}>
            <Plus /> Add course
          </Button>
        </div>
        {bad && <ErrorBox message={mode === 'percent' ? 'Scores must be between 0 and 100.' : 'Points must be between 0.0 and 4.0.'} />}
        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border">
          <NumberField label="Previous cumulative GPA" value={prevGpa} onChange={setPrevGpa} min={0} max={4} step={0.01} />
          <NumberField label="Previous credits" value={prevCredits} onChange={setPrevCredits} min={0} />
        </div>
      </Section>
      <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-1 gap-2">
          <Stat label="Term GPA" value={Number.isFinite(r.term) ? r.term.toFixed(2) : '—'} hint={`${fmtN(r.credits, 1)} credits · ${fmtN(r.qualityPoints, 1)} quality pts`} />
          <Stat label="Cumulative GPA" value={Number.isFinite(r.cumulative) ? r.cumulative.toFixed(2) : '—'} hint={`${fmtN(r.totalCredits, 1)} total credits`} />
        </div>
        <DataTable
          head={['Grade', 'Points', '%']}
          rows={C.LETTER_GRADES.map((g, i) => [g.letter, g.points.toFixed(1), i === 0 ? '97–100' : `${g.minPct}–${C.LETTER_GRADES[i - 1].minPct - 1}`])}
          className="max-h-64"
        />
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Time duration
// ═════════════════════════════════════════════════════════════════════════════

export function TimeDurationCalculator() {
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:45');
  const [brk, setBrk] = useState(30);
  const [rows, setRows] = useState([
    { id: uid(), sign: 1, text: '1:45:30' },
    { id: uid(), sign: 1, text: '2h 15m' },
    { id: uid(), sign: 1, text: '00:38:10' },
    { id: uid(), sign: -1, text: '0:20' },
  ]);
  const [clock, setClock] = useState('22:30');
  const [addDur, setAddDur] = useState('3:45');

  const span = C.clockSpan(start, end);
  const worked = span ? span.seconds - Math.max(0, C.num(brk)) * 60 : NaN;
  const parsed = rows.map(r => C.parseDuration(r.text));
  const total = parsed.reduce<number>((s, v, i) => s + (v ?? 0) * rows[i].sign, 0);

  const clockSec = C.parseClock(clock);
  const addSec = C.parseDuration(addDur);
  const sum = clockSec !== null && addSec !== null ? clockSec + addSec : NaN;
  const dayShift = Number.isFinite(sum) ? Math.floor(sum / 86400) : 0;
  const wrapped = Number.isFinite(sum) ? ((sum % 86400) + 86400) % 86400 : NaN;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Between two times" description="End before start is treated as overnight.">
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1.5"><FieldLabel>Start</FieldLabel><Input type="time" step={1} value={start} onChange={e => setStart(e.target.value)} /></div>
          <div className="space-y-1.5"><FieldLabel>End</FieldLabel><Input type="time" step={1} value={end} onChange={e => setEnd(e.target.value)} /></div>
          <NumberField label="Break (min)" value={brk} onChange={setBrk} min={0} />
        </div>
        {!span ? <ErrorBox message="Enter both times." /> : worked < 0 ? <ErrorBox message="Break is longer than the time span." /> : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="Duration" value={C.formatHMS(worked)} hint={span.overnight ? 'overnight (+1 day)' : C.formatHuman(worked)} />
              <Stat label="Decimal hours" value={fmtN(worked / 3600, 2)} />
              <Stat label="Minutes" value={fmtN(worked / 60, 1)} />
            </div>
            {brk > 0 && <p className="text-[11px] text-muted-foreground">Span {C.formatHMS(span.seconds)} minus {brk} min break.</p>}
          </>
        )}
      </Section>

      <Section title="Add / subtract durations" description="hh:mm:ss, hh:mm, 1h 30m, 90m or plain minutes."
        action={<Button variant="ghost" size="xs" onClick={() => setRows(r => [...r, { id: uid(), sign: 1, text: '' }])}><Plus /> Add</Button>}>
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div key={r.id} className="flex items-center gap-1.5">
              <Button variant="outline" size="icon-sm" title="Toggle add/subtract" className="font-mono" onClick={() => setRows(rs => rs.map(x => x.id === r.id ? { ...x, sign: -x.sign } : x))}>
                {r.sign > 0 ? '+' : '−'}
              </Button>
              <Input className={cn(MONO, 'h-8', r.text && parsed[i] === null && 'border-destructive')} value={r.text} placeholder="0:30:00"
                onChange={e => setRows(rs => rs.map(x => x.id === r.id ? { ...x, text: e.target.value } : x))} />
              <span className="w-20 text-right text-xs text-muted-foreground tabular-nums shrink-0">{parsed[i] !== null ? C.formatHMS(parsed[i]!) : r.text ? 'invalid' : ''}</span>
              <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => setRows(rs => rs.filter(x => x.id !== r.id))}><X /></Button>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Stat label="Total" value={C.formatHMS(total)} hint={C.formatHuman(total)} />
          <Stat label="Decimal hours" value={fmtN(total / 3600, 3)} />
          <Stat label="Seconds" value={fmtN(total, 0)} />
        </div>
      </Section>

      <Section title="Clock time + duration" className="lg:col-span-2">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5 w-36"><FieldLabel>Time</FieldLabel><Input type="time" value={clock} onChange={e => setClock(e.target.value)} /></div>
          <div className="space-y-1.5 w-40"><FieldLabel>Add (negative to subtract)</FieldLabel><Input className={MONO} value={addDur} onChange={e => setAddDur(e.target.value)} /></div>
          <div className="pb-1.5 text-sm">
            {Number.isFinite(wrapped)
              ? <>= <b className="tabular-nums">{C.formatHMS(wrapped).slice(0, wrapped % 60 ? 8 : 5)}</b>{dayShift !== 0 && <Badge variant="secondary" className="ml-2">{dayShift > 0 ? '+' : ''}{dayShift} day{Math.abs(dayShift) === 1 ? '' : 's'}</Badge>}</>
              : <span className="text-xs text-destructive">Enter a valid time and duration</span>}
          </div>
        </div>
      </Section>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Electricity
// ═════════════════════════════════════════════════════════════════════════════

interface Appliance { id: string; name: string; watts: number; hours: number; qty: number }
const APPLIANCE_PRESETS: Omit<Appliance, 'id'>[] = [
  { name: 'LED bulb', watts: 10, hours: 6, qty: 1 },
  { name: 'Ceiling fan', watts: 75, hours: 10, qty: 1 },
  { name: 'Refrigerator', watts: 150, hours: 24, qty: 1 },
  { name: 'Air conditioner (1.5 ton)', watts: 1500, hours: 8, qty: 1 },
  { name: 'Inverter AC (avg)', watts: 900, hours: 8, qty: 1 },
  { name: 'Television', watts: 100, hours: 4, qty: 1 },
  { name: 'Laptop', watts: 60, hours: 8, qty: 1 },
  { name: 'Desktop PC', watts: 250, hours: 6, qty: 1 },
  { name: 'Wi-Fi router', watts: 10, hours: 24, qty: 1 },
  { name: 'Washing machine', watts: 500, hours: 1, qty: 1 },
  { name: 'Microwave', watts: 1200, hours: 0.3, qty: 1 },
  { name: 'Electric kettle', watts: 1800, hours: 0.25, qty: 1 },
  { name: 'Water heater', watts: 2000, hours: 1, qty: 1 },
  { name: 'Iron', watts: 1000, hours: 0.3, qty: 1 },
  { name: 'Water pump', watts: 750, hours: 1, qty: 1 },
  { name: 'Space heater', watts: 1500, hours: 4, qty: 1 },
  { name: 'EV charging (L2)', watts: 7200, hours: 2, qty: 1 },
];

export function ElectricityBillCalculator() {
  const [items, setItems] = useState<Appliance[]>(() => [
    { id: uid(), name: 'LED bulb', watts: 10, hours: 6, qty: 8 },
    { id: uid(), name: 'Ceiling fan', watts: 75, hours: 10, qty: 3 },
    { id: uid(), name: 'Refrigerator', watts: 150, hours: 24, qty: 1 },
    { id: uid(), name: 'Air conditioner (1.5 ton)', watts: 1500, hours: 6, qty: 1 },
    { id: uid(), name: 'Laptop', watts: 60, hours: 8, qty: 2 },
  ]);
  const [days, setDays] = useState(30);
  const [rate, setRate] = useState(0.16);
  const [tiered, setTiered] = useState(false);
  const [tiers, setTiers] = useState<(C.Tier & { id: string })[]>([
    { id: uid(), upTo: 200, rate: 0.12 },
    { id: uid(), upTo: 500, rate: 0.18 },
    { id: uid(), upTo: null, rate: 0.25 },
  ]);
  const [fixed, setFixed] = useState(0);
  const [taxPct, setTaxPct] = useState(0);

  const kwh = items.map(a => C.applianceKwh(a.watts, a.hours, a.qty, days));
  const totalKwh = kwh.reduce((s, x) => s + x, 0);
  const energy = tiered ? C.tieredCost(totalKwh, tiers) : { cost: totalKwh * C.num(rate), breakdown: [] };
  const avgRate = totalKwh ? energy.cost / totalKwh : tiered ? C.num(tiers[0]?.rate) : C.num(rate);
  const subtotal = energy.cost + C.num(fixed);
  const total = subtotal * (1 + C.num(taxPct) / 100);
  const upd = (id: string, p: Partial<Appliance>) => setItems(xs => xs.map(x => (x.id === id ? { ...x, ...p } : x)));

  const csv = () => downloadBlob(toCsv(['Appliance', 'Watts', 'Hours/day', 'Qty', 'kWh', 'Cost'],
    items.map((a, i) => [a.name, a.watts, a.hours, a.qty, kwh[i].toFixed(2), (kwh[i] * avgRate).toFixed(2)])), 'electricity.csv', 'text/csv');

  return (
    <div className="space-y-4">
      <Section
        title="Appliances"
        action={
          <div className="flex items-center gap-2">
            <select className={cn(SELECT, 'w-40')} value="" onChange={e => {
              const p = APPLIANCE_PRESETS[Number(e.target.value)];
              if (p) setItems(xs => [...xs, { ...p, id: uid() }]);
            }}>
              <option value="">+ Add appliance…</option>
              {APPLIANCE_PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name} ({p.watts} W)</option>)}
            </select>
            <Button variant="outline" size="sm" onClick={() => setItems(xs => [...xs, { id: uid(), name: '', watts: 100, hours: 1, qty: 1 }])}><Plus /> Custom</Button>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <div className="min-w-[36rem] space-y-1.5">
            <div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem_4rem_5.5rem_5.5rem_1.5rem] gap-1.5 text-[11px] text-muted-foreground">
              <span>Appliance</span><span>Watts</span><span>Hours/day</span><span>Qty</span><span className="text-right">kWh / {days || 0}d</span><span className="text-right">Cost</span><span />
            </div>
            {items.map((a, i) => (
              <div key={a.id} className="grid grid-cols-[minmax(0,1fr)_5rem_5rem_4rem_5.5rem_5.5rem_1.5rem] gap-1.5 items-center">
                <Input className="h-7 text-xs" value={a.name} placeholder="Appliance" onChange={e => upd(a.id, { name: e.target.value })} />
                <NumInput value={a.watts} min={0} onChange={v => upd(a.id, { watts: v })} />
                <NumInput value={a.hours} min={0} step={0.25} onChange={v => upd(a.id, { hours: Math.min(24, v) })} />
                <NumInput value={a.qty} min={0} onChange={v => upd(a.id, { qty: v })} />
                <span className="text-xs text-right tabular-nums">{fmtN(kwh[i], 2)}</span>
                <span className="text-xs text-right tabular-nums">{fmt(kwh[i] * avgRate)}</span>
                <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => setItems(xs => xs.filter(x => x.id !== a.id))}><X /></Button>
              </div>
            ))}
            {items.length === 0 && <p className="text-xs text-muted-foreground py-2">Add appliances to estimate usage.</p>}
          </div>
        </div>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Tariff">
          <div className="grid grid-cols-3 gap-2">
            <NumberField label="Billing days" value={days} onChange={setDays} min={1} max={366} />
            <NumberField label="Fixed charge" value={fixed} onChange={setFixed} min={0} />
            <NumberField label="Tax" value={taxPct} onChange={setTaxPct} min={0} suffix="%" />
          </div>
          <Segmented value={tiered ? 'tiered' : 'flat'} onChange={v => setTiered(v === 'tiered')} options={[{ value: 'flat', label: 'Flat rate' }, { value: 'tiered', label: 'Tiered (slabs)' }]} />
          {!tiered ? (
            <NumberField label="Price per kWh" value={rate} onChange={setRate} min={0} step={0.01} />
          ) : (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_1.5rem] gap-1.5 text-[11px] text-muted-foreground"><span>From kWh</span><span>Up to kWh</span><span>Price / kWh</span><span /></div>
              {tiers.map((t, i) => (
                <div key={t.id} className="grid grid-cols-[5rem_minmax(0,1fr)_minmax(0,1fr)_1.5rem] gap-1.5 items-center">
                  <span className="text-xs tabular-nums text-muted-foreground">{i === 0 ? 0 : tiers[i - 1].upTo ?? '—'}</span>
                  {i === tiers.length - 1
                    ? <span className="text-xs text-muted-foreground">and above</span>
                    : <NumInput value={t.upTo ?? NaN} min={0} onChange={v => setTiers(ts => ts.map(x => x.id === t.id ? { ...x, upTo: v } : x))} />}
                  <NumInput value={t.rate} min={0} step={0.01} onChange={v => setTiers(ts => ts.map(x => x.id === t.id ? { ...x, rate: v } : x))} />
                  <Button variant="ghost" size="icon-xs" disabled={tiers.length <= 1} onClick={() => setTiers(ts => {
                    const n = ts.filter(x => x.id !== t.id);
                    return n.map((x, j) => (j === n.length - 1 ? { ...x, upTo: null } : x));
                  })}><X /></Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setTiers(ts => {
                const last = ts[ts.length - 1];
                const prevCap = ts.length > 1 ? (ts[ts.length - 2].upTo ?? 0) : 0;
                return [...ts.slice(0, -1), { ...last, upTo: prevCap + 200 }, { id: uid(), upTo: null, rate: last.rate }];
              })}><Plus /> Add slab</Button>
            </div>
          )}
        </Section>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Stat label={`Estimated bill (${days || 0} days)`} value={fmt(total)} hint={taxPct || fixed ? `${fmt(energy.cost)} energy${fixed ? ` + ${fmt(fixed)} fixed` : ''}${taxPct ? ` + ${taxPct}% tax` : ''}` : undefined} />
            <Stat label="Energy used" value={`${fmtN(totalKwh, 1)} kWh`} hint={`${fmtN(totalKwh / Math.max(1, days || 1), 2)} kWh/day`} />
            <Stat label="Average price" value={`${fmtN(avgRate, 4)} /kWh`} />
            <Stat label="Per year (est.)" value={fmt(total / Math.max(1, days || 1) * 365)} />
          </div>
          {tiered && energy.breakdown.length > 0 && (
            <DataTable head={['Slab', 'kWh', 'Rate', 'Cost']} rows={energy.breakdown.map(b => [`${fmtN(b.from, 0)}–${fmtN(b.to, 0)}`, fmtN(b.kwh, 1), fmtN(b.rate, 4), fmt(b.cost)])} />
          )}
          {items.length > 0 && totalKwh > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Share of usage</p>
              {items.map((a, i) => ({ a, k: kwh[i] })).sort((x, y) => y.k - x.k).slice(0, 6).map(({ a, k }) => (
                <div key={a.id} className="flex items-center gap-2 text-xs">
                  <span className="w-32 truncate">{a.name || 'Unnamed'}</span>
                  <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full bg-primary" style={{ width: `${(k / totalKwh) * 100}%` }} /></div>
                  <span className="w-10 text-right tabular-nums text-muted-foreground">{fmtN((k / totalKwh) * 100, 0)}%</span>
                </div>
              ))}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={csv} disabled={!items.length}><Download /> Export CSV</Button>
        </div>
      </div>
    </div>
  );
}
