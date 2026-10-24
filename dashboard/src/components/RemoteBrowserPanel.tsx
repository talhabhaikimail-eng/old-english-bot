import React, { useEffect, useRef, useState } from 'react';
import { api, type RemoteBrowserSession } from '../api';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Globe, Search, ExternalLink, Copy, Loader2, Clock, Square, ShieldCheck, TriangleAlert } from 'lucide-react';

const fmt = (secs: number) => {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * Remote browser isolation: a real Chromium runs in a throwaway container on an isolated network and is streamed here.
 * The page never runs on the dashboard origin, so a hostile site cannot reach the dashboard or its credentials.
 */
export default function RemoteBrowserPanel() {
  const [urlInput, setUrlInput] = useState('');
  const [sessions, setSessions] = useState<RemoteBrowserSession[]>([]);
  const [max, setMax] = useState(3);
  const [firewall, setFirewall] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const pollRef = useRef<number | null>(null);

  const load = async () => {
    try {
      const r = await api.listRemoteBrowsers();
      setSessions(r.sessions || []);
      setMax(r.max);
      setFirewall(r.firewall);
    } catch { /* manager offline */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => { clearInterval(t); if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const active = sessions.find(s => s.sessionId === activeId) || null;

  const start = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setStarting(true);
    setPhase('Requesting session…');
    try {
      const r = await api.startRemoteBrowser(urlInput.trim(), 30);
      setActiveId(r.sessionId);
      // Poll the deployment job: image pull + container + tunnel can take a minute on first use
      await new Promise<void>((resolve, reject) => {
        pollRef.current = window.setInterval(async () => {
          try {
            const job = await api.getGoJobStatus(r.jobId);
            setPhase(job.phase === 'completed' ? 'Ready' : `${job.phase}…`);
            if (job.status === 'done') { clearInterval(pollRef.current!); resolve(); }
            if (job.status === 'error') { clearInterval(pollRef.current!); reject(new Error(job.error || 'Session failed to start')); }
          } catch (err) { clearInterval(pollRef.current!); reject(err); }
        }, 1500);
      });
      await load();
    } catch (err: any) {
      setError(err.message);
      setActiveId(null);
    } finally {
      setStarting(false);
      setPhase('');
    }
  };

  const stop = async (id: string) => {
    if (!confirm('Close this remote browser? Everything in it is discarded.')) return;
    try { await api.stopGoDocker(id); } catch (e: any) { setError(e.message); }
    if (activeId === id) setActiveId(null);
    load();
  };

  const extend = async (id: string) => {
    try { await api.extendRemoteBrowser(id, 30); load(); } catch (e: any) { setError(e.message); }
  };

  const copyPw = async (pw: string) => {
    try { await navigator.clipboard.writeText(pw); setNote('Password copied'); setTimeout(() => setNote(''), 2000); } catch { setNote(pw); }
  };

  return (
    <Card className="border border-border bg-card flex flex-col min-h-[78vh] text-[13px]">
      {/* Address bar */}
      <div className="bg-secondary border-b border-border px-3 py-2 flex flex-wrap items-center gap-2">
        <form onSubmit={start} className="flex-1 min-w-[16rem] flex items-center gap-2">
          <div className="flex-1 flex items-center bg-background border border-input rounded-md px-2.5 h-8 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
            <Search className="w-3.5 h-3.5 text-muted-foreground mr-2 shrink-0" />
            <input
              type="text"
              className="flex-1 bg-transparent border-none outline-none text-xs text-foreground placeholder:text-muted-foreground p-0 font-mono"
              placeholder="Start URL (optional) — e.g. youtube.com"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              disabled={starting}
            />
          </div>
          <Button type="submit" size="sm" disabled={starting || sessions.length >= max}>
            {starting ? <><Loader2 className="animate-spin" /> {phase || 'Starting…'}</> : 'New browser'}
          </Button>
        </form>
        <span className="text-[11px] text-muted-foreground">{sessions.length}/{max} sessions</span>
      </div>

      {error && (
        <div className="m-3 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive flex items-start gap-2">
          <TriangleAlert className="size-3.5 shrink-0 mt-0.5" /> {error}
        </div>
      )}
      {note && <div className="mx-3 mt-2 text-xs text-muted-foreground">{note}</div>}

      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Session list */}
        <div className="lg:w-72 border-b lg:border-b-0 lg:border-r border-border p-3 space-y-2 overflow-y-auto">
          <p className="text-xs font-medium text-muted-foreground">Active sessions</p>
          {sessions.map(s => (
            <div
              key={s.sessionId}
              className={`rounded-md border p-2.5 space-y-1.5 cursor-pointer ${s.sessionId === activeId ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/40'}`}
              onClick={() => setActiveId(s.sessionId)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] truncate">{s.sessionId}</span>
                <Badge variant={s.status === 'running' ? 'default' : 'secondary'} className="capitalize text-[10px]">{s.status || 'starting'}</Badge>
              </div>
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="size-3" /> {fmt(s.remainingSeconds)} left
              </div>
              <div className="flex flex-wrap gap-1" onClick={e => e.stopPropagation()}>
                <Button size="xs" variant="outline" onClick={() => extend(s.sessionId)}>+30 min</Button>
                <Button size="xs" variant="outline" onClick={() => copyPw(s.password)}><Copy /> Password</Button>
                <Button size="xs" variant="destructive" onClick={() => stop(s.sessionId)}><Square /> Close</Button>
              </div>
            </div>
          ))}
          {!sessions.length && <p className="text-xs text-muted-foreground">No sessions yet.</p>}

          <div className="rounded-md border border-border bg-secondary/40 p-2.5 text-[11px] text-muted-foreground space-y-1">
            <p className="flex items-center gap-1.5 font-medium text-foreground"><ShieldCheck className="size-3.5" /> Isolated</p>
            <p>Runs in its own container and origin. Cannot reach this dashboard, the host or private networks.</p>
            {firewall && <p className="font-mono break-words">Firewall: {firewall}</p>}
          </div>
        </div>

        {/* Viewer */}
        <div className="flex-1 bg-background relative flex flex-col min-h-[50vh]">
          {active && active.url ? (
            <>
              <div className="px-3 py-1.5 border-b border-border flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>Sign in with user <code className="text-foreground">{active.user}</code> and the session password if prompted.</span>
                <a href={active.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline shrink-0">
                  Open in new tab <ExternalLink className="size-3" />
                </a>
              </div>
              <iframe
                key={active.sessionId}
                src={active.url}
                title="Remote browser"
                className="flex-1 w-full border-none bg-black"
                allow="clipboard-read; clipboard-write; fullscreen; autoplay"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 p-8">
              <div className="size-12 rounded-lg border border-border bg-secondary text-primary flex items-center justify-center">
                <Globe className="size-6" />
              </div>
              <CardTitle className="text-base">Remote browser</CardTitle>
              <CardDescription className="text-xs text-muted-foreground max-w-md">
                A real Chromium running in the cloud, streamed to you. Works on every site, uses the cloud runner's IP and is thrown away when you close it or the timer ends.
              </CardDescription>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
