import React, { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { CopyButton, downloadBlob } from '../../devtools/shared';
import type { ReportCtx } from '../Report';
import { Pager, shortUrl } from '../ui';

const PAGE = 50;

export function CustomSearchTab({ ctx }: { ctx: ReportCtx }) {
  const { report: r, openPage } = ctx;
  const results = r.customSearch || [];
  const extract = r.options.extract || [];
  const [sel, setSel] = useState(0);
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => { setOffset(0); setQ(''); }, [sel]);

  if (results.length === 0 && extract.length === 0) {
    return <div className="rounded-lg border border-dashed border-border p-8 text-center text-xs text-muted-foreground">This audit had no custom search or extraction rules. Add them under Crawl settings › Custom search.</div>;
  }
  const cur = results[sel];
  const urls = cur ? cur.urls.filter(u => !q || u.toLowerCase().includes(q.toLowerCase())) : [];

  return (
    <div className="space-y-4">
      {results.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div className="rounded-lg border border-border bg-card divide-y divide-border self-start">
            {results.map((x, i) => (
              <button key={i} onClick={() => setSel(i)} className={cn('w-full text-left px-3 py-2.5 cursor-pointer', sel === i ? 'bg-accent' : 'hover:bg-secondary/50')}>
                <span className="flex items-center gap-2">
                  <Search className="size-3.5 text-primary shrink-0" />
                  <span className="text-xs font-medium flex-1 truncate">{x.rule.name}</span>
                  <span className="text-xs tabular-nums">{x.matched.toLocaleString()}</span>
                </span>
                <span className="block text-[11px] text-muted-foreground truncate pl-5.5">
                  {x.rule.absent ? 'missing ' : 'contains '}<code>{x.rule.pattern}</code>{x.rule.regex ? ' (regex)' : ''}{x.rule.inText ? ' in text' : ' in HTML'}
                </span>
              </button>
            ))}
          </div>
          {cur && (
            <div className="rounded-lg border border-border bg-card p-4 space-y-3 min-w-0">
              <div>
                <h3 className="text-sm font-semibold">{cur.rule.name}</h3>
                <p className="text-[11px] text-muted-foreground">
                  {cur.matched.toLocaleString()} of {cur.checked.toLocaleString()} HTML pages {cur.rule.absent ? 'do not contain' : 'contain'} <code>{cur.rule.pattern}</code>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} placeholder="Filter URLs" className="h-7 text-xs w-52" />
                <CopyButton value={urls.join('\n')} label="Copy" />
                <Button size="xs" variant="ghost" onClick={() => downloadBlob(['URL,Occurrences', ...urls.map(u => `"${u}",${cur.counts?.[u] ?? ''}`)].join('\n'), `search-${cur.rule.name.replace(/\W+/g, '-')}.csv`, 'text/csv')}>CSV</Button>
                <span className="ml-auto"><Pager offset={offset} limit={PAGE} total={urls.length} onChange={setOffset} /></span>
              </div>
              <div className="rounded-md border border-border divide-y divide-border">
                {urls.slice(offset, offset + PAGE).map(u => (
                  <button key={u} onClick={() => openPage(u)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-secondary/40 cursor-pointer">
                    <span className="font-mono text-[11px] truncate flex-1" title={u}>{shortUrl(u, r.site.origin)}</span>
                    {cur.counts?.[u] !== undefined && <span className="text-[11px] tabular-nums text-muted-foreground">{cur.counts[u]}×</span>}
                  </button>
                ))}
                {urls.length === 0 && <p className="p-4 text-xs text-muted-foreground text-center">No pages.</p>}
              </div>
            </div>
          )}
        </div>
      )}
      {extract.length > 0 && <ExtractTable ctx={ctx} />}
    </div>
  );
}

function ExtractTable({ ctx }: { ctx: ReportCtx }) {
  const { report: r, openPage } = ctx;
  const cols = r.options.extract || [];
  const [onlyFound, setOnlyFound] = useState(true);
  const [offset, setOffset] = useState(0);
  const rows = r.pages.filter(p => p.isHtml && (!onlyFound || cols.some(c => p.extracted?.[c.name]?.length)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold flex-1">Extracted data</h3>
        <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={onlyFound} onChange={e => { setOnlyFound(e.target.checked); setOffset(0); }} /> Only pages with a value
        </label>
        <Pager offset={offset} limit={100} total={rows.length} onChange={setOffset} />
      </div>
      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-border bg-secondary/40">
            <tr>
              <th className="px-2 py-2 text-left font-medium text-muted-foreground">URL</th>
              {cols.map(c => <th key={c.name} className="px-2 py-2 text-left font-medium text-muted-foreground">{c.name}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.slice(offset, offset + 100).map(p => (
              <tr key={p.url} className="hover:bg-secondary/40 cursor-pointer" onClick={() => openPage(p.url)}>
                <td className="px-2 py-1.5 font-mono text-[11px] max-w-80 truncate" title={p.url}>{shortUrl(p.url, r.site.origin)}</td>
                {cols.map(c => <td key={c.name} className="px-2 py-1.5 max-w-72 truncate" title={p.extracted?.[c.name]?.join('\n')}>{p.extracted?.[c.name]?.join(' | ') || <span className="text-muted-foreground">—</span>}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="text-xs text-muted-foreground p-6 text-center">No values extracted.</p>}
      </div>
    </div>
  );
}
