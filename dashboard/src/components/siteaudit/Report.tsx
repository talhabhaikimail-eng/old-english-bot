import React, { useState } from 'react';
import { ArrowLeft, Download, ExternalLink, FileJson, FileSpreadsheet, Loader2, RotateCcw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { downloadBlob } from '../devtools/shared';
import { auditApi, type AuditReport } from './api';
import { ExtLink, fmtMs, timeAgo } from './ui';
import { Overview } from './tabs/Overview';
import { IssuesTab } from './tabs/Issues';
import { PagesTab } from './tabs/Pages';
import { LinksTab } from './tabs/Links';
import { ContentTab } from './tabs/Content';
import { SiteHealthTab } from './tabs/SiteHealth';
import { PerformanceTab } from './tabs/Performance';
import { PageDrawer } from './PageDrawer';

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'issues', label: 'Issues' },
  { id: 'pages', label: 'Pages' },
  { id: 'links', label: 'Links & assets' },
  { id: 'content', label: 'Content & duplicates' },
  { id: 'performance', label: 'Performance' },
  { id: 'site', label: 'Security & site' },
] as const;
export type TabId = typeof TABS[number]['id'];

export interface ReportCtx {
  report: AuditReport;
  openPage: (url: string) => void;
  goTo: (tab: TabId, filter?: { issue?: string; category?: string; pageFilter?: string }) => void;
}

export function Report({ report, tab, onTab, onBack, onRerun, filter }: {
  report: AuditReport;
  tab: TabId;
  onTab: (t: TabId, filter?: { issue?: string; category?: string; pageFilter?: string }) => void;
  onBack: () => void;
  onRerun: () => void;
  filter: { issue?: string; category?: string; pageFilter?: string };
}) {
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [exporting, setExporting] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const ctx: ReportCtx = { report, openPage: setPageUrl, goTo: onTab };
  const issueCount = report.issues.reduce((n, i) => n + (i.site ? 1 : i.count), 0);

  const doExport = async (type: string, format: 'csv' | 'json') => {
    setExporting(type + format);
    try {
      const { blob, name } = await auditApi.export(report.id, type, format);
      downloadBlob(blob, name);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setExporting('');
      setExportOpen(false);
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft /> All audits</Button>
        <div className="order-last basis-full min-w-0 sm:order-none sm:basis-auto sm:flex-1">
          <h2 className="text-base font-semibold tracking-tight truncate flex items-center gap-2">
            {report.host}
            <ExtLink href={report.site.finalUrl || report.startUrl} className="text-muted-foreground"><ExternalLink className="size-3.5" /></ExtLink>
          </h2>
          <p className="text-[11px] text-muted-foreground">
            {report.summary.pagesCrawled.toLocaleString()} URLs · {fmtMs(report.durationMs)} · {new Date(report.createdAt).toLocaleString()} ({timeAgo(report.createdAt)})
          </p>
        </div>
        <Button variant="outline" size="sm" className="ml-auto sm:ml-0" onClick={onRerun}><RotateCcw /> Re-run</Button>
        <div className="relative">
          <Button variant="outline" size="sm" onClick={() => setExportOpen(o => !o)}><Download /> Export</Button>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setExportOpen(false)} />
              <div className="absolute right-0 top-9 z-40 w-56 rounded-md border border-border bg-popover shadow-lg p-1 text-xs">
                {[['pages', 'All pages'], ['issues', 'Issues (one row per URL)'], ['links', 'All links'], ['resources', 'Assets & external links'], ['images', 'Images']].map(([t, l]) => (
                  <button key={t} onClick={() => doExport(t, 'csv')} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-secondary text-left cursor-pointer">
                    {exporting === t + 'csv' ? <Loader2 className="size-3.5 animate-spin" /> : <FileSpreadsheet className="size-3.5 text-primary" />} {l} (CSV)
                  </button>
                ))}
                <div className="border-t border-border my-1" />
                <button onClick={() => doExport('full', 'json')} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-secondary text-left cursor-pointer">
                  {exporting === 'fulljson' ? <Loader2 className="size-3.5 animate-spin" /> : <FileJson className="size-3.5 text-primary" />} Full report (JSON)
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {(report.status !== 'done' || report.truncated) && (
        <div className="flex items-start gap-2 text-xs rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3 py-2">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            {report.status === 'failed' ? `Audit failed: ${report.error}` : report.status === 'cancelled' ? 'Audit was stopped early — results are partial.' : ''}
            {report.truncated && ` Crawl reached the ${report.options.maxPages?.toLocaleString()}-page limit; more URLs exist. Re-run with a higher limit for full coverage.`}
          </span>
        </div>
      )}

      <nav className="flex gap-1 overflow-x-auto border-b border-border -mx-1 px-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => onTab(t.id)}
            className={cn('h-9 px-3 text-xs font-medium whitespace-nowrap border-b-2 -mb-px cursor-pointer transition-colors',
              tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {t.label}
            {t.id === 'issues' && <span className="ml-1.5 text-[10px] tabular-nums opacity-70">{issueCount.toLocaleString()}</span>}
            {t.id === 'pages' && <span className="ml-1.5 text-[10px] tabular-nums opacity-70">{report.pages.length.toLocaleString()}</span>}
          </button>
        ))}
      </nav>

      {report.status === 'failed' && report.pages.length === 0 ? null : (
        <>
          {tab === 'overview' && <Overview ctx={ctx} />}
          {tab === 'issues' && <IssuesTab ctx={ctx} initialIssue={filter.issue} initialCategory={filter.category} />}
          {tab === 'pages' && <PagesTab ctx={ctx} initialFilter={filter.pageFilter} />}
          {tab === 'links' && <LinksTab ctx={ctx} />}
          {tab === 'content' && <ContentTab ctx={ctx} />}
          {tab === 'performance' && <PerformanceTab ctx={ctx} />}
          {tab === 'site' && <SiteHealthTab ctx={ctx} />}
        </>
      )}

      {pageUrl && <PageDrawer auditId={report.id} url={pageUrl} origin={report.site.origin} onClose={() => setPageUrl(null)} onOpen={setPageUrl} />}
    </div>
  );
}
