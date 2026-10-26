import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ErrorBox } from './devtools/shared';
import { auditApi, isRunning, type AuditReport, type RunningAudit } from './siteaudit/api';
import { NewAudit } from './siteaudit/NewAudit';
import { Running } from './siteaudit/Running';
import { Report, TABS, type TabId } from './siteaudit/Report';

type Filter = { issue?: string; category?: string; pageFilter?: string };

/** `#/site-audit?id=…&tab=issues` */
function readHash(): { id: string | null; tab: TabId } {
  const q = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const tab = q.get('tab') as TabId;
  return { id: q.get('id'), tab: TABS.some(t => t.id === tab) ? tab : 'overview' };
}

function writeHash(id: string | null, tab: TabId) {
  const params = new URLSearchParams();
  if (id) params.set('id', id);
  if (id && tab !== 'overview') params.set('tab', tab);
  const next = `#/site-audit${params.toString() ? '?' + params : ''}`;
  if (window.location.hash !== next) window.history.pushState(null, '', next);
}

export default function SiteAuditPanel() {
  const [{ id, tab }, setRoute] = useState(readHash);
  const [data, setData] = useState<AuditReport | RunningAudit | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>({});
  const [reload, setReload] = useState(0);

  const navigate = useCallback((nextId: string | null, nextTab: TabId = 'overview', f: Filter = {}) => {
    writeHash(nextId, nextTab);
    setFilter(f);
    setRoute({ id: nextId, tab: nextTab });
  }, []);

  useEffect(() => {
    const onPop = () => { if (window.location.hash.startsWith('#/site-audit')) setRoute(readHash()); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop); };
  }, []);

  useEffect(() => {
    if (!id) { setData(null); return; }
    let cancelled = false;
    setError('');
    if (data?.id !== id) setData(null);
    auditApi.get(id).then(d => { if (!cancelled) setData(d); }).catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [id, reload]);

  const rerun = async () => {
    if (!data) return;
    try {
      const res = await auditApi.start({ ...data.options, url: data.startUrl });
      navigate(res.id);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      {!id && <NewAudit onStarted={i => navigate(i)} onOpen={i => navigate(i)} />}
      {id && error && (
        <div className="space-y-3">
          <ErrorBox message={error} />
          <button className="text-xs text-primary hover:underline cursor-pointer" onClick={() => navigate(null)}>← Back to audits</button>
        </div>
      )}
      {id && !error && !data && <p className="text-xs text-muted-foreground flex items-center gap-2 py-8 justify-center"><Loader2 className="size-4 animate-spin" /> Loading report…</p>}
      {id && data && isRunning(data) && (
        <Running id={data.id} url={data.startUrl} initial={data.progress} maxPages={data.options.maxPages} onDone={() => setReload(n => n + 1)} />
      )}
      {id && data && !isRunning(data) && (
        <Report report={data} tab={tab} filter={filter} onTab={(t, f) => navigate(id, t, f)} onBack={() => navigate(null)} onRerun={rerun} />
      )}
    </div>
  );
}
