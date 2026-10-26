import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, Loader2, Play, Power, Sparkles, Trash2, XCircle, AlertTriangle, Cpu, FileText, Braces } from 'lucide-react';
import { BASE, authFetch } from '../api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Checkbox, CopyButton, ErrorBox, FieldLabel, InfoBox, NumberField, Segmented, Stat } from './devtools/shared';

interface ModelStatus {
  status: 'absent' | 'downloaded' | 'downloading' | 'loading' | 'ready' | 'error';
  error?: string | null;
  downloaded_bytes: number;
  total_bytes: number;
  load_seconds?: number | null;
  model: string;
  threads: number;
  disk_bytes: number;
}
interface SetupStatus {
  phase: 'idle' | 'installing' | 'starting' | 'running' | 'error';
  step: string;
  error: string;
  log: string[];
  installed: boolean;
  model: ModelStatus | null;
  home: string;
}
interface ExtractResult {
  fetched?: { url: string; status: number; ms: number; bytes: number };
  structured: Record<string, any>;
  text: string;
  stats: { html_chars: number; text_chars: number; html_tokens: number; text_tokens: number; reduction: number; estimated?: boolean };
  timings: { structured_ms: number; clean_ms: number; model_ms?: number };
  model: null | {
    output: any; raw?: string; valid: boolean; errors: string[]; ungrounded?: string[]; retried?: boolean;
    input_tokens?: number; output_tokens?: number; text_truncated?: boolean; tokens_per_second?: number;
  };
}

const TEMPLATES: Record<string, object> = {
  Product: { name: '', brand: '', price: '', currency: '', availability: '', description: '', features: [], rating: '', review_count: '' },
  Article: { title: '', author: '', published_date: '', summary: '', topics: [], quotes: [] },
  'Job posting': { job_title: '', company: '', location: '', employment_type: '', salary: '', requirements: [], responsibilities: [], how_to_apply: '' },
  'Contact info': { organization: '', emails: [], phone_numbers: [], address: '', social_profiles: [] },
  Event: { name: '', date: '', time: '', venue: '', address: '', price: '', organizer: '' },
  Recipe: { name: '', servings: '', prep_time: '', cook_time: '', ingredients: [], steps: [] },
  Company: { name: '', tagline: '', products_or_services: [], founders: [], headquarters: '', founded: '' },
  'People / team': { people: [{ name: '', role: '', bio: '' }] },
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await authFetch(`${BASE}/api/extract${path}`, init);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error((j as any).error || `HTTP ${r.status}`);
  return j as T;
}

const mb = (n: number) => `${(n / (1 << 20)).toFixed(0)} MB`;

export default function ExtractorPanel() {
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [stErr, setStErr] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = () => call<SetupStatus>('/status').then(s => { setSt(s); setStErr(''); }).catch(e => setStErr(e.message));
  const active = !!st && (st.phase === 'installing' || st.phase === 'starting' || st.model?.status === 'downloading' || st.model?.status === 'loading');
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, active ? 1500 : 8000);
    return () => clearInterval(t);
  }, [active]);

  const act = async (name: string, path: string, method = 'POST') => {
    setBusy(name);
    try { await call(path, { method }); await refresh(); } catch (e) { alert((e as Error).message); } finally { setBusy(''); }
  };

  const ready = st?.model?.status === 'ready';
  const serverUp = st?.phase === 'running' && !!st.model;

  return (
    <div className="space-y-4 min-w-0">
      <SetupCard st={st} error={stErr} busy={busy} active={active}
        onSetup={() => act('setup', '/setup')} onStop={() => act('stop', '/stop')}
        onDelete={() => confirm('Delete the downloaded model files?') && act('delete', '/model', 'DELETE')} />
      <ExtractCard ready={ready} serverUp={serverUp} />
    </div>
  );
}

function SetupCard({ st, error, busy, active, onSetup, onStop, onDelete }: {
  st: SetupStatus | null; error: string; busy: string; active: boolean;
  onSetup: () => void; onStop: () => void; onDelete: () => void;
}) {
  const m = st?.model;
  const pct = m && m.total_bytes ? Math.min(100, (m.downloaded_bytes / m.total_bytes) * 100) : 0;
  const ready = m?.status === 'ready';
  let headline = 'Not installed';
  if (st?.phase === 'installing') headline = st.step || 'Installing Python packages…';
  else if (st?.phase === 'starting') headline = 'Starting extraction server…';
  else if (m?.status === 'downloading') headline = `Downloading model — ${mb(m.downloaded_bytes)} of ${mb(m.total_bytes)}`;
  else if (m?.status === 'loading') headline = 'Loading model into memory…';
  else if (ready) headline = `Ready — loaded in ${m!.load_seconds}s, ${m!.threads} CPU threads`;
  else if (m?.status === 'downloaded') headline = 'Model downloaded, not loaded';
  else if (st?.phase === 'running') headline = 'Server running — model not downloaded';
  else if (st?.phase === 'error') headline = 'Setup failed';
  else if (st?.installed) headline = 'Python environment installed — server stopped';

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="size-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0"><Sparkles className="size-5 text-primary" /></div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold tracking-tight">AI Web Extractor · NuExtract-1.5-tiny</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            numind/NuExtract-1.5-tiny (0.5B, Qwen2.5, MIT). Give it a JSON template and it fills it from any page. It runs on the bridge server
            (GitHub Actions runner), and nothing is downloaded until you click <b>Download &amp; set up</b>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!ready && (
            <Button onClick={onSetup} disabled={active || busy === 'setup'}>
              {active || busy === 'setup' ? <Loader2 className="animate-spin" /> : <Download />} {active ? 'Setting up…' : 'Download & set up'}
            </Button>
          )}
          {st?.phase === 'running' && <Button variant="outline" onClick={onStop} disabled={!!busy}><Power /> Stop server</Button>}
          {m && (m.status === 'ready' || m.status === 'downloaded') && <Button variant="destructive" onClick={onDelete} disabled={!!busy}><Trash2 /> Delete model</Button>}
        </div>
      </div>

      {error && <ErrorBox message={error} />}
      <div className="rounded-md border border-border bg-secondary/40 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs">
          {ready ? <CheckCircle2 className="size-4 text-emerald-500" /> : st?.phase === 'error' || m?.status === 'error' ? <XCircle className="size-4 text-red-500" /> :
            active ? <Loader2 className="size-4 animate-spin text-primary" /> : <Cpu className="size-4 text-muted-foreground" />}
          <span className="font-medium">{headline}</span>
        </div>
        {m?.status === 'downloading' && (
          <div className="h-2 rounded-full bg-border overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
        )}
        {(st?.error || m?.error) && <p className="text-[11px] text-red-600 dark:text-red-400 break-all">{st?.error || m?.error}</p>}
        <ol className="grid gap-1 sm:grid-cols-4 text-[11px] text-muted-foreground">
          <Step done={!!st?.installed} active={st?.phase === 'installing'}>Python env + PyTorch CPU</Step>
          <Step done={st?.phase === 'running'} active={st?.phase === 'starting'}>Extraction server</Step>
          <Step done={!!m && ['downloaded', 'loading', 'ready'].includes(m.status)} active={m?.status === 'downloading'}>Download model (~1 GB)</Step>
          <Step done={ready} active={m?.status === 'loading'}>Load into RAM</Step>
        </ol>
      </div>
      {st && st.log.length > 0 && (
        <details open={active}>
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">Setup log</summary>
          <pre className="mt-2 text-[11px] font-mono bg-secondary/50 border border-border rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap">{st.log.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}

function Step({ done, active, children }: { done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <li className={cn('flex items-center gap-1.5', done && 'text-foreground')}>
      {done ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : active ? <Loader2 className="size-3.5 animate-spin text-primary" /> : <span className="size-3.5 rounded-full border border-border" />}
      {children}
    </li>
  );
}

function ExtractCard({ ready, serverUp }: { ready: boolean; serverUp: boolean }) {
  const [mode, setMode] = useState<'url' | 'html'>('url');
  const [url, setUrl] = useState('');
  const [html, setHtml] = useState('');
  const [preset, setPreset] = useState('Product');
  const [template, setTemplate] = useState(JSON.stringify(TEMPLATES.Product, null, 2));
  const [useModel, setUseModel] = useState(true);
  const [maxIn, setMaxIn] = useState(6000);
  const [maxOut, setMaxOut] = useState(1024);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [res, setRes] = useState<ExtractResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<number>();

  let templateError = '';
  try { const t = JSON.parse(template); if (typeof t !== 'object' || Array.isArray(t)) templateError = 'Template must be a JSON object'; } catch (e) { templateError = (e as Error).message; }

  const go = async () => {
    setRunning(true); setError(''); setRes(null);
    const t0 = Date.now();
    timer.current = window.setInterval(() => setElapsed(Date.now() - t0), 250);
    try {
      const r = await call<ExtractResult>('/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: mode === 'url' ? url : undefined, html: mode === 'html' ? html : undefined, template, useModel: useModel && ready, maxInputTokens: maxIn, maxNewTokens: maxOut }),
      });
      setRes(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      clearInterval(timer.current);
      setElapsed(Date.now() - t0);
      setRunning(false);
    }
  };

  const canRun = serverUp && !running && (mode === 'url' ? !!url.trim() : !!html.trim()) && (!useModel || !ready || !templateError);

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 min-w-0">
          <Segmented value={mode} onChange={setMode} options={[{ value: 'url', label: 'From URL' }, { value: 'html', label: 'Paste HTML' }]} />
          {mode === 'url' ? (
            <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/product/123" onKeyDown={e => e.key === 'Enter' && canRun && go()} />
          ) : (
            <textarea value={html} onChange={e => setHtml(e.target.value)} rows={8} placeholder="<html>…</html>"
              className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs font-mono" />
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-2 items-center">
            <Checkbox checked={useModel} onChange={setUseModel}>Run NuExtract on the cleaned text</Checkbox>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Max input tokens" value={maxIn} min={256} max={30000} step={500} onChange={setMaxIn} />
            <NumberField label="Max output tokens" value={maxOut} min={32} max={4000} step={128} onChange={setMaxOut} />
          </div>
          {!serverUp && <InfoBox>Set up the extractor above first. Once the server is up, the structured-data and clean-text steps work while the model is still downloading.</InfoBox>}
          {serverUp && useModel && !ready && <InfoBox>The model isn't loaded yet, so this run only extracts structured data and clean text.</InfoBox>}
          <Button size="lg" onClick={go} disabled={!canRun}>
            {running ? <Loader2 className="animate-spin" /> : <Play />} {running ? `Extracting… ${(elapsed / 1000).toFixed(1)}s` : 'Extract'}
          </Button>
        </div>
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={
            <select value={preset} onChange={e => { setPreset(e.target.value); setTemplate(JSON.stringify(TEMPLATES[e.target.value], null, 2)); }}
              className="h-7 rounded-md border border-input bg-card px-2 text-xs">
              {Object.keys(TEMPLATES).map(k => <option key={k}>{k}</option>)}
            </select>
          }>JSON template ("" = text, [] = list)</FieldLabel>
          <textarea value={template} onChange={e => setTemplate(e.target.value)} rows={14} spellCheck={false}
            className={cn('w-full rounded-md border bg-card px-2 py-1.5 text-xs font-mono', templateError ? 'border-red-500/60' : 'border-input')} />
          {templateError && <p className="text-[11px] text-red-600 dark:text-red-400">{templateError}</p>}
        </div>
      </div>

      {error && <ErrorBox message={error} />}
      {res && <Results res={res} />}
    </section>
  );
}

function Results({ res }: { res: ExtractResult }) {
  const [view, setView] = useState<'model' | 'structured' | 'text'>(res.model ? 'model' : 'structured');
  const s = res.stats;
  const structuredCount = Object.values(res.structured || {}).reduce((n: number, v: any) => n + (Array.isArray(v) ? v.length : 0), 0);
  const m = res.model;
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="grid gap-2 grid-cols-2 md:grid-cols-6">
        {res.fetched && <Stat label="Fetch" value={`${res.fetched.ms} ms`} hint={`HTTP ${res.fetched.status} · ${(res.fetched.bytes / 1024).toFixed(0)} KB`} />}
        <Stat label="Structured data" value={`${res.timings.structured_ms} ms`} hint={`${structuredCount} item(s)`} />
        <Stat label="Clean → Markdown" value={`${res.timings.clean_ms} ms`} hint={`${s.html_tokens.toLocaleString()} → ${s.text_tokens.toLocaleString()} tokens${s.estimated ? ' (est.)' : ''}`} />
        <Stat label="Token reduction" value={`${s.reduction}×`} />
        {res.timings.model_ms !== undefined && <Stat label="NuExtract" value={`${(res.timings.model_ms / 1000).toFixed(1)} s`} hint={m?.tokens_per_second ? `${m.tokens_per_second} tok/s · ${m.output_tokens} out` : undefined} />}
        {m && <Stat label="Validation" value={m.valid ? 'Valid' : 'Issues'} hint={m.retried ? 'retried once' : undefined} />}
      </div>
      <Segmented value={view} onChange={setView} options={[
        ...(m ? [{ value: 'model' as const, label: 'Model output' }] : []),
        { value: 'structured' as const, label: `Embedded data (${structuredCount})` },
        { value: 'text' as const, label: 'Cleaned text' },
      ]} />
      {view === 'model' && m && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {m.valid ? <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="size-4" /> Matches the template</span>
              : <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"><AlertTriangle className="size-4" /> {m.errors.length} validation issue(s)</span>}
            {m.text_truncated && <span className="text-muted-foreground">· input truncated to max input tokens</span>}
            <span className="ml-auto"><CopyButton value={JSON.stringify(m.output, null, 2)} label="Copy JSON" /></span>
          </div>
          {m.errors.length > 0 && <ul className="text-[11px] text-amber-600 dark:text-amber-400 list-disc pl-5">{m.errors.slice(0, 20).map(e => <li key={e}>{e}</li>)}</ul>}
          {m.ungrounded && m.ungrounded.length > 0 && (
            <p className="text-[11px] text-muted-foreground">Not found verbatim in the page (check these): <code>{m.ungrounded.join(', ')}</code></p>
          )}
          <JsonBlock value={m.output ?? m.raw} icon={Braces} />
        </div>
      )}
      {view === 'structured' && (structuredCount === 0
        ? <InfoBox>No JSON-LD, microdata, OpenGraph or RDFa on this page.</InfoBox>
        : <JsonBlock value={res.structured} icon={Braces} />)}
      {view === 'text' && (
        <div className="relative">
          <span className="absolute right-2 top-2"><CopyButton value={res.text} /></span>
          <pre className="text-xs whitespace-pre-wrap bg-secondary/40 border border-border rounded-md p-3 max-h-[480px] overflow-auto"><FileText className="inline size-3.5 mr-1 text-primary" />{res.text || '(no text)'}</pre>
        </div>
      )}
    </div>
  );
}

function JsonBlock({ value, icon: Icon }: { value: any; icon: React.ElementType }) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div className="relative">
      <span className="absolute right-2 top-2"><CopyButton value={s} /></span>
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-secondary/40 border border-border rounded-md p-3 max-h-[480px] overflow-auto"><Icon className="inline size-3.5 mr-1 text-primary" />{s}</pre>
    </div>
  );
}
