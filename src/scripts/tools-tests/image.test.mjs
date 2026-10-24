// Tests for /api/tools/image/* and the image converters (src/libs/tools/image.ts + image_tools.py).
// Fixtures are generated here with sharp so nothing binary needs to be committed.
import sharp from 'sharp';
import JSZip from 'jszip';
import { api, assert, assertMagic, runJob, test } from './lib.mjs';

// ---------- fixtures ----------

/** A 640×480 noisy gradient "photo" (noise makes it compress like a real photo). */
async function photoRaw(w = 640, h = 480) {
  const buf = Buffer.alloc(w * h * 3);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const n = (rnd() - 0.5) * 30;
    buf[i] = Math.max(0, Math.min(255, (x / w) * 255 + n));
    buf[i + 1] = Math.max(0, Math.min(255, (y / h) * 255 + n));
    buf[i + 2] = Math.max(0, Math.min(255, 128 + 100 * Math.sin(x / 40) + n));
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } });
}

const PHOTO_JPG = (await photoRaw()).jpeg({ quality: 95 }).withExif({ IFD0: { Make: 'TestCam', Model: 'Bench 1', Software: 'x'.repeat(2000) } }).withMetadata({ orientation: 6 }).toBuffer();
const PHOTO_PLAIN_JPG = (await photoRaw()).jpeg({ quality: 92 }).toBuffer();
// Half-transparent red square on transparent background.
const ALPHA_PNG = sharp({ create: { width: 200, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: { create: { width: 100, height: 60, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }, left: 50, top: 30 }])
  .png().toBuffer();
const LOGO_SVG = Buffer.from(`<?xml version="1.0"?>
<!-- generator: test -->
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <metadata>junk</metadata>
  <g><rect x="0" y="0" width="64" height="64" rx="12" fill="#2563eb"/></g>
  <circle cx="32.000000" cy="32.000000" r="16.000000" fill="#ffffff"/>
</svg>`);

const meta = buf => sharp(buf).metadata();
const jpg = async () => ({ name: 'photo.jpg', data: await PHOTO_JPG, type: 'image/jpeg' });
const plainJpg = async (name = 'plain.jpg') => ({ name, data: await PHOTO_PLAIN_JPG, type: 'image/jpeg' });
const png = async (name = 'alpha.png') => ({ name, data: await ALPHA_PNG, type: 'image/png' });

let caps;
const capsReady = api.get('/image/caps').then(c => { caps = c; return c; });

// ---------- routes ----------

test('caps reports encoders and CPU count', async () => {
  const c = await capsReady;
  assert.equal(c.python, true, 'python available');
  assert.equal(c.pillow, true, 'Pillow + numpy available');
  for (const f of ['jpg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'ico']) assert.equal(c.encode[f], true, `encode ${f}`);
  assert.equal(typeof c.encode.avif, 'boolean');
  assert.equal(typeof c.encode.heic, 'boolean');
  assert.ok(c.cpus >= 1);
  assert.equal(c.sharp.svg, true);
});

test('svgo optimises and reports sizes', async () => {
  const r = await api.post('/image/svgo', { svg: LOGO_SVG.toString(), multipass: true, precision: 2 });
  assert.ok(r.after < r.before, `${r.after} < ${r.before}`);
  assert.ok(!r.svg.includes('<metadata') && !r.svg.includes('generator'), 'comments/metadata removed');
  assert.ok(r.svg.includes('viewBox'), 'viewBox kept by default');
  assert.ok(r.gzipAfter > 0 && r.savedPct > 0);
  const r2 = await api.post('/image/svgo', { svg: LOGO_SVG.toString(), removeDimensions: true });
  assert.ok(!/ width="64"/.test(r2.svg.split('>')[0]), 'dimensions removed');
});

test('svgo rejects invalid SVG with 400', async () => {
  await assert.rejects(api.post('/image/svgo', { svg: '<svg><g></svg' }), /400/);
  await assert.rejects(api.post('/image/svgo', {}), /400/);
});

test('palette extracts dominant colours (k-means and median cut)', async () => {
  // 75% blue, 25% yellow
  const img = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#1e40af' } })
    .composite([{ input: { create: { width: 50, height: 50, channels: 3, background: '#facc15' } }, left: 0, top: 0 }]).png().toBuffer();
  for (const method of ['kmeans', 'median']) {
    const r = await api.postForm('/image/palette', { count: '4', method }, [{ name: 'p.png', data: img, type: 'image/png' }], 'file');
    assert.equal(r.method, method);
    assert.ok(r.colors.length >= 2 && r.colors.length <= 4);
    assert.equal(r.colors[0].hex, '#1e40af', `${method} dominant`);
    assert.ok(Math.abs(r.colors[0].percent - 75) < 3, `${method} percent ${r.colors[0].percent}`);
    assert.ok(r.colors.some(c => c.hex === '#facc15'));
  }
});

test('palette rejects non-images', async () => {
  await assert.rejects(api.postForm('/image/palette', {}, [{ name: 'x.png', data: 'not an image' }], 'file'), /400/);
});

// ---------- compress ----------

test('lossless JPEG strip is bit-identical, smaller, and keeps orientation', async () => {
  const input = await jpg();
  const { job, outputs } = await runJob('image-compress', [input], { preset: 'lossless' });
  const f = job.meta.files[0];
  assertMagic(outputs[0], 'jpg');
  assert.ok(outputs[0].length < input.data.length - 1500, `stripped ${input.data.length} → ${outputs[0].length}`);
  assert.equal(f.psnrInf, true);
  assert.equal(f.ssim, 1);
  assert.equal(f.maxDiff, 0);
  const m = await meta(outputs[0]);
  assert.equal(m.orientation, 6, 'orientation tag preserved');
  assert.equal(f.width, 480, 'reported dims are display (rotated) dims');
  // Decoded pixels identical to the original.
  const [a, b] = await Promise.all([sharp(input.data).raw().toBuffer(), sharp(outputs[0]).raw().toBuffer()]);
  assert.ok(a.equals(b), 'pixels identical');
});

test('web preset to WebP reports PSNR/SSIM and savings', async () => {
  const { job, outputs } = await runJob('image-compress', [await plainJpg(), await png()], { preset: 'web', format: 'webp' });
  assert.equal(outputs.length, 2);
  outputs.forEach(o => assertMagic(o, 'webp'));
  const [photo] = job.meta.files;
  assert.equal(photo.output, 'plain.webp');
  assert.ok(photo.savedPct > 20, `saved ${photo.savedPct}%`);
  assert.ok(photo.psnr > 25 && photo.psnr < 60, `psnr ${photo.psnr}`);
  assert.ok(photo.ssim > 0.5 && photo.ssim <= 1, `ssim ${photo.ssim}`);
  assert.equal(job.meta.totals.count, 2);
});

test('custom quality + max dimension resizes', async () => {
  const { job, outputs } = await runJob('image-compress', [await plainJpg()], { preset: 'custom', format: 'jpg', quality: 60, maxDim: 320 });
  const m = await meta(outputs[0]);
  assert.equal(Math.max(m.width, m.height), 320);
  assert.match(job.meta.files[0].method, /JPG Q60/);
});

test('AVIF and HEIC output when supported', async () => {
  const c = await capsReady;
  for (const fmt of ['avif', 'heic']) {
    if (!c.encode[fmt]) { console.log(`      (skipping ${fmt}: not supported here)`); continue; }
    const { outputs } = await runJob('image-compress', [await plainJpg()], { preset: 'near', format: fmt });
    assertMagic(outputs[0], fmt);
  }
});

test('neverLarger keeps the original when re-encoding grows the file', async () => {
  const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png({ compressionLevel: 9 }).toBuffer();
  const { job, outputs } = await runJob('image-compress', [{ name: 'tiny.png', data: tiny }], { preset: 'near' });
  assert.ok(outputs[0].length <= tiny.length);
  assert.ok(job.meta.files[0].savedPct >= 0);
});

// ---------- batch ----------

test('batch compresses a zip + loose files into one zip with the same tree', async () => {
  const zip = new JSZip();
  zip.file('album/2024/a.jpg', await PHOTO_PLAIN_JPG);
  zip.file('album/b.png', await ALPHA_PNG);
  zip.file('album/notes.txt', 'skip me');
  zip.file('__MACOSX/album/._a.jpg', 'junk');
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
  const { job, outputs } = await runJob('image-batch', [{ name: 'photos.zip', data: zipBuf }, await plainJpg('loose.jpg')], { format: 'webp', quality: 70, maxDim: 300, workers: 2 });
  assertMagic(outputs[0], 'zip');
  const out = await JSZip.loadAsync(outputs[0]);
  const names = Object.keys(out.files).sort();
  assert.deepEqual(names, ['_compression-report.csv', 'album/2024/a.webp', 'album/b.webp', 'loose.webp']);
  const a = await out.file('album/2024/a.webp').async('nodebuffer');
  assertMagic(a, 'webp');
  assert.equal(Math.max((await meta(a)).width, (await meta(a)).height), 300);
  const s = job.meta.stats;
  assert.equal(s.count, 3);
  assert.equal(s.errors, 0);
  assert.equal(s.skipped, 1);
  assert.ok(s.after < s.before && s.throughput > 0 && s.workers >= 1);
});

test('batch reports per-file errors without failing the job', async () => {
  const { job } = await runJob('image-batch', [await plainJpg('ok.jpg'), { name: 'broken.jpg', data: Buffer.from('nope') }], { maxDim: 200 });
  assert.equal(job.meta.stats.count, 1);
  assert.equal(job.meta.stats.errors, 1);
  assert.equal(job.meta.errors[0].file, 'broken.jpg');
});

// ---------- benchmark ----------

test('benchmark encodes the selected profile categories with metrics', async () => {
  const { job, outputs } = await runJob('image-benchmark', [await plainJpg()], { categories: 'lossless,web' });
  const rows = job.meta.rows;
  assert.ok(rows.length >= 8 && rows.every(r => ['lossless', 'web'].includes(r.category)));
  const done = rows.filter(r => r.size);
  assert.equal(outputs.length, done.length);
  const strip = rows.find(r => r.id === '01');
  assert.equal(strip.psnrInf, true);
  assert.equal(strip.ssim, 1);
  const webp75 = rows.find(r => r.id === '16');
  assert.ok(webp75.reductionPct > 0 && webp75.ratio > 1 && webp75.encodeMs >= 0 && webp75.psnr > 20);
  assert.equal(job.meta.original.width, 640);
});

test('benchmark skips JPEG-only stripping for PNG input', async () => {
  const { job } = await runJob('image-benchmark', [await png()], { profiles: '01,03' });
  assert.match(job.meta.rows.find(r => r.id === '01').skipped, /JPEG/);
  assert.ok(job.meta.rows.find(r => r.id === '03').size > 0);
});

// ---------- convert / resize / crop / rotate / watermark ----------

test('convert PNG → JPG flattens transparency onto the background', async () => {
  const { outputs, job } = await runJob('image-convert', [await png()], { format: 'jpg', background: '#00ff00' });
  assertMagic(outputs[0], 'jpg');
  assert.equal(job.meta.files[0].output, 'alpha.jpg');
  const { data } = await sharp(outputs[0]).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] < 40 && data[1] > 200 && data[2] < 40, `corner is green: ${data.subarray(0, 3).join(',')}`);
});

test('convert to ICO, GIF, BMP, TIFF and PNG', async () => {
  for (const [fmt, magic] of [['ico', 'ico'], ['gif', 'gif'], ['png', 'png']]) {
    const { outputs } = await runJob('image-convert', [await plainJpg()], { format: fmt });
    assertMagic(outputs[0], magic);
  }
  const bmp = (await runJob('image-convert', [await plainJpg()], { format: 'bmp' })).outputs[0];
  assert.equal(bmp.subarray(0, 2).toString(), 'BM');
  const tif = (await runJob('image-convert', [await plainJpg()], { format: 'tiff' })).outputs[0];
  assert.ok(['II*\0', 'MM\0*'].includes(tif.subarray(0, 4).toString('latin1')));
});

test('convert rejects a bad background colour', async () => {
  await assert.rejects(runJob('image-convert', [await png()], { format: 'jpg', background: 'red; rm -rf' }), /hex colour/);
});

test('resize: max side, exact cover/contain and percent', async () => {
  let m = await meta((await runJob('image-resize', [await plainJpg()], { mode: 'maxside', maxSide: 200 })).outputs[0]);
  assert.deepEqual([m.width, m.height], [200, 150]);
  m = await meta((await runJob('image-resize', [await plainJpg()], { mode: 'exact', width: 300, height: 300, fit: 'cover' })).outputs[0]);
  assert.deepEqual([m.width, m.height], [300, 300]);
  const contain = (await runJob('image-resize', [await plainJpg()], { mode: 'exact', width: 300, height: 300, fit: 'contain', format: 'png' })).outputs[0];
  m = await meta(contain);
  assert.deepEqual([m.width, m.height, m.hasAlpha], [300, 300, true]);
  m = await meta((await runJob('image-resize', [await plainJpg()], { mode: 'exact', width: 300, height: 300, fit: 'inside' })).outputs[0]);
  assert.deepEqual([m.width, m.height], [300, 225]);
  m = await meta((await runJob('image-resize', [await plainJpg()], { mode: 'percent', percent: 25 })).outputs[0]);
  assert.deepEqual([m.width, m.height], [160, 120]);
  m = await meta((await runJob('image-resize', [await plainJpg()], { mode: 'maxside', maxSide: 4000, noUpscale: true })).outputs[0]);
  assert.equal(m.width, 640, 'no upscale');
});

test('crop to exact pixels (clamped to the image)', async () => {
  let m = await meta((await runJob('image-crop', [await plainJpg()], { x: 100, y: 50, width: 200, height: 100 })).outputs[0]);
  assert.deepEqual([m.width, m.height], [200, 100]);
  m = await meta((await runJob('image-crop', [await plainJpg()], { x: 600, y: 400, width: 500, height: 500 })).outputs[0]);
  assert.deepEqual([m.width, m.height], [40, 80]);
});

test('crop coordinates are in display orientation (EXIF applied)', async () => {
  const { job } = await runJob('image-crop', [await jpg()], { x: 0, y: 0, width: 480, height: 10 });
  assert.equal(job.meta.files[0].origWidth, 480);
  assert.equal(job.meta.files[0].width, 480);
});

test('rotate: quarter turn swaps dims, free angle expands, flip works', async () => {
  let m = await meta((await runJob('image-rotate', [await plainJpg()], { angle: 90 })).outputs[0]);
  assert.deepEqual([m.width, m.height], [480, 640]);
  const free = (await runJob('image-rotate', [await png()], { angle: 45, expand: true, fill: 'transparent' })).outputs[0];
  m = await meta(free);
  assert.ok(m.width > 200 && m.hasAlpha);
  const flipped = (await runJob('image-rotate', [await png()], { angle: 0, flipH: true, format: 'png' })).outputs[0];
  m = await meta(flipped);
  assert.deepEqual([m.width, m.height], [200, 120]);
});

test('watermark with text (tiled) and with a logo', async () => {
  const input = await plainJpg();
  const text = (await runJob('image-watermark', [input], { mode: 'text', text: 'SAMPLE', position: 'tiled', angle: -30, opacity: 50 })).outputs[0];
  assertMagic(text, 'jpg');
  const [a, b] = await Promise.all([sharp(input.data).raw().toBuffer(), sharp(text).raw().toBuffer()]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 97) diff += Math.abs(a[i] - b[i]);
  assert.ok(diff / (a.length / 97) > 2, 'watermark changed pixels');
  const logo = { name: '__wmlogo.png', data: await sharp(LOGO_SVG).png().toBuffer() };
  const { job, outputs } = await runJob('image-watermark', [input, logo], { mode: 'logo', position: 'br', scale: 20, opacity: 80 });
  assert.equal(outputs.length, 1, 'logo file is not watermarked itself');
  assert.equal(job.meta.files[0].output, 'plain-watermarked.jpg');
});

test('watermark in logo mode without a logo fails clearly', async () => {
  await assert.rejects(runJob('image-watermark', [await plainJpg()], { mode: 'logo' }), /logo/);
});

// ---------- sharp-based: favicon, svg-raster ----------

test('favicon set from SVG (ico, pngs, manifest, snippet)', async () => {
  const { job, outputs } = await runJob('favicon', [{ name: 'logo.svg', data: LOGO_SVG }], { shape: 'rounded', appName: 'Bridge', themeColor: '#2563eb' });
  const byName = Object.fromEntries(job.outputs.map((o, i) => [o.filename, outputs[i]]));
  assertMagic(byName['favicon.ico'], 'ico');
  assert.equal(byName['favicon.ico'].readUInt16LE(4), 3, 'ico has 3 sizes');
  for (const [n, s] of [['favicon-16x16.png', 16], ['favicon-32x32.png', 32], ['apple-touch-icon.png', 180], ['android-chrome-512x512.png', 512]]) {
    const m = await meta(byName[n]);
    assert.deepEqual([m.width, m.height], [s, s], n);
  }
  const apple = await sharp(byName['apple-touch-icon.png']).raw().toBuffer({ resolveWithObject: true });
  assert.equal(apple.data[3], 255, 'apple-touch-icon corner is opaque');
  assert.ok(byName['favicon.svg'], 'svg copied');
  const manifest = JSON.parse(byName['site.webmanifest'].toString());
  assert.equal(manifest.name, 'Bridge');
  assert.equal(manifest.theme_color, '#2563eb');
  assert.match(job.meta.html, /apple-touch-icon/);
  assert.match(byName['favicon-snippet.html'].toString(), /site\.webmanifest/);
});

test('favicon from PNG', async () => {
  const { outputs, job } = await runJob('favicon', [await png('logo.png')], { background: '#ffffff', padding: 10 });
  assert.ok(!job.outputs.some(o => o.filename === 'favicon.svg'));
  assertMagic(outputs[0], 'ico');
});

test('svg-raster renders crisp at the requested width', async () => {
  const { job, outputs } = await runJob('svg-raster', [{ name: 'logo.svg', data: LOGO_SVG }], { format: 'png', width: 512 });
  assertMagic(outputs[0], 'png');
  const m = await meta(outputs[0]);
  assert.deepEqual([m.width, m.height], [512, 512]);
  assert.equal(job.meta.files[0].density, 576);
  const jpgOut = (await runJob('svg-raster', [{ name: 'logo.svg', data: LOGO_SVG }], { format: 'jpg', width: 0, scale: 2, background: '#000000' })).outputs[0];
  assertMagic(jpgOut, 'jpg');
  assert.equal((await meta(jpgOut)).width, 128);
});

test('svg-raster rejects absurd sizes', async () => {
  await assert.rejects(runJob('svg-raster', [{ name: 'logo.svg', data: LOGO_SVG }], { width: 0, scale: 64, density: 0 }).then(async () => {
    // 64× of 64 px is 4096 — allowed; force a too-large one instead.
    await runJob('svg-raster', [{ name: 'big.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000"/>') }], { width: 0, scale: 64 });
  }), /16384|megapixels/);
});
