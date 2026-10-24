/**
 * @file tools/docs-office.ts
 * @description LibreOffice-backed document / spreadsheet / presentation conversion (`office-convert`).
 *
 * Every job gets its own LibreOffice profile (`-env:UserInstallation=<jobdir>/lo-profile`) so
 * conversions can run in parallel without fighting over the user's profile lock, and the whole
 * process tree is killed on cancel / timeout (soffice spawns soffice.bin as a child).
 */

import { spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, extname, join } from 'path';
import { pathToFileURL } from 'url';
import { findBinary } from './binaries';
import { withExt, type ConverterSpec, type JobOutput, type JobRunCtx } from './jobs';
import { markdownToHtmlDocument } from './docs-markdown';

export type OfficeFamily = 'document' | 'spreadsheet' | 'presentation' | 'pdf';

/** Input extension → family. Mirrored by dashboard/src/components/devtools/lib/files.ts. */
export const OFFICE_FAMILY: Record<string, OfficeFamily> = {
  doc: 'document', docx: 'document', docm: 'document', dot: 'document', dotx: 'document', odt: 'document', ott: 'document',
  rtf: 'document', txt: 'document', html: 'document', htm: 'document', md: 'document', markdown: 'document',
  wpd: 'document', pages: 'document',
  xls: 'spreadsheet', xlsx: 'spreadsheet', xlsm: 'spreadsheet', xlsb: 'spreadsheet', ods: 'spreadsheet', ots: 'spreadsheet',
  csv: 'spreadsheet', tsv: 'spreadsheet', numbers: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', pps: 'presentation', ppsx: 'presentation', odp: 'presentation', otp: 'presentation',
  key: 'presentation',
  pdf: 'pdf',
};

export const OFFICE_TARGETS: Record<OfficeFamily, string[]> = {
  document: ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'epub', 'png'],
  spreadsheet: ['pdf', 'xlsx', 'xls', 'ods', 'csv', 'html', 'png'],
  presentation: ['pdf', 'pptx', 'ppt', 'odp', 'png'],
  pdf: ['docx', 'odt', 'rtf', 'doc'],
};

const FAMILY_LABEL: Record<OfficeFamily, string> = {
  document: 'documents', spreadsheet: 'spreadsheets', presentation: 'presentations', pdf: 'PDFs',
};

const DELIMS: Record<string, number> = { comma: 44, semicolon: 59, tab: 9, pipe: 124 };

// ---------- process helpers ----------

export interface TreeRunOpts { cwd?: string; timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }

/** Kill a process and all of its children (soffice → soffice.bin, chrome → renderers). */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

/** Like runProcess but runs in its own process group and kills the whole tree on abort / timeout. */
export function runTree(cmd: string, args: string[], opts: TreeRunOpts): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('Cancelled'));
    const child = spawn(cmd, args, {
      cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    let reason = '';
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-32 * 1024); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-32 * 1024); });
    const stop = (why: string) => { if (!reason) { reason = why; killTree(child.pid); } };
    const timer = setTimeout(() => stop(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`), opts.timeoutMs);
    const onAbort = () => stop('Cancelled');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', e => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (reason) return reject(new Error(reason === 'Cancelled' ? 'Cancelled' : `LibreOffice ${reason}`));
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

// ---------- LibreOffice ----------

let versionPromise: Promise<number[]> | null = null;

/** [major, minor] of the installed LibreOffice, or [0, 0] when unknown. */
export function sofficeVersion(): Promise<number[]> {
  if (!versionPromise) {
    versionPromise = (async () => {
      const bin = await findBinary('soffice');
      if (!bin) return [0, 0];
      try {
        const { stdout } = await runTree(bin, ['--version'], { timeoutMs: 60_000 });
        const m = /(\d+)\.(\d+)\.\d+/.exec(stdout);
        return m ? [Number(m[1]), Number(m[2])] : [0, 0];
      } catch {
        return [0, 0];
      }
    })();
  }
  return versionPromise;
}

export async function requireSoffice(): Promise<string> {
  const bin = await findBinary('soffice');
  if (!bin) throw new Error('LibreOffice is not installed on this server (needed for document conversion)');
  return bin;
}

export interface SofficeRun {
  input: string;
  outDir: string;
  /** `--convert-to` value, e.g. `pdf:writer_pdf_Export` */
  convertTo: string;
  infilter?: string;
  profileDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A fresh LibreOffice profile costs ~5 s to initialise on first start. After the first successful
 * conversion we keep a copy of that profile and seed later jobs' private profiles from it.
 */
async function profileTemplate(): Promise<string> {
  const [major, minor] = await sofficeVersion();
  return join(tmpdir(), `bridge-tools-lo-profile-${major}.${minor}`);
}

async function seedProfile(profileDir: string): Promise<void> {
  if (existsSync(profileDir)) return;
  const tpl = await profileTemplate();
  if (!existsSync(join(tpl, 'user'))) return;
  await fs.cp(tpl, profileDir, { recursive: true }).catch(() => fs.rm(profileDir, { recursive: true, force: true }).catch(() => {}));
}

async function saveProfileTemplate(profileDir: string): Promise<void> {
  const tpl = await profileTemplate();
  if (existsSync(tpl) || !existsSync(join(profileDir, 'user'))) return;
  const staging = `${tpl}.${process.pid}.${Date.now()}`;
  try {
    await fs.cp(profileDir, staging, { recursive: true, filter: src => !src.endsWith('.lock') });
    await fs.rename(staging, tpl);
  } catch {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run one headless conversion; returns the files LibreOffice wrote into outDir. */
export async function sofficeConvert(r: SofficeRun): Promise<string[]> {
  const bin = await requireSoffice();
  await fs.mkdir(r.outDir, { recursive: true });
  await seedProfile(r.profileDir);
  const args = [
    `-env:UserInstallation=${pathToFileURL(r.profileDir).href}`,
    '--headless', '--norestore', '--nolockcheck', '--nologo', '--nodefault', '--nofirststartwizard',
  ];
  if (r.infilter) args.push(`--infilter=${r.infilter}`);
  args.push('--convert-to', r.convertTo, '--outdir', r.outDir, r.input);
  const res = await runTree(bin, args, {
    timeoutMs: r.timeoutMs ?? 5 * 60_000, signal: r.signal, cwd: dirname(r.input),
    // LibreOffice wants a writable HOME on Linux even with a custom profile.
    env: process.platform === 'win32' ? {} : { HOME: dirname(r.profileDir) },
  });
  const files = (await fs.readdir(r.outDir)).map(f => join(r.outDir, f));
  if (!files.length) {
    const msg = `${res.stdout}\n${res.stderr}`.split(/\r?\n/).map(s => s.trim()).filter(s => /error|fail/i.test(s)).slice(-2).join(' ');
    throw new Error(`LibreOffice could not convert ${basename(r.input)}${msg ? ` (${msg})` : ' - the file may be damaged, encrypted or in an unsupported format'}`);
  }
  await saveProfileTemplate(r.profileDir);
  return files;
}

function exportFilter(family: OfficeFamily, target: string, o: Record<string, any>, csvSheet: number): string {
  const writerish = family === 'document' || family === 'pdf';
  const app = writerish ? 'writer' : family === 'spreadsheet' ? 'calc' : 'impress';
  switch (target) {
    case 'pdf': {
      const props: Record<string, { type: string; value: string }> = {};
      if (o.pdfA) props.SelectPdfVersion = { type: 'long', value: '2' };
      if (family === 'spreadsheet' && o.onePagePerSheet) props.SinglePageSheets = { type: 'boolean', value: 'true' };
      return `pdf:${app}_pdf_Export` + (Object.keys(props).length ? ':' + JSON.stringify(props) : '');
    }
    case 'docx': return 'docx:MS Word 2007 XML';
    case 'doc': return 'doc:MS Word 97';
    case 'odt': return 'odt:writer8';
    case 'rtf': return 'rtf:Rich Text Format';
    case 'txt': return 'txt:Text (encoded):UTF8';
    case 'epub': return 'epub:EPUB';
    case 'html': return family === 'spreadsheet' ? 'html:HTML (StarCalc)' : 'html:HTML (StarWriter):EmbedImages';
    case 'xlsx': return 'xlsx:Calc MS Excel 2007 XML';
    case 'xls': return 'xls:MS Excel 97';
    case 'ods': return 'ods:calc8';
    case 'csv': return `csv:Text - txt - csv (StarCalc):${DELIMS[o.delimiter] ?? 44},34,UTF8,1,,0,false,true,false,false,false,${csvSheet}`;
    case 'pptx': return 'pptx:Impress MS PowerPoint 2007 XML';
    case 'ppt': return 'ppt:MS PowerPoint 97';
    case 'odp': return 'odp:impress8';
    case 'png': return `png:${app}_png_Export`;
    default: throw new Error(`Unsupported target ${target}`);
  }
}

/** Guess the delimiter of a CSV from its first few lines. */
async function sniffDelimiter(path: string, ext: string): Promise<number> {
  if (ext === 'tsv') return 9;
  const head = (await fs.readFile(path)).subarray(0, 64 * 1024).toString('utf-8').split(/\r?\n/).slice(0, 10).join('\n');
  const counts = Object.entries(DELIMS).map(([, code]) => [code, head.split(String.fromCharCode(code)).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : 44;
}

async function inputFilter(family: OfficeFamily, ext: string, path: string, o: Record<string, any>): Promise<string | undefined> {
  if (family === 'pdf') return 'writer_pdf_import';
  if (ext === 'csv' || ext === 'tsv') {
    const d = o.inputDelimiter && o.inputDelimiter !== 'auto' ? DELIMS[o.inputDelimiter] : await sniffDelimiter(path, ext);
    return `Text - txt - csv (StarCalc):${d},34,UTF8,1,,0,false,true`;
  }
  if (ext === 'txt') return 'Text (encoded):UTF8';
  // Force the Writer HTML importer: Writer/Web (the default for .html) can't export to docx/odt.
  if (ext === 'html' || ext === 'htm' || ext === 'md' || ext === 'markdown') return 'HTML (StarWriter)';
  return undefined;
}

function sanitizeSheet(s: string): string {
  return s.replace(/[^\w.\- ]+/g, '_');
}

export const officeConvert: ConverterSpec = {
  id: 'office-convert',
  label: 'Convert with LibreOffice',
  group: 'document',
  inputs: Object.keys(OFFICE_FAMILY),
  output: 'pdf / docx / odt / xlsx / csv / pptx …',
  minFiles: 1,
  maxFiles: 20,
  requires: { binaries: ['soffice'] },
  timeoutMs: 30 * 60_000,
  options: [
    {
      key: 'target', label: 'Convert to', type: 'select', default: 'pdf',
      choices: ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'epub', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp', 'png']
        .map(v => ({ value: v, label: v.toUpperCase() })),
    },
    { key: 'sheet', label: 'Sheets (CSV)', type: 'text', default: '', placeholder: 'all, 2 or Sheet name', help: 'Blank = every sheet as its own CSV.' },
    {
      key: 'delimiter', label: 'CSV delimiter', type: 'select', default: 'comma',
      choices: [{ value: 'comma', label: 'Comma ,' }, { value: 'semicolon', label: 'Semicolon ;' }, { value: 'tab', label: 'Tab' }, { value: 'pipe', label: 'Pipe |' }],
    },
    {
      key: 'inputDelimiter', label: 'Input CSV delimiter', type: 'select', default: 'auto',
      choices: [{ value: 'auto', label: 'Auto-detect' }, { value: 'comma', label: 'Comma ,' }, { value: 'semicolon', label: 'Semicolon ;' }, { value: 'tab', label: 'Tab' }, { value: 'pipe', label: 'Pipe |' }],
    },
    { key: 'csvBom', label: 'UTF-8 BOM in CSV (for Excel)', type: 'boolean', default: false },
    { key: 'onePagePerSheet', label: 'One PDF page per sheet', type: 'boolean', default: false, help: 'Spreadsheets → PDF: fit each whole sheet on a single page.' },
    { key: 'pdfA', label: 'PDF/A-2b (archival)', type: 'boolean', default: false },
  ],
  run: async (ctx: JobRunCtx) => {
    const o = ctx.options;
    const target = String(o.target);
    const jobDir = dirname(ctx.workDir);
    const profileDir = join(jobDir, 'lo-profile');
    const [major, minor] = await sofficeVersion();
    const multiSheetCsv = major > 7 || (major === 7 && minor >= 2) || major === 0;

    // Validate every file before starting so a bad pair fails fast.
    for (const f of ctx.inputs) {
      const ext = extname(f.filename).slice(1).toLowerCase();
      const fam = OFFICE_FAMILY[ext];
      if (!fam) throw new Error(`${f.filename}: unsupported input type .${ext}`);
      if (!OFFICE_TARGETS[fam].includes(target)) {
        throw new Error(`${f.filename}: ${FAMILY_LABEL[fam]} can't be converted to ${target.toUpperCase()} - choose one of ${OFFICE_TARGETS[fam].map(t => t.toUpperCase()).join(', ')}`);
      }
    }

    // CSV sheet selection: blank/all → every sheet; a number → that sheet; a name → filter after export.
    const sheetOpt = String(o.sheet || '').trim();
    let csvSheet = multiSheetCsv ? -1 : 1;
    let sheetName = '';
    if (sheetOpt && sheetOpt.toLowerCase() !== 'all') {
      if (/^\d+$/.test(sheetOpt)) csvSheet = Math.max(1, Number(sheetOpt));
      else sheetName = sheetOpt;
    }

    const outputs: JobOutput[] = [];
    const files: { input: string; outputs: string[]; ms: number }[] = [];
    const n = ctx.inputs.length;
    for (const [i, f] of ctx.inputs.entries()) {
      if (ctx.signal.aborted) throw new Error('Cancelled');
      const t0 = Date.now();
      ctx.progress(3 + (90 * i) / n, `Converting ${f.filename} (${i + 1}/${n})${i === 0 ? ' - starting LibreOffice' : ''}`);
      const ext = extname(f.filename).slice(1).toLowerCase();
      const fam = OFFICE_FAMILY[ext];
      let input = f.path;
      if (ext === 'md' || ext === 'markdown') {
        // LibreOffice has no reliable Markdown importer: render to HTML first.
        input = join(jobDir, `md-${i}`, withExt(f.filename, 'html'));
        await fs.mkdir(dirname(input), { recursive: true });
        await fs.writeFile(input, markdownToHtmlDocument(await fs.readFile(f.path, 'utf-8'), basename(f.filename)));
      }
      const outDir = join(jobDir, 'lo-out', String(i));
      const written = await sofficeConvert({
        input, outDir, profileDir, signal: ctx.signal,
        convertTo: exportFilter(fam, target, o, csvSheet),
        infilter: await inputFilter(fam, ext, f.path, o),
        timeoutMs: 6 * 60_000,
      });

      let produced = written.filter(p => extname(p).slice(1).toLowerCase() === target);
      if (!produced.length) throw new Error(`LibreOffice did not produce a ${target.toUpperCase()} for ${f.filename}`);
      if (target === 'csv' && sheetName) {
        const want = sanitizeSheet(sheetName).toLowerCase();
        const match = produced.filter(p => basename(p, '.csv').toLowerCase().endsWith('-' + want));
        if (!match.length) {
          const stem = basename(input, extname(input));
          const names = produced.map(p => basename(p, '.csv').slice(stem.length + 1)).filter(Boolean);
          throw new Error(`${f.filename}: no sheet named "${sheetName}"${names.length ? ` (sheets: ${names.join(', ')})` : ''}`);
        }
        produced = match;
      }
      produced.sort();
      const names: string[] = [];
      for (const p of produced) {
        // Keep the user's original stem (LibreOffice uses the sanitized upload name).
        const loStem = basename(input, extname(input));
        const suffix = basename(p, extname(p)).slice(loStem.length); // e.g. "-Sheet1" for multi-sheet CSV
        let name = withExt(f.filename, target);
        if (suffix) name = name.replace(/\.[^.]+$/, `${suffix}.${target}`);
        if (outputs.some(x => x.filename.toLowerCase() === name.toLowerCase())) name = `${i + 1}_${name}`;
        const dest = join(ctx.workDir, name);
        if (target === 'csv' && o.csvBom) {
          const buf = await fs.readFile(p);
          await fs.writeFile(dest, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]));
        } else {
          await fs.rename(p, dest).catch(async () => { await fs.copyFile(p, dest); });
        }
        outputs.push({ path: dest, filename: name });
        names.push(name);
      }
      files.push({ input: f.filename, outputs: names, ms: Date.now() - t0 });
    }
    return { outputs, meta: { target, files, libreOffice: major ? `${major}.${minor}` : undefined } };
  },
};
