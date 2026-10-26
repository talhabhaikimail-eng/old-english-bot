import React, { useState } from 'react';
import { Copy, FileText, GitBranch, Repeat, Braces } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DupGroup } from '../api';
import type { ReportCtx } from '../Report';
import { BarList, Section, StatusPill, shortUrl } from '../ui';

export function ContentTab({ ctx }: { ctx: ReportCtx }) {
  const { report: r, openPage } = ctx;
  const [dupKind, setDupKind] = useState<'title' | 'desc' | 'h1' | 'content'>('title');
  const groups: Record<typeof dupKind, DupGroup[]> = { title: r.dupTitles, desc: r.dupDescriptions, h1: r.dupH1, content: r.dupContent };
  const list = groups[dupKind];
  const schema = Object.entries(r.summary.schemaTypes).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const origin = r.site.origin;
  const UrlBtn = ({ u }: { u: string }) => (
    <button onClick={() => openPage(u)} className="block w-full text-left font-mono text-[11px] truncate hover:text-primary cursor-pointer" title={u}>{shortUrl(u, origin)}</button>
  );

  return (
    <div className="space-y-4">
      <Section title="Duplicate content" icon={Copy}
        action={<div className="inline-flex rounded-md border border-border bg-secondary p-0.5">
          {([['title', 'Titles', r.dupTitles], ['desc', 'Descriptions', r.dupDescriptions], ['h1', 'H1s', r.dupH1], ['content', 'Identical pages', r.dupContent]] as const).map(([k, l, g]) => (
            <button key={k} onClick={() => setDupKind(k)} className={cn('h-6 px-2 rounded-[5px] text-[11px] font-medium cursor-pointer', dupKind === k ? 'bg-card border border-border shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {l} <span className="opacity-60 tabular-nums">{g.length}</span>
            </button>
          ))}
        </div>}>
        {list.length === 0 ? <p className="text-xs text-muted-foreground">No duplicates among indexable pages.</p> : (
          <div className="space-y-2 max-h-[480px] overflow-auto">
            {list.slice(0, 200).map((g, i) => (
              <details key={i} className="rounded-md border border-border group" open={i < 3}>
                <summary className="px-3 py-2 text-xs cursor-pointer flex items-center gap-2 list-none">
                  <span className="shrink-0 h-5 min-w-5 px-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[11px] font-semibold flex items-center justify-center tabular-nums">{g.urls.length}</span>
                  <span className="truncate flex-1">{g.value || <em className="text-muted-foreground">untitled</em>}</span>
                </summary>
                <div className="px-3 pb-2 space-y-0.5">{g.urls.map(u => <UrlBtn key={u} u={u} />)}</div>
              </details>
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={`Near-duplicate pages (${r.nearDuplicates.length})`} icon={FileText}>
          {r.nearDuplicates.length === 0 ? <p className="text-xs text-muted-foreground">No pages are ≥ 95% similar.</p> : (
            <div className="divide-y divide-border max-h-80 overflow-auto">
              {r.nearDuplicates.slice(0, 200).map((d, i) => (
                <div key={i} className="py-1.5 flex items-center gap-2">
                  <span className="text-[11px] tabular-nums w-12 shrink-0 text-amber-600 dark:text-amber-400">{d.similarity}%</span>
                  <div className="flex-1 min-w-0"><UrlBtn u={d.a} /><UrlBtn u={d.b} /></div>
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section title="Structured data types" icon={Braces}>
          {schema.length === 0 ? <p className="text-xs text-muted-foreground">No structured data found on any page.</p> :
            <BarList items={schema.map(([k, v]) => ({ label: k, value: v }))} />}
          <p className="text-[11px] text-muted-foreground mt-2">Pages per schema.org type (JSON-LD, microdata and RDFa).</p>
        </Section>
      </div>

      <Section title={`Redirect chains & loops (${r.redirectChains.length})`} icon={Repeat}>
        {r.redirectChains.length === 0 ? <p className="text-xs text-muted-foreground">No multi-hop redirects.</p> : (
          <div className="space-y-2 max-h-96 overflow-auto">
            {r.redirectChains.map((c, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  {c.hops.map((h, j) => (
                    <React.Fragment key={j}>
                      <span className="inline-flex items-center gap-1 min-w-0"><StatusPill status={h.status} /><span className="font-mono text-[11px] truncate max-w-64" title={h.url}>{shortUrl(h.url, origin)}</span></span>
                      <GitBranch className="size-3 text-muted-foreground rotate-90" />
                    </React.Fragment>
                  ))}
                  {c.loop ? <span className="text-red-600 dark:text-red-400 font-medium">loop ↺</span> : (
                    <span className="inline-flex items-center gap-1"><StatusPill status={c.finalStatus} /><span className="font-mono text-[11px] truncate max-w-64" title={c.final}>{shortUrl(c.final, origin)}</span></span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
