// Helpers for the /api/tools test suite. Tests are plain ESM run by run-all.mjs, which starts
// the unauthenticated tools dev server and sets TOOLS_URL.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { assert };
export const BASE = process.env.TOOLS_URL || 'http://127.0.0.1:4100';
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function parse(res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${typeof body === 'object' ? body.error : text.slice(0, 200)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  get: path => fetch(BASE + '/api/tools' + path).then(parse),
  post: (path, json) => fetch(BASE + '/api/tools' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json),
  }).then(parse),
  /** POST multipart; files = [{ name, data: Buffer|string, type? }] */
  postForm: (path, fields = {}, files = [], field = 'files') => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    for (const f of files) form.append(field, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name);
    return fetch(BASE + '/api/tools' + path, { method: 'POST', body: form }).then(parse);
  },
  raw: (path, init) => fetch(BASE + '/api/tools' + path, init),
};

/** Load a fixture from ./fixtures as { name, data }. */
export async function fixture(name) {
  return { name: basename(name), data: await readFile(join(FIXTURES, name)) };
}

/** Submit a converter job, wait for it, and return { job, outputs: Buffer[] }. Throws on job error. */
export async function runJob(converter, files, options = {}, { timeoutMs = 5 * 60_000 } = {}) {
  let job = await api.postForm('/jobs', { converter, options: JSON.stringify(options) }, files);
  const start = Date.now();
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() - start > timeoutMs) throw new Error(`job ${converter} timed out`);
    await new Promise(r => setTimeout(r, 300));
    job = await api.get('/jobs/' + job.id);
  }
  if (job.status !== 'done') throw new Error(`job ${converter} ${job.status}: ${job.error}`);
  const outputs = [];
  for (const o of job.outputs) {
    const res = await api.raw(`/jobs/${job.id}/files/${o.index}`);
    assert.equal(res.status, 200, `download output ${o.index}`);
    outputs.push(Buffer.from(await res.arrayBuffer()));
  }
  return { job, outputs };
}

/** Assert a buffer starts with the magic bytes of a format. */
export function assertMagic(buf, kind) {
  const hex = buf.subarray(0, 16).toString('hex');
  const ascii = buf.subarray(0, 16).toString('latin1');
  const checks = {
    pdf: () => ascii.startsWith('%PDF'),
    png: () => hex.startsWith('89504e47'),
    jpg: () => hex.startsWith('ffd8ff'),
    gif: () => ascii.startsWith('GIF8'),
    webp: () => ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP',
    avif: () => ascii.slice(4, 12) === 'ftypavif' || ascii.slice(4, 12) === 'ftypavis',
    heic: () => ascii.slice(4, 8) === 'ftyp' && /heic|heix|mif1|msf1/.test(ascii.slice(8, 12)),
    zip: () => hex.startsWith('504b0304'), // also docx/xlsx/pptx/odt
    ico: () => hex.startsWith('00000100'),
    mp3: () => ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2'),
    wav: () => ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE',
    ogg: () => ascii.startsWith('OggS'),
    flac: () => ascii.startsWith('fLaC'),
    mp4: () => ascii.slice(4, 8) === 'ftyp',
    webm: () => hex.startsWith('1a45dfa3'),
  };
  assert.ok(checks[kind], `unknown magic kind ${kind}`);
  assert.ok(checks[kind](), `expected ${kind}, got ${hex}`);
}

const registered = [];
/** Register a test: test('name', async () => { ... }) */
export function test(name, fn) { registered.push({ name, fn }); }
export function _registered() { return registered.splice(0); }
