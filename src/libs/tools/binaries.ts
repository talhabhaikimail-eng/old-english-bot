/**
 * @file tools/binaries.ts
 * @description Locates the external programs the tools backend shells out to
 * (Python, LibreOffice, ffmpeg) and runs them with timeouts and cancellation.
 *
 * Overrides: TOOLS_PYTHON, TOOLS_SOFFICE, TOOLS_FFMPEG, TOOLS_FFPROBE.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

export type BinaryName = 'python' | 'soffice' | 'ffmpeg' | 'ffprobe';

const CANDIDATES: Record<BinaryName, string[]> = {
  python: process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'],
  soffice: process.platform === 'win32'
    // soffice.com is the console build: it returns immediately and prints to stdout.
    ? ['C:\\Program Files\\LibreOffice\\program\\soffice.com', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com', 'soffice']
    : ['soffice', 'libreoffice', '/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'],
  ffmpeg: ['ffmpeg'],
  ffprobe: ['ffprobe'],
};

const ENV: Record<BinaryName, string> = {
  python: 'TOOLS_PYTHON', soffice: 'TOOLS_SOFFICE', ffmpeg: 'TOOLS_FFMPEG', ffprobe: 'TOOLS_FFPROBE',
};

const VERSION_ARGS: Record<BinaryName, string[]> = {
  python: ['--version'], soffice: ['--version'], ffmpeg: ['-version'], ffprobe: ['-version'],
};

const cache = new Map<BinaryName, Promise<string | null>>();
const resolved = new Map<BinaryName, string | null>();

/**
 * Kill a child and everything it spawned. soffice/ffmpeg wrappers fork helpers (soffice.bin…)
 * that a plain kill would orphan. On POSIX the child must be spawned with `detached: true` so it
 * leads its own process group.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'));
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

const DETACHED = process.platform !== 'win32';

function works(cmd: string, args: string[]): Promise<boolean> {
  if ((cmd.includes('/') || cmd.includes('\\')) &&!existsSync(cmd)) return Promise.resolve(false);
  return new Promise(resolvePromise => {
    try {
      const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore', detached: DETACHED });
      const timer = setTimeout(() => { killTree(child); resolvePromise(false); }, 20_000);
      child.on('error', () => { clearTimeout(timer); resolvePromise(false); });
      child.on('close', code => { clearTimeout(timer); resolvePromise(code === 0); });
    } catch {
      resolvePromise(false);
    }
  });
}

/** Absolute command for a binary, or null when it isn't installed. Cached per process. */
export function findBinary(name: BinaryName): Promise<string | null> {
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const override = process.env[ENV[name]];
      for (const c of override ? [override] : CANDIDATES[name]) {
        if (await works(c, VERSION_ARGS[name])) return c;
      }
      return null;
    })().then(found => { resolved.set(name, found); return found; });
    cache.set(name, p);
  }
  return p;
}

export async function requireBinary(name: BinaryName): Promise<string> {
  const bin = await findBinary(name);
  if (!bin) throw new Error(`${name} is not installed on the server`);
  return bin;
}

const pyModuleCache = new Map<string, Promise<boolean>>();

/** True when `import <mod>` succeeds in the server's Python. */
export function hasPythonModule(mod: string): Promise<boolean> {
  let p = pyModuleCache.get(mod);
  if (!p) {
    p = findBinary('python').then(py => (py ? works(py, ['-c', `import ${mod}`]) : false));
    pyModuleCache.set(mod, p);
  }
  return p;
}

// Probe in the background at startup so the first request doesn't pay for it.
for (const b of Object.keys(CANDIDATES) as BinaryName[]) void findBinary(b);

/** Directory holding the Python helpers (src/scripts/tools) in both dev (ts) and built (dist) layouts. */
export const SCRIPTS_DIR = [
  resolve(__dirname, '../../scripts/tools'),
  resolve(__dirname, '../../../src/scripts/tools'),
  join(process.cwd(), 'src/scripts/tools'),
].find(p => existsSync(p)) ?? join(process.cwd(), 'src/scripts/tools');

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string | Buffer;
  env?: Record<string, string>;
  /** Called with each stderr line (useful for ffmpeg progress). */
  onStderrLine?: (line: string) => void;
  /** Called with each stdout line (Python helpers emit JSON progress lines). */
  onStdoutLine?: (line: string) => void;
}

/**
 * Run a program without a shell (arguments are never interpolated into a command line).
 * Rejects on non-zero exit with the tail of stderr as the message.
 */
export function runProcess(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      detached: DETACHED,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    let outBuf = '';
    let errBuf = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) { killTree(child); reject(new Error(`${cmd} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`)); }
    }, opts.timeoutMs ?? 10 * 60_000);

    const onAbort = () => { killTree(child); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf-8');
      if (stdout.length < 50 * 1024 * 1024) stdout += s;
      if (opts.onStdoutLine) {
        outBuf += s;
        const lines = outBuf.split(/\r?\n/);
        outBuf = lines.pop() ?? '';
        lines.forEach(l => l && opts.onStdoutLine!(l));
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf-8');
      stderr = (stderr + s).slice(-64 * 1024);
      if (opts.onStderrLine) {
        errBuf += s;
        const lines = errBuf.split(/\r|\n/);
        errBuf = lines.pop() ?? '';
        lines.forEach(l => l && opts.onStderrLine!(l));
      }
    });
    child.on('error', e => {
      finished = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error('Cancelled'));
      if (code !== 0) {
        const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
        return reject(new Error(tail || `${cmd} exited with code ${code}`));
      }
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Run a helper in src/scripts/tools with Python. The helper should print a single JSON
 * object as its last stdout line; lines of the form {"progress": n, "message": "..."} are
 * forwarded to `onProgress`.
 */
export async function runPythonScript(
  script: string,
  args: string[],
  opts: RunOptions & { onProgress?: (pct: number, message?: string) => void } = {},
): Promise<any> {
  const py = await requireBinary('python');
  let last = '';
  await runProcess(py, [join(SCRIPTS_DIR, script), ...args], {
    ...opts,
    onStdoutLine: line => {
      if (line.startsWith('{') && line.includes('"progress"')) {
        try {
          const p = JSON.parse(line);
          if (typeof p.progress === 'number' && Object.keys(p).every(k => k === 'progress' || k === 'message')) {
            opts.onProgress?.(p.progress, p.message);
            return;
          }
        } catch { /* not a progress line */ }
      }
      last = line;
      opts.onStdoutLine?.(line);
    },
  });
  try {
    return last ? JSON.parse(last) : {};
  } catch {
    throw new Error(`Unexpected output from ${script}: ${last.slice(0, 300)}`);
  }
}
