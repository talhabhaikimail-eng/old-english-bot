import React, { useEffect, useMemo, useState } from 'react';
import { Search, Wrench, Lightbulb, Globe } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { CopyButton, downloadBlob } from '../../devtools/shared';
import { Button } from '@/components/ui/button';
import type { IssueResult, Severity } from '../api';
import type { ReportCtx } from '../Report';
import { ExtLink, Pager, SEVERITY, SeverityBadge, shortUrl } from '../ui';

const PAGE = 50;

export function IssuesTab({ ctx, initialIssue, initialCategory }: { ctx: ReportCtx; initialIssue?: string; initialCategory?: string }) {
  const { report: r, openPage } = ctx;
  const [sev, setSev] = useState<Severity | 'all'>(initialCategory?.startsWith('sev:') ? initialCategory.slice(4) as Severity : 'all');
  const [cat, setCat] = useState<string>(initialCategory && !initialCategory.startsWith('sev:') ? initialCategory : 'all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(initialIssue ?? null);

  const list = useMemo(() => r.issues.filter(i =>
    (sev === 'all' || i.severity === sev) && (cat === 'all' || i.category === cat) &&
    (!q || (i.title + ' ' + i.id + ' ' + i.why).toLowerCase().includes(q.toLowerCase()))), [r.issues, sev, cat, q]);

  useEffect(() => {
    if (!selected || !list.some(i => i.id === selected)) setSelected(list[0]?.id ?? null);
  }, [list]);

  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const i of r.issues) if (sev === 'all' || i.severity === sev) m[i.category] = (m[i.category] || 0) + 1;
    return m;
  }, [r.issues, sev]);
  const issue = r.issues.find(i => i.id === selected);
  const catLabel = (id: string) => r.categories.find(c => c.ID === id)?.Label ?? id;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border bg-secondary p-0.5">
          {(['all', 'error', 'warning', 'notice'] as const).map(s => {
            const n = s === 'all' ? r.issues.length : r.issues.filter(i => i.severity === s).length;
            return (
              <button key={s} onClick={() => setSev(s)} className={cn('h-7 px-2.5 rounded-[5px] text-xs font-medium cursor-pointer flex items-center gap-1.5',
                sev === s ? 'bg-card border border-border shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {s !== 'all' && React.createElement(SEVERITY[s].icon, { className: cn('size-3.5', SEVERITY[s].text) })}
                {s === 'all' ? 'All' : SEVERITY[s].label + 's'} <span className="tabular-nums opacity-60">{n}</span>
              </button>
            );
          })}
        </div>
        <select value={cat} onChange={e => setCat(e.target.value)} className="h-8 rounded-md border border-input bg-card px-2 text-xs">
          <option value="all">All categories</option>
          {r.categories.filter(c => catCounts[c.ID]).map(c => <option key={c.ID} value={c.ID}>{c.Label} ({catCounts[c.ID]})</option>)}
        </select>
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search issues…" className="pl-8 h-8 text-xs" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className="rounded-lg border border-border bg-card divide-y divide-border max-h-[70vh] overflow-auto">
          {list.length === 0 && <p className="text-xs text-muted-foreground p-4">No issues match.</p>}
          {list.map(i => (
            <button key={i.id} onClick={() => setSelected(i.id)}
              className={cn('w-full text-left px-3 py-2.5 cursor-pointer flex items-start gap-2', selected === i.id ? 'bg-accent' : 'hover:bg-secondary/50')}>
              <SeverityBadge severity={i.severity} count={i.site ? undefined : i.count} />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium leading-snug">{i.title}</span>
                <span className="block text-[11px] text-muted-foreground">{catLabel(i.category)}{i.site ? ' · site-wide' : !i.asset ? ` · ${Math.round(i.ratio * 100)}% of pages` : ' · assets'}</span>
              </span>
            </button>
          ))}
        </div>
        {issue ? <IssueDetail issue={issue} catLabel={catLabel(issue.category)} origin={r.site.origin} onOpenPage={issue.asset ? undefined : openPage} /> :
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-xs text-muted-foreground">Select an issue</div>}
      </div>
    </div>
  );
}

function IssueDetail({ issue, catLabel, origin, onOpenPage }: { issue: IssueResult; catLabel: string; origin: string; onOpenPage?: (u: string) => void }) {
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState('');
  useEffect(() => { setOffset(0); setFilter(''); }, [issue.id]);
  const urls = (issue.urls || []).filter(u => u !== 'site' && (!filter || u.toLowerCase().includes(filter.toLowerCase())));
  const S = SEVERITY[issue.severity];
  const siteDetail = issue.details?.site;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4 min-w-0">
      <div className="flex items-start gap-2">
        <S.icon className={cn('size-5 shrink-0 mt-0.5', S.text)} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-snug">{issue.title}</h3>
          <p className="text-[11px] text-muted-foreground">{S.label} · {catLabel} · <code>{issue.id}</code></p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-border bg-secondary/40 p-3">
          <p className="text-[11px] font-medium flex items-center gap-1.5 mb-1"><Lightbulb className="size-3.5 text-amber-500" /> Why it matters</p>
          <p className="text-xs text-muted-foreground">{issue.why}</p>
        </div>
        <div className="rounded-md border border-border bg-secondary/40 p-3">
          <p className="text-[11px] font-medium flex items-center gap-1.5 mb-1"><Wrench className="size-3.5 text-primary" /> How to fix</p>
          <p className="text-xs text-muted-foreground">{issue.fix}</p>
        </div>
      </div>

      {issue.site ? (
        <div className="flex items-start gap-2 text-xs rounded-md border border-border p-3">
          <Globe className="size-4 text-muted-foreground shrink-0" />
          <span className="break-words whitespace-pre-wrap">{siteDetail || 'Applies to the whole site.'}</span>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium flex-1">{issue.count.toLocaleString()} affected {issue.asset ? 'assets' : 'URLs'}</p>
            <Input value={filter} onChange={e => { setFilter(e.target.value); setOffset(0); }} placeholder="Filter URLs" className="h-7 text-xs w-44" />
            <CopyButton value={urls.join('\n')} label="Copy" />
            <Button size="xs" variant="ghost" onClick={() => downloadBlob(['URL,Detail', ...urls.map(u => `"${u}","${(issue.details?.[u] || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`)].join('\n'), `${issue.id}.csv`, 'text/csv')}>CSV</Button>
          </div>
          <div className="rounded-md border border-border divide-y divide-border">
            {urls.slice(offset, offset + PAGE).map(u => (
              <div key={u} className="px-3 py-2 text-xs min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  {onOpenPage ? (
                    <button onClick={() => onOpenPage(u)} className="font-mono text-[11px] text-left truncate hover:text-primary cursor-pointer flex-1 min-w-0" title={u}>{shortUrl(u, origin)}</button>
                  ) : <ExtLink href={u} className="font-mono text-[11px] truncate flex-1 min-w-0">{shortUrl(u, origin)}</ExtLink>}
                  <ExtLink href={u} className="text-muted-foreground text-[11px] shrink-0">open ↗</ExtLink>
                </div>
                {issue.details?.[u] && <p className="mt-0.5 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">{issue.details[u]}</p>}
              </div>
            ))}
          </div>
          <Pager offset={offset} limit={PAGE} total={urls.length} onChange={setOffset} />
          {issue.count > (issue.urls?.length || 0) && <p className="text-[11px] text-muted-foreground">Showing the first {issue.urls?.length.toLocaleString()} URLs.</p>}
        </div>
      )}
    </div>
  );
}
