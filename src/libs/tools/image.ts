/**
 * @file tools/image.ts
 * @description Image tools for the Dev Tools panel.
 *
 * Heavy lifting runs in src/scripts/tools/image_tools.py (Pillow + pillow-heif + numpy, a port of
 * the image-compress benchmarking engine): compression presets with PSNR/SSIM, multi-core batch
 * compression, the ~33-profile benchmark, and convert/resize/crop/rotate/watermark. SVG work and
 * favicons use sharp (libvips + librsvg), palette extraction and SVGO run in-process.
 *
 *  GET  /api/tools/image/caps      → encoder/decoder support (AVIF/HEIC…), CPU count, versions
 *  POST /api/tools/image/svgo      → JSON { svg, multipass, precision, … } → { svg, before, after, … }
 *  POST /api/tools/image/palette   → multipart file (+ count, method) → dominant colours
 *
 * Converters: image-compress, image-batch, image-benchmark, image-convert, image-resize,
 * image-crop, image-rotate, image-watermark, favicon, svg-raster.
 */

import { promises as fs } from 'fs';
import { cpus } from 'os';
import { extname, join } from 'path';
import { gzipSync } from 'zlib';
import sharp from 'sharp';
import { optimize, type PluginConfig } from 'svgo';
import { findBinary, hasPythonModule, runPythonScript } from './binaries';
import { HttpError, readJson, readMultipart, sendJson, str, type ToolRoute } from './http';
import { mimeFor, safeName, withExt, type ConverterSpec, type JobOutput, type JobRunCtx, type OptionSpec } from './jobs';

// ---------------------------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------------------------

const RASTER_IN = ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'avif', 'heic', 'heif', 'gif', 'bmp', 'tif', 'tiff', 'ico'];
const PY = { pythonModules: ['PIL', 'numpy'] };

const choices = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

const FORMAT_KEEP = choices(['keep', 'Same as input'], ['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP'], ['avif', 'AVIF'],
  ['heic', 'HEIC'], ['gif', 'GIF'], ['bmp', 'BMP'], ['tiff', 'TIFF'], ['ico', 'ICO']);

const qualityOpt = (def = 85): OptionSpec => ({ key: 'quality', label: 'Quality', type: 'number', default: def, min: 1, max: 100, help: 'For JPG / WebP / AVIF / HEIC output' });
const formatOpt = (def = 'keep'): OptionSpec => ({ key: 'format', label: 'Output format', type: 'select', choices: FORMAT_KEEP, default: def });
const bgOpt = (def = '#ffffff', label = 'Background'): OptionSpec => ({ key: 'background', label, type: 'text', default: def, placeholder: '#ffffff or transparent', help: 'Used where transparency must be flattened (JPG/BMP) or padded' });

const COLOR_RE = /^(transparent|none|#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i;
function color(v: unknown, name: string): string {
  const s = String(v ?? '').trim();
  if (!COLOR_RE.test(s)) throw new Error(`${name} must be a hex colour like #ffffff or "transparent"`);
  return s;
}

/** '#rgb' / '#rrggbbaa' / 'transparent' → sharp colour object. */
function rgba(hex: string): { r: number; g: number; b: number; alpha: number } {
  const s = hex.trim().toLowerCase();
  if (s === 'transparent' || s === 'none') return { r: 0, g: 0, b: 0, alpha: 0 };
  let h = s.replace('#', '');
  if (h.length <= 4) h = h.split('').map(c => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), alpha: h.length === 8 ? n(6) / 255 : 1 };
}

/** Run an image_tools.py command with a JSON spec file; returns its parsed result. */
async function py(command: string, ctx: JobRunCtx, spec: Record<string, unknown>, timeoutMs = 15 * 60_000) {
  const specPath = join(ctx.workDir, '..', `spec-${command}.json`);
  await fs.writeFile(specPath, JSON.stringify({ outDir: ctx.workDir, ...spec }));
  return runPythonScript('image_tools.py', [command, specPath], {
    signal: ctx.signal, timeoutMs, onProgress: (p, m) => ctx.progress(p, m),
  });
}

const inputsOf = (ctx: JobRunCtx, filter: (f: JobRunCtx['inputs'][number]) => boolean = () => true) =>
  ctx.inputs.filter(filter).map(f => ({ path: f.path, name: f.filename }));

/** Turn a python per-file result list into job outputs + meta (throws when every file failed). */
function filesResult(result: { files: any[]; [k: string]: unknown }) {
  const files = result.files ?? [];
  const ok = files.filter(f => !f.error && f.outputPath);
  if (!ok.length) throw new Error(files.map(f => `${f.file}: ${f.error}`).join('\n') || 'No output produced');
  const outputs: JobOutput[] = ok.map(f => ({ path: f.outputPath, filename: f.output, mimeType: mimeFor(f.output) }));
  const meta = { ...result, files: files.map(({ outputPath: _p, ...rest }) => rest) };
  return { outputs, meta };
}

// ---------------------------------------------------------------------------------------------
// capability probe (cached)
// ---------------------------------------------------------------------------------------------

let capsPromise: Promise<any> | null = null;
function imageCaps(): Promise<any> {
  if (!capsPromise) {
    capsPromise = (async () => {
      const python = !!(await findBinary('python'));
      const pillow = python && (await hasPythonModule('PIL')) && (await hasPythonModule('numpy'));
      let pyCaps: any = null;
      let pyError = '';
      if (pillow) {
        try { pyCaps = await runPythonScript('image_tools.py', ['caps'], { timeoutMs: 60_000 }); } catch (e) { pyError = (e as Error).message; }
      }
      const f = sharp.format as unknown as Record<string, { input: { buffer: boolean }; output: { buffer: boolean } }>;
      return {
        python, pillow, error: pyError || undefined,
        encode: pyCaps?.encode ?? {}, decode: pyCaps?.decode ?? {},
        versions: { pillow: pyCaps?.pillow, pillowHeif: pyCaps?.pillowHeif, numpy: pyCaps?.numpy, python: pyCaps?.python, sharp: sharp.versions.sharp, vips: sharp.versions.vips },
        sharp: { svg: !!f.svg?.input.buffer, avif: !!f.heif?.output.buffer, webp: !!f.webp?.output.buffer },
        freetype: pyCaps?.freetype ?? false,
        cpus: cpus().length,
      };
    })().catch(e => { capsPromise = null; throw e; });
  }
  return capsPromise;
}

// ---------------------------------------------------------------------------------------------
// palette extraction (k-means++ or median cut over a downsampled copy)
// ---------------------------------------------------------------------------------------------

type RGB = [number, number, number];

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

export function kmeans(pixels: RGB[], k: number, iterations = 16): { color: RGB; count: number }[] {
  if (!pixels.length) return [];
  const rand = mulberry32(42);
  const centers: RGB[] = [pixels[Math.floor(rand() * pixels.length)]];
  const d = new Float64Array(pixels.length).fill(Infinity);
  while (centers.length < k) {
    const last = centers[centers.length - 1];
    let sum = 0;
    for (let i = 0; i < pixels.length; i++) { d[i] = Math.min(d[i], dist2(pixels[i], last)); sum += d[i]; }
    if (sum === 0) break; // fewer distinct colours than k
    let r = rand() * sum;
    let idx = 0;
    for (; idx < pixels.length - 1; idx++) { r -= d[idx]; if (r <= 0) break; }
    centers.push([...pixels[idx]] as RGB);
  }
  const assign = new Int32Array(pixels.length);
  for (let it = 0; it < iterations; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    let moved = false;
    for (let i = 0; i < pixels.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) { const dd = dist2(pixels[i], centers[c]); if (dd < bd) { bd = dd; best = c; } }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
      const s = sums[best]; s[0] += pixels[i][0]; s[1] += pixels[i][1]; s[2] += pixels[i][2]; s[3]++;
    }
    sums.forEach((s, c) => { if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    if (!moved && it > 0) break;
  }
  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < pixels.length; i++) counts[assign[i]]++;
  return centers.map((c, i) => ({ color: c.map(Math.round) as RGB, count: counts[i] })).filter(c => c.count > 0);
}

export function medianCut(pixels: RGB[], k: number): { color: RGB; count: number }[] {
  if (!pixels.length) return [];
  let boxes: RGB[][] = [pixels];
  const range = (box: RGB[], ch: number) => { let lo = 255, hi = 0; for (const p of box) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; } return hi - lo; };
  while (boxes.length < k) {
    // Split the box with the largest (range × population) along its widest channel.
    let bi = -1, bscore = 0, bch = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let ch = 0; ch < 3; ch++) { const s = range(b, ch) * Math.sqrt(b.length); if (s > bscore) { bscore = s; bi = i; bch = ch; } }
    });
    if (bi < 0) break;
    const box = boxes[bi].slice().sort((a, b) => a[bch] - b[bch]);
    // Split near the median, but never through a run of equal values (a flat colour area
    // would otherwise end up as two identical swatches).
    const mid = box.length >> 1;
    const v = box[mid][bch];
    let lo = mid; while (lo > 0 && box[lo - 1][bch] === v) lo--;
    let hi = mid; while (hi < box.length && box[hi][bch] === v) hi++;
    const cut = lo === 0 ? hi : hi === box.length ? lo : (mid - lo <= hi - mid ? lo : hi);
    boxes = [...boxes.slice(0, bi), box.slice(0, cut), box.slice(cut), ...boxes.slice(bi + 1)];
  }
  return boxes.map(b => {
    const s = [0, 0, 0];
    for (const p of b) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    return { color: s.map(v => Math.round(v / b.length)) as RGB, count: b.length };
  });
}

/** Merge clusters whose colours are visually identical (ΔRGB < 6). */
function mergeClose(list: { color: RGB; count: number }[]) {
  const out: { color: RGB; count: number }[] = [];
  for (const c of list.sort((a, b) => b.count - a.count)) {
    const same = out.find(o => dist2(o.color, c.color) < 36);
    if (same) same.count += c.count; else out.push({ color: [...c.color] as RGB, count: c.count });
  }
  return out;
}

const hex = (c: RGB) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');

async function extractPalette(buf: Buffer, count: number, method: 'kmeans' | 'median') {
  const img = sharp(buf, { failOn: 'none', limitInputPixels: 150_000_000 }).rotate();
  const meta = await img.metadata();
  const { data, info } = await img.resize(160, 160, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels: RGB[] = [];
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 128) continue; // ignore transparent pixels
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  const clusters = mergeClose(method === 'median' ? medianCut(pixels, count) : kmeans(pixels, count));
  const total = clusters.reduce((s, c) => s + c.count, 0) || 1;
  return {
    width: meta.width, height: meta.height, format: meta.format, sampled: pixels.length,
    colors: clusters.sort((a, b) => b.count - a.count).map(c => ({
      hex: hex(c.color), rgb: c.color, percent: Math.round((c.count / total) * 1000) / 10,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// favicon + svg rasterising (sharp)
// ---------------------------------------------------------------------------------------------

/** Pack PNG buffers into a .ico (PNG-compressed entries, supported by every current browser/OS). */
export function buildIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const o = 6 + i * 16;
    header.writeUInt8(img.size >= 256 ? 0 : img.size, o);
    header.writeUInt8(img.size >= 256 ? 0 : img.size, o + 1);
    header.writeUInt8(0, o + 2);
    header.writeUInt8(0, o + 3);
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(img.png.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += img.png.length;
  });
  return Buffer.concat([header, ...images.map(i => i.png)]);
}

async function svgDensityFor(buf: Buffer, targetPx: number): Promise<number> {
  const m = await sharp(buf).metadata();
  const side = Math.max(m.width || 0, m.height || 0) || 100;
  return Math.min(2400, Math.max(10, Math.ceil((72 * targetPx) / side)));
}

async function renderSquare(src: Buffer, isSvg: boolean, size: number, o: { background: string; padding: number; shape: string; flatten?: boolean }) {
  const inner = Math.max(1, Math.round(size * (1 - (2 * o.padding) / 100)));
  const input = isSvg ? sharp(src, { density: await svgDensityFor(src, inner) }) : sharp(src, { failOn: 'none' }).rotate();
  const glyph = await input.resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' }).png().toBuffer();
  let bg = rgba(o.background);
  if (o.flatten && bg.alpha < 1) bg = { r: 255, g: 255, b: 255, alpha: 1 };
  const layers: sharp.OverlayOptions[] = [{ input: glyph, gravity: 'center' }];
  if (o.shape !== 'square' && !o.flatten) { // iOS masks apple-touch-icon itself; keep it square + opaque
    const r = o.shape === 'circle' ? size / 2 : size * 0.18;
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}"/></svg>`), blend: 'dest-in' });
  }
  return sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite(layers).png({ compressionLevel: 9 }).toBuffer();
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

async function runFavicon(ctx: JobRunCtx) {
  const o = ctx.options;
  const input = ctx.inputs[0];
  const src = await fs.readFile(input.path);
  const isSvg = extname(input.filename).toLowerCase() === '.svg';
  const opts = { background: color(o.background, 'Background'), padding: Math.max(0, Math.min(40, Number(o.padding) || 0)), shape: String(o.shape) };
  const theme = color(o.themeColor, 'Theme colour');
  const appName = String(o.appName || 'My App').slice(0, 100);
  const shortName = String(o.shortName || appName).slice(0, 30);

  const outputs: JobOutput[] = [];
  const files: { name: string; size: number; px: number }[] = [];
  const write = async (name: string, buf: Buffer, px: number) => {
    const p = join(ctx.workDir, name);
    await fs.writeFile(p, buf);
    outputs.push({ path: p, filename: name, mimeType: mimeFor(name) });
    files.push({ name, size: buf.length, px });
  };

  const sizes = [16, 32, 48, 64, 96, 128, 180, 192, 256, 384, 512];
  const pngs = new Map<number, Buffer>();
  for (const [i, s] of sizes.entries()) {
    if (ctx.signal.aborted) throw new Error('Cancelled');
    pngs.set(s, await renderSquare(src, isSvg, s, { ...opts, flatten: s === 180 }));
    ctx.progress(5 + (80 * (i + 1)) / sizes.length, `Rendering ${s}×${s}`);
  }
  await write('favicon.ico', buildIco([16, 32, 48].map(s => ({ size: s, png: pngs.get(s)! }))), 48);
  if (isSvg) await write('favicon.svg', src, 0);
  for (const s of [16, 32, 48, 64, 96, 128, 256, 384]) await write(`favicon-${s}x${s}.png`, pngs.get(s)!, s);
  await write('apple-touch-icon.png', pngs.get(180)!, 180);
  await write('android-chrome-192x192.png', pngs.get(192)!, 192);
  await write('android-chrome-512x512.png', pngs.get(512)!, 512);

  const manifest = {
    name: appName, short_name: shortName,
    icons: [
      { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: theme === 'transparent' ? '#ffffff' : theme,
    background_color: opts.background === 'transparent' ? '#ffffff' : opts.background,
    display: 'standalone',
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  await write('site.webmanifest', Buffer.from(manifestText), 0);
  const html = [
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    isSvg ? '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' : '<link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    `<meta name="theme-color" content="${escapeHtml(manifest.theme_color)}">`,
    `<meta name="apple-mobile-web-app-title" content="${escapeHtml(shortName)}">`,
  ].join('\n') + '\n';
  await write('favicon-snippet.html', Buffer.from(html), 0);
  return { outputs, meta: { html, manifest: manifestText, files } };
}

async function runSvgRaster(ctx: JobRunCtx) {
  const o = ctx.options;
  const fmt = String(o.format) as 'png' | 'jpg' | 'webp' | 'avif';
  const bg = color(o.background, 'Background');
  const outputs: JobOutput[] = [];
  const files: unknown[] = [];
  for (const [i, f] of ctx.inputs.entries()) {
    if (ctx.signal.aborted) throw new Error('Cancelled');
    const buf = await fs.readFile(f.path);
    const m = await sharp(buf).metadata().catch(() => { throw new Error(`${f.filename}: not a valid SVG`); });
    const w0 = m.width || 300, h0 = m.height || 150;
    const width = Math.round(Number(o.width) > 0 ? Number(o.width) : w0 * Math.max(0.01, Number(o.scale) || 1));
    if (width < 1 || width > 16384) throw new Error('Output width must be between 1 and 16384 px');
    const height = Math.max(1, Math.round((h0 * width) / w0));
    if (width * height > 100_000_000) throw new Error('Output exceeds 100 megapixels');
    const density = Number(o.density) > 0 ? Math.min(2400, Number(o.density)) : Math.min(2400, Math.max(1, (72 * width) / w0));
    let img = sharp(buf, { density }).resize(width, height, { fit: 'fill' });
    const b = rgba(bg);
    if (fmt === 'jpg' || b.alpha > 0) img = img.flatten({ background: fmt === 'jpg' && b.alpha === 0 ? '#ffffff' : bg });
    const q = Math.max(1, Math.min(100, Number(o.quality) || 90));
    img = fmt === 'jpg' ? img.jpeg({ quality: q, mozjpeg: true }) : fmt === 'webp' ? img.webp({ quality: q }) : fmt === 'avif' ? img.avif({ quality: q }) : img.png({ compressionLevel: 9 });
    const out = await img.toBuffer();
    const name = withExt(f.filename, fmt);
    const p = join(ctx.workDir, `${i}_${name}`);
    await fs.writeFile(p, out);
    outputs.push({ path: p, filename: name, mimeType: mimeFor(name) });
    files.push({ file: f.filename, output: name, width, height, density: Math.round(density), size: out.length });
    ctx.progress(((i + 1) / ctx.inputs.length) * 95);
  }
  return { outputs, meta: { files } };
}

// ---------------------------------------------------------------------------------------------
// converters
// ---------------------------------------------------------------------------------------------

const transform = (op: string) => async (ctx: JobRunCtx) => {
  const opts = { ...ctx.options };
  if ('background' in opts) opts.background = color(opts.background, 'Background');
  if ('fill' in opts) opts.fill = color(opts.fill, 'Fill');
  if ('color' in opts) opts.color = color(opts.color, 'Text colour');
  let logo: string | undefined;
  let inputs = inputsOf(ctx);
  if (op === 'watermark') {
    const l = ctx.inputs.find(f => f.filename.includes('__wmlogo'));
    logo = l?.path;
    inputs = inputsOf(ctx, f => f !== l);
    if (!inputs.length) throw new Error('Add at least one image to watermark');
    if (opts.mode === 'logo' && !logo) throw new Error('Add a logo image (the file named __wmlogo…) for logo watermarks');
  }
  return filesResult(await py('transform', ctx, { op, inputs, options: opts, logo }));
};

export const converters: ConverterSpec[] = [
  {
    id: 'image-compress', label: 'Compress images', group: 'image', inputs: RASTER_IN, output: 'same / chosen format',
    maxFiles: 50, requires: PY, timeoutMs: 20 * 60_000,
    options: [
      { key: 'preset', label: 'Preset', type: 'select', default: 'web', choices: choices(
        ['lossless', 'Lossless (strip metadata, bit-identical)'], ['near', 'Near-lossless (SSIM > 0.995)'],
        ['web', 'Web sweet spot'], ['aggressive', 'Aggressive'], ['custom', 'Custom']) },
      { key: 'format', label: 'Output format', type: 'select', default: 'keep', choices: choices(['keep', 'Same as input'], ['jpg', 'JPG'], ['webp', 'WebP'], ['avif', 'AVIF'], ['heic', 'HEIC'], ['png', 'PNG']) },
      { key: 'quality', label: 'Quality (custom)', type: 'number', default: 80, min: 1, max: 100 },
      { key: 'maxDim', label: 'Max dimension (px, 0 = preset)', type: 'number', default: 0, min: 0, max: 20000 },
      { key: 'pngColors', label: 'PNG palette colours (custom, 0 = lossless)', type: 'number', default: 0, min: 0, max: 256 },
      { key: 'resample', label: 'Resampling', type: 'select', default: 'lanczos', choices: choices(['lanczos', 'Lanczos (sharpest)'], ['bicubic', 'Bicubic (faster)']) },
      { key: 'keepMetadata', label: 'Keep EXIF metadata', type: 'boolean', default: false },
      { key: 'keepIcc', label: 'Keep ICC colour profile', type: 'boolean', default: true },
      { key: 'neverLarger', label: 'Never output a larger file', type: 'boolean', default: true },
      { key: 'metrics', label: 'Compute PSNR / SSIM', type: 'boolean', default: true },
    ],
    run: async ctx => filesResult(await py('compress', ctx, { inputs: inputsOf(ctx), options: ctx.options })),
  },
  {
    id: 'image-batch', label: 'Batch compress', group: 'image', inputs: [...RASTER_IN, 'zip'], output: 'zip',
    maxFiles: 500, requires: PY, timeoutMs: 90 * 60_000,
    options: [
      { key: 'format', label: 'Output format', type: 'select', default: 'webp', choices: choices(['webp', 'WebP'], ['avif', 'AVIF'], ['jpg', 'JPG'], ['png', 'PNG'], ['keep', 'Same as input']) },
      { key: 'quality', label: 'Quality', type: 'number', default: 75, min: 1, max: 100 },
      { key: 'maxDim', label: 'Max dimension (px, 0 = keep)', type: 'number', default: 1200, min: 0, max: 20000 },
      { key: 'resample', label: 'Resampling', type: 'select', default: 'lanczos', choices: choices(['lanczos', 'Lanczos (max quality)'], ['bicubic', 'Bicubic (faster)']) },
      { key: 'fastDecode', label: 'Fast JPEG draft decode', type: 'boolean', default: false, help: 'Decode JPEGs at reduced scale (~30% faster when downscaling)' },
      { key: 'webpMethod', label: 'WebP effort (0–6)', type: 'number', default: 4, min: 0, max: 6 },
      { key: 'keepMetadata', label: 'Keep EXIF metadata', type: 'boolean', default: false },
      { key: 'workers', label: 'Workers (0 = all cores)', type: 'number', default: 0, min: 0, max: 64 },
    ],
    run: async ctx => {
      const r = await py('batch', ctx, { inputs: inputsOf(ctx), options: ctx.options, workDir: join(ctx.workDir, '..', 'batch'), zipName: 'compressed-images.zip' }, 90 * 60_000);
      return { outputs: [{ path: r.zip, filename: 'compressed-images.zip', mimeType: 'application/zip' }], meta: { stats: r.stats, errors: r.errors, files: r.files, skippedFiles: r.skippedFiles } };
    },
  },
  {
    id: 'image-benchmark', label: 'Run benchmark', group: 'image', inputs: RASTER_IN, output: 'variants',
    maxFiles: 1, requires: PY, timeoutMs: 30 * 60_000,
    options: [
      { key: 'categories', label: 'Categories', type: 'text', default: '', placeholder: 'lossless,near,web,aggressive,resized (empty = all)' },
      { key: 'profiles', label: 'Profile ids', type: 'text', default: '', placeholder: 'e.g. 01,10,16 (empty = all)' },
      { key: 'parallel', label: 'Encode in parallel', type: 'boolean', default: true, help: 'Faster; per-profile encode times include some CPU contention' },
    ],
    run: async ctx => {
      const r = await py('benchmark', ctx, { inputs: inputsOf(ctx), options: ctx.options }, 30 * 60_000);
      const outputs: JobOutput[] = (r.outputs as string[]).map(p => ({ path: p, filename: p.split(/[\\/]/).pop()!, mimeType: mimeFor(p) }));
      if (!outputs.length) throw new Error(r.rows?.find((x: any) => x.error)?.error || 'No profile could be encoded');
      return { outputs, meta: { original: r.original, rows: r.rows, workers: r.workers, caps: r.caps } };
    },
  },
  {
    id: 'image-convert', label: 'Convert', group: 'image', inputs: RASTER_IN, output: 'image', maxFiles: 50, requires: PY,
    options: [
      formatOpt('webp'), qualityOpt(85), bgOpt(),
      { key: 'lossless', label: 'Lossless (WebP / AVIF)', type: 'boolean', default: false },
      { key: 'keepAnimation', label: 'Keep animation (GIF/WebP → GIF/WebP)', type: 'boolean', default: true },
    ],
    run: transform('convert'),
  },
  {
    id: 'image-resize', label: 'Resize', group: 'image', inputs: RASTER_IN, output: 'image', maxFiles: 50, requires: PY,
    options: [
      { key: 'mode', label: 'Mode', type: 'select', default: 'maxside', choices: choices(['maxside', 'Max side'], ['exact', 'Exact width × height'], ['percent', 'Percentage']) },
      { key: 'maxSide', label: 'Max side (px)', type: 'number', default: 1200, min: 1, max: 20000 },
      { key: 'width', label: 'Width (px)', type: 'number', default: 1200, min: 0, max: 20000 },
      { key: 'height', label: 'Height (px)', type: 'number', default: 800, min: 0, max: 20000 },
      { key: 'fit', label: 'Fit', type: 'select', default: 'contain', choices: choices(['contain', 'Contain (letterbox)'], ['cover', 'Cover (crop)'], ['fill', 'Fill (stretch)'], ['inside', 'Inside (no padding)']) },
      { key: 'gravity', label: 'Crop anchor (cover)', type: 'select', default: 'center', choices: choices(['center', 'Center'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']) },
      { key: 'percent', label: 'Percent', type: 'number', default: 50, min: 1, max: 1000 },
      { key: 'noUpscale', label: "Don't upscale", type: 'boolean', default: true },
      { key: 'resample', label: 'Resampling', type: 'select', default: 'lanczos', choices: choices(['lanczos', 'Lanczos'], ['bicubic', 'Bicubic'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest (pixel art)']) },
      bgOpt('transparent', 'Letterbox colour'), formatOpt(), qualityOpt(88),
    ],
    run: transform('resize'),
  },
  {
    id: 'image-crop', label: 'Crop', group: 'image', inputs: RASTER_IN, output: 'image', maxFiles: 50, requires: PY,
    options: [
      { key: 'x', label: 'X', type: 'number', default: 0, min: 0, max: 100000 },
      { key: 'y', label: 'Y', type: 'number', default: 0, min: 0, max: 100000 },
      { key: 'width', label: 'Width', type: 'number', default: 100000, min: 1, max: 100000 },
      { key: 'height', label: 'Height', type: 'number', default: 100000, min: 1, max: 100000 },
      formatOpt(), qualityOpt(92), bgOpt(),
    ],
    run: transform('crop'),
  },
  {
    id: 'image-rotate', label: 'Rotate / flip', group: 'image', inputs: RASTER_IN, output: 'image', maxFiles: 50, requires: PY,
    options: [
      { key: 'angle', label: 'Angle (° clockwise)', type: 'number', default: 90, min: -360, max: 360, step: 0.1 },
      { key: 'flipH', label: 'Flip horizontal', type: 'boolean', default: false },
      { key: 'flipV', label: 'Flip vertical', type: 'boolean', default: false },
      { key: 'expand', label: 'Expand canvas to fit', type: 'boolean', default: true },
      { key: 'fill', label: 'Fill colour', type: 'text', default: 'transparent', placeholder: '#ffffff or transparent' },
      formatOpt(), qualityOpt(92), bgOpt(),
    ],
    run: transform('rotate'),
  },
  {
    id: 'image-watermark', label: 'Watermark', group: 'image', inputs: RASTER_IN, output: 'image', maxFiles: 51, requires: PY,
    options: [
      { key: 'mode', label: 'Type', type: 'select', default: 'text', choices: choices(['text', 'Text'], ['logo', 'Logo image']) },
      { key: 'text', label: 'Text', type: 'text', default: '© Your Name' },
      { key: 'position', label: 'Position', type: 'select', default: 'br', choices: choices(['tl', 'Top left'], ['tc', 'Top center'], ['tr', 'Top right'], ['ml', 'Middle left'], ['c', 'Center'], ['mr', 'Middle right'], ['bl', 'Bottom left'], ['bc', 'Bottom center'], ['br', 'Bottom right'], ['tiled', 'Tiled']) },
      { key: 'opacity', label: 'Opacity %', type: 'number', default: 60, min: 0, max: 100 },
      { key: 'scale', label: 'Width (% of image)', type: 'number', default: 25, min: 1, max: 100 },
      { key: 'fontSize', label: 'Font size px (0 = from width)', type: 'number', default: 0, min: 0, max: 2000 },
      { key: 'margin', label: 'Margin (% of short side)', type: 'number', default: 3, min: 0, max: 40 },
      { key: 'angle', label: 'Angle (° clockwise)', type: 'number', default: 0, min: -180, max: 180 },
      { key: 'gap', label: 'Tile spacing %', type: 'number', default: 60, min: 20, max: 400 },
      { key: 'color', label: 'Text colour', type: 'text', default: '#ffffff' },
      { key: 'outline', label: 'Contrast outline', type: 'boolean', default: true },
      formatOpt(), qualityOpt(90),
    ],
    run: transform('watermark'),
  },
  {
    id: 'favicon', label: 'Generate favicons', group: 'image', inputs: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'svg'], output: 'ico + png + manifest',
    maxFiles: 1, timeoutMs: 3 * 60_000,
    options: [
      { key: 'background', label: 'Background', type: 'text', default: 'transparent', placeholder: '#ffffff or transparent' },
      { key: 'padding', label: 'Padding %', type: 'number', default: 0, min: 0, max: 40 },
      { key: 'shape', label: 'Shape', type: 'select', default: 'square', choices: choices(['square', 'Square'], ['rounded', 'Rounded'], ['circle', 'Circle']) },
      { key: 'appName', label: 'App name', type: 'text', default: 'My App' },
      { key: 'shortName', label: 'Short name', type: 'text', default: '' },
      { key: 'themeColor', label: 'Theme colour', type: 'text', default: '#ffffff' },
    ],
    run: runFavicon,
  },
  {
    id: 'svg-raster', label: 'Rasterise SVG', group: 'image', inputs: ['svg'], output: 'png / jpg / webp / avif', maxFiles: 50, timeoutMs: 5 * 60_000,
    options: [
      { key: 'format', label: 'Format', type: 'select', default: 'png', choices: choices(['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP'], ['avif', 'AVIF']) },
      { key: 'width', label: 'Width px (0 = use scale)', type: 'number', default: 1024, min: 0, max: 16384 },
      { key: 'scale', label: 'Scale ×', type: 'number', default: 1, min: 0.01, max: 64, step: 0.1 },
      { key: 'density', label: 'Density DPI (0 = auto)', type: 'number', default: 0, min: 0, max: 2400 },
      { key: 'background', label: 'Background', type: 'text', default: 'transparent', placeholder: '#ffffff or transparent' },
      { key: 'quality', label: 'Quality', type: 'number', default: 90, min: 1, max: 100 },
    ],
    run: runSvgRaster,
  },
];

// ---------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------

const MAX_SVG = 5 * 1024 * 1024;

export const routes: ToolRoute[] = [
  {
    method: 'GET', path: '/api/tools/image/caps',
    handler: async ({ res }) => sendJson(res, await imageCaps()),
  },
  {
    method: 'POST', path: '/api/tools/image/svgo',
    handler: async ({ req, res }) => {
      const body = await readJson(req, MAX_SVG + 64 * 1024);
      const svg = str(body.svg, 'svg', { max: MAX_SVG });
      const precision = Math.max(0, Math.min(8, Math.round(Number(body.precision ?? 3))));
      const flag = (k: string, d: boolean) => (body[k] === undefined ? d : !!body[k]);
      const overrides: Record<string, false> = {};
      if (!flag('cleanupIds', true)) overrides.cleanupIds = false;
      if (!flag('removeComments', true)) overrides.removeComments = false;
      if (!flag('removeMetadata', true)) overrides.removeMetadata = false;
      if (!flag('convertColors', true)) overrides.convertColors = false;
      if (!flag('mergePaths', true)) overrides.mergePaths = false;
      if (!flag('inlineStyles', true)) { overrides.inlineStyles = false; overrides.minifyStyles = false; }
      if (!flag('removeDesc', true)) overrides.removeDesc = false;
      const plugins: PluginConfig[] = [{ name: 'preset-default', params: { floatPrecision: precision, overrides } } as PluginConfig];
      if (flag('removeViewBox', false)) plugins.push('removeViewBox');
      if (flag('removeDimensions', false)) plugins.push('removeDimensions');
      if (flag('removeTitle', false)) plugins.push('removeTitle');
      if (flag('removeXMLNS', false)) plugins.push('removeXMLNS');
      if (flag('sortAttrs', true)) plugins.push('sortAttrs');
      if (flag('removeScripts', true)) plugins.push('removeScripts');
      let out: string;
      try {
        out = optimize(svg, { multipass: flag('multipass', true), plugins, js2svg: { pretty: flag('pretty', false), indent: 2 } }).data;
      } catch (e) {
        throw new HttpError(400, `Invalid SVG: ${(e as Error).message.split('\n')[0]}`);
      }
      const before = Buffer.byteLength(svg), after = Buffer.byteLength(out);
      sendJson(res, {
        svg: out, before, after, savedPct: before ? Math.round((1 - after / before) * 1000) / 10 : 0,
        gzipBefore: gzipSync(svg).length, gzipAfter: gzipSync(out).length,
      });
    },
  },
  {
    method: 'POST', path: '/api/tools/image/palette',
    handler: async ({ req, res }) => {
      const { fields, files } = await readMultipart(req, 50 * 1024 * 1024);
      const file = files[0];
      if (!file) throw new HttpError(400, 'Upload an image as "file"');
      const count = Math.max(2, Math.min(24, Math.round(Number(fields.count) || 8)));
      const method = fields.method === 'median' ? 'median' : 'kmeans';
      try {
        sendJson(res, { ...(await extractPalette(file.buffer, count, method)), method, file: safeName(file.filename) });
      } catch (e) {
        throw new HttpError(400, `Could not read image: ${(e as Error).message}`);
      }
    },
  },
];
