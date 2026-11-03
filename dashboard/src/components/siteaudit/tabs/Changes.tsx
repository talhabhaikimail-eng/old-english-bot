import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Loader2, Minus, Plus, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ErrorBox } from '../../devtools/shared';
import { auditApi, type AuditSummary, type Comparison, type IssueDiff } from '../api';
import type { ReportCtx } from '../Report';
import { SEVERITY, Section, StatusPill, shortUrl, timeAgo } from '../ui';

export function ChangesTab({ ctx }: { ctx: ReportCtx }) {
  const { report: r, openPage } = ctx;
  const [audits, setAudits] = useState<AuditSummary[] | null>(null);
  const [base, setBase] = useState('');
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const others = useMemo(() => (audits || []).filter(a => a.host === r.host && a.id !== r.id && a.status === 'done'), [audits, r]);
  useEffect(() => { auditApi.list().then(setAudits).catch(e => setError((e as Error).message)); }, []);
  useEffect(() => {
    if (!audits) return;
    if (others.length === 0) { setCmp(null); return; }
    const target = base || (others.find(a => new Date(a.createdAt) < new Date(r.createdAt)) ?? others[0]).id;
    if (!base) { setBase(target); return; }
    setLoading(true); setError('');
    auditApi.compare(r.id, target).then(setCmp).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [audits, base, others, r]);

  if (error) return <ErrorBox message={error} />;
  if (!audits) return <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading audits…</p>;
  if (others.length === 0) {
    return <div className="rounded-lg border border-dashed border-border p-8 text-center text-xs text-muted-foreground">No other finished audit of {r.host} to compare with. Re-run this audit later to track what changed.</div>;
  }
  const olderFirst = cmp && new Date(cmp.base.createdAt) < new Date(cmp.current.createdAt);
  const label = (a: AuditSummary) => `${new Date(a.createdAt).toLocaleString()} · score ${a.score} · ${a.pages} pages`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Compare this audit with</span>
        <select value={base} onChange={e => setBase(e.target.value)} className="h-8 rounded-md border border-input bg-card px-2 text-xs max-w-full">
          {others.map(a => <option key={a.id} value={a.id}>{label(a)} ({timeAgo(a.createdAt)})</option>)}
        </select>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>
      {cmp && (
        <>
          {!olderFirst && <p className="text-[11px] text-amber-600 dark:text-amber-400">The selected audit is newer than this one — "new" and "fixed" are relative to it.</p>}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Delta label="Score" from={cmp.base.score} to={cmp.current.score} higherIsBetter />
            <Delta label="Errors" from={cmp.base.errors} to={cmp.current.errors} />
            <Delta label="Warnings" from={cmp.base.warnings} to={cmp.current.warnings} />
            <Delta label="Pages" from={cmp.base.pages} to={cmp.current.pages} neutral />
          </div>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
            <Section title={`Issue changes (${cmp.issues.length})`}>
              <p className="text-[11px] text-muted-foreground -mt-1 mb-2">{cmp.newIssues} new issue types, {cmp.fixedIssues} fully resolved.</p>
              {cmp.notCompared?.length > 0 && (
                <p className="text-[11px] text-muted-foreground mb-2" title={cmp.notCompared.join('\n')}>
                  Not compared ({cmp.notCompared.length}) — these checks only ran in one of the audits: {cmp.notCompared.slice(0, 3).join(', ')}{cmp.notCompared.length > 3 ? '…' : ''}
                </p>
              )}
              {cmp.issues.length === 0 && <p className="text-xs text-muted-foreground">No issue changes.</p>}
              <div className="divide-y divide-border -mx-4 -mb-4">
                {cmp.issues.map(d => <IssueRow key={d.id} d={d} origin={r.site.origin} openPage={openPage} />)}
              </div>
            </Section>
            <div className="space-y-4">
              <Section title="Category scores">
                <div className="space-y-1">
                  {r.categories.map(c => {
                    const [a, b] = cmp.categories[c.ID] || [0, 0];
                    return (
                      <div key={c.ID} className="flex items-center gap-2 text-xs">
                        <span className="flex-1 truncate">{c.Label}</span>
                        <span className="tabular-nums text-muted-foreground">{a}</span>
                        <ArrowRight className="size-3 text-muted-foreground" />
                        <span className="tabular-nums w-7 text-right">{b}</span>
                        <span className={cn('tabular-nums w-9 text-right', b > a ? 'text-emerald-600 dark:text-emerald-400' : b < a ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>{b - a > 0 ? '+' : ''}{b - a || ''}</span>
                      </div>
                    );
                  })}
                </div>
              </Section>
              <UrlList title="New URLs" count={cmp.addedCount} urls={cmp.added} origin={r.site.origin} onOpen={openPage} />
              <UrlList title="URLs no longer found" count={cmp.removedCount} urls={cmp.removed} origin={r.site.origin} />
              {cmp.statusChanges.length > 0 && (
                <Section title={`Status code changes (${cmp.statusChanges.length})`}>
                  <div className="space-y-1 max-h-64 overflow-auto">
                    {cmp.statusChanges.map(s => (
                      <button key={s.url} onClick={() => openPage(s.url)} className="w-full flex items-center gap-1.5 text-left cursor-pointer hover:text-primary">
                        <span className="font-mono text-[11px] truncate flex-1" title={s.url}>{shortUrl(s.url, r.site.origin)}</span>
                        <StatusPill status={s.from} /><ArrowRight className="size-3 text-muted-foreground" /><StatusPill status={s.to} />
                      </button>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Delta({ label, from, to, higherIsBetter, neutral }: { label: string; from: number; to: number; higherIsBetter?: boolean; neutral?: boolean }) {
  const d = to - from;
  const good = neutral ? null : higherIsBetter ? d > 0 : d < 0;
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums flex items-center gap-2">
        {to.toLocaleString()}
        {d !== 0 && (
          <span className={cn('text-xs font-medium inline-flex items-center gap-0.5', good === null ? 'text-muted-foreground' : good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
            {d > 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}{d > 0 ? '+' : ''}{d.toLocaleString()}
          </span>
        )}
      </p>
      <p className="text-[11px] text-muted-foreground">was {from.toLocaleString()}</p>
    </div>
  );
}

function IssueRow({ d, origin, openPage }: { d: IssueDiff; origin: string; openPage: (u: string) => void }) {
  const [open, setOpen] = useState(false);
  const S = SEVERITY[d.severity];
  const urls = (list: string[]) => list.filter(u => u !== 'site');
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-secondary/40 cursor-pointer">
        <S.icon className={cn('size-3.5 shrink-0', S.text)} />
        <span className="text-xs flex-1 min-w-0 truncate">{d.title}</span>
        {d.before === 0 && <span className="text-[10px] rounded px-1 bg-red-500/10 text-red-600 dark:text-red-400">new</span>}
        {d.after === 0 && <span className="text-[10px] rounded px-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">resolved</span>}
        <span className="text-[11px] tabular-nums text-muted-foreground w-16 text-right">{d.site ? '' : `${d.before} → ${d.after}`}</span>
        {d.newCount > 0 && !d.site && <span className="text-[11px] tabular-nums text-red-600 dark:text-red-400 inline-flex items-center"><Plus className="size-3" />{d.newCount}</span>}
        {d.fixedCount > 0 && !d.site && <span className="text-[11px] tabular-nums text-emerald-600 dark:text-emerald-400 inline-flex items-center"><Minus className="size-3" />{d.fixedCount}</span>}
      </button>
      {open && !d.site && (
        <div className="px-4 pb-3 grid gap-3 md:grid-cols-2 text-[11px]">
          {[['Newly affected', urls(d.new), d.newCount], ['Fixed', urls(d.fixed), d.fixedCount]].map(([title, list, n]) => (
            <div key={title as string}>
              <p className="font-medium mb-1">{title as string} ({(n as number).toLocaleString()})</p>
              {(list as string[]).slice(0, 50).map(u => (
                <button key={u} onClick={() => openPage(u)} className="block w-full text-left font-mono truncate hover:text-primary cursor-pointer" title={u}>{shortUrl(u, origin)}</button>
              ))}
              {(n as number) > 50 && <p className="text-muted-foreground">…and {((n as number) - 50).toLocaleString()} more</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UrlList({ title, count, urls, origin, onOpen }: { title: string; count: number; urls: string[]; origin: string; onOpen?: (u: string) => void }) {
  if (count === 0) return null;
  return (
    <Section title={`${title} (${count.toLocaleString()})`}>
      <div className="space-y-0.5 max-h-48 overflow-auto">
        {urls.map(u => onOpen ? (
          <button key={u} onClick={() => onOpen(u)} className="block w-full text-left font-mono text-[11px] truncate hover:text-primary cursor-pointer" title={u}>{shortUrl(u, origin)}</button>
        ) : <p key={u} className="font-mono text-[11px] truncate text-muted-foreground" title={u}>{shortUrl(u, origin)}</p>)}
        {count > urls.length && <p className="text-[11px] text-muted-foreground">…and {(count - urls.length).toLocaleString()} more</p>}
      </div>
    </Section>
  );
}
