import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Copy, Download, FileUp, Loader2, X } from 'lucide-react';
import { BASE, authFetch } from '../../api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// ---------- styling ----------

export const MONO = 'font-mono text-xs leading-relaxed';
/** Textarea with a fixed height (the shadcn Textarea grows with content by default). */
export const FIXED = 'field-sizing-fixed';

// ---------- clipboard / download ----------

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; fall back for plain-http deployments.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function downloadBlob(data: Blob | string, filename: string, mimeType = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type: mimeType }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function formatBytes(n: number, digits = 1) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${n < 0 ? '-' : ''}${i === 0 ? v : v.toFixed(digits)} ${units[i]}`;
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// ---------- backend API (/api/tools/*) ----------

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const toolsApi = {
  get: <T = any>(path: string) => authFetch(`${BASE}/api/tools${path}`).then(r => parse<T>(r)),
  post: <T = any>(path: string, body: unknown) =>
    authFetch(`${BASE}/api/tools${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => parse<T>(r)),
  postForm: <T = any>(path: string, form: FormData) =>
    authFetch(`${BASE}/api/tools${path}`, { method: 'POST', body: form }).then(r => parse<T>(r)),
  /** Fetch a binary response (e.g. a generated file) with auth. */
  blob: async (path: string, init?: RequestInit) => {
    const res = await authFetch(`${BASE}/api/tools${path}`, init);
    if (!res.ok) await parse(res);
    return res.blob();
  },
};

// ---------- jobs ----------

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobOutputInfo { index: number; filename: string; size: number; mimeType: string }

export interface ToolJob {
  id: string;
  converter: string;
  status: JobStatus;
  progress: number;
  message?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  inputs: { filename: string; size: number }[];
  options: Record<string, unknown>;
  outputs: JobOutputInfo[];
  meta?: any;
  expiresAt: number;
}

export type OptionSpec =
  | { key: string; label: string; type: 'select'; choices: { value: string; label: string }[]; default: string; help?: string }
  | { key: string; label: string; type: 'number'; default: number; min?: number; max?: number; step?: number; help?: string }
  | { key: string; label: string; type: 'text'; default: string; placeholder?: string; help?: string }
  | { key: string; label: string; type: 'boolean'; default: boolean; help?: string };

export interface ConverterInfo {
  id: string;
  label: string;
  group: string;
  inputs: string[];
  output: string;
  minFiles: number;
  maxFiles: number;
  options: OptionSpec[];
  available: boolean;
  missing: string[];
  /** Human-readable versions of `missing`, e.g. "LibreOffice". */
  missingLabels?: string[];
}

export interface Capabilities {
  binaries: Record<string, boolean>;
  converters: ConverterInfo[];
}

let capsPromise: Promise<Capabilities> | null = null;

export function loadCapabilities(force = false): Promise<Capabilities> {
  if (!capsPromise || force) {
    capsPromise = toolsApi.get<Capabilities>('/capabilities').catch(e => { capsPromise = null; throw e; });
  }
  return capsPromise;
}

export function useCapabilities() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    loadCapabilities().then(c => alive && setCaps(c)).catch(e => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, []);
  return { caps, error };
}

export function useConverter(id: string) {
  const { caps, error } = useCapabilities();
  return { converter: caps?.converters.find(c => c.id === id) ?? null, loading: !caps && !error, error };
}

export const jobsApi = {
  create: (converter: string, files: File[], options: Record<string, unknown> = {}) => {
    const form = new FormData();
    form.append('converter', converter);
    form.append('options', JSON.stringify(options));
    files.forEach(f => form.append('files', f, f.name));
    return toolsApi.postForm<ToolJob>('/jobs', form);
  },
  get: (id: string) => toolsApi.get<ToolJob>(`/jobs/${id}`),
  list: () => toolsApi.get<{ jobs: ToolJob[] }>('/jobs').then(r => r.jobs),
  cancel: (id: string) => authFetch(`${BASE}/api/tools/jobs/${id}`, { method: 'DELETE' }).then(r => parse(r)),
  /** Blob of one output, or of the whole job (zip when there are several outputs). */
  outputBlob: (job: ToolJob, index?: number) =>
    toolsApi.blob(index === undefined ? `/jobs/${job.id}/download` : `/jobs/${job.id}/files/${index}`),
  download: async (job: ToolJob, index?: number) => {
    const blob = await jobsApi.outputBlob(job, index);
    const name = index !== undefined
      ? job.outputs[index].filename
      : job.outputs.length === 1 ? job.outputs[0].filename : `${job.converter}-${job.id.slice(0, 8)}.zip`;
    downloadBlob(blob, name);
  },
};

/**
 * Submit a job and poll until it finishes.
 *   const { run, job, running, error, reset } = useJob();
 *   const done = await run('doc-to-pdf', files, { quality: 80 });
 */
export function useJob() {
  const [job, setJob] = useState<ToolJob | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => () => { cancelled.current = true; }, []);

  const run = useCallback(async (converter: string, files: File[], options: Record<string, unknown> = {}) => {
    setError('');
    setJob(null);
    setRunning(true);
    cancelled.current = false;
    try {
      let j = await jobsApi.create(converter, files, options);
      setJob(j);
      while (j.status === 'queued' || j.status === 'running') {
        await new Promise(r => setTimeout(r, 700));
        if (cancelled.current) return null;
        j = await jobsApi.get(j.id);
        setJob(j);
      }
      if (j.status === 'error') setError(j.error || 'Conversion failed');
      return j;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setRunning(false);
    }
  }, []);

  const cancel = useCallback(async () => {
    cancelled.current = true;
    if (job) await jobsApi.cancel(job.id).catch(() => {});
    setRunning(false);
  }, [job]);

  const reset = useCallback(() => { setJob(null); setError(''); }, []);

  return { run, job, running, error, cancel, reset };
}

// ---------- small UI pieces ----------

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size={label ? 'xs' : 'icon-xs'}
      disabled={!value}
      title="Copy"
      onClick={async () => {
        await copyText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check className="text-primary" /> : <Copy />}
      {label}
    </Button>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
      <AlertCircle className="size-4 shrink-0" />
      <span className="break-all whitespace-pre-wrap">{message}</span>
    </div>
  );
}

export function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs text-muted-foreground bg-secondary/50 border border-border rounded-md px-3 py-2">{children}</div>
  );
}

export function FieldLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between min-h-6">
      <label className="text-xs font-medium text-muted-foreground">{children}</label>
      {action}
    </div>
  );
}

/** Read-only key/value row with a copy button. */
export function OutputRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-border last:border-0">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className={cn(MONO, 'flex-1 min-w-0 break-all')}>{value || '—'}</code>
      <CopyButton value={value} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap items-center rounded-md border border-border bg-secondary p-0.5 min-h-8">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 px-3 rounded-[5px] text-xs font-medium border border-transparent cursor-pointer transition-colors',
            value === o.value ? 'bg-card text-foreground border-border shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** Labelled numeric input. */
export function NumberField({ label, value, onChange, min, max, step, suffix, className }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-1.5">
        <Input type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step}
          onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
        {suffix && <span className="text-xs text-muted-foreground shrink-0">{suffix}</span>}
      </div>
    </div>
  );
}

/** Big stat tile. */
export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-base font-semibold tabular-nums break-all">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Drag-and-drop / click file picker. */
export function FileDrop({ files, onFiles, accept, multiple, label, hint }: {
  files: File[];
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  label?: string;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const add = (list: FileList | null) => {
    if (!list?.length) return;
    const incoming = Array.from(list);
    onFiles(multiple ? [...files, ...incoming] : incoming.slice(0, 1));
  };

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        onDragOver={e => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
        className={cn(
          'flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center cursor-pointer transition-colors',
          over ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-secondary/40',
        )}
      >
        <FileUp className="size-5 text-muted-foreground" />
        <p className="text-xs font-medium">{label ?? (multiple ? 'Drop files here or click to choose' : 'Drop a file here or click to choose')}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={accept}
          multiple={multiple}
          onChange={e => { add(e.target.files); e.target.value = ''; }}
        />
      </div>
      {files.length > 0 && (
        <div className="space-y-1">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
              <span className="flex-1 truncate">{f.name}</span>
              <span className="text-muted-foreground tabular-nums">{formatBytes(f.size)}</span>
              <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => onFiles(files.filter((_, j) => j !== i))}><X /></Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Renders the form for a converter's declared options. */
export function OptionsForm({ specs, values, onChange }: {
  specs: OptionSpec[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}) {
  if (!specs.length) return null;
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {specs.map(s => {
        const v = values[s.key] ?? s.default;
        return (
          <div key={s.key} className="space-y-1.5">
            {s.type !== 'boolean' && <FieldLabel>{s.label}</FieldLabel>}
            {s.type === 'select' && (
              <select
                className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-primary"
                value={String(v)}
                onChange={e => set(s.key, e.target.value)}
              >
                {s.choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            )}
            {s.type === 'number' && (
              <Input type="number" value={String(v)} min={s.min} max={s.max} step={s.step}
                onChange={e => set(s.key, e.target.value === '' ? '' : Number(e.target.value))} />
            )}
            {s.type === 'text' && (
              <Input value={String(v)} placeholder={s.placeholder} onChange={e => set(s.key, e.target.value)} />
            )}
            {s.type === 'boolean' && (
              <div className="pt-6"><Checkbox checked={!!v} onChange={b => set(s.key, b)}>{s.label}</Checkbox></div>
            )}
            {s.help && <p className="text-[11px] text-muted-foreground">{s.help}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** Progress / error / outputs for a job, with downloads and inline image previews. */
export function JobResult({ job, error, running, onCancel }: {
  job: ToolJob | null; error?: string; running?: boolean; onCancel?: () => void;
}) {
  const [previews, setPreviews] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!job || job.status !== 'done') return;
    let alive = true;
    const urls: string[] = [];
    // Preview up to 12 image outputs inline.
    job.outputs.filter(o => o.mimeType.startsWith('image/') && o.size < 15 * 1024 * 1024).slice(0, 12).forEach(o => {
      jobsApi.outputBlob(job, o.index).then(b => {
        if (!alive) return;
        const u = URL.createObjectURL(b);
        urls.push(u);
        setPreviews(p => ({ ...p, [o.index]: u }));
      }).catch(() => {});
    });
    return () => { alive = false; urls.forEach(u => URL.revokeObjectURL(u)); setPreviews({}); };
  }, [job?.id, job?.status]);

  if (!job && !error) return null;
  const totalIn = job?.inputs.reduce((s, f) => s + f.size, 0) ?? 0;
  const totalOut = job?.outputs.reduce((s, f) => s + f.size, 0) ?? 0;
  // A size delta only means something for tools whose purpose is to shrink files.
  const showSavings = !!job && /compress|batch|minify|strip|optimi[sz]e/.test(job.converter) && totalIn > 0 && totalOut > 0;

  return (
    <div className="space-y-3">
      {job && (job.status === 'queued' || job.status === 'running') && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {job.status === 'queued' ? 'Queued…' : job.message || 'Processing…'}
            </span>
            <span className="flex items-center gap-2 tabular-nums">
              {job.progress}%
              {onCancel && running && <Button variant="ghost" size="xs" onClick={onCancel}>Cancel</Button>}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(3, job.progress)}%` }} />
          </div>
        </div>
      )}
      {error && <ErrorBox message={error} />}
      {job?.status === 'done' && (
        <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Done</Badge>
            <span className="text-xs text-muted-foreground">
              {job.outputs.length} file{job.outputs.length === 1 ? '' : 's'} · {formatBytes(totalOut)}
              {showSavings && ` (${totalOut <= totalIn ? '−' : '+'}${Math.abs(Math.round((1 - totalOut / totalIn) * 100))}% vs input)`}
            </span>
            <Button size="sm" className="ml-auto" onClick={() => jobsApi.download(job)}>
              <Download /> {job.outputs.length > 1 ? 'Download all (.zip)' : 'Download'}
            </Button>
          </div>
          {job.outputs.length > 1 || Object.keys(previews).length ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {job.outputs.slice(0, 200).map(o => (
                <div key={o.index} className="rounded-md border border-border bg-card p-2 space-y-1.5 min-w-0">
                  {previews[o.index] && (
                    <img src={previews[o.index]} alt={o.filename} className="w-full h-32 object-contain rounded bg-[repeating-conic-gradient(#8882_0_25%,transparent_0_50%)] bg-[length:16px_16px]" />
                  )}
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="flex-1 truncate" title={o.filename}>{o.filename}</span>
                    <span className="text-muted-foreground tabular-nums shrink-0">{formatBytes(o.size)}</span>
                    <Button variant="ghost" size="icon-xs" title="Download" onClick={() => jobsApi.download(job, o.index)}><Download /></Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Complete upload → options → run → download UI for a backend converter.
 * Pass `optionOverrides` to pre-set or hide options for a preset tool (e.g. "PNG to JPG").
 */
export function ConverterTool({ converterId, accept, hideOptions = [], presetOptions = {}, hint, children, onDone }: {
  converterId: string;
  accept?: string;
  hideOptions?: string[];
  presetOptions?: Record<string, unknown>;
  hint?: string;
  /** Extra UI rendered under the result (receives the finished job). */
  children?: (job: ToolJob) => React.ReactNode;
  onDone?: (job: ToolJob) => void;
}) {
  const { converter, loading, error: capsError } = useConverter(converterId);
  const [files, setFiles] = useState<File[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>(presetOptions);
  const { run, job, running, error, cancel } = useJob();

  if (loading) return <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading…</p>;
  if (capsError) return <ErrorBox message={`Could not reach the tools backend: ${capsError}`} />;
  if (!converter) return <ErrorBox message={`Converter "${converterId}" is not registered on the server.`} />;

  const acceptAttr = accept ?? (converter.inputs.length ? converter.inputs.map(e => '.' + e).join(',') : undefined);
  const multiple = converter.maxFiles > 1;
  const visible = converter.options.filter(o => !hideOptions.includes(o.key));

  return (
    <div className="space-y-4">
      {!converter.available && (
        <ErrorBox message={`This converter can't run on this server yet — missing: ${(converter.missingLabels ?? converter.missing).join(', ')}.`} />
      )}
      <FileDrop
        files={files}
        onFiles={setFiles}
        accept={acceptAttr}
        multiple={multiple}
        hint={hint ?? `${converter.inputs.length ? converter.inputs.map(e => '.' + e).join(' ') : 'Any file'} → ${converter.output}${multiple ? ` · up to ${converter.maxFiles} files` : ''}`}
      />
      <OptionsForm specs={visible} values={values} onChange={setValues} />
      <Button
        disabled={running || !converter.available || files.length < converter.minFiles}
        onClick={async () => {
          const j = await run(converterId, files, { ...values, ...presetOptions });
          if (j?.status === 'done') onDone?.(j);
        }}
      >
        {running ? <Loader2 className="animate-spin" /> : null}
        {running ? 'Working…' : converter.label}
      </Button>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {job?.status === 'done' && children?.(job)}
    </div>
  );
}

/** Placeholder used while a tool is being built. */
export function NotImplemented({ name }: { name: string }) {
  return <InfoBox>{name} is not implemented yet.</InfoBox>;
}
