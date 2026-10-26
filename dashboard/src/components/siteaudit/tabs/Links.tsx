import React, { useEffect, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ErrorBox } from '../../devtools/shared';
import { auditApi, type LinkRow, type Paged, type ResourceRow } from '../api';
import type { ReportCtx } from '../Report';
import { ExtLink, Pager, StatusPill, fmtBytes, shortUrl } from '../ui';

const LINK_TYPES = [
  { id: 'broken', label: 'Broken' },
  { id: 'all', label: 'All' },
  { id: 'internal', label: 'Internal' },
  { id: 'external', label: 'External' },
  { id: 'redirect', label: 'To redirects' },
  { id: 'nofollow', label: 'Nofollow' },
];
const KINDS = [
  { id: 'all', label: 'All assets' },
  { id: 'image', label: 'Images' },
  { id: 'script', label: 'JavaScript' },
  { id: 'style', label: 'CSS' },
  { id: 'external', label: 'External links' },
];
const RES_FILTERS = [
  { id: '', label: 'Any' },
  { id: 'broken', label: 'Broken' },
  { id: 'large', label: 'Large (> 200 KB)' },
  { id: 'uncached', label: 'No browser cache' },
  { id: 'redirect', label: 'Redirected' },
];

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function Pills({ value, options, onChange, counts }: { value: string; options: { id: string; label: string }[]; onChange: (v: string) => void; counts?: Record<string, number> }) {
  return (
    <div className="inline-flex flex-wrap rounded-md border border-border bg-secondary p-0.5">
      {options.map(o => (
        <button key={o.id} onClick={() => onChange(o.id)} className={cn('h-7 px-2.5 rounded-[5px] text-xs font-medium cursor-pointer',
          value === o.id ? 'bg-card border border-border shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          {o.label}{counts?.[o.id] !== undefined && <span className="ml-1 opacity-60 tabular-nums">{counts[o.id]}</span>}
        </button>
      ))}
    </div>
  );
}

export function LinksTab({ ctx }: { ctx: ReportCtx }) {
  const [mode, setMode] = useState<'links' | 'assets'>('links');
  const stats = ctx.report.resourceStats;
  const brokenAssets = Object.values(stats).reduce((n, m) => n + (m.broken || 0), 0);
  return (
    <div className="space-y-3">
      <Pills value={mode} onChange={v => setMode(v as any)} options={[{ id: 'links', label: `Hyperlinks (${ctx.report.edgeCount.toLocaleString()} internal)` }, { id: 'assets', label: `Assets & external URLs${brokenAssets ? ` · ${brokenAssets} broken` : ''}` }]} />
      {mode === 'links' ? <LinksView ctx={ctx} /> : <AssetsView ctx={ctx} />}
    </div>
  );
}

function LinksView({ ctx }: { ctx: ReportCtx }) {
  const { report: r, openPage } = ctx;
  const [type, setType] = useState('broken');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Paged<LinkRow> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const limit = 100;

  useEffect(() => { setOffset(0); }, [type, dq]);
  useEffect(() => {
    setLoading(true);
    auditApi.links(r.id, { type, q: dq, offset, limit }).then(d => { setData(d); setError(''); }).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [r.id, type, dq, offset]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pills value={type} onChange={setType} options={LINK_TYPES} />
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter by source, target or anchor…" className="pl-8 h-8 text-xs" />
        </div>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {data && <Pager offset={offset} limit={limit} total={data.total} onChange={setOffset} />}
      </div>
      {error && <ErrorBox message={error} />}
      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-xs table-fixed min-w-[860px]">
          <colgroup><col className="w-[30%]" /><col className="w-[34%]" /><col /><col className="w-16" /><col className="w-20" /></colgroup>
          <thead className="border-b border-border bg-secondary/40 text-muted-foreground">
            <tr><th className="px-2 py-2 text-left font-medium">Found on</th><th className="px-2 py-2 text-left font-medium">Link target</th><th className="px-2 py-2 text-left font-medium">Anchor text</th><th className="px-2 py-2 font-medium">Status</th><th className="px-2 py-2 font-medium">Type</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data?.rows.map((l, i) => (
              <tr key={i} className="hover:bg-secondary/40">
                <td className="px-2 py-1.5 font-mono text-[11px] truncate"><button className="hover:text-primary cursor-pointer truncate max-w-full" title={l.from} onClick={() => openPage(l.from)}>{shortUrl(l.from, r.site.origin)}</button></td>
                <td className="px-2 py-1.5 font-mono text-[11px] truncate" title={l.to + (l.redirectTo ? `\n→ ${l.redirectTo}` : '')}>
                  {l.internal ? <button className="hover:text-primary cursor-pointer truncate max-w-full" onClick={() => openPage(l.to)}>{shortUrl(l.to, r.site.origin)}</button> : <ExtLink href={l.to}>{shortUrl(l.to)}</ExtLink>}
                  {l.redirectTo && <span className="block text-[10px] text-muted-foreground truncate">→ {shortUrl(l.redirectTo, r.site.origin)}</span>}
                </td>
                <td className="px-2 py-1.5 truncate" title={l.anchor}>{l.anchor || <span className="text-muted-foreground italic">empty</span>}</td>
                <td className="px-2 py-1.5 text-center"><StatusPill status={l.status} error={l.error} /></td>
                <td className="px-2 py-1.5 text-center text-[11px] text-muted-foreground">{l.internal ? 'internal' : 'external'}{l.nofollow ? ' · nf' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.rows.length === 0 && <p className="text-xs text-muted-foreground p-6 text-center">{type === 'broken' ? 'No broken links found 🎉' : 'No links match.'}</p>}
      </div>
      {type === 'external' && <p className="text-[11px] text-muted-foreground">External sites often answer crawlers with 403/429/999; only 404, 410, 5xx and DNS/connection failures count as broken.</p>}
    </div>
  );
}

function AssetsView({ ctx }: { ctx: ReportCtx }) {
  const { report: r, openPage } = ctx;
  const [kind, setKind] = useState('all');
  const [filter, setFilter] = useState('broken');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Paged<ResourceRow> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const limit = 100;
  const counts = Object.fromEntries(KINDS.map(k => [k.id, k.id === 'all' ? Object.values(r.resourceStats).reduce((n, m) => n + (m.total || 0), 0) : r.resourceStats[k.id]?.total || 0]));

  useEffect(() => { setOffset(0); }, [kind, filter, dq]);
  useEffect(() => {
    setLoading(true);
    auditApi.resources(r.id, { kind, filter, q: dq, offset, limit }).then(d => { setData(d); setError(''); }).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [r.id, kind, filter, dq, offset]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pills value={kind} onChange={setKind} options={KINDS} counts={counts} />
        <select value={filter} onChange={e => setFilter(e.target.value)} className="h-8 rounded-md border border-input bg-card px-2 text-xs">
          {RES_FILTERS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <div className="relative flex-1 min-w-40">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter URLs…" className="pl-8 h-8 text-xs" />
        </div>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {data && <Pager offset={offset} limit={limit} total={data.total} onChange={setOffset} />}
      </div>
      {error && <ErrorBox message={error} />}
      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-xs table-fixed min-w-[860px]">
          <colgroup><col className="w-[42%]" /><col className="w-20" /><col className="w-16" /><col className="w-20" /><col /><col className="w-[18%]" /></colgroup>
          <thead className="border-b border-border bg-secondary/40 text-muted-foreground">
            <tr>{['URL', 'Type', 'Status', 'Size', 'Cache-Control', 'Used on'].map(h => <th key={h} className="px-2 py-2 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data?.rows.map(x => (
              <tr key={x.url} className="hover:bg-secondary/40">
                <td className="px-2 py-1.5 font-mono text-[11px] truncate" title={x.url + (x.redirectTo ? `\n→ ${x.redirectTo}` : '')}>
                  <ExtLink href={x.url}>{shortUrl(x.url, r.site.origin)}</ExtLink>
                  {x.error && <span className="block text-[10px] text-red-600 dark:text-red-400 truncate">{x.error}</span>}
                </td>
                <td className="px-2 py-1.5 text-muted-foreground">{x.kind}{x.compression ? ` · ${x.compression}` : ''}</td>
                <td className="px-2 py-1.5"><StatusPill status={x.status} error={x.error} /></td>
                <td className={cn('px-2 py-1.5 tabular-nums', x.size > 200 * 1024 && 'text-amber-600 dark:text-amber-400')}>{x.size ? fmtBytes(x.size) : '—'}</td>
                <td className="px-2 py-1.5 truncate text-muted-foreground font-mono text-[11px]" title={x.cacheControl}>{x.cacheControl || '—'}</td>
                <td className="px-2 py-1.5 truncate">
                  {x.foundOn?.[0] && <button className="font-mono text-[11px] hover:text-primary cursor-pointer truncate max-w-full" title={x.foundOn.join('\n')} onClick={() => openPage(x.foundOn![0])}>{shortUrl(x.foundOn[0], r.site.origin)}</button>}
                  {x.foundOnCount > 1 && <span className="text-[10px] text-muted-foreground"> +{x.foundOnCount - 1}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.rows.length === 0 && <p className="text-xs text-muted-foreground p-6 text-center">Nothing matches this filter.</p>}
      </div>
    </div>
  );
}
