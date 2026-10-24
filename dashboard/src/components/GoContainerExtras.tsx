import React, { useEffect, useState } from 'react';
import { api, BASE, type GoEvent, type GoSettings, type GoSystemInfo, type GoVolume } from '../api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  RefreshCw, Rocket, RotateCw, Square, Play, Link2, Bot, Webhook, KeyRound, Activity, Settings2, HardDrive, Trash2, TriangleAlert,
} from 'lucide-react';

export interface ControlSession {
  id: string;
  type: string;
  metadata?: {
    status?: string;
    desired?: string;
    restartCount?: number;
    oomKilled?: boolean;
    statusSince?: string;
    webhookSecret?: string;
    agentReadToken?: string;
    agentWriteToken?: string;
  };
}

const origin = () => (BASE && BASE.startsWith('http') ? BASE : window.location.origin);

export const agentUrl = (s: ControlSession, scope: 'read' | 'write') => {
  const t = scope === 'write' ? s.metadata?.agentWriteToken : s.metadata?.agentReadToken;
  return t ? `${origin()}/api/agent/${s.id}.txt?token=${t}` : '';
};
export const webhookUrl = (s: ControlSession) =>
  s.metadata?.webhookSecret ? `${origin()}/api/webhook/docker/${s.id}?secret=${s.metadata.webhookSecret}` : '';

function since(iso?: string) {
  if (!iso) return '';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

/** Always-visible lifecycle buttons + copyable access URLs for one session. */
export function SessionControls({
  session, onResult, onJob, reload,
}: {
  session: ControlSession;
  onResult: (msg: string) => void;
  onJob: (jobId: string) => void;
  reload: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const m = session.metadata || {};
  const stopped = m.desired === 'stopped';

  const run = async (action: 'start' | 'stop' | 'restart' | 'redeploy', ifChanged = false) => {
    setBusy(action);
    try {
      const res = await api.goAction(session.id, action, { ifChanged });
      onResult(res.message);
      if (res.jobId) onJob(res.jobId);
      reload();
    } catch (e: any) {
      onResult(`Error: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const copy = async (label: string, text: string) => {
    if (!text) { onResult(`${label}: not available yet`); return; }
    try { await navigator.clipboard.writeText(text); onResult(`${label} copied to clipboard`); }
    catch { onResult(text); }
  };

  const rotate = async () => {
    if (!confirm('Rotate webhook secret and agent tokens? Existing URLs will stop working.')) return;
    try { await api.goRotateTokens(session.id, 'all'); onResult('Tokens rotated'); reload(); }
    catch (e: any) { onResult(`Error: ${e.message}`); }
  };

  return (
    <div className="space-y-2 border-t border-border pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('redeploy')} title="Pull latest image and recreate">
          <Rocket /> {busy === 'redeploy' ? 'Redeploying…' : 'Redeploy'}
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('restart')}>
          <RotateCw /> Restart
        </Button>
        {stopped ? (
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('start')}><Play /> Start</Button>
        ) : (
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run('stop')} title="Stops but keeps config, data and URLs">
            <Square /> Stop
          </Button>
        )}
        <span className="mx-1 h-4 w-px bg-border" />
        <Button size="sm" variant="ghost" onClick={() => copy('Agent read URL', agentUrl(session, 'read'))} title="Plain-text report: logs, state, image info (read-only token)">
          <Bot /> Agent URL
        </Button>
        <Button size="sm" variant="ghost" onClick={() => copy('Agent control URL', agentUrl(session, 'write'))} title="Same report plus redeploy / restart / edit / exec endpoints">
          <Link2 /> Control URL
        </Button>
        <Button size="sm" variant="ghost" onClick={() => copy('Webhook URL', webhookUrl(session))} title="Hit this URL (GET/POST) to redeploy, e.g. from Docker Hub or CI">
          <Webhook /> Webhook
        </Button>
        <Button size="sm" variant="ghost" onClick={rotate} title="Rotate webhook + agent tokens"><KeyRound /></Button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>Desired: <span className="text-foreground">{m.desired || 'running'}</span></span>
        {m.statusSince && <span>In state: <span className="text-foreground">{since(m.statusSince)}</span></span>}
        {!!m.restartCount && <span>Restarts: <span className="text-foreground">{m.restartCount}</span></span>}
        {m.oomKilled && (
          <span className="text-destructive inline-flex items-center gap-1"><TriangleAlert className="size-3" /> OOM killed — raise memory limit</span>
        )}
      </div>
    </div>
  );
}

const levelVariant = (l: GoEvent['level']) =>
  l === 'error' ? 'destructive' : l === 'success' ? 'default' : 'secondary';

export function EventsTab({ sessionIds }: { sessionIds: { id: string; label: string }[] }) {
  const [events, setEvents] = useState<GoEvent[]>([]);
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState('all');
  const [err, setErr] = useState('');

  const load = async () => {
    try { setEvents(await api.getGoEvents(filter || undefined, 300)); setErr(''); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [filter]);

  const shown = events.filter(e => level === 'all' || e.level === level);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden animate-in fade-in duration-200">
      <div className="px-4 py-3 border-b border-border bg-secondary/40 flex flex-wrap items-center gap-2 justify-between">
        <h3 className="text-sm font-semibold tracking-tight flex items-center gap-2"><Activity className="size-4" /> State timeline & audit log</h3>
        <div className="flex flex-wrap items-center gap-2">
          <select value={filter} onChange={e => setFilter(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs">
            <option value="">All sessions</option>
            {sessionIds.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <select value={level} onChange={e => setLevel(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs">
            {['all', 'error', 'warn', 'success', 'info'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <Button size="sm" variant="outline" onClick={load}><RefreshCw /> Refresh</Button>
        </div>
      </div>
      <div className="max-h-[70vh] overflow-y-auto divide-y divide-border scrollbar-thin">
        {err && <div className="p-4 text-xs text-destructive">{err}</div>}
        {shown.map(e => (
          <div key={e.id} className="px-4 py-2.5 flex flex-wrap items-start gap-x-3 gap-y-1 text-xs">
            <span className="text-muted-foreground font-mono w-36 shrink-0">{new Date(e.time).toLocaleString()}</span>
            <Badge variant={levelVariant(e.level)} className="capitalize shrink-0">{e.kind.replace(/_/g, ' ')}</Badge>
            {e.name && <span className="font-mono text-[11px] text-muted-foreground shrink-0">{e.name}</span>}
            <span className="flex-1 min-w-[12rem]">{e.message}</span>
            {e.actor && <span className="text-[10px] text-muted-foreground">by {e.actor}</span>}
          </div>
        ))}
        {!shown.length && !err && <div className="p-10 text-center text-muted-foreground">No events recorded yet.</div>}
      </div>
    </div>
  );
}

export function SettingsTab({ onResult }: { onResult: (msg: string) => void }) {
  const [s, setS] = useState<GoSettings | null>(null);
  const [info, setInfo] = useState<GoSystemInfo | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try { setS(await api.getGoSettings()); } catch (e: any) { onResult(`Settings: ${e.message}`); }
    try { setInfo(await api.getGoSystemInfo()); } catch { /* daemon offline */ }
  };
  useEffect(() => { load(); }, []);

  if (!s) return <div className="p-8 text-muted-foreground">Loading settings…</div>;

  const save = async () => {
    setSaving(true);
    try { setS(await api.saveGoSettings(s)); onResult('Settings saved (synced to Cloudflare R2)'); }
    catch (e: any) { onResult(`Error: ${e.message}`); }
    finally { setSaving(false); }
  };
  const act = async (fn: () => Promise<any>, ok: (r: any) => string) => {
    try { onResult(ok(await fn())); load(); } catch (e: any) { onResult(`Error: ${e.message}`); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-in fade-in duration-200">
      <Card className="lg:col-span-7 p-5 space-y-4">
        <CardHeader className="p-0">
          <CardTitle className="text-sm font-semibold tracking-tight flex items-center gap-2"><Settings2 className="size-4" /> Alerts & automation</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Stored in <code>auth_info/go_settings.json</code>, so it comes back after the 5-hour host restart.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 space-y-3.5">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Notification webhook (Discord, Slack or any JSON endpoint)</label>
            <Input value={s.notifyUrl} onChange={e => setS({ ...s, notifyUrl: e.target.value })} placeholder="https://discord.com/api/webhooks/…" className="text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Notify from level</label>
              <select value={s.notifyMinLevel} onChange={e => setS({ ...s, notifyMinLevel: e.target.value as GoSettings['notifyMinLevel'] })} className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs">
                <option value="error">error only (crashes, failed deploys)</option>
                <option value="warn">warn + error (default)</option>
                <option value="success">success + warn + error</option>
                <option value="info">everything</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Public base URL (for copied links)</label>
              <Input value={s.publicBaseUrl} onChange={e => setS({ ...s, publicBaseUrl: e.target.value })} placeholder="https://dash.example.com" className="text-xs" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={s.autoRecover} onChange={e => setS({ ...s, autoRecover: e.target.checked })} />
            Auto-recover crashed or missing containers (backoff, gives up after 5 tries)
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={!!s.composeAllowUnsafe} onChange={e => setS({ ...s, composeAllowUnsafe: e.target.checked })} />
            Allow unsafe compose options (privileged, host network/PID, Docker socket and system path mounts)
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={s.autoBackupEnabled} onChange={e => setS({ ...s, autoBackupEnabled: e.target.checked })} />
              Auto-backup volumes to R2 every
            </label>
            <Input type="number" min={5} value={s.autoBackupIntervalMin} onChange={e => setS({ ...s, autoBackupIntervalMin: Number(e.target.value) })} className="w-20 h-8 text-xs" />
            <span className="text-xs text-muted-foreground">minutes (also on stop and shutdown)</span>
          </div>
          <div className="flex gap-2 pt-1">
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
            <Button variant="outline" onClick={() => act(() => api.testGoNotification(), () => 'Test notification sent')} disabled={!s.notifyUrl}>Send test</Button>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-5 p-5 space-y-4">
        <CardHeader className="p-0">
          <CardTitle className="text-sm font-semibold tracking-tight">System</CardTitle>
        </CardHeader>
        <CardContent className="p-0 space-y-3 text-xs">
          {info ? (
            <>
              <div className="grid grid-cols-2 gap-y-1.5 gap-x-3">
                <span className="text-muted-foreground">Docker</span><span className="font-mono">{info.dockerVersion || '—'}</span>
                <span className="text-muted-foreground">Manager uptime</span><span>{since(new Date(Date.now() - info.uptimeSeconds * 1000).toISOString())}</span>
                <span className="text-muted-foreground">Sessions</span>
                <span>{info.sessions.running}/{info.sessions.total} running{info.sessions.needAttention > 0 && <span className="text-destructive"> · {info.sessions.needAttention} need attention</span>}</span>
                <span className="text-muted-foreground">R2 state sync</span>
                <span>
                  {info.r2.lastSuccess && !info.r2.lastSuccess.startsWith('0001') ? `${since(info.r2.lastSuccess)} ago` : 'never'}
                  {info.r2.pending && ' · pending'}
                </span>
              </div>
              {info.r2.lastError && <div className="text-destructive break-words">R2 error: {info.r2.lastError}</div>}
              <div className="rounded-md bg-secondary/40 border border-border p-2 font-mono text-[11px] space-y-0.5">
                {info.diskUsage.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </>
          ) : <div className="text-muted-foreground">System info unavailable.</div>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => act(() => api.backupAllGoVolumes(), r => r.message)}>Backup all volumes now</Button>
            <Button size="sm" variant="outline" onClick={() => act(() => api.pruneGoImages(false), r => `Pruned dangling images\n${r.output}`)}>Prune images</Button>
            <Button size="sm" variant="outline" onClick={() => { if (confirm('Remove ALL unused images? They will be re-pulled when needed.')) act(() => api.pruneGoImages(true), r => `Pruned unused images\n${r.output}`); }}>Prune all unused</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Docker volumes on the host with backup status; click a row to fill the backup form. */
export function VolumesCard({ onPick, onResult }: { onPick: (name: string) => void; onResult: (msg: string) => void }) {
  const [vols, setVols] = useState<GoVolume[]>([]);
  const load = async () => { try { setVols(await api.listGoVolumes()); } catch { /* offline */ } };
  useEffect(() => { load(); }, []);

  const del = async (v: GoVolume) => {
    if (!confirm(`Delete volume ${v.name}?${v.sessionId ? ` It belongs to ${v.sessionId}.` : ''} This cannot be undone${v.backedUp ? ' (an R2 backup exists)' : ' and NO R2 backup exists'}.`)) return;
    try { await api.deleteGoVolume(v.name, !!v.sessionId); onResult(`Deleted ${v.name}`); load(); }
    catch (e: any) { onResult(`Error: ${e.message}`); }
  };

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight flex items-center gap-2"><HardDrive className="size-4" /> Volumes on this host ({vols.length})</h3>
        <Button size="sm" variant="outline" onClick={load}><RefreshCw /> Refresh</Button>
      </div>
      <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin">
        {vols.map(v => (
          <div key={v.name} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
            <button className="text-left font-mono truncate hover:underline" onClick={() => onPick(v.name)} title="Use in the backup form">{v.name}</button>
            <div className="flex items-center gap-1.5 shrink-0">
              {v.sessionId && <Badge variant="secondary" className="text-[10px]">{v.sessionId}</Badge>}
              <Badge variant={v.backedUp ? 'default' : 'destructive'} className="text-[10px]">{v.backedUp ? 'in R2' : 'not backed up'}</Badge>
              <Button size="icon-xs" variant="ghost" onClick={() => del(v)} aria-label="Delete volume"><Trash2 /></Button>
            </div>
          </div>
        ))}
        {!vols.length && <p className="text-xs text-muted-foreground">No Docker volumes on this host.</p>}
      </div>
    </Card>
  );
}
