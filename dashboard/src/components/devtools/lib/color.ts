// Colour math for the Color tools. Pure TypeScript, no React / path aliases, so it can be
// unit-tested with plain tsx (see color.test.ts).
//
// Conventions: RGB channels are 0–255 (may be fractional), alpha 0–1, HSL/HSV h in degrees and
// s/l/v in 0–100, OKLCH l in 0–1, c ≈ 0–0.4, h in degrees.

export interface RGB { r: number; g: number; b: number }
export interface RGBA extends RGB { a: number }
export interface HSL { h: number; s: number; l: number }
export interface HSV { h: number; s: number; v: number }
export interface OKLab { l: number; a: number; b: number }
export interface OKLCH { l: number; c: number; h: number }

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d = 0) => { const p = 10 ** d; return Math.round(v * p) / p; };
const mod = (a: number, n: number) => ((a % n) + n) % n;

// ---------- parsing / formatting ----------

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080',
  grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', purple: '#800080', teal: '#008080',
  navy: '#000080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347', crimson: '#dc143c', khaki: '#f0e68c',
  rebeccapurple: '#663399', slategray: '#708090', steelblue: '#4682b4', royalblue: '#4169e1', skyblue: '#87ceeb',
  tan: '#d2b48c', turquoise: '#40e0d0', beige: '#f5f5dc', ivory: '#fffff0', lavender: '#e6e6fa', mintcream: '#f5fffa',
};

function parseHex(s: string): RGBA | null {
  let h = s.replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
  if (h.length <= 4) h = h.split('').map(c => c + c).join('');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? round(n(6) / 255, 3) : 1 };
}

/** A number or percentage (of `pctOf`). */
function num(token: string, pctOf: number): number {
  const t = token.trim();
  return t.endsWith('%') ? (parseFloat(t) / 100) * pctOf : parseFloat(t);
}

function angle(token: string): number {
  const t = token.trim().toLowerCase();
  const v = parseFloat(t);
  if (t.endsWith('turn')) return v * 360;
  if (t.endsWith('grad')) return v * 0.9;
  if (t.endsWith('rad')) return (v * 180) / Math.PI;
  return v;
}

/** Parse #hex, rgb()/rgba(), hsl()/hsla(), hwb-less CSS, oklch(), oklab() and common named colours. */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED[s]) return parseHex(NAMED[s]);
  if (s.startsWith('#') || /^[0-9a-f]{3,8}$/.test(s)) return parseHex(s);
  const m = /^(rgba?|hsla?|oklch|oklab)\(\s*([^)]*)\)$/.exec(s);
  if (!m) return null;
  const parts = m[2].replace(/\s*\/\s*/, ' / ').split(/[\s,]+/).filter(Boolean);
  const slash = parts.indexOf('/');
  let alphaTok: string | undefined;
  let comps = parts;
  if (slash >= 0) { alphaTok = parts[slash + 1]; comps = parts.slice(0, slash); } else if (parts.length === 4) { alphaTok = parts[3]; comps = parts.slice(0, 3); }
  if (comps.length !== 3 || comps.some(c => Number.isNaN(parseFloat(c)) && c !== 'none')) return null;
  const a = alphaTok === undefined ? 1 : clamp(alphaTok.endsWith('%') ? parseFloat(alphaTok) / 100 : parseFloat(alphaTok));
  if (Number.isNaN(a)) return null;
  const c = comps.map(x => (x === 'none' ? '0' : x));
  let rgb: RGB;
  switch (m[1]) {
    case 'rgb': case 'rgba':
      rgb = { r: num(c[0], 255), g: num(c[1], 255), b: num(c[2], 255) };
      break;
    case 'hsl': case 'hsla':
      rgb = hslToRgb({ h: angle(c[0]), s: parseFloat(c[1]), l: parseFloat(c[2]) });
      break;
    case 'oklch':
      rgb = oklchToRgbGamut({ l: c[0].endsWith('%') ? parseFloat(c[0]) / 100 : parseFloat(c[0]), c: c[1].endsWith('%') ? (parseFloat(c[1]) / 100) * 0.4 : parseFloat(c[1]), h: angle(c[2]) });
      break;
    default:
      rgb = clampRgb(oklabToRgb({ l: c[0].endsWith('%') ? parseFloat(c[0]) / 100 : parseFloat(c[0]), a: parseFloat(c[1]), b: parseFloat(c[2]) }));
  }
  rgb = clampRgb(rgb);
  return { ...rgb, a: round(a, 3) };
}

export const clampRgb = (c: RGB): RGB => ({ r: clamp(c.r, 0, 255), g: clamp(c.g, 0, 255), b: clamp(c.b, 0, 255) });

const h2 = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');

export function rgbToHex(c: RGB, alpha = 1): string {
  return '#' + h2(c.r) + h2(c.g) + h2(c.b) + (alpha < 1 ? h2(alpha * 255) : '');
}

export function hexToRgb(hex: string): RGB | null {
  const p = parseHex(hex);
  return p ? { r: p.r, g: p.g, b: p.b } : null;
}

export function formatRgb(c: RGB, a = 1): string {
  const [r, g, b] = [c.r, c.g, c.b].map(v => Math.round(clamp(v, 0, 255)));
  return a < 1 ? `rgb(${r} ${g} ${b} / ${round(a, 3)})` : `rgb(${r} ${g} ${b})`;
}

export function formatHsl(c: RGB, a = 1): string {
  const { h, s, l } = rgbToHsl(c);
  const body = `${round(h, 1)} ${round(s, 1)}% ${round(l, 1)}%`;
  return a < 1 ? `hsl(${body} / ${round(a, 3)})` : `hsl(${body})`;
}

export function formatOklch(c: RGB, a = 1): string {
  const o = rgbToOklch(c);
  const body = `${round(o.l * 100, 2)}% ${round(o.c, 4)} ${o.c < 1e-4 ? 0 : round(o.h, 2)}`;
  return a < 1 ? `oklch(${body} / ${round(a, 3)})` : `oklch(${body})`;
}

// ---------- HSL / HSV ----------

export function rgbToHsl({ r, g, b }: RGB): HSL {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  h = mod(h, 360); s = clamp(s / 100); l = clamp(l / 100);
  const k = (n: number) => mod(n + h / 30, 12);
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

export function rgbToHsv({ r, g, b }: RGB): HSV {
  const { h } = rgbToHsl({ r, g, b });
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return { h, s: max === 0 ? 0 : ((max - min) / max) * 100, v: max * 100 };
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  s = clamp(s / 100); v = clamp(v / 100);
  const f = (n: number) => { const k = mod(n + h / 60, 6); return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 };
}

// ---------- OKLab / OKLCH ----------

export const srgbToLinear = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const linearToSrgb = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.sign(v) * Math.abs(v) ** (1 / 2.4) - 0.055);

export function rgbToOklab(c: RGB): OKLab {
  const r = srgbToLinear(c.r), g = srgbToLinear(c.g), b = srgbToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** May return out-of-range channels for colours outside sRGB (see inGamut / oklchToRgbGamut). */
export function oklabToRgb({ l: L, a, b }: OKLab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

export function rgbToOklch(c: RGB): OKLCH {
  const { l, a, b } = rgbToOklab(c);
  const ch = Math.sqrt(a * a + b * b);
  return { l, c: ch, h: ch < 1e-6 ? 0 : mod((Math.atan2(b, a) * 180) / Math.PI, 360) };
}

export function oklchToRgb({ l, c, h }: OKLCH): RGB {
  const r = (h * Math.PI) / 180;
  return oklabToRgb({ l, a: c * Math.cos(r), b: c * Math.sin(r) });
}

export const inGamut = (c: RGB, eps = 0.5) => [c.r, c.g, c.b].every(v => v >= -eps && v <= 255 + eps);

/** OKLCH → sRGB, reducing chroma (keeping L and h) until the colour fits the sRGB gamut. */
export function oklchToRgbGamut(o: OKLCH): RGB {
  const l = clamp(o.l);
  if (l >= 1) return { r: 255, g: 255, b: 255 };
  if (l <= 0) return { r: 0, g: 0, b: 0 };
  let rgb = oklchToRgb({ ...o, l });
  if (inGamut(rgb)) return clampRgb(rgb);
  let lo = 0, hi = o.c;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToRgb({ l, c: mid, h: o.h }))) lo = mid; else hi = mid;
  }
  rgb = oklchToRgb({ l, c: lo, h: o.h });
  return clampRgb(rgb);
}

/** Largest in-gamut chroma for a lightness/hue. */
export function maxChroma(l: number, h: number): number {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToRgb({ l, c: mid, h }))) lo = mid; else hi = mid;
  }
  return lo;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

// ---------- WCAG contrast ----------

export function relativeLuminance(c: RGB): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composite a translucent foreground over an opaque background. */
export function compositeOver(fg: RGBA, bg: RGB): RGB {
  return mix(bg, fg, fg.a);
}

export interface WcagResult {
  ratio: number;
  aaNormal: boolean; aaaNormal: boolean; aaLarge: boolean; aaaLarge: boolean; ui: boolean;
}

export function wcag(ratio: number): WcagResult {
  // WCAG compares the unrounded ratio against the thresholds.
  return { ratio, aaNormal: ratio >= 4.5, aaaNormal: ratio >= 7, aaLarge: ratio >= 3, aaaLarge: ratio >= 4.5, ui: ratio >= 3 };
}

export const readableText = (bg: RGB): '#000000' | '#ffffff' =>
  contrastRatio(bg, { r: 0, g: 0, b: 0 }) >= contrastRatio(bg, { r: 255, g: 255, b: 255 }) ? '#000000' : '#ffffff';

/**
 * Nearest colour to `fg` (same OKLCH hue/chroma where possible, only lightness changes) that reaches
 * `target` contrast against `bg`. Returns null when even black/white can't reach it.
 */
export function suggestContrast(fg: RGB, bg: RGB, target: number): RGB | null {
  if (contrastRatio(fg, bg) >= target) return clampRgb(fg);
  const o = rgbToOklch(fg);
  let best: RGB | null = null;
  let bestDelta = Infinity;
  for (const dir of [-1, 1]) {
    for (let l = o.l; l >= 0 && l <= 1; l += dir * 0.002) {
      const c = oklchToRgbGamut({ l, c: o.c, h: o.h });
      const rounded = { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };
      if (contrastRatio(rounded, bg) >= target) {
        const d = Math.abs(l - o.l);
        if (d < bestDelta) { bestDelta = d; best = rounded; }
        break;
      }
    }
  }
  return best;
}

// ---------- palettes ----------

export type Harmony = 'complementary' | 'analogous' | 'triadic' | 'tetradic' | 'split' | 'monochrome' | 'shades';

export const HARMONIES: { value: Harmony; label: string }[] = [
  { value: 'complementary', label: 'Complementary' }, { value: 'analogous', label: 'Analogous' },
  { value: 'triadic', label: 'Triadic' }, { value: 'tetradic', label: 'Tetradic' },
  { value: 'split', label: 'Split-compl.' }, { value: 'monochrome', label: 'Monochrome' },
];

/**
 * Colour-wheel harmonies. Hue rotation happens in OKLCH so lightness stays perceptually even, with
 * chroma clipped to the gamut. Returns 5 swatches (base first where it makes sense).
 */
export function harmony(base: RGB, kind: Harmony): RGB[] {
  const o = rgbToOklch(base);
  const at = (dh: number, dl = 0, cs = 1) => oklchToRgbGamut({ l: clamp(o.l + dl, 0.05, 0.98), c: o.c * cs, h: mod(o.h + dh, 360) });
  switch (kind) {
    case 'complementary': return [at(0, 0.18, 0.6), base, at(0, -0.15), at(180), at(180, 0.18, 0.6)];
    case 'analogous': return [at(-60), at(-30), base, at(30), at(60)];
    case 'triadic': return [base, at(120), at(240), at(0, 0.2, 0.5), at(120, 0.2, 0.5)];
    case 'tetradic': return [base, at(90), at(180), at(270), at(0, 0.22, 0.4)];
    case 'split': return [base, at(150), at(210), at(150, 0.2, 0.5), at(210, 0.2, 0.5)];
    case 'shades':
    case 'monochrome': {
      const ls = [0.92, 0.78, 0.62, 0.46, 0.3];
      return ls.map(l => oklchToRgbGamut({ l, c: Math.min(o.c, maxChroma(l, o.h)), h: o.h }));
    }
  }
}

/** Seeded PRNG so "random" palettes are reproducible in tests. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random but pleasant palette: hues spread from a random anchor (golden-angle-ish jitter), varied
 * lightness, moderate chroma. Locked swatches are kept as-is; their hue seeds the rest.
 */
export function randomPalette(locked: (RGB | null)[], rand: () => number = Math.random): RGB[] {
  const anchor = locked.find(Boolean);
  const baseHue = anchor ? rgbToOklch(anchor).h : rand() * 360;
  const scheme = [0, 30, 150, 180, 210, 330][Math.floor(rand() * 6)];
  return locked.map((c, i) => {
    if (c) return c;
    const h = mod(baseHue + (i % 2 ? scheme : 0) + (rand() - 0.5) * 50 + i * 12, 360);
    const l = 0.35 + rand() * 0.55;
    const ch = (0.04 + rand() * 0.16);
    return oklchToRgbGamut({ l, c: Math.min(ch, maxChroma(l, h)), h });
  });
}

// ---------- Tailwind 50–950 scale ----------

export const TW_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
// Averages of Tailwind v4's default palette (OKLCH lightness, and chroma relative to the peak step).
const TW_L = [0.971, 0.934, 0.884, 0.809, 0.706, 0.63, 0.561, 0.496, 0.434, 0.387, 0.27];
const TW_C = [0.055, 0.13, 0.25, 0.47, 0.72, 0.92, 1, 0.93, 0.77, 0.59, 0.375];

export interface ScaleStep { step: number; rgb: RGB; hex: string; oklch: OKLCH; isBase: boolean }

/**
 * Build a 50–950 scale around `base` using Tailwind v4's perceptual lightness curve. The base colour
 * lands exactly on the step whose lightness is closest; the curve is bent smoothly so neighbouring
 * steps stay monotonic, and chroma follows Tailwind's bell shape (clipped to the sRGB gamut).
 */
export function tailwindScale(base: RGB, opts: { anchor?: number | 'auto'; hueShift?: number } = {}): ScaleStep[] {
  const o = rgbToOklch(base);
  let k = TW_L.reduce((best, l, i) => (Math.abs(l - o.l) < Math.abs(TW_L[best] - o.l) ? i : best), 0);
  if (opts.anchor && opts.anchor !== 'auto') {
    const idx = TW_STEPS.indexOf(opts.anchor as (typeof TW_STEPS)[number]);
    if (idx >= 0) k = idx;
  }
  const n = TW_L.length;
  const delta = o.l - TW_L[k];
  const hueShift = opts.hueShift ?? 0;
  return TW_STEPS.map((step, i) => {
    if (i === k) {
      const rgb = clampRgb(base);
      return { step, rgb, hex: rgbToHex(rgb), oklch: o, isBase: true };
    }
    // Weight 1 at the anchor fading to 0 at the ends, so 50 stays near-white and 950 near-black.
    const w = i < k ? i / k : (n - 1 - i) / (n - 1 - k);
    let l = TW_L[i] + delta * w;
    l = clamp(l, 0.12, 0.985);
    const c = o.c * (TW_C[i] / TW_C[k]);
    const h = mod(o.h + hueShift * ((i - k) / (n - 1)), 360);
    const capped = Math.min(c, maxChroma(l, h), 0.37);
    const rgb = oklchToRgbGamut({ l, c: capped, h });
    const rounded = { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b) };
    return { step, rgb: rounded, hex: rgbToHex(rounded), oklch: rgbToOklch(rounded), isBase: false };
  });
}

// ---------- gradients ----------

export type GradientType = 'linear' | 'radial' | 'conic';
export interface GradientStop { id: number; color: string; pos: number }
export interface Gradient {
  type: GradientType; angle: number; stops: GradientStop[];
  shape?: 'circle' | 'ellipse'; cx?: number; cy?: number;
}

export function sortedStops(stops: GradientStop[]) {
  return [...stops].sort((a, b) => a.pos - b.pos);
}

export function gradientCss(g: Gradient): string {
  const stops = sortedStops(g.stops).map(s => `${s.color} ${round(s.pos, 1)}%`).join(', ');
  const at = `at ${round(g.cx ?? 50, 1)}% ${round(g.cy ?? 50, 1)}%`;
  if (g.type === 'radial') return `radial-gradient(${g.shape ?? 'circle'} ${at}, ${stops})`;
  if (g.type === 'conic') return `conic-gradient(from ${round(g.angle, 1)}deg ${at}, ${stops})`;
  return `linear-gradient(${round(g.angle, 1)}deg, ${stops})`;
}

const TW_DIRS: Record<number, string> = { 0: 't', 45: 'tr', 90: 'r', 135: 'br', 180: 'b', 225: 'bl', 270: 'l', 315: 'tl' };

/** Tailwind classes: the arbitrary-value form always works; v3 from/via/to when the gradient allows. */
export function gradientTailwind(g: Gradient): { arbitrary: string; utilities: string | null } {
  const arbitrary = `bg-[${gradientCss(g).replace(/,\s*/g, ',').replace(/\s+/g, '_')}]`;
  const s = sortedStops(g.stops);
  const dir = TW_DIRS[mod(Math.round(g.angle), 360)];
  if (g.type !== 'linear' || !dir || s.length < 2 || s.length > 3) return { arbitrary, utilities: null };
  const c = (x: string) => `[${x.replace(/\s+/g, '')}]`;
  const parts = [`bg-gradient-to-${dir}`, `from-${c(s[0].color)}`];
  if (s[0].pos !== 0) parts.push(`from-${round(s[0].pos)}%`);
  if (s.length === 3) { parts.push(`via-${c(s[1].color)}`); if (s[1].pos !== 50) parts.push(`via-${round(s[1].pos)}%`); }
  const last = s[s.length - 1];
  parts.push(`to-${c(last.color)}`);
  if (last.pos !== 100) parts.push(`to-${round(last.pos)}%`);
  return { arbitrary, utilities: parts.join(' ') };
}

/** Colour of a gradient at a position (for inserting a new stop that doesn't change the look). */
export function colorAt(stops: GradientStop[], pos: number): RGBA {
  const s = sortedStops(stops).map(x => ({ pos: x.pos, c: parseColor(x.color) ?? { r: 0, g: 0, b: 0, a: 1 } }));
  if (!s.length) return { r: 0, g: 0, b: 0, a: 1 };
  if (pos <= s[0].pos) return s[0].c;
  for (let i = 1; i < s.length; i++) {
    if (pos <= s[i].pos) {
      const t = (pos - s[i - 1].pos) / Math.max(1e-9, s[i].pos - s[i - 1].pos);
      const a = s[i - 1].c, b = s[i].c;
      return { ...mix(a, b, t), a: a.a + (b.a - a.a) * t };
    }
  }
  return s[s.length - 1].c;
}

/** Normalise any colour string to #rrggbb[aa]; null if unparseable. */
export function toHex(input: string): string | null {
  const c = parseColor(input);
  return c ? rgbToHex(c, c.a) : null;
}
