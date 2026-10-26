/**
 * @file extractor.ts
 * @description On-demand AI web extractor (NuExtract-1.5-tiny). Nothing is installed or downloaded
 * until someone clicks "Download & set up" in the dashboard; then, on whatever machine runs the
 * bridge (the GitHub Actions runner in production):
 *
 *   1. create a private venv under EXTRACT_HOME (default ~/.cache/datanodes-extractor)
 *   2. pip install CPU-only torch + src/scripts/extract/requirements.txt
 *   3. start src/scripts/extract/extract_server.py on 127.0.0.1:EXTRACT_PORT (8002)
 *   4. ask it to download numind/NuExtract-1.5-tiny from Hugging Face and load it
 *
 *  GET    /api/extract/status    setup phase + log, and the Python server's model status
 *  POST   /api/extract/setup     run steps 1–4 (idempotent; resumes where it left off)
 *  POST   /api/extract/run       {url | html, template, useModel, maxInputTokens, maxNewTokens}
 *  POST   /api/extract/stop      stop the Python server (frees ~2 GB RAM)
 *  DELETE /api/extract/model     delete the downloaded model files
 */

import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { findBinary, killTree, runProcess } from './tools/binaries';
import { HttpError, readJson, sendError, sendJson } from './tools/http';
import { errMsg, fetchPage, normalizeInputUrl } from './tools/seo-fetch';

const HOME = process.env.EXTRACT_HOME || join(homedir(), '.cache', 'datanodes-extractor');
const PORT = Number(process.env.EXTRACT_PORT || 8002);
const API = `http://127.0.0.1:${PORT}`;
const SCRIPT_DIR = [
  resolve(__dirname, '../scripts/extract'),
  resolve(__dirname, '../../src/scripts/extract'),
  join(process.cwd(), 'src/scripts/extract'),
].find(p => existsSync(join(p, 'extract_server.py'))) ?? join(process.cwd(), 'src/scripts/extract');
const VENV = join(HOME, 'venv');
const VENV_PY = process.platform === 'win32' ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python');
const TORCH_INDEX = 'https://download.pytorch.org/whl/cpu';

type Phase = 'idle' | 'installing' | 'starting' | 'running' | 'error';

const state = {
  phase: 'idle' as Phase,
  step: '',
  error: '',
  log: [] as string[],
  startedAt: 0,
};
let server: ChildProcess | null = null;
let setupPromise: Promise<void> | null = null;

function log(line: string) {
  const l = line.replace(/\s+$/, '');
  if (!l) return;
  state.log.push(`${new Date().toISOString().slice(11, 19)}  ${l}`);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

async function py<T = any>(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(API + path, { ...init, signal: ctl.signal });
    const body = await r.json().catch(() => ({})) as any;
    if (!r.ok) throw new HttpError(r.status, typeof body.detail === 'string' ? body.detail : `extract server HTTP ${r.status}`);
    return body as T;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as Error).name === 'AbortError') throw new HttpError(504, 'extract server timed out');
    throw new HttpError(503, 'extract server is not running');
  } finally {
    clearTimeout(t);
  }
}

async function serverUp(): Promise<boolean> {
  try { await py('/health', undefined, 2000); return true; } catch { return false; }
}

function requirementsHash(): string {
  return createHash('sha1').update(readFileSync(join(SCRIPT_DIR, 'requirements.txt'))).digest('hex').slice(0, 12);
}

async function install() {
  mkdirSync(HOME, { recursive: true });
  const marker = join(HOME, '.installed');
  const hash = requirementsHash();
  if (existsSync(VENV_PY) && existsSync(marker) && readFileSync(marker, 'utf-8').trim() === hash) {
    log('Python environment already installed');
    return;
  }
  const python = await findBinary('python');
  if (!python) throw new Error('python3 is not installed on the server');
  const pipLine = (l: string) => { if (/^(Collecting|Downloading|Installing|Successfully|ERROR|WARNING: Retrying)/.test(l.trim())) log(l.trim()); };
  const opts = { timeoutMs: 20 * 60_000, onStdoutLine: pipLine, onStderrLine: pipLine };

  state.step = 'Creating Python virtual environment';
  log(state.step);
  if (!existsSync(VENV_PY)) await runProcess(python, ['-m', 'venv', VENV], { timeoutMs: 120_000 });
  await runProcess(VENV_PY, ['-m', 'pip', 'install', '--upgrade', '--progress-bar', 'off', 'pip'], opts);

  state.step = 'Installing PyTorch (CPU build, ~200 MB)';
  log(state.step);
  await runProcess(VENV_PY, ['-m', 'pip', 'install', '--progress-bar', 'off', 'torch', '--index-url', TORCH_INDEX], opts);

  state.step = 'Installing transformers, trafilatura, extruct';
  log(state.step);
  await runProcess(VENV_PY, ['-m', 'pip', 'install', '--progress-bar', 'off', '-r', join(SCRIPT_DIR, 'requirements.txt')], opts);
  writeFileSync(marker, hash);
  log('Python environment ready');
}

async function startServer() {
  if (await serverUp()) return;
  state.step = 'Starting extraction server';
  log(state.step);
  const child = spawn(VENV_PY, [join(SCRIPT_DIR, 'extract_server.py')], {
    env: { ...process.env, EXTRACT_HOME: HOME, EXTRACT_PORT: String(PORT), PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  server = child;
  const onData = (b: Buffer) => b.toString().split('\n').forEach(l => /INFO|ERROR|Traceback|Error/.test(l) && log(l.replace(/^\S+ \S+ /, '')));
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', code => {
    if (server === child) server = null;
    log(`extraction server exited (code ${code})`);
    if (state.phase === 'running') { state.phase = 'error'; state.error = `extraction server exited (code ${code})`; }
  });
  for (let i = 0; i < 60; i++) {
    if (await serverUp()) return;
    if (child.exitCode !== null) throw new Error('extraction server failed to start — see log');
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('extraction server did not become ready in 60s');
}

function setup(): Promise<void> {
  if (setupPromise) return setupPromise;
  state.phase = 'installing';
  state.error = '';
  state.startedAt = Date.now();
  setupPromise = (async () => {
    try {
      await install();
      state.phase = 'starting';
      await startServer();
      state.phase = 'running';
      state.step = 'Downloading and loading NuExtract-1.5-tiny';
      log(state.step);
      await py('/model/download', { method: 'POST' });
    } catch (e) {
      state.phase = 'error';
      state.error = errMsg(e);
      log(`setup failed: ${state.error}`);
    } finally {
      setupPromise = null;
    }
  })();
  return setupPromise;
}

async function status() {
  let model: any = null;
  if (await serverUp()) {
    model = await py('/status').catch(() => null);
    if (state.phase === 'idle' || state.phase === 'error') state.phase = 'running';
  } else if (state.phase === 'running') {
    state.phase = 'idle';
  }
  return {
    phase: state.phase, step: state.step, error: state.error, log: state.log.slice(-80),
    installed: existsSync(VENV_PY) && existsSync(join(HOME, '.installed')),
    model, home: HOME,
  };
}

const MAX_HTML = 8 * 1024 * 1024;

async function run(body: Record<string, any>) {
  let html = typeof body.html === 'string' ? body.html : '';
  let url: string | undefined;
  let fetched: any;
  if (!html) {
    const target = normalizeInputUrl(body.url);
    const page = await fetchPage(target, { maxBytes: MAX_HTML, timeoutMs: 25_000 }).catch(e => { throw new HttpError(502, errMsg(e)); });
    if (page.status >= 400) throw new HttpError(502, `${page.finalUrl} returned HTTP ${page.status}`);
    if (!/html|xml/i.test(page.contentType) && page.contentType) throw new HttpError(400, `Not an HTML page (${page.contentType})`);
    html = page.text;
    url = page.finalUrl;
    fetched = { url: page.finalUrl, status: page.status, ms: Math.round(page.totalMsAll), bytes: page.body.length };
  } else if (html.length > MAX_HTML) {
    throw new HttpError(413, 'HTML is larger than 8 MB');
  } else if (typeof body.url === 'string' && body.url) {
    url = body.url;
  }
  const out = await py('/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html, url,
      template: body.template,
      use_model: body.useModel !== false,
      max_input_tokens: Number(body.maxInputTokens) || 6000,
      max_new_tokens: Number(body.maxNewTokens) || 1024,
    }),
  }, 10 * 60_000);
  return { ...out, fetched };
}

export async function handleExtractorRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url || '').split('?')[0];
  if (!path.startsWith('/api/extract/')) return false;
  const method = req.method || 'GET';
  try {
    if (method === 'GET' && path === '/api/extract/status') return sendJson(res, await status()), true;
    if (method === 'POST' && path === '/api/extract/setup') {
      void setup();
      return sendJson(res, await status()), true;
    }
    if (method === 'POST' && path === '/api/extract/run') return sendJson(res, await run(await readJson(req, MAX_HTML * 2))), true;
    if (method === 'POST' && path === '/api/extract/stop') {
      if (server) killTree(server);
      server = null;
      state.phase = 'idle';
      log('extraction server stopped');
      return sendJson(res, { ok: true }), true;
    }
    if (method === 'DELETE' && path === '/api/extract/model') return sendJson(res, await py('/model', { method: 'DELETE' })), true;
    sendError(res, 'Unknown extract endpoint', 404);
  } catch (e) {
    sendError(res, errMsg(e), e instanceof HttpError ? e.status : 500);
  }
  return true;
}
