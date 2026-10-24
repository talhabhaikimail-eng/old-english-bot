// Pure helpers for the Image tools UI (no React, no path aliases) — unit-tested in image.test.ts.
// Several functions mirror src/scripts/tools/image_tools.py so live previews match the server output.

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------- crop box ----------

export interface Box { x: number; y: number; w: number; h: number }
export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Largest centred box of `aspect` (w/h) covering `fill` of the image; free aspect → `fill` of each side. */
export function initialBox(W: number, H: number, aspect: number | null, fill = 0.8): Box {
  let w = W * fill, h = H * fill;
  if (aspect) {
    if (w / h > aspect) w = h * aspect; else h = w / aspect;
  }
  return roundBox({ x: (W - w) / 2, y: (H - h) / 2, w, h });
}

export function roundBox(b: Box): Box {
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.max(1, Math.round(b.w)), h: Math.max(1, Math.round(b.h)) };
}

/** Clamp a box inside W×H (moving first, then shrinking). */
export function clampBox(b: Box, W: number, H: number): Box {
  const w = clamp(b.w, 1, W), h = clamp(b.h, 1, H);
  return { x: clamp(b.x, 0, W - w), y: clamp(b.y, 0, H - h), w, h };
}

/** Re-fit an existing box to a new aspect, keeping its centre where possible. */
export function applyAspect(b: Box, aspect: number | null, W: number, H: number): Box {
  if (!aspect) return b;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  let w = b.w, h = b.w / aspect;
  if (h > H || h > b.h * 1.5) { h = Math.min(b.h, H); w = h * aspect; }
  if (w > W) { w = W; h = w / aspect; }
  if (h > H) { h = H; w = h * aspect; }
  return roundBox(clampBox({ x: cx - w / 2, y: cy - h / 2, w, h }, W, H));
}

/**
 * New crop box after dragging `handle` by (dx, dy) image pixels from the box `s` at drag start.
 * Keeps the box inside W×H and, when `aspect` is set, locks width/height to it (corners anchor the
 * opposite corner, edges keep the perpendicular centre).
 */
export function dragBox(s: Box, handle: Handle, dx: number, dy: number, W: number, H: number, aspect: number | null, min = 4): Box {
  if (handle === 'move') return { ...s, x: clamp(s.x + dx, 0, W - s.w), y: clamp(s.y + dy, 0, H - s.h) };
  const hasN = handle.includes('n'), hasS = handle.includes('s'), hasW = handle.includes('w'), hasE = handle.includes('e');
  let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
  if (hasW) l = clamp(l + dx, 0, r - min);
  if (hasE) r = clamp(r + dx, l + min, W);
  if (hasN) t = clamp(t + dy, 0, b - min);
  if (hasS) b = clamp(b + dy, t + min, H);
  if (!aspect) return { x: l, y: t, w: r - l, h: b - t };

  const corner = (hasN || hasS) && (hasW || hasE);
  if (corner) {
    // Use whichever axis moved more, then fit inside the room available from the anchored corner.
    let w = Math.max(r - l, (b - t) * aspect);
    const maxW = hasW ? s.x + s.w : W - s.x;
    const maxH = hasN ? s.y + s.h : H - s.y;
    w = Math.min(w, maxW, maxH * aspect);
    w = Math.max(w, min * Math.max(1, aspect));
    const h = w / aspect;
    const x = hasW ? s.x + s.w - w : s.x;
    const y = hasN ? s.y + s.h - h : s.y;
    return { x, y, w, h };
  }
  if (hasE || hasW) {
    let w = r - l;
    let h = w / aspect;
    if (h > H) { h = H; w = h * aspect; }
    const cy = s.y + s.h / 2;
    const x = hasW ? s.x + s.w - w : s.x;
    return { x, y: clamp(cy - h / 2, 0, H - h), w, h };
  }
  let h = b - t;
  let w = h * aspect;
  if (w > W) { w = W; h = w / aspect; }
  const cx = s.x + s.w / 2;
  const y = hasN ? s.y + s.h - h : s.y;
  return { x: clamp(cx - w / 2, 0, W - w), y, w, h };
}

export function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : Math.abs(a); }
/** 1920×1080 → "16:9"; awkward ratios fall back to a decimal. */
export function ratioLabel(w: number, h: number): string {
  if (!w || !h) return '—';
  const g = gcd(Math.round(w), Math.round(h));
  const a = Math.round(w) / g, b = Math.round(h) / g;
  return a <= 50 && b <= 50 ? `${a}:${b}` : `${(w / h).toFixed(3)}:1`;
}

// ---------- resize (mirrors image_tools.resize_op) ----------

export interface ResizeOpts {
  mode: 'maxside' | 'exact' | 'percent';
  maxSide?: number; width?: number; height?: number; percent?: number;
  fit?: 'contain' | 'cover' | 'fill' | 'inside'; noUpscale?: boolean;
}

export function resizeTarget(W: number, H: number, o: ResizeOpts): { w: number; h: number } {
  const noUp = o.noUpscale ?? true;
  if (o.mode === 'percent') {
    let p = clamp(o.percent ?? 50, 0.1, 1000) / 100;
    if (noUp && p > 1) p = 1;
    return { w: Math.max(1, Math.round(W * p)), h: Math.max(1, Math.round(H * p)) };
  }
  if (o.mode === 'maxside') {
    const m = o.maxSide ?? 1200;
    if (m <= 0 || (noUp && Math.max(W, H) <= m)) return { w: W, h: H };
    const s = m / Math.max(W, H);
    return { w: Math.max(1, Math.round(W * s)), h: Math.max(1, Math.round(H * s)) };
  }
  let tw = o.width ?? 0, th = o.height ?? 0;
  if (tw <= 0 && th <= 0) return { w: W, h: H };
  if (tw <= 0) tw = Math.max(1, Math.round((W * th) / H));
  if (th <= 0) th = Math.max(1, Math.round((H * tw) / W));
  const fit = o.fit ?? 'contain';
  if (fit === 'fill') return noUp && (tw > W || th > H) ? { w: Math.min(tw, W), h: Math.min(th, H) } : { w: tw, h: th };
  if (fit === 'cover') return noUp && Math.max(tw / W, th / H) > 1 ? { w: Math.min(tw, W), h: Math.min(th, H) } : { w: tw, h: th };
  let s = Math.min(tw / W, th / H);
  if (noUp) s = Math.min(s, 1);
  const nw = Math.max(1, Math.round(W * s)), nh = Math.max(1, Math.round(H * s));
  return fit === 'inside' ? { w: nw, h: nh } : { w: tw, h: th };
}

// ---------- rotation ----------

/** Canvas size of a W×H image rotated by `deg` with expand (quarter turns are exact). */
export function rotatedBounds(W: number, H: number, deg: number): { w: number; h: number } {
  const a = ((deg % 360) + 360) % 360;
  if (a === 0 || a === 180) return { w: W, h: H };
  if (a === 90 || a === 270) return { w: H, h: W };
  const r = (a * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  return { w: Math.ceil(W * c + H * s - 1e-9), h: Math.ceil(W * s + H * c - 1e-9) };
}

// ---------- watermark layout (mirrors image_tools.apply_watermark) ----------

export type WmPosition = 'tl' | 'tc' | 'tr' | 'ml' | 'c' | 'mr' | 'bl' | 'bc' | 'br' | 'tiled';

/** Font size so that text measuring `widthAt100` px at 100px spans `scalePct` of the image width. */
export function autoFontSize(widthAt100: number, W: number, scalePct: number): number {
  return (100 * W * (clamp(scalePct, 1, 100) / 100)) / Math.max(1, widthAt100);
}

export function markPosition(pos: Exclude<WmPosition, 'tiled'>, W: number, H: number, mw: number, mh: number, marginPct: number) {
  const m = Math.floor((Math.min(W, H) * Math.max(0, marginPct)) / 100);
  const v = pos === 'c' ? 'm' : pos[0];
  const hz = pos === 'c' ? 'c' : pos[pos.length - 1];
  const x = hz === 'l' ? m : hz === 'c' ? Math.floor((W - mw) / 2) : W - mw - m;
  const y = v === 't' ? m : v === 'm' ? Math.floor((H - mh) / 2) : H - mh - m;
  return { x, y };
}

export function tilePositions(W: number, H: number, mw: number, mh: number, gapPct: number) {
  const gap = Math.max(0.2, gapPct / 100);
  const sx = Math.max(1, Math.floor(mw * (1 + gap))), sy = Math.max(1, Math.floor(mh * (1 + gap * 2)));
  const out: { x: number; y: number }[] = [];
  let row = 0;
  for (let y = -Math.floor(mh / 2); y < H + mh; y += sy) {
    const off = row % 2 ? Math.floor(sx / 2) : 0;
    for (let x = -Math.floor(mw / 2) - off; x < W + mw; x += sx) out.push({ x, y });
    row++;
    if (out.length > 5000) break;
  }
  return out;
}

// ---------- base64 / data URLs ----------

const MAGIC: [string, (b: Uint8Array) => boolean, string][] = [
  ['image/png', b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, 'png'],
  ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, 'jpg'],
  ['image/gif', b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46, 'gif'],
  ['image/webp', b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP', 'webp'],
  ['image/avif', b => ascii(b, 4, 8) === 'ftyp' && /avi[fs]/.test(ascii(b, 8, 12)), 'avif'],
  ['image/heic', b => ascii(b, 4, 8) === 'ftyp' && /heic|heix|mif1|msf1/.test(ascii(b, 8, 12)), 'heic'],
  ['image/bmp', b => b[0] === 0x42 && b[1] === 0x4d, 'bmp'],
  ['image/x-icon', b => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0, 'ico'],
  ['image/tiff', b => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a), 'tiff'],
];

function ascii(b: Uint8Array, s: number, e: number) {
  let out = '';
  for (let i = s; i < e && i < b.length; i++) out += String.fromCharCode(b[i]);
  return out;
}

export function sniffImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  for (const [mime, test, ext] of MAGIC) if (bytes.length >= 12 && test(bytes)) return { mime, ext };
  const head = ascii(bytes, 0, Math.min(bytes.length, 512)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { mime: 'image/svg+xml', ext: 'svg' };
  return null;
}

export const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/heic': 'heic', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tiff', 'image/svg+xml': 'svg',
};

export function base64ToBytes(b64: string): Uint8Array {
  let s = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}

export type ParsedImage = { mime: string; ext: string; bytes: Uint8Array; declaredMime?: string; warning?: string };

/** Accepts a data URL, raw base64 (whitespace ok), CSS url("data:…") or an <img src="data:…">. */
export function parseBase64Image(input: string): ParsedImage | { error: string } {
  let s = input.trim();
  if (!s) return { error: 'Paste a data URL or Base64 string.' };
  const embedded = /data:[^"')\s]+/.exec(s);
  if (embedded && !s.startsWith('data:')) s = embedded[0];
  let declared: string | undefined;
  let payload = s;
  let isBase64 = true;
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    if (comma < 0) return { error: 'Malformed data URL (missing comma).' };
    const header = s.slice(5, comma);
    declared = header.split(';')[0] || undefined;
    isBase64 = /;base64/i.test(header);
    payload = s.slice(comma + 1);
  }
  let bytes: Uint8Array;
  try {
    bytes = isBase64 ? base64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return { error: 'Not valid Base64 — check for truncated or extra characters.' };
  }
  if (!bytes.length) return { error: 'Decoded to zero bytes.' };
  const sniffed = sniffImage(bytes);
  if (!sniffed && !declared?.startsWith('image/')) return { error: 'Decoded data is not a recognised image (PNG, JPEG, GIF, WebP, AVIF, SVG, BMP, ICO, TIFF).' };
  const mime = sniffed?.mime ?? declared!;
  const ext = sniffed?.ext ?? EXT_FOR_MIME[mime] ?? 'bin';
  const warning = declared && sniffed && declared !== sniffed.mime && !(declared === 'image/jpg' && sniffed.mime === 'image/jpeg')
    ? `Data URL says ${declared} but the bytes are ${sniffed.mime}.` : undefined;
  return { mime, ext, bytes, declaredMime: declared, warning };
}

// ---------- metrics / tables ----------

export function qualityLabel(ssim: number | null | undefined, psnrInf?: boolean): { label: string; tone: 'good' | 'ok' | 'bad' } {
  if (psnrInf || ssim === 1) return { label: 'Identical', tone: 'good' };
  if (ssim == null) return { label: '—', tone: 'ok' };
  if (ssim >= 0.995) return { label: 'Visually lossless', tone: 'good' };
  if (ssim >= 0.985) return { label: 'Excellent', tone: 'good' };
  if (ssim >= 0.96) return { label: 'Good', tone: 'ok' };
  if (ssim >= 0.9) return { label: 'Fair', tone: 'ok' };
  return { label: 'Visible loss', tone: 'bad' };
}

/** Sort a copy of `rows` by `key`; null/undefined always last. */
export function sortRows<T extends Record<string, any>>(rows: T[], key: keyof T, dir: 'asc' | 'desc'): T[] {
  const m = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    const xn = x === null || x === undefined, yn = y === null || y === undefined;
    if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * m;
  });
}

/** Benchmark picks: smallest file meeting an SSIM bar (excludes skipped/errored rows). */
export function bestUnder<T extends { size?: number; ssim?: number | null; psnrInf?: boolean }>(rows: T[], minSsim: number): T | null {
  const ok = rows.filter(r => r.size && (r.psnrInf || (r.ssim ?? 0) >= minSsim));
  return ok.length ? ok.reduce((a, b) => (b.size! < a.size! ? b : a)) : null;
}

/** "about 25 min" style projection for N images at a measured throughput. */
export function projectDuration(n: number, perSecond: number): string {
  if (!perSecond || perSecond <= 0) return '—';
  const sec = n / perSecond;
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}
