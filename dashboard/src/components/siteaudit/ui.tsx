import React from 'react';
import { AlertOctagon, AlertTriangle, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Severity } from './api';

export const SEVERITY: Record<Severity, { label: string; icon: React.ElementType; text: string; bg: string; bar: string }> = {
  error: { label: 'Error', icon: AlertOctagon, text: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/10 border-red-500/30', bar: 'bg-red-500' },
  warning: { label: 'Warning', icon: AlertTriangle, text: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30', bar: 'bg-amber-500' },
  notice: { label: 'Notice', icon: Info, text: 'text-sky-600 dark:text-sky-400', bg: 'bg-sky-500/10 border-sky-500/30', bar: 'bg-sky-500' },
};

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  const s = SEVERITY[severity];
  const Icon = s.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 h-5 px-1.5 rounded-full border text-[11px] font-medium whitespace-nowrap', s.bg, s.text)}>
      <Icon className="size-3" />
      {count !== undefined ? count.toLocaleString() : s.label}
    </span>
  );
}

/** Score → token colour. Good / needs work / poor, always shown next to the number. */
export function scoreTone(score: number) {
  if (score >= 90) return { stroke: 'stroke-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: 'Good' };
  if (score >= 70) return { stroke: 'stroke-amber-500', text: 'text-amber-600 dark:text-amber-400', label: 'Needs work' };
  return { stroke: 'stroke-red-500', text: 'text-red-600 dark:text-red-400', label: 'Poor' };
}

export function ScoreRing({ score, size = 120, label, grade }: { score: number; size?: number; label?: string; grade?: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const tone = scoreTone(score);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${label || 'Score'} ${score} of 100`}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx="50" cy="50" r={r} className="stroke-border" strokeWidth="8" fill="none" />
        <circle cx="50" cy="50" r={r} className={tone.stroke} strokeWidth="8" fill="none" strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`} style={{ transition: 'stroke-dasharray .6s ease' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('font-bold tabular-nums leading-none', tone.text)} style={{ fontSize: size * 0.28 }}>{score}</span>
        {grade && <span className="text-[11px] text-muted-foreground mt-0.5">Grade {grade}</span>}
      </div>
    </div>
  );
}

export function MiniScore({ score }: { score: number }) {
  const tone = scoreTone(score);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="h-1.5 flex-1 rounded-full bg-border overflow-hidden">
        <div className={cn('h-full rounded-full', tone.stroke.replace('stroke-', 'bg-'))} style={{ width: `${score}%` }} />
      </div>
      <span className={cn('text-xs font-semibold tabular-nums w-7 text-right', tone.text)}>{score}</span>
    </div>
  );
}

/** Horizontal single-series bars with a hover tooltip and the value printed at the end. */
export function BarList({ items, onClick, format = (n: number) => n.toLocaleString(), barClass = 'bg-primary' }: {
  items: { label: string; value: number; hint?: string; key?: string; barClass?: string }[];
  onClick?: (key: string) => void;
  format?: (n: number) => string;
  barClass?: string;
}) {
  const max = Math.max(1, ...items.map(i => i.value));
  return (
    <div className="space-y-1">
      {items.map(i => (
        <button key={i.key || i.label} type="button" disabled={!onClick} onClick={() => onClick?.(i.key || i.label)}
          title={`${i.label}: ${format(i.value)}${i.hint ? ` — ${i.hint}` : ''}`}
          className={cn('w-full flex items-center gap-2 text-left group rounded px-1 -mx-1 py-0.5', onClick && 'cursor-pointer hover:bg-secondary/60')}>
          <span className="w-28 shrink-0 text-xs text-muted-foreground truncate">{i.label}</span>
          <span className="flex-1 h-3 rounded-sm bg-secondary overflow-hidden">
            <span className={cn('block h-full rounded-r-[3px]', i.barClass || barClass)} style={{ width: `${Math.max(i.value > 0 ? 2 : 0, (i.value / max) * 100)}%` }} />
          </span>
          <span className="w-12 shrink-0 text-right text-xs tabular-nums">{format(i.value)}</span>
        </button>
      ))}
    </div>
  );
}

/** Vertical histogram (single series), value on hover and the label underneath. */
export function Histogram({ items, barClass = 'bg-primary', height = 96 }: { items: { label: string; value: number }[]; barClass?: string; height?: number }) {
  const max = Math.max(1, ...items.map(i => i.value));
  return (
    <div className="flex items-end gap-[2px]" style={{ height: height + 18 }}>
      {items.map(i => (
        <div key={i.label} className="flex-1 min-w-0 flex flex-col items-center justify-end h-full group" title={`${i.label}: ${i.value.toLocaleString()}`}>
          <span className="text-[10px] tabular-nums text-muted-foreground opacity-0 group-hover:opacity-100">{i.value}</span>
          <div className={cn('w-full rounded-t-[4px] min-h-[2px] transition-opacity group-hover:opacity-80', barClass)} style={{ height: `${(i.value / max) * height}px` }} />
          <span className="text-[10px] text-muted-foreground truncate w-full text-center mt-0.5">{i.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Pager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (o: number) => void }) {
  if (total <= limit) return <p className="text-[11px] text-muted-foreground">{total.toLocaleString()} rows</p>;
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <Button size="icon-xs" variant="outline" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}><ChevronLeft /></Button>
      <span className="tabular-nums">{(offset + 1).toLocaleString()}–{Math.min(total, offset + limit).toLocaleString()} of {total.toLocaleString()}</span>
      <Button size="icon-xs" variant="outline" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}><ChevronRight /></Button>
    </div>
  );
}

export function StatusPill({ status, error, blocked }: { status: number; error?: string; blocked?: boolean }) {
  let cls = 'bg-secondary text-muted-foreground border-border';
  let text = String(status);
  if (blocked) { text = 'Blocked'; cls = 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'; }
  else if (error) { text = 'Error'; cls = 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30'; }
  else if (status >= 200 && status < 300) cls = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30';
  else if (status >= 300 && status < 400) cls = 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30';
  else if (status >= 400 || status === 0) { cls = 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30'; if (status === 0) text = '—'; }
  return <span title={error} className={cn('inline-flex items-center h-5 px-1.5 rounded border text-[11px] font-mono tabular-nums whitespace-nowrap', cls)}>{text}</span>;
}

export function Section({ title, icon: Icon, action, children, className }: { title: React.ReactNode; icon?: React.ElementType; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-border bg-card p-4 min-w-0', className)}>
      <div className="flex items-center gap-2 mb-3 min-h-6">
        {Icon && <Icon className="size-4 text-primary shrink-0" />}
        <h3 className="text-[13px] font-semibold tracking-tight flex-1 min-w-0">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function KV({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-1.5 border-b border-border last:border-0 text-xs min-w-0">
      <span className="w-36 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('flex-1 min-w-0 break-words', mono && 'font-mono')}>{children ?? '—'}</span>
    </div>
  );
}

export function Check({ ok, children, warn }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs py-1">
      <span className={cn('mt-0.5 size-4 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold text-white',
        ok ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-red-500')} aria-label={ok ? 'pass' : 'fail'}>{ok ? '✓' : '!'}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function shortUrl(u: string, origin?: string) {
  if (origin && u.startsWith(origin)) return u.slice(origin.length) || '/';
  return u.replace(/^https?:\/\//, '');
}

export function fmtMs(ms: number) {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function fmtBytes(n: number) {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ExtLink({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) {
  return <a href={href} target="_blank" rel="noreferrer noopener" className={cn('hover:text-primary hover:underline break-all', className)}>{children ?? href}</a>;
}
