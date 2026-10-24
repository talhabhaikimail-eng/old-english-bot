/**
 * @file tools/docs-pdf.ts
 * @description PDF tools and image metadata stripping, implemented by src/scripts/tools/doc_tools.py
 * (PyMuPDF + Pillow): pdf-merge, pdf-split, pdf-compress, pdf-to-image, pdf-text, images-to-pdf,
 * exif-strip, plus the quick POST /api/tools/files/pdf-info endpoint.
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { HttpError, readMultipart, sendJson, type ToolRoute } from './http';
import { safeName, type ConverterSpec, type JobRunCtx, type JobRunResult } from './jobs';
import { runPythonScript } from './binaries';

const SCRIPT = 'doc_tools.py';

/** Run a doc_tools.py command for a job; outputs are written straight into ctx.workDir. */
async function runDocTool(command: string, ctx: JobRunCtx, extraOptions: Record<string, unknown> = {}, timeoutMs = 20 * 60_000): Promise<JobRunResult> {
  const cfgPath = join(dirname(ctx.workDir), `doc-tools-${command}.json`);
  await fs.writeFile(cfgPath, JSON.stringify({
    inputs: ctx.inputs.map(i => ({ path: i.path, filename: i.filename })),
    outdir: ctx.workDir,
    options: { ...ctx.options, ...extraOptions },
  }));
  const res = await runPythonScript(SCRIPT, [command, cfgPath], {
    signal: ctx.signal, timeoutMs, onProgress: (p, m) => ctx.progress(p, m),
  });
  return { outputs: (res.outputs ?? []).map((o: any) => ({ path: o.path, filename: o.filename })), meta: res.meta };
}

const password = { key: 'password', label: 'Password (if encrypted)', type: 'text' as const, default: '', placeholder: 'Only for protected PDFs' };

export const pdfConverters: ConverterSpec[] = [
  {
    id: 'pdf-merge',
    label: 'Merge PDFs',
    group: 'pdf',
    inputs: ['pdf'],
    output: 'pdf',
    minFiles: 2,
    maxFiles: 50,
    requires: { pythonModules: ['fitz'] },
    timeoutMs: 15 * 60_000,
    options: [
      { key: 'bookmarks', label: 'Add a bookmark per file', type: 'boolean', default: true },
      { key: 'outputName', label: 'Output name', type: 'text', default: 'merged', placeholder: 'merged' },
      password,
    ],
    run: ctx => runDocTool('merge', ctx),
  },
  {
    id: 'pdf-split',
    label: 'Split PDF',
    group: 'pdf',
    inputs: ['pdf'],
    output: 'pdf (zip)',
    maxFiles: 1,
    requires: { pythonModules: ['fitz'] },
    timeoutMs: 15 * 60_000,
    options: [
      {
        key: 'mode', label: 'Split', type: 'select', default: 'ranges',
        choices: [{ value: 'ranges', label: 'By page ranges' }, { value: 'every', label: 'Every N pages' }, { value: 'each', label: 'Every page' }],
      },
      { key: 'ranges', label: 'Ranges', type: 'text', default: '', placeholder: '1-3, 5, 8-', help: 'Each range becomes its own PDF.' },
      { key: 'every', label: 'Pages per file', type: 'number', default: 1, min: 1, max: 10000 },
      { key: 'single', label: 'Extract selected ranges into one PDF', type: 'boolean', default: false },
      password,
    ],
    run: ctx => runDocTool('split', ctx),
  },
  {
    id: 'pdf-compress',
    label: 'Compress PDF',
    group: 'pdf',
    inputs: ['pdf'],
    output: 'pdf',
    maxFiles: 20,
    requires: { pythonModules: ['fitz', 'PIL'] },
    timeoutMs: 30 * 60_000,
    options: [
      {
        key: 'preset', label: 'Preset', type: 'select', default: 'ebook',
        choices: [
          { value: 'screen', label: 'Screen - 72 dpi, smallest' },
          { value: 'ebook', label: 'eBook - 150 dpi, balanced' },
          { value: 'printer', label: 'Printer - 300 dpi, high quality' },
          { value: 'lossless', label: 'Lossless - structure only' },
        ],
      },
      { key: 'quality', label: 'JPEG quality override', type: 'number', default: 0, min: 0, max: 95, help: '0 = preset default (45 / 65 / 85).' },
      { key: 'stripMetadata', label: 'Remove metadata & thumbnails', type: 'boolean', default: true },
      password,
    ],
    run: ctx => runDocTool('compress', ctx),
  },
  {
    id: 'pdf-to-image',
    label: 'PDF to images',
    group: 'pdf',
    inputs: ['pdf'],
    output: 'png / jpg / webp',
    maxFiles: 10,
    requires: { pythonModules: ['fitz', 'PIL'] },
    timeoutMs: 30 * 60_000,
    options: [
      { key: 'format', label: 'Format', type: 'select', default: 'png', choices: [{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WebP' }] },
      { key: 'dpi', label: 'Resolution (DPI)', type: 'number', default: 150, min: 36, max: 600, step: 1 },
      { key: 'pages', label: 'Pages', type: 'text', default: '', placeholder: 'all, or 1-3,5', help: 'Blank = every page.' },
      { key: 'quality', label: 'Quality (JPG/WebP)', type: 'number', default: 90, min: 1, max: 100 },
      { key: 'transparent', label: 'Transparent background (PNG)', type: 'boolean', default: false },
      password,
    ],
    run: ctx => runDocTool('to-image', ctx),
  },
  {
    id: 'pdf-text',
    label: 'Extract text',
    group: 'pdf',
    inputs: ['pdf'],
    output: 'txt',
    maxFiles: 20,
    requires: { pythonModules: ['fitz'] },
    timeoutMs: 15 * 60_000,
    options: [
      { key: 'mode', label: 'Mode', type: 'select', default: 'plain', choices: [{ value: 'plain', label: 'Plain (reading order)' }, { value: 'layout', label: 'Layout (keep columns / spacing)' }] },
      { key: 'separators', label: 'Page separators', type: 'boolean', default: true },
      { key: 'pages', label: 'Pages', type: 'text', default: '', placeholder: 'all, or 1-3,5' },
      password,
    ],
    run: ctx => runDocTool('text', ctx),
  },
  {
    id: 'images-to-pdf',
    label: 'Images to PDF',
    group: 'pdf',
    inputs: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp', 'tif', 'tiff'],
    output: 'pdf',
    maxFiles: 200,
    requires: { pythonModules: ['fitz', 'PIL'] },
    timeoutMs: 20 * 60_000,
    options: [
      {
        key: 'pageSize', label: 'Page size', type: 'select', default: 'a4',
        choices: [{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }, { value: 'legal', label: 'Legal' }, { value: 'a3', label: 'A3' }, { value: 'a5', label: 'A5' }, { value: 'fit', label: 'Fit to image' }],
      },
      {
        key: 'orientation', label: 'Orientation', type: 'select', default: 'auto',
        choices: [{ value: 'auto', label: 'Auto (per image)' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }],
      },
      { key: 'margin', label: 'Margin (mm)', type: 'number', default: 10, min: 0, max: 50 },
      {
        key: 'fit', label: 'Image placement', type: 'select', default: 'fit',
        choices: [{ value: 'fit', label: 'Fit (whole image)' }, { value: 'fill', label: 'Fill (crop to page)' }, { value: 'stretch', label: 'Stretch' }],
      },
      { key: 'quality', label: 'JPEG quality (re-encoded images)', type: 'number', default: 90, min: 30, max: 100 },
      { key: 'outputName', label: 'Output name', type: 'text', default: '', placeholder: 'images' },
    ],
    run: ctx => runDocTool('images-to-pdf', ctx),
  },
  {
    id: 'exif-strip',
    label: 'Strip metadata',
    group: 'image',
    inputs: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tif', 'tiff'],
    output: 'same format',
    maxFiles: 50,
    requires: { pythonModules: ['PIL'] },
    timeoutMs: 10 * 60_000,
    options: [
      { key: 'keepIcc', label: 'Keep colour profile (ICC)', type: 'boolean', default: true, help: 'Recommended - removing it can shift colours.' },
      {
        key: 'jpegMode', label: 'JPEG orientation', type: 'select', default: 'lossless',
        choices: [
          { value: 'lossless', label: 'Lossless - keep only the rotation flag' },
          { value: 'reencode', label: 'Rotate pixels (re-encode at q95)' },
        ],
      },
    ],
    run: ctx => runDocTool('exif-strip', ctx),
  },
];

export const pdfRoutes: ToolRoute[] = [
  {
    // Quick facts about one PDF (page count, encryption, metadata) for the UI.
    method: 'POST', path: '/api/tools/files/pdf-info',
    handler: async ({ req, res }) => {
      const { fields, files } = await readMultipart(req, 200 * 1024 * 1024);
      const f = files[0];
      if (!f) throw new HttpError(400, 'Upload a PDF as "file"');
      const dir = await fs.mkdtemp(join(tmpdir(), 'pdf-info-'));
      try {
        const path = join(dir, safeName(f.filename));
        await fs.writeFile(path, f.buffer);
        const cfg = join(dir, 'cfg.json');
        await fs.writeFile(cfg, JSON.stringify({ inputs: [{ path, filename: f.filename }], outdir: dir, options: { password: fields.password || '' } }));
        let result: any;
        try {
          result = await runPythonScript(SCRIPT, ['info', cfg], { timeoutMs: 60_000 });
        } catch (e) {
          throw new HttpError(422, (e as Error).message);
        }
        sendJson(res, { filename: f.filename, ...result.meta });
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  },
];
