/**
 * @file tools/jobs.ts
 * @description Generic file-conversion job queue used by the Dev Tools panel.
 *
 * A converter declares what it accepts and how to run; uploads become a job with its own
 * temp directory, run with bounded concurrency, and outputs are downloadable until the
 * job expires (TOOLS_JOB_TTL_MIN, default 60 minutes).
 *
 *  GET    /api/tools/capabilities           → binaries + every converter and whether it can run here
 *  POST   /api/tools/jobs (multipart)       → fields: converter, options (JSON); files: files
 *  GET    /api/tools/jobs                   → recent jobs
 *  GET    /api/tools/jobs/:id               → one job
 *  GET    /api/tools/jobs/:id/files/:index  → download one output
 *  GET    /api/tools/jobs/:id/download      → the single output, or a zip of all outputs
 *  DELETE /api/tools/jobs/:id               → cancel + delete
 */

import { randomUUID } from 'crypto';
import { promises as fs, existsSync } from 'fs';
import { tmpdir } from 'os';
import { basename, extname, join } from 'path';
import JSZip from 'jszip';
import { findBinary, hasPythonModule, type BinaryName } from './binaries';
import { HttpError, readMultipart, sendFile, sendJson, type ToolRoute } from './http';

export type OptionSpec =
  | { key: string; label: string; type: 'select'; choices: { value: string; label: string }[]; default: string; help?: string }
  | { key: string; label: string; type: 'number'; default: number; min?: number; max?: number; step?: number; help?: string }
  | { key: string; label: string; type: 'text'; default: string; placeholder?: string; help?: string }
  | { key: string; label: string; type: 'boolean'; default: boolean; help?: string };

export interface JobInput {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface JobOutput {
  path: string;
  filename: string;
  mimeType?: string;
}

export interface JobRunCtx {
  jobId: string;
  /** Empty scratch directory owned by this job; write outputs here. */
  workDir: string;
  inputs: JobInput[];
  options: Record<string, any>;
  progress: (pct: number, message?: string) => void;
  signal: AbortSignal;
}

export interface JobRunResult {
  outputs: JobOutput[];
  /** Free-form JSON shown alongside the outputs (stats, metrics, page counts…). */
  meta?: unknown;
}

export interface ConverterSpec {
  /** Stable id used by the frontend, e.g. `doc-to-pdf`. */
  id: string;
  label: string;
  /** Grouping for the generic File Converter UI. */
  group: 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'image' | 'audio' | 'video' | 'data' | 'archive' | 'other';
  /** Accepted extensions, lower-case without dot. Empty = any. */
  inputs: string[];
  /** Output description for the UI, e.g. `pdf` or `zip`. */
  output: string;
  minFiles?: number;
  maxFiles?: number;
  options?: OptionSpec[];
  /** External programs / Python modules this converter needs. */
  requires?: { binaries?: BinaryName[]; pythonModules?: string[] };
  timeoutMs?: number;
  run: (ctx: JobRunCtx) => Promise<JobRunResult>;
}

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

interface Job {
  id: string;
  converter: string;
  status: JobStatus;
  progress: number;
  message?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  inputs: { filename: string; size: number }[];
  options: Record<string, any>;
  outputs: (JobOutput & { size: number })[];
  meta?: unknown;
  dir: string;
  abort: AbortController;
  /** Absent until the job is picked up by a worker slot. */
  inputFiles: JobInput[];
}

const ROOT = join(tmpdir(), 'bridge-tools-jobs');
const CONCURRENCY = Math.max(1, Number(process.env.TOOLS_JOB_CONCURRENCY || 2));
const TTL_MS = Math.max(5, Number(process.env.TOOLS_JOB_TTL_MIN || 60)) * 60_000;
const MAX_JOBS = 200;

const converters = new Map<string, ConverterSpec>();
const jobs = new Map<string, Job>();
const queue: string[] = [];
let running = 0;

export function registerConverters(list: ConverterSpec[]): void {
  for (const c of list) {
    if (converters.has(c.id)) throw new Error(`Duplicate converter id: ${c.id}`);
    converters.set(c.id, c);
  }
}

export function getConverter(id: string): ConverterSpec | undefined {
  return converters.get(id);
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', zip: 'application/zip', json: 'application/json', csv: 'text/csv', txt: 'text/plain',
  html: 'text/html', md: 'text/markdown', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', tiff: 'image/tiff', ico: 'image/x-icon',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', rtf: 'application/rtf', epub: 'application/epub+zip',
};

export function mimeFor(filename: string): string {
  return MIME[extname(filename).slice(1).toLowerCase()] || 'application/octet-stream';
}

/** Strip directory parts and unsafe characters from a client-supplied filename. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).replace(/[^\w.\- ()\[\]]+/g, '_').replace(/^\.+/, '').slice(0, 150);
  return base || 'file';
}

/** `photo.HEIC` → `photo.jpg` */
export function withExt(filename: string, ext: string): string {
  const stem = filename.slice(0, filename.length - extname(filename).length) || 'output';
  return `${stem}.${ext.replace(/^\./, '')}`;
}

const FRIENDLY: Record<string, string> = {
  soffice: 'LibreOffice', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', python: 'Python 3',
  'python:fitz': 'PyMuPDF (pip install pymupdf)', 'python:PIL': 'Pillow (pip install pillow)',
  'python:pillow_heif': 'pillow-heif (pip install pillow-heif)', 'python:numpy': 'numpy (pip install numpy)',
};

export function friendlyRequirement(req: string): string {
  return FRIENDLY[req] ?? (req.startsWith('python:') ? `Python module ${req.slice(7)}` : req);
}

export async function missingRequirements(c: ConverterSpec): Promise<string[]> {
  const missing: string[] = [];
  for (const b of c.requires?.binaries ?? []) if (!(await findBinary(b))) missing.push(b);
  if (c.requires?.pythonModules?.length) {
    if (!(await findBinary('python'))) { if (!missing.includes('python')) missing.push('python'); }
    else for (const m of c.requires.pythonModules) if (!(await hasPythonModule(m))) missing.push(`python:${m}`);
  }
  return missing;
}

function publicJob(j: Job) {
  return {
    id: j.id, converter: j.converter, status: j.status, progress: j.progress, message: j.message, error: j.error,
    createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, inputs: j.inputs, options: j.options,
    outputs: j.outputs.map((o, index) => ({ index, filename: o.filename, size: o.size, mimeType: o.mimeType || mimeFor(o.filename) })),
    meta: j.meta,
    expiresAt: (j.finishedAt ?? j.createdAt) + TTL_MS,
  };
}

function pump(): void {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    running++;
    void execute(job).finally(() => { running--; pump(); });
  }
}

async function execute(job: Job): Promise<void> {
  const conv = converters.get(job.converter)!;
  job.status = 'running';
  job.startedAt = Date.now();
  job.progress = 1;
  const outDir = join(job.dir, 'out');
  await fs.mkdir(outDir, { recursive: true });

  const timeoutMs = conv.timeoutMs ?? 15 * 60_000;
  const timeout = setTimeout(() => job.abort.abort('timeout'), timeoutMs);
  try {
    const result = await conv.run({
      jobId: job.id,
      workDir: outDir,
      inputs: job.inputFiles,
      options: job.options,
      signal: job.abort.signal,
      progress: (pct, message) => {
        job.progress = Math.max(job.progress, Math.min(99, Math.round(pct)));
        if (message) job.message = message;
      },
    });
    if (job.abort.signal.aborted) throw new Error((job.status as JobStatus) === 'cancelled' ? 'Cancelled' : 'Timed out');
    if (!result.outputs.length) throw new Error('Conversion produced no output');
    const outputs = [];
    for (const o of result.outputs) {
      const st = await fs.stat(o.path);
      outputs.push({ ...o, filename: safeName(o.filename), size: st.size });
    }
    job.outputs = outputs;
    job.meta = result.meta;
    job.status = 'done';
    job.progress = 100;
    job.message = undefined;
  } catch (e) {
    // status may have been flipped to 'cancelled' by DELETE while we were awaiting.
    if ((job.status as JobStatus) !== 'cancelled') {
      job.status = 'error';
      // Converters usually surface an abort as "Cancelled"; say what really happened.
      job.error = job.abort.signal.reason === 'timeout'
        ? `Timed out after ${Math.round(timeoutMs / 60_000) || 1} min`
        : (e as Error).message || String(e);
    }
  } finally {
    clearTimeout(timeout);
    job.finishedAt = Date.now();
  }
}

async function removeJob(job: Job): Promise<void> {
  jobs.delete(job.id);
  await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

// Expire finished jobs and their files.
setInterval(() => {
  const now = Date.now();
  for (const j of jobs.values()) {
    if (j.status !== 'running' && j.status !== 'queued' && now - (j.finishedAt ?? j.createdAt) > TTL_MS) void removeJob(j);
  }
}, 60_000).unref();

/** Create and enqueue a job programmatically (used by routes and tests). */
export async function createJob(converterId: string, files: { filename: string; buffer: Buffer; mimeType?: string }[], options: Record<string, any> = {}) {
  const conv = converters.get(converterId);
  if (!conv) throw new HttpError(404, `Unknown converter "${converterId}"`);
  const missing = await missingRequirements(conv);
  if (missing.length) throw new HttpError(503, `This server is missing ${missing.map(friendlyRequirement).join(', ')}`);
  const min = conv.minFiles ?? 1;
  const max = conv.maxFiles ?? 1;
  if (files.length < min) throw new HttpError(400, `${conv.label} needs at least ${min} file(s)`);
  if (files.length > max) throw new HttpError(400, `${conv.label} accepts at most ${max} file(s)`);
  if (conv.inputs.length) {
    for (const f of files) {
      const ext = extname(f.filename).slice(1).toLowerCase();
      if (!conv.inputs.includes(ext)) throw new HttpError(400, `${f.filename}: expected ${conv.inputs.map(e => '.' + e).join(', ')}`);
    }
  }

  // Fill defaults and coerce option types so converters can trust them.
  const opts: Record<string, any> = {};
  for (const spec of conv.options ?? []) {
    const raw = options[spec.key];
    if (raw === undefined || raw === '') { opts[spec.key] = spec.default; continue; }
    if (spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new HttpError(400, `Option "${spec.label}" must be a number`);
      opts[spec.key] = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, n));
    } else if (spec.type === 'boolean') {
      opts[spec.key] = raw === true || raw === 'true' || raw === '1' || raw === 1;
    } else if (spec.type === 'select') {
      if (!spec.choices.some(c => c.value === String(raw))) throw new HttpError(400, `Invalid value for "${spec.label}"`);
      opts[spec.key] = String(raw);
    } else {
      opts[spec.key] = String(raw).slice(0, 10_000);
    }
  }

  if (jobs.size >= MAX_JOBS) {
    const oldest = [...jobs.values()].filter(j => j.status !== 'running' && j.status !== 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) throw new HttpError(429, 'Too many jobs in progress');
    await removeJob(oldest);
  }

  const id = randomUUID();
  const dir = join(ROOT, id);
  const inDir = join(dir, 'in');
  await fs.mkdir(inDir, { recursive: true });
  const inputFiles: JobInput[] = [];
  const used = new Set<string>();
  for (const [i, f] of files.entries()) {
    let name = safeName(f.filename);
    if (used.has(name.toLowerCase())) name = `${i + 1}_${name}`;
    used.add(name.toLowerCase());
    const p = join(inDir, name);
    await fs.writeFile(p, f.buffer);
    inputFiles.push({ path: p, filename: name, mimeType: f.mimeType || mimeFor(name), size: f.buffer.length });
  }

  const job: Job = {
    id, converter: conv.id, status: 'queued', progress: 0, createdAt: Date.now(),
    inputs: inputFiles.map(f => ({ filename: f.filename, size: f.size })), options: opts,
    outputs: [], dir, abort: new AbortController(), inputFiles,
  };
  jobs.set(id, job);
  queue.push(id);
  pump();
  return publicJob(job);
}

export function getJob(id: string) {
  const j = jobs.get(id);
  return j ? publicJob(j) : null;
}

/** Resolve once a job leaves queued/running (for tests and synchronous-style endpoints). */
export async function waitForJob(id: string, timeoutMs = 10 * 60_000) {
  const start = Date.now();
  for (;;) {
    const j = jobs.get(id);
    if (!j) throw new Error('Job disappeared');
    if (j.status !== 'queued' && j.status !== 'running') return publicJob(j);
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for job');
    await new Promise(r => setTimeout(r, 200));
  }
}

function jobOr404(id: string): Job {
  const j = jobs.get(id);
  if (!j) throw new HttpError(404, 'Job not found (it may have expired)');
  return j;
}

export const jobRoutes: ToolRoute[] = [
  {
    method: 'GET', path: '/api/tools/capabilities',
    handler: async ({ res }) => {
      const names: BinaryName[] = ['python', 'soffice', 'ffmpeg', 'ffprobe'];
      const binaries = Object.fromEntries(await Promise.all(names.map(async b => [b, !!(await findBinary(b))] as const)));
      const list = await Promise.all([...converters.values()].map(async c => ({ c, missing: await missingRequirements(c) })));
      sendJson(res, {
        binaries,
        converters: list.map(({ c, missing }) => {
          return {
            id: c.id, label: c.label, group: c.group, inputs: c.inputs, output: c.output,
            minFiles: c.minFiles ?? 1, maxFiles: c.maxFiles ?? 1, options: c.options ?? [],
            available: missing.length === 0, missing, missingLabels: missing.map(friendlyRequirement),
          };
        }),
      });
    },
  },
  {
    method: 'POST', path: '/api/tools/jobs',
    handler: async ({ req, res }) => {
      const { fields, files } = await readMultipart(req);
      let options: Record<string, any> = {};
      if (fields.options) {
        try { options = JSON.parse(fields.options); } catch { throw new HttpError(400, 'options must be JSON'); }
      }
      const job = await createJob(fields.converter || '', files, options);
      sendJson(res, job, 202);
    },
  },
  {
    method: 'GET', path: '/api/tools/jobs',
    handler: ({ res }) => {
      sendJson(res, { jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(publicJob) });
    },
  },
  {
    method: 'GET', path: '/api/tools/jobs/:id',
    handler: ({ res, params }) => sendJson(res, publicJob(jobOr404(params.id))),
  },
  {
    method: 'GET', path: '/api/tools/jobs/:id/files/:index',
    handler: async ({ res, params }) => {
      const j = jobOr404(params.id);
      const o = j.outputs[Number(params.index)];
      if (!o) throw new HttpError(404, 'Output not found');
      sendFile(res, await fs.readFile(o.path), o.mimeType || mimeFor(o.filename), o.filename);
    },
  },
  {
    method: 'GET', path: '/api/tools/jobs/:id/download',
    handler: async ({ res, params }) => {
      const j = jobOr404(params.id);
      if (j.status !== 'done') throw new HttpError(409, `Job is ${j.status}`);
      if (j.outputs.length === 1) {
        const o = j.outputs[0];
        return sendFile(res, await fs.readFile(o.path), o.mimeType || mimeFor(o.filename), o.filename);
      }
      const zip = new JSZip();
      for (const o of j.outputs) zip.file(o.filename, await fs.readFile(o.path));
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      sendFile(res, buf, 'application/zip', `${j.converter}-${j.id.slice(0, 8)}.zip`);
    },
  },
  {
    method: 'DELETE', path: '/api/tools/jobs/:id',
    handler: async ({ res, params }) => {
      const j = jobOr404(params.id);
      if (j.status === 'queued' || j.status === 'running') {
        j.status = 'cancelled';
        j.abort.abort();
        j.finishedAt = Date.now();
      }
      if (existsSync(j.dir)) await removeJob(j); else jobs.delete(j.id);
      sendJson(res, { success: true });
    },
  },
];
