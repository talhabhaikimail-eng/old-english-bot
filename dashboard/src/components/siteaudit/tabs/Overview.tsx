import React, { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Layers, ListChecks, Sparkles, Zap, GitCompare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Stat } from '../../devtools/shared';
import { auditApi, type AuditReport, type AuditSummary, type IssueResult } from '../api';
import type { ReportCtx } from '../Report';
import { BarList, Histogram, MiniScore, ScoreRing, Section, SEVERITY, SeverityBadge, fmtBytes, scoreTone } from '../ui';

const STATUS_ORDER = (k: string) => (k === 'blocked' ? 900 : k === 'error' ? 950 : Number(k));

export function Overview({ ctx }: { ctx: ReportCtx }) {
  const { report: r, goTo } = ctx;
  const s = r.summary;
  const tone = scoreTone(r.score);
  const cats = [...r.categories].sort((a, b) => (r.categoryScores[a.ID] ?? 100) - (r.categoryScores[b.ID] ?? 100));
  const top = r.issues.filter(i => i.severity !== 'notice').slice(0, 8);
  const psiMobile = r.site.pageSpeed?.find(p => p.strategy === 'mobile' && !p.error);

  const statusItems = Object.entries(s.statusCodes).sort((a, b) => STATUS_ORDER(a[0]) - STATUS_ORDER(b[0])).map(([k, v]) => ({
    label: k === 'blocked' ? 'Blocked (robots)' : k === 'error' ? 'Failed' : `HTTP ${k}`, value: v, key: k,
    barClass: k.startsWith('2') ? 'bg-emerald-500' : k.startsWith('3') ? 'bg-sky-500' : k === 'blocked' ? 'bg-amber-500' : 'bg-red-500',
  }));
  const depthItems = Object.entries(s.depthHist).sort((a, b) => (a[0] === 'orphan' ? 99 : +a[0]) - (b[0] === 'orphan' ? 99 : +b[0]))
    .map(([k, v]) => ({ label: k === 'orphan' ? 'Orphan' : k === '10' ? '10+' : k, value: v }));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="rounded-lg border border-border bg-card p-5 flex flex-col sm:flex-row gap-5 items-center sm:items-start">
          <ScoreRing score={r.score} grade={r.grade} size={136} label="Site health" />
          <div className="flex-1 min-w-0 w-full">
            <p className="text-xs text-muted-foreground">Site health</p>
            <p className={cn('text-xl font-semibold', tone.text)}>{tone.label}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Weighted by severity and by how many pages each issue affects. {s.htmlPages.toLocaleString()} HTML pages analysed, {s.indexable.toLocaleString()} indexable.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(['error', 'warning', 'notice'] as const).map(sev => {
                const n = sev === 'error' ? s.errors : sev === 'warning' ? s.warnings : s.notices;
                const kinds = r.issues.filter(i => i.severity === sev).length;
                const S = SEVERITY[sev];
                return (
                  <button key={sev} onClick={() => goTo('issues', { category: 'sev:' + sev })}
                    className={cn('flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer hover:opacity-80', S.bg)}>
                    <S.icon className={cn('size-4', S.text)} />
                    <span className="text-left">
                      <span className={cn('block text-base font-semibold tabular-nums leading-tight', S.text)}>{n.toLocaleString()}</span>
                      <span className="block text-[11px] text-muted-foreground">{S.label}s · {kinds} types</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
        <Section title="Category scores" icon={BarChart3}>
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {cats.map(c => (
              <button key={c.ID} onClick={() => goTo('issues', { category: c.ID })} className="text-left cursor-pointer group" title={`Show ${c.Label} issues`}>
                <p className="text-[11px] text-muted-foreground group-hover:text-foreground">{c.Label}</p>
                <MiniScore score={r.categoryScores[c.ID] ?? 100} />
              </button>
            ))}
          </div>
        </Section>
      </div>

      <div className="grid gap-2 grid-cols-2 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="URLs crawled" value={s.pagesCrawled.toLocaleString()} />
        <Stat label="Indexable" value={s.indexable.toLocaleString()} hint={`${s.nonIndexable} not`} />
        <Stat label="Redirects" value={s.redirects.toLocaleString()} />
        <Stat label="4xx / 5xx" value={`${s.clientErrors} / ${s.serverErrors}`} />
        <Stat label="Broken links" value={s.brokenLinks.toLocaleString()} />
        <Stat label="Avg. TTFB" value={`${s.avgTtfbMs} ms`} />
        <Stat label="Avg. words" value={s.avgWords.toLocaleString()} />
        <Stat label="Data transferred" value={fmtBytes(s.totalBytes)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Top issues to fix" icon={ListChecks} action={<button className="text-[11px] text-primary hover:underline cursor-pointer" onClick={() => goTo('issues')}>All issues →</button>}>
          {top.length === 0 ? <p className="text-xs text-muted-foreground">No errors or warnings — nice work.</p> : (
            <div className="divide-y divide-border -my-1">
              {top.map(i => (
                <button key={i.id} onClick={() => goTo('issues', { issue: i.id })} className="w-full flex items-center gap-2 py-2 text-left cursor-pointer hover:bg-secondary/40 -mx-2 px-2 rounded">
                  <SeverityBadge severity={i.severity} />
                  <span className="flex-1 min-w-0 text-xs truncate">{i.title}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{i.site ? 'site-wide' : `${i.count.toLocaleString()} ${i.asset ? 'assets' : 'pages'}`}</span>
                </button>
              ))}
            </div>
          )}
        </Section>
        <Section title="HTTP status codes" icon={Activity}>
          <BarList items={statusItems} onClick={k => goTo('pages', { pageFilter: 'status:' + k })} />
          <div className="mt-4">
            <p className="text-[11px] text-muted-foreground mb-1">Click depth from homepage</p>
            <Histogram items={depthItems} />
          </div>
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Server response (TTFB)" icon={Zap}>
          <Histogram items={orderBuckets(s.ttfbHist)} barClass="bg-sky-500" />
        </Section>
        <Section title="Word count per page" icon={Layers}>
          <Histogram items={orderBuckets(s.wordHist)} barClass="bg-violet-500" />
        </Section>
        <Section title="At a glance" icon={Sparkles}>
          <div className="space-y-1.5 text-xs">
            <Glance label="Lighthouse (mobile)" value={psiMobile?.scores?.performance !== undefined ? `${psiMobile.scores.performance} / 100` : 'not run'} onClick={() => goTo('performance')} />
            <Glance label="Security headers" value={`Grade ${r.site.securityGrade}`} onClick={() => goTo('site')} />
            <Glance label="TLS certificate" value={r.site.tls?.valid ? `valid, ${r.site.tls.daysLeft} days left` : r.site.tls?.error || 'n/a'} onClick={() => goTo('site')} />
            <Glance label="Sitemap URLs" value={r.site.sitemapUrls.toLocaleString()} onClick={() => goTo('site')} />
            <Glance label="Orphan pages" value={s.orphans.toLocaleString()} onClick={() => goTo('issues', { issue: 'orphan-page' })} />
            <Glance label="Duplicate titles" value={r.dupTitles.length.toLocaleString() + ' groups'} onClick={() => goTo('content')} />
            <Glance label="Tech detected" value={r.site.tech.slice(0, 3).map(t => t.name).join(', ') || '—'} onClick={() => goTo('site')} />
            <Glance label="Structured data" value={Object.keys(s.schemaTypes).slice(0, 3).join(', ') || 'none'} onClick={() => goTo('content')} />
          </div>
        </Section>
      </div>

      <CompareWithPrevious report={r} />
    </div>
  );
}

function Glance({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2 text-left cursor-pointer hover:text-primary">
      <span className="text-muted-foreground flex-1">{label}</span>
      <span className="font-medium truncate max-w-[60%] text-right">{value}</span>
    </button>
  );
}

function orderBuckets(h: Record<string, number>) {
  return Object.entries(h).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).map(([label, value]) => ({ label: label.replace('ms', ''), value }));
}

/** Score and issue deltas against the previous finished audit of the same host. */
function CompareWithPrevious({ report }: { report: AuditReport }) {
  const [prev, setPrev] = useState<AuditSummary | null>(null);
  const [prevReport, setPrevReport] = useState<AuditReport | null>(null);

  useEffect(() => {
    auditApi.list().then(list => {
      const older = list.filter(a => a.host === report.host && a.status === 'done' && a.id !== report.id && new Date(a.createdAt) < new Date(report.createdAt));
      if (older[0]) {
        setPrev(older[0]);
        auditApi.get(older[0].id).then(x => { if ('pages' in x) setPrevReport(x as AuditReport); }).catch(() => {});
      }
    }).catch(() => {});
  }, [report.id]);

  const diff = useMemo(() => {
    if (!prevReport) return null;
    const before = new Map(prevReport.issues.map(i => [i.id, i]));
    const after = new Map(report.issues.map(i => [i.id, i]));
    const rows: { title: string; severity: IssueResult['severity']; before: number; after: number }[] = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(id), a = after.get(id);
      const bn = b ? (b.site ? 1 : b.count) : 0, an = a ? (a.site ? 1 : a.count) : 0;
      if (bn !== an) rows.push({ title: (a || b)!.title, severity: (a || b)!.severity, before: bn, after: an });
    }
    return rows.sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before)).slice(0, 12);
  }, [prevReport, report]);

  if (!prev) return null;
  const delta = report.score - prev.score;
  return (
    <Section title={`Change since previous audit (${new Date(prev.createdAt).toLocaleDateString()})`} icon={GitCompare}>
      <div className="flex flex-wrap items-center gap-4 mb-3 text-xs">
        <span>Score <b className="tabular-nums">{prev.score} → {report.score}</b>{' '}
          <span className={delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : delta < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}>({delta > 0 ? '+' : ''}{delta})</span></span>
        <span>Errors <b className="tabular-nums">{prev.errors} → {report.summary.errors}</b></span>
        <span>Warnings <b className="tabular-nums">{prev.warnings} → {report.summary.warnings}</b></span>
        <span>Pages <b className="tabular-nums">{prev.pages} → {report.summary.pagesCrawled}</b></span>
      </div>
      {diff === null ? <p className="text-xs text-muted-foreground">Loading comparison…</p> : diff.length === 0 ? <p className="text-xs text-muted-foreground">Issue counts are unchanged.</p> : (
        <div className="grid gap-x-6 sm:grid-cols-2">
          {diff.map(d => (
            <div key={d.title} className="flex items-center gap-2 py-1 text-xs border-b border-border">
              <SeverityBadge severity={d.severity} />
              <span className="flex-1 min-w-0 truncate">{d.title}</span>
              <span className="tabular-nums text-muted-foreground">{d.before} →</span>
              <span className={cn('tabular-nums font-medium w-10 text-right', d.after < d.before ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{d.after}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
