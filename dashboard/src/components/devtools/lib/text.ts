// Pure text helpers for the Text tools (no React, no path aliases — unit-tested with tsx).

// ───────────────────────── graphemes / words ─────────────────────────

type Seg = { segment: string; index: number; isWordLike?: boolean };
type SegmenterCtor = new (locale?: string, opts?: { granularity: 'grapheme' | 'word' | 'sentence' }) => { segment(s: string): Iterable<Seg> };
const Segmenter: SegmenterCtor | undefined = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;

/** Split into user-perceived characters (emoji ZWJ sequences, flags, combining marks stay whole). */
export function graphemes(s: string): string[] {
  if (!s) return [];
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(s), x => x.segment);
  // Fallback: code points, gluing combining marks / ZWJ / variation selectors onto the previous char.
  const out: string[] = [];
  for (const cp of Array.from(s)) {
    if (out.length && /^[̀-ͯ‍️⃣]|^[\u{1F3FB}-\u{1F3FF}]/u.test(cp)) out[out.length - 1] += cp;
    else if (out.length && out[out.length - 1].endsWith('‍')) out[out.length - 1] += cp;
    else out.push(cp);
  }
  return out;
}

export const graphemeCount = (s: string) => graphemes(s).length;

export function wordList(s: string): string[] {
  if (Segmenter) {
    const out: string[] = [];
    for (const x of new Segmenter(undefined, { granularity: 'word' }).segment(s)) if (x.isWordLike) out.push(x.segment);
    return out;
  }
  return s.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? [];
}

export const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been before being below between both but by
can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd
he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself
no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's
the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd
we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's will with won't would wouldn't you you'd you'll
you're you've your yours yourself yourselves also just get got like one two may might much many us use used using via yet would could`.split(/\s+/));

export interface TextStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  letters: number;
  sentences: number;
  paragraphs: number;
  lines: number;
  uniqueWords: number;
  avgWordLength: number;
  avgSentenceWords: number;
  longestWord: string;
  readingMinutes: number;
  speakingMinutes: number;
  keywords: { word: string; count: number; density: number }[];
  phrases: { phrase: string; count: number }[];
}

export function textStats(text: string, { readingWpm = 238, speakingWpm = 150, keywordLimit = 12 } = {}): TextStats {
  const words = wordList(text);
  const g = graphemes(text);
  const charsNoSpaces = g.filter(c => !/^\s+$/.test(c)).length;
  const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const sentences = text.trim() ? (text.match(/[^.!?…。！？]*[\p{L}\p{N}][^.!?…。！？]*(?:[.!?…。！？]+|$)/gu) ?? []).length : 0;
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim()).length;
  const lower = words.map(w => w.toLowerCase());
  const freq = new Map<string, number>();
  for (const w of lower) if (!STOPWORDS.has(w) && w.length > 1 && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, keywordLimit)
    .map(([word, count]) => ({ word, count, density: words.length ? count / words.length : 0 }));
  const bi = new Map<string, number>();
  for (let i = 0; i + 1 < lower.length; i++) {
    if (STOPWORDS.has(lower[i]) || STOPWORDS.has(lower[i + 1])) continue;
    const k = `${lower[i]} ${lower[i + 1]}`;
    bi.set(k, (bi.get(k) ?? 0) + 1);
  }
  const phrases = [...bi.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([phrase, count]) => ({ phrase, count }));
  const totalLen = words.reduce((s, w) => s + graphemeCount(w), 0);
  return {
    words: words.length,
    characters: g.length,
    charactersNoSpaces: charsNoSpaces,
    letters,
    sentences,
    paragraphs,
    lines: text ? text.split('\n').length : 0,
    uniqueWords: new Set(lower).size,
    avgWordLength: words.length ? totalLen / words.length : 0,
    avgSentenceWords: sentences ? words.length / sentences : 0,
    longestWord: words.reduce((m, w) => (graphemeCount(w) > graphemeCount(m) ? w : m), ''),
    readingMinutes: words.length / readingWpm,
    speakingMinutes: words.length / speakingWpm,
    keywords,
    phrases,
  };
}

/** 1.5 → "1 min 30 s", 0.2 → "12 s" */
export function formatMinutes(min: number): string {
  const total = Math.round(min * 60);
  if (total < 60) return `${total} s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h} h ${m} min` : s ? `${m} min ${s} s` : `${m} min`;
}

// ───────────────────────── platform counters ─────────────────────────

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€\f';

export interface SmsInfo {
  encoding: 'GSM-7' | 'UCS-2';
  units: number;
  segments: number;
  perSegment: number;
  remainingInSegment: number;
  nonGsm: string[];
}

export function smsInfo(text: string): SmsInfo {
  const nonGsm: string[] = [];
  let gsmUnits = 0;
  for (const ch of Array.from(text)) {
    if (GSM_BASIC.includes(ch)) gsmUnits += 1;
    else if (GSM_EXT.includes(ch)) gsmUnits += 2;
    else if (!nonGsm.includes(ch)) nonGsm.push(ch);
  }
  if (!nonGsm.length) {
    const per = gsmUnits <= 160 ? 160 : 153;
    const segments = gsmUnits === 0 ? 0 : Math.ceil(gsmUnits / per);
    return { encoding: 'GSM-7', units: gsmUnits, segments, perSegment: per, remainingInSegment: segments ? segments * per - gsmUnits : 160, nonGsm };
  }
  const units = text.length; // UTF-16 code units
  const per = units <= 70 ? 70 : 67;
  const segments = Math.ceil(units / per);
  return { encoding: 'UCS-2', units, segments, perSegment: per, remainingInSegment: segments * per - units, nonGsm };
}

/** X / Twitter weighted length: URLs count 23, most Latin chars 1, CJK / emoji 2. */
export function tweetLength(text: string): number {
  let n = 0;
  const urlRe = /https?:\/\/[^\s]+|(?:\b[a-z0-9-]+\.)+(?:com|org|net|io|dev|co|ai|app|me|gg|ly)\b(?:\/[^\s]*)?/gi;
  const withoutUrls = text.replace(urlRe, () => { n += 23; return ''; });
  for (const g of graphemes(withoutUrls)) {
    if (/\p{Extended_Pictographic}/u.test(g)) { n += 2; continue; }
    const cp = g.codePointAt(0)!;
    const light = cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}

// ───────────────────────── duplicate lines ─────────────────────────

export type SortMode = 'none' | 'asc' | 'desc' | 'natural' | 'natural-desc' | 'length' | 'length-desc' | 'random' | 'reverse';
export interface DedupeOptions {
  mode: 'dedupe' | 'duplicates' | 'unique';
  caseInsensitive: boolean;
  ignoreWhitespace: boolean;
  trim: boolean;
  removeEmpty: boolean;
  keep: 'first' | 'last';
  sort: SortMode;
  seed?: number;
}

export const DEFAULT_DEDUPE: DedupeOptions = {
  mode: 'dedupe', caseInsensitive: false, ignoreWhitespace: true, trim: true, removeEmpty: true, keep: 'first', sort: 'none',
};

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function dedupeLines(text: string, o: DedupeOptions) {
  let lines = text.split(/\r?\n/);
  const total = lines.length;
  if (o.trim) lines = lines.map(l => l.trim());
  let emptyRemoved = 0;
  if (o.removeEmpty) { const before = lines.length; lines = lines.filter(l => l.trim() !== ''); emptyRemoved = before - lines.length; }
  const key = (l: string) => {
    let k = o.ignoreWhitespace ? l.trim().replace(/\s+/g, ' ') : l;
    if (o.caseInsensitive) k = k.toLocaleLowerCase();
    return k;
  };
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(key(l), (counts.get(key(l)) ?? 0) + 1);

  let out: string[];
  if (o.mode === 'duplicates') {
    const seen = new Set<string>();
    out = lines.filter(l => { const k = key(l); if (counts.get(k)! < 2 || seen.has(k)) return false; seen.add(k); return true; });
  } else if (o.mode === 'unique') {
    out = lines.filter(l => counts.get(key(l)) === 1);
  } else if (o.keep === 'last') {
    const lastIdx = new Map<string, number>();
    lines.forEach((l, i) => lastIdx.set(key(l), i));
    out = lines.filter((l, i) => lastIdx.get(key(l)) === i);
  } else {
    const seen = new Set<string>();
    out = lines.filter(l => { const k = key(l); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  const dupesRemoved = o.mode === 'dedupe' ? lines.length - out.length : 0;
  out = sortLines(out, o.sort, o.seed ?? 1);
  return {
    output: out.join('\n'),
    total,
    kept: out.length,
    removed: total - out.length,
    duplicatesRemoved: dupesRemoved,
    emptyRemoved,
    duplicateGroups: [...counts.values()].filter(c => c > 1).length,
  };
}

export function sortLines(lines: string[], sort: SortMode, seed = 1): string[] {
  const a = [...lines];
  switch (sort) {
    case 'asc': return a.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    case 'desc': return a.sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
    case 'natural': return a.sort(collator.compare);
    case 'natural-desc': return a.sort((x, y) => collator.compare(y, x));
    case 'length': return a.sort((x, y) => x.length - y.length || collator.compare(x, y));
    case 'length-desc': return a.sort((x, y) => y.length - x.length || collator.compare(x, y));
    case 'reverse': return a.reverse();
    case 'random': {
      const r = mulberry32(seed);
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    }
    default: return a;
  }
}

// ───────────────────────── fancy text ─────────────────────────

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

function mathAlpha(upper: number, lower: number, digit?: number, exceptions: Record<string, string> = {}) {
  return (s: string) => Array.from(s, ch => {
    if (exceptions[ch]) return exceptions[ch];
    let i = UPPER.indexOf(ch);
    if (i >= 0) return String.fromCodePoint(upper + i);
    i = LOWER.indexOf(ch);
    if (i >= 0) return String.fromCodePoint(lower + i);
    i = DIGITS.indexOf(ch);
    if (i >= 0 && digit !== undefined) return String.fromCodePoint(digit + i);
    return ch;
  }).join('');
}

function charMap(from: string, to: string[] | string, opts: { lowerToUpper?: boolean } = {}) {
  const targets = typeof to === 'string' ? Array.from(to) : to;
  const src = Array.from(from);
  const m = new Map<string, string>();
  src.forEach((c, i) => targets[i] && m.set(c, targets[i]));
  return (s: string) => Array.from(s, ch => m.get(ch) ?? (opts.lowerToUpper ? m.get(ch.toUpperCase()) : undefined) ?? ch).join('');
}

const combining = (mark: string) => (s: string) => graphemes(s).map(g => (/\s/.test(g) ? g : g + mark)).join('');

const UPSIDE: Record<string, string> = {
  a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ', j: 'ɾ', k: 'ʞ', l: 'l', m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ', s: 's',
  t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z', A: '∀', B: 'ꓭ', C: 'Ɔ', D: 'ᗡ', E: 'Ǝ', F: 'Ⅎ', G: '⅁', H: 'H', I: 'I', J: 'ſ', K: 'ꓘ', L: '˥',
  M: 'W', N: 'N', O: 'O', P: 'Ԁ', Q: 'Ό', R: 'ꓤ', S: 'S', T: '⊥', U: '∩', V: 'Λ', W: 'M', X: 'X', Y: '⅄', Z: 'Z', 1: 'Ɩ', 2: 'ᄅ', 3: 'Ɛ', 4: 'ㄣ',
  5: 'ϛ', 6: '9', 7: 'ㄥ', 8: '8', 9: '6', 0: '0', '.': '˙', ',': "'", "'": ',', '"': '„', '`': ',', '?': '¿', '!': '¡', '(': ')', ')': '(', '[': ']',
  ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '&': '⅋', _: '‾', ';': '؛',
};

/** Rotate text 180° (maps characters and reverses order, line by line). */
export function upsideDown(s: string): string {
  return s.split('\n').map(line => graphemes(line).reverse().map(g => UPSIDE[g] ?? g).join('')).reverse().join('\n');
}

const ZALGO_UP = ['̍', '̎', '̄', '̅', '̿', '̑', '̆', '̐', '͒', '͗', '͑', '̇', '̈', '̊', '͂', '̓', '̈́', '͊', '͋', '͌', '̃', '̂', '̌', '͐', '̀', '́', '̋', '̏', '̒', '̓', '̔', '̽'];
const ZALGO_DOWN = ['̖', '̗', '̘', '̙', '̜', '̝', '̞', '̟', '̠', '̤', '̥', '̦', '̩', '̪', '̫', '̬', '̭', '̮', '̯', '̰', '̱', '̲', '̳', '̹', '̺', '̻', '̼', 'ͅ', '͇', '͈', '͉', '͍', '͎'];

export function zalgo(s: string, intensity = 1, seed = 7): string {
  const r = mulberry32(seed);
  return graphemes(s).map(g => {
    if (/\s/.test(g)) return g;
    let out = g;
    const n = 1 + Math.floor(r() * (intensity + 1));
    for (let i = 0; i < n; i++) out += ZALGO_UP[Math.floor(r() * ZALGO_UP.length)];
    for (let i = 0; i < Math.floor(r() * (intensity + 1)); i++) out += ZALGO_DOWN[Math.floor(r() * ZALGO_DOWN.length)];
    return out;
  }).join('');
}

export interface FancyStyle { id: string; label: string; fn: (s: string) => string }

const SMALL_CAPS = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ';
const SUPER_SRC = 'abcdefghijklmnoprstuvwxyzABDEGHIJKLMNOPRTUVW0123456789+-=()';
const SUPER_DST = 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾';
const SUB_SRC = 'aehijklmnoprstuvx0123456789+-=()';
const SUB_DST = 'ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎';

export const FANCY_STYLES: FancyStyle[] = [
  { id: 'bold', label: 'Bold (serif)', fn: mathAlpha(0x1d400, 0x1d41a, 0x1d7ce) },
  { id: 'italic', label: 'Italic (serif)', fn: mathAlpha(0x1d434, 0x1d44e, undefined, { h: 'ℎ' }) },
  { id: 'bold-italic', label: 'Bold italic (serif)', fn: mathAlpha(0x1d468, 0x1d482) },
  { id: 'sans-bold', label: 'Bold (sans)', fn: mathAlpha(0x1d5d4, 0x1d5ee, 0x1d7ec) },
  { id: 'sans-italic', label: 'Italic (sans)', fn: mathAlpha(0x1d608, 0x1d622) },
  { id: 'sans-bold-italic', label: 'Bold italic (sans)', fn: mathAlpha(0x1d63c, 0x1d656) },
  { id: 'sans', label: 'Sans-serif', fn: mathAlpha(0x1d5a0, 0x1d5ba, 0x1d7e2) },
  { id: 'script', label: 'Script', fn: mathAlpha(0x1d49c, 0x1d4b6, undefined, { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' }) },
  { id: 'bold-script', label: 'Bold script', fn: mathAlpha(0x1d4d0, 0x1d4ea) },
  { id: 'fraktur', label: 'Fraktur (gothic)', fn: mathAlpha(0x1d504, 0x1d51e, undefined, { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' }) },
  { id: 'bold-fraktur', label: 'Bold fraktur', fn: mathAlpha(0x1d56c, 0x1d586) },
  { id: 'double-struck', label: 'Double-struck', fn: mathAlpha(0x1d538, 0x1d552, 0x1d7d8, { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' }) },
  { id: 'monospace', label: 'Monospace', fn: mathAlpha(0x1d670, 0x1d68a, 0x1d7f6) },
  { id: 'fullwidth', label: 'Fullwidth (vaporwave)', fn: s => Array.from(s, c => { const cp = c.codePointAt(0)!; return cp === 32 ? '　' : cp > 32 && cp < 127 ? String.fromCodePoint(cp + 0xfee0) : c; }).join('') },
  { id: 'circled', label: 'Circled', fn: charMap(UPPER + LOWER + '0123456789', [...Array.from({ length: 26 }, (_, i) => String.fromCodePoint(0x24b6 + i)), ...Array.from({ length: 26 }, (_, i) => String.fromCodePoint(0x24d0 + i)), '⓪', ...Array.from({ length: 9 }, (_, i) => String.fromCodePoint(0x2460 + i))]) },
  { id: 'circled-neg', label: 'Circled (filled)', fn: charMap(UPPER + '0123456789', [...Array.from({ length: 26 }, (_, i) => String.fromCodePoint(0x1f150 + i)), '⓿', ...Array.from({ length: 9 }, (_, i) => String.fromCodePoint(0x2776 + i))], { lowerToUpper: true }) },
  { id: 'squared', label: 'Squared', fn: charMap(UPPER, Array.from({ length: 26 }, (_, i) => String.fromCodePoint(0x1f130 + i)), { lowerToUpper: true }) },
  { id: 'squared-neg', label: 'Squared (filled)', fn: charMap(UPPER, Array.from({ length: 26 }, (_, i) => String.fromCodePoint(0x1f170 + i)), { lowerToUpper: true }) },
  { id: 'parenthesized', label: 'Parenthesized', fn: charMap(LOWER, Array.from({ length: 26 }, (_, i) => String.fromCodePoint(0x249c + i)), { lowerToUpper: false }) },
  { id: 'small-caps', label: 'Small caps', fn: s => charMap(LOWER, SMALL_CAPS)(s) },
  { id: 'superscript', label: 'Superscript', fn: s => charMap(SUPER_SRC, SUPER_DST)(s) },
  { id: 'subscript', label: 'Subscript', fn: s => charMap(SUB_SRC, SUB_DST)(s.toLowerCase()) },
  { id: 'upside-down', label: 'Upside down', fn: upsideDown },
  { id: 'strike', label: 'Strikethrough', fn: combining('̶') },
  { id: 'underline', label: 'Underline', fn: combining('̲') },
  { id: 'double-underline', label: 'Double underline', fn: combining('̳') },
  { id: 'overline', label: 'Overline', fn: combining('̅') },
  { id: 'slash', label: 'Slashed', fn: combining('̸') },
  { id: 'regional', label: 'Regional indicators', fn: s => Array.from(s, c => { const i = UPPER.indexOf(c.toUpperCase()); return i >= 0 ? String.fromCodePoint(0x1f1e6 + i) + '​' : c; }).join('') },
  { id: 'spaced', label: 'S p a c e d', fn: s => graphemes(s).join(' ') },
  { id: 'zalgo', label: 'Zalgo (light)', fn: s => zalgo(s, 1) },
  { id: 'zalgo-heavy', label: 'Zalgo (glitchy)', fn: s => zalgo(s, 4, 13) },
];

// ───────────────────────── reverse ─────────────────────────

export const reverseChars = (s: string) => graphemes(s).reverse().join('');
/** Reverse word order on each line, keeping the line structure. */
export const reverseWords = (s: string) => s.split('\n').map(l => l.split(/(\s+)/).reverse().join('')).join('\n');
export const reverseLines = (s: string) => s.split('\n').reverse().join('\n');
/** Reverse the letters of each word in place. */
export const reverseEachWord = (s: string) => s.split(/(\s+)/).map(w => (/^\s+$/.test(w) ? w : reverseChars(w))).join('');

// ───────────────────────── lorem ipsum ─────────────────────────

const LOREM_WORDS = `lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad
minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum
fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum praesent elementum facilisis
leo vel fringilla phasellus faucibus scelerisque eleifend donec pretium vulputate sapien nec sagittis aliquam malesuada bibendum arcu vitae tortor
condimentum lacinia quis vel eros donec ac odio tempor orci dapibus ultrices iaculis nunc mattis enim ut tellus pellentesque habitant morbi tristique
senectus netus fames turpis egestas maecenas pharetra convallis posuere morbi leo urna molestie at elementum eu facilisis viverra justo nec ultrices
dui sapien eget mi proin gravida hendrerit lectus a cras semper auctor neque vitae tempus quam pellentesque massa placerat duis ultricies lacus sed
turpis tincidunt id aliquet risus feugiat pretium nibh ipsum consequat nisl vel pretium lectus quam id leo integer feugiat scelerisque varius morbi
enim nunc faucibus a pellentesque sit amet porttitor eget dolor morbi non arcu risus quis varius quam quisque`.split(/\s+/);

export type LoremUnit = 'paragraphs' | 'sentences' | 'words' | 'list';
export interface LoremOptions { unit: LoremUnit; count: number; startWithLorem: boolean; html: boolean; seed: number; sentencesPerParagraph?: [number, number] }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function lorem(o: LoremOptions): string {
  const r = mulberry32(o.seed);
  const rint = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const word = () => LOREM_WORDS[Math.floor(r() * LOREM_WORDS.length)];
  let first = o.startWithLorem;
  const sentence = (min = 6, max = 16) => {
    const n = rint(min, max);
    const ws: string[] = [];
    if (first) { ws.push('lorem', 'ipsum', 'dolor', 'sit', 'amet'); first = false; }
    while (ws.length < n) ws.push(word());
    // sprinkle a comma in longer sentences
    if (ws.length > 9) ws[rint(3, ws.length - 4)] += ',';
    return cap(ws.join(' ')) + (r() < 0.08 ? '?' : '.');
  };
  const count = Math.max(1, Math.min(o.count, 1000));
  const [pMin, pMax] = o.sentencesPerParagraph ?? [4, 7];
  if (o.unit === 'words') {
    const ws: string[] = o.startWithLorem ? ['lorem', 'ipsum', 'dolor', 'sit', 'amet'].slice(0, count) : [];
    while (ws.length < count) ws.push(word());
    const s = cap(ws.join(' '));
    return o.html ? `<p>${s}</p>` : s;
  }
  if (o.unit === 'sentences') {
    const s = Array.from({ length: count }, () => sentence()).join(' ');
    return o.html ? `<p>${s}</p>` : s;
  }
  if (o.unit === 'list') {
    const items = Array.from({ length: count }, () => sentence(3, 8).replace(/[.?]$/, ''));
    return o.html ? `<ul>\n${items.map(i => `  <li>${i}</li>`).join('\n')}\n</ul>` : items.map(i => `• ${i}`).join('\n');
  }
  const paras = Array.from({ length: count }, () => Array.from({ length: rint(pMin, pMax) }, () => sentence()).join(' '));
  return o.html ? paras.map(p => `<p>${p}</p>`).join('\n\n') : paras.join('\n\n');
}
