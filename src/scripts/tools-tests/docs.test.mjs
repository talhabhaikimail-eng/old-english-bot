// Files & Documents converters: LibreOffice, Chromium, PyMuPDF/Pillow and ffmpeg.
// Fixtures are generated on first run into fixtures/docs-gen/ (needs python + PyMuPDF + Pillow,
// ffmpeg and LibreOffice - the same things the converters need).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { api, assert, assertMagic, runJob, test, FIXTURES } from './lib.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const JSZip = require('jszip');

const GEN = join(FIXTURES, 'docs-gen');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const SOFFICE = process.platform === 'win32'
  ? ['C:\\Program Files\\LibreOffice\\program\\soffice.com'].find(existsSync) || 'soffice'
  : 'soffice';
const TMP = mkdtempSync(join(tmpdir(), 'docs-test-'));

const gen = name => ({ name, data: readFileSync(join(GEN, name)) });
const py = (code, ...args) => execFileSync(PY, ['-c', code, ...args], { encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
let tmpN = 0;
function tmpFile(buf, ext) {
  const p = join(TMP, `t${++tmpN}.${ext}`);
  writeFileSync(p, buf);
  return p;
}
/** Page count + full text of a PDF buffer via PyMuPDF. */
function pdfFacts(buf) {
  const out = py(`import sys, json, pymupdf
d = pymupdf.open(sys.argv[1])
print(json.dumps({"pages": d.page_count, "text": "\\n".join(p.get_text() for p in d), "toc": len(d.get_toc()),
  "size": [round(d[0].rect.width), round(d[0].rect.height)]}))`, tmpFile(buf, 'pdf'));
  return JSON.parse(out.trim().split('\n').pop());
}
function ffprobe(buf, ext) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', tmpFile(buf, ext)], { encoding: 'utf-8' });
  const j = JSON.parse(out);
  return {
    duration: Number(j.format.duration),
    format: j.format.format_name,
    v: j.streams.find(s => s.codec_type === 'video'),
    a: j.streams.find(s => s.codec_type === 'audio'),
  };
}
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: expected ~${expected}, got ${actual}`);

// ---------------------------------------------------------------- fixtures

test('generate fixtures', async () => {
  mkdirSync(GEN, { recursive: true });
  if (!existsSync(join(GEN, 'sample.pdf'))) {
    py(`import sys, os, io, random, pymupdf
from PIL import Image
out = sys.argv[1]
# 5-page text PDF
d = pymupdf.open()
for i in range(1, 6):
    p = d.new_page(width=595, height=842)
    p.insert_text((72, 100), f"Page {i} of the sample document", fontsize=18)
    p.insert_text((72, 140), "Left column", fontsize=11)
    p.insert_text((350, 140), "Right column", fontsize=11)
d.set_metadata({"title": "Sample", "author": "Tester"})
d.save(os.path.join(out, "sample.pdf"))
d.save(os.path.join(out, "encrypted.pdf"), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
# 2-page PDF with a big high-dpi photo-like image (compressible)
random.seed(1)
w, h = 2400, 1600
img = Image.radial_gradient("L").resize((w, h)).convert("RGB")
noise = Image.effect_noise((w, h), 40).convert("RGB")
img = Image.blend(img, noise, 0.35)
buf = io.BytesIO(); img.save(buf, format="JPEG", quality=97)
d = pymupdf.open()
for i in range(2):
    p = d.new_page(width=595, height=842)
    p.insert_image(pymupdf.Rect(72, 72, 72 + 288, 72 + 192), stream=buf.getvalue())
    p.insert_text((72, 320), f"Photo page {i + 1}", fontsize=14)
d.save(os.path.join(out, "photos.pdf"))
# Images: JPEG with EXIF (camera, GPS, orientation 6) + ICC, PNG with text, WebP with EXIF
from PIL import ImageCms
im = Image.new("RGB", (640, 400), (200, 60, 40))
for x in range(0, 640, 40):
    for y in range(0, 400, 40):
        if (x // 40 + y // 40) % 2: im.paste((40, 90, 200), (x, y, x + 40, y + 40))
ex = Image.Exif()
ex[0x010F] = "TestCam"; ex[0x0110] = "Model X"; ex[0x0112] = 6; ex[0x0132] = "2024:05:01 10:00:00"
gps = {1: "N", 2: (51.0, 30.0, 0.0), 3: "W", 4: (0.0, 7.0, 0.0)}
ex[0x8825] = gps
icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
im.save(os.path.join(out, "photo.jpg"), format="JPEG", quality=90, exif=ex.tobytes(), icc_profile=icc)
from PIL import PngImagePlugin
meta = PngImagePlugin.PngInfo(); meta.add_text("Author", "Secret Person"); meta.add_text("Comment", "GPS 51.5 -0.12")
im.save(os.path.join(out, "photo.png"), pnginfo=meta)
im.save(os.path.join(out, "photo.webp"), format="WEBP", quality=80, exif=ex.tobytes())
im.resize((300, 500)).save(os.path.join(out, "tall.png"))
`, GEN);
  }
  if (!existsSync(join(GEN, 'book.xlsx'))) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'qty'], ['apple', 3], ['pear, green', 5]]), 'Fruit');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['city', 'pop'], ['Zürich', 421878], ['Oslo', 709037]]), 'Cities');
    XLSX.writeFile(wb, join(GEN, 'book.xlsx'));
    writeFileSync(join(GEN, 'data.csv'), 'id;label;price\n1;Widget;9.5\n2;Gadget;12\n');
    writeFileSync(join(GEN, 'doc.html'), `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>
<h1>Quarterly Report</h1><p>Hello <b>bold</b> world - unique marker ZEBRA42.</p><ul><li>One</li><li>Two</li></ul>
<table border="1"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>`);
    writeFileSync(join(GEN, 'notes.md'), '# Meeting Notes\n\nSome **bold** text and `code` - marker KIWI77.\n\n- item one\n- item two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  }
  if (!existsSync(join(GEN, 'slides.pptx'))) {
    // Build a 3-slide deck by importing a 3-page PDF into Impress.
    py(`import sys, pymupdf
d = pymupdf.open()
for i in range(1, 4):
    p = d.new_page(width=960, height=540)
    p.insert_text((80, 120), f"Slide {i} title", fontsize=36)
d.save(sys.argv[1])`, join(TMP, 'slides-src.pdf'));
    const profile = 'file:///' + join(TMP, 'lo-prof').replace(/\\/g, '/').replace(/^\//, '');
    execFileSync(SOFFICE, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--infilter=impress_pdf_import',
      '--convert-to', 'pptx:Impress MS PowerPoint 2007 XML', '--outdir', TMP, join(TMP, 'slides-src.pdf')], { stdio: 'ignore', timeout: 180_000 });
    writeFileSync(join(GEN, 'slides.pptx'), readFileSync(join(TMP, 'slides-src.pptx')));
  }
  if (!existsSync(join(GEN, 'clip.mp4'))) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(GEN, 'clip.mp4')]);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '2', join(GEN, 'tone.wav')]);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=20:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(GEN, 'long.mp4')]);
  }
  for (const f of ['sample.pdf', 'photos.pdf', 'encrypted.pdf', 'photo.jpg', 'book.xlsx', 'slides.pptx', 'clip.mp4', 'tone.wav']) {
    assert.ok(existsSync(join(GEN, f)), `fixture ${f}`);
  }
});

test('capabilities: every docs converter is registered and available', async () => {
  const caps = await api.get('/capabilities');
  const ids = ['office-convert', 'html-to-pdf', 'pdf-merge', 'pdf-split', 'pdf-compress', 'pdf-to-image', 'pdf-text', 'images-to-pdf',
    'exif-strip', 'video-to-mp3', 'audio-convert', 'audio-cut', 'video-convert', 'video-to-gif'];
  for (const id of ids) {
    const c = caps.converters.find(x => x.id === id);
    assert.ok(c, `${id} registered`);
    assert.ok(c.available, `${id} available (missing: ${c.missing})`);
  }
  const fmts = await api.get('/files/formats');
  assert.equal(fmts.families.docx, 'document');
  assert.ok(fmts.targets.spreadsheet.includes('csv'));
  assert.ok(fmts.libreOffice);
});

// ---------------------------------------------------------------- LibreOffice

let docxBuf;
test('office: HTML → DOCX → PDF keeps the text', async () => {
  const { outputs, job } = await runJob('office-convert', [gen('doc.html')], { target: 'docx' });
  assertMagic(outputs[0], 'zip');
  assert.equal(job.outputs[0].filename, 'doc.docx');
  const zip = await JSZip.loadAsync(outputs[0]);
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('ZEBRA42'), 'docx contains marker');
  docxBuf = outputs[0];
  const pdf = await runJob('office-convert', [{ name: 'report.docx', data: docxBuf }], { target: 'pdf' });
  assertMagic(pdf.outputs[0], 'pdf');
  assert.equal(pdf.job.outputs[0].filename, 'report.pdf');
  const facts = pdfFacts(pdf.outputs[0]);
  assert.ok(facts.text.includes('ZEBRA42') && facts.text.includes('Quarterly Report'), 'pdf text');
});

test('office: DOCX → ODT, RTF, TXT, EPUB, PNG', async () => {
  const { outputs, job } = await runJob('office-convert', [{ name: 'r.docx', data: docxBuf }], { target: 'txt' });
  assert.ok(outputs[0].toString('utf-8').includes('ZEBRA42'));
  assert.equal(job.outputs[0].filename, 'r.txt');
  const odt = await runJob('office-convert', [{ name: 'r.docx', data: docxBuf }], { target: 'odt' });
  assertMagic(odt.outputs[0], 'zip');
  assert.ok(odt.outputs[0].includes(Buffer.from('application/vnd.oasis.opendocument.text')));
  const rtf = await runJob('office-convert', [{ name: 'r.docx', data: docxBuf }], { target: 'rtf' });
  assert.ok(rtf.outputs[0].toString('latin1').startsWith('{\\rtf'));
  const epub = await runJob('office-convert', [{ name: 'r.docx', data: docxBuf }], { target: 'epub' });
  assertMagic(epub.outputs[0], 'zip');
  assert.ok(epub.outputs[0].includes(Buffer.from('application/epub+zip')));
  const png = await runJob('office-convert', [{ name: 'r.docx', data: docxBuf }], { target: 'png' });
  assertMagic(png.outputs[0], 'png');
});

test('office: XLSX → CSV exports every sheet', async () => {
  const { outputs, job } = await runJob('office-convert', [gen('book.xlsx')], { target: 'csv' });
  assert.deepEqual(job.outputs.map(o => o.filename).sort(), ['book-Cities.csv', 'book-Fruit.csv']);
  const byName = Object.fromEntries(job.outputs.map((o, i) => [o.filename, outputs[i].toString('utf-8')]));
  assert.equal(byName['book-Fruit.csv'].trim().split(/\r?\n/).join('|'), 'name,qty|apple,3|"pear, green",5');
  assert.ok(byName['book-Cities.csv'].includes('Zürich,421878'), 'UTF-8 preserved');
});

test('office: XLSX → CSV single sheet by name, semicolon, BOM', async () => {
  const { outputs, job } = await runJob('office-convert', [gen('book.xlsx')], { target: 'csv', sheet: 'Cities', delimiter: 'semicolon', csvBom: true });
  assert.equal(job.outputs.length, 1);
  assert.equal(job.outputs[0].filename, 'book-Cities.csv');
  assert.deepEqual([...outputs[0].subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(outputs[0].toString('utf-8').includes('Oslo;709037'));
  const two = await runJob('office-convert', [gen('book.xlsx')], { target: 'csv', sheet: '2' });
  assert.equal(two.job.outputs.length, 1);
  assert.ok(two.outputs[0].toString('utf-8').startsWith('city,pop'));
  await assert.rejects(runJob('office-convert', [gen('book.xlsx')], { target: 'csv', sheet: 'Nope' }), /no sheet named "Nope".*Cities/);
});

test('office: CSV (semicolon, auto-detected) → XLSX', async () => {
  const { outputs } = await runJob('office-convert', [gen('data.csv')], { target: 'xlsx' });
  assertMagic(outputs[0], 'zip');
  const wb = XLSX.read(outputs[0]);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  assert.deepEqual(rows, [['id', 'label', 'price'], [1, 'Widget', 9.5], [2, 'Gadget', 12]]);
});

test('office: XLSX → PDF (one page per sheet) and → ODS', async () => {
  const { outputs } = await runJob('office-convert', [gen('book.xlsx')], { target: 'pdf', onePagePerSheet: true });
  const facts = pdfFacts(outputs[0]);
  assert.equal(facts.pages, 2);
  assert.ok(facts.text.includes('Oslo') && facts.text.includes('apple'));
  const ods = await runJob('office-convert', [gen('book.xlsx')], { target: 'ods' });
  assert.ok(ods.outputs[0].includes(Buffer.from('application/vnd.oasis.opendocument.spreadsheet')));
});

test('office: PPTX → PDF has one page per slide', async () => {
  const { outputs, job } = await runJob('office-convert', [gen('slides.pptx')], { target: 'pdf' });
  assert.equal(job.outputs[0].filename, 'slides.pdf');
  const facts = pdfFacts(outputs[0]);
  assert.equal(facts.pages, 3);
  assert.ok(facts.text.includes('Slide 2 title'));
});

test('office: PDF → DOCX (writer_pdf_import)', async () => {
  const { outputs, job } = await runJob('office-convert', [gen('sample.pdf')], { target: 'docx' });
  assert.equal(job.outputs[0].filename, 'sample.docx');
  const zip = await JSZip.loadAsync(outputs[0]);
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('Page 3 of the sample'), 'text carried over');
});

test('office: Markdown → PDF and batch of 3 files', async () => {
  const { outputs, job } = await runJob('office-convert', [gen('notes.md'), gen('doc.html'), { name: 'r.docx', data: docxBuf }], { target: 'pdf' });
  assert.deepEqual(job.outputs.map(o => o.filename), ['notes.pdf', 'doc.pdf', 'r.pdf']);
  outputs.forEach(b => assertMagic(b, 'pdf'));
  assert.ok(pdfFacts(outputs[0]).text.includes('KIWI77'));
  assert.equal(job.meta.files.length, 3);
});

test('office: unsupported pairs fail with a clear message', async () => {
  await assert.rejects(runJob('office-convert', [gen('book.xlsx')], { target: 'docx' }), /spreadsheets can't be converted to DOCX - choose one of PDF, XLSX/);
  await assert.rejects(runJob('office-convert', [gen('sample.pdf')], { target: 'xlsx' }), /PDFs can't be converted to XLSX/);
  await assert.rejects(api.postForm('/jobs', { converter: 'office-convert', options: '{}' }, [{ name: 'x.exe', data: 'MZ' }]), /400/);
});

test('office: cancelling a running job kills LibreOffice', async () => {
  const count = () => {
    try {
      const out = process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', 'IMAGENAME eq soffice.bin', '/FO', 'CSV', '/NH'], { encoding: 'utf-8' })
        : execFileSync('sh', ['-c', 'pgrep -f soffice.bin || true'], { encoding: 'utf-8' });
      return out.split('\n').filter(l => l.includes('soffice')).length;
    } catch { return 0; }
  };
  const before = count();
  const job = await api.postForm('/jobs', { converter: 'office-convert', options: JSON.stringify({ target: 'pdf' }) },
    [gen('slides.pptx'), gen('book.xlsx'), { name: 'r.docx', data: docxBuf }]);
  for (let i = 0; i < 50; i++) {
    const j = await api.get('/jobs/' + job.id);
    if (j.status === 'running') break;
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 1500));
  const del = await api.raw('/jobs/' + job.id, { method: 'DELETE' });
  assert.equal(del.status, 200);
  let after = count();
  for (let i = 0; i < 30 && after > before; i++) { await new Promise(r => setTimeout(r, 300)); after = count(); }
  assert.ok(after <= before, `soffice.bin processes: before ${before}, after ${after}`);
});

// ---------------------------------------------------------------- HTML → PDF

test('html-to-pdf: HTML file with Chromium, options applied', async () => {
  const { outputs, job } = await runJob('html-to-pdf', [gen('doc.html')], { pageSize: 'Letter', landscape: true, pageNumbers: true, waitMs: 0 });
  assert.equal(job.meta.engine, 'chromium');
  const facts = pdfFacts(outputs[0]);
  assert.deepEqual(facts.size, [792, 612], 'Letter landscape');
  assert.ok(facts.text.includes('ZEBRA42'));
  assert.ok(/1\s*\/\s*1/.test(facts.text), 'page number footer');
});

test('html-to-pdf: Markdown upload is rendered (tables, bold)', async () => {
  const { outputs, job } = await runJob('html-to-pdf', [gen('notes.md')], { waitMs: 0 });
  assert.equal(job.outputs[0].filename, 'notes.pdf');
  const facts = pdfFacts(outputs[0]);
  near(facts.size[0], 595, 1, 'A4 width');
  near(facts.size[1], 842, 1, 'A4 height');
  assert.ok(facts.text.includes('Meeting Notes') && facts.text.includes('KIWI77') && !facts.text.includes('**'));
});

test('html-to-pdf: private network requests are blocked', async () => {
  const html = `<html><body><p>SSRF test</p><img src="http://127.0.0.1:${new URL(process.env.TOOLS_URL).port}/api/tools/capabilities">
<img src="http://169.254.169.254/latest/meta-data/"></body></html>`;
  const { job } = await runJob('html-to-pdf', [{ name: 'ssrf.html', data: html }], { waitMs: 0 });
  assert.ok(job.meta.blockedRequests.some(u => u.includes('127.0.0.1')), 'loopback blocked');
  assert.ok(job.meta.blockedRequests.some(u => u.includes('169.254.169.254')), 'metadata blocked');
  await assert.rejects(runJob('html-to-pdf', [], { url: 'http://127.0.0.1:8080/' }), /Blocked/);
  await assert.rejects(runJob('html-to-pdf', [], { url: 'http://localhost/' }), /Blocked/);
  await assert.rejects(runJob('html-to-pdf', [], { url: 'file:///etc/passwd' }), /http/);
});

test('html-to-pdf: LibreOffice engine fallback', async () => {
  const { outputs, job } = await runJob('html-to-pdf', [gen('doc.html')], { engine: 'libreoffice' });
  assert.equal(job.meta.engine, 'libreoffice');
  assert.ok(pdfFacts(outputs[0]).text.includes('ZEBRA42'));
});

test('html-to-pdf: public URL (skipped only when offline)', async () => {
  let res;
  try {
    res = await runJob('html-to-pdf', [], { url: 'example.com', waitMs: 0 });
  } catch (e) {
    if (/Could not load|ENOTFOUND|resolves to a private|net::ERR_/.test(String(e))) { console.log('      (offline - skipped: ' + String(e).slice(0, 200) + ')'); return; }
    throw e;
  }
  assert.equal(res.job.outputs[0].filename, 'example.com.pdf');
  const text = pdfFacts(res.outputs[0]).text;
  assert.ok(text.includes('documentation examples'), text.slice(0, 300));
});

// ---------------------------------------------------------------- PDF tools

test('pdf-info: pages, metadata, encryption', async () => {
  const info = await api.postForm('/files/pdf-info', {}, [gen('sample.pdf')], 'file');
  assert.equal(info.pages, 5);
  assert.equal(info.metadata.title, 'Sample');
  assert.equal(info.encrypted, false);
  assert.equal(info.pageSize.widthMm, 209.9);
  const enc = await api.postForm('/files/pdf-info', {}, [gen('encrypted.pdf')], 'file');
  assert.equal(enc.needsPassword, true);
  assert.equal(enc.unlocked, false);
  const ok = await api.postForm('/files/pdf-info', { password: 'secret' }, [gen('encrypted.pdf')], 'file');
  assert.equal(ok.pages, 5);
});

test('pdf-merge: pages in upload order with bookmarks', async () => {
  const { outputs, job } = await runJob('pdf-merge', [gen('photos.pdf'), gen('sample.pdf')], { outputName: 'combined' });
  assert.equal(job.outputs[0].filename, 'combined.pdf');
  const facts = pdfFacts(outputs[0]);
  assert.equal(facts.pages, 7);
  assert.equal(facts.toc, 2);
  assert.ok(facts.text.indexOf('Photo page 1') < facts.text.indexOf('Page 1 of the sample'), 'order kept');
  await assert.rejects(runJob('pdf-merge', [gen('sample.pdf'), gen('encrypted.pdf')]), /password-protected/);
  const withPw = await runJob('pdf-merge', [gen('sample.pdf'), gen('encrypted.pdf')], { password: 'secret', bookmarks: false });
  const f2 = pdfFacts(withPw.outputs[0]);
  assert.equal(f2.pages, 10);
  assert.equal(f2.toc, 0);
});

test('pdf-split: ranges, every N, each page, validation', async () => {
  const r = await runJob('pdf-split', [gen('sample.pdf')], { mode: 'ranges', ranges: '1-2, 4, 5-' });
  assert.deepEqual(r.job.outputs.map(o => o.filename), ['sample_p1-2.pdf', 'sample_p4.pdf', 'sample_p5.pdf']);
  assert.deepEqual(r.outputs.map(b => pdfFacts(b).pages), [2, 1, 1]);
  assert.ok(pdfFacts(r.outputs[1]).text.includes('Page 4'));
  const single = await runJob('pdf-split', [gen('sample.pdf')], { mode: 'ranges', ranges: '1,3,5', single: true });
  assert.equal(single.outputs.length, 1);
  assert.equal(pdfFacts(single.outputs[0]).pages, 3);
  const every = await runJob('pdf-split', [gen('sample.pdf')], { mode: 'every', every: 2 });
  assert.deepEqual(every.outputs.map(b => pdfFacts(b).pages), [2, 2, 1]);
  const each = await runJob('pdf-split', [gen('sample.pdf')], { mode: 'each' });
  assert.equal(each.outputs.length, 5);
  await assert.rejects(runJob('pdf-split', [gen('sample.pdf')], { mode: 'ranges', ranges: '7-9' }), /after the last page \(5\)/);
  await assert.rejects(runJob('pdf-split', [gen('sample.pdf')], { mode: 'ranges', ranges: '3-1' }), /backwards/);
  await assert.rejects(runJob('pdf-split', [gen('sample.pdf')], { mode: 'ranges', ranges: 'abc' }), /Invalid page range/);
  // Whole-job download is a zip of the parts.
  const res = await api.raw(`/jobs/${each.job.id}/download`);
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  assert.equal(Object.keys(zip.files).length, 5);
});

test('pdf-compress: screen preset shrinks image PDFs, never grows', async () => {
  const src = gen('photos.pdf');
  const { outputs, job } = await runJob('pdf-compress', [src], { preset: 'screen' });
  assert.ok(outputs[0].length < src.data.length * 0.5, `compressed ${src.data.length} → ${outputs[0].length}`);
  assert.equal(job.meta.files[0].recompressed, 1);
  assert.equal(job.meta.files[0].downsampled, 1);
  const facts = pdfFacts(outputs[0]);
  assert.equal(facts.pages, 2);
  assert.ok(facts.text.includes('Photo page 2'));
  // Image actually downsampled to ~72 dpi (4 in wide → ~288 px).
  const w = py(`import sys, pymupdf
d = pymupdf.open(sys.argv[1]); x = d[0].get_images()[0][0]; print(d.extract_image(x)["width"])`, tmpFile(outputs[0], 'pdf'));
  near(Number(w.trim()), 288, 4, 'image width');
  const ebook = await runJob('pdf-compress', [src], { preset: 'ebook' });
  assert.ok(ebook.outputs[0].length > outputs[0].length && ebook.outputs[0].length < src.data.length);
  const lossless = await runJob('pdf-compress', [gen('sample.pdf')], { preset: 'lossless' });
  assert.ok(lossless.outputs[0].length <= gen('sample.pdf').data.length);
  assert.ok(lossless.job.meta.after <= lossless.job.meta.before);
});

test('pdf-to-image: PNG at 72 dpi has page-sized pixels; JPG/WebP', async () => {
  const { outputs, job } = await runJob('pdf-to-image', [gen('sample.pdf')], { dpi: 72, pages: '2-3' });
  assert.deepEqual(job.outputs.map(o => o.filename), ['sample_p2.png', 'sample_p3.png']);
  assertMagic(outputs[0], 'png');
  assert.equal(outputs[0].readUInt32BE(16), 595);
  assert.equal(outputs[0].readUInt32BE(20), 842);
  const jpg = await runJob('pdf-to-image', [gen('sample.pdf')], { format: 'jpg', dpi: 100, pages: '1' });
  assertMagic(jpg.outputs[0], 'jpg');
  const webp = await runJob('pdf-to-image', [gen('sample.pdf')], { format: 'webp', pages: 'last' });
  assertMagic(webp.outputs[0], 'webp');
  assert.equal(webp.job.outputs[0].filename, 'sample_p5.webp');
});

test('pdf-text: plain + layout, separators, encrypted', async () => {
  const { outputs, job } = await runJob('pdf-text', [gen('sample.pdf')]);
  const txt = outputs[0].toString('utf-8');
  assert.ok(txt.includes('===== Page 3 =====') && txt.includes('Page 3 of the sample document'));
  assert.equal(job.meta.pages, 5);
  assert.ok(job.meta.chars > 100);
  const layout = await runJob('pdf-text', [gen('sample.pdf')], { mode: 'layout', separators: false, pages: '1' });
  const line = layout.outputs[0].toString('utf-8').split('\n').find(l => l.includes('Left column'));
  assert.ok(/Left column {10,}Right column/.test(line), `columns kept apart: "${line}"`);
  await assert.rejects(runJob('pdf-text', [gen('encrypted.pdf')]), /password-protected/);
  await assert.rejects(runJob('pdf-text', [gen('encrypted.pdf')], { password: 'nope' }), /wrong password/);
  const ok = await runJob('pdf-text', [gen('encrypted.pdf')], { password: 'secret' });
  assert.ok(ok.outputs[0].toString('utf-8').includes('Page 5'));
});

test('images-to-pdf: page per image, orientation, fit-to-image', async () => {
  const { outputs } = await runJob('images-to-pdf', [gen('photo.jpg'), gen('tall.png'), gen('photo.png')], { pageSize: 'a4', orientation: 'auto' });
  const facts = py(`import sys, json, pymupdf
d = pymupdf.open(sys.argv[1]); print(json.dumps([[round(p.rect.width), round(p.rect.height), len(p.get_images())] for p in d]))`, tmpFile(outputs[0], 'pdf'));
  // photo.jpg is 640x400 with EXIF orientation 6 → displayed portrait; photo.png is landscape.
  assert.deepEqual(JSON.parse(facts), [[595, 842, 1], [595, 842, 1], [842, 595, 1]], facts);
  const fit = await runJob('images-to-pdf', [gen('tall.png')], { pageSize: 'fit', margin: 0, outputName: 'one' });
  assert.equal(fit.job.outputs[0].filename, 'one.pdf');
  assert.deepEqual(pdfFacts(fit.outputs[0]).size, [225, 375], JSON.stringify(pdfFacts(fit.outputs[0]).size));
});

test('exif-strip: JPEG lossless (GPS/camera gone, orientation + ICC kept, pixels identical)', async () => {
  const src = gen('photo.jpg');
  const { outputs, job } = await runJob('exif-strip', [src, gen('photo.png'), gen('photo.webp')]);
  const meta = job.meta.files[0];
  assert.ok(meta.removed.includes('EXIF') && meta.removed.includes('GPS location'), JSON.stringify(meta.removed));
  assert.equal(meta.found.camera, 'TestCam Model X');
  assert.ok(meta.kept.includes('ICC colour profile'));
  const check = JSON.parse(py(`import sys, json
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]); b = Image.open(sys.argv[2])
ex = b.getexif()
print(json.dumps({"tags": sorted(ex.keys()), "gps": len(ex.get_ifd(0x8825)), "icc": bool(b.info.get("icc_profile")),
  "same": ImageChops.difference(a.convert("RGB"), b.convert("RGB")).getbbox() is None}))`, join(GEN, 'photo.jpg'), tmpFile(outputs[0], 'jpg')).trim());
  assert.deepEqual(check.tags, [0x0112], 'only orientation remains');
  assert.equal(check.gps, 0);
  assert.equal(check.icc, true);
  assert.equal(check.same, true, 'lossless');
  assert.ok(!outputs[0].includes(Buffer.from('TestCam')));
  // PNG text chunks and WebP EXIF removed.
  assert.ok(!outputs[1].includes(Buffer.from('Secret Person')));
  assert.ok(job.meta.files[1].removed.includes('Text chunks'));
  assert.ok(!outputs[2].includes(Buffer.from('TestCam')));
  assertMagic(outputs[2], 'webp');
  const webpOk = py(`import sys
from PIL import Image
im = Image.open(sys.argv[1]); im.load(); print(im.size, len(im.getexif()))`, tmpFile(outputs[2], 'webp')).trim();
  assert.equal(webpOk, '(640, 400) 0');
});

test('exif-strip: re-encode mode applies rotation; ICC can be dropped', async () => {
  const { outputs } = await runJob('exif-strip', [gen('photo.jpg')], { jpegMode: 'reencode', keepIcc: false });
  const r = py(`import sys
from PIL import Image
b = Image.open(sys.argv[1]); print(b.size, len(b.getexif()), bool(b.info.get("icc_profile")))`, tmpFile(outputs[0], 'jpg')).trim();
  assert.equal(r, '(400, 640) 0 False');
});

// ---------------------------------------------------------------- media

test('video-to-mp3: full and trimmed', async () => {
  const { outputs, job } = await runJob('video-to-mp3', [gen('clip.mp4')], { bitrate: '320' });
  assertMagic(outputs[0], 'mp3');
  assert.equal(job.outputs[0].filename, 'clip.mp3');
  const p = ffprobe(outputs[0], 'mp3');
  near(p.duration, 3, 0.15, 'duration');
  assert.equal(p.a.codec_name, 'mp3');
  assert.ok(!p.v, 'no video');
  near(Number(p.a.bit_rate) / 1000, 320, 5, 'bitrate');
  const trimmed = await runJob('video-to-mp3', [gen('clip.mp4')], { mode: 'vbr', vbr: '0', start: '0.5', end: '0:01.5' });
  near(ffprobe(trimmed.outputs[0], 'mp3').duration, 1, 0.1, 'trimmed duration');
  await assert.rejects(runJob('video-to-mp3', [gen('clip.mp4')], { start: '10' }), /after the end/);
});

test('audio-convert: flac / ogg / opus / m4a / wav with options', async () => {
  const cases = [
    ['flac', 'flac', 'flac'], ['ogg', 'vorbis', 'ogg'], ['opus', 'opus', 'ogg'], ['m4a', 'aac', 'mp4'], ['aac', 'aac', null], ['wav', 'pcm_s16le', 'wav'],
  ];
  for (const [format, codec, magic] of cases) {
    const { outputs, job } = await runJob('audio-convert', [gen('tone.wav')], { format });
    assert.equal(job.outputs[0].filename, `tone.${format}`);
    if (magic) assertMagic(outputs[0], magic);
    const p = ffprobe(outputs[0], format);
    assert.equal(p.a.codec_name, codec, format);
    near(p.duration, 3, 0.2, `${format} duration`);
  }
  const { outputs } = await runJob('audio-convert', [gen('tone.wav'), gen('clip.mp4')], { format: 'mp3', channels: 'mono', sampleRate: '22050', loudnorm: true, bitrate: '96' });
  assert.equal(outputs.length, 2);
  const p = ffprobe(outputs[0], 'mp3');
  assert.equal(p.a.channels, 1);
  assert.equal(Number(p.a.sample_rate), 22050);
});

test('audio-cut: exact length, fades, same format', async () => {
  const { outputs, job } = await runJob('audio-cut', [gen('tone.wav')], { start: '0.5', end: '2.0', fadeIn: 0.3, fadeOut: 0.3 });
  assert.equal(job.outputs[0].filename, 'tone_cut.wav');
  const p = ffprobe(outputs[0], 'wav');
  near(p.duration, 1.5, 0.02, 'cut length');
  // Fade-in: the first samples are near silent, the middle is loud.
  const pcm = outputs[0].subarray(outputs[0].indexOf(Buffer.from('data')) + 8);
  const rms = (from, n) => { let s = 0; for (let i = 0; i < n; i++) { const v = pcm.readInt16LE((from + i) * 4); s += v * v; } return Math.sqrt(s / n); };
  assert.ok(rms(0, 200) < rms(30000, 200) / 5, `fade in applied: ${rms(0, 200)} vs ${rms(30000, 200)}`);
  const mp3 = await runJob('audio-cut', [gen('tone.wav')], { start: '1', end: '', format: 'mp3' });
  near(ffprobe(mp3.outputs[0], 'mp3').duration, 2, 0.1, 'to end');
  await assert.rejects(runJob('audio-cut', [gen('tone.wav')], { start: '2', end: '1' }), /End must be after start/);
  await assert.rejects(runJob('audio-cut', [gen('tone.wav')], { start: 'abc' }), /Invalid start/);
});

test('video-convert: webm (vp9/opus), scale + fps, strip audio, target size', async () => {
  const webm = await runJob('video-convert', [gen('clip.mp4')], { format: 'webm', speed: 'fast' });
  assertMagic(webm.outputs[0], 'webm');
  const p = ffprobe(webm.outputs[0], 'webm');
  assert.equal(p.v.codec_name, 'vp9');
  assert.equal(p.a.codec_name, 'opus');
  const small = await runJob('video-convert', [gen('long.mp4')], { format: 'mp4', maxHeight: '360', fps: '15', stripAudio: true, speed: 'fast' });
  const q = ffprobe(small.outputs[0], 'mp4');
  assert.equal(q.v.height, 360);
  assert.equal(q.v.avg_frame_rate, '15/1');
  assert.ok(!q.a, 'audio removed');
  assert.ok(readFileSync(join(GEN, 'long.mp4')).subarray(0, 64).length);
  // moov atom first (faststart)
  assert.ok(small.outputs[0].indexOf(Buffer.from('moov')) < small.outputs[0].indexOf(Buffer.from('mdat')), 'faststart');
  const sized = await runJob('video-convert', [gen('long.mp4')], { format: 'mov', targetSizeMb: 1, speed: 'fast' });
  assert.ok(sized.outputs[0].length < 1.25 * 1024 * 1024, `target size: ${sized.outputs[0].length}`);
  await assert.rejects(runJob('video-convert', [gen('long.mp4')], { targetSizeMb: 0.01 }), /too small/);
  await assert.rejects(runJob('video-convert', [gen('tone.wav')]), /400|expected/);
});

test('video-to-gif: gif with palette, webp, mp4', async () => {
  const { outputs, job } = await runJob('video-to-gif', [gen('clip.mp4')], { start: '0.5', duration: 2, fps: 10, width: 200 });
  assertMagic(outputs[0], 'gif');
  assert.equal(job.outputs[0].filename, 'clip.gif');
  assert.equal(outputs[0].readUInt16LE(6), 200, 'gif width');
  const frames = py(`import sys
from PIL import Image
im = Image.open(sys.argv[1]); print(im.n_frames, im.info.get("loop"))`, tmpFile(outputs[0], 'gif')).trim().split(' ');
  near(Number(frames[0]), 20, 2, 'frame count');
  assert.equal(frames[1], '0', 'loops forever');
  const webp = await runJob('video-to-gif', [gen('clip.mp4')], { format: 'webp', duration: 1 });
  assertMagic(webp.outputs[0], 'webp');
  const mp4 = await runJob('video-to-gif', [gen('clip.mp4')], { format: 'mp4', duration: 1.5 });
  near(ffprobe(mp4.outputs[0], 'mp4').duration, 1.5, 0.15, 'clip length');
});

test('media: cancelling stops ffmpeg', async () => {
  const job = await api.postForm('/jobs', { converter: 'video-convert', options: JSON.stringify({ format: 'webm', speed: 'small', quality: 'high' }) }, [gen('long.mp4')]);
  for (let i = 0; i < 50; i++) {
    const j = await api.get('/jobs/' + job.id);
    if (j.status === 'running') break;
    await new Promise(r => setTimeout(r, 100));
  }
  const del = await api.raw('/jobs/' + job.id, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await api.raw('/jobs/' + job.id)).status, 404);
});

test('cleanup temp files', async () => {
  rmSync(TMP, { recursive: true, force: true });
});
