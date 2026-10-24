// Tests for src/libs/tools/text.ts — text, AI/LLM and spreadsheet → data endpoints.
import { createRequire } from 'node:module';
import { api, assert, runJob, test } from './lib.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

// ─── grammar ───────────────────────────────────────────────────────────────

test('grammar: validates input', async () => {
  await assert.rejects(api.post('/text/grammar', {}), /400/);
  await assert.rejects(api.post('/text/grammar', { text: 'x'.repeat(20_001) }), /400/);
  await assert.rejects(api.post('/text/grammar', { text: 'hi', language: 'en; rm -rf' }), /400/);
});

test('grammar: finds and normalises issues (LanguageTool)', async () => {
  let r;
  try {
    r = await api.post('/text/grammar', { text: 'This are a sentence with a speling mistake.', language: 'en-US' });
  } catch (e) {
    // The public API is rate-limited / may be unreachable from CI — accept a clean upstream error.
    assert.ok([429, 502].includes(e.status), `unexpected ${e.message}`);
    console.log('      (LanguageTool unreachable — skipped content checks)');
    return;
  }
  assert.ok(Array.isArray(r.matches) && r.matches.length >= 1, 'expected matches');
  const m = r.matches.find(x => x.replacements.includes('spelling'));
  assert.ok(m, 'spelling suggestion');
  assert.equal('This are a sentence with a speling mistake.'.slice(m.offset, m.offset + m.length), 'speling');
  for (const x of r.matches) {
    assert.equal(typeof x.message, 'string');
    assert.ok(x.replacements.length <= 5);
    assert.equal(typeof x.rule.id, 'string');
    assert.equal(typeof x.issueType, 'string');
  }
});

// ─── similarity ────────────────────────────────────────────────────────────

test('similarity: identical texts score 1', async () => {
  const t = 'The quick brown fox jumps over the lazy dog near the quiet river bank today.';
  const r = await api.post('/text/similarity', { a: t, b: t });
  assert.equal(r.jaccard, 1);
  assert.ok(r.cosine > 0.999);
  assert.equal(r.aInB, 1);
  assert.equal(r.bInA, 1);
  assert.equal(r.passages.length, 1);
  assert.equal(r.passages[0].aStart, 0);
});

test('similarity: shared passage offsets point at the copied text in both docs', async () => {
  const shared = 'retrieval augmented generation combines a search index with a language model';
  const a = `Intro paragraph about cats and dogs. ${shared}. Unrelated closing words here.`;
  const b = `Totally different opening! Indeed, ${shared.toUpperCase()} — and then other stuff follows.`;
  const r = await api.post('/text/similarity', { a, b, n: 4 });
  assert.equal(r.shingleSize, 4);
  assert.ok(r.passages.length >= 1);
  const p = r.passages.reduce((x, y) => (y.words > x.words ? y : x));
  assert.equal(a.slice(p.aStart, p.aEnd), shared);
  assert.equal(b.slice(p.bStart, p.bEnd).toLowerCase(), shared);
  assert.equal(p.words, shared.split(' ').length);
  assert.ok(r.aInB > 0.4 && r.aInB < 1, `aInB ${r.aInB}`);
  assert.ok(r.jaccard > 0 && r.jaccard < 1);
});

test('similarity: unrelated texts score ~0', async () => {
  const r = await api.post('/text/similarity', { a: 'apples bananas cherries dates elderberries figs', b: 'kernel scheduler mutex interrupt pagefault syscall' });
  assert.equal(r.jaccard, 0);
  assert.equal(r.cosine, 0);
  assert.equal(r.passages.length, 0);
  await assert.rejects(api.post('/text/similarity', { a: 'x' }), /400/);
});

// ─── tokens ────────────────────────────────────────────────────────────────

test('tokens: exact counts for o200k / cl100k plus labelled estimates', async () => {
  const r = await api.post('/ai/tokens', { text: 'Hello world' });
  assert.equal(r.encodings.o200k_base.tokens, 2);
  assert.equal(r.encodings.cl100k_base.tokens, 2);
  assert.match(r.estimates.claude.label, /estimate/i);
  assert.match(r.estimates.gemini.label, /estimate/i);
  assert.ok(r.estimates.claude.tokens > 0);
  assert.equal(r.visualized.pieces.map(p => p.text).join(''), 'Hello world');
  assert.equal(r.chars, 11);
  assert.equal(r.words, 2);
});

test('tokens: special tokens are counted as text, multibyte pieces decode cleanly', async () => {
  const text = 'héllo 🌍 <|endoftext|> 日本語のテキスト';
  const r = await api.post('/ai/tokens', { text, encodings: ['o200k_base'] });
  assert.ok(r.encodings.o200k_base.tokens > 5);
  assert.equal(r.encodings.cl100k_base, undefined);
  const joined = r.visualized.pieces.map(p => p.text).join('');
  assert.equal(joined, text);
  assert.ok(!joined.includes('�'));
  const ids = r.visualized.pieces.flatMap(p => p.ids).length;
  assert.equal(ids, r.encodings.o200k_base.tokens);
});

test('tokens: visualisation is capped and flagged', async () => {
  const r = await api.post('/ai/tokens', { text: 'word '.repeat(5000), maxPieces: 100 });
  assert.ok(r.visualized.truncated);
  assert.equal(r.visualized.pieces.flatMap(p => p.ids).length, 100);
  await assert.rejects(api.post('/ai/tokens', { text: 'x', encodings: ['nope'] }), /400/);
});

// ─── chunking ──────────────────────────────────────────────────────────────

const DOC = [
  'Retrieval-augmented generation (RAG) grounds a model in your own data. It retrieves passages and adds them to the prompt.',
  'Chunking decides what a passage is. Chunks that are too small lose context! Chunks that are too large dilute relevance?',
  'Overlap repeats a little text between neighbours so that a fact split across a boundary still appears whole in one chunk.',
].join('\n\n');

function checkCoverage(r, text) {
  assert.ok(r.chunks.length >= 1);
  assert.equal(r.chunks[0].start, 0);
  assert.equal(r.chunks.at(-1).end, text.length);
  for (const [i, c] of r.chunks.entries()) {
    assert.equal(c.index, i);
    assert.equal(c.text, text.slice(c.start, c.end));
    assert.ok(c.tokens > 0);
    if (i) {
      assert.ok(c.start <= r.chunks[i - 1].end, 'no gaps');
      assert.ok(c.start > r.chunks[i - 1].start, 'progress');
    }
  }
}

test('chunk: fixed chars with overlap', async () => {
  const r = await api.post('/ai/chunk', { text: DOC, strategy: 'fixed', size: 100, overlap: 20, unit: 'chars' });
  checkCoverage(r, DOC);
  assert.ok(r.chunks.slice(0, -1).every(c => c.chars === 100));
  assert.equal(r.chunks[1].start, 80);
});

test('chunk: sentence strategy never cuts mid-sentence when sentences fit', async () => {
  const r = await api.post('/ai/chunk', { text: DOC, strategy: 'sentence', size: 130, overlap: 0, unit: 'chars' });
  checkCoverage(r, DOC);
  for (const c of r.chunks) {
    assert.ok(c.chars <= 130, `chunk ${c.index} has ${c.chars} chars`);
    assert.match(c.text.trimEnd(), /[.!?)]$/);
  }
});

test('chunk: paragraph and recursive respect size; token strategy counts tokens', async () => {
  for (const strategy of ['paragraph', 'recursive']) {
    const r = await api.post('/ai/chunk', { text: DOC, strategy, size: 150, overlap: 0, unit: 'chars' });
    checkCoverage(r, DOC);
    assert.ok(r.chunks.every(c => c.chars <= 150));
  }
  const t = await api.post('/ai/chunk', { text: DOC, strategy: 'token', size: 32, overlap: 8 });
  checkCoverage(t, DOC);
  assert.equal(t.unit, 'tokens');
  assert.ok(t.chunks.slice(0, -1).every(c => c.tokens >= 30 && c.tokens <= 34), t.chunks.map(c => c.tokens).join(','));
  const s = await api.post('/ai/chunk', { text: DOC, strategy: 'sentence', size: 40, overlap: 15, unit: 'tokens' });
  checkCoverage(s, DOC);
  assert.ok(s.chunks.every(c => c.tokens <= 44));
  await assert.rejects(api.post('/ai/chunk', { text: DOC, strategy: 'magic' }), /400/);
  await assert.rejects(api.post('/ai/chunk', { strategy: 'fixed' }), /400/);
});

// ─── embeddings ────────────────────────────────────────────────────────────

test('embeddings: validates input', async () => {
  await assert.rejects(api.post('/ai/embeddings', { texts: 'nope' }), /400/);
  await assert.rejects(api.post('/ai/embeddings', { texts: Array(21).fill('x') }), /400/);
  await assert.rejects(api.post('/ai/embeddings', { texts: ['a'], taskType: 'BAD' }), /400/);
});

test('embeddings: Gemini vectors + similarity matrix (or 503 without a key)', async () => {
  const texts = ['The cat sat on the mat.', 'A kitten is resting on a rug.', 'Quarterly revenue grew by 12 percent.'];
  let r;
  try {
    r = await api.post('/ai/embeddings', { texts, dimensions: 256 });
  } catch (e) {
    if (e.status === 503) { assert.match(e.message, /GEMINI_API_KEY/); console.log('      (no Gemini key — asserted 503)'); return; }
    throw e;
  }
  assert.equal(r.dimensions, 256);
  assert.equal(r.embeddings.length, 3);
  assert.equal(r.embeddings[0].values.length, 256);
  assert.equal(r.similarity.length, 3);
  assert.ok(Math.abs(r.similarity[0][0] - 1) < 1e-3);
  assert.equal(r.similarity[0][1], r.similarity[1][0]);
  assert.ok(r.similarity[0][1] > r.similarity[0][2], `cat/kitten ${r.similarity[0][1]} vs cat/revenue ${r.similarity[0][2]}`);
});

// ─── sheet-to-data ─────────────────────────────────────────────────────────

function buildWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Name', 'Qty', 'Price', 'Active', 'Name'],
    ['Widget', 3, 9.99, true, 'dup'],
    ['Gadget, "Pro"', 1, 120, false, 'dup2'],
    [],
    ['Ünïcödé 名前', 7, 0.5, true, null],
  ]), 'Sales');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['k', 'v'], ['a', 1], ['b', 2]]), 'Lookup');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('sheet-to-data: xlsx → JSON + CSV per sheet with meta preview', async () => {
  const { job, outputs } = await runJob('sheet-to-data', [{ name: 'book.xlsx', data: buildWorkbook() }], { output: 'both', header: true });
  assert.deepEqual(job.outputs.map(o => o.filename), ['book-Sales.json', 'book-Sales.csv', 'book-Lookup.json', 'book-Lookup.csv']);
  const sales = JSON.parse(outputs[0].toString('utf8'));
  assert.equal(sales.length, 3, 'blank row skipped');
  assert.deepEqual(Object.keys(sales[0]), ['Name', 'Qty', 'Price', 'Active', 'Name_2']);
  assert.equal(sales[0].Qty, 3);
  assert.equal(sales[0].Active, true);
  assert.equal(sales[2].Name, 'Ünïcödé 名前');
  const csv = outputs[1].toString('utf8');
  assert.ok(csv.startsWith('﻿Name,Qty'));
  assert.ok(csv.includes('"Gadget, ""Pro"""'));
  const meta = job.meta.files[0];
  assert.deepEqual(meta.sheetNames, ['Sales', 'Lookup']);
  assert.equal(meta.sheets[0].rows, 3);
  assert.equal(meta.sheets[0].cols, 5);
  assert.equal(meta.sheets[0].preview.length, 3);
  assert.deepEqual(meta.sheets[0].outputs, { json: 0, csv: 1 });
});

test('sheet-to-data: sheet selection, no header, CSV and TSV inputs', async () => {
  const one = await runJob('sheet-to-data', [{ name: 'book.xlsx', data: buildWorkbook() }], { output: 'json', header: false, sheets: 'lookup' });
  assert.equal(one.job.outputs.length, 1);
  assert.deepEqual(JSON.parse(one.outputs[0].toString()), [['k', 'v'], ['a', 1], ['b', 2]]);

  const csvIn = 'id,city\n1,Zürich\n2,"São Paulo, BR"\n';
  const c = await runJob('sheet-to-data', [{ name: 'cities.csv', data: Buffer.from(csvIn) }, { name: 't.tsv', data: Buffer.from('a\tb\n1\t2\n') }], { output: 'json' });
  assert.deepEqual(c.job.outputs.map(o => o.filename), ['cities.json', 't.json']);
  assert.deepEqual(JSON.parse(c.outputs[0].toString()), [{ id: 1, city: 'Zürich' }, { id: 2, city: 'São Paulo, BR' }]);
  assert.deepEqual(JSON.parse(c.outputs[1].toString()), [{ a: 1, b: 2 }]);

  await assert.rejects(runJob('sheet-to-data', [{ name: 'book.xlsx', data: buildWorkbook() }], { sheets: 'Missing' }), /no sheet named/);
  await assert.rejects(runJob('sheet-to-data', [{ name: 'x.pdf', data: Buffer.from('%PDF') }]), /400/);
});

test('sheet-to-data: ods round trip', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x', 'y'], [1, 2]]), 'Data');
  const ods = XLSX.write(wb, { type: 'buffer', bookType: 'ods' });
  const { outputs, job } = await runJob('sheet-to-data', [{ name: 'd.ods', data: ods }], { output: 'csv' });
  assert.equal(job.outputs[0].filename, 'd.csv');
  assert.equal(outputs[0].toString('utf8').replace(/^﻿/, '').trim(), 'x,y\n1,2');
});
