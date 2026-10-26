import React, { useState } from 'react';
import { Gauge, Smartphone, Monitor, Timer, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InfoBox } from '../../devtools/shared';
import type { PageSpeedRun } from '../api';
import type { ReportCtx } from '../Report';
import { ScoreRing, Section, shortUrl } from '../ui';

const METRIC_INFO: Record<string, string> = {
  LCP: 'Largest Contentful Paint', FCP: 'First Contentful Paint', TBT: 'Total Blocking Time', CLS: 'Cumulative Layout Shift',
  SI: 'Speed Index', TTI: 'Time to Interactive', TTFB: 'Time to First Byte', INP: 'Interaction to Next Paint',
};
const catTone = (c?: string) => c === 'FAST' ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
  : c === 'AVERAGE' ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30'
    : c === 'SLOW' ? 'text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/30' : 'border-border';
const catLabel = (c?: string) => c === 'FAST' ? 'Good' : c === 'AVERAGE' ? 'Needs improvement' : c === 'SLOW' ? 'Poor' : '';

export function PerformanceTab({ ctx }: { ctx: ReportCtx }) {
  const { report: r, openPage } = ctx;
  const runs = r.site.pageSpeed || [];
  const [strategy, setStrategy] = useState<'mobile' | 'desktop'>('mobile');
  const run = runs.find(x => x.strategy === strategy);
  const slow = [...r.pages].filter(p => p.isHtml).sort((a, b) => b.ttfbMs - a.ttfbMs).slice(0, 15);
  const heavy = [...r.pages].filter(p => p.isHtml).sort((a, b) => b.sizeKb - a.sizeKb).slice(0, 15);

  return (
    <div className="space-y-4">
      <Section title={`Lighthouse — ${r.site.finalUrl.replace(/^https?:\/\//, '')}`} icon={Gauge}
        action={runs.length > 0 && <div className="inline-flex rounded-md border border-border bg-secondary p-0.5">
          {(['mobile', 'desktop'] as const).map(s => (
            <button key={s} onClick={() => setStrategy(s)} className={cn('h-6 px-2 rounded-[5px] text-[11px] font-medium cursor-pointer flex items-center gap-1', strategy === s ? 'bg-card border border-border shadow-sm' : 'text-muted-foreground')}>
              {s === 'mobile' ? <Smartphone className="size-3" /> : <Monitor className="size-3" />}{s}
            </button>
          ))}
        </div>}>
        {runs.length === 0 ? (
          <InfoBox>Lighthouse wasn't run for this audit. Enable “Lighthouse / Core Web Vitals” in crawl settings (a free Google PageSpeed API key makes it reliable).</InfoBox>
        ) : !run || run.error ? (
          <InfoBox>{run?.error || 'No result.'}</InfoBox>
        ) : <PSIView run={run} />}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Slowest server responses" icon={Timer}>
          <PageMetricList rows={slow.map(p => ({ url: p.url, value: `${p.ttfbMs} ms`, bad: p.ttfbMs > 800 }))} origin={r.site.origin} onOpen={openPage} />
        </Section>
        <Section title="Heaviest HTML documents" icon={Timer}>
          <PageMetricList rows={heavy.map(p => ({ url: p.url, value: `${p.sizeKb} KB`, bad: p.sizeKb > 500 }))} origin={r.site.origin} onOpen={openPage} />
        </Section>
      </div>
    </div>
  );
}

function PSIView({ run }: { run: PageSpeedRun }) {
  const scores = run.scores || {};
  const labels: Record<string, string> = { performance: 'Performance', accessibility: 'Accessibility', 'best-practices': 'Best practices', seo: 'SEO' };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap justify-around gap-4">
        {Object.entries(labels).map(([k, l]) => scores[k] !== undefined && (
          <div key={k} className="flex flex-col items-center gap-1">
            <ScoreRing score={scores[k]} size={84} label={l} />
            <span className="text-xs text-muted-foreground">{l}</span>
          </div>
        ))}
      </div>
      {run.field && Object.keys(run.field).length > 0 && (
        <div>
          <p className="text-xs font-medium mb-2 flex items-center gap-1.5"><Users className="size-3.5 text-primary" /> Real-user Core Web Vitals (CrUX, 75th percentile, {run.fieldScope === 'origin' ? 'whole origin' : 'this URL'})</p>
          <div className="grid gap-2 grid-cols-2 md:grid-cols-5">
            {['LCP', 'INP', 'CLS', 'FCP', 'TTFB'].filter(k => run.field![k]).map(k => <MetricTile key={k} name={k} m={run.field![k]} />)}
          </div>
        </div>
      )}
      <div>
        <p className="text-xs font-medium mb-2">Lab metrics (simulated)</p>
        <div className="grid gap-2 grid-cols-2 md:grid-cols-4">
          {['LCP', 'FCP', 'TBT', 'CLS', 'SI', 'TTI', 'TTFB'].filter(k => run.metrics?.[k]).map(k => <MetricTile key={k} name={k} m={run.metrics![k]} />)}
        </div>
      </div>
      {run.opportunities && run.opportunities.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-2">Opportunities</p>
          <div className="divide-y divide-border rounded-md border border-border">
            {run.opportunities.map(o => (
              <div key={o.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                <span className={cn('size-2 rounded-full shrink-0', o.score < 0.5 ? 'bg-red-500' : 'bg-amber-500')} />
                <span className="flex-1 min-w-0">{o.title}</span>
                <span className="tabular-nums text-muted-foreground">{o.display || `${(o.savingsMs / 1000).toFixed(1)} s`}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricTile({ name, m }: { name: string; m: { display: string; category?: string } }) {
  return (
    <div className={cn('rounded-md border px-3 py-2', catTone(m.category))} title={METRIC_INFO[name]}>
      <p className="text-[11px] text-muted-foreground">{name} · {METRIC_INFO[name]}</p>
      <p className="text-base font-semibold tabular-nums">{m.display}</p>
      {m.category && <p className="text-[11px]">{catLabel(m.category)}</p>}
    </div>
  );
}

function PageMetricList({ rows, origin, onOpen }: { rows: { url: string; value: string; bad: boolean }[]; origin: string; onOpen: (u: string) => void }) {
  return (
    <div className="divide-y divide-border">
      {rows.map(r => (
        <button key={r.url} onClick={() => onOpen(r.url)} className="w-full flex items-center gap-2 py-1.5 text-left cursor-pointer hover:text-primary">
          <span className="flex-1 min-w-0 font-mono text-[11px] truncate" title={r.url}>{shortUrl(r.url, origin)}</span>
          <span className={cn('text-xs tabular-nums', r.bad && 'text-red-600 dark:text-red-400')}>{r.value}</span>
        </button>
      ))}
    </div>
  );
}
