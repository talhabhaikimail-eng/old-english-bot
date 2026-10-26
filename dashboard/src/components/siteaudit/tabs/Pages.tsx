import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { PageRow } from '../api';
import type { ReportCtx } from '../Report';
import { Pager, StatusPill, shortUrl } from '../ui';

type Col = { key: keyof PageRow | 'issueCount'; label: string; num?: boolean; width?: string; render?: (p: PageRow) => React.ReactNode; title?: string };

const FILTERS: { id: string; label: string; test: (p: PageRow) => boolean }[] = [
  { id: 'all', label: 'All URLs', test: () => true },
  { id: 'html', label: 'HTML pages', test: p => p.isHtml },
  { id: 'indexable', label: 'Indexable', test: p => p.indexable },
  { id: 'nonindexable', label: 'Non-indexable', test: p => !p.indexable },
  { id: 'redirects', label: 'Redirects', test: p => p.status >= 300 && p.status < 400 },
  { id: 'errors', label: '4xx / 5xx / failed', test: p => p.status >= 400 || !!p.error },
  { id: 'blocked', label: 'Blocked by robots', test: p => !!p.blocked },
  { id: 'orphans', label: 'Orphans', test: p => p.depth < 0 && p.isHtml },
  { id: 'thin', label: 'Thin (< 200 words)', test: p => p.isHtml && p.words < 200 },
  { id: 'slow', label: 'Slow (TTFB > 800ms)', test: p => p.ttfbMs > 800 },
  { id: 'with-issues', label: 'With errors/warnings', test: p => p.issues.length > 0 },
];

export function PagesTab({ ctx, initialFilter }: { ctx: ReportCtx; initialFilter?: string }) {
  const { report: r, openPage } = ctx;
  const statusFilter = initialFilter?.startsWith('status:') ? initialFilter.slice(7) : '';
  const [filter, setFilter] = useState(statusFilter ? 'status' : 'all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: Col['key']; dir: 1 | -1 }>({ key: 'linkScore', dir: -1 });
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<'seo' | 'tech' | 'links'>('seo');
  const limit = 100;
  const sevOf = useMemo(() => Object.fromEntries(r.issues.map(i => [i.id, i.severity])), [r.issues]);

  const columns: Record<typeof view, Col[]> = {
    seo: [
      { key: 'title', label: 'Title', render: p => <Len text={p.title} len={p.titleLen} min={30} max={60} /> },
      { key: 'descLen', label: 'Description', render: p => <Len text={p.description} len={p.descLen} min={70} max={160} /> },
      { key: 'h1', label: 'H1', render: p => <span className={cn('truncate block', p.h1Count !== 1 && p.isHtml && 'text-amber-600 dark:text-amber-400')} title={p.h1}>{p.h1Count > 1 ? `(${p.h1Count}) ` : ''}{p.h1 || (p.isHtml ? '—' : '')}</span> },
      { key: 'words', label: 'Words', num: true },
      { key: 'indexable', label: 'Index', render: p => p.indexable ? <span className="text-emerald-600 dark:text-emerald-400">Yes</span> : <span className="text-muted-foreground" title={p.indexReason}>{p.indexReason || 'No'}</span> },
    ],
    tech: [
      { key: 'ttfbMs', label: 'TTFB', num: true, render: p => <span className={cn(p.ttfbMs > 800 && 'text-red-600 dark:text-red-400')}>{p.ttfbMs}</span> },
      { key: 'loadMs', label: 'Load ms', num: true },
      { key: 'sizeKb', label: 'KB', num: true },
      { key: 'contentType', label: 'Type' },
      { key: 'canonical', label: 'Canonical', render: p => <span className="truncate block font-mono text-[11px]" title={p.canonical}>{p.canonical ? (p.canonical === p.url ? 'self' : shortUrl(p.canonical, r.site.origin)) : '—'}</span> },
      { key: 'redirectTo', label: 'Redirects to', render: p => <span className="truncate block font-mono text-[11px]" title={p.redirectTo}>{p.redirectTo ? shortUrl(p.redirectTo, r.site.origin) : ''}</span> },
    ],
    links: [
      { key: 'depth', label: 'Depth', num: true, render: p => p.depth < 0 ? <span className="text-amber-600 dark:text-amber-400">orphan</span> : p.depth },
      { key: 'inlinks', label: 'Inlinks', num: true },
      { key: 'outlinks', label: 'Outlinks', num: true },
      { key: 'external', label: 'External', num: true },
      { key: 'linkScore', label: 'Link score', num: true, title: 'Internal PageRank, 0–100' },
      { key: 'inSitemap', label: 'Sitemap', render: p => p.inSitemap ? 'Yes' : '' },
      { key: 'images', label: 'Images', num: true },
    ],
  };
  const cols = columns[view];

  const rows = useMemo(() => {
    const f = FILTERS.find(x => x.id === filter);
    const needle = q.toLowerCase();
    let out = r.pages.filter(p => {
      if (filter === 'status') {
        if (statusFilter === 'blocked') { if (!p.blocked) return false; }
        else if (statusFilter === 'error') { if (!p.error) return false; }
        else if (String(p.status) !== statusFilter || p.blocked || p.error) return false;
      } else if (f && !f.test(p)) return false;
      return !needle || (p.url + ' ' + (p.title || '') + ' ' + (p.h1 || '')).toLowerCase().includes(needle);
    });
    const k = sort.key;
    out = [...out].sort((a, b) => {
      const av = k === 'issueCount' ? a.issues.length : (a as any)[k];
      const bv = k === 'issueCount' ? b.issues.length : (b as any)[k];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * sort.dir;
    });
    return out;
  }, [r.pages, filter, q, sort, statusFilter]);

  const header = (c: Col) => (
    <th key={c.key} title={c.title} className={cn('px-2 py-2 font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:text-foreground', c.num && 'text-right')}
      onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : (c.num ? -1 : 1) }))}>
      {c.label}{sort.key === c.key && (sort.dir === 1 ? <ArrowUp className="inline size-3 ml-0.5" /> : <ArrowDown className="inline size-3 ml-0.5" />)}
    </th>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={filter} onChange={e => { setFilter(e.target.value); setOffset(0); }} className="h-8 rounded-md border border-input bg-card px-2 text-xs">
          {statusFilter && <option value="status">Status {statusFilter}</option>}
          {FILTERS.map(f => <option key={f.id} value={f.id}>{f.label} ({r.pages.filter(f.test).length})</option>)}
        </select>
        <div className="inline-flex rounded-md border border-border bg-secondary p-0.5">
          {(['seo', 'tech', 'links'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} className={cn('h-7 px-2.5 rounded-[5px] text-xs font-medium cursor-pointer', view === v ? 'bg-card border border-border shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {v === 'seo' ? 'On-page' : v === 'tech' ? 'Technical' : 'Links'}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} placeholder="Filter by URL, title or H1…" className="pl-8 h-8 text-xs" />
        </div>
        <Pager offset={offset} limit={limit} total={rows.length} onChange={setOffset} />
      </div>
      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-xs table-fixed min-w-[900px]">
          <colgroup>
            <col className="w-[30%]" /><col className="w-14" />
            {cols.map(c => <col key={c.key} className={c.num ? 'w-20' : undefined} />)}
            <col className="w-20" />
          </colgroup>
          <thead className="border-b border-border bg-secondary/40">
            <tr>
              {header({ key: 'url', label: 'URL' })}
              {header({ key: 'status', label: 'Status', num: true })}
              {cols.map(header)}
              {header({ key: 'issueCount', label: 'Issues', num: true })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.slice(offset, offset + limit).map(p => {
              const errs = p.issues.filter(i => sevOf[i] === 'error').length;
              const warns = p.issues.filter(i => sevOf[i] === 'warning').length;
              return (
                <tr key={p.url} className="hover:bg-secondary/40 cursor-pointer" onClick={() => openPage(p.url)}>
                  <td className="px-2 py-1.5 font-mono text-[11px] truncate" title={p.url}>{shortUrl(p.url, r.site.origin)}</td>
                  <td className="px-2 py-1.5 text-right"><StatusPill status={p.status} error={p.error} blocked={p.blocked} /></td>
                  {cols.map(c => (
                    <td key={c.key} className={cn('px-2 py-1.5 truncate', c.num && 'text-right tabular-nums')}>
                      {c.render ? c.render(p) : String((p as any)[c.key] ?? '')}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {errs > 0 && <span className="text-red-600 dark:text-red-400 mr-1.5" title="errors">{errs}</span>}
                    {warns > 0 && <span className="text-amber-600 dark:text-amber-400 mr-1.5" title="warnings">{warns}</span>}
                    <span className="text-muted-foreground" title="all issues">{p.issues.length}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="text-xs text-muted-foreground p-6 text-center">No URLs match.</p>}
      </div>
    </div>
  );
}

function Len({ text, len, min, max }: { text?: string; len: number; min: number; max: number }) {
  if (!text) return <span className="text-red-600 dark:text-red-400">missing</span>;
  const bad = len > max || len < min;
  return (
    <span className="flex items-center gap-1.5 min-w-0" title={text}>
      <span className={cn('shrink-0 tabular-nums text-[10px] px-1 rounded', bad ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400')}>{len}</span>
      <span className="truncate">{text}</span>
    </span>
  );
}
