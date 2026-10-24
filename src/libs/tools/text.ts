/**
 * @file tools/text.ts
 * @description Text, data and AI/LLM endpoints for the Dev Tools panel.
 *
 *  POST /api/tools/text/grammar      LanguageTool proxy (normalised matches)
 *  POST /api/tools/text/similarity   shingle Jaccard + TF-IDF cosine + shared passages
 *  POST /api/tools/ai/tokens         exact OpenAI token counts (gpt-tokenizer) + labelled estimates
 *  POST /api/tools/ai/chunk          RAG chunking (fixed / sentence / paragraph / recursive / token)
 *  POST /api/tools/ai/embeddings     Gemini embeddings + cosine similarity matrix
 *  converter `sheet-to-data`         spreadsheet (xlsx/xls/ods/csv/…) → per-sheet JSON / CSV
 */

import { promises as fs } from 'fs';
import { extname, join } from 'path';
import * as XLSX from 'xlsx';
import { GoogleGenAI } from '@google/genai';
import { HttpError, readJson, sendJson, str, type ToolRoute } from './http';
import type { ConverterSpec, JobOutput } from './jobs';

// ───────────────────────────── helpers ─────────────────────────────

function int(v: unknown, def: number, min: number, max: number): number {
  const n = v === undefined || v === null || v === '' ? def : Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, 'Expected a number');
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ───────────────────────────── tokenizers ─────────────────────────────

type Encoder = {
  encode: (text: string, opts?: object) => number[];
  decode: (tokens: number[]) => string;
  countTokens: (text: string, opts?: object) => number;
};

export const ENCODINGS = {
  o200k_base: 'GPT-4o / 4.1 / o-series / GPT-5',
  cl100k_base: 'GPT-4 / GPT-3.5-turbo / text-embedding-3',
  p50k_base: 'Codex / text-davinci-002/003',
  r50k_base: 'GPT-3 (davinci)',
} as const;
type EncodingName = keyof typeof ENCODINGS;

const encoderCache = new Map<EncodingName, Encoder>();
function encoder(name: EncodingName): Encoder {
  let e = encoderCache.get(name);
  if (!e) {
    // Per-encoding entry points keep memory down (each BPE table is several MB).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    e = require(`gpt-tokenizer/cjs/encoding/${name}`) as Encoder;
    encoderCache.set(name, e);
  }
  return e;
}

/** Treat special-token strings like `<|endoftext|>` as plain text instead of throwing. */
const PLAIN = { disallowedSpecial: new Set<string>() };

export const countTokens = (text: string, enc: EncodingName = 'o200k_base') => encoder(enc).countTokens(text, PLAIN);

/**
 * Split a token list into display pieces. Tokens that end in the middle of a multi-byte
 * character are grouped with the following token(s) so every piece decodes cleanly.
 */
function tokenPieces(enc: Encoder, tokens: number[]): { text: string; ids: number[] }[] {
  const pieces: { text: string; ids: number[] }[] = [];
  let pending: number[] = [];
  for (const t of tokens) {
    pending.push(t);
    const s = enc.decode(pending);
    if (s.endsWith('�') && pending.length < 4) continue;
    pieces.push({ text: s, ids: pending });
    pending = [];
  }
  if (pending.length) pieces.push({ text: enc.decode(pending), ids: pending });
  return pieces;
}

/** Character offset after each token (end boundaries), handling split multi-byte characters. */
function tokenBoundaries(text: string): number[] {
  const enc = encoder('o200k_base');
  const tokens = enc.encode(text, PLAIN);
  const ends: number[] = [];
  let pos = 0;
  for (const p of tokenPieces(enc, tokens)) {
    pos = Math.min(text.length, pos + p.text.length);
    for (let i = 0; i < p.ids.length; i++) ends.push(pos);
  }
  if (ends.length) ends[ends.length - 1] = text.length;
  return ends;
}

// ───────────────────────────── grammar (LanguageTool) ─────────────────────────────

const LT_URL = () => process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';

async function grammar(text: string, language: string) {
  const body = new URLSearchParams({ text, language });
  if (language === 'auto') body.set('preferredVariants', 'en-US,de-DE,pt-BR,ca-ES');
  let res: Response;
  try {
    res = await fetch(LT_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? 'LanguageTool timed out after 30s' : `Could not reach LanguageTool: ${(e as Error).message}`;
    throw new HttpError(502, msg);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new HttpError(res.status === 429 ? 429 : 502, `LanguageTool HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json() as any;
  const matches = (data.matches ?? []).map((m: any) => ({
    offset: Number(m.offset) || 0,
    length: Number(m.length) || 0,
    message: String(m.message ?? ''),
    shortMessage: String(m.shortMessage ?? ''),
    replacements: (m.replacements ?? []).slice(0, 5).map((r: any) => String(r.value ?? '')),
    context: m.context?.text ?? '',
    sentence: m.sentence ?? '',
    rule: {
      id: String(m.rule?.id ?? ''),
      description: String(m.rule?.description ?? ''),
      category: String(m.rule?.category?.name ?? m.rule?.category?.id ?? ''),
      categoryId: String(m.rule?.category?.id ?? ''),
    },
    issueType: String(m.rule?.issueType ?? 'other'),
  }));
  return {
    language: { name: data.language?.name ?? language, code: data.language?.code ?? language },
    detected: data.language?.detectedLanguage
      ? { name: data.language.detectedLanguage.name, code: data.language.detectedLanguage.code, confidence: data.language.detectedLanguage.confidence }
      : null,
    matches,
  };
}

// ───────────────────────────── similarity ─────────────────────────────

interface WordTok { w: string; start: number; end: number }

function words(text: string): WordTok[] {
  const out: WordTok[] = [];
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });
  return out;
}

export function similarity(a: string, b: string, n = 5) {
  const A = words(a);
  const B = words(b);
  const k = Math.max(1, Math.min(n, A.length, B.length) || 1);

  const shingles = (T: WordTok[]) => {
    const map = new Map<string, number[]>();
    for (let i = 0; i + k <= T.length; i++) {
      const key = T.slice(i, i + k).map(t => t.w).join(' ');
      const list = map.get(key);
      if (list) { if (list.length < 50) list.push(i); } else map.set(key, [i]);
    }
    return map;
  };
  const SA = shingles(A);
  const SB = shingles(B);
  let inter = 0;
  for (const key of SA.keys()) if (SB.has(key)) inter++;
  const union = SA.size + SB.size - inter;
  const jaccard = union ? inter / union : 0;

  // TF-IDF cosine over the two documents with smoothed IDF (so shared terms still count).
  const tf = (T: WordTok[]) => { const m = new Map<string, number>(); for (const t of T) m.set(t.w, (m.get(t.w) ?? 0) + 1); return m; };
  const ta = tf(A);
  const tb = tf(B);
  const idf = (w: string) => Math.log(3 / (1 + (ta.has(w) ? 1 : 0) + (tb.has(w) ? 1 : 0))) + 1;
  let dot = 0, na = 0, nb = 0;
  for (const [w, c] of ta) { const v = c * idf(w); na += v * v; const cb = tb.get(w); if (cb) dot += v * cb * idf(w); }
  for (const [w, c] of tb) { const v = c * idf(w); nb += v * v; }
  const cosine = na && nb ? dot / Math.sqrt(na * nb) : 0;

  // Shared passages: greedy maximal extension of matching shingles.
  const passages: { aStart: number; aEnd: number; bStart: number; bEnd: number; words: number; text: string }[] = [];
  const coveredB = new Uint8Array(B.length);
  let coveredA = 0;
  if (A.length >= k && B.length >= k) {
    let i = 0;
    while (i + k <= A.length) {
      const key = A.slice(i, i + k).map(t => t.w).join(' ');
      const cands = SB.get(key);
      if (!cands) { i++; continue; }
      let best = 0, bestJ = -1;
      for (const j of cands) {
        let L = k;
        while (i + L < A.length && j + L < B.length && A[i + L].w === B[j + L].w) L++;
        if (L > best) { best = L; bestJ = j; }
      }
      passages.push({
        aStart: A[i].start, aEnd: A[i + best - 1].end,
        bStart: B[bestJ].start, bEnd: B[bestJ + best - 1].end,
        words: best,
        text: a.slice(A[i].start, A[i + best - 1].end),
      });
      coveredA += best;
      for (let x = bestJ; x < bestJ + best; x++) coveredB[x] = 1;
      i += best;
    }
  }
  const bCovered = coveredB.reduce((s, v) => s + v, 0);
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return {
    shingleSize: k,
    words: { a: A.length, b: B.length, sharedVocabulary: [...ta.keys()].filter(w => tb.has(w)).length },
    jaccard: round(jaccard),
    cosine: round(cosine),
    aInB: round(A.length ? coveredA / A.length : 0),
    bInA: round(B.length ? bCovered / B.length : 0),
    passages: passages.sort((x, y) => x.aStart - y.aStart),
  };
}

// ───────────────────────────── chunking ─────────────────────────────

type Unit = 'chars' | 'tokens';
type Strategy = 'fixed' | 'sentence' | 'paragraph' | 'recursive' | 'token';
interface Span { start: number; end: number }

const LEVELS: Record<string, RegExp> = {
  paragraph: /\n[ \t]*\n\s*/g,
  line: /\n/g,
  sentence: /(?<=[.!?…。！？])["'”’)\]]*\s+/g,
  word: /\s+/g,
};

/** Split [start,end) after each separator match (separators stay with the left piece). */
function splitAt(text: string, s: Span, re: RegExp): Span[] {
  const out: Span[] = [];
  const sub = text.slice(s.start, s.end);
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sub))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const cut = m.index + m[0].length;
    if (cut > last && cut < sub.length) { out.push({ start: s.start + last, end: s.start + cut }); last = cut; }
  }
  out.push({ start: s.start + last, end: s.end });
  return out.filter(x => x.end > x.start);
}

export function chunkText(text: string, strategy: Strategy, size: number, overlap: number, unitIn: Unit) {
  const unit: Unit = strategy === 'token' ? 'tokens' : unitIn;
  const total = text.length;
  const boundaries = unit === 'tokens' ? tokenBoundaries(text) : null;
  const tokCache = new Map<string, number>();
  const measure = (s: Span) => {
    if (unit === 'chars') return s.end - s.start;
    const key = `${s.start}:${s.end}`;
    let v = tokCache.get(key);
    if (v === undefined) { v = countTokens(text.slice(s.start, s.end)); tokCache.set(key, v); }
    return v;
  };

  /** Hard split a span into windows of `size` units (no overlap — packing adds overlap). */
  const hardSplit = (s: Span): Span[] => {
    const out: Span[] = [];
    if (unit === 'chars') {
      for (let p = s.start; p < s.end; p += size) out.push({ start: p, end: Math.min(s.end, p + size) });
      return out;
    }
    let p = s.start;
    while (p < s.end) {
      let lo = p + 1, hi = s.end;
      // binary search the longest end with ≤ size tokens
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (countTokens(text.slice(p, mid)) <= size) lo = mid; else hi = mid - 1; }
      out.push({ start: p, end: lo });
      p = lo;
    }
    return out;
  };

  let chunks: Span[] = [];
  if (strategy === 'fixed' || strategy === 'token') {
    const step = Math.max(1, size - overlap);
    if (unit === 'chars') {
      for (let p = 0; p < total; p += step) {
        chunks.push({ start: p, end: Math.min(total, p + size) });
        if (p + size >= total) break;
      }
    } else {
      const ends = boundaries!;
      const n = ends.length;
      for (let t = 0; t < n; t += step) {
        const startChar = t === 0 ? 0 : ends[t - 1];
        const endTok = Math.min(n, t + size);
        chunks.push({ start: startChar, end: ends[endTok - 1] });
        if (endTok >= n) break;
      }
    }
  } else {
    // Split down to at least `minLevel`, then further only while a piece is still too big.
    const order = strategy === 'recursive' ? ['paragraph', 'line', 'sentence', 'word'] : ['paragraph', 'sentence', 'word'];
    const minLevel = strategy === 'sentence' ? 1 : 0;
    const segs: Span[] = [];
    const segment = (s: Span, level: number) => {
      if (level >= order.length) { segs.push(...hardSplit(s)); return; }
      for (const piece of splitAt(text, s, LEVELS[order[level]])) {
        if (level < minLevel) segment(piece, level + 1);
        else if (measure(piece) <= size) segs.push(piece);
        else segment(piece, level + 1);
      }
    };
    if (total) segment({ start: 0, end: total }, 0);
    let i = 0;
    while (i < segs.length) {
      let used = 0;
      let j = i;
      while (j < segs.length && (j === i || used + measure(segs[j]) <= size)) { used += measure(segs[j]); j++; }
      chunks.push({ start: segs[i].start, end: segs[j - 1].end });
      if (j >= segs.length) break;
      // Overlap: step back over whole trailing segments totalling ≤ overlap.
      let back = j, ov = 0;
      while (overlap > 0 && back - 1 > i && ov + measure(segs[back - 1]) <= overlap) { ov += measure(segs[back - 1]); back--; }
      i = back;
    }
  }

  if (chunks.length > 10_000) throw new HttpError(400, `That would produce ${chunks.length} chunks — increase the chunk size`);
  return {
    strategy, unit, size, overlap,
    totalChars: total,
    totalTokens: boundaries ? boundaries.length : countTokens(text),
    chunks: chunks.map((c, index) => {
      const t = text.slice(c.start, c.end);
      return { index, start: c.start, end: c.end, chars: t.length, tokens: countTokens(t), text: t };
    }),
  };
}

// ───────────────────────────── embeddings (Gemini) ─────────────────────────────

function geminiKeys(): string[] {
  return (process.env.GEMINI_API_KEY || process.env.GEMINI_AI_API_KEY || '')
    .split(',').map(k => k.replace(/['"]/g, '').trim()).filter(Boolean);
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const TASK_TYPES = ['SEMANTIC_SIMILARITY', 'RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY', 'CLASSIFICATION', 'CLUSTERING', 'QUESTION_ANSWERING', 'FACT_VERIFICATION', 'CODE_RETRIEVAL_QUERY'];

async function embed(texts: string[], model: string, dimensions: number, taskType: string) {
  const keys = geminiKeys();
  if (!keys.length) throw new HttpError(503, 'Embeddings need a Gemini API key — set GEMINI_API_KEY (or GEMINI_AI_API_KEY) on the server.');
  let lastErr: any;
  for (const apiKey of keys.slice(0, 4)) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const res = await Promise.race([
        ai.models.embedContent({ model, contents: texts, config: { outputDimensionality: dimensions, taskType } }),
        new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error('Gemini timed out after 45s'), { status: 504 })), 45_000)),
      ]);
      const vectors = (res.embeddings ?? []).map(e => e.values ?? []);
      if (vectors.length !== texts.length) throw new Error(`Gemini returned ${vectors.length} embeddings for ${texts.length} texts`);
      return vectors;
    } catch (e) {
      lastErr = e;
      const status = Number((e as any).status);
      // Bad requests won't succeed with another key.
      if (status === 400 || status === 404) break;
    }
  }
  const status = Number(lastErr?.status);
  const msg = String(lastErr?.message || lastErr).slice(0, 400);
  throw new HttpError(status === 429 ? 429 : status === 400 || status === 404 ? 400 : 502, `Gemini embeddings failed: ${msg}`);
}

// ───────────────────────────── routes ─────────────────────────────

export const routes: ToolRoute[] = [
  {
    method: 'POST', path: '/api/tools/text/grammar',
    handler: async ({ req, res }) => {
      const body = await readJson(req, 256 * 1024);
      const text = str(body.text, 'text', { max: 20_000 });
      const language = str(body.language, 'language', { required: false, max: 20 }) || 'auto';
      if (!/^(auto|[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*)$/.test(language)) throw new HttpError(400, 'Invalid language code');
      sendJson(res, await grammar(text, language));
    },
  },
  {
    method: 'POST', path: '/api/tools/text/similarity',
    handler: async ({ req, res }) => {
      const body = await readJson(req, 2 * 1024 * 1024);
      const a = str(body.a, 'a', { max: 300_000 });
      const b = str(body.b, 'b', { max: 300_000 });
      const n = int(body.n, 5, 2, 15);
      sendJson(res, similarity(a, b, n));
    },
  },
  {
    method: 'POST', path: '/api/tools/ai/tokens',
    handler: async ({ req, res }) => {
      const body = await readJson(req, 6 * 1024 * 1024);
      const text = typeof body.text === 'string' ? body.text : '';
      if (text.length > 2 * 1024 * 1024) throw new HttpError(413, 'Text is limited to 2 MB');
      const requested: string[] = Array.isArray(body.encodings) && body.encodings.length ? body.encodings.map(String) : ['o200k_base', 'cl100k_base'];
      for (const e of requested) if (!(e in ENCODINGS)) throw new HttpError(400, `Unknown encoding "${e}"`);
      const maxPieces = int(body.maxPieces, 2000, 0, 5000);
      const vizEnc = (requested.includes(String(body.visualize)) ? String(body.visualize) : requested[0]) as EncodingName;

      const counts: Record<string, { label: string; tokens: number }> = {};
      let pieces: { text: string; ids: number[] }[] = [];
      for (const e of requested as EncodingName[]) {
        const enc = encoder(e);
        if (e === vizEnc) {
          const toks = enc.encode(text, PLAIN);
          counts[e] = { label: ENCODINGS[e], tokens: toks.length };
          pieces = tokenPieces(enc, toks.slice(0, maxPieces));
        } else {
          counts[e] = { label: ENCODINGS[e], tokens: enc.countTokens(text, PLAIN) };
        }
      }
      const chars = text.length;
      const graphemes = [...text].length;
      const wordCount = (text.match(/\S+/g) ?? []).length;
      const bytes = Buffer.byteLength(text, 'utf8');
      const nonAscii = bytes - chars > chars * 0.2;
      sendJson(res, {
        chars, codePoints: graphemes, words: wordCount, bytes, lines: text ? text.split('\n').length : 0,
        encodings: counts,
        estimates: {
          // Anthropic and Google tokenizers aren't public for offline use — these are heuristics.
          claude: { label: 'Claude (estimate)', tokens: Math.ceil(nonAscii ? bytes / 3 : chars / 3.5), method: nonAscii ? 'UTF-8 bytes ÷ 3' : 'characters ÷ 3.5' },
          gemini: { label: 'Gemini (estimate)', tokens: Math.ceil(nonAscii ? bytes / 3.5 : chars / 4), method: nonAscii ? 'UTF-8 bytes ÷ 3.5' : 'characters ÷ 4' },
        },
        visualized: { encoding: vizEnc, truncated: (counts[vizEnc]?.tokens ?? 0) > maxPieces, pieces },
      });
    },
  },
  {
    method: 'POST', path: '/api/tools/ai/chunk',
    handler: async ({ req, res }) => {
      const body = await readJson(req, 6 * 1024 * 1024);
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text) throw new HttpError(400, 'Missing "text"');
      if (text.length > 2 * 1024 * 1024) throw new HttpError(413, 'Text is limited to 2 MB');
      const strategy = String(body.strategy || 'recursive') as Strategy;
      if (!['fixed', 'sentence', 'paragraph', 'recursive', 'token'].includes(strategy)) throw new HttpError(400, 'Invalid strategy');
      const unit = (strategy === 'token' ? 'tokens' : String(body.unit || 'chars')) as Unit;
      if (unit !== 'chars' && unit !== 'tokens') throw new HttpError(400, 'Invalid unit');
      const size = int(body.size, unit === 'tokens' ? 256 : 1000, unit === 'tokens' ? 8 : 20, 100_000);
      const overlap = int(body.overlap, 0, 0, size - 1);
      sendJson(res, chunkText(text, strategy, size, overlap, unit));
    },
  },
  {
    method: 'POST', path: '/api/tools/ai/embeddings',
    handler: async ({ req, res }) => {
      const body = await readJson(req, 1024 * 1024);
      if (!Array.isArray(body.texts)) throw new HttpError(400, '"texts" must be an array of strings');
      const texts = body.texts.map((t: unknown) => String(t ?? '').trim()).filter(Boolean) as string[];
      if (!texts.length) throw new HttpError(400, 'Provide at least one non-empty text');
      if (texts.length > 20) throw new HttpError(400, 'At most 20 texts per request');
      if (texts.some(t => t.length > 10_000)) throw new HttpError(400, 'Each text is limited to 10,000 characters');
      const model = str(body.model, 'model', { required: false, max: 80 }) || 'gemini-embedding-001';
      if (!/^[\w.\-/]+$/.test(model)) throw new HttpError(400, 'Invalid model');
      const dimensions = int(body.dimensions, 768, 32, 3072);
      const taskType = String(body.taskType || 'SEMANTIC_SIMILARITY');
      if (!TASK_TYPES.includes(taskType)) throw new HttpError(400, 'Invalid taskType');
      const vectors = await embed(texts, model, dimensions, taskType);
      const matrix = vectors.map(a => vectors.map(b => Math.round(cosineSim(a, b) * 10000) / 10000));
      sendJson(res, {
        model, taskType, dimensions: vectors[0]?.length ?? 0,
        embeddings: vectors.map((v, i) => ({ text: texts[i], norm: Math.sqrt(v.reduce((s, x) => s + x * x, 0)), values: v })),
        similarity: matrix,
      });
    },
  },
];

// ───────────────────────────── spreadsheet → data ─────────────────────────────

const SHEET_INPUTS = ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'fods', 'csv', 'tsv', 'txt', 'numbers'];

function safePart(s: string) {
  return s.replace(/[^\w.\- ()]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'sheet';
}

export const converters: ConverterSpec[] = [
  {
    id: 'sheet-to-data',
    label: 'Convert sheets to JSON / CSV',
    group: 'spreadsheet',
    inputs: SHEET_INPUTS,
    output: 'json / csv',
    minFiles: 1,
    maxFiles: 10,
    timeoutMs: 5 * 60_000,
    options: [
      { key: 'output', label: 'Output', type: 'select', default: 'json', choices: [
        { value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }, { value: 'both', label: 'JSON + CSV' },
      ] },
      { key: 'header', label: 'First row is a header (JSON objects)', type: 'boolean', default: true },
      { key: 'sheets', label: 'Sheets', type: 'text', default: '', placeholder: 'All sheets — or e.g. Sales, Q2', help: 'Comma-separated sheet names; leave empty for every sheet.' },
      { key: 'values', label: 'Cell values', type: 'select', default: 'raw', choices: [
        { value: 'raw', label: 'Raw (numbers, booleans, ISO dates)' }, { value: 'formatted', label: 'As displayed (formatted text)' },
      ] },
      { key: 'skipEmpty', label: 'Skip empty rows', type: 'boolean', default: true },
    ],
    run: async ({ inputs, options, workDir, progress, signal }) => {
      const outputs: JobOutput[] = [];
      const wanted = String(options.sheets || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const header = !!options.header;
      const raw = options.values !== 'formatted';
      const used = new Set<string>();
      const files: any[] = [];

      for (const [fi, input] of inputs.entries()) {
        if (signal.aborted) throw new Error('Cancelled');
        progress((fi / inputs.length) * 100, `Reading ${input.filename}`);
        const ext = extname(input.filename).slice(1).toLowerCase();
        const buf = await fs.readFile(input.path);
        let wb: XLSX.WorkBook;
        try {
          if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
            const textIn = buf.toString('utf8').replace(/^﻿/, '');
            wb = XLSX.read(textIn, { type: 'string', cellDates: true, raw: false, ...(ext === 'tsv' ? { FS: '\t' } as any : {}) });
          } else {
            wb = XLSX.read(buf, { type: 'buffer', cellDates: true, dense: true } as any);
          }
        } catch (e) {
          throw new Error(`${input.filename}: could not read spreadsheet (${(e as Error).message})`);
        }
        const stem = input.filename.slice(0, input.filename.length - extname(input.filename).length) || 'sheet';
        const names = wb.SheetNames.filter(n => !wanted.length || wanted.includes(n.toLowerCase()));
        if (!names.length) throw new Error(`${input.filename}: no sheet named ${wanted.join(', ')} (has: ${wb.SheetNames.join(', ')})`);

        const sheets: any[] = [];
        for (const name of names.slice(0, 100)) {
          const ws = wb.Sheets[name];
          const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw, defval: null, blankrows: !options.skipEmpty, dateNF: 'yyyy-mm-dd hh:mm:ss' });
          const cols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
          const norm = (v: unknown) => v instanceof Date ? (Number.isNaN(v.getTime()) ? null : v.toISOString()) : v;
          const rowsAoa = aoa.map(r => Array.from({ length: cols }, (_, i) => norm(r[i] ?? null)));

          // Headers: blank / duplicate header cells get unique names.
          let headers: string[] = [];
          if (header && rowsAoa.length) {
            const seen = new Map<string, number>();
            headers = rowsAoa[0].map((h, i) => {
              let k = h === null || h === '' ? `column_${i + 1}` : String(h).trim();
              const c = seen.get(k) ?? 0;
              seen.set(k, c + 1);
              if (c) k = `${k}_${c + 1}`;
              return k;
            });
          }
          const body = header ? rowsAoa.slice(1) : rowsAoa;
          const json = header ? body.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]]))) : body;

          let base = `${stem}${wb.SheetNames.length > 1 || names.length > 1 ? '-' + safePart(name) : ''}`;
          while (used.has(base.toLowerCase())) base += '_';
          used.add(base.toLowerCase());

          const outIdx: { json?: number; csv?: number } = {};
          if (options.output === 'json' || options.output === 'both') {
            const p = join(workDir, `${base}.json`);
            await fs.writeFile(p, JSON.stringify(json, null, 2));
            outIdx.json = outputs.push({ path: p, filename: `${base}.json`, mimeType: 'application/json' }) - 1;
          }
          if (options.output === 'csv' || options.output === 'both') {
            const csvSheet = XLSX.utils.aoa_to_sheet(rowsAoa.map(r => r.map(v => v === null ? '' : v)) as any[][]);
            const csv = XLSX.utils.sheet_to_csv(csvSheet, { blankrows: !options.skipEmpty });
            const p = join(workDir, `${base}.csv`);
            await fs.writeFile(p, '﻿' + csv);
            outIdx.csv = outputs.push({ path: p, filename: `${base}.csv`, mimeType: 'text/csv' }) - 1;
          }
          sheets.push({
            name,
            rows: body.length,
            cols,
            headers: header ? headers : Array.from({ length: cols }, (_, i) => XLSX.utils.encode_col(i)),
            preview: body.slice(0, 50),
            outputs: outIdx,
          });
        }
        files.push({ file: input.filename, sheetNames: wb.SheetNames, sheets });
      }
      progress(99, 'Done');
      return { outputs, meta: { header, files } };
    },
  },
];
