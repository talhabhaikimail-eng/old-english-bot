import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, CircleX, Download, ExternalLink, Globe, Info, Loader2, Play, Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Checkbox, CopyButton, ErrorBox, FieldLabel, FIXED, InfoBox, JobResult, MONO, NumberField, OutputRow, Segmented, Stat,
  downloadBlob, formatBytes, jobsApi, toolsApi, useJob,
} from './shared';
import {
  estimateLoad, formatMs, IMAGE_SPECS, imageIssues, lengthStatus, normalizeInput, parseUrlList, PROFILES, scoreLabel,
  scoreTone, SERP, serpBreadcrumb, siteName, textWidthPx, toCsv, truncateToWidth, type LoadModel, type Platform,
} from './lib/seo';

// SEO tools. Everything that touches a URL runs on the backend (/api/tools/seo/*), which fetches
// pages through an SSRF-guarded client; nothing here talks to third-party sites directly except
// <img> previews of og:image URLs.

// ───────────────────────────── types ─────────────────────────────

type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';
interface Hop { url: string; status: number; statusText: string; location?: string; ttfbMs: number; totalMs: number }
interface Check { id: string; category: string; label: string; status: CheckStatus; message: string; advice?: string; weight: number }
interface ImageProbe { url: string; status?: number; contentType?: string; bytes?: number; width?: number; height?: number; format?: string; error?: string }

interface Analysis {
  url: string; finalUrl: string; status: number; statusText: string; chain: Hop[]; redirectError?: string;
  timing: { ttfbMs: number; totalMs: number; totalAllMs: number };
  size: { transferBytes: number; htmlBytes: number; encoding: string; truncated: boolean };
  httpVersion: string; ip?: string; contentType: string; isHtml: boolean;
  headers: Record<string, string>;
  charset: { value: string; source: string; meta: string | null };
  title: { text: string; length: number; count: number };
  description: { text: string; length: number; count: number };
  robots: { meta: { name: string; content: string }[]; xRobotsTag: string[]; directives: { noindex: boolean; nofollow: boolean; raw: string[] } };
  canonical: { tags: { href: string; resolved: string | null; inHead: boolean }[]; header: string | null; resolved: string | null; selfReferential: boolean | null };
  lang: string | null; viewport: string | null; metaRefresh: string | null; hasDoctype: boolean;
  favicons: { rel: string; href: string; sizes: string; type: string }[];
  faviconFallback: { url: string; status: number | null; error?: string } | null;
  og: Record<string, string>; ogImages: string[]; twitter: Record<string, string>; ogImage: ImageProbe | null; twitterImage: ImageProbe | null;
  meta: { attr: string; key: string; value: string }[];
  hreflang: { lang: string; href: string; valid: boolean }[];
  headings: { outline: { level: number; text: string }[]; counts: number[]; skipped: string[] };
  content: { wordCount: number; textLength: number; htmlLength: number; ratio: number; readingMinutes: number; excerpt: string };
  images: { total: number; missingAlt: number; emptyAlt: number; missingDimensions: number; lazy: number; withSrcset: number; formats: Record<string, number>; list: { src: string; alt: string | null; width: string | null; height: string | null; loading: string | null }[] };
  links: { total: number; internal: number; external: number; nofollow: number; sponsored: number; ugc: number; internalNofollow: number; empty: number; generic: number; list: { href: string; text: string; rel: string[]; internal: boolean }[] };
  structuredData: { jsonLd: { types: string[]; error: string | null; snippet: string }[]; microdata: string[]; rdfa: string[]; types: string[] };
  resources: { scripts: number; inlineScripts: number; stylesheets: number; inlineStyles: number; iframes: number; renderBlocking: string[] };
  mixedContent: { tag: string; url: string }[];
  checks: Check[];
  score: number;
  categories: { id: string; label: string; score: number; pass: number; warn: number; fail: number }[];
}

// ───────────────────────────── shared state & hooks ─────────────────────────────

const EXAMPLE_URL = 'https://example.com';
/** The URL last used in any SEO tool, so switching tools keeps it. */
let lastUrl = EXAMPLE_URL;

const UA_OPTIONS = [
  { value: 'chrome-desktop', label: 'Chrome desktop' },
  { value: 'chrome-mobile', label: 'Chrome mobile' },
  { value: 'googlebot', label: 'Googlebot smartphone' },
  { value: 'bingbot', label: 'Bingbot' },
];

const analysisCache = new Map<string, { at: number; data: Analysis }>();
const CACHE_MS = 5 * 60_000;

function useRequest<T>() {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<T>) => {
    setLoading(true);
    setError('');
    try {
      const d = await fn();
      setData(d);
      return d;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  };
  return { data, setData, loading, error, run };
}

/** Analyze hook shared by the score / meta / OG tools (cached for 5 minutes per URL + UA). */
function useAnalysis(initialUa = 'chrome-desktop') {
  const req = useRequest<Analysis>();
  // Re-show a recent result when switching between the analyze-based tools.
  useEffect(() => {
    const hit = analysisCache.get(`${lastUrl}|${initialUa}`);
    if (hit && Date.now() - hit.at < CACHE_MS) req.setData(hit.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const analyze = (url: string, ua: string, force = false) => req.run(async () => {
    const u = normalizeInput(url);
    lastUrl = u;
    const key = `${u}|${ua}`;
    const hit = analysisCache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const d = await toolsApi.post<Analysis>('/seo/analyze', { url: u, userAgent: ua });
    analysisCache.set(key, { at: Date.now(), data: d });
    return d;
  });
  return { ...req, analyze };
}

// ───────────────────────────── small UI pieces ─────────────────────────────

const selectCls = 'h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-primary';

function NativeSelect({ value, onChange, options, className, title }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string; title?: string;
}) {
  return (
    <select className={cn(selectCls, className)} value={value} title={title} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function UrlForm({ url, onUrl, onSubmit, loading, children, button = 'Analyze', placeholder = 'https://example.com/page' }: {
  url: string; onUrl: (v: string) => void; onSubmit: () => void; loading: boolean; children?: React.ReactNode; button?: string; placeholder?: string;
}) {
  return (
    <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={e => { e.preventDefault(); if (!loading && url.trim()) onSubmit(); }}>
      <div className="relative flex-1 min-w-0">
        <Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input className="pl-8" value={url} onChange={e => onUrl(e.target.value)} placeholder={placeholder} spellCheck={false} inputMode="url" />
      </div>
      <div className="flex gap-2">
        {children}
        <Button type="submit" disabled={loading || !url.trim()} className="shrink-0">
          {loading ? <Loader2 className="animate-spin" /> : <Search />}
          {loading ? 'Checking…' : button}
        </Button>
      </div>
    </form>
  );
}

function StatusIcon({ status, className }: { status: CheckStatus; className?: string }) {
  if (status === 'pass') return <CheckCircle2 className={cn('size-4 shrink-0 text-primary', className)} />;
  if (status === 'fail') return <CircleX className={cn('size-4 shrink-0 text-destructive', className)} />;
  if (status === 'warn') return <AlertTriangle className={cn('size-4 shrink-0 text-foreground/70', className)} />;
  return <Info className={cn('size-4 shrink-0 text-muted-foreground', className)} />;
}

function StatusBadge({ status, children }: { status: CheckStatus; children?: React.ReactNode }) {
  const label = children ?? (status === 'pass' ? 'Pass' : status === 'fail' ? 'Fail' : status === 'warn' ? 'Warning' : 'Info');
  return (
    <Badge variant={status === 'fail' ? 'destructive' : status === 'pass' ? 'default' : status === 'warn' ? 'outline' : 'secondary'} className="shrink-0">
      {label}
    </Badge>
  );
}

function httpStatus(status: number | null | undefined): CheckStatus {
  if (!status) return 'fail';
  if (status >= 200 && status < 300) return 'pass';
  if (status >= 300 && status < 400) return 'warn';
  return 'fail';
}

function Loading({ label = 'Fetching and analysing…' }: { label?: string }) {
  return <p className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center"><Loader2 className="size-4 animate-spin" />{label}</p>;
}

function Section({ title, description, action, children, className }: {
  title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <Card size="sm" className={cn('min-w-0', className)}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-sm">{title}</CardTitle>
            {description && <CardDescription className="text-xs">{description}</CardDescription>}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 min-w-0">{children}</CardContent>
    </Card>
  );
}

function ScoreGauge({ score, size = 112 }: { score: number; size?: number }) {
  const tone = scoreTone(score);
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" className="stroke-secondary" />
        <circle
          cx="50" cy="50" r={r} fill="none" strokeWidth="9" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)}
          className={cn('transition-all duration-700', tone === 'good' ? 'stroke-primary' : tone === 'ok' ? 'stroke-foreground/60' : 'stroke-destructive')}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums leading-none">{score}</span>
        <span className="text-[10px] text-muted-foreground mt-1">/ 100</span>
      </div>
    </div>
  );
}

function Bar({ pct, tone = 'primary', className }: { pct: number; tone?: 'primary' | 'muted' | 'destructive' | 'foreground'; className?: string }) {
  const color = tone === 'primary' ? 'bg-primary' : tone === 'destructive' ? 'bg-destructive' : tone === 'foreground' ? 'bg-foreground/60' : 'bg-muted-foreground/40';
  return (
    <div className={cn('h-1.5 rounded-full bg-secondary overflow-hidden', className)}>
      <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/** Length meter with a recommended window. */
function LengthMeter({ len, min, max, hardMax, px, pxMax, unit = 'chars' }: {
  len: number; min: number; max: number; hardMax: number; px?: number; pxMax?: number; unit?: string;
}) {
  const st = lengthStatus(len, min, max);
  const pxOver = px !== undefined && pxMax !== undefined && px > pxMax;
  return (
    <div className="space-y-1">
      <div className="relative h-2 rounded-full bg-secondary overflow-hidden">
        <div className="absolute inset-y-0 bg-primary/15" style={{ left: `${(min / hardMax) * 100}%`, width: `${((max - min) / hardMax) * 100}%` }} />
        <div className={cn('absolute inset-y-0 left-0 rounded-full', st === 'ok' && !pxOver ? 'bg-primary' : st === 'missing' ? '' : st === 'long' || pxOver ? 'bg-destructive' : 'bg-foreground/50')}
          style={{ width: `${Math.min(100, (len / hardMax) * 100)}%` }} />
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 text-[11px] text-muted-foreground tabular-nums">
        <span>
          {len} {unit}{px !== undefined && ` · ~${px}px`}
          {' — '}
          <span className={cn(st === 'ok' && !pxOver ? 'text-primary' : st === 'long' || pxOver || st === 'missing' ? 'text-destructive' : 'text-foreground')}>
            {st === 'missing' ? 'missing' : st === 'short' ? 'too short' : st === 'long' ? 'too long' : pxOver ? 'too wide, will be cut' : 'good length'}
          </span>
        </span>
        <span>recommended {min}–{max}{pxMax ? ` · ≤ ${pxMax}px` : ''}</span>
      </div>
    </div>
  );
}

function RedirectChain({ chain, error }: { chain: Hop[]; error?: string }) {
  if (!chain?.length) return null;
  return (
    <div className="space-y-1">
      {chain.map((h, i) => (
        <div key={i} className="flex items-center gap-2 text-xs min-w-0">
          <Badge variant={h.status >= 400 ? 'destructive' : h.status >= 300 ? 'outline' : 'default'} className="tabular-nums shrink-0">{h.status}</Badge>
          <span className={cn(MONO, 'truncate flex-1 min-w-0')} title={h.url}>{h.url}</span>
          <span className="text-muted-foreground tabular-nums shrink-0">{h.totalMs} ms</span>
          {i < chain.length - 1 && <ArrowRight className="size-3 text-muted-foreground shrink-0" />}
        </div>
      ))}
      {error && <ErrorBox message={error} />}
    </div>
  );
}

function Table({ head, children, className }: { head: React.ReactNode[]; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto rounded-md border border-border', className)}>
      <table className="w-full text-xs">
        <thead className="bg-secondary/60 text-muted-foreground">
          <tr>{head.map((h, i) => <th key={i} className="text-left font-medium px-2.5 py-1.5 whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody className="[&>tr]:border-t [&>tr]:border-border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top">{children}</tbody>
      </table>
    </div>
  );
}

function ExtLink({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={cn('inline-flex items-center gap-1 hover:underline break-all', className)} title={href}>
      {children ?? href}<ExternalLink className="size-3 shrink-0 opacity-60" />
    </a>
  );
}

function CheckRow({ c }: { c: { status: CheckStatus; label: string; message: string; advice?: string; detail?: string } }) {
  return (
    <div className="flex gap-2.5 py-2 border-b border-border last:border-0 min-w-0">
      <StatusIcon status={c.status} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-medium">{c.label}</span>
          <span className="text-xs text-muted-foreground break-words min-w-0">{c.message}</span>
        </div>
        {(c.advice || c.detail) && (
          <p className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
            {c.advice && <span className="font-medium text-foreground">How to fix: </span>}{c.advice || c.detail}
          </p>
        )}
      </div>
    </div>
  );
}

function VerdictBanner({ status, title, summary, children }: { status: 'pass' | 'warn' | 'fail'; title: string; summary: string; children?: React.ReactNode }) {
  return (
    <div className={cn('flex gap-3 rounded-lg border p-3 sm:p-4',
      status === 'pass' ? 'border-primary/50 bg-primary/10' : status === 'fail' ? 'border-destructive/50 bg-destructive/10' : 'border-border bg-secondary/60')}>
      <StatusIcon status={status} className="size-6 mt-0.5" />
      <div className="min-w-0 space-y-1">
        <p className={cn('text-sm font-semibold', status === 'pass' ? 'text-primary' : status === 'fail' ? 'text-destructive' : 'text-foreground')}>{title}</p>
        <p className="text-xs text-muted-foreground break-words">{summary}</p>
        {children}
      </div>
    </div>
  );
}

function downloadJson(data: unknown, name: string) {
  downloadBlob(JSON.stringify(data, null, 2), name, 'application/json');
}

function fileSlug(url: string) {
  return siteName(url).replace(/[^a-z0-9.-]+/gi, '_') || 'page';
}

function useUrlState() {
  const [url, setUrl] = useState(lastUrl);
  return [url, (v: string) => { setUrl(v); }] as const;
}

// ───────────────────────────── SEO Score Checker ─────────────────────────────

const CATEGORY_ORDER = ['meta', 'content', 'links', 'images', 'technical', 'social'];

function reportMarkdown(a: Analysis) {
  const lines = [`# SEO report — ${a.finalUrl}`, '', `Score: **${a.score}/100** (${scoreLabel(a.score)})`, ''];
  for (const cat of a.categories) {
    lines.push(`## ${cat.label} — ${cat.score}/100`);
    for (const c of a.checks.filter(x => x.category === cat.id)) {
      lines.push(`- [${c.status.toUpperCase()}] ${c.label}: ${c.message}${c.advice ? `\n  - Fix: ${c.advice}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function SeoScoreChecker() {
  const [url, setUrl] = useUrlState();
  const [ua, setUa] = useState('chrome-desktop');
  const [filter, setFilter] = useState<'issues' | 'all' | 'pass'>('issues');
  const [cat, setCat] = useState<string | null>(null);
  const { data: a, loading, error, analyze } = useAnalysis();

  const checks = useMemo(() => {
    if (!a) return [];
    return a.checks
      .filter(c => (filter === 'all' ? true : filter === 'pass' ? c.status === 'pass' : c.status === 'warn' || c.status === 'fail'))
      .filter(c => !cat || c.category === cat)
      .sort((x, y) => {
        const rank = (s: CheckStatus) => (s === 'fail' ? 0 : s === 'warn' ? 1 : s === 'info' ? 2 : 3);
        return rank(x.status) - rank(y.status) || y.weight - x.weight;
      });
  }, [a, filter, cat]);

  const counts = a ? {
    fail: a.checks.filter(c => c.status === 'fail').length,
    warn: a.checks.filter(c => c.status === 'warn').length,
    pass: a.checks.filter(c => c.status === 'pass').length,
  } : null;

  return (
    <div className="space-y-4">
      <UrlForm url={url} onUrl={setUrl} loading={loading} onSubmit={() => analyze(url, ua, true)}>
        <NativeSelect value={ua} onChange={setUa} options={UA_OPTIONS} title="Fetch as" className="w-36 sm:w-44" />
      </UrlForm>
      {error && <ErrorBox message={error} />}
      {loading && !a && <Loading />}
      {!a && !loading && !error && <InfoBox>Enter a URL and press Analyze. The page is fetched by the server (as the selected user agent) and audited against ~40 on-page, technical and social checks.</InfoBox>}
      {a && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <Card size="sm">
            <CardContent>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="flex items-center gap-4">
                  <ScoreGauge score={a.score} />
                  <div className="space-y-1 sm:hidden">
                    <p className="text-base font-semibold">{scoreLabel(a.score)}</p>
                  </div>
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="hidden sm:block text-base font-semibold">{scoreLabel(a.score)}</div>
                  <ExtLink href={a.finalUrl} className="text-xs text-muted-foreground">{a.finalUrl}</ExtLink>
                  {counts && (
                    <div className="flex flex-wrap gap-1.5">
                      <StatusBadge status="fail">{counts.fail} failed</StatusBadge>
                      <StatusBadge status="warn">{counts.warn} warnings</StatusBadge>
                      <StatusBadge status="pass">{counts.pass} passed</StatusBadge>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="HTTP" value={<span className={a.status >= 400 ? 'text-destructive' : ''}>{a.status}</span>} hint={a.chain.length > 1 ? `${a.chain.length - 1} redirect(s)` : a.httpVersion ? `HTTP/${a.httpVersion}` : undefined} />
                    <Stat label="TTFB" value={formatMs(a.timing.ttfbMs)} hint={`total ${formatMs(a.timing.totalAllMs)}`} />
                    <Stat label="HTML" value={formatBytes(a.size.transferBytes)} hint={a.size.encoding || 'uncompressed'} />
                    <Stat label="Words" value={a.content.wordCount.toLocaleString()} hint={`${a.content.readingMinutes} min read`} />
                  </div>
                </div>
                <div className="flex sm:flex-col gap-1.5">
                  <CopyButton value={reportMarkdown(a)} label="Copy report" />
                  <Button variant="ghost" size="xs" onClick={() => downloadJson(a, `seo-${fileSlug(a.finalUrl)}.json`)}><Download /> JSON</Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {a.chain.length > 1 && (
            <Section title="Redirect chain"><RedirectChain chain={a.chain} error={a.redirectError} /></Section>
          )}

          <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            {CATEGORY_ORDER.map(id => a.categories.find(c => c.id === id)).filter(Boolean).map(c => {
              const tone = scoreTone(c!.score);
              const active = cat === c!.id;
              return (
                <button key={c!.id} type="button" onClick={() => setCat(active ? null : c!.id)}
                  className={cn('text-left rounded-md border px-3 py-2 space-y-1.5 transition-colors cursor-pointer',
                    active ? 'border-primary bg-primary/5' : 'border-border bg-secondary/40 hover:border-primary/40')}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">{c!.label}</span>
                    <span className="text-sm font-semibold tabular-nums">{c!.score}</span>
                  </div>
                  <Bar pct={c!.score} tone={tone === 'good' ? 'primary' : tone === 'ok' ? 'foreground' : 'destructive'} />
                  <p className="text-[10px] text-muted-foreground tabular-nums">
                    {c!.fail ? <span className="text-destructive">{c!.fail} fail · </span> : null}{c!.warn} warn · {c!.pass} pass
                  </p>
                </button>
              );
            })}
          </div>

          <Section
            title={cat ? `${a.categories.find(c => c.id === cat)?.label} checks` : 'Checklist'}
            description="Sorted by severity and impact. Weights reflect how much each item affects the score."
            action={
              <Segmented value={filter} onChange={setFilter} options={[
                { value: 'issues', label: 'Issues' }, { value: 'all', label: 'All' }, { value: 'pass', label: 'Passed' },
              ]} />
            }
          >
            {cat && <Button variant="link" size="xs" className="px-0" onClick={() => setCat(null)}>Show all categories</Button>}
            {checks.length ? <div>{checks.map(c => <CheckRow key={c.id} c={c} />)}</div>
              : <p className="text-xs text-muted-foreground py-3">{filter === 'issues' ? 'No issues in this view — nice.' : 'Nothing to show.'}</p>}
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Key facts">
              <OutputRow label="Title" value={a.title.text} />
              <OutputRow label="Description" value={a.description.text} />
              <OutputRow label="Canonical" value={a.canonical.resolved || ''} />
              <OutputRow label="H1" value={a.headings.outline.find(h => h.level === 1)?.text || ''} />
              <OutputRow label="Robots" value={a.robots.directives.raw.join(', ') || 'index, follow (default)'} />
              <OutputRow label="Language" value={a.lang || ''} />
              <OutputRow label="Structured data" value={a.structuredData.types.join(', ')} />
            </Section>
            <Section title="Page statistics">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Internal links" value={a.links.internal} />
                <Stat label="External links" value={a.links.external} hint={`${a.links.nofollow} nofollow`} />
                <Stat label="Images" value={a.images.total} hint={`${a.images.missingAlt} without alt`} />
                <Stat label="Scripts" value={a.resources.scripts} hint={`${a.resources.inlineScripts} inline`} />
                <Stat label="Stylesheets" value={a.resources.stylesheets} hint={`${a.resources.inlineStyles} inline`} />
                <Stat label="Text / HTML" value={`${a.content.ratio}%`} />
              </div>
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Meta Tag Analyzer ─────────────────────────────

function SerpPreview({ url, title, description, favicon }: { url: string; title: string; description: string; favicon?: string }) {
  const t = truncateToWidth(title || 'Untitled page', SERP.titlePx, SERP.titleFont);
  const d = truncateToWidth(description || 'No meta description — Google will pick text from the page.', SERP.descPx, SERP.descFont);
  const crumb = serpBreadcrumb(url);
  const [iconOk, setIconOk] = useState(true);
  return (
    // Google's own colours — a deliberate exception to theme tokens for a realistic preview.
    <div className="rounded-lg border border-border bg-white p-4 text-left max-w-[652px]" style={{ fontFamily: 'Arial, sans-serif' }}>
      <div className="flex items-center gap-3 mb-1">
        <div className="size-7 rounded-full bg-[#f1f3f4] flex items-center justify-center overflow-hidden shrink-0">
          {favicon && iconOk ? <img src={favicon} alt="" className="size-[18px]" onError={() => setIconOk(false)} /> : <Globe className="size-4 text-[#5f6368]" />}
        </div>
        <div className="min-w-0 leading-tight">
          <div className="text-[14px] text-[#202124] truncate">{crumb.site}</div>
          <div className="text-[12px] text-[#4d5156] truncate">{crumb.crumbs}</div>
        </div>
      </div>
      <div className="text-[20px] leading-[1.3] text-[#1a0dab] hover:underline cursor-pointer break-words">{t.text}</div>
      <div className="text-[14px] leading-[1.58] text-[#4d5156] mt-1 break-words line-clamp-2">{d.text}</div>
    </div>
  );
}

function KeyValueTable({ rows, empty }: { rows: { k: string; v: string; status?: CheckStatus; note?: string }[]; empty?: string }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">{empty ?? 'None found.'}</p>;
  return (
    <Table head={['Tag', 'Value', '']}>
      {rows.map((r, i) => (
        <tr key={i}>
          <td className={cn(MONO, 'whitespace-nowrap')}>
            <span className="inline-flex items-center gap-1.5">{r.status && <StatusIcon status={r.status} className="size-3.5" />}{r.k}</span>
          </td>
          <td className="break-all min-w-[12rem]">{r.v || <span className="text-muted-foreground">{r.note || '—'}</span>}</td>
          <td className="w-8"><CopyButton value={r.v} /></td>
        </tr>
      ))}
    </Table>
  );
}

export function MetaTagAnalyzer() {
  const [url, setUrl] = useUrlState();
  const [ua, setUa] = useState('chrome-desktop');
  const [metaFilter, setMetaFilter] = useState('');
  const { data: a, loading, error, analyze } = useAnalysis();

  const titlePx = a ? textWidthPx(a.title.text, SERP.titleFont) : 0;
  const descPx = a ? textWidthPx(a.description.text, SERP.descFont) : 0;
  const issues = a ? a.checks.filter(c => (c.category === 'meta' || c.category === 'social') && (c.status === 'warn' || c.status === 'fail')) : [];
  const favicon = a?.favicons.find(f => /icon/.test(f.rel))?.href || (a?.faviconFallback?.status === 200 ? a.faviconFallback.url : undefined);

  return (
    <div className="space-y-4">
      <UrlForm url={url} onUrl={setUrl} loading={loading} onSubmit={() => analyze(url, ua, true)}>
        <NativeSelect value={ua} onChange={setUa} options={UA_OPTIONS} title="Fetch as" className="w-36 sm:w-44" />
      </UrlForm>
      {error && <ErrorBox message={error} />}
      {loading && !a && <Loading />}
      {!a && !loading && !error && <InfoBox>Fetches the page and lists every meta tag, with length checks, a Google result preview, headings outline, Open Graph / Twitter tags and structured data.</InfoBox>}
      {a && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <Section title="Google result preview" description="Approximate desktop rendering; truncation is estimated from pixel widths (title ≈ 580px, description ≈ 920px).">
            <SerpPreview url={a.finalUrl} title={a.title.text} description={a.description.text} favicon={favicon} />
          </Section>

          {issues.length > 0 && (
            <Section title={`${issues.length} issue${issues.length === 1 ? '' : 's'}`}>
              <div>{issues.map(c => <CheckRow key={c.id} c={c} />)}</div>
            </Section>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Title" action={<CopyButton value={a.title.text} />}>
              <p className="text-sm break-words">{a.title.text || <span className="text-destructive">Missing</span>}</p>
              <LengthMeter len={a.title.length} min={30} max={60} hardMax={90} px={titlePx} pxMax={SERP.titlePx} />
              {a.title.count > 1 && <p className="text-xs text-destructive">{a.title.count} title tags found.</p>}
            </Section>
            <Section title="Meta description" action={<CopyButton value={a.description.text} />}>
              <p className="text-sm break-words">{a.description.text || <span className="text-destructive">Missing</span>}</p>
              <LengthMeter len={a.description.length} min={70} max={160} hardMax={220} px={descPx} pxMax={SERP.descPx} />
              {a.description.count > 1 && <p className="text-xs text-destructive">{a.description.count} description tags found.</p>}
            </Section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Indexing & technical">
              <OutputRow label="Final URL" value={a.finalUrl} />
              <OutputRow label="Canonical" value={a.canonical.resolved ? `${a.canonical.resolved}${a.canonical.selfReferential ? '  (self)' : '  (points elsewhere)'}` : ''} />
              <OutputRow label="Robots meta" value={a.robots.meta.map(m => `${m.name}: ${m.content}`).join(' | ')} />
              <OutputRow label="X-Robots-Tag" value={a.robots.xRobotsTag.join(' | ')} />
              <OutputRow label="Effective" value={a.robots.directives.raw.join(', ') || 'index, follow'} />
              <OutputRow label="Viewport" value={a.viewport || ''} />
              <OutputRow label="Charset" value={`${a.charset.value} (${a.charset.source})`} />
              <OutputRow label="Language" value={a.lang || ''} />
              <OutputRow label="Favicon" value={a.favicons.map(f => f.href).join(' ') || (a.faviconFallback ? `${a.faviconFallback.url} → ${a.faviconFallback.status ?? a.faviconFallback.error}` : '')} />
              {a.metaRefresh && <OutputRow label="Meta refresh" value={a.metaRefresh} />}
            </Section>
            <Section title="Headings" description={`H1–H6: ${a.headings.counts.join(' / ')}`}>
              {a.headings.outline.length ? (
                <div className="max-h-72 overflow-y-auto space-y-0.5 pr-1">
                  {a.headings.outline.map((h, i) => (
                    <div key={i} className="flex items-baseline gap-2 text-xs min-w-0" style={{ paddingLeft: (h.level - 1) * 14 }}>
                      <Badge variant={h.level === 1 ? 'default' : 'secondary'} className="shrink-0 px-1.5 text-[10px]">H{h.level}</Badge>
                      <span className="break-words min-w-0">{h.text || <span className="text-muted-foreground italic">(empty)</span>}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-xs text-muted-foreground">No headings.</p>}
              {a.headings.skipped.length > 0 && <p className="text-[11px] text-muted-foreground">Skipped levels: {a.headings.skipped.join('; ')}</p>}
            </Section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Open Graph">
              <KeyValueTable rows={['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name', 'og:locale']
                .map(k => ({ k, v: a.og[k] || '', status: (a.og[k] ? 'pass' : ['og:site_name', 'og:locale'].includes(k) ? 'info' : 'warn') as CheckStatus, note: 'missing' }))
                .concat(Object.entries(a.og).filter(([k]) => !['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name', 'og:locale'].includes(k)).map(([k, v]) => ({ k, v, status: 'pass' as CheckStatus, note: '' })))} />
            </Section>
            <Section title="Twitter / X">
              <KeyValueTable rows={['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:site', 'twitter:creator']
                .map(k => ({ k, v: a.twitter[k] || '', status: (a.twitter[k] ? 'pass' : k === 'twitter:card' ? 'warn' : 'info') as CheckStatus, note: k === 'twitter:card' ? 'missing' : 'falls back to og:*' }))} />
            </Section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Structured data" description={a.structuredData.types.length ? a.structuredData.types.join(', ') : 'None found'}>
              {a.structuredData.jsonLd.map((j, i) => (
                <div key={i} className="rounded-md border border-border p-2 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium">JSON-LD #{i + 1}</span>
                    {j.error ? <Badge variant="destructive">Parse error</Badge> : j.types.map(t => <Badge key={t} variant="secondary">{t}</Badge>)}
                    <span className="ml-auto"><CopyButton value={j.snippet} /></span>
                  </div>
                  {j.error && <p className="text-[11px] text-destructive">{j.error}</p>}
                  <pre className={cn(MONO, 'max-h-40 overflow-auto bg-secondary/40 rounded p-2 whitespace-pre-wrap break-all')}>{j.snippet}</pre>
                </div>
              ))}
              {(a.structuredData.microdata.length > 0 || a.structuredData.rdfa.length > 0) && (
                <p className="text-xs">Microdata/RDFa: {[...a.structuredData.microdata, ...a.structuredData.rdfa].join(', ')}</p>
              )}
              {!a.structuredData.types.length && !a.structuredData.jsonLd.length && <p className="text-xs text-muted-foreground">Add schema.org JSON-LD to be eligible for rich results.</p>}
            </Section>
            <Section title="hreflang" description={a.hreflang.length ? `${a.hreflang.length} alternates` : 'No language alternates declared'}>
              {a.hreflang.length > 0 && (
                <Table head={['Lang', 'URL']}>
                  {a.hreflang.map((h, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><StatusIcon status={h.valid ? 'pass' : 'fail'} className="size-3.5" /><code className={MONO}>{h.lang}</code></span></td>
                      <td className="break-all">{h.href}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
          </div>

          <Section title={`All meta tags (${a.meta.length})`} action={<Input className="h-7 w-40 text-xs" placeholder="Filter…" value={metaFilter} onChange={e => setMetaFilter(e.target.value)} />}>
            <Table head={['Attribute', 'Key', 'Content', '']}>
              {a.meta.filter(m => !metaFilter || `${m.key} ${m.value}`.toLowerCase().includes(metaFilter.toLowerCase())).map((m, i) => (
                <tr key={i}>
                  <td className="text-muted-foreground whitespace-nowrap">{m.attr}</td>
                  <td className={cn(MONO, 'whitespace-nowrap')}>{m.key}</td>
                  <td className="break-all min-w-[12rem]">{m.value}</td>
                  <td className="w-8"><CopyButton value={m.value} /></td>
                </tr>
              ))}
            </Table>
          </Section>

          <Section title="Response headers">
            {Object.entries(a.headers).map(([k, v]) => <OutputRow key={k} label={k} value={v} />)}
          </Section>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Open Graph Preview ─────────────────────────────

interface CardData { title: string; description: string; image: string | null; site: string; host: string; url: string; probe: ImageProbe | null; twitterCard: string; themeColor?: string }

function PreviewImage({ src, className, style }: { src: string | null; className?: string; style?: React.CSSProperties }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return <div className={cn('flex items-center justify-center bg-[#e4e6eb] text-[#8a8d91]', className)} style={style}><Globe className="size-6" /></div>;
  }
  return <img src={src} alt="" referrerPolicy="no-referrer" className={cn('object-cover', className)} style={style} onError={() => setFailed(true)} />;
}

function FacebookCard({ d }: { d: CardData }) {
  return (
    <div className="rounded-md overflow-hidden border border-[#dadde1] bg-white max-w-[500px]" style={{ fontFamily: 'Helvetica, Arial, sans-serif' }}>
      {d.image && <PreviewImage src={d.image} className="w-full" style={{ aspectRatio: '1.91 / 1' }} />}
      <div className="bg-[#f0f2f5] px-3 py-2.5 border-t border-[#dadde1]">
        <div className="text-[12px] uppercase text-[#65676b] truncate">{d.host}</div>
        <div className="text-[16px] font-semibold text-[#050505] leading-5 line-clamp-2 mt-0.5">{d.title}</div>
        <div className="text-[14px] text-[#65676b] leading-5 line-clamp-1">{d.description}</div>
      </div>
    </div>
  );
}

function XCard({ d, large }: { d: CardData; large: boolean }) {
  if (large) {
    return (
      <div className="max-w-[506px]" style={{ fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif' }}>
        <div className="relative rounded-2xl overflow-hidden border border-[#cfd9de]">
          <PreviewImage src={d.image} className="w-full" style={{ aspectRatio: '2 / 1' }} />
          <span className="absolute left-3 bottom-3 rounded bg-black/75 px-1.5 py-0.5 text-[13px] text-white max-w-[80%] truncate">{d.title}</span>
        </div>
        <div className="text-[13px] text-[#536471] mt-1">From {d.host}</div>
      </div>
    );
  }
  return (
    <div className="flex rounded-2xl overflow-hidden border border-[#cfd9de] bg-white max-w-[506px]" style={{ fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif' }}>
      <PreviewImage src={d.image} className="w-[130px] shrink-0 border-r border-[#cfd9de]" style={{ aspectRatio: '1 / 1' }} />
      <div className="min-w-0 px-3 py-2 flex flex-col justify-center gap-0.5">
        <div className="text-[15px] text-[#536471] truncate">{d.host}</div>
        <div className="text-[15px] text-[#0f1419] truncate">{d.title}</div>
        <div className="text-[15px] text-[#536471] line-clamp-2 leading-5">{d.description}</div>
      </div>
    </div>
  );
}

function LinkedInCard({ d }: { d: CardData }) {
  return (
    <div className="rounded-lg overflow-hidden border border-[#e0e0e0] bg-white max-w-[552px]" style={{ fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif' }}>
      {d.image && <PreviewImage src={d.image} className="w-full" style={{ aspectRatio: '1.91 / 1' }} />}
      <div className="px-3 py-2 bg-[#eef3f8]">
        <div className="text-[14px] font-semibold text-[#000000e6] line-clamp-2 leading-5">{d.title}</div>
        <div className="text-[12px] text-[#00000099] mt-0.5 truncate">{d.host}</div>
      </div>
    </div>
  );
}

function SlackCard({ d }: { d: CardData }) {
  return (
    <div className="flex gap-3 bg-white max-w-[520px] p-1" style={{ fontFamily: 'Lato, "Segoe UI", sans-serif' }}>
      <div className="w-1 rounded-full bg-[#dddddd] shrink-0" />
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-1.5 text-[15px] font-bold text-[#1d1c1d]">{d.site}</div>
        <div className="text-[15px] font-bold text-[#1264a3] hover:underline leading-5">{d.title}</div>
        <div className="text-[15px] text-[#1d1c1d] leading-[22px] line-clamp-3">{d.description}</div>
        {d.image && <PreviewImage src={d.image} className="rounded-lg max-w-[360px] w-full mt-1" style={{ aspectRatio: '1.91 / 1' }} />}
      </div>
    </div>
  );
}

function DiscordCard({ d }: { d: CardData }) {
  return (
    <div className="bg-[#313338] p-3 rounded-md max-w-[520px]" style={{ fontFamily: '"gg sans", "Noto Sans", "Helvetica Neue", sans-serif' }}>
      <div className="rounded border-l-4 bg-[#2b2d31] p-3 pr-4 space-y-1.5 max-w-[432px]" style={{ borderLeftColor: d.themeColor || '#1e1f22' }}>
        <div className="text-[12px] text-[#dbdee1] truncate">{d.site}</div>
        <div className="text-[16px] font-semibold text-[#00a8fc] hover:underline leading-5">{d.title}</div>
        <div className="text-[14px] text-[#dbdee1] leading-[18px] line-clamp-4">{d.description}</div>
        {d.image && <PreviewImage src={d.image} className="rounded w-full mt-2" style={{ aspectRatio: '1.91 / 1' }} />}
      </div>
    </div>
  );
}

function WhatsAppCard({ d }: { d: CardData }) {
  return (
    <div className="bg-[#efeae2] p-3 rounded-md max-w-[420px]" style={{ fontFamily: 'Helvetica, Arial, sans-serif' }}>
      <div className="ml-auto max-w-[330px] rounded-lg bg-[#d9fdd3] p-1 shadow-sm">
        <div className="rounded-md bg-[#d1f4cc] overflow-hidden">
          {d.image && <PreviewImage src={d.image} className="w-full" style={{ aspectRatio: '1.91 / 1' }} />}
          <div className="px-2.5 py-1.5">
            <div className="text-[13.5px] font-semibold text-[#111b21] line-clamp-2">{d.title}</div>
            <div className="text-[12.5px] text-[#667781] line-clamp-2">{d.description}</div>
            <div className="text-[12px] text-[#667781] mt-0.5">{d.host}</div>
          </div>
        </div>
        <div className="px-1.5 pt-1 text-[13.5px] text-[#027eb5] break-all">{d.url}</div>
        <div className="text-right text-[11px] text-[#667781] px-1.5">12:00 ✓✓</div>
      </div>
    </div>
  );
}

function IMessageCard({ d }: { d: CardData }) {
  return (
    <div className="bg-white p-3 rounded-md max-w-[360px]" style={{ fontFamily: '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif' }}>
      <div className="ml-auto w-[260px] rounded-[18px] overflow-hidden bg-[#e9e9eb]">
        {d.image && <PreviewImage src={d.image} className="w-full" style={{ aspectRatio: '1.91 / 1' }} />}
        <div className="px-3 py-2">
          <div className="text-[14px] font-semibold text-black leading-[18px] line-clamp-2">{d.title}</div>
          <div className="text-[13px] text-[#8e8e93] truncate">{d.host}</div>
        </div>
      </div>
    </div>
  );
}

const PREVIEWS: { id: Platform; label: string; render: (d: CardData) => React.ReactNode; icons?: React.ReactNode }[] = [
  { id: 'facebook', label: 'Facebook', render: d => <FacebookCard d={d} /> },
  { id: 'x-large', label: 'X / Twitter — large image', render: d => <XCard d={d} large /> },
  { id: 'x-summary', label: 'X / Twitter — summary', render: d => <XCard d={d} large={false} /> },
  { id: 'linkedin', label: 'LinkedIn', render: d => <LinkedInCard d={d} /> },
  { id: 'slack', label: 'Slack', render: d => <SlackCard d={d} /> },
  { id: 'discord', label: 'Discord', render: d => <DiscordCard d={d} /> },
  { id: 'whatsapp', label: 'WhatsApp', render: d => <WhatsAppCard d={d} /> },
  { id: 'imessage', label: 'iMessage', render: d => <IMessageCard d={d} /> },
];

function suggestedTags(a: Analysis, d: CardData) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const lines = [
    `<meta property="og:type" content="${esc(a.og['og:type'] || 'website')}">`,
    `<meta property="og:url" content="${esc(a.og['og:url'] || a.canonical.resolved || a.finalUrl)}">`,
    `<meta property="og:title" content="${esc(d.title)}">`,
    `<meta property="og:description" content="${esc(d.description)}">`,
    `<meta property="og:image" content="${esc(d.image || 'https://example.com/og-image-1200x630.jpg')}">`,
  ];
  if (d.probe?.width && d.probe?.height) lines.push(`<meta property="og:image:width" content="${d.probe.width}">`, `<meta property="og:image:height" content="${d.probe.height}">`);
  lines.push(`<meta property="og:site_name" content="${esc(d.site)}">`);
  lines.push(`<meta name="twitter:card" content="${esc(a.twitter['twitter:card'] || 'summary_large_image')}">`);
  if (a.twitter['twitter:site']) lines.push(`<meta name="twitter:site" content="${esc(a.twitter['twitter:site'])}">`);
  return lines.join('\n');
}

export function OpenGraphPreview() {
  const [url, setUrl] = useUrlState();
  const [only, setOnly] = useState<'all' | Platform>('all');
  const { data: a, loading, error, analyze } = useAnalysis();

  const d: CardData | null = useMemo(() => {
    if (!a) return null;
    const host = siteName(a.finalUrl);
    const theme = a.meta.find(m => m.key.toLowerCase() === 'theme-color')?.value;
    return {
      title: a.og['og:title'] || a.twitter['twitter:title'] || a.title.text || a.finalUrl,
      description: a.og['og:description'] || a.twitter['twitter:description'] || a.description.text || '',
      image: a.ogImages[0] || a.twitterImage?.url || a.ogImage?.url || null,
      site: a.og['og:site_name'] || host,
      host, url: a.finalUrl, probe: a.ogImage, twitterCard: a.twitter['twitter:card'] || '', themeColor: theme,
    };
  }, [a]);

  const xLarge = d ? (d.twitterCard ? d.twitterCard === 'summary_large_image' : !!d.image) : true;
  const visible = PREVIEWS.filter(p => (only === 'all' || p.id === only) && (only !== 'all' || p.id !== (xLarge ? 'x-summary' : 'x-large')));

  return (
    <div className="space-y-4">
      <UrlForm url={url} onUrl={setUrl} loading={loading} onSubmit={() => analyze(url, 'chrome-desktop', true)} button="Preview" />
      {error && <ErrorBox message={error} />}
      {loading && !a && <Loading />}
      {!a && !loading && !error && <InfoBox>See how a link unfurls on Facebook, X, LinkedIn, Slack, Discord, WhatsApp and iMessage. The server reads the page's Open Graph / Twitter tags and inspects the image size and dimensions.</InfoBox>}
      {a && d && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            <Stat label="Title source" value={a.og['og:title'] ? 'og:title' : a.twitter['twitter:title'] ? 'twitter:title' : '<title>'} />
            <Stat label="Image" value={d.probe?.width ? `${d.probe.width}×${d.probe.height}` : d.image ? 'unknown size' : 'none'} hint={d.probe?.width && d.probe.height ? `ratio ${(d.probe.width / d.probe.height).toFixed(2)}:1` : undefined} />
            <Stat label="Image weight" value={d.probe?.bytes ? formatBytes(d.probe.bytes) : '—'} hint={d.probe?.contentType || d.probe?.error} />
            <Stat label="X card type" value={d.twitterCard || '(none)'} hint={!d.twitterCard ? `shown as ${xLarge ? 'large' : 'summary'}` : undefined} />
          </div>
          {d.probe?.error && <ErrorBox message={`og:image could not be loaded by the server: ${d.probe.error}`} />}
          {d.probe?.status && d.probe.status >= 400 && <ErrorBox message={`og:image returns HTTP ${d.probe.status} — platforms will show no image.`} />}

          <NativeSelect value={only} onChange={v => setOnly(v as 'all' | Platform)} options={[{ value: 'all', label: 'All platforms' }, ...PREVIEWS.map(p => ({ value: p.id, label: p.label }))]} className="w-56" />

          <div className="grid gap-4 xl:grid-cols-2">
            {visible.map(p => {
              const issues = imageIssues(p.id, d.image ? (d.probe && !d.probe.error ? d.probe : {}) : null);
              return (
                <Section key={p.id} title={p.label} description={`Recommended image ${IMAGE_SPECS[p.id].recW}×${IMAGE_SPECS[p.id].recH}`}>
                  <div className="rounded-md bg-secondary/40 p-3 overflow-hidden">{p.render(d)}</div>
                  {issues.length ? issues.map((m, i) => <p key={i} className="flex gap-1.5 text-[11px] text-muted-foreground"><AlertTriangle className="size-3.5 shrink-0" />{m}</p>)
                    : <p className="flex gap-1.5 text-[11px] text-primary"><CheckCircle2 className="size-3.5 shrink-0" />Image meets {IMAGE_SPECS[p.id].label}'s requirements.</p>}
                </Section>
              );
            })}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Detected tags">
              <KeyValueTable rows={[
                ...Object.entries(a.og).map(([k, v]) => ({ k, v, status: 'pass' as CheckStatus })),
                ...Object.entries(a.twitter).map(([k, v]) => ({ k, v, status: 'pass' as CheckStatus })),
              ]} empty="No Open Graph or Twitter tags — platforms fall back to <title> and the meta description." />
              {a.checks.filter(c => c.category === 'social' && c.status !== 'pass').map(c => <CheckRow key={c.id} c={c} />)}
            </Section>
            <Section title="Suggested tags" description="Built from the current values; fill in anything that's a placeholder." action={<CopyButton value={suggestedTags(a, d)} label="Copy" />}>
              <pre className={cn(MONO, 'bg-secondary/40 rounded-md p-2.5 overflow-x-auto whitespace-pre-wrap break-all')}>{suggestedTags(a, d)}</pre>
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Indexability Checker ─────────────────────────────

interface IndexItem { id: string; label: string; status: CheckStatus; message: string; detail?: string }
interface IndexResult {
  url: string; crawler: string; title: string; finalUrl: string | null; status: number | null; chain: Hop[];
  verdict: { indexable: boolean; status: 'indexable' | 'warning' | 'blocked'; summary: string; reasons: string[]; warnings: string[] };
  items: IndexItem[];
  robots: {
    url: string; status: number | null; mode: string; note: string; error?: string; text: string; matchedAgent: string | null;
    matchedRule: { type: string; path: string; line: number } | null; allowed: boolean; groupRules: { type: string; path: string; line: number }[];
    crawlDelay?: number; sitemaps: string[]; invalid: { line: number; text: string }[]; finalAllowed: boolean | null;
  };
  directives: { noindex: boolean; nofollow: boolean; raw: string[]; unavailableAfter?: string } | null;
  directiveSources: { source: string; value: string; applies: boolean }[];
  canonical: string | null;
  sitemaps: { sitemaps: { url: string; source: string; status: number | null; kind?: string; urlCount: number; error?: string; containsTarget?: string; parent?: string }[]; listed: { sitemap: string; match: string } | null; found: number };
}

function RobotsTxtView({ text, highlight }: { text: string; highlight?: number }) {
  const lines = text.split(/\r\n|\r|\n/);
  useEffect(() => {
    if (highlight) document.getElementById(`robots-line-${highlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight, text]);
  return (
    <div className={cn(MONO, 'max-h-72 overflow-auto rounded-md border border-border bg-secondary/30 py-1')}>
      {lines.map((l, i) => (
        <div key={i} id={`robots-line-${i + 1}`} className={cn('flex gap-3 px-2', highlight === i + 1 && 'bg-primary/15')}>
          <span className="w-8 shrink-0 text-right text-muted-foreground select-none tabular-nums">{i + 1}</span>
          <span className="whitespace-pre-wrap break-all">{l || ' '}</span>
        </div>
      ))}
    </div>
  );
}

export function IndexabilityChecker() {
  const [url, setUrl] = useUrlState();
  const [bot, setBot] = useState('googlebot');
  const { data: r, loading, error, run } = useRequest<IndexResult>();
  const submit = () => run(() => { lastUrl = normalizeInput(url); return toolsApi.post<IndexResult>('/seo/indexability', { url: normalizeInput(url), userAgent: bot }); });

  return (
    <div className="space-y-4">
      <UrlForm url={url} onUrl={setUrl} loading={loading} onSubmit={submit} button="Check">
        <NativeSelect value={bot} onChange={setBot} title="Crawler" className="w-32 sm:w-40" options={[
          { value: 'googlebot', label: 'Googlebot' }, { value: 'bingbot', label: 'Bingbot' }, { value: '*', label: 'Any crawler (*)' },
        ]} />
      </UrlForm>
      {error && <ErrorBox message={error} />}
      {loading && !r && <Loading label="Checking robots.txt, the page and sitemaps…" />}
      {!r && !loading && !error && <InfoBox>Checks everything that decides whether a search engine can index a URL: robots.txt (with Google's matching rules), meta robots and X-Robots-Tag (including bot-specific ones), the HTTP status and redirects, the canonical, and whether the URL is in an XML sitemap.</InfoBox>}
      {r && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <VerdictBanner
            status={r.verdict.status === 'blocked' ? 'fail' : r.verdict.status === 'warning' ? 'warn' : 'pass'}
            title={r.verdict.status === 'blocked' ? 'Not indexable' : r.verdict.status === 'warning' ? 'Indexable, with warnings' : 'Indexable'}
            summary={r.verdict.summary}
          >
            <p className="text-[11px] text-muted-foreground break-all">{r.url}{r.title ? ` — "${r.title}"` : ''}</p>
          </VerdictBanner>

          <Section title="Checks">
            <div>{r.items.map((c, i) => <CheckRow key={i} c={c} />)}</div>
          </Section>

          {r.chain.length > 1 && <Section title="Redirects"><RedirectChain chain={r.chain} /></Section>}

          <div className="grid gap-4 lg:grid-cols-2">
            <Section
              title="robots.txt"
              description={<>{r.robots.status ? `HTTP ${r.robots.status}` : r.robots.error} · {r.robots.note}</>}
              action={r.robots.text ? <CopyButton value={r.robots.text} /> : undefined}
            >
              <div className="flex flex-wrap gap-1.5 items-center text-xs">
                <StatusBadge status={r.robots.allowed ? 'pass' : 'fail'}>{r.robots.allowed ? 'Allowed' : 'Disallowed'}</StatusBadge>
                <span className="text-muted-foreground">group:</span><code className={MONO}>{r.robots.matchedAgent ?? '(none)'}</code>
                {r.robots.matchedRule && <><span className="text-muted-foreground">rule:</span><code className={MONO}>{r.robots.matchedRule.type === 'allow' ? 'Allow' : 'Disallow'}: {r.robots.matchedRule.path}</code><span className="text-muted-foreground">(line {r.robots.matchedRule.line})</span></>}
                {r.robots.crawlDelay !== undefined && <Badge variant="secondary">crawl-delay {r.robots.crawlDelay}</Badge>}
              </div>
              {r.robots.text ? <RobotsTxtView text={r.robots.text} highlight={r.robots.matchedRule?.line} /> : <p className="text-xs text-muted-foreground">No robots.txt content.</p>}
              {r.robots.invalid.length > 0 && <p className="text-[11px] text-muted-foreground">Unrecognised lines: {r.robots.invalid.map(x => x.line).join(', ')}</p>}
            </Section>
            <div className="space-y-4 min-w-0">
              <Section title="Robots directives" description={r.directives ? `Effective: ${r.directives.raw.join(', ') || 'index, follow (default)'}` : undefined}>
                {r.directiveSources.length ? (
                  <Table head={['Source', 'Value', 'Applies']}>
                    {r.directiveSources.map((s, i) => (
                      <tr key={i}>
                        <td className={cn(MONO, 'whitespace-nowrap')}>{s.source}</td>
                        <td className="break-all">{s.value}</td>
                        <td>{s.applies ? <Badge>yes</Badge> : <Badge variant="secondary">other bot</Badge>}</td>
                      </tr>
                    ))}
                  </Table>
                ) : <p className="text-xs text-muted-foreground">No robots meta tags or X-Robots-Tag headers.</p>}
                <OutputRow label="Canonical" value={r.canonical || ''} />
              </Section>
              <Section title="XML sitemaps" description={r.sitemaps.listed ? `Listed in ${r.sitemaps.listed.sitemap}` : 'URL not found in any sitemap checked'}>
                <div className="space-y-1">
                  {r.sitemaps.sitemaps.map((s, i) => (
                    <div key={i} className={cn('flex items-center gap-2 text-xs min-w-0', s.parent && 'pl-4')}>
                      <StatusIcon status={s.error ? (s.source === 'default' ? 'info' : 'fail') : s.containsTarget ? 'pass' : 'info'} className="size-3.5" />
                      <span className={cn(MONO, 'truncate flex-1 min-w-0')} title={s.url}>{s.url}</span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">{s.error ? s.error : `${s.kind === 'index' ? 'index · ' : ''}${s.urlCount.toLocaleString()} URLs`}</span>
                      {s.containsTarget && <Badge variant={s.containsTarget === 'exact' ? 'default' : 'outline'}>{s.containsTarget === 'exact' ? 'listed' : 'variant'}</Badge>}
                    </div>
                  ))}
                </div>
              </Section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Canonical Checker ─────────────────────────────

interface CanonicalResult {
  url: string; finalUrl: string; status: number; redirectChain: Hop[];
  canonical: string | null; tags: { href: string; resolved: string | null; inHead: boolean }[]; header: string | null; selfReferential: boolean | null;
  items: IndexItem[];
  chain: { url: string; status: number | null; finalUrl?: string; redirects: number; canonical: string | null; noindex?: boolean; error?: string }[];
  loop: boolean;
  variants: { url: string; finalUrl: string | null; status: number | null; hops: { status: number; url: string }[]; error?: string }[];
  verdict: { status: 'pass' | 'warn' | 'fail'; summary: string };
}

export function CanonicalChecker() {
  const [url, setUrl] = useUrlState();
  const { data: r, loading, error, run } = useRequest<CanonicalResult>();
  const submit = () => run(() => { lastUrl = normalizeInput(url); return toolsApi.post<CanonicalResult>('/seo/canonical', { url: normalizeInput(url) }); });
  const finals = r ? new Set(r.variants.filter(v => v.finalUrl).map(v => v.finalUrl)) : new Set();

  return (
    <div className="space-y-4">
      <UrlForm url={url} onUrl={setUrl} loading={loading} onSubmit={submit} button="Check" />
      {error && <ErrorBox message={error} />}
      {loading && !r && <Loading label="Checking canonical tags, targets and URL variants…" />}
      {!r && !loading && !error && <InfoBox>Validates the canonical tag / Link header, follows the canonical target (redirects, status, noindex, chains and loops) and fetches the http/https and www/non-www (and trailing-slash) variants to see where each ends up.</InfoBox>}
      {r && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <VerdictBanner status={r.verdict.status} title={r.canonical ? (r.selfReferential ? 'Self-referencing canonical' : 'Canonicalised to another URL') : 'No canonical declared'} summary={r.verdict.summary}>
            {r.canonical && <p className={cn(MONO, 'break-all')}>{r.canonical}</p>}
          </VerdictBanner>
          <Section title="Checks"><div>{r.items.map((c, i) => <CheckRow key={i} c={c} />)}</div></Section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Canonical declarations">
              {r.tags.length || r.header ? (
                <Table head={['Source', 'href', 'Resolved']}>
                  {r.tags.map((t, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap">{t.inHead ? '<link> in head' : <span className="text-destructive">{'<link> in body'}</span>}</td>
                      <td className={cn(MONO, 'break-all')}>{t.href || '(empty)'}</td>
                      <td className="break-all">{t.resolved}</td>
                    </tr>
                  ))}
                  {r.header && <tr><td className="whitespace-nowrap">Link header</td><td className={cn(MONO, 'break-all')}>{r.header}</td><td className="break-all">{r.header}</td></tr>}
                </Table>
              ) : <p className="text-xs text-muted-foreground">None.</p>}
              {r.redirectChain.length > 1 && <><FieldLabel>Requested URL redirects</FieldLabel><RedirectChain chain={r.redirectChain} /></>}
            </Section>
            <Section title="Canonical target chain" description={r.chain.length ? undefined : 'Canonical is self-referencing (or missing) — nothing to follow.'}>
              {r.chain.map((c, i) => (
                <div key={i} className="rounded-md border border-border p-2 space-y-1 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant={c.error || (c.status ?? 0) >= 400 ? 'destructive' : c.redirects ? 'outline' : 'default'}>{c.error ? 'error' : c.status}</Badge>
                    <span className={cn(MONO, 'truncate')} title={c.url}>{c.url}</span>
                  </div>
                  {c.redirects > 0 && <p className="text-muted-foreground">redirects {c.redirects}× → {c.finalUrl}</p>}
                  {c.noindex && <p className="text-destructive">noindex</p>}
                  {c.error && <p className="text-destructive">{c.error}</p>}
                  <p className="text-muted-foreground break-all">its canonical: {c.canonical || '(none)'}</p>
                </div>
              ))}
              {r.loop && <ErrorBox message="Canonical loop detected." />}
            </Section>
          </div>
          <Section title="URL variants" description={finals.size === 1 ? 'All variants resolve to the same URL.' : `Variants resolve to ${finals.size} different URLs.`}>
            <Table head={['Variant', 'Hops', 'Ends at']}>
              {r.variants.map((v, i) => (
                <tr key={i}>
                  <td className={cn(MONO, 'break-all')}>{v.url}</td>
                  <td className="whitespace-nowrap">
                    {v.error && !v.hops.length ? <span className="text-destructive">{v.error}</span> : (
                      <span className="inline-flex flex-wrap gap-1">{v.hops.map((h, j) => <Badge key={j} variant={h.status >= 400 ? 'destructive' : h.status >= 300 ? 'outline' : 'default'} className="tabular-nums">{h.status}</Badge>)}</span>
                    )}
                  </td>
                  <td className="break-all">
                    {v.finalUrl ? <span className={cn(v.finalUrl === (r.canonical || r.finalUrl) ? 'text-primary' : '')}>{v.finalUrl}</span> : '—'}
                    {v.error && v.hops.length > 0 && <span className="block text-destructive">{v.error}</span>}
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Page Speed Estimator ─────────────────────────────

type ResType = 'html' | 'css' | 'js' | 'image' | 'font' | 'other';
interface WeightResource {
  url: string; type: ResType; status: number | null; bytes: number; approximate?: boolean; encoding: string; cacheControl: string;
  contentType: string; thirdParty: boolean; renderBlocking: boolean; ms: number; method: string; error?: string; initiator: string;
}
interface WeightResult {
  url: string; finalUrl: string; status: number; ttfbMs: number;
  totals: { bytes: number; requests: number; failed: number; origins: number; skipped: number };
  byType: { type: ResType; count: number; bytes: number }[];
  thirdParty: { count: number; bytes: number; share: number; hosts: { host: string; count: number; bytes: number }[] };
  largest: WeightResource[]; renderBlocking: WeightResource[]; resources: WeightResource[]; iframes: string[];
  model: LoadModel;
  estimates: { id: string; label: string; kbps: number; rttMs: number; fullMs: number; renderMs: number }[];
  suggestions: { severity: 'high' | 'medium' | 'low'; title: string; detail: string; savingsBytes?: number }[];
}

const TYPE_META: Record<ResType, { label: string; cls: string }> = {
  html: { label: 'HTML', cls: 'bg-primary' },
  css: { label: 'CSS', cls: 'bg-primary/65' },
  js: { label: 'JavaScript', cls: 'bg-foreground/70' },
  image: { label: 'Images', cls: 'bg-primary/35' },
  font: { label: 'Fonts', cls: 'bg-foreground/35' },
  other: { label: 'Other', cls: 'bg-muted-foreground/30' },
};

const shortUrl = (u: string) => { try { const x = new URL(u); return (x.pathname.split('/').filter(Boolean).pop() || x.hostname) + x.search.slice(0, 20); } catch { return u; } };

export function PageSpeedEstimator() {
  const [url, setUrl] = useUrlState();
  const [ua, setUa] = useState('chrome-desktop');
  const [kbps, setKbps] = useState(5000);
  const [rtt, setRtt] = useState(100);
  const [showAll, setShowAll] = useState(false);
  const { data: r, loading, error, run } = useRequest<WeightResult>();
  const submit = () => run(() => { lastUrl = normalizeInput(url); return toolsApi.post<WeightResult>('/seo/page-weight', { url: normalizeInput(url), userAgent: ua }); });

  const custom = r ? estimateLoad({ kbps, rttMs: rtt }, r.model) : null;
  const maxFull = r ? Math.max(...r.estimates.map(e => e.fullMs), custom?.fullMs ?? 0) : 1;

  const exportCsv = () => {
    if (!r) return;
    downloadBlob(toCsv([
      ['url', 'type', 'status', 'bytes', 'encoding', 'cache-control', 'third-party', 'render-blocking', 'initiator', 'error'],
      ...r.resources.map(x => [x.url, x.type, x.status, x.bytes, x.encoding, x.cacheControl, x.thirdParty, x.renderBlocking, x.initiator, x.error || '']),
    ]), `page-weight-${fileSlug(r.finalUrl)}.csv`, 'text/csv');
  };

  return (
    <div className="space-y-4">
      <UrlForm url={url} onUrl={setUrl} loading={loading} onSubmit={submit} button="Measure">
        <NativeSelect value={ua} onChange={setUa} options={UA_OPTIONS.slice(0, 2)} className="w-36" title="Fetch as" />
      </UrlForm>
      {error && <ErrorBox message={error} />}
      {loading && !r && <Loading label="Downloading the page and up to 100 resources…" />}
      {!r && !loading && !error && <InfoBox>Downloads the HTML and every script, stylesheet, image (largest srcset candidate) and web font it references (up to 100), measures the bytes actually transferred, and estimates load times from 2G to fibre. Resources injected by JavaScript at runtime are not seen.</InfoBox>}
      {r && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Total transferred" value={formatBytes(r.totals.bytes)} />
            <Stat label="Requests" value={r.totals.requests} hint={r.totals.failed ? `${r.totals.failed} failed` : r.totals.skipped ? `${r.totals.skipped} not checked` : undefined} />
            <Stat label="Origins" value={r.totals.origins} />
            <Stat label="Third-party" value={`${Math.round(r.thirdParty.share * 100)}%`} hint={`${formatBytes(r.thirdParty.bytes)} · ${r.thirdParty.count} req`} />
            <Stat label="TTFB" value={formatMs(r.ttfbMs)} />
            <Stat label="Render-blocking" value={r.renderBlocking.length} hint={formatBytes(r.renderBlocking.reduce((a, x) => a + x.bytes, 0))} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Weight by type">
              <div className="flex h-3 rounded-full overflow-hidden bg-secondary">
                {r.byType.filter(t => t.bytes > 0).map(t => (
                  <div key={t.type} className={TYPE_META[t.type].cls} style={{ width: `${(t.bytes / Math.max(1, r.totals.bytes)) * 100}%` }} title={`${TYPE_META[t.type].label}: ${formatBytes(t.bytes)}`} />
                ))}
              </div>
              <Table head={['Type', 'Requests', 'Size', 'Share']}>
                {r.byType.map(t => (
                  <tr key={t.type}>
                    <td><span className="inline-flex items-center gap-2"><span className={cn('size-2.5 rounded-sm', TYPE_META[t.type].cls)} />{TYPE_META[t.type].label}</span></td>
                    <td className="tabular-nums">{t.count}</td>
                    <td className="tabular-nums">{formatBytes(t.bytes)}</td>
                    <td className="tabular-nums w-32"><div className="flex items-center gap-2"><Bar pct={(t.bytes / Math.max(1, r.totals.bytes)) * 100} className="flex-1" /><span className="w-9 text-right">{Math.round((t.bytes / Math.max(1, r.totals.bytes)) * 100)}%</span></div></td>
                  </tr>
                ))}
              </Table>
            </Section>
            <Section title="Estimated load time" description="Model: connections × RTT + request round-trips + bytes ÷ bandwidth. Ignores CPU, caching and HTTP/2 gains — use it to compare, not as a lab measurement.">
              <Table head={['Network', 'First render', 'Full load', '']}>
                {r.estimates.map(e => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">{e.label}<span className="block text-[10px] text-muted-foreground">{e.kbps >= 1000 ? `${e.kbps / 1000} Mbps` : `${e.kbps} kbps`} · {e.rttMs} ms RTT</span></td>
                    <td className="tabular-nums whitespace-nowrap">{formatMs(e.renderMs)}</td>
                    <td className="tabular-nums whitespace-nowrap font-medium">{formatMs(e.fullMs)}</td>
                    <td className="w-28"><Bar pct={(e.fullMs / maxFull) * 100} tone={e.fullMs > 10_000 ? 'destructive' : e.fullMs > 3000 ? 'foreground' : 'primary'} /></td>
                  </tr>
                ))}
                {custom && (
                  <tr>
                    <td>
                      <div className="flex items-center gap-1">
                        <Input type="number" className="h-6 w-20 text-xs px-1.5" value={kbps} min={10} onChange={e => setKbps(Math.max(10, Number(e.target.value) || 10))} title="kbps" />
                        <span className="text-[10px] text-muted-foreground">kbps</span>
                        <Input type="number" className="h-6 w-16 text-xs px-1.5" value={rtt} min={1} onChange={e => setRtt(Math.max(1, Number(e.target.value) || 1))} title="RTT ms" />
                        <span className="text-[10px] text-muted-foreground">ms</span>
                      </div>
                    </td>
                    <td className="tabular-nums">{formatMs(custom.renderMs)}</td>
                    <td className="tabular-nums font-medium">{formatMs(custom.fullMs)}</td>
                    <td><Bar pct={(custom.fullMs / maxFull) * 100} tone="muted" /></td>
                  </tr>
                )}
              </Table>
            </Section>
          </div>

          {r.suggestions.length > 0 && (
            <Section title="Suggestions">
              <div>
                {r.suggestions.map((s, i) => (
                  <div key={i} className="flex gap-2.5 py-2 border-b border-border last:border-0">
                    <Badge variant={s.severity === 'high' ? 'destructive' : s.severity === 'medium' ? 'outline' : 'secondary'} className="shrink-0 w-16 justify-center">{s.severity}</Badge>
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{s.title}{s.savingsBytes ? <span className="text-muted-foreground font-normal"> — save ~{formatBytes(s.savingsBytes)}</span> : null}</p>
                      <p className="text-[11px] text-muted-foreground break-words">{s.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Largest resources">
              <Table head={['Resource', 'Type', 'Size', '']}>
                {r.largest.map((x, i) => (
                  <tr key={i}>
                    <td className="max-w-[16rem]"><a href={x.url} target="_blank" rel="noopener noreferrer nofollow" className="block truncate hover:underline" title={x.url}>{shortUrl(x.url)}</a>
                      <span className="text-[10px] text-muted-foreground">{siteName(x.url)}{x.encoding ? ` · ${x.encoding}` : ''}</span></td>
                    <td>{TYPE_META[x.type].label}</td>
                    <td className="tabular-nums whitespace-nowrap">{x.approximate ? '≥ ' : ''}{formatBytes(x.bytes)}</td>
                    <td className="whitespace-nowrap">{x.thirdParty && <Badge variant="secondary">3rd party</Badge>} {x.renderBlocking && <Badge variant="outline">blocking</Badge>}</td>
                  </tr>
                ))}
              </Table>
            </Section>
            <div className="space-y-4 min-w-0">
              <Section title="Render-blocking in <head>" description="Scripts without async/defer and stylesheets delay the first paint.">
                {r.renderBlocking.length ? r.renderBlocking.map((x, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs min-w-0">
                    <Badge variant="secondary" className="shrink-0">{x.type.toUpperCase()}</Badge>
                    <span className={cn(MONO, 'truncate flex-1 min-w-0')} title={x.url}>{x.url}</span>
                    <span className="text-muted-foreground tabular-nums shrink-0">{formatBytes(x.bytes)}</span>
                  </div>
                )) : <p className="text-xs text-primary">None — nice.</p>}
              </Section>
              {r.thirdParty.hosts.length > 0 && (
                <Section title="Third-party hosts">
                  {r.thirdParty.hosts.map(h => (
                    <div key={h.host} className="flex items-center gap-2 text-xs">
                      <span className="flex-1 truncate">{h.host}</span>
                      <span className="text-muted-foreground tabular-nums">{h.count} req</span>
                      <span className="tabular-nums w-20 text-right">{formatBytes(h.bytes)}</span>
                    </div>
                  ))}
                </Section>
              )}
              {r.iframes.length > 0 && (
                <Section title={`Iframes (${r.iframes.length})`} description="Listed, not downloaded — each embeds a full page of its own.">
                  {r.iframes.map(f => <p key={f} className={cn(MONO, 'truncate')} title={f}>{f}</p>)}
                </Section>
              )}
            </div>
          </div>

          <Section title={`All resources (${r.resources.length})`} action={
            <div className="flex gap-1">
              <Button variant="ghost" size="xs" onClick={exportCsv}><Download /> CSV</Button>
              <Button variant="ghost" size="xs" onClick={() => setShowAll(v => !v)}>{showAll ? 'Hide' : 'Show'}</Button>
            </div>
          }>
            {showAll && (
              <Table head={['URL', 'Type', 'Status', 'Size', 'Encoding', 'Cache-Control']}>
                {r.resources.map((x, i) => (
                  <tr key={i}>
                    <td className="max-w-[20rem]"><span className="block truncate" title={x.url}>{x.url}</span><span className="text-[10px] text-muted-foreground">{x.initiator}{x.error ? ` · ${x.error}` : ''}</span></td>
                    <td>{TYPE_META[x.type].label}</td>
                    <td><Badge variant={x.error || (x.status ?? 0) >= 400 ? 'destructive' : 'secondary'} className="tabular-nums">{x.error ? 'err' : x.status}</Badge></td>
                    <td className="tabular-nums whitespace-nowrap">{x.approximate ? '≥ ' : ''}{formatBytes(x.bytes)}</td>
                    <td>{x.encoding || '—'}</td>
                    <td className="break-all max-w-[12rem]">{x.cacheControl || '—'}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Backlink Checker ─────────────────────────────

interface BacklinkLink { href: string; anchor: string; rel: string[]; nofollow: boolean; sponsored: boolean; ugc: boolean; image: boolean; placement: string; context: string }
interface BacklinkPage {
  url: string; finalUrl?: string; status: number | null; error?: string; title?: string; indexable?: boolean; noindex?: boolean; pageNofollow?: boolean;
  canonical?: string | null; canonicalElsewhere?: boolean; totalLinks?: number; links: BacklinkLink[]; found: boolean; followed?: number; internal?: boolean;
}
interface BacklinkResult {
  target: string; mode: 'domain' | 'url';
  summary: { pages: number; fetched: number; errors: number; pagesWithLinks: number; links: number; followed: number; nofollow: number; sponsored: number; ugc: number };
  results: BacklinkPage[];
}

function RelBadges({ l }: { l: BacklinkLink }) {
  const follow = !l.nofollow && !l.sponsored && !l.ugc;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {follow ? <Badge>follow</Badge> : null}
      {l.nofollow && <Badge variant="outline">nofollow</Badge>}
      {l.sponsored && <Badge variant="outline">sponsored</Badge>}
      {l.ugc && <Badge variant="outline">ugc</Badge>}
    </span>
  );
}

export function BacklinkChecker() {
  const [target, setTarget] = useState('python.org');
  const [pages, setPages] = useState('https://en.wikipedia.org/wiki/Python_(programming_language)\nhttps://github.com/python/cpython\nhttps://www.djangoproject.com/');
  const [filter, setFilter] = useState<'all' | 'found' | 'missing'>('all');
  const { data: r, loading, error, run } = useRequest<BacklinkResult>();
  const parsed = useMemo(() => parseUrlList(pages, { max: 50 }), [pages]);

  const submit = () => run(() => toolsApi.post<BacklinkResult>('/seo/backlinks', { target, pages: parsed.urls }));

  const exportCsv = () => {
    if (!r) return;
    const rows: unknown[][] = [['page', 'status', 'page_indexable', 'link_href', 'anchor', 'rel', 'placement', 'context', 'error']];
    for (const p of r.results) {
      if (!p.links.length) rows.push([p.url, p.status ?? '', p.indexable ?? '', '', '', '', '', '', p.error || (p.found ? '' : 'no link found')]);
      for (const l of p.links) rows.push([p.url, p.status, p.indexable, l.href, l.anchor, l.rel.join(' ') || 'follow', l.placement, l.context, '']);
    }
    downloadBlob(toCsv(rows), `backlinks-${target.replace(/[^a-z0-9.-]+/gi, '_')}.csv`, 'text/csv');
  };

  const shown = r ? r.results.filter(p => filter === 'all' || (filter === 'found' ? p.found : !p.found)) : [];

  return (
    <div className="space-y-4">
      <InfoBox>
        This verifies backlinks <span className="font-medium text-foreground">you already know about</span>: paste pages that should link to you and it checks each one live — is the link there, what's the anchor text, is it follow/nofollow/sponsored/ugc, and can the page itself be indexed. There is no global backlink index behind this tool; for discovery use Google Search Console's Links report.
      </InfoBox>
      <div className="grid gap-3 lg:grid-cols-[1fr_2fr]">
        <div className="space-y-1.5">
          <FieldLabel>Your site (domain or exact URL)</FieldLabel>
          <Input value={target} onChange={e => setTarget(e.target.value)} placeholder="example.com or https://example.com/page" />
          <p className="text-[11px] text-muted-foreground">A domain matches links to it and its subdomains; a URL matches only that page (ignoring www, trailing slash and #fragment).</p>
        </div>
        <div className="space-y-1.5">
          <FieldLabel action={<span className="text-[11px] text-muted-foreground tabular-nums">{parsed.urls.length}/50 URLs{parsed.invalid.length ? ` · ${parsed.invalid.length} invalid` : ''}{parsed.duplicates ? ` · ${parsed.duplicates} duplicate` : ''}</span>}>Referring pages (one per line)</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-28')} value={pages} onChange={e => setPages(e.target.value)} spellCheck={false} placeholder={'https://blog.example.org/post\nhttps://news.example.net/article'} />
        </div>
      </div>
      <Button onClick={submit} disabled={loading || !target.trim() || !parsed.urls.length}>
        {loading ? <Loader2 className="animate-spin" /> : <Play />}{loading ? `Checking ${parsed.urls.length} page(s)…` : 'Check backlinks'}
      </Button>
      {error && <ErrorBox message={error} />}
      {r && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Pages checked" value={r.summary.pages} hint={r.summary.errors ? `${r.summary.errors} failed` : undefined} />
            <Stat label="Pages linking" value={`${r.summary.pagesWithLinks}/${r.summary.pages}`} />
            <Stat label="Links found" value={r.summary.links} />
            <Stat label="Follow" value={r.summary.followed} />
            <Stat label="Nofollow" value={r.summary.nofollow} />
            <Stat label="Sponsored / UGC" value={`${r.summary.sponsored} / ${r.summary.ugc}`} />
          </div>
          <Section
            title={`Results for ${r.target}`}
            action={<div className="flex items-center gap-2">
              <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'found', label: 'Linking' }, { value: 'missing', label: 'Missing' }]} />
              <Button variant="ghost" size="xs" onClick={exportCsv}><Download /> CSV</Button>
            </div>}
          >
            <div className="space-y-2">
              {shown.map((p, i) => (
                <div key={i} className="rounded-md border border-border p-2.5 space-y-2 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <StatusIcon status={p.error ? 'fail' : p.found ? (p.indexable ? 'pass' : 'warn') : 'warn'} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{p.title || p.url}</p>
                      <ExtLink href={p.finalUrl || p.url} className="text-[11px] text-muted-foreground">{p.finalUrl || p.url}</ExtLink>
                    </div>
                    {p.status !== null && <Badge variant={httpStatus(p.status) === 'fail' ? 'destructive' : 'secondary'} className="tabular-nums">{p.status}</Badge>}
                    {p.error ? <Badge variant="destructive">error</Badge> : p.found ? <Badge>{p.links.length} link{p.links.length === 1 ? '' : 's'}</Badge> : <Badge variant="outline">no link</Badge>}
                    {p.indexable === false && <Badge variant="destructive">page not indexable</Badge>}
                    {p.pageNofollow && <Badge variant="outline">page nofollow</Badge>}
                    {p.canonicalElsewhere && <Badge variant="outline" title={p.canonical || ''}>canonical elsewhere</Badge>}
                    {p.internal && <Badge variant="secondary" title="This page is on your own site, so these are internal links">same site</Badge>}
                  </div>
                  {p.error && <p className="text-[11px] text-destructive break-words">{p.error}</p>}
                  {!p.error && !p.found && <p className="text-[11px] text-muted-foreground">No link to {r.target} among {p.totalLinks ?? 0} links on this page.</p>}
                  {p.links.length > 0 && (
                    <Table head={['Anchor', 'Rel', 'Where', 'Links to']}>
                      {p.links.map((l, j) => (
                        <tr key={j}>
                          <td className="min-w-[10rem]">
                            <span className="font-medium">{l.anchor || <span className="text-destructive">(empty)</span>}</span>
                            <span className="block text-[10px] text-muted-foreground break-words">{l.context}</span>
                          </td>
                          <td><RelBadges l={l} /></td>
                          <td className="text-muted-foreground">{l.placement}</td>
                          <td className="break-all max-w-[14rem]">{l.href}</td>
                        </tr>
                      ))}
                    </Table>
                  )}
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Sitemap Generator ─────────────────────────────

const CHANGEFREQ_OPTIONS = [{ value: 'none', label: '(omit)' }, ...['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'].map(v => ({ value: v, label: v }))];
const PRIORITY_VALUES = ['1.0', '0.9', '0.8', '0.7', '0.6', '0.5', '0.4', '0.3', '0.2', '0.1'];

function XmlOutput({ xml, filename, extra }: { xml: string; filename: string; extra?: React.ReactNode }) {
  const lines = xml.split('\n').length;
  return (
    <div className="space-y-1.5">
      <FieldLabel action={<div className="flex items-center gap-1">
        <CopyButton value={xml} label="Copy" />
        <Button variant="ghost" size="xs" onClick={() => downloadBlob(xml, filename, 'application/xml')}><Download /> {filename}</Button>
        {extra}
      </div>}>
        {filename} · {formatBytes(new Blob([xml]).size)} · {lines.toLocaleString()} lines
      </FieldLabel>
      <Textarea readOnly className={cn(MONO, FIXED, 'h-72 bg-secondary/40')} value={xml.length > 400_000 ? xml.slice(0, 400_000) + '\n<!-- preview truncated; download for the full file -->' : xml} />
    </div>
  );
}

function CrawlMode() {
  const [opts, setOpts] = useState({
    startUrl: EXAMPLE_URL === lastUrl ? 'https://example.com' : lastUrl,
    maxPages: 100, maxDepth: 5, sameHostOnly: true, respectRobots: true, includeLastmod: true, ignoreQuery: false,
    changefreq: 'none', priority: 'none', userAgent: 'chrome-desktop',
  });
  const set = <K extends keyof typeof opts>(k: K, v: (typeof opts)[K]) => setOpts(o => ({ ...o, [k]: v }));
  const { run, job, running, error, cancel } = useJob();
  const [xml, setXml] = useState('');
  const [xmlError, setXmlError] = useState('');
  const [tab, setTab] = useState<'xml' | 'excluded' | 'errors'>('xml');

  const start = async () => {
    setXml(''); setXmlError('');
    const j = await run('sitemap-crawl', [], { ...opts, startUrl: normalizeInput(opts.startUrl) });
    if (j?.status === 'done') {
      const idx = j.outputs.findIndex(o => o.filename === 'sitemap.xml');
      try { setXml(await (await jobsApi.outputBlob(j, idx < 0 ? 0 : idx)).text()); } catch (e) { setXmlError((e as Error).message); }
    }
  };
  const meta = (job?.status === 'done' ? job.meta : null) as null | {
    discovered: number; crawled: number; included: number; queued: number; limitReached: boolean; durationMs: number; avgFetchMs: number;
    excluded: { url: string; reason: string }[]; excludedCount: number; errors: { url: string; status?: number; error?: string }[]; errorCount: number; maxDepthReached: number;
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel>Start URL</FieldLabel>
          <Input value={opts.startUrl} onChange={e => set('startUrl', e.target.value)} placeholder="https://example.com" />
        </div>
        <NumberField label="Max pages (≤ 500)" value={opts.maxPages} min={1} max={500} onChange={v => set('maxPages', Math.min(500, Math.max(1, v || 1)))} />
        <NumberField label="Max depth" value={opts.maxDepth} min={0} max={20} onChange={v => set('maxDepth', Math.min(20, Math.max(0, v || 0)))} />
        <div className="space-y-1.5">
          <FieldLabel>changefreq</FieldLabel>
          <NativeSelect className="w-full" value={opts.changefreq} onChange={v => set('changefreq', v)} options={CHANGEFREQ_OPTIONS} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>priority</FieldLabel>
          <NativeSelect className="w-full" value={opts.priority} onChange={v => set('priority', v)} options={[{ value: 'none', label: '(omit)' }, { value: 'auto', label: 'By depth (1.0 → 0.5)' }, ...PRIORITY_VALUES.map(v => ({ value: v, label: v }))]} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Crawl as</FieldLabel>
          <NativeSelect className="w-full" value={opts.userAgent} onChange={v => set('userAgent', v)} options={UA_OPTIONS} />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Checkbox checked={opts.respectRobots} onChange={v => set('respectRobots', v)}>Respect robots.txt</Checkbox>
        <Checkbox checked={opts.sameHostOnly} onChange={v => set('sameHostOnly', v)}>Same host only (off = include subdomains)</Checkbox>
        <Checkbox checked={opts.includeLastmod} onChange={v => set('includeLastmod', v)}>lastmod from Last-Modified</Checkbox>
        <Checkbox checked={opts.ignoreQuery} onChange={v => set('ignoreQuery', v)}>Ignore query strings</Checkbox>
      </div>
      <p className="text-[11px] text-muted-foreground">Pages that are noindex, canonicalised elsewhere, redirecting, non-200 or non-HTML are left out (and listed below). Google ignores changefreq and priority; lastmod is used when accurate.</p>
      <Button onClick={start} disabled={running || !opts.startUrl.trim()}>
        {running ? <Loader2 className="animate-spin" /> : <Play />}{running ? 'Crawling…' : 'Start crawl'}
      </Button>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {meta && (
        <div className="space-y-3">
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="In sitemap" value={meta.included} />
            <Stat label="Crawled" value={meta.crawled} hint={meta.limitReached ? 'page limit reached' : undefined} />
            <Stat label="Discovered" value={meta.discovered} hint={meta.queued ? `${meta.queued} not crawled` : undefined} />
            <Stat label="Excluded" value={meta.excludedCount} />
            <Stat label="Errors" value={meta.errorCount} />
            <Stat label="Duration" value={formatMs(meta.durationMs)} hint={`avg ${formatMs(meta.avgFetchMs)} / page`} />
          </div>
          <Segmented value={tab} onChange={setTab} options={[
            { value: 'xml', label: 'sitemap.xml' }, { value: 'excluded', label: `Excluded (${meta.excludedCount})` }, { value: 'errors', label: `Errors (${meta.errorCount})` },
          ]} />
          {tab === 'xml' && (xmlError ? <ErrorBox message={xmlError} /> : xml ? <XmlOutput xml={xml} filename="sitemap.xml" extra={
            job && <Button variant="ghost" size="xs" onClick={() => { const i = job.outputs.findIndex(o => o.filename === 'urls.txt'); if (i >= 0) jobsApi.download(job, i); }}><Download /> urls.txt</Button>
          } /> : <Loading label="Loading sitemap…" />)}
          {tab === 'excluded' && (meta.excluded.length ? (
            <Table head={['URL', 'Reason']}>
              {meta.excluded.map((e, i) => <tr key={i}><td className="break-all">{e.url}</td><td className="text-muted-foreground">{e.reason}</td></tr>)}
            </Table>
          ) : <p className="text-xs text-muted-foreground">Nothing excluded.</p>)}
          {tab === 'errors' && (meta.errors.length ? (
            <Table head={['URL', 'Problem']}>
              {meta.errors.map((e, i) => <tr key={i}><td className="break-all">{e.url}</td><td className="text-destructive">{e.status ? `HTTP ${e.status}` : e.error}</td></tr>)}
            </Table>
          ) : <p className="text-xs text-muted-foreground">No errors.</p>)}
        </div>
      )}
    </div>
  );
}

function ManualMode() {
  const [text, setText] = useState('https://example.com/\nhttps://example.com/about\nhttps://example.com/blog/\nhttps://example.com/contact');
  const [changefreq, setChangefreq] = useState('none');
  const [priority, setPriority] = useState('none');
  const [lastmodMode, setLastmodMode] = useState<'none' | 'today' | 'date'>('today');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const { data: r, loading, error, run } = useRequest<{ xml: string; count: number; invalid: string[]; invalidCount: number; duplicates: number; hosts: string[] }>();
  const lines = text.split(/\r?\n/).filter(l => l.trim()).length;

  const build = () => run(() => toolsApi.post('/seo/sitemap-build', {
    urls: text.split(/\r?\n/), changefreq, priority: priority === 'none' ? undefined : priority,
    lastmod: lastmodMode === 'date' ? date : lastmodMode,
  }));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-1.5">
          <FieldLabel action={<span className="text-[11px] text-muted-foreground tabular-nums">{lines.toLocaleString()} lines</span>}>URLs (one per line, absolute)</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-56')} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5"><FieldLabel>changefreq</FieldLabel><NativeSelect className="w-full" value={changefreq} onChange={setChangefreq} options={CHANGEFREQ_OPTIONS} /></div>
          <div className="space-y-1.5"><FieldLabel>priority</FieldLabel><NativeSelect className="w-full" value={priority} onChange={setPriority} options={[{ value: 'none', label: '(omit)' }, ...PRIORITY_VALUES.map(v => ({ value: v, label: v }))]} /></div>
          <div className="space-y-1.5">
            <FieldLabel>lastmod</FieldLabel>
            <Segmented value={lastmodMode} onChange={setLastmodMode} options={[{ value: 'none', label: 'Omit' }, { value: 'today', label: 'Today' }, { value: 'date', label: 'Date' }]} />
            {lastmodMode === 'date' && <Input type="date" value={date} onChange={e => setDate(e.target.value)} />}
          </div>
          <Button onClick={build} disabled={loading || !lines} className="w-full">{loading ? <Loader2 className="animate-spin" /> : null}Generate sitemap.xml</Button>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {r && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <Badge>{r.count.toLocaleString()} URLs</Badge>
            {r.duplicates > 0 && <Badge variant="secondary">{r.duplicates} duplicates removed</Badge>}
            {r.invalidCount > 0 && <Badge variant="destructive">{r.invalidCount} invalid skipped</Badge>}
            {r.hosts.length > 1 && <Badge variant="outline">{r.hosts.length} hosts — a sitemap should only list URLs of its own host</Badge>}
          </div>
          {r.invalid.length > 0 && <InfoBox>Skipped: {r.invalid.slice(0, 10).join(', ')}{r.invalid.length > 10 ? '…' : ''}</InfoBox>}
          <XmlOutput xml={r.xml} filename="sitemap.xml" />
          <p className="text-[11px] text-muted-foreground">Upload to your site root and reference it in robots.txt with <code className={MONO}>Sitemap: https://your-site/sitemap.xml</code>, then submit it in Search Console.</p>
        </div>
      )}
    </div>
  );
}

export function SitemapGenerator() {
  const [mode, setMode] = useState<'crawl' | 'manual'>('crawl');
  return (
    <div className="space-y-4">
      <Segmented value={mode} onChange={setMode} options={[{ value: 'crawl', label: 'Crawl a site' }, { value: 'manual', label: 'Paste URLs' }]} />
      {mode === 'crawl' ? <CrawlMode /> : <ManualMode />}
    </div>
  );
}

// ───────────────────────────── Keyword Density ─────────────────────────────

interface Prominence { title: boolean; description: boolean; h1: boolean; h2: boolean; first100: boolean; url: boolean }
interface KwTerm { term: string; count: number; density: number; prominence: Prominence }
interface KwResult {
  source: { url?: string; finalUrl?: string; status?: number; title: string; description: string; h1: string[]; h2: string[] } | null;
  stats: { totalWords: number; uniqueWords: number; stopwordsRemoved: number; sentences: number; characters: number; readingMinutes: number; avgWordsPerSentence: number };
  grams: Record<string, KwTerm[]>;
}

const SAMPLE_TEXT = `Cold brew coffee is coffee brewed with cold water over many hours. Because cold brew coffee is never heated, it tastes smoother and less acidic than hot coffee.

To make cold brew at home, mix coarsely ground coffee with cold water, steep it for 12 to 24 hours, then strain. Cold brew concentrate keeps in the fridge for up to two weeks. Serve cold brew over ice, dilute the concentrate with water or milk, and experiment with different coffee beans to find the flavour you like.`;

const PROM_KEYS: { k: keyof Prominence; label: string; title: string }[] = [
  { k: 'title', label: 'Title', title: 'In <title>' },
  { k: 'description', label: 'Desc', title: 'In the meta description' },
  { k: 'h1', label: 'H1', title: 'In an H1' },
  { k: 'h2', label: 'H2', title: 'In an H2' },
  { k: 'first100', label: '100w', title: 'In the first 100 words' },
  { k: 'url', label: 'URL', title: 'In the URL path' },
];

export function KeywordDensity() {
  const [mode, setMode] = useState<'text' | 'url'>('text');
  const [text, setText] = useState(SAMPLE_TEXT);
  const [url, setUrl] = useState(lastUrl === EXAMPLE_URL ? 'https://en.wikipedia.org/wiki/Search_engine_optimization' : lastUrl);
  const [minLength, setMinLength] = useState(3);
  const [stopwords, setStopwords] = useState(true);
  const [numbers, setNumbers] = useState(false);
  const [n, setN] = useState<'1' | '2' | '3'>('1');
  const [q, setQ] = useState('');
  const { data: r, loading, error, run } = useRequest<KwResult>();

  const submit = () => run(() => {
    const body: Record<string, unknown> = { minLength, stopwords, includeNumbers: numbers, ngrams: 3, top: 50 };
    if (mode === 'url') { body.url = normalizeInput(url); lastUrl = String(body.url); } else body.text = text;
    return toolsApi.post<KwResult>('/seo/keywords', body);
  });

  // Text mode re-analyses automatically (debounced) so it feels live.
  useEffect(() => {
    if (mode !== 'text' || !text.trim()) return;
    const id = setTimeout(submit, 450);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, text, minLength, stopwords, numbers]);

  const list = (r?.grams[n] || []).filter(t => !q || t.term.includes(q.toLowerCase()));
  const maxDensity = Math.max(0.01, ...list.map(t => t.density));
  const hasProminence = !!r?.source;

  const exportCsv = () => {
    if (!r) return;
    const rows: unknown[][] = [['n', 'term', 'count', 'density_pct', ...(hasProminence ? PROM_KEYS.map(p => p.k) : [])]];
    for (const [k, terms] of Object.entries(r.grams)) for (const t of terms) rows.push([k, t.term, t.count, t.density, ...(hasProminence ? PROM_KEYS.map(p => t.prominence[p.k]) : [])]);
    downloadBlob(toCsv(rows), 'keyword-density.csv', 'text/csv');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'text', label: 'Text' }, { value: 'url', label: 'URL' }]} />
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          Min length
          <Input type="number" className="h-8 w-16" value={minLength} min={1} max={20} onChange={e => setMinLength(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
        </label>
        <Checkbox checked={stopwords} onChange={setStopwords}>Remove stopwords</Checkbox>
        <Checkbox checked={numbers} onChange={setNumbers}>Include numbers</Checkbox>
      </div>
      {mode === 'text' ? (
        <div className="space-y-1.5">
          <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setText('')}>Clear</Button>}>Text</FieldLabel>
          <Textarea className={cn(FIXED, 'h-44 text-sm')} value={text} onChange={e => setText(e.target.value)} placeholder="Paste your copy here…" />
        </div>
      ) : (
        <UrlForm url={url} onUrl={setUrl} loading={loading} onSubmit={submit} />
      )}
      {mode === 'url' && <p className="text-[11px] text-muted-foreground">Analyses the visible body text (navigation, footer and sidebars excluded) and checks whether each term appears in the title, description, headings, opening and URL.</p>}
      {error && <ErrorBox message={error} />}
      {loading && !r && <Loading label="Analysing…" />}
      {r && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Words" value={r.stats.totalWords.toLocaleString()} />
            <Stat label="Unique words" value={r.stats.uniqueWords.toLocaleString()} />
            <Stat label="Sentences" value={r.stats.sentences.toLocaleString()} hint={`${r.stats.avgWordsPerSentence} words avg`} />
            <Stat label="Stopwords removed" value={r.stats.stopwordsRemoved.toLocaleString()} />
            <Stat label="Characters" value={r.stats.characters.toLocaleString()} />
            <Stat label="Reading time" value={`${r.stats.readingMinutes} min`} />
          </div>
          {r.source && (
            <Section title={r.source.title || r.source.finalUrl || ''} description={r.source.description || 'No meta description'}>
              <p className="text-[11px] text-muted-foreground break-all">{r.source.finalUrl}{r.source.h1.length ? ` · H1: ${r.source.h1.join(' | ')}` : ''}</p>
            </Section>
          )}
          <Section
            title="Keywords & phrases"
            description="Density = occurrences × words in the phrase ÷ total words. Phrases never start or end with a stopword and don't cross sentences."
            action={<Button variant="ghost" size="xs" onClick={exportCsv}><Download /> CSV</Button>}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Segmented value={n} onChange={setN} options={[
                { value: '1', label: `1 word (${r.grams['1']?.length ?? 0})` }, { value: '2', label: `2 words (${r.grams['2']?.length ?? 0})` }, { value: '3', label: `3 words (${r.grams['3']?.length ?? 0})` },
              ]} />
              <Input className="h-8 w-40" placeholder="Filter…" value={q} onChange={e => setQ(e.target.value)} />
            </div>
            {list.length ? (
              <Table head={['#', 'Term', 'Count', 'Density', ...(hasProminence ? ['Prominence'] : [])]}>
                {list.map((t, i) => (
                  <tr key={t.term}>
                    <td className="text-muted-foreground tabular-nums w-8">{i + 1}</td>
                    <td className="font-medium break-words">{t.term}
                      {n === '1' && t.density > 3 && r.stats.totalWords > 150 && <Badge variant="outline" className="ml-1.5" title="Very high density can read as keyword stuffing">high</Badge>}
                    </td>
                    <td className="tabular-nums">{t.count}</td>
                    <td className="w-40"><div className="flex items-center gap-2"><Bar pct={(t.density / maxDensity) * 100} className="flex-1" /><span className="tabular-nums w-12 text-right">{t.density.toFixed(2)}%</span></div></td>
                    {hasProminence && (
                      <td><span className="inline-flex flex-wrap gap-1">
                        {PROM_KEYS.map(p => (
                          <span key={p.k} title={p.title} className={cn('rounded px-1 py-0.5 text-[10px] border', t.prominence[p.k] ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground/50')}>{p.label}</span>
                        ))}
                      </span></td>
                    )}
                  </tr>
                ))}
              </Table>
            ) : <p className="text-xs text-muted-foreground">{n === '1' ? 'No keywords.' : 'No phrase occurs more than once.'}</p>}
          </Section>
        </div>
      )}
    </div>
  );
}

