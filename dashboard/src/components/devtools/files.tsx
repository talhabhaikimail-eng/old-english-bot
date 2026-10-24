import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, Ban, Camera, ChevronDown, ChevronRight, Download, ExternalLink, Eye, File as FileIcon, Folder,
  FolderOpen, GripVertical, Loader2, Lock, MapPin, Pause, Play, RefreshCw, Scissors, TriangleAlert, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  MONO, FIXED, Checkbox, CopyButton, ErrorBox, FieldLabel, FileDrop, InfoBox, JobResult, NumberField, OptionsForm, Segmented, Stat,
  downloadBlob, formatBytes, jobsApi, toolsApi, useCapabilities, useConverter, useJob,
  type ConverterInfo, type ToolJob,
} from './shared';
import {
  AUDIO_EXT, IMAGE_EXT, KIND_LABEL, OFFICE_FAMILY, SIZE_UNITS, TARGET_LABEL, VIDEO_EXT, buildTree, commonTargets, describeMissing,
  describeSplit, fileExt, fileStem, formatDms, formatNumber, formatTimecode, fromBytes, humanDuration, humanSize, kindOf, moveItem,
  osmUrl, parsePageRanges, parseTimecode, planJobs, previewKind, targetVideoKbps, toBytes, transferSeconds, unsafeZipPath,
  type FileKind, type TreeNode,
} from './lib/files';

// Files & Documents: server-side converters (LibreOffice, Chromium, PyMuPDF, ffmpeg) run as jobs
// through /api/tools/jobs; ZIP browsing, EXIF reading and size maths run in the browser.

// =====================================================================================
// shared bits
// =====================================================================================

const SELECT = 'h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-primary';

function Select<T extends string>({ value, onChange, options, className, disabled }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string; disabled?: boolean;
}) {
  return (
    <select className={cn(SELECT, className)} value={value} disabled={disabled} onChange={e => onChange(e.target.value as T)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Field({ label, children, hint, className }: { label: React.ReactNode; children: React.ReactNode; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1.5 min-w-0', className)}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function useObjectUrl(blob: Blob | null | undefined) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/** Fetch one job output as a Blob once the job is done. */
function useJobOutputBlob(job: ToolJob | null, index = 0, enabled = true) {
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    setBlob(null);
    if (!enabled || !job || job.status !== 'done' || !job.outputs[index]) return;
    let alive = true;
    jobsApi.outputBlob(job, index).then(b => alive && setBlob(b)).catch(() => {});
    return () => { alive = false; };
  }, [job?.id, job?.status, index, enabled]);
  return blob;
}

/** Availability banner for one or more converters (null when everything can run). */
function ServerStatus({ ids }: { ids: string[] }) {
  const { caps, error } = useCapabilities();
  if (error) return <ErrorBox message={`Could not reach the tools backend: ${error}`} />;
  if (!caps) return <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Checking server…</p>;
  const problems = ids.map(id => caps.converters.find(c => c.id === id) ?? ({ id, available: false, missing: ['not registered'] } as Partial<ConverterInfo>))
    .filter(c => !c.available);
  if (!problems.length) return null;
  const missing = [...new Set(problems.flatMap(p => p.missing ?? []))];
  return <ErrorBox message={`Not available on this server yet — missing: ${describeMissing(missing)}.`} />;
}

function useAvailable(id: string) {
  const { converter } = useConverter(id);
  return !!converter?.available;
}

/** Keep only files with allowed extensions; returns rejected names for a warning. */
function acceptFiles(files: File[], exts: string[]): { ok: File[]; rejected: string[] } {
  const ok: File[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    if (exts.includes(fileExt(f.name))) ok.push(f);
    else rejected.push(f.name);
  }
  return { ok, rejected };
}

function useFilteredFiles(exts: string[], max: number) {
  const [files, setFilesRaw] = useState<File[]>([]);
  const [warning, setWarning] = useState('');
  const setFiles = useCallback((list: File[]) => {
    const { ok, rejected } = acceptFiles(list, exts);
    const warn: string[] = [];
    if (rejected.length) warn.push(`Skipped unsupported file${rejected.length > 1 ? 's' : ''}: ${rejected.slice(0, 5).join(', ')}${rejected.length > 5 ? '…' : ''}`);
    if (ok.length > max) warn.push(`Only the first ${max} files are used.`);
    setWarning(warn.join(' '));
    setFilesRaw(ok.slice(0, max));
  }, [exts.join(','), max]);
  return { files, setFiles, warning };
}

function RunButton({ running, disabled, onClick, children, onCancel }: {
  running: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; onCancel?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={running || disabled} onClick={onClick}>
        {running && <Loader2 className="animate-spin" />}
        {running ? 'Working…' : children}
      </Button>
      {running && onCancel && <Button variant="outline" onClick={onCancel}><Ban /> Cancel</Button>}
    </div>
  );
}

const accept = (exts: string[]) => exts.map(e => '.' + e).join(',');

function PdfPreview({ job, index = 0 }: { job: ToolJob | null; index?: number }) {
  const [open, setOpen] = useState(false);
  const isPdf = !!job && job.status === 'done' && job.outputs[index]?.mimeType === 'application/pdf';
  const blob = useJobOutputBlob(job, index, open && isPdf);
  const url = useObjectUrl(blob);
  if (!isPdf) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen(o => !o)}><Eye /> {open ? 'Hide preview' : 'Preview PDF'}</Button>
        {url && <Button variant="ghost" size="sm" onClick={() => window.open(url, '_blank', 'noopener')}><ExternalLink /> Open in new tab</Button>}
      </div>
      {open && (url
        ? <iframe title="PDF preview" src={url} className="w-full h-[28rem] rounded-md border border-border bg-card" />
        : <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading preview…</p>)}
    </div>
  );
}

function MediaPreview({ job, kind }: { job: ToolJob | null; kind: 'audio' | 'video' }) {
  const blob = useJobOutputBlob(job, 0, !!job && job.outputs.length === 1);
  const url = useObjectUrl(blob);
  if (!url) return null;
  return kind === 'audio'
    ? <audio controls src={url} className="w-full" />
    : <video controls src={url} className="w-full max-h-80 rounded-md border border-border bg-black" />;
}

// ---------- PDF info (page count / encryption) ----------

interface PdfInfo {
  pages: number | null; encrypted: boolean; needsPassword: boolean; unlocked: boolean;
  metadata?: Record<string, string>; pageSize?: { widthMm: number; heightMm: number }; hasText?: boolean; fileSize?: number;
}
const pdfInfoCache = new WeakMap<File, Promise<PdfInfo>>();
function fetchPdfInfo(file: File, password = ''): Promise<PdfInfo> {
  if (!password) {
    const hit = pdfInfoCache.get(file);
    if (hit) return hit;
  }
  const form = new FormData();
  form.append('file', file, file.name);
  if (password) form.append('password', password);
  const p = toolsApi.postForm<PdfInfo>('/files/pdf-info', form);
  if (!password) {
    pdfInfoCache.set(file, p);
    p.catch(() => pdfInfoCache.delete(file));
  }
  return p;
}

function usePdfInfo(file: File | null, password = '') {
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setInfo(null); setError('');
    if (!file) return;
    let alive = true;
    const t = setTimeout(() => {
      fetchPdfInfo(file, password).then(i => alive && setInfo(i)).catch(e => alive && setError((e as Error).message));
    }, password ? 400 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [file, password]);
  return { info, error };
}

// ---------- recent jobs ----------

const CONVERTER_NAMES: Record<string, string> = {
  'office-convert': 'LibreOffice', 'html-to-pdf': 'HTML → PDF', 'pdf-merge': 'Merge PDF', 'pdf-split': 'Split PDF',
  'pdf-compress': 'Compress PDF', 'pdf-to-image': 'PDF → images', 'pdf-text': 'PDF → text', 'images-to-pdf': 'Images → PDF',
  'exif-strip': 'Strip metadata', 'video-to-mp3': 'Video → MP3', 'audio-convert': 'Audio convert', 'audio-cut': 'Audio cut',
  'video-convert': 'Video convert', 'video-to-gif': 'Video → GIF',
};

function JobStatusBadge({ job }: { job: ToolJob }) {
  if (job.status === 'done') return <Badge>Done</Badge>;
  if (job.status === 'error') return <Badge variant="destructive">Failed</Badge>;
  if (job.status === 'cancelled') return <Badge variant="outline">Cancelled</Badge>;
  return <Badge variant="secondary">{job.status === 'queued' ? 'Queued' : `${job.progress}%`}</Badge>;
}

function RecentJobs({ converters, refreshKey = 0, title = 'Recent jobs' }: { converters?: string[]; refreshKey?: number; title?: string }) {
  const [jobs, setJobs] = useState<ToolJob[]>([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const filter = converters?.join(',');

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const list = await jobsApi.list();
        if (!alive) return;
        const mine = converters ? list.filter(j => converters.includes(j.converter)) : list;
        setJobs(mine.slice(0, 20));
        setError('');
        const busy = mine.some(j => j.status === 'queued' || j.status === 'running');
        timer = setTimeout(load, busy ? 1200 : 8000);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        timer = setTimeout(load, 10000);
      }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [filter, refreshKey, tick]);

  if (!jobs.length && !error) return null;
  return (
    <div className="space-y-2">
      <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setTick(t => t + 1)}><RefreshCw /> Refresh</Button>}>{title}</FieldLabel>
      {error && <ErrorBox message={error} />}
      <div className="space-y-1.5">
        {jobs.map(j => {
          const busy = j.status === 'queued' || j.status === 'running';
          const outSize = j.outputs.reduce((s, o) => s + o.size, 0);
          return (
            <div key={j.id} className="rounded-md border border-border px-2.5 py-2 text-xs space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <JobStatusBadge job={j} />
                <span className="font-medium">{CONVERTER_NAMES[j.converter] ?? j.converter}</span>
                {typeof j.options.target === 'string' && <span className="text-muted-foreground">→ {String(j.options.target).toUpperCase()}</span>}
                {typeof j.options.format === 'string' && <span className="text-muted-foreground">→ {String(j.options.format).toUpperCase()}</span>}
                <span className="flex-1 min-w-0 truncate text-muted-foreground" title={j.inputs.map(i => i.filename).join(', ')}>
                  {j.inputs[0]?.filename ?? 'URL'}{j.inputs.length > 1 ? ` +${j.inputs.length - 1}` : ''}
                </span>
                {j.status === 'done' && (
                  <Button size="xs" onClick={() => jobsApi.download(j).catch(e => setError((e as Error).message))}>
                    <Download /> {j.outputs.length > 1 ? `${j.outputs.length} files (.zip)` : formatBytes(outSize)}
                  </Button>
                )}
                <Button variant="ghost" size="icon-xs" title={busy ? 'Cancel' : 'Remove'}
                  onClick={async () => { await jobsApi.cancel(j.id).catch(() => {}); setTick(t => t + 1); }}>
                  {busy ? <Ban /> : <X />}
                </Button>
              </div>
              {busy && (
                <div className="space-y-1">
                  <div className="h-1 rounded-full bg-secondary overflow-hidden">
                    <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(3, j.progress)}%` }} />
                  </div>
                  {j.message && <p className="text-[11px] text-muted-foreground truncate">{j.message}</p>}
                </div>
              )}
              {j.status === 'error' && <p className="text-[11px] text-destructive break-words">{j.error}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =====================================================================================
// Universal converter
// =====================================================================================

/** Options worth showing for each converter in the universal UI. */
function relevantOptions(converter: string, target: string, kinds: Set<FileKind>): string[] {
  switch (converter) {
    case 'office-convert':
      return [
        ...(target === 'csv' ? ['sheet', 'delimiter', 'csvBom'] : []),
        ...(kinds.has('spreadsheet') ? ['inputDelimiter'] : []),
        ...(target === 'pdf' && kinds.has('spreadsheet') ? ['onePagePerSheet'] : []),
        ...(target === 'pdf' ? ['pdfA'] : []),
      ];
    case 'html-to-pdf': return ['pageSize', 'landscape', 'margin', 'printBackground', 'pageNumbers'];
    case 'pdf-to-image': return ['dpi', 'pages', 'quality'];
    case 'pdf-text': return ['mode', 'separators', 'pages'];
    case 'images-to-pdf': return ['pageSize', 'orientation', 'margin', 'fit'];
    case 'audio-convert': return ['bitrate', 'sampleRate', 'channels', 'loudnorm'];
    case 'video-to-mp3': return ['mode', 'bitrate', 'vbr'];
    case 'video-convert': return ['quality', 'maxHeight', 'fps', 'stripAudio'];
    case 'video-to-gif': return ['start', 'duration', 'fps', 'width'];
    default: return [];
  }
}

const ALL_EXT = [...Object.keys(OFFICE_FAMILY), ...IMAGE_EXT, ...AUDIO_EXT, ...VIDEO_EXT];

export function UniversalConverter() {
  const { caps } = useCapabilities();
  const [files, setFiles] = useState<File[]>([]);
  const [target, setTarget] = useState('');
  const [opts, setOpts] = useState<Record<string, Record<string, unknown>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  const names = files.map(f => f.name);
  const kinds = useMemo(() => new Set(files.map(f => kindOf(f.name))), [files]);
  const targets = useMemo(() => commonTargets(names), [names.join('|')]);
  useEffect(() => {
    if (targets.length && !targets.includes(target)) setTarget(targets[0]);
  }, [targets.join(','), target]);

  const plan = useMemo(() => (target ? planJobs(files, target) : { batches: [], unsupported: files }), [files, target]);
  const convIds = [...new Set(plan.batches.map(b => b.converter))];

  const kindCounts = useMemo(() => {
    const m = new Map<FileKind, number>();
    files.forEach(f => m.set(kindOf(f.name), (m.get(kindOf(f.name)) ?? 0) + 1));
    return [...m.entries()];
  }, [files]);

  const submit = async () => {
    setSubmitting(true); setError(''); setNotice('');
    let ok = 0;
    try {
      for (const b of plan.batches) {
        await jobsApi.create(b.converter, b.files, { ...(opts[b.converter] ?? {}), ...b.options });
        ok++;
      }
      setNotice(`${ok} job${ok === 1 ? '' : 's'} started — progress and downloads are listed below.`);
      setFiles([]);
    } catch (e) {
      setError(`${ok ? `${ok} job(s) started, then: ` : ''}${(e as Error).message}`);
    } finally {
      setSubmitting(false);
      setRefresh(r => r + 1);
    }
  };

  return (
    <div className="space-y-4">
      <FileDrop files={files} onFiles={setFiles} multiple accept={accept(ALL_EXT)}
        hint="Documents, spreadsheets, slides, PDFs, images, audio and video — mix and match, up to 20 per job." />
      {kindCounts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {kindCounts.map(([k, c]) => <Badge key={k} variant={k === 'unknown' ? 'destructive' : 'secondary'}>{c} × {KIND_LABEL[k]}</Badge>)}
        </div>
      )}
      {files.length > 0 && !targets.length && (
        <ErrorBox message={kinds.has('unknown')
          ? 'Some files are of a type this converter does not handle — remove them to continue.'
          : 'These files have no output format in common — convert each kind separately.'} />
      )}
      {targets.length > 0 && (
        <Field label="Convert to">
          <div className="flex flex-wrap gap-1.5">
            {targets.map(t => (
              <button key={t} type="button" onClick={() => setTarget(t)}
                className={cn('h-8 px-3 rounded-md border text-xs font-medium transition-colors cursor-pointer',
                  t === target ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground hover:border-primary/50')}>
                {TARGET_LABEL[t] ?? t.toUpperCase()}
              </button>
            ))}
          </div>
        </Field>
      )}
      {convIds.length > 0 && <ServerStatus ids={convIds} />}
      {caps && convIds.map(id => {
        const spec = caps.converters.find(c => c.id === id);
        const keys = relevantOptions(id, target, kinds);
        const specs = (spec?.options ?? []).filter(o => keys.includes(o.key));
        if (!specs.length) return null;
        return (
          <div key={id} className="rounded-md border border-border p-3 space-y-2">
            <p className="text-xs font-medium">{CONVERTER_NAMES[id] ?? id} options</p>
            <OptionsForm specs={specs} values={opts[id] ?? {}} onChange={v => setOpts(o => ({ ...o, [id]: v }))} />
          </div>
        );
      })}
      {plan.batches.length > 1 && (
        <InfoBox>These files will run as {plan.batches.length} jobs ({plan.batches.map(b => `${b.files.length} × ${CONVERTER_NAMES[b.converter] ?? b.converter}`).join(', ')}).</InfoBox>
      )}
      <RunButton running={submitting} disabled={!plan.batches.length || plan.unsupported.length > 0} onClick={submit}>
        {files.length ? `Convert ${files.length} file${files.length === 1 ? '' : 's'}${target ? ` to ${target.toUpperCase()}` : ''}` : 'Convert'}
      </RunButton>
      {error && <ErrorBox message={error} />}
      {notice && <InfoBox>{notice}</InfoBox>}
      <RecentJobs refreshKey={refresh} />
    </div>
  );
}

// =====================================================================================
// Office presets
// =====================================================================================

interface OfficeToolProps {
  exts: string[];
  targets: { value: string; label: string }[];
  defaultTarget: string;
  intro?: React.ReactNode;
  /** Extra options UI for the chosen target. */
  extra?: (target: string, values: Record<string, unknown>, set: (k: string, v: unknown) => void, files: File[]) => React.ReactNode;
  result?: (job: ToolJob) => React.ReactNode;
}

function OfficeTool({ exts, targets, defaultTarget, intro, extra, result }: OfficeToolProps) {
  const { files, setFiles, warning } = useFilteredFiles(exts, 20);
  const [target, setTarget] = useState(defaultTarget);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('office-convert');
  const set = (k: string, v: unknown) => setValues(o => ({ ...o, [k]: v }));

  return (
    <div className="space-y-4">
      <ServerStatus ids={['office-convert']} />
      {intro}
      <FileDrop files={files} onFiles={setFiles} multiple accept={accept(exts)}
        hint={`${exts.map(e => '.' + e).join(' ')} · up to 20 files, converted with LibreOffice`} />
      {warning && <InfoBox>{warning}</InfoBox>}
      {targets.length > 1 && (
        <Field label="Output format">
          <Segmented value={target} onChange={setTarget} options={targets} />
        </Field>
      )}
      {extra?.(target, values, set, files)}
      <RunButton running={running} onCancel={cancel} disabled={!files.length || !available}
        onClick={() => run('office-convert', files, { ...values, target })}>
        Convert {files.length > 1 ? `${files.length} files ` : ''}to {target.toUpperCase()}
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {job?.status === 'done' && job.outputs.length === 1 && <PdfPreview job={job} />}
      {job?.status === 'done' && result?.(job)}
    </div>
  );
}

const WORD_EXT = ['doc', 'docx', 'docm', 'dotx', 'odt', 'rtf', 'txt', 'html', 'htm', 'md', 'wpd'];

export function WordToPdf() {
  return (
    <OfficeTool
      exts={WORD_EXT}
      targets={[{ value: 'pdf', label: 'PDF' }]}
      defaultTarget="pdf"
      extra={(_, v, set) => (
        <div className="flex flex-wrap gap-4">
          <Checkbox checked={!!v.pdfA} onChange={b => set('pdfA', b)}>PDF/A-2b (archival, embeds all fonts)</Checkbox>
        </div>
      )}
    />
  );
}

export function PdfToWord() {
  return (
    <OfficeTool
      exts={['pdf']}
      targets={[{ value: 'docx', label: 'Word (.docx)' }, { value: 'odt', label: 'ODT' }, { value: 'rtf', label: 'RTF' }, { value: 'doc', label: 'Word 97' }]}
      defaultTarget="docx"
      intro={<InfoBox>Text, images and positions are carried over as editable frames. Scanned PDFs (images only) have no text layer — they'd need OCR first. For plain text, use <b>PDF Text Extractor</b>.</InfoBox>}
    />
  );
}

const SHEET_EXT = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv', 'numbers'];

function CsvPreview({ job }: { job: ToolJob }) {
  const [idx, setIdx] = useState(0);
  const csvOutputs = job.outputs.filter(o => o.filename.toLowerCase().endsWith('.csv'));
  const blob = useJobOutputBlob(job, csvOutputs[idx]?.index ?? 0, csvOutputs.length > 0);
  const [text, setText] = useState('');
  useEffect(() => { setText(''); blob?.slice(0, 64 * 1024).text().then(setText); }, [blob]);
  if (!csvOutputs.length) return null;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).slice(0, 15);
  return (
    <div className="space-y-1.5">
      <FieldLabel action={csvOutputs.length > 1 ? (
        <Select value={String(idx)} onChange={v => setIdx(Number(v))} className="w-auto" options={csvOutputs.map((o, i) => ({ value: String(i), label: o.filename }))} />
      ) : undefined}>Preview (first rows)</FieldLabel>
      <pre className={cn(MONO, 'max-h-64 overflow-auto rounded-md border border-border bg-secondary/40 p-2 whitespace-pre')}>{lines.join('\n') || 'Loading…'}</pre>
    </div>
  );
}

export function SpreadsheetFileConverter() {
  return (
    <OfficeTool
      exts={SHEET_EXT}
      targets={[
        { value: 'xlsx', label: 'XLSX' }, { value: 'csv', label: 'CSV' }, { value: 'pdf', label: 'PDF' }, { value: 'ods', label: 'ODS' },
        { value: 'xls', label: 'XLS' }, { value: 'html', label: 'HTML' },
      ]}
      defaultTarget="csv"
      extra={(target, v, set, files) => {
        const hasCsvInput = files.some(f => ['csv', 'tsv'].includes(fileExt(f.name)));
        return (
          <div className="grid gap-3 sm:grid-cols-2">
            {target === 'csv' && (
              <>
                <Field label="Sheets" hint="Blank = every sheet as its own CSV. Or a sheet number (2) or name (Sales).">
                  <Input value={String(v.sheet ?? '')} placeholder="All sheets" onChange={e => set('sheet', e.target.value)} />
                </Field>
                <Field label="Delimiter">
                  <Segmented value={String(v.delimiter ?? 'comma')} onChange={d => set('delimiter', d)}
                    options={[{ value: 'comma', label: ',' }, { value: 'semicolon', label: ';' }, { value: 'tab', label: 'Tab' }, { value: 'pipe', label: '|' }]} />
                </Field>
                <div className="sm:col-span-2">
                  <Checkbox checked={!!v.csvBom} onChange={b => set('csvBom', b)}>Add UTF-8 BOM (makes Excel open accents correctly)</Checkbox>
                </div>
              </>
            )}
            {target === 'pdf' && (
              <div className="sm:col-span-2 flex flex-wrap gap-4">
                <Checkbox checked={!!v.onePagePerSheet} onChange={b => set('onePagePerSheet', b)}>Fit each sheet on one page</Checkbox>
                <Checkbox checked={!!v.pdfA} onChange={b => set('pdfA', b)}>PDF/A-2b</Checkbox>
              </div>
            )}
            {hasCsvInput && (
              <Field label="Input CSV delimiter">
                <Select value={String(v.inputDelimiter ?? 'auto')} onChange={d => set('inputDelimiter', d)}
                  options={[{ value: 'auto', label: 'Auto-detect' }, { value: 'comma', label: 'Comma' }, { value: 'semicolon', label: 'Semicolon' }, { value: 'tab', label: 'Tab' }, { value: 'pipe', label: 'Pipe' }]} />
              </Field>
            )}
          </div>
        );
      }}
      result={job => <CsvPreview job={job} />}
    />
  );
}

export function PresentationToPdf() {
  return (
    <OfficeTool
      exts={['ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key']}
      targets={[{ value: 'pdf', label: 'PDF' }, { value: 'pptx', label: 'PPTX' }, { value: 'odp', label: 'ODP' }, { value: 'png', label: 'PNG (first slide)' }]}
      defaultTarget="pdf"
      extra={(target, v, set) => target === 'pdf' ? (
        <Checkbox checked={!!v.pdfA} onChange={b => set('pdfA', b)}>PDF/A-2b (archival)</Checkbox>
      ) : null}
    />
  );
}

// =====================================================================================
// HTML / Markdown → PDF
// =====================================================================================

const PRINT_CSS = `
:root{color-scheme:light}*{box-sizing:border-box}html{font-size:11pt}
body{font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans","Liberation Sans",sans-serif;line-height:1.55;color:#1f2328;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .5em;break-after:avoid}
h1{font-size:1.9em;border-bottom:1px solid #d0d7de;padding-bottom:.3em}h2{font-size:1.45em;border-bottom:1px solid #d0d7de;padding-bottom:.25em}
h3{font-size:1.2em}p,ul,ol,table,pre,blockquote{margin:0 0 .9em}a{color:#0969da;text-decoration:none}
code{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:.88em;background:#f3f4f6;border-radius:4px;padding:.1em .35em}
pre{background:#f6f8fa;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;break-inside:avoid}
pre code{background:none;padding:0}blockquote{border-left:4px solid #d0d7de;color:#57606a;padding:0 1em;margin-left:0}
table{border-collapse:collapse;max-width:100%}tr{break-inside:avoid}th,td{border:1px solid #d0d7de;padding:5px 10px;vertical-align:top}
th{background:#f6f8fa}img{max-width:100%;height:auto}hr{border:0;border-top:1px solid #d0d7de;margin:1.5em 0}
`;

const SAMPLE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Invoice</title>
  <style>
    body { font-family: system-ui, sans-serif; color: #222; }
    h1 { color: #0a7d55; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
  </style>
</head>
<body>
  <h1>Invoice #1042</h1>
  <p>Thanks for your business!</p>
  <table>
    <tr><th>Item</th><th>Qty</th><th>Price</th></tr>
    <tr><td>Widget</td><td>2</td><td>$19.00</td></tr>
  </table>
</body>
</html>`;

const SAMPLE_MD = `# Project update

**Status:** on track · _week 42_

## Highlights
- Shipped the new converter
- Fixed 12 bugs

| Metric | Value |
|-------:|:------|
| Users  | 1,204 |
| Uptime | 99.98% |

\`\`\`js
console.log('hello');
\`\`\`
`;

type HtmlMode = 'html' | 'markdown' | 'file' | 'url';

export function HtmlToPdf() {
  const [mode, setMode] = useState<HtmlMode>('html');
  const [html, setHtml] = useState(SAMPLE_HTML);
  const [md, setMd] = useState(SAMPLE_MD);
  const [mdHtml, setMdHtml] = useState('');
  const { files, setFiles, warning } = useFilteredFiles(['html', 'htm', 'xhtml', 'md', 'markdown', 'txt'], 20);
  const [url, setUrl] = useState('');
  const [o, setO] = useState({
    pageSize: 'A4', landscape: false, margin: 15, printBackground: true, scale: 1, pageNumbers: false, headerText: '',
    media: 'print', waitMs: 1000, engine: 'auto',
  });
  const set = <K extends keyof typeof o>(k: K, v: (typeof o)[K]) => setO(p => ({ ...p, [k]: v }));
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('html-to-pdf');

  useEffect(() => {
    if (mode !== 'markdown') return;
    let alive = true;
    const t = setTimeout(async () => {
      const { marked } = await import('marked');
      const body = await marked.parse(md, { gfm: true });
      if (alive) setMdHtml(body);
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [md, mode]);

  const mdTitle = (/^#\s+(.+)$/m.exec(md)?.[1] ?? 'document').trim();
  const mdDoc = `<!doctype html><html><head><meta charset="utf-8"><title>${mdTitle.replace(/</g, '&lt;')}</title><style>${PRINT_CSS}</style></head><body>${mdHtml}</body></html>`;
  const safeName = (s: string) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'document';

  const urlError = mode === 'url' && url.trim() && !/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(url.trim()) ? 'Enter a public web address, e.g. https://example.com' : '';
  const canRun = available && (
    (mode === 'html' && html.trim()) || (mode === 'markdown' && md.trim() && mdHtml) || (mode === 'file' && files.length) || (mode === 'url' && url.trim() && !urlError)
  );

  const go = () => {
    const opts: Record<string, unknown> = { ...o, waitMs: mode === 'url' ? o.waitMs : Math.min(o.waitMs, 300) };
    let list: File[] = [];
    if (mode === 'html') {
      const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1];
      list = [new File([html], `${safeName(title || 'document')}.html`, { type: 'text/html' })];
    } else if (mode === 'markdown') {
      list = [new File([mdDoc], `${safeName(mdTitle)}.html`, { type: 'text/html' })];
    } else if (mode === 'file') {
      list = files;
    } else {
      opts.url = url.trim();
    }
    void run('html-to-pdf', list, opts);
  };

  return (
    <div className="space-y-4">
      <ServerStatus ids={['html-to-pdf']} />
      <Segmented value={mode} onChange={setMode} options={[
        { value: 'html', label: 'Paste HTML' }, { value: 'markdown', label: 'Write Markdown' }, { value: 'file', label: 'Upload files' }, { value: 'url', label: 'Web page URL' },
      ]} />
      {mode === 'html' && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="HTML">
            <Textarea className={cn(MONO, FIXED, 'h-72')} value={html} spellCheck={false} onChange={e => setHtml(e.target.value)} />
          </Field>
          <Field label="Preview">
            <iframe title="HTML preview" sandbox="" srcDoc={html} className="w-full h-72 rounded-md border border-border bg-white" />
          </Field>
        </div>
      )}
      {mode === 'markdown' && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Markdown">
            <Textarea className={cn(MONO, FIXED, 'h-72')} value={md} spellCheck={false} onChange={e => setMd(e.target.value)} />
          </Field>
          <Field label="Print preview">
            <iframe title="Markdown preview" sandbox="" srcDoc={mdDoc.replace('<body>', '<body style="padding:16px">')} className="w-full h-72 rounded-md border border-border bg-white" />
          </Field>
        </div>
      )}
      {mode === 'file' && (
        <>
          <FileDrop files={files} onFiles={setFiles} multiple accept=".html,.htm,.xhtml,.md,.markdown,.txt" hint=".html .md .txt · up to 20 files, each becomes a PDF" />
          {warning && <InfoBox>{warning}</InfoBox>}
        </>
      )}
      {mode === 'url' && (
        <Field label="Web page" hint="Rendered by headless Chromium on the server. Private / internal addresses are blocked.">
          <Input value={url} placeholder="https://example.com/article" onChange={e => setUrl(e.target.value)} />
          {urlError && <p className="text-[11px] text-destructive">{urlError}</p>}
        </Field>
      )}

      <div className="rounded-md border border-border p-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Page size">
            <Segmented value={o.pageSize} onChange={v => set('pageSize', v)} options={['A4', 'Letter', 'Legal', 'A3', 'A5'].map(v => ({ value: v, label: v }))} />
          </Field>
          <NumberField label="Margin" suffix="mm" value={o.margin} min={0} max={50} onChange={v => set('margin', v)} />
          <NumberField label="Scale" value={o.scale} min={0.1} max={2} step={0.05} onChange={v => set('scale', v)} />
          <Field label="Header text"><Input value={o.headerText} placeholder="Optional" onChange={e => set('headerText', e.target.value)} /></Field>
          <Field label="CSS media">
            <Select value={o.media} onChange={v => set('media', v)} options={[{ value: 'print', label: 'Print stylesheet' }, { value: 'screen', label: 'Screen (as in browser)' }]} />
          </Field>
          <Field label="Engine">
            <Select value={o.engine} onChange={v => set('engine', v)} options={[{ value: 'auto', label: 'Auto (Chromium, else LibreOffice)' }, { value: 'chromium', label: 'Chromium' }, { value: 'libreoffice', label: 'LibreOffice' }]} />
          </Field>
          {mode === 'url' && <NumberField label="Wait after load" suffix="ms" value={o.waitMs} min={0} max={15000} step={250} onChange={v => set('waitMs', v)} />}
        </div>
        <div className="flex flex-wrap gap-4">
          <Checkbox checked={o.landscape} onChange={v => set('landscape', v)}>Landscape</Checkbox>
          <Checkbox checked={o.printBackground} onChange={v => set('printBackground', v)}>Print backgrounds</Checkbox>
          <Checkbox checked={o.pageNumbers} onChange={v => set('pageNumbers', v)}>Page numbers</Checkbox>
        </div>
      </div>

      <RunButton running={running} onCancel={cancel} disabled={!canRun} onClick={go}>Create PDF</RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {job?.status === 'done' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Rendered with {job.meta?.engine === 'libreoffice' ? 'LibreOffice' : 'Chromium'}
            {Array.isArray(job.meta?.files) && ` · ${job.meta.files.map((f: { pages: number }) => `${f.pages} page${f.pages === 1 ? '' : 's'}`).join(', ')}`}
          </p>
          {job.meta?.blockedRequests?.length > 0 && (
            <InfoBox>Blocked {job.meta.blockedRequests.length} request(s) to private or non-web addresses, e.g. <code className={MONO}>{job.meta.blockedRequests[0]}</code></InfoBox>
          )}
          {job.outputs.length === 1 && <PdfPreview job={job} />}
        </div>
      )}
    </div>
  );
}

// =====================================================================================
// Reorderable lists
// =====================================================================================

function useDragReorder<T>(items: T[], setItems: (v: T[]) => void) {
  const from = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const props = (i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { from.current = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); },
    onDragOver: (e: React.DragEvent) => { if (from.current === null) return; e.preventDefault(); setOver(i); },
    onDragLeave: () => setOver(o => (o === i ? null : o)),
    onDrop: (e: React.DragEvent) => {
      if (from.current === null) return;
      e.preventDefault(); e.stopPropagation();
      setItems(moveItem(items, from.current, i));
      from.current = null; setOver(null);
    },
    onDragEnd: () => { from.current = null; setOver(null); },
  });
  return { props, over };
}

function Thumb({ file }: { file: File }) {
  const url = useObjectUrl(file);
  const [failed, setFailed] = useState(false);
  if (failed || !url) {
    return <div className="w-full h-28 flex flex-col items-center justify-center gap-1 rounded bg-secondary text-[11px] text-muted-foreground"><FileIcon className="size-5" />{fileExt(file.name).toUpperCase()}</div>;
  }
  return <img src={url} alt={file.name} onError={() => setFailed(true)} className="w-full h-28 object-contain rounded bg-secondary" />;
}

export function ImagesToPdf() {
  const { files, setFiles, warning } = useFilteredFiles(IMAGE_EXT, 200);
  const { props, over } = useDragReorder(files, setFiles);
  const [o, setO] = useState({ pageSize: 'a4', orientation: 'auto', margin: 10, fit: 'fit', quality: 90, outputName: '' });
  const set = <K extends keyof typeof o>(k: K, v: (typeof o)[K]) => setO(p => ({ ...p, [k]: v }));
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('images-to-pdf');

  return (
    <div className="space-y-4">
      <ServerStatus ids={['images-to-pdf']} />
      <FileDrop files={[]} onFiles={list => setFiles([...files, ...list])} multiple accept={accept(IMAGE_EXT)}
        hint="JPG, PNG, WebP, HEIC, GIF, BMP, TIFF · each image becomes a page, in the order below" />
      {warning && <InfoBox>{warning}</InfoBox>}
      {files.length > 0 && (
        <div className="space-y-2">
          <FieldLabel action={
            <div className="flex gap-1">
              <Button variant="ghost" size="xs" onClick={() => setFiles([...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))}>Sort by name</Button>
              <Button variant="ghost" size="xs" onClick={() => setFiles([...files].sort((a, b) => a.lastModified - b.lastModified))}>By date</Button>
              <Button variant="ghost" size="xs" onClick={() => setFiles([...files].reverse())}>Reverse</Button>
              <Button variant="ghost" size="xs" onClick={() => setFiles([])}>Clear</Button>
            </div>
          }>{files.length} image{files.length === 1 ? '' : 's'} · drag to reorder</FieldLabel>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {files.map((f, i) => (
              <div key={`${f.name}-${f.size}-${f.lastModified}-${i}`} {...props(i)}
                className={cn('rounded-md border bg-card p-1.5 space-y-1 cursor-grab active:cursor-grabbing', over === i ? 'border-primary' : 'border-border')}>
                <div className="relative">
                  <Thumb file={f} />
                  <Badge variant="secondary" className="absolute top-1 left-1">{i + 1}</Badge>
                </div>
                <p className="text-[11px] truncate" title={f.name}>{f.name}</p>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">{formatBytes(f.size)}</span>
                  <div className="flex">
                    <Button variant="ghost" size="icon-xs" title="Move earlier" disabled={i === 0} onClick={() => setFiles(moveItem(files, i, i - 1))}><ArrowUp className="-rotate-90" /></Button>
                    <Button variant="ghost" size="icon-xs" title="Move later" disabled={i === files.length - 1} onClick={() => setFiles(moveItem(files, i, i + 1))}><ArrowDown className="-rotate-90" /></Button>
                    <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => setFiles(files.filter((_, j) => j !== i))}><X /></Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Page size">
          <Select value={o.pageSize} onChange={v => set('pageSize', v)} options={[
            { value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }, { value: 'legal', label: 'Legal' }, { value: 'a3', label: 'A3' },
            { value: 'a5', label: 'A5' }, { value: 'fit', label: 'Same as image' },
          ]} />
        </Field>
        <Field label="Orientation">
          <Segmented value={o.orientation} onChange={v => set('orientation', v)} options={[{ value: 'auto', label: 'Auto' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} />
        </Field>
        <Field label="Placement">
          <Segmented value={o.fit} onChange={v => set('fit', v)} options={[{ value: 'fit', label: 'Fit' }, { value: 'fill', label: 'Fill (crop)' }, { value: 'stretch', label: 'Stretch' }]} />
        </Field>
        <NumberField label="Margin" suffix="mm" value={o.margin} min={0} max={50} onChange={v => set('margin', v)} />
        <NumberField label="JPEG quality (re-encoded images)" value={o.quality} min={30} max={100} onChange={v => set('quality', v)} />
        <Field label="File name"><Input value={o.outputName} placeholder={files.length === 1 ? fileStem(files[0].name) : 'images'} onChange={e => set('outputName', e.target.value)} /></Field>
      </div>
      <p className="text-[11px] text-muted-foreground">JPEGs are embedded untouched (no quality loss) unless they need rotating or cropping.</p>
      <RunButton running={running} onCancel={cancel} disabled={!files.length || !available} onClick={() => run('images-to-pdf', files, o)}>
        Create PDF ({files.length} page{files.length === 1 ? '' : 's'})
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      <PdfPreview job={job} />
    </div>
  );
}

// =====================================================================================
// PDF tools
// =====================================================================================

function PdfPages({ file }: { file: File }) {
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchPdfInfo(file).then(i => alive && setInfo(i)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [file]);
  if (failed) return <Badge variant="destructive">unreadable</Badge>;
  if (!info) return <Loader2 className="size-3 animate-spin text-muted-foreground" />;
  if (info.needsPassword) return <span className="inline-flex items-center gap-1 text-muted-foreground"><Lock className="size-3" /> locked</span>;
  return <span className="text-muted-foreground tabular-nums">{info.pages} p.</span>;
}

export function MergePdf() {
  const { files, setFiles, warning } = useFilteredFiles(['pdf'], 50);
  const { props, over } = useDragReorder(files, setFiles);
  const [bookmarks, setBookmarks] = useState(true);
  const [name, setName] = useState('merged');
  const [password, setPassword] = useState('');
  const [infos, setInfos] = useState<(PdfInfo | null)[]>([]);
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('pdf-merge');

  useEffect(() => {
    let alive = true;
    Promise.all(files.map(f => fetchPdfInfo(f).catch(() => null))).then(r => alive && setInfos(r));
    return () => { alive = false; };
  }, [files]);
  const totalPages = infos.reduce((s, i) => s + (i?.pages ?? 0), 0);
  const locked = infos.some(i => i?.needsPassword);

  return (
    <div className="space-y-4">
      <ServerStatus ids={['pdf-merge']} />
      <FileDrop files={[]} onFiles={list => setFiles([...files, ...list])} multiple accept=".pdf" hint="Add 2–50 PDFs · drag rows to set the order" />
      {warning && <InfoBox>{warning}</InfoBox>}
      {files.length > 0 && (
        <div className="space-y-1">
          <FieldLabel action={
            <div className="flex gap-1">
              <Button variant="ghost" size="xs" onClick={() => setFiles([...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))}>Sort A–Z</Button>
              <Button variant="ghost" size="xs" onClick={() => setFiles([])}>Clear</Button>
            </div>
          }>{files.length} files{totalPages ? ` · ${totalPages} pages total` : ''}</FieldLabel>
          {files.map((f, i) => (
            <div key={`${f.name}-${f.size}-${i}`} {...props(i)}
              className={cn('flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs bg-card cursor-grab active:cursor-grabbing', over === i ? 'border-primary' : 'border-border')}>
              <GripVertical className="size-3.5 text-muted-foreground shrink-0" />
              <span className="w-5 text-muted-foreground tabular-nums">{i + 1}.</span>
              <span className="flex-1 min-w-0 truncate" title={f.name}>{f.name}</span>
              <PdfPages file={f} />
              <span className="hidden sm:inline text-muted-foreground tabular-nums">{formatBytes(f.size)}</span>
              <Button variant="ghost" size="icon-xs" title="Move up" disabled={i === 0} onClick={() => setFiles(moveItem(files, i, i - 1))}><ArrowUp /></Button>
              <Button variant="ghost" size="icon-xs" title="Move down" disabled={i === files.length - 1} onClick={() => setFiles(moveItem(files, i, i + 1))}><ArrowDown /></Button>
              <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => setFiles(files.filter((_, j) => j !== i))}><X /></Button>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Output name"><Input value={name} onChange={e => setName(e.target.value)} /></Field>
        {locked && <Field label="Password for protected files"><Input type="password" value={password} onChange={e => setPassword(e.target.value)} /></Field>}
      </div>
      <Checkbox checked={bookmarks} onChange={setBookmarks}>Add a bookmark for each file (keeps existing bookmarks nested)</Checkbox>
      <RunButton running={running} onCancel={cancel} disabled={files.length < 2 || !available}
        onClick={() => run('pdf-merge', files, { bookmarks, outputName: name, password })}>
        Merge {files.length} PDFs
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      <PdfPreview job={job} />
    </div>
  );
}

export function SplitPdf() {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const { info, error: infoError } = usePdfInfo(file, password);
  const [mode, setMode] = useState<'ranges' | 'every' | 'each'>('ranges');
  const [ranges, setRanges] = useState('');
  const [every, setEvery] = useState(1);
  const [single, setSingle] = useState(false);
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('pdf-split');
  const pages = info?.pages ?? 0;
  const desc = useMemo(() => (file && pages ? describeSplit(file.name, pages, mode, { ranges, every, single }) : { parts: [] }), [file, pages, mode, ranges, every, single]);
  const rangeEmpty = mode === 'ranges' && !ranges.trim();

  return (
    <div className="space-y-4">
      <ServerStatus ids={['pdf-split']} />
      <FileDrop files={file ? [file] : []} onFiles={l => { setFile(l.find(f => fileExt(f.name) === 'pdf') ?? null); setPassword(''); }} accept=".pdf" />
      {infoError && <ErrorBox message={infoError} />}
      {info?.needsPassword && (
        <Field label="This PDF is password-protected" hint={info.unlocked ? undefined : password ? 'Wrong password' : 'Enter the password to read it'}>
          <Input type="password" value={password} onChange={e => setPassword(e.target.value)} />
        </Field>
      )}
      {file && pages > 0 && <p className="text-xs text-muted-foreground">{pages} pages{info?.pageSize ? ` · ${info.pageSize.widthMm} × ${info.pageSize.heightMm} mm` : ''}</p>}
      <Field label="Split mode">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'ranges', label: 'Page ranges' }, { value: 'every', label: 'Every N pages' }, { value: 'each', label: 'Every page' }]} />
      </Field>
      {mode === 'ranges' && (
        <div className="space-y-2">
          <Field label="Ranges" hint="Comma-separated: 1-3, 5, 8- (to the end), -2 (first two), last">
            <Input value={ranges} placeholder="1-3, 5, 8-" className={cn(MONO, desc.error && ranges.trim() && 'border-destructive')} onChange={e => setRanges(e.target.value)} />
          </Field>
          <Checkbox checked={single} onChange={setSingle}>Extract all selected pages into one PDF</Checkbox>
        </div>
      )}
      {mode === 'every' && <NumberField label="Pages per file" value={every} min={1} max={Math.max(1, pages)} onChange={setEvery} className="max-w-48" />}
      {desc.error && !rangeEmpty && <ErrorBox message={desc.error} />}
      {!desc.error && desc.parts.length > 0 && !rangeEmpty && (
        <div className="rounded-md border border-border p-2.5 space-y-1">
          <p className="text-xs font-medium">Will create {desc.parts.length} file{desc.parts.length === 1 ? '' : 's'}</p>
          <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2 max-h-48 overflow-auto">
            {desc.parts.slice(0, 60).map(p => (
              <div key={p.name} className="flex items-center gap-2 text-[11px]">
                <code className={cn(MONO, 'truncate flex-1')}>{p.name}</code>
                <span className="text-muted-foreground shrink-0">{p.label}</span>
              </div>
            ))}
          </div>
          {desc.parts.length > 60 && <p className="text-[11px] text-muted-foreground">…and {desc.parts.length - 60} more</p>}
        </div>
      )}
      <RunButton running={running} onCancel={cancel} disabled={!file || !available || !!desc.error || rangeEmpty || (info?.needsPassword && !info.unlocked)}
        onClick={() => file && run('pdf-split', [file], { mode, ranges, every, single, password })}>
        Split PDF
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
    </div>
  );
}

const COMPRESS_PRESETS = [
  { value: 'screen', title: 'Screen', dpi: '72 dpi', desc: 'Smallest — for email and on-screen reading' },
  { value: 'ebook', title: 'eBook', dpi: '150 dpi', desc: 'Balanced — sharp on screen, much smaller' },
  { value: 'printer', title: 'Printer', dpi: '300 dpi', desc: 'High quality — safe for printing' },
  { value: 'lossless', title: 'Lossless', dpi: 'images untouched', desc: 'Only cleans and recompresses structure' },
];

export function PdfCompressor() {
  const { files, setFiles, warning } = useFilteredFiles(['pdf'], 20);
  const [preset, setPreset] = useState('ebook');
  const [strip, setStrip] = useState(true);
  const [quality, setQuality] = useState(0);
  const [password, setPassword] = useState('');
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('pdf-compress');
  const m = job?.status === 'done' ? job.meta : null;

  return (
    <div className="space-y-4">
      <ServerStatus ids={['pdf-compress']} />
      <FileDrop files={files} onFiles={setFiles} multiple accept=".pdf" hint="Up to 20 PDFs" />
      {warning && <InfoBox>{warning}</InfoBox>}
      <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
        {COMPRESS_PRESETS.map(p => (
          <button key={p.value} type="button" onClick={() => setPreset(p.value)}
            className={cn('text-left rounded-lg border p-3 space-y-1 transition-colors cursor-pointer',
              preset === p.value ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50')}>
            <p className="text-sm font-semibold">{p.title}</p>
            <p className="text-[11px] text-primary">{p.dpi}</p>
            <p className="text-[11px] text-muted-foreground">{p.desc}</p>
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {preset !== 'lossless' && (
          <NumberField label="JPEG quality (0 = preset default)" value={quality} min={0} max={95} onChange={setQuality} />
        )}
        <Field label="Password (only for protected PDFs)"><Input type="password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
      </div>
      <Checkbox checked={strip} onChange={setStrip}>Remove metadata (author, software, XMP) and page thumbnails</Checkbox>
      <RunButton running={running} onCancel={cancel} disabled={!files.length || !available}
        onClick={() => run('pdf-compress', files, { preset, stripMetadata: strip, quality: quality || 0, password })}>
        Compress {files.length > 1 ? `${files.length} PDFs` : 'PDF'}
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {m && (
        <div className="space-y-2">
          <div className="grid gap-2 grid-cols-3">
            <Stat label="Before" value={formatBytes(m.before)} />
            <Stat label="After" value={formatBytes(m.after)} />
            <Stat label="Saved" value={`${m.savedPct}%`} hint={formatBytes(m.before - m.after)} />
          </div>
          {m.files?.length > 0 && (
            <div className="space-y-1">
              {m.files.map((f: any) => (
                <div key={f.file} className="flex flex-wrap items-center gap-2 text-xs rounded-md border border-border px-2.5 py-1.5">
                  <span className="flex-1 min-w-0 truncate">{f.file}</span>
                  <span className="tabular-nums text-muted-foreground">{formatBytes(f.before)} → {formatBytes(f.after)}</span>
                  {f.keptOriginal
                    ? <Badge variant="outline">Already optimal — original kept</Badge>
                    : <Badge>−{Math.round((1 - f.after / f.before) * 100)}%</Badge>}
                  {f.recompressed > 0 && <span className="text-[11px] text-muted-foreground">{f.recompressed} of {f.images} images recompressed</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PdfToImage() {
  const { files, setFiles, warning } = useFilteredFiles(['pdf'], 10);
  const [format, setFormat] = useState('png');
  const [dpi, setDpi] = useState(150);
  const [pages, setPages] = useState('');
  const [quality, setQuality] = useState(90);
  const [transparent, setTransparent] = useState(false);
  const [password, setPassword] = useState('');
  const { info } = usePdfInfo(files.length === 1 ? files[0] : null);
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('pdf-to-image');
  const rangeCheck = info?.pages ? parsePageRanges(pages, info.pages) : { ranges: [], error: undefined as string | undefined };
  const count = info?.pages && !rangeCheck.error ? rangeCheck.ranges.reduce((s, [a, b]) => s + b - a + 1, 0) : 0;
  const px = info?.pageSize ? `${Math.round(info.pageSize.widthMm / 25.4 * dpi)} × ${Math.round(info.pageSize.heightMm / 25.4 * dpi)} px` : '';

  return (
    <div className="space-y-4">
      <ServerStatus ids={['pdf-to-image']} />
      <FileDrop files={files} onFiles={setFiles} multiple accept=".pdf" hint="Up to 10 PDFs" />
      {warning && <InfoBox>{warning}</InfoBox>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Format">
          <Segmented value={format} onChange={setFormat} options={[{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WebP' }]} />
        </Field>
        <Field label="Resolution" hint={px ? `≈ ${px} per page` : '150 dpi is right for screens, 300 for print'}>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={String(dpi)} onChange={v => setDpi(Number(v))} options={[72, 150, 300, 600].map(d => ({ value: String(d), label: `${d}` }))} />
            <Input type="number" className="w-20" value={dpi} min={36} max={600} onChange={e => setDpi(Number(e.target.value) || 150)} />
          </div>
        </Field>
        <Field label="Pages" hint={info?.pages ? (rangeCheck.error ?? `${count} of ${info.pages} pages`) : 'Blank = all pages'}>
          <Input value={pages} placeholder="all, or 1-3, 5" className={cn(MONO, rangeCheck.error && 'border-destructive')} onChange={e => setPages(e.target.value)} />
        </Field>
        {format !== 'png'
          ? <NumberField label="Quality" value={quality} min={1} max={100} onChange={setQuality} />
          : <div className="pt-6"><Checkbox checked={transparent} onChange={setTransparent}>Transparent background</Checkbox></div>}
        {info?.needsPassword && <Field label="Password"><Input type="password" value={password} onChange={e => setPassword(e.target.value)} /></Field>}
      </div>
      <RunButton running={running} onCancel={cancel} disabled={!files.length || !available || !!rangeCheck.error}
        onClick={() => run('pdf-to-image', files, { format, dpi, pages, quality, transparent, password })}>
        Render {count ? `${count} page${count === 1 ? '' : 's'}` : 'pages'}
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
    </div>
  );
}

export function PdfToText() {
  const { files, setFiles, warning } = useFilteredFiles(['pdf'], 20);
  const [mode, setMode] = useState('plain');
  const [separators, setSeparators] = useState(true);
  const [pages, setPages] = useState('');
  const [password, setPassword] = useState('');
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('pdf-text');
  const blob = useJobOutputBlob(job, 0, job?.outputs.length === 1);
  const [text, setText] = useState('');
  useEffect(() => { setText(''); blob?.text().then(setText); }, [blob]);
  const meta = job?.status === 'done' ? job.meta : null;

  return (
    <div className="space-y-4">
      <ServerStatus ids={['pdf-text']} />
      <FileDrop files={files} onFiles={setFiles} multiple accept=".pdf" hint="Up to 20 PDFs · one .txt per document" />
      {warning && <InfoBox>{warning}</InfoBox>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Mode" hint={mode === 'layout' ? 'Keeps columns and indentation — good for tables and forms' : 'Natural reading order — good for prose'}>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'plain', label: 'Plain' }, { value: 'layout', label: 'Layout' }]} />
        </Field>
        <Field label="Pages"><Input value={pages} placeholder="all" className={MONO} onChange={e => setPages(e.target.value)} /></Field>
        <Field label="Password (if protected)"><Input type="password" value={password} onChange={e => setPassword(e.target.value)} /></Field>
      </div>
      <Checkbox checked={separators} onChange={setSeparators}>Page separators (===== Page N =====)</Checkbox>
      <RunButton running={running} onCancel={cancel} disabled={!files.length || !available}
        onClick={() => run('pdf-text', files, { mode, separators, pages, password })}>
        Extract text
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {meta && (
        <div className="space-y-2">
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
            <Stat label="Pages" value={meta.pages} />
            <Stat label="Characters" value={Number(meta.chars).toLocaleString()} />
            <Stat label="Words (approx.)" value={text ? text.split(/\s+/).filter(Boolean).length.toLocaleString() : '—'} />
          </div>
          {meta.noTextLayer?.length > 0 && (
            <InfoBox>No text layer found in {meta.noTextLayer.join(', ')} — these look like scanned images and would need OCR.</InfoBox>
          )}
          {text && (
            <Field label="Text" className="w-full">
              <div className="flex justify-end gap-1 -mt-7">
                <CopyButton value={text} label="Copy" />
              </div>
              <Textarea readOnly className={cn(MONO, FIXED, 'h-80 bg-secondary/40')} value={text.length > 400_000 ? text.slice(0, 400_000) + '\n… (truncated — download for the full text)' : text} />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

// =====================================================================================
// Audio / video
// =====================================================================================

const MEDIA_IN = [...VIDEO_EXT, ...AUDIO_EXT];

function useMediaMeta(file: File | null) {
  const url = useObjectUrl(file);
  const [meta, setMeta] = useState<{ duration: number; width: number; height: number } | null>(null);
  useEffect(() => {
    setMeta(null);
    if (!url || !file) return;
    const el = document.createElement(kindOf(file.name) === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => setMeta({
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      width: (el as HTMLVideoElement).videoWidth || 0,
      height: (el as HTMLVideoElement).videoHeight || 0,
    });
    el.onerror = () => setMeta(null);
    el.src = url;
    return () => { el.removeAttribute('src'); el.load(); };
  }, [url]);
  return meta;
}

function TimeInput({ label, value, onChange, placeholder, hint }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string }) {
  const parsed = parseTimecode(value);
  const bad = parsed !== null && Number.isNaN(parsed);
  return (
    <Field label={label} hint={bad ? 'Use seconds (75.5) or m:ss.ms (1:15.5)' : hint}>
      <Input value={value} placeholder={placeholder} className={cn(MONO, bad && 'border-destructive')} onChange={e => onChange(e.target.value)} />
    </Field>
  );
}

const timeOk = (v: string) => { const p = parseTimecode(v); return p === null || !Number.isNaN(p); };

export function VideoToMp3() {
  const { files, setFiles, warning } = useFilteredFiles(MEDIA_IN, 20);
  const [mode, setMode] = useState('cbr');
  const [bitrate, setBitrate] = useState('192');
  const [vbr, setVbr] = useState('2');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('video-to-mp3');
  const meta = useMediaMeta(files[0] ?? null);

  return (
    <div className="space-y-4">
      <ServerStatus ids={['video-to-mp3']} />
      <FileDrop files={files} onFiles={setFiles} multiple accept={accept(MEDIA_IN)} hint="MP4, MOV, MKV, WebM, AVI… · up to 20 files" />
      {warning && <InfoBox>{warning}</InfoBox>}
      {meta && files.length === 1 && <p className="text-xs text-muted-foreground">Duration {formatTimecode(meta.duration, 1)}{meta.width ? ` · ${meta.width}×${meta.height}` : ''}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bitrate mode">
          <Segmented value={mode} onChange={setMode} options={[{ value: 'cbr', label: 'Constant (CBR)' }, { value: 'vbr', label: 'Variable (VBR)' }]} />
        </Field>
        {mode === 'cbr' ? (
          <Field label="Bitrate">
            <Segmented value={bitrate} onChange={setBitrate} options={['128', '192', '256', '320'].map(b => ({ value: b, label: `${b}k` }))} />
          </Field>
        ) : (
          <Field label="VBR quality" hint="V0 is best; V2 is transparent for most listeners">
            <Segmented value={vbr} onChange={setVbr} options={['0', '1', '2', '3', '4'].map(v => ({ value: v, label: `V${v}` }))} />
          </Field>
        )}
        <TimeInput label="Start (optional)" value={start} onChange={setStart} placeholder="0:00" />
        <TimeInput label="End (optional)" value={end} onChange={setEnd} placeholder="end" />
      </div>
      <RunButton running={running} onCancel={cancel} disabled={!files.length || !available || !timeOk(start) || !timeOk(end)}
        onClick={() => run('video-to-mp3', files, { mode, bitrate, vbr, start, end })}>
        Extract MP3{files.length > 1 ? ` from ${files.length} files` : ''}
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {job?.status === 'done' && job.outputs.length === 1 && <MediaPreview job={job} kind="audio" />}
    </div>
  );
}

const AUDIO_FORMATS = [
  { value: 'mp3', label: 'MP3' }, { value: 'm4a', label: 'M4A' }, { value: 'aac', label: 'AAC' }, { value: 'ogg', label: 'OGG' },
  { value: 'opus', label: 'Opus' }, { value: 'flac', label: 'FLAC' }, { value: 'wav', label: 'WAV' },
];
const BITRATES = [{ value: 'auto', label: 'Auto (high quality)' }, ...[64, 96, 128, 160, 192, 256, 320].map(b => ({ value: String(b), label: `${b} kbps` }))];

export function AudioConverter() {
  const { files, setFiles, warning } = useFilteredFiles(MEDIA_IN, 20);
  const [format, setFormat] = useState('mp3');
  const [bitrate, setBitrate] = useState('auto');
  const [sampleRate, setSampleRate] = useState('keep');
  const [channels, setChannels] = useState('keep');
  const [loudnorm, setLoudnorm] = useState(false);
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('audio-convert');
  const lossless = format === 'flac' || format === 'wav';

  return (
    <div className="space-y-4">
      <ServerStatus ids={['audio-convert']} />
      <FileDrop files={files} onFiles={setFiles} multiple accept={accept(MEDIA_IN)} hint="Any audio (or video — the audio track is used) · up to 20 files" />
      {warning && <InfoBox>{warning}</InfoBox>}
      <Field label="Output format"><Segmented value={format} onChange={setFormat} options={AUDIO_FORMATS} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Bitrate" hint={lossless ? 'Not used for lossless formats' : undefined}>
          <Select value={bitrate} onChange={setBitrate} options={BITRATES} disabled={lossless} />
        </Field>
        <Field label="Sample rate">
          <Select value={sampleRate} onChange={setSampleRate} options={[{ value: 'keep', label: 'Keep original' }, ...[8000, 16000, 22050, 32000, 44100, 48000].map(r => ({ value: String(r), label: `${r / 1000} kHz` }))]} />
        </Field>
        <Field label="Channels">
          <Segmented value={channels} onChange={setChannels} options={[{ value: 'keep', label: 'Keep' }, { value: 'mono', label: 'Mono' }, { value: 'stereo', label: 'Stereo' }]} />
        </Field>
      </div>
      <Checkbox checked={loudnorm} onChange={setLoudnorm}>Normalize loudness (EBU R128, −16 LUFS — evens out quiet and loud files)</Checkbox>
      <RunButton running={running} onCancel={cancel} disabled={!files.length || !available}
        onClick={() => run('audio-convert', files, { format, bitrate, sampleRate, channels, loudnorm })}>
        Convert to {format.toUpperCase()}
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {job?.status === 'done' && job.outputs.length === 1 && <MediaPreview job={job} kind="audio" />}
    </div>
  );
}

// ---------- audio cutter with waveform ----------

const BUCKETS = 2000;

async function decodePeaks(file: File): Promise<{ peaks: Float32Array; duration: number }> {
  const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new AC();
  try {
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const peaks = new Float32Array(BUCKETS);
    const per = Math.max(1, Math.floor(audio.length / BUCKETS));
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let b = 0; b < BUCKETS; b++) {
        let max = 0;
        const start = b * per;
        const end = Math.min(data.length, start + per);
        for (let i = start; i < end; i += 4) { const v = Math.abs(data[i]); if (v > max) max = v; }
        if (max > peaks[b]) peaks[b] = max;
      }
    }
    return { peaks, duration: audio.duration };
  } finally {
    void ctx.close();
  }
}

export function AudioCutter() {
  const [file, setFile] = useState<File | null>(null);
  const url = useObjectUrl(file);
  const audioRef = useRef<HTMLAudioElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mutedRef = useRef<HTMLSpanElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [duration, setDuration] = useState(0);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState('');
  const [sel, setSel] = useState<[number, number]>([0, 0]);
  const [startText, setStartText] = useState('0:00.00');
  const [endText, setEndText] = useState('');
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const [format, setFormat] = useState('same');
  const [bitrate, setBitrate] = useState('auto');
  const [width, setWidth] = useState(600);
  const drag = useRef<{ mode: 'start' | 'end' | 'move' | 'new'; origin: number; sel: [number, number] } | null>(null);
  const stopAt = useRef<number | null>(null);
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('audio-cut');

  // Decode for the waveform.
  useEffect(() => {
    setPeaks(null); setDecodeError(''); setDuration(0); setPlayhead(0);
    if (!file) return;
    if (file.size > 300 * 1024 * 1024) { setDecodeError('File is too large to draw a waveform in the browser — enter times manually.'); return; }
    let alive = true;
    setDecoding(true);
    decodePeaks(file).then(r => {
      if (!alive) return;
      setPeaks(r.peaks); setDuration(r.duration); setSel([0, r.duration]);
    }).catch(() => alive && setDecodeError("Your browser can't decode this format for a waveform — you can still cut it by entering times.")).finally(() => alive && setDecoding(false));
    return () => { alive = false; };
  }, [file]);

  // Fallback duration from the <audio> element (formats the browser can play but not decode, or huge files).
  const onMeta = () => {
    const d = audioRef.current?.duration;
    if (d && Number.isFinite(d) && !duration) { setDuration(d); setSel([0, d]); }
  };

  useEffect(() => { setStartText(formatTimecode(sel[0])); setEndText(formatTimecode(sel[1])); }, [sel[0], sel[1]]);

  // Track container width for a crisp canvas.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [file]);

  // Draw the waveform (colours come from theme tokens via computed CSS colour).
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !peaks || !duration) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 128;
    c.width = Math.max(1, Math.floor(width * dpr));
    c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const active = getComputedStyle(c).color;
    const muted = mutedRef.current ? getComputedStyle(mutedRef.current).color : active;
    const mid = h / 2;
    for (let x = 0; x < width; x++) {
      const b = Math.min(BUCKETS - 1, Math.floor((x / width) * BUCKETS));
      const b2 = Math.min(BUCKETS, Math.floor(((x + 1) / width) * BUCKETS));
      let amp = 0;
      for (let k = b; k < Math.max(b + 1, b2); k++) amp = Math.max(amp, peaks[k]);
      const t = (x / width) * duration;
      g.fillStyle = t >= sel[0] && t <= sel[1] ? active : muted;
      const bar = Math.max(1, amp * (h - 8));
      g.fillRect(x, mid - bar / 2, 1, bar);
    }
  }, [peaks, duration, width, sel[0], sel[1]]);

  // Smooth playhead + stop at selection end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) {
        setPlayhead(a.currentTime);
        if (stopAt.current !== null && a.currentTime >= stopAt.current) { a.pause(); stopAt.current = null; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const timeAt = (clientX: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
  };
  const pxPerSec = duration ? width / duration : 0;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!duration) return;
    const t = timeAt(e.clientX);
    const near = (x: number) => Math.abs((t - x) * pxPerSec) < 10;
    let mode: 'start' | 'end' | 'move' | 'new' = 'new';
    if (near(sel[0])) mode = 'start';
    else if (near(sel[1])) mode = 'end';
    else if (t > sel[0] && t < sel[1] && e.shiftKey) mode = 'move';
    drag.current = { mode, origin: t, sel: [...sel] as [number, number] };
    if (mode === 'new') setSel([t, t]);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = timeAt(e.clientX);
    if (d.mode === 'start') setSel([Math.min(t, d.sel[1] - 0.01), d.sel[1]]);
    else if (d.mode === 'end') setSel([d.sel[0], Math.max(t, d.sel[0] + 0.01)]);
    else if (d.mode === 'move') {
      const len = d.sel[1] - d.sel[0];
      const s = Math.min(duration - len, Math.max(0, d.sel[0] + t - d.origin));
      setSel([s, s + len]);
    } else setSel(t >= d.origin ? [d.origin, t] : [t, d.origin]);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.mode === 'new' && sel[1] - sel[0] < 0.05) {
      // A click (not a drag) seeks instead of creating an empty selection.
      setSel(d.sel);
      if (audioRef.current) { audioRef.current.currentTime = d.origin; setPlayhead(d.origin); }
    }
  };

  const play = (from: number, to: number | null) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = from;
    stopAt.current = to;
    void a.play();
  };

  const commitTimes = () => {
    const s = parseTimecode(startText);
    const e = parseTimecode(endText);
    if (s === null || Number.isNaN(s) || e === null || Number.isNaN(e) || e <= s) { setStartText(formatTimecode(sel[0])); setEndText(formatTimecode(sel[1])); return; }
    setSel([Math.max(0, s), duration ? Math.min(duration, e) : e]);
  };

  const len = Math.max(0, sel[1] - sel[0]);
  const nudge = (which: 0 | 1, delta: number) => setSel(s => {
    const n: [number, number] = [...s] as [number, number];
    n[which] = Math.min(duration || Infinity, Math.max(0, n[which] + delta));
    if (n[1] <= n[0]) return s;
    return n;
  });

  return (
    <div className="space-y-4">
      <ServerStatus ids={['audio-cut']} />
      <FileDrop files={file ? [file] : []} onFiles={l => { setFile(l[0] ?? null); }} accept={accept(MEDIA_IN)} hint="MP3, WAV, M4A, OGG, FLAC… (or a video's audio track)" />
      {file && (
        <>
          <audio ref={audioRef} src={url} onLoadedMetadata={onMeta} onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); setPlayhead(audioRef.current?.currentTime ?? 0); }} className="hidden" />
          {decoding && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Drawing waveform…</p>}
          {decodeError && <InfoBox>{decodeError}</InfoBox>}
          {duration > 0 && (
            <div className="space-y-1">
              <div
                ref={wrapRef}
                className="relative h-32 rounded-md border border-border bg-secondary/30 overflow-hidden select-none touch-none cursor-crosshair"
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
              >
                {peaks && <canvas ref={canvasRef} className="absolute inset-0 w-full h-full text-primary" />}
                <span ref={mutedRef} className="hidden text-muted-foreground/40" />
                <div className="absolute inset-y-0 bg-primary/10 border-x-2 border-primary pointer-events-none"
                  style={{ left: `${(sel[0] / duration) * 100}%`, width: `${(len / duration) * 100}%` }}>
                  <div className="absolute -left-[5px] top-1/2 -translate-y-1/2 h-8 w-2 rounded-sm bg-primary" />
                  <div className="absolute -right-[5px] top-1/2 -translate-y-1/2 h-8 w-2 rounded-sm bg-primary" />
                </div>
                <div className="absolute inset-y-0 w-px bg-foreground pointer-events-none" style={{ left: `${(playhead / duration) * 100}%` }} />
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                <span>0:00</span><span>Drag to select · drag the edges to adjust · shift-drag to move · click to seek</span><span>{formatTimecode(duration, 1)}</span>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={!duration} onClick={() => (playing ? audioRef.current?.pause() : play(sel[0], sel[1]))}>
              {playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play selection'}
            </Button>
            <Button variant="ghost" size="sm" disabled={!duration || playing} onClick={() => play(playhead, null)}><Play /> From playhead</Button>
            <Button variant="ghost" size="sm" disabled={!duration} onClick={() => setSel([0, duration])}>Select all</Button>
            <span className="text-xs text-muted-foreground tabular-nums ml-auto">Selection {formatTimecode(len, 2)} · playhead {formatTimecode(playhead, 2)}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Start">
              <div className="flex gap-1">
                <Input value={startText} className={MONO} onChange={e => setStartText(e.target.value)} onBlur={commitTimes} onKeyDown={e => e.key === 'Enter' && commitTimes()} />
                <Button variant="ghost" size="icon-sm" title="−0.1 s" onClick={() => nudge(0, -0.1)}>−</Button>
                <Button variant="ghost" size="icon-sm" title="+0.1 s" onClick={() => nudge(0, 0.1)}>+</Button>
              </div>
            </Field>
            <Field label="End">
              <div className="flex gap-1">
                <Input value={endText} className={MONO} onChange={e => setEndText(e.target.value)} onBlur={commitTimes} onKeyDown={e => e.key === 'Enter' && commitTimes()} />
                <Button variant="ghost" size="icon-sm" title="−0.1 s" onClick={() => nudge(1, -0.1)}>−</Button>
                <Button variant="ghost" size="icon-sm" title="+0.1 s" onClick={() => nudge(1, 0.1)}>+</Button>
              </div>
            </Field>
            <NumberField label="Fade in" suffix="s" value={fadeIn} min={0} max={30} step={0.1} onChange={setFadeIn} />
            <NumberField label="Fade out" suffix="s" value={fadeOut} min={0} max={30} step={0.1} onChange={setFadeOut} />
            <Field label="Format"><Select value={format} onChange={setFormat} options={[{ value: 'same', label: 'Same as input' }, ...AUDIO_FORMATS]} /></Field>
            <Field label="Bitrate"><Select value={bitrate} onChange={setBitrate} options={BITRATES} disabled={format === 'flac' || format === 'wav'} /></Field>
          </div>
          <RunButton running={running} onCancel={cancel} disabled={!available || len <= 0}
            onClick={() => run('audio-cut', [file], { start: sel[0].toFixed(3), end: sel[1].toFixed(3), fadeIn: fadeIn || 0, fadeOut: fadeOut || 0, format, bitrate })}>
            <Scissors /> Cut {formatTimecode(len, 2)}
          </RunButton>
          <JobResult job={job} error={error} running={running} onCancel={cancel} />
          {job?.status === 'done' && <MediaPreview job={job} kind="audio" />}
        </>
      )}
    </div>
  );
}

// ---------- video ----------

export function VideoConverter() {
  const { files, setFiles, warning } = useFilteredFiles([...VIDEO_EXT, 'gif'], 5);
  const [format, setFormat] = useState('mp4');
  const [quality, setQuality] = useState('medium');
  const [speed, setSpeed] = useState('balanced');
  const [maxHeight, setMaxHeight] = useState('keep');
  const [fps, setFps] = useState('keep');
  const [sizeMode, setSizeMode] = useState<'quality' | 'size'>('quality');
  const [targetMb, setTargetMb] = useState(25);
  const [audioBitrate, setAudioBitrate] = useState('128');
  const [stripAudio, setStripAudio] = useState(false);
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('video-convert');
  const meta = useMediaMeta(files[0] ?? null);
  const kbps = meta?.duration ? targetVideoKbps(targetMb, meta.duration, stripAudio ? 0 : Number(audioBitrate)) : NaN;
  const done = job?.status === 'done' ? job.meta : null;

  return (
    <div className="space-y-4">
      <ServerStatus ids={['video-convert']} />
      <FileDrop files={files} onFiles={setFiles} multiple accept={accept([...VIDEO_EXT, 'gif'])} hint="MP4, MOV, MKV, WebM, AVI, GIF… · up to 5 files" />
      {warning && <InfoBox>{warning}</InfoBox>}
      {meta && <p className="text-xs text-muted-foreground">{files[0]?.name}: {meta.width}×{meta.height} · {formatTimecode(meta.duration, 1)} · {formatBytes(files[0]?.size ?? 0)}</p>}
      <Field label="Format">
        <Segmented value={format} onChange={setFormat} options={[{ value: 'mp4', label: 'MP4 (H.264)' }, { value: 'webm', label: 'WebM (VP9)' }, { value: 'mov', label: 'MOV' }, { value: 'mkv', label: 'MKV' }]} />
      </Field>
      <Field label="Size control">
        <Segmented value={sizeMode} onChange={setSizeMode} options={[{ value: 'quality', label: 'By quality' }, { value: 'size', label: 'Target file size' }]} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sizeMode === 'quality' ? (
          <Field label="Quality">
            <Segmented value={quality} onChange={setQuality} options={[{ value: 'high', label: 'High' }, { value: 'medium', label: 'Balanced' }, { value: 'low', label: 'Small' }]} />
          </Field>
        ) : (
          <Field label="Target size" hint={Number.isFinite(kbps) ? (kbps < 60 ? 'Too small for this length — pick a bigger size or lower resolution' : `≈ ${kbps} kbps video for ${files[0]?.name}`) : 'Approximate (single pass)'}>
            <div className="flex items-center gap-1.5">
              <Input type="number" value={targetMb} min={1} onChange={e => setTargetMb(Number(e.target.value) || 1)} />
              <span className="text-xs text-muted-foreground">MB</span>
            </div>
            <div className="flex flex-wrap gap-1 pt-1">
              {[8, 10, 25, 50, 100].map(s => <Button key={s} variant="ghost" size="xs" onClick={() => setTargetMb(s)}>{s} MB</Button>)}
            </div>
          </Field>
        )}
        <Field label="Max resolution">
          <Select value={maxHeight} onChange={setMaxHeight} options={[{ value: 'keep', label: 'Keep original' }, ...['2160', '1440', '1080', '720', '480', '360'].map(h => ({ value: h, label: `${h}p` }))]} />
        </Field>
        <Field label="Frame rate">
          <Select value={fps} onChange={setFps} options={[{ value: 'keep', label: 'Keep original' }, ...['60', '30', '25', '24', '15'].map(r => ({ value: r, label: `${r} fps` }))]} />
        </Field>
        <Field label="Encoder speed" hint="Slower = smaller file at the same quality">
          <Segmented value={speed} onChange={setSpeed} options={[{ value: 'fast', label: 'Fast' }, { value: 'balanced', label: 'Balanced' }, { value: 'small', label: 'Slow' }]} />
        </Field>
        <Field label="Audio bitrate">
          <Select value={audioBitrate} onChange={setAudioBitrate} disabled={stripAudio} options={['64', '96', '128', '160', '192'].map(b => ({ value: b, label: `${b} kbps` }))} />
        </Field>
        <div className="pt-6"><Checkbox checked={stripAudio} onChange={setStripAudio}>Remove audio</Checkbox></div>
      </div>
      <RunButton running={running} onCancel={cancel} disabled={!files.length || !available}
        onClick={() => run('video-convert', files, {
          format, quality, speed, maxHeight, fps, audioBitrate, stripAudio, targetSizeMb: sizeMode === 'size' ? targetMb : 0,
        })}>
        Convert {files.length > 1 ? `${files.length} videos` : 'video'}
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {done?.files?.length > 0 && (
        <div className="space-y-1">
          {done.files.map((f: any) => (
            <div key={f.output} className="flex flex-wrap items-center gap-2 text-xs rounded-md border border-border px-2.5 py-1.5">
              <span className="flex-1 min-w-0 truncate">{f.output}</span>
              <span className="text-muted-foreground">{f.inputResolution} → {f.outputResolution} · {f.vcodec}</span>
              <span className="tabular-nums">{formatBytes(f.before)} → {formatBytes(f.after)}</span>
              <Badge variant={f.after <= f.before ? 'default' : 'outline'}>{f.after <= f.before ? '−' : '+'}{Math.abs(Math.round((1 - f.after / f.before) * 100))}%</Badge>
            </div>
          ))}
        </div>
      )}
      {job?.status === 'done' && job.outputs.length === 1 && <MediaPreview job={job} kind="video" />}
    </div>
  );
}

export function VideoToGif() {
  const [file, setFile] = useState<File | null>(null);
  const url = useObjectUrl(file);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoDur, setVideoDur] = useState(0);
  const [start, setStart] = useState(0);
  const [duration, setDuration] = useState(4);
  const [loopPreview, setLoopPreview] = useState(true);
  const [fps, setFps] = useState(12);
  const [width, setWidth] = useState(480);
  const [dither, setDither] = useState('sierra2_4a');
  const [loop, setLoop] = useState('0');
  const [format, setFormat] = useState('gif');
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('video-to-gif');
  const end = Math.min(videoDur || Infinity, start + duration);
  const frames = Math.round(fps * (end - start));

  const onTime = () => {
    const v = videoRef.current;
    if (!v || !loopPreview || v.paused) return;
    if (v.currentTime >= end || v.currentTime < start - 0.3) v.currentTime = start;
  };

  return (
    <div className="space-y-4">
      <ServerStatus ids={['video-to-gif']} />
      <FileDrop files={file ? [file] : []} onFiles={l => { setFile(l[0] ?? null); setStart(0); }} accept={accept([...VIDEO_EXT, 'gif'])} hint="MP4, MOV, WebM, MKV… · clips up to 30 s" />
      {file && (
        <>
          <video ref={videoRef} src={url} controls playsInline muted onTimeUpdate={onTime}
            onLoadedMetadata={e => setVideoDur(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
            className="w-full max-h-80 rounded-md border border-border bg-black" />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setStart(Math.round((videoRef.current?.currentTime ?? 0) * 10) / 10)}>Start here</Button>
            <Button variant="outline" size="sm" onClick={() => { const t = videoRef.current?.currentTime ?? 0; if (t > start) setDuration(Math.min(30, Math.round((t - start) * 10) / 10)); }}>End here</Button>
            <Button variant="ghost" size="sm" onClick={() => { const v = videoRef.current; if (v) { v.currentTime = start; void v.play(); } }}><Play /> Preview segment</Button>
            <Checkbox checked={loopPreview} onChange={setLoopPreview}>Loop segment</Checkbox>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatTimecode(start, 1)} → {formatTimecode(end, 1)} · {frames} frames</span>
          </div>
          {videoDur > 0 && (
            <input type="range" className="w-full accent-[var(--primary)]" min={0} max={Math.max(0, videoDur - 0.1)} step={0.1} value={start}
              onChange={e => { const s = Number(e.target.value); setStart(s); if (videoRef.current) videoRef.current.currentTime = s; }} />
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField label="Start" suffix="s" value={start} min={0} step={0.1} onChange={v => setStart(Math.max(0, v || 0))} />
            <NumberField label="Duration" suffix="s" value={duration} min={0.2} max={30} step={0.1} onChange={v => setDuration(Math.min(30, Math.max(0.2, v || 1)))} />
            <Field label="Frame rate"><Segmented value={String(fps)} onChange={v => setFps(Number(v))} options={['8', '10', '12', '15', '20', '25'].map(v => ({ value: v, label: v }))} /></Field>
            <Field label="Width"><Segmented value={String(width)} onChange={v => setWidth(Number(v))} options={['320', '480', '640', '800'].map(v => ({ value: v, label: `${v}px` }))} /></Field>
            <Field label="Output">
              <Segmented value={format} onChange={setFormat} options={[{ value: 'gif', label: 'GIF' }, { value: 'webp', label: 'WebP' }, { value: 'mp4', label: 'MP4' }]} />
            </Field>
            {format === 'gif' && (
              <Field label="Dithering">
                <Select value={dither} onChange={setDither} options={[
                  { value: 'sierra2_4a', label: 'Sierra (smooth)' }, { value: 'floyd_steinberg', label: 'Floyd–Steinberg' },
                  { value: 'bayer', label: 'Bayer (smaller)' }, { value: 'none', label: 'None (smallest)' },
                ]} />
              </Field>
            )}
            {format !== 'mp4' && (
              <Field label="Loop"><Segmented value={loop} onChange={setLoop} options={[{ value: '0', label: 'Forever' }, { value: '-1', label: 'Once' }]} /></Field>
            )}
          </div>
          {frames > 360 && format === 'gif' && <InfoBox>{frames} frames will make a large GIF — lower the frame rate, width or duration, or choose WebP / MP4.</InfoBox>}
          <RunButton running={running} onCancel={cancel} disabled={!available || duration <= 0}
            onClick={() => run('video-to-gif', [file], { start: start.toFixed(2), duration, fps, width, dither, loop, format })}>
            Make {format.toUpperCase()}
          </RunButton>
          <JobResult job={job} error={error} running={running} onCancel={cancel} />
          {job?.status === 'done' && format === 'mp4' && <MediaPreview job={job} kind="video" />}
        </>
      )}
    </div>
  );
}

// =====================================================================================
// EXIF viewer & stripper
// =====================================================================================

type ExifGroups = Record<string, Record<string, unknown>>;

function fmtExifValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toLocaleString();
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `<${(v as Uint8Array).byteLength} bytes>`;
  if (Array.isArray(v)) return v.length > 16 ? `[${v.slice(0, 16).map(fmtExifValue).join(', ')}, … ${v.length} items]` : v.map(fmtExifValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 300);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return String(v).replace(/\0+$/, '');
}

const EXIF_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tif', 'tiff'];

function exposure(t: unknown) {
  const n = Number(t);
  if (!n) return '';
  return n >= 1 ? `${n} s` : `1/${Math.round(1 / n)} s`;
}

function ExifSummary({ all, gps }: { all: Record<string, any>; gps: { latitude: number; longitude: number } | null }) {
  const camera = [all.Make, all.Model].filter(Boolean).join(' ').replace(/\0/g, '').trim();
  const items: [string, string][] = [
    ['Camera', camera],
    ['Lens', all.LensModel || all.Lens || ''],
    ['Taken', fmtExifValue(all.DateTimeOriginal ?? all.CreateDate ?? '')],
    ['Modified', all.DateTimeOriginal || all.CreateDate ? '' : fmtExifValue(all.ModifyDate ?? '')],
    ['Exposure', [exposure(all.ExposureTime), all.FNumber ? `f/${all.FNumber}` : '', all.ISO ? `ISO ${all.ISO}` : '', all.FocalLength ? `${all.FocalLength} mm` : ''].filter(Boolean).join(' · ')],
    ['Size', all.ExifImageWidth ? `${all.ExifImageWidth} × ${all.ExifImageHeight}` : all.ImageWidth ? `${all.ImageWidth} × ${all.ImageHeight}` : ''],
    ['Orientation', all.Orientation ? String(all.Orientation) : ''],
    ['Software', all.Software || ''],
    ['Owner / artist', [all.Artist, all.OwnerName, all.CameraOwnerName, all.Copyright].filter(Boolean).join(' · ')],
  ].filter(([, v]) => v) as [string, string][];
  const flags = [
    gps && 'GPS location',
    (all.BodySerialNumber || all.SerialNumber || all.InternalSerialNumber) && 'Camera serial number',
    (all.Artist || all.OwnerName || all.CameraOwnerName) && 'Owner name',
    (all.DateTimeOriginal || all.ModifyDate) && 'Timestamps',
  ].filter(Boolean) as string[];
  return (
    <div className="space-y-2">
      {flags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <TriangleAlert className="size-3.5 text-destructive" />
          <span className="text-xs text-muted-foreground">Privacy-sensitive:</span>
          {flags.map(f => <Badge key={f} variant="destructive">{f}</Badge>)}
        </div>
      )}
      {items.length > 0 && (
        <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
          {items.map(([k, v]) => <Stat key={k} label={k} value={<span className="text-sm">{v}</span>} />)}
        </div>
      )}
      {gps && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
          <MapPin className="size-4 text-destructive shrink-0" />
          <span className={MONO}>{formatDms(gps.latitude, true)}, {formatDms(gps.longitude, false)}</span>
          <span className="text-muted-foreground tabular-nums">({gps.latitude.toFixed(6)}, {gps.longitude.toFixed(6)})</span>
          {typeof all.GPSAltitude === 'number' && <span className="text-muted-foreground">alt {Math.round(all.GPSAltitude)} m</span>}
          <a href={osmUrl(gps.latitude, gps.longitude)} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
            OpenStreetMap <ExternalLink className="size-3" />
          </a>
          <CopyButton value={`${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}`} />
        </div>
      )}
    </div>
  );
}

export function ExifViewer() {
  const { files, setFiles, warning } = useFilteredFiles(EXIF_EXT, 50);
  const [sel, setSel] = useState(0);
  const file = files[sel] ?? null;
  const url = useObjectUrl(file);
  const [groups, setGroups] = useState<ExifGroups | null>(null);
  const [gps, setGps] = useState<{ latitude: number; longitude: number } | null>(null);
  const [readError, setReadError] = useState('');
  const [filter, setFilter] = useState('');
  const [imgFailed, setImgFailed] = useState(false);
  const [keepIcc, setKeepIcc] = useState(true);
  const [jpegMode, setJpegMode] = useState('lossless');
  const [verify, setVerify] = useState<Record<number, number | null>>({});
  const { run, job, running, error, cancel } = useJob();
  const available = useAvailable('exif-strip');

  useEffect(() => { if (sel >= files.length) setSel(0); }, [files.length, sel]);
  useEffect(() => {
    setGroups(null); setGps(null); setReadError(''); setImgFailed(false);
    if (!file) return;
    let alive = true;
    (async () => {
      const exifr = (await import('exifr')).default;
      try {
        const out = await exifr.parse(file, {
          tiff: true, ifd1: true, exif: true, gps: true, interop: true, xmp: true, iptc: true, icc: true, jfif: true, ihdr: true,
          makerNote: false, userComment: true, mergeOutput: false, translateValues: true, reviveValues: true,
        } as any);
        const g = await exifr.gps(file).catch(() => null);
        if (!alive) return;
        setGroups(out ?? {});
        setGps(g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude) ? g : null);
      } catch (e) {
        if (alive) setReadError((e as Error).message || 'Could not read metadata');
      }
    })();
    return () => { alive = false; };
  }, [file]);

  // After stripping, re-read each output to prove what's left.
  useEffect(() => {
    setVerify({});
    if (!job || job.status !== 'done') return;
    let alive = true;
    (async () => {
      const exifr = (await import('exifr')).default;
      for (const o of job.outputs.slice(0, 50)) {
        try {
          const blob = await jobsApi.outputBlob(job, o.index);
          const left = await exifr.parse(blob, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, jfif: false, ihdr: false } as any).catch(() => null);
          const n = left ? Object.keys(left).length : 0;
          if (alive) setVerify(v => ({ ...v, [o.index]: n }));
        } catch {
          if (alive) setVerify(v => ({ ...v, [o.index]: null }));
        }
      }
    })();
    return () => { alive = false; };
  }, [job?.id, job?.status]);

  const flat = useMemo(() => {
    const all: Record<string, any> = {};
    if (groups) for (const g of Object.values(groups)) if (g && typeof g === 'object') Object.assign(all, g);
    return all;
  }, [groups]);
  const groupEntries = groups ? Object.entries(groups).filter(([, v]) => v && typeof v === 'object' && Object.keys(v).length) : [];
  const total = groupEntries.reduce((s, [, v]) => s + Object.keys(v).length, 0);
  const q = filter.trim().toLowerCase();

  return (
    <div className="space-y-4">
      <FileDrop files={[]} onFiles={l => { setFiles([...files, ...l]); }} multiple accept={accept(EXIF_EXT)} hint="JPG, PNG, WebP, HEIC, TIFF · read in your browser; stripping runs on the server" />
      {warning && <InfoBox>{warning}</InfoBox>}
      {files.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <button key={`${f.name}-${i}`} type="button" onClick={() => setSel(i)}
              className={cn('h-7 max-w-48 truncate px-2.5 rounded-md border text-xs cursor-pointer', i === sel ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground')}>
              {f.name}
            </button>
          ))}
          <Button variant="ghost" size="xs" onClick={() => setFiles([])}>Clear all</Button>
        </div>
      )}
      {file && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
          <div className="space-y-1.5">
            {!imgFailed && url
              ? <img src={url} alt={file.name} onError={() => setImgFailed(true)} className="w-full max-h-64 object-contain rounded-md border border-border bg-secondary" />
              : <div className="h-40 flex flex-col items-center justify-center gap-1 rounded-md border border-border bg-secondary text-xs text-muted-foreground"><Camera className="size-5" />No browser preview for {fileExt(file.name).toUpperCase()}</div>}
            <p className="text-[11px] text-muted-foreground truncate">{file.name} · {formatBytes(file.size)}</p>
            {files.length === 1 && <Button variant="ghost" size="xs" onClick={() => setFiles([])}><X /> Remove</Button>}
          </div>
          <div className="space-y-3 min-w-0">
            {readError && <ErrorBox message={readError} />}
            {!groups && !readError && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Reading metadata…</p>}
            {groups && total === 0 && <InfoBox>No metadata found in this file.</InfoBox>}
            {groups && total > 0 && <ExifSummary all={flat} gps={gps} />}
          </div>
        </div>
      )}
      {groups && total > 0 && (
        <div className="space-y-2">
          <FieldLabel action={<Input className="h-7 w-44" placeholder="Filter tags…" value={filter} onChange={e => setFilter(e.target.value)} />}>All metadata ({total} tags)</FieldLabel>
          <div className="space-y-3 max-h-96 overflow-auto rounded-md border border-border p-2">
            {groupEntries.map(([g, tags]) => {
              const rows = Object.entries(tags).filter(([k, v]) => !q || k.toLowerCase().includes(q) || fmtExifValue(v).toLowerCase().includes(q));
              if (!rows.length) return null;
              return (
                <div key={g} className="space-y-0.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</p>
                  {rows.map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2 text-xs py-0.5 border-b border-border/50 last:border-0">
                      <span className="text-muted-foreground truncate" title={k}>{k}</span>
                      <span className={cn(MONO, 'break-all')}>{fmtExifValue(v)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {files.length > 0 && (
        <div className="rounded-md border border-border p-3 space-y-3">
          <p className="text-xs font-medium">Strip metadata from {files.length} file{files.length === 1 ? '' : 's'}</p>
          <ServerStatus ids={['exif-strip']} />
          <div className="flex flex-wrap gap-4">
            <Checkbox checked={keepIcc} onChange={setKeepIcc}>Keep colour profile (recommended)</Checkbox>
          </div>
          <Field label="JPEG rotation" hint={jpegMode === 'lossless' ? 'Pixels untouched; only the orientation flag is kept so photos stay upright.' : 'Pixels rotated and re-saved at quality 95; no metadata at all remains.'}>
            <Segmented value={jpegMode} onChange={setJpegMode} options={[{ value: 'lossless', label: 'Lossless' }, { value: 'reencode', label: 'Rotate pixels' }]} />
          </Field>
          <RunButton running={running} onCancel={cancel} disabled={!available} onClick={() => run('exif-strip', files, { keepIcc, jpegMode })}>
            Strip metadata
          </RunButton>
          <JobResult job={job} error={error} running={running} onCancel={cancel} />
          {job?.status === 'done' && Array.isArray(job.meta?.files) && (
            <div className="space-y-1.5">
              {job.meta.files.map((f: any, i: number) => (
                <div key={`${f.file}-${i}`} className="rounded-md border border-border px-2.5 py-2 text-xs space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium flex-1 min-w-0 truncate">{f.file}</span>
                    <span className="text-muted-foreground">{f.method}</span>
                    <span className="tabular-nums text-muted-foreground">{formatBytes(f.before)} → {formatBytes(f.after)}</span>
                    {verify[i] !== undefined && (
                      verify[i] === null ? null
                        : verify[i] === 0 ? <Badge>Verified clean</Badge>
                          : <Badge variant="outline">{verify[i]} tag{verify[i] === 1 ? '' : 's'} left (orientation)</Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {f.removed.length ? f.removed.map((r: string) => <Badge key={r} variant="destructive">− {r}</Badge>) : <span className="text-muted-foreground">Nothing to remove</span>}
                    {f.kept.map((k: string) => <Badge key={k} variant="secondary">kept {k}</Badge>)}
                  </div>
                  {f.notes?.map((n: string) => <p key={n} className="text-[11px] text-muted-foreground">{n}</p>)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =====================================================================================
// ZIP extractor (client-side)
// =====================================================================================

interface ZipEntryInfo { path: string; dir: boolean; size: number; compressed: number; date: Date; unsafe: string | null }

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  avif: 'image/avif', ico: 'image/x-icon',
};

export function ZipExtractor() {
  const [file, setFile] = useState<File | null>(null);
  const [zip, setZip] = useState<any>(null);
  const [entries, setEntries] = useState<ZipEntryInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set(['']));
  const [preview, setPreview] = useState<{ path: string; kind: 'text' | 'image' | 'binary'; text?: string; url?: string; size: number } | null>(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    setZip(null); setEntries([]); setError(''); setPreview(null); setOpen(new Set(['']));
    if (!file) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const JSZip = (await import('jszip')).default;
        const z = await JSZip.loadAsync(file);
        if (!alive) return;
        const list: ZipEntryInfo[] = [];
        z.forEach((path: string, e: any) => {
          // JSZip synthesises parent folders for "../x" entries (e.g. "/"): skip empty folder artifacts.
          if (e.dir && !path.replace(/\/+$/, '')) return;
          list.push({
            path, dir: e.dir,
            size: e._data?.uncompressedSize ?? 0,
            compressed: e._data?.compressedSize ?? 0,
            date: e.date,
            unsafe: unsafeZipPath(e.unsafeOriginalName ?? path) ?? (e.dir ? null : unsafeZipPath(path)),
          });
        });
        setZip(z);
        setEntries(list);
        const tops = new Set(['']);
        if (list.length < 200) list.filter(e => e.dir).forEach(e => tops.add(e.path));
        setOpen(tops);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (alive) setError(/encrypt/i.test(msg) ? 'This ZIP is password-protected (encrypted) — the browser extractor can\'t open it.' : `Not a readable ZIP: ${msg}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [file]);

  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview?.url]);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const files = entries.filter(e => !e.dir);
  const totalSize = files.reduce((s, e) => s + e.size, 0);
  const unsafe = entries.filter(e => e.unsafe);
  const ratio = file && totalSize ? totalSize / file.size : 0;

  const downloadEntry = async (path: string) => {
    const e = zip?.file(path);
    if (!e) return;
    setBusy(path);
    try {
      downloadBlob(await e.async('blob'), path.split('/').pop() || 'file');
    } finally { setBusy(''); }
  };

  const downloadFolder = async (prefix: string) => {
    if (!zip) return;
    setBusy(prefix || '/');
    try {
      const JSZip = (await import('jszip')).default;
      const out = new JSZip();
      const items = files.filter(e => e.path.startsWith(prefix) && !e.unsafe);
      for (const e of items) out.file(e.path.slice(prefix.length), await zip.file(e.path).async('uint8array'), { date: e.date });
      const blob = await out.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const name = prefix ? prefix.replace(/\/$/, '').split('/').pop() : fileStem(file?.name ?? 'archive');
      downloadBlob(blob, `${name}.zip`);
    } finally { setBusy(''); }
  };

  const showPreview = async (path: string, size: number) => {
    const e = zip?.file(path);
    if (!e) return;
    const kind = previewKind(path);
    setBusy(path);
    try {
      if (kind === 'image') {
        const data: Uint8Array = await e.async('uint8array');
        const blob = new Blob([data as BlobPart], { type: MIME_BY_EXT[fileExt(path)] ?? 'application/octet-stream' });
        setPreview({ path, kind: 'image', url: URL.createObjectURL(blob), size });
      } else {
        const data: Uint8Array = await e.async('uint8array');
        const head = data.subarray(0, 256 * 1024);
        const nul = head.subarray(0, 8000).filter(b => b === 0).length;
        if (!kind && nul > 0) { setPreview({ path, kind: 'binary', size }); return; }
        const text = new TextDecoder('utf-8', { fatal: false }).decode(head);
        setPreview({ path, kind: 'text', text: text + (data.length > head.length ? '\n\n… (preview truncated)' : ''), size });
      }
    } finally { setBusy(''); }
  };

  const renderRow = (node: TreeNode, depth: number): React.ReactNode => {
    const isOpen = open.has(node.path);
    const info = node.dir ? null : entries.find(e => e.path === node.path);
    const pct = node.size ? Math.round((1 - node.compressed / node.size) * 100) : 0;
    return (
      <React.Fragment key={node.path}>
        <div className={cn('flex items-center gap-1.5 px-1.5 py-1 text-xs rounded hover:bg-secondary/60', preview?.path === node.path && 'bg-secondary')}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}>
          {node.dir ? (
            <button type="button" className="flex items-center gap-1 min-w-0 flex-1 text-left cursor-pointer"
              onClick={() => setOpen(s => { const n = new Set(s); n.has(node.path) ? n.delete(node.path) : n.add(node.path); return n; })}>
              {isOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
              {isOpen ? <FolderOpen className="size-3.5 shrink-0 text-primary" /> : <Folder className="size-3.5 shrink-0 text-primary" />}
              <span className="truncate">{node.name}</span>
              <span className="text-muted-foreground shrink-0">({node.children.length})</span>
            </button>
          ) : (
            <button type="button" className="flex items-center gap-1 min-w-0 flex-1 text-left cursor-pointer pl-[18px]" onClick={() => showPreview(node.path, node.size)}>
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate" title={node.path}>{node.name}</span>
            </button>
          )}
          {info?.unsafe && <Badge variant="destructive" title={info.unsafe}>unsafe path</Badge>}
          <span className="tabular-nums text-muted-foreground shrink-0">{formatBytes(node.size)}</span>
          <span className="hidden sm:inline w-12 text-right tabular-nums text-muted-foreground shrink-0" title="Space saved by compression">{node.size ? (pct > 0 ? `${pct}%` : 'stored') : ''}</span>
          {busy === node.path ? <Loader2 className="size-3.5 animate-spin" /> : (
            <Button variant="ghost" size="icon-xs" title={node.dir ? 'Download folder as .zip' : 'Download'} onClick={() => (node.dir ? downloadFolder(node.path) : downloadEntry(node.path))}>
              <Download />
            </Button>
          )}
        </div>
        {node.dir && isOpen && node.children.map(c => renderRow(c, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div className="space-y-4">
      <FileDrop files={file ? [file] : []} onFiles={l => setFile(l[0] ?? null)} accept=".zip,.jar,.apk,.docx,.xlsx,.pptx,.odt,.epub,.cbz,.vsix,.whl,.nupkg"
        hint="Opened entirely in your browser — nothing is uploaded. Also works on .docx/.xlsx/.jar/.apk/.epub (they're ZIPs)." />
      {loading && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Reading archive…</p>}
      {error && <ErrorBox message={error} />}
      {zip && (
        <>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            <Stat label="Files" value={files.length.toLocaleString()} hint={`${entries.length - files.length} folders`} />
            <Stat label="Unpacked size" value={formatBytes(totalSize)} />
            <Stat label="Archive size" value={formatBytes(file?.size ?? 0)} />
            <Stat label="Compression" value={totalSize ? `${Math.max(0, Math.round((1 - (file?.size ?? 0) / totalSize) * 100))}%` : '—'} hint={ratio > 1 ? `${ratio.toFixed(1)}× ratio` : undefined} />
          </div>
          {unsafe.length > 0 && (
            <ErrorBox message={`Zip-slip warning: ${unsafe.length} entr${unsafe.length === 1 ? 'y has' : 'ies have'} a path that would escape the extraction folder (${unsafe.slice(0, 3).map(e => `"${e.path}" — ${e.unsafe}`).join('; ')}). Tools that extract blindly could overwrite files elsewhere. These entries are skipped from folder downloads.`} />
          )}
          {ratio > 100 && <ErrorBox message={`Unusual compression ratio (${Math.round(ratio)}×) — this may be a zip bomb. Extract with care.`} />}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(new Set(['', ...entries.filter(e => e.dir).map(e => e.path), ...collectDirs(tree)]))}>Expand all</Button>
            <Button variant="outline" size="sm" onClick={() => setOpen(new Set(['']))}>Collapse all</Button>
            <Button size="sm" disabled={!!busy} onClick={() => downloadFolder('')}><Download /> Re-download clean copy</Button>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border border-border p-1 max-h-[28rem] overflow-auto">
              {tree.children.map(c => renderRow(c, 0))}
            </div>
            <div className="rounded-md border border-border p-2 min-h-40 space-y-2 min-w-0">
              {!preview && <p className="text-xs text-muted-foreground p-2">Click a file to preview it (text and images).</p>}
              {preview && (
                <>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="flex-1 min-w-0 truncate font-medium" title={preview.path}>{preview.path}</span>
                    <span className="text-muted-foreground">{formatBytes(preview.size)}</span>
                    {preview.kind === 'text' && <CopyButton value={preview.text ?? ''} />}
                    <Button variant="ghost" size="icon-xs" onClick={() => downloadEntry(preview.path)}><Download /></Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => setPreview(null)}><X /></Button>
                  </div>
                  {preview.kind === 'image' && <img src={preview.url} alt={preview.path} className="max-h-96 max-w-full object-contain mx-auto rounded bg-secondary" />}
                  {preview.kind === 'text' && <pre className={cn(MONO, 'max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-secondary/40 p-2')}>{preview.text}</pre>}
                  {preview.kind === 'binary' && <InfoBox>Binary file — no preview. Download it to open.</InfoBox>}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function collectDirs(n: TreeNode): string[] {
  return n.children.filter(c => c.dir).flatMap(c => [c.path, ...collectDirs(c)]);
}

// =====================================================================================
// File size converter
// =====================================================================================

const SPEED_UNITS = [
  { value: 'kbps', label: 'Kbps', mbps: 0.001 }, { value: 'mbps', label: 'Mbps', mbps: 1 }, { value: 'gbps', label: 'Gbps', mbps: 1000 },
  { value: 'MBps', label: 'MB/s', mbps: 8 }, { value: 'GBps', label: 'GB/s', mbps: 8000 },
];
const COMMON_LINKS = [
  { label: '3G', mbps: 3 }, { label: '4G', mbps: 25 }, { label: '5G', mbps: 300 }, { label: 'Home broadband', mbps: 100 },
  { label: 'Gigabit', mbps: 1000 }, { label: 'USB 2.0', mbps: 280 }, { label: 'USB 3.0', mbps: 3200 }, { label: 'SATA SSD', mbps: 4400 },
];

export function FileSizeConverter() {
  const [value, setValue] = useState('1.5');
  const [unit, setUnit] = useState('GB');
  const [speed, setSpeed] = useState(100);
  const [speedUnit, setSpeedUnit] = useState('mbps');
  const [efficiency, setEfficiency] = useState('0.9');
  const num = Number(value.replace(/,/g, ''));
  const bytes = Number.isFinite(num) ? toBytes(num, unit) : NaN;
  const mbps = speed * (SPEED_UNITS.find(s => s.value === speedUnit)?.mbps ?? 1);
  const secs = transferSeconds(bytes, mbps, Number(efficiency));

  const col = (system: 'decimal' | 'binary', bits: boolean) => SIZE_UNITS.filter(u => u.system === system && !!u.bits === bits);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Field label="Size"><Input value={value} inputMode="decimal" className="text-base" onChange={e => setValue(e.target.value)} /></Field>
        <Field label="Unit"><Select value={unit} onChange={setUnit} options={SIZE_UNITS.map(u => ({ value: u.id, label: u.label }))} /></Field>
      </div>
      {!Number.isFinite(bytes) ? <ErrorBox message="Enter a number" /> : (
        <>
          <div className="grid gap-2 grid-cols-2">
            <Stat label="Decimal (SI, 1000)" value={humanSize(bytes, 'decimal', 3)} hint="What drive makers and macOS use" />
            <Stat label="Binary (IEC, 1024)" value={humanSize(bytes, 'binary', 3)} hint="What Windows shows (labelled KB/MB/GB)" />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {([['Decimal', col('decimal', false)], ['Binary', col('binary', false)], ['Bits', col('decimal', true)]] as const).map(([title, units]) => (
              <div key={title} className="rounded-md border border-border p-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-1 pb-1">{title}</p>
                {units.map(u => {
                  const v = formatNumber(fromBytes(bytes, u.id));
                  return (
                    <div key={u.id} className={cn('flex items-center gap-2 py-1 px-1 border-b border-border/50 last:border-0', u.id === unit && 'bg-primary/10 rounded')}>
                      <span className="w-10 text-xs text-muted-foreground shrink-0">{u.id}</span>
                      <code className={cn(MONO, 'flex-1 min-w-0 break-all')}>{v}</code>
                      <CopyButton value={v} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {unit !== 'B' && ['KB', 'MB', 'GB', 'TB', 'PB'].includes(unit) && (
            <InfoBox>A “{value} {unit}” drive shows up in Windows as <b>{humanSize(bytes, 'binary', 2).replace('i', '')}</b> — the same bytes counted in 1024s ({humanSize(bytes, 'binary', 2)}).</InfoBox>
          )}
          <div className="rounded-md border border-border p-3 space-y-3">
            <p className="text-xs font-medium">Transfer time</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField label="Link speed" value={speed} min={0} onChange={v => setSpeed(v)} />
              <Field label="Unit"><Select value={speedUnit} onChange={setSpeedUnit} options={SPEED_UNITS.map(s => ({ value: s.value, label: s.label }))} /></Field>
              <Field label="Real-world efficiency">
                <Select value={efficiency} onChange={setEfficiency} options={[{ value: '1', label: '100% (theoretical)' }, { value: '0.9', label: '90% (typical TCP)' }, { value: '0.7', label: '70% (Wi-Fi / busy)' }]} />
              </Field>
            </div>
            <Stat label={`${humanSize(bytes)} at ${formatNumber(speed)} ${SPEED_UNITS.find(s => s.value === speedUnit)?.label}`} value={humanDuration(secs)} hint={Number.isFinite(secs) ? `${formatNumber(Math.round(secs * 100) / 100)} seconds` : undefined} />
            <div className="grid gap-1 sm:grid-cols-2">
              {COMMON_LINKS.map(l => (
                <div key={l.label} className="flex items-center justify-between text-xs border-b border-border/50 py-1">
                  <span className="text-muted-foreground">{l.label} <span className="text-[11px]">({l.mbps >= 1000 ? `${l.mbps / 1000} Gbps` : `${l.mbps} Mbps`})</span></span>
                  <span className="tabular-nums">{humanDuration(transferSeconds(bytes, l.mbps, Number(efficiency)))}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
