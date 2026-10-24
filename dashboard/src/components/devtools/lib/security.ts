// Pure helpers for the Security dev tools (no React, no `@/` imports — unit-tested with tsx).
// All randomness comes from crypto.getRandomValues with rejection sampling (no modulo bias).

import { COMMON_NAMES, COMMON_PASSWORDS, KEYBOARD_ROWS, KEYBOARD_WALKS, WORDLIST } from './security-words';

// ── secure random primitives ─────────────────────────────────────────────────

const u32 = new Uint32Array(64);
let u32Pos = u32.length;

export function randomUint32(): number {
  if (u32Pos >= u32.length) { globalThis.crypto.getRandomValues(u32); u32Pos = 0; }
  return u32[u32Pos++];
}

const TWO32 = 2 ** 32;
const TWO53 = 2 ** 53;

/** Uniform integer in [0, n) for 1 ≤ n ≤ 2^53, by rejection sampling. */
export function randomBelow(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO53) throw new RangeError('randomBelow: n must be an integer in [1, 2^53]');
  if (n === 1) return 0;
  if (n <= TWO32) {
    const limit = TWO32 - (TWO32 % n);
    for (;;) { const r = randomUint32(); if (r < limit) return r % n; }
  }
  const limit = TWO53 - (TWO53 % n);
  for (;;) {
    const r = (randomUint32() & 0x1fffff) * TWO32 + randomUint32(); // 53 random bits
    if (r < limit) return r % n;
  }
}

/** Uniform integer in [min, max] (inclusive). */
export function randomInt(min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw new RangeError('Bounds must be safe integers');
  if (min > max) [min, max] = [max, min];
  return min + randomBelow(max - min + 1);
}

/** Uniform float in [0, 1) with 53 bits of randomness. */
export function randomUnit(): number {
  return ((randomUint32() & 0x1fffff) * TWO32 + randomUint32()) / TWO53;
}

/** Uniform decimal in [min, max] with `decimals` places (every representable value equally likely). */
export function randomDecimal(min: number, max: number, decimals: number): number {
  if (min > max) [min, max] = [max, min];
  const f = 10 ** decimals;
  const lo = Math.ceil(min * f);
  const hi = Math.floor(max * f);
  if (hi - lo + 1 > TWO53 || !Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) throw new RangeError('Range × precision is too large');
  return (lo + randomBelow(hi - lo + 1)) / f;
}

export function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** `count` distinct integers from [min, max]. */
export function uniqueInts(min: number, max: number, count: number): number[] {
  if (min > max) [min, max] = [max, min];
  const range = max - min + 1;
  if (count > range) throw new RangeError(`Only ${range} distinct values exist in [${min}, ${max}]`);
  if (range <= 100_000 && count * 3 > range) {
    // Dense: partial Fisher–Yates over the whole range.
    const a = Array.from({ length: range }, (_, i) => min + i);
    for (let i = 0; i < count; i++) {
      const j = i + randomBelow(range - i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, count);
  }
  const seen = new Set<number>();
  const out: number[] = [];
  while (out.length < count) {
    const v = randomInt(min, max);
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

export function pick<T>(items: readonly T[], count: number, unique: boolean): T[] {
  if (!items.length) return [];
  if (unique) return shuffle(items).slice(0, Math.min(count, items.length));
  return Array.from({ length: count }, () => items[randomBelow(items.length)]);
}

// ── dice ─────────────────────────────────────────────────────────────────────

export type DiceTerm =
  | { kind: 'dice'; sign: 1 | -1; count: number; sides: number; mod?: { op: 'kh' | 'kl' | 'dh' | 'dl'; n: number }; text: string }
  | { kind: 'const'; sign: 1 | -1; value: number; text: string };

/** Parse dice notation: "3d6+2", "2d20kh1", "4d6dl1", "d%", "1d8+1d6-1". */
export function parseDice(expr: string): DiceTerm[] | { error: string } {
  const s = expr.replace(/\s+/g, '').toLowerCase();
  if (!s) return { error: 'Enter dice notation like 3d6+2' };
  const terms: DiceTerm[] = [];
  const re = /([+-]?)(?:(\d*)d(\d+|%)(?:(kh|kl|dh|dl|k|d)(\d+))?|(\d+))/gy;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m || m[0] === '' || (pos > 0 && !m[1])) return { error: `Unexpected "${s.slice(pos)}" — use terms like 2d6, d20, 4d6dl1, +3` };
    pos = re.lastIndex;
    const sign = m[1] === '-' ? -1 : 1;
    if (m[6] !== undefined) {
      terms.push({ kind: 'const', sign, value: Number(m[6]), text: m[0].replace(/^\+/, '') });
      continue;
    }
    const count = m[2] ? Number(m[2]) : 1;
    const sides = m[3] === '%' ? 100 : Number(m[3]);
    if (count < 1 || count > 1000) return { error: 'Roll between 1 and 1000 dice per term' };
    if (sides < 2 || sides > 1_000_000) return { error: 'Dice need 2 to 1,000,000 sides' };
    let mod: { op: 'kh' | 'kl' | 'dh' | 'dl'; n: number } | undefined;
    if (m[4]) {
      const op = (m[4] === 'k' ? 'kh' : m[4] === 'd' ? 'dl' : m[4]) as 'kh' | 'kl' | 'dh' | 'dl';
      const n = Number(m[5]);
      if (n < 0 || n > count) return { error: `Can't ${op.startsWith('k') ? 'keep' : 'drop'} ${n} of ${count} dice` };
      mod = { op, n };
    }
    terms.push({ kind: 'dice', sign, count, sides, mod, text: m[0].replace(/^\+/, '') });
  }
  if (terms.length > 20) return { error: 'At most 20 terms' };
  return terms;
}

function keptCount(t: Extract<DiceTerm, { kind: 'dice' }>) {
  if (!t.mod) return t.count;
  return t.mod.op.startsWith('k') ? t.mod.n : t.count - t.mod.n;
}

export function diceRange(terms: DiceTerm[]): { min: number; max: number; mean: number } {
  let min = 0, max = 0, mean = 0;
  for (const t of terms) {
    if (t.kind === 'const') { min += t.sign * t.value; max += t.sign * t.value; mean += t.sign * t.value; continue; }
    const k = keptCount(t);
    const lo = k, hi = k * t.sides, avg = (k * (t.sides + 1)) / 2; // mean is exact only without keep/drop
    if (t.sign > 0) { min += lo; max += hi; } else { min -= hi; max -= lo; }
    mean += t.sign * avg;
  }
  return { min, max, mean };
}

export interface DiceRoll { total: number; terms: { text: string; rolls: number[]; kept: boolean[]; subtotal: number }[] }

export function rollDice(terms: DiceTerm[]): DiceRoll {
  let total = 0;
  const out: DiceRoll['terms'] = [];
  for (const t of terms) {
    if (t.kind === 'const') {
      total += t.sign * t.value;
      out.push({ text: (t.sign < 0 ? '-' : '+') + t.value, rolls: [], kept: [], subtotal: t.sign * t.value });
      continue;
    }
    const rolls = Array.from({ length: t.count }, () => 1 + randomBelow(t.sides));
    const kept = rolls.map(() => true);
    if (t.mod) {
      const order = rolls.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
      const { op, n } = t.mod;
      const drop = op === 'kh' ? order.slice(0, t.count - n) : op === 'kl' ? order.slice(n) : op === 'dl' ? order.slice(0, n) : order.slice(t.count - n);
      for (const [, i] of drop) kept[i] = false;
    }
    const subtotal = t.sign * rolls.reduce((a, v, i) => a + (kept[i] ? v : 0), 0);
    total += subtotal;
    out.push({ text: (t.sign < 0 ? '-' : '') + t.text.replace(/^-/, ''), rolls, kept, subtotal });
  }
  return { total, terms: out };
}

// ── password generation ─────────────────────────────────────────────────────

export const CHARSETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>/?~|',
};
/** Characters that are easy to confuse with each other. */
export const SIMILAR = 'il1Lo0OI|';
/** Characters that break shells, URLs, CSV, JSON or are hard to read aloud. */
export const AMBIGUOUS = '{}[]()/\\\'"`~,;:.<>';

export interface PasswordOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  /** Overrides the default symbol set. */
  symbolSet?: string;
  excludeSimilar?: boolean;
  excludeAmbiguous?: boolean;
  /** Extra characters to never use. */
  exclude?: string;
  requireEach?: boolean;
  noRepeats?: boolean;
}

export function passwordSets(o: PasswordOptions): string[] {
  const drop = new Set([...(o.exclude || ''), ...(o.excludeSimilar ? SIMILAR : ''), ...(o.excludeAmbiguous ? AMBIGUOUS : '')]);
  const clean = (s: string) => [...new Set(s)].filter(c => !drop.has(c)).join('');
  const sets: string[] = [];
  if (o.upper) sets.push(clean(CHARSETS.upper));
  if (o.lower) sets.push(clean(CHARSETS.lower));
  if (o.digits) sets.push(clean(CHARSETS.digits));
  if (o.symbols) sets.push(clean(o.symbolSet !== undefined && o.symbolSet !== '' ? o.symbolSet.replace(/\s/g, '') : CHARSETS.symbols));
  return sets.filter(Boolean);
}

export function passwordPool(o: PasswordOptions): string {
  return [...new Set(passwordSets(o).join(''))].join('');
}

/** Bits of entropy of a generated password (exact for the uniform case, ≈ when requireEach is on). */
export function passwordEntropy(o: PasswordOptions): number {
  const n = passwordPool(o).length;
  if (!n) return 0;
  if (o.noRepeats) {
    let bits = 0;
    for (let i = 0; i < Math.min(o.length, n); i++) bits += Math.log2(n - i);
    return bits;
  }
  return o.length * Math.log2(n);
}

export function validatePasswordOptions(o: PasswordOptions): string | null {
  const sets = passwordSets(o);
  const pool = passwordPool(o);
  if (!sets.length) return 'Select at least one character set (or remove some exclusions).';
  if (!Number.isInteger(o.length) || o.length < 1 || o.length > 1024) return 'Length must be 1–1024.';
  if (o.requireEach && o.length < sets.length) return `Length must be at least ${sets.length} to include every selected set.`;
  if (o.noRepeats && o.length > pool.length) return `"No repeated characters" allows at most ${pool.length} characters with these sets.`;
  return null;
}

export function generatePassword(o: PasswordOptions): string {
  const err = validatePasswordOptions(o);
  if (err) throw new Error(err);
  const sets = passwordSets(o);
  const pool = passwordPool(o);
  const used = new Set<string>();
  const chars: string[] = [];
  const take = (from: string) => {
    const avail = o.noRepeats ? [...from].filter(c => !used.has(c)) : [...from];
    const c = avail[randomBelow(avail.length)];
    used.add(c);
    chars.push(c);
  };
  if (o.requireEach) for (const s of sets) take(s);
  while (chars.length < o.length) take(pool);
  return o.requireEach ? shuffle(chars).join('') : chars.join('');
}

export const PASSPHRASE_WORDS: string[] = [...new Set(WORDLIST.filter(w => /^[a-z]{3,8}$/.test(w)))];

export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: 'none' | 'first' | 'all' | 'random';
  addNumber: boolean;
  addSymbol: boolean;
  wordlist?: string[];
}

const PASSPHRASE_SYMBOLS = '!@#$%^&*?';

export function generatePassphrase(o: PassphraseOptions): { phrase: string; entropy: number } {
  const list = o.wordlist ?? PASSPHRASE_WORDS;
  const n = Math.max(1, Math.min(o.words, 64));
  let entropy = n * Math.log2(list.length);
  let parts = Array.from({ length: n }, () => list[randomBelow(list.length)]);
  if (o.capitalize === 'first') parts = parts.map(w => w[0].toUpperCase() + w.slice(1));
  if (o.capitalize === 'all') parts = parts.map(w => w.toUpperCase());
  if (o.capitalize === 'random') {
    parts = parts.map(w => (randomBelow(2) ? w[0].toUpperCase() + w.slice(1) : w));
    entropy += n;
  }
  if (o.addNumber) {
    const i = randomBelow(n);
    parts[i] += String(randomBelow(100));
    entropy += Math.log2(100) + Math.log2(n);
  }
  if (o.addSymbol) {
    const i = randomBelow(n);
    parts[i] += PASSPHRASE_SYMBOLS[randomBelow(PASSPHRASE_SYMBOLS.length)];
    entropy += Math.log2(PASSPHRASE_SYMBOLS.length) + Math.log2(n);
  }
  return { phrase: parts.join(o.separator), entropy };
}

export function strengthLabel(bits: number): { label: string; level: 0 | 1 | 2 | 3 | 4 } {
  if (bits < 28) return { label: 'Very weak', level: 0 };
  if (bits < 40) return { label: 'Weak', level: 1 };
  if (bits < 60) return { label: 'Fair', level: 2 };
  if (bits < 80) return { label: 'Strong', level: 3 };
  return { label: 'Very strong', level: 4 };
}

// ── strength analysis ───────────────────────────────────────────────────────

export type PatternKind = 'password' | 'dictionary' | 'name' | 'keyboard' | 'sequence' | 'repeat' | 'date' | 'year' | 'bruteforce';

export interface Match {
  kind: PatternKind;
  i: number;
  j: number;
  token: string;
  /** log10 of the guesses needed for this segment. */
  log10: number;
  detail?: string;
  leet?: boolean;
  caps?: 'first' | 'all' | 'mixed';
}

const LEET: Record<string, string[]> = {
  '4': ['a'], '@': ['a'], '8': ['b'], '(': ['c'], '3': ['e'], '6': ['g'], '9': ['g'], '1': ['i', 'l'], '!': ['i'],
  '|': ['l', 'i'], '0': ['o'], '$': ['s'], '5': ['s'], '7': ['t'], '+': ['t'], '2': ['z'],
};

const RANK = new Map<string, { rank: number; kind: 'password' | 'dictionary' | 'name' }>();
COMMON_PASSWORDS.forEach((w, i) => { const k = w.toLowerCase(); if (!RANK.has(k)) RANK.set(k, { rank: i + 1, kind: 'password' }); });
COMMON_NAMES.forEach(w => { if (!RANK.has(w)) RANK.set(w, { rank: 800, kind: 'name' }); });
WORDLIST.forEach(w => { if (!RANK.has(w)) RANK.set(w, { rank: 2500, kind: 'dictionary' }); });

const log10 = Math.log10;

function nCk(n: number, k: number) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

function capsVariations(token: string): { factor: number; caps?: 'first' | 'all' | 'mixed' } {
  const letters = token.replace(/[^a-zA-Z]/g, '');
  const upper = letters.replace(/[^A-Z]/g, '').length;
  const lower = letters.length - upper;
  if (!upper) return { factor: 1 };
  if (!lower) return { factor: 2, caps: 'all' };
  if (upper === 1 && /^[^a-zA-Z]*[A-Z]/.test(token)) return { factor: 2, caps: 'first' };
  let f = 0;
  for (let k = 1; k <= Math.min(upper, lower); k++) f += nCk(upper + lower, k);
  return { factor: Math.max(f, 2), caps: 'mixed' };
}

/** Lowercased, de-leeted variants of a string (one per ambiguous mapping choice, max 4). */
function unleetVariants(s: string): string[] {
  let variants = [''];
  for (const ch of s.toLowerCase()) {
    const opts = LEET[ch];
    if (!opts) { variants = variants.map(v => v + ch); continue; }
    variants = variants.flatMap(v => [v + ch, ...opts.map(o => v + o)]).slice(0, 16);
  }
  return [...new Set(variants)];
}

function dictionaryMatches(pw: string): Match[] {
  const out: Match[] = [];
  const lower = pw.toLowerCase();
  const n = pw.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < Math.min(n, i + 24); j++) {
      const token = pw.slice(i, j + 1);
      const len = j - i + 1;
      const plain = lower.slice(i, j + 1);
      const candidates = /[0-9@$!|+(]/.test(token) ? unleetVariants(token) : [plain];
      for (const cand of candidates) {
        const hit = RANK.get(cand);
        if (!hit) continue;
        // Short dictionary words are everywhere; only count them if they're the whole password.
        if (hit.kind !== 'password' && len < 4 && len !== n) continue;
        if (hit.kind === 'password' && len < 4 && len !== n && !/^\d+$/.test(cand)) continue;
        const leet = cand !== plain;
        const caps = capsVariations(token);
        const subs = leet ? [...token].filter((c, k) => c.toLowerCase() !== cand[k]).length : 0;
        out.push({
          kind: hit.kind, i, j, token, leet, caps: caps.caps,
          log10: log10(hit.rank) + log10(caps.factor) + (leet ? subs * log10(2) : 0),
          detail: hit.kind === 'password' ? `#${hit.rank} most common password` : hit.kind === 'name' ? 'common name' : 'dictionary word',
        });
        break;
      }
    }
  }
  return out;
}

function keyboardMatches(pw: string): Match[] {
  const out: Match[] = [];
  const rows = [...KEYBOARD_ROWS, ...KEYBOARD_ROWS.map(r => [...r].reverse().join('')), ...KEYBOARD_WALKS];
  const n = pw.length;
  for (let i = 0; i < n; i++) {
    let best = -1;
    for (let j = i + 3; j < n; j++) {
      const t = pw.slice(i, j + 1);
      const tl = t.toLowerCase();
      if (rows.some(r => r.includes(t) || r.includes(tl))) best = j; else break;
    }
    if (best >= 0) {
      const token = pw.slice(i, best + 1);
      const L = token.length;
      out.push({ kind: 'keyboard', i, j: best, token, log10: log10(10 * L ** 2.5) + log10(capsVariations(token).factor), detail: 'keyboard pattern' });
    }
  }
  return out;
}

function sequenceMatches(pw: string): Match[] {
  const out: Match[] = [];
  const n = pw.length;
  let i = 0;
  while (i < n - 2) {
    const d = pw.charCodeAt(i + 1) - pw.charCodeAt(i);
    const same = (a: string, b: string) => (/\d/.test(a) && /\d/.test(b)) || (/[a-z]/.test(a) && /[a-z]/.test(b)) || (/[A-Z]/.test(a) && /[A-Z]/.test(b));
    if (Math.abs(d) >= 1 && Math.abs(d) <= 2 && same(pw[i], pw[i + 1])) {
      let j = i + 1;
      while (j + 1 < n && pw.charCodeAt(j + 1) - pw.charCodeAt(j) === d && same(pw[j], pw[j + 1])) j++;
      if (j - i >= 2) {
        const token = pw.slice(i, j + 1);
        const obvious = /^[aA019zZ]/.test(token);
        const base = obvious ? 4 : /\d/.test(token[0]) ? 10 : 26;
        out.push({ kind: 'sequence', i, j, token, log10: log10(base * token.length * (d < 0 ? 2 : 1)), detail: d < 0 ? 'descending sequence' : 'sequence' });
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

function repeatMatches(pw: string): Match[] {
  const out: Match[] = [];
  const re = /(.+?)\1+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pw))) {
    if (m[0].length < 3) { re.lastIndex = m.index + 1; continue; }
    const unit = m[1];
    const reps = m[0].length / unit.length;
    const unitLog = Math.min(unit.length * log10(poolSize(unit)), RANK.get(unit.toLowerCase()) ? log10(RANK.get(unit.toLowerCase())!.rank) : Infinity);
    out.push({ kind: 'repeat', i: m.index, j: m.index + m[0].length - 1, token: m[0], log10: unitLog + log10(reps), detail: `"${unit}" × ${reps}` });
  }
  return out;
}

const THIS_YEAR = new Date().getFullYear();

function dateMatches(pw: string): Match[] {
  const out: Match[] = [];
  const yearSpace = (y: number) => Math.max(Math.abs(y - THIS_YEAR), 20);
  // Full dates: d/m/y, m/d/y, y/m/d with optional separators, 2- or 4-digit years.
  const re = /(?=(\d{1,4})([\s/._-]?)(\d{1,2})\2(\d{1,4}))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pw))) {
    const [, a, sep, b, c] = m;
    const token = `${a}${sep}${b}${sep}${c}`;
    if (token.length < 4 || token.length > 10) { re.lastIndex = m.index + 1; continue; }
    const nums = [a, b, c].map(Number);
    let year: number | null = null;
    const plausible = (d: number, mo: number) => d >= 1 && d <= 31 && mo >= 1 && mo <= 12;
    if (a.length === 4 && plausible(nums[2], nums[1])) year = nums[0];
    else if (c.length === 4 && (plausible(nums[0], nums[1]) || plausible(nums[1], nums[0]))) year = nums[2];
    else if (c.length === 2 && a.length <= 2 && (plausible(nums[0], nums[1]) || plausible(nums[1], nums[0]))) year = nums[2] + (nums[2] > 50 ? 1900 : 2000);
    if (year !== null && year >= 1900 && year <= 2099) {
      out.push({ kind: 'date', i: m.index, j: m.index + token.length - 1, token, log10: log10(365 * yearSpace(year) * (sep ? 4 : 1)), detail: 'date' });
    }
    re.lastIndex = m.index + 1;
  }
  const yr = /(19\d\d|20\d\d)/g;
  while ((m = yr.exec(pw))) {
    out.push({ kind: 'year', i: m.index, j: m.index + 3, token: m[0], log10: log10(yearSpace(Number(m[0]))), detail: 'year' });
  }
  return out;
}

export function charClasses(pw: string) {
  return {
    lower: /[a-z]/.test(pw),
    upper: /[A-Z]/.test(pw),
    digit: /\d/.test(pw),
    symbol: /[^\sa-zA-Z\d\u0080-￿]/.test(pw),
    space: /\s/.test(pw),
    unicode: /[\u0080-￿]/.test(pw),
  };
}

export function poolSize(pw: string): number {
  const c = charClasses(pw);
  return (c.lower ? 26 : 0) + (c.upper ? 26 : 0) + (c.digit ? 10 : 0) + (c.symbol ? 33 : 0) + (c.space ? 1 : 0) + (c.unicode ? 100 : 0) || 1;
}

export interface CrackTime { id: string; label: string; rate: string; perSecond: number; seconds: number; display: string }

export const CRACK_SCENARIOS = [
  { id: 'online-throttled', label: 'Online, rate-limited', rate: '100 / hour', perSecond: 100 / 3600 },
  { id: 'online', label: 'Online, no rate limit', rate: '10 / second', perSecond: 10 },
  { id: 'offline-slow', label: 'Offline, slow hash (bcrypt, Argon2)', rate: '10k / second', perSecond: 1e4 },
  { id: 'offline-fast', label: 'Offline, fast hash (MD5, SHA-1) on GPUs', rate: '10B / second', perSecond: 1e10 },
];

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds > 3.15e16) return 'longer than the age of the universe';
  if (seconds < 1) return 'instantly';
  const units: [number, string][] = [[31557600 * 100, 'century'], [31557600, 'year'], [2629800, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [s, name] of units) {
    if (seconds >= s) {
      const v = seconds / s;
      if (name === 'century') {
        if (v >= 1e6) return `${(v / 1e4).toExponential(1).replace('e+', '×10^')} millennia`;
        return v >= 10 ? 'centuries' : `${Math.round(v)} ${v >= 1.5 ? 'centuries' : 'century'}`;
      }
      const r = Math.round(v);
      return `${r} ${name}${r === 1 ? '' : 's'}`;
    }
  }
  return 'instantly';
}

export interface StrengthResult {
  length: number;
  classes: ReturnType<typeof charClasses>;
  pool: number;
  naiveBits: number;
  log10Guesses: number;
  bits: number;
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  segments: Match[];
  matches: Match[];
  crack: CrackTime[];
  warnings: string[];
  suggestions: string[];
  isCommon: boolean;
}

/** zxcvbn-style analysis: find predictable patterns and the cheapest way to cover the password with them. */
export function analyzePassword(pw: string): StrengthResult {
  const n = pw.length;
  const classes = charClasses(pw);
  const pool = poolSize(pw);
  const matches = n ? [...dictionaryMatches(pw), ...keyboardMatches(pw), ...sequenceMatches(pw), ...repeatMatches(pw), ...dateMatches(pw)] : [];
  const charLog = log10(Math.max(pool, 10));

  // DP over prefix lengths: cheapest log10(guesses) to cover pw[0..k).
  const best = new Array<number>(n + 1).fill(Infinity);
  const back = new Array<Match | null>(n + 1).fill(null);
  const segs = new Array<number>(n + 1).fill(0);
  best[0] = 0;
  const byEnd = new Map<number, Match[]>();
  for (const m of matches) { const l = byEnd.get(m.j) ?? []; l.push(m); byEnd.set(m.j, l); }
  for (let k = 1; k <= n; k++) {
    // brute-force one character
    best[k] = best[k - 1] + charLog;
    back[k] = null;
    segs[k] = segs[k - 1] + (back[k - 1] === null && k > 1 ? 0 : 1);
    for (const m of byEnd.get(k - 1) ?? []) {
      const cost = best[m.i] + m.log10 + log10(segs[m.i] + 1);
      if (cost < best[k]) { best[k] = cost; back[k] = m; segs[k] = segs[m.i] + 1; }
    }
  }
  const segments: Match[] = [];
  for (let k = n; k > 0;) {
    const m = back[k];
    if (m) { segments.unshift(m); k = m.i; continue; }
    // A run of brute-forced characters reaches back to the previous match end (or the start).
    let start = k;
    while (start > 0 && back[start] === null) start--;
    segments.unshift({ kind: 'bruteforce', i: start, j: k - 1, token: pw.slice(start, k), log10: (k - start) * charLog, detail: 'random characters' });
    k = start;
  }
  const log10Guesses = n ? Math.max(best[n], 0) : 0;
  const bits = log10Guesses * Math.log2(10);
  const score = (log10Guesses < 3 ? 0 : log10Guesses < 6 ? 1 : log10Guesses < 8 ? 2 : log10Guesses < 10 ? 3 : 4) as 0 | 1 | 2 | 3 | 4;
  const guesses = 10 ** log10Guesses;
  const crack = CRACK_SCENARIOS.map(s => {
    const seconds = guesses / 2 / s.perSecond; // on average half the space is searched
    return { ...s, seconds, display: formatDuration(seconds) };
  });

  const isCommon = segments.length === 1 && segments[0].kind === 'password';
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const kinds = new Set(segments.map(s => s.kind));
  if (isCommon) warnings.push(`This is ${segments[0].detail} — it is in every attacker's first wordlist.`);
  else if (kinds.has('password')) warnings.push('Contains a very common password.');
  if (kinds.has('dictionary')) warnings.push(`Contains dictionary word${segments.filter(s => s.kind === 'dictionary').length > 1 ? 's' : ''}: ${segments.filter(s => s.kind === 'dictionary').map(s => `"${s.token}"`).join(', ')}.`);
  if (kinds.has('name')) warnings.push('Names are among the first things attackers try.');
  if (segments.some(s => s.leet)) warnings.push("Predictable substitutions like '@' for 'a' or '0' for 'o' barely help.");
  if (segments.some(s => s.caps === 'first')) suggestions.push('Capitalising the first letter adds almost nothing — capitalise unpredictable letters instead.');
  if (kinds.has('keyboard')) warnings.push('Keyboard patterns (qwerty, asdf, 1qaz…) are tried early.');
  if (kinds.has('sequence')) warnings.push('Sequences like abc or 1234 are easy to guess.');
  if (kinds.has('repeat')) warnings.push('Repeated characters or chunks add little strength.');
  if (kinds.has('date') || kinds.has('year')) warnings.push('Dates and years (birthdays, anniversaries) are easy to guess.');
  if (n && n < 12) suggestions.push('Use at least 12–16 characters; length beats complexity.');
  const nClasses = [classes.lower, classes.upper, classes.digit, classes.symbol].filter(Boolean).length;
  if (n && nClasses < 3 && n < 16) suggestions.push('Mix in other character types — or make it much longer.');
  if (score < 3) suggestions.push('Try a random passphrase of 4–6 words (see the Password Generator).');
  if (score >= 3 && !warnings.length) suggestions.push('Looks good. Use it for one site only and keep it in a password manager.');

  return {
    length: n, classes, pool, naiveBits: n * Math.log2(pool), log10Guesses, bits, score,
    label: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'][score],
    segments, matches, crack, warnings, suggestions, isCommon,
  };
}

// ── Have I Been Pwned (k-anonymity) ──────────────────────────────────────────

export async function sha1Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Count for `suffix` (35 hex chars) in a /range/<prefix> response body, 0 when absent. */
export function hibpCount(rangeBody: string, suffix: string): number {
  const want = suffix.toUpperCase();
  for (const line of rangeBody.split(/\r?\n/)) {
    const [s, c] = line.trim().split(':');
    if (s && s.toUpperCase() === want) return Number(c) || 0;
  }
  return 0;
}
