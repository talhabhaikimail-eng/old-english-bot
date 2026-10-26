import React, { useEffect, useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ErrorBox, Stat } from '../devtools/shared';
import { auditApi, type Progress } from './api';
import { fmtMs } from './ui';

const PHASES = [
  { id: 'site', label: 'Site checks' },
  { id: 'crawl', label: 'Crawling' },
  { id: 'resources', label: 'Assets & links' },
  { id: 'pagespeed', label: 'Lighthouse' },
  { id: 'analyze', label: 'Analysis' },
];

/** Live progress for a queued/running audit; calls onDone once the server reports it finished. */
export function Running({ id, url, initial, maxPages, onDone }: { id: string; url: string; initial: Progress; maxPages?: number; onDone: () => void }) {
  const [p, setP] = useState<Progress>(initial);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await auditApi.progress(id);
        if (stop) return;
        setP(r.progress);
        setError('');
        if (r.status !== 'running' && r.status !== 'queued') { onDone(); return; }
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
      if (!stop) setTimeout(tick, 1000);
    };
    const t = setTimeout(tick, 600);
    return () => { stop = true; clearTimeout(t); };
  }, [id]);

  const phaseIdx = PHASES.findIndex(x => x.id === p.phase);
  const crawlPct = maxPages ? Math.min(100, (p.crawled / Math.max(1, Math.min(maxPages, p.discovered || maxPages))) * 100) : 0;
  const resPct = p.resourcesTotal ? (p.resourcesChecked / p.resourcesTotal) * 100 : 0;
  const pct = p.phase === 'resources' ? resPct : p.phase === 'crawl' ? crawlPct : phaseIdx > 1 ? 100 : 0;

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-5">
      <div className="flex items-start gap-3">
        <Loader2 className="size-5 animate-spin text-primary shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold tracking-tight truncate">Auditing {url.replace(/^https?:\/\//, '')}</h2>
          <p className="text-xs text-muted-foreground truncate">{p.phase === 'queued' ? 'Waiting for a free crawler slot…' : p.current || 'Starting…'}</p>
        </div>
        <Button variant="destructive" size="sm" disabled={cancelling} onClick={async () => {
          setCancelling(true);
          await auditApi.cancel(id).catch(e => setError((e as Error).message));
        }}>
          <Square /> {cancelling ? 'Stopping…' : 'Stop & keep results'}
        </Button>
      </div>

      <ol className="grid grid-cols-5 gap-1.5">
        {PHASES.map((ph, i) => (
          <li key={ph.id} className="min-w-0">
            <div className={cn('h-1.5 rounded-full', i < phaseIdx ? 'bg-primary' : i === phaseIdx ? 'bg-primary/40 overflow-hidden' : 'bg-border')}>
              {i === phaseIdx && <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${Math.max(8, pct)}%` }} />}
            </div>
            <p className={cn('mt-1 text-[11px] truncate', i <= phaseIdx ? 'text-foreground' : 'text-muted-foreground')}>{ph.label}</p>
          </li>
        ))}
      </ol>

      <div className="grid gap-2 grid-cols-2 md:grid-cols-5">
        <Stat label="Pages crawled" value={p.crawled.toLocaleString()} hint={maxPages ? `limit ${maxPages.toLocaleString()}` : undefined} />
        <Stat label="In queue" value={p.queued.toLocaleString()} />
        <Stat label="URLs discovered" value={p.discovered.toLocaleString()} />
        <Stat label="Errors so far" value={p.errors.toLocaleString()} />
        <Stat label="Elapsed" value={fmtMs(p.elapsedMs)} hint={p.pagesPerSec ? `${p.pagesPerSec} pages/s` : undefined} />
      </div>
      {p.phase === 'resources' && (
        <p className="text-xs text-muted-foreground tabular-nums">Checked {p.resourcesChecked.toLocaleString()} of {p.resourcesTotal.toLocaleString()} images, scripts, stylesheets and external links</p>
      )}
      {error && <ErrorBox message={error} />}
      {p.log && p.log.length > 0 && (
        <pre className="text-[11px] font-mono bg-secondary/50 border border-border rounded-md p-3 max-h-44 overflow-auto whitespace-pre-wrap">
          {p.log.slice(-12).join('\n')}
        </pre>
      )}
    </section>
  );
}
