// Pure helpers for the Files & Documents tools (no React, no `@/` imports — unit tested with
// node:assert in files.test.ts). The office format matrix mirrors src/libs/tools/docs-office.ts.

// ---------- file kinds & conversion matrix ----------

export type OfficeFamily = 'document' | 'spreadsheet' | 'presentation' | 'pdf';
export type FileKind = OfficeFamily | 'image' | 'audio' | 'video' | 'unknown';

export const OFFICE_FAMILY: Record<string, OfficeFamily> = {
  doc: 'document', docx: 'document', docm: 'document', dot: 'document', dotx: 'document', odt: 'document', ott: 'document',
  rtf: 'document', txt: 'document', html: 'document', htm: 'document', md: 'document', markdown: 'document',
  wpd: 'document', pages: 'document',
  xls: 'spreadsheet', xlsx: 'spreadsheet', xlsm: 'spreadsheet', xlsb: 'spreadsheet', ods: 'spreadsheet', ots: 'spreadsheet',
  csv: 'spreadsheet', tsv: 'spreadsheet', numbers: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', pps: 'presentation', ppsx: 'presentation', odp: 'presentation', otp: 'presentation',
  key: 'presentation',
  pdf: 'pdf',
};

export const OFFICE_TARGETS: Record<OfficeFamily, string[]> = {
  document: ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'epub', 'png'],
  spreadsheet: ['pdf', 'xlsx', 'xls', 'ods', 'csv', 'html', 'png'],
  presentation: ['pdf', 'pptx', 'ppt', 'odp', 'png'],
  pdf: ['docx', 'odt', 'rtf', 'doc'],
};

export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp', 'tif', 'tiff'];
export const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'ts', 'mts', 'm2ts', 'ogv'];
export const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'wma', 'aiff', 'aif', 'amr', 'ac3', 'mka', 'weba', 'caf'];
export const AUDIO_TARGETS = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav'];
export const VIDEO_TARGETS = ['mp4', 'webm', 'mov', 'mkv'];

export function fileExt(name: string): string {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function fileStem(name: string): string {
  const base = name.split(/[\\/]/).pop() || name;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

export function kindOf(name: string): FileKind {
  const ext = fileExt(name);
  if (OFFICE_FAMILY[ext]) return OFFICE_FAMILY[ext];
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return 'unknown';
}

export const KIND_LABEL: Record<FileKind, string> = {
  document: 'Document', spreadsheet: 'Spreadsheet', presentation: 'Presentation', pdf: 'PDF',
  image: 'Image', audio: 'Audio', video: 'Video', unknown: 'Unsupported',
};

/** How one target is produced for one kind of input. */
export interface ConversionPlan {
  converter: string;
  options: Record<string, unknown>;
  /** Converter's own max files per job. */
  maxFiles: number;
}

const HTMLISH = ['html', 'htm', 'md', 'markdown'];

/** Targets offered for a single file (by extension), in display order. */
export function targetsForFile(name: string): string[] {
  const ext = fileExt(name);
  const kind = kindOf(name);
  switch (kind) {
    case 'document': case 'spreadsheet': case 'presentation': return OFFICE_TARGETS[kind];
    case 'pdf': return [...OFFICE_TARGETS.pdf, 'txt', 'png', 'jpg', 'webp'];
    case 'image': return ['pdf'];
    case 'audio': return AUDIO_TARGETS.filter(t => t !== ext);
    case 'video': return [...VIDEO_TARGETS, 'gif', ...AUDIO_TARGETS];
    default: return [];
  }
}

/** Targets every selected file can be converted to. */
export function commonTargets(names: string[]): string[] {
  if (!names.length) return [];
  let acc = targetsForFile(names[0]);
  for (const n of names.slice(1)) {
    const t = new Set(targetsForFile(n));
    acc = acc.filter(x => t.has(x));
  }
  // Same-format audio conversions are still useful (bitrate / channels); allow them when mixed.
  return acc;
}

export function planFor(name: string, target: string): ConversionPlan | null {
  const ext = fileExt(name);
  const kind = kindOf(name);
  if (!targetsForFile(name).includes(target)) return null;
  if (kind === 'pdf') {
    if (target === 'txt') return { converter: 'pdf-text', options: {}, maxFiles: 20 };
    if (['png', 'jpg', 'webp'].includes(target)) return { converter: 'pdf-to-image', options: { format: target }, maxFiles: 10 };
    return { converter: 'office-convert', options: { target }, maxFiles: 20 };
  }
  if (kind === 'document' && target === 'pdf' && HTMLISH.includes(ext)) return { converter: 'html-to-pdf', options: {}, maxFiles: 20 };
  if (kind === 'document' || kind === 'spreadsheet' || kind === 'presentation') return { converter: 'office-convert', options: { target }, maxFiles: 20 };
  if (kind === 'image') return { converter: 'images-to-pdf', options: {}, maxFiles: 200 };
  if (kind === 'audio') return { converter: 'audio-convert', options: { format: target }, maxFiles: 20 };
  if (kind === 'video') {
    if (VIDEO_TARGETS.includes(target)) return { converter: 'video-convert', options: { format: target }, maxFiles: 5 };
    if (target === 'gif') return { converter: 'video-to-gif', options: { format: 'gif' }, maxFiles: 1 };
    if (target === 'mp3') return { converter: 'video-to-mp3', options: {}, maxFiles: 20 };
    return { converter: 'audio-convert', options: { format: target }, maxFiles: 20 };
  }
  return null;
}

export interface JobBatch<T> { converter: string; options: Record<string, unknown>; files: T[] }

/** Group files into as few jobs as possible (same converter + options, within maxFiles). */
export function planJobs<T extends { name: string }>(files: T[], target: string): { batches: JobBatch<T>[]; unsupported: T[] } {
  const batches: JobBatch<T>[] = [];
  const unsupported: T[] = [];
  for (const f of files) {
    const p = planFor(f.name, target);
    if (!p) { unsupported.push(f); continue; }
    const key = JSON.stringify(p.options);
    const open = batches.find(b => b.converter === p.converter && JSON.stringify(b.options) === key && b.files.length < p.maxFiles);
    if (open) open.files.push(f);
    else batches.push({ converter: p.converter, options: p.options, files: [f] });
  }
  return { batches, unsupported };
}

export const TARGET_LABEL: Record<string, string> = {
  pdf: 'PDF', docx: 'Word (.docx)', doc: 'Word 97 (.doc)', odt: 'OpenDocument (.odt)', rtf: 'Rich Text (.rtf)', txt: 'Plain text',
  html: 'HTML', epub: 'EPUB e-book', png: 'PNG image', jpg: 'JPG image', webp: 'WebP image',
  xlsx: 'Excel (.xlsx)', xls: 'Excel 97 (.xls)', ods: 'OpenDocument (.ods)', csv: 'CSV',
  pptx: 'PowerPoint (.pptx)', ppt: 'PowerPoint 97 (.ppt)', odp: 'OpenDocument (.odp)',
  mp3: 'MP3', m4a: 'M4A (AAC)', aac: 'AAC', ogg: 'OGG Vorbis', opus: 'Opus', flac: 'FLAC', wav: 'WAV',
  mp4: 'MP4 (H.264)', webm: 'WebM (VP9)', mov: 'MOV', mkv: 'MKV', gif: 'Animated GIF',
};

/** Friendly names for missing server requirements reported by /api/tools/capabilities. */
export function describeMissing(missing: string[]): string {
  const names: Record<string, string> = {
    soffice: 'LibreOffice', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', python: 'Python 3',
    'python:fitz': 'PyMuPDF (pip install pymupdf)', 'python:PIL': 'Pillow (pip install pillow)',
    'python:pillow_heif': 'pillow-heif (pip install pillow-heif)', 'python:numpy': 'NumPy',
  };
  return missing.map(m => names[m] ?? m).join(', ');
}

// ---------- page ranges ----------

export type PageRange = [number, number];

/** Mirrors doc_tools.py parse_ranges: "1-3, 5, 8-", "-2", "last"; blank/"all" → whole document. */
export function parsePageRanges(spec: string, pageCount: number): { ranges: PageRange[]; error?: string } {
  const s = spec.trim();
  if (!s || s.toLowerCase() === 'all') return { ranges: pageCount > 0 ? [[1, pageCount]] : [] };
  const ranges: PageRange[] = [];
  for (const raw of s.split(/[,;\s]+/)) {
    const part = raw.trim();
    if (!part) continue;
    let a: number, b: number;
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      a = m[1] ? Number(m[1]) : 1;
      b = m[2] ? Number(m[2]) : pageCount;
    } else if (/^\d+$/.test(part)) {
      a = b = Number(part);
    } else if (part.toLowerCase() === 'last') {
      a = b = pageCount;
    } else {
      return { ranges: [], error: `"${part}" isn't a page range — use forms like 1-3, 5, 8-` };
    }
    if (a < 1 || b < 1) return { ranges: [], error: `Page numbers start at 1 ("${part}")` };
    if (a > b) return { ranges: [], error: `"${part}" is backwards` };
    if (pageCount && a > pageCount) return { ranges: [], error: `"${part}" starts after the last page (${pageCount})` };
    ranges.push([a, pageCount ? Math.min(b, pageCount) : b]);
  }
  if (!ranges.length) return { ranges: [], error: 'No pages selected' };
  return { ranges };
}

export function countPages(ranges: PageRange[]): number {
  const seen = new Set<number>();
  for (const [a, b] of ranges) for (let p = a; p <= b; p++) seen.add(p);
  return seen.size;
}

export interface SplitPart { name: string; pages: number; label: string }

/** Files a split will produce (mirrors cmd_split naming). */
export function describeSplit(
  filename: string, pageCount: number, mode: 'ranges' | 'every' | 'each', opts: { ranges?: string; every?: number; single?: boolean },
): { parts: SplitPart[]; error?: string } {
  if (!pageCount) return { parts: [] };
  const stem = fileStem(filename);
  const w = String(pageCount).length;
  const pad = (n: number) => String(n).padStart(w, '0');
  let groups: PageRange[];
  if (mode === 'ranges') {
    const r = parsePageRanges(opts.ranges ?? '', pageCount);
    if (r.error) return { parts: [], error: r.error };
    if (opts.single) {
      return { parts: [{ name: `${stem}_selected.pdf`, pages: r.ranges.reduce((s, [a, b]) => s + b - a + 1, 0), label: r.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ') }] };
    }
    groups = r.ranges;
  } else if (mode === 'every') {
    const k = Math.max(1, Math.floor(opts.every || 1));
    groups = [];
    for (let a = 1; a <= pageCount; a += k) groups.push([a, Math.min(a + k - 1, pageCount)]);
  } else {
    groups = Array.from({ length: pageCount }, (_, i) => [i + 1, i + 1] as PageRange);
  }
  if (groups.length > 1000) return { parts: [], error: `That would create ${groups.length} files — the limit is 1000` };
  return {
    parts: groups.map(([a, b]) => ({
      name: `${stem}_${a === b ? `p${pad(a)}` : `p${pad(a)}-${pad(b)}`}.pdf`,
      pages: b - a + 1,
      label: a === b ? `page ${a}` : `pages ${a}–${b}`,
    })),
  };
}

// ---------- time ----------

/** "1:02.5", "00:01:02.500", "62.5", "62.5s" → seconds; null when blank; NaN when invalid. */
export function parseTimecode(v: string): number | null {
  const s = v.trim().replace(/s$/i, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m) return NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 75.25 → "1:15.25"; 3725.5 → "1:02:05.50" */
export function formatTimecode(sec: number, digits = 2): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  let s = (sec % 60).toFixed(digits);
  if (Number(s) >= 60) s = (0).toFixed(digits); // rounding edge (59.999)
  const ss = s.padStart(digits ? 3 + digits : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Human duration: 0.4 → "0.4 s", 75 → "1 min 15 s", 3700 → "1 h 1 min". */
export function humanDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 1) return `${(sec * 1000).toFixed(0)} ms`;
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
  return `${Math.floor(sec / 86400)} d ${Math.round((sec % 86400) / 3600)} h`;
}

// ---------- file sizes ----------

export interface SizeUnit { id: string; label: string; bytes: number; system: 'decimal' | 'binary'; bits?: boolean }

export const SIZE_UNITS: SizeUnit[] = [
  { id: 'B', label: 'Bytes (B)', bytes: 1, system: 'decimal' },
  { id: 'KB', label: 'Kilobytes (KB)', bytes: 1e3, system: 'decimal' },
  { id: 'MB', label: 'Megabytes (MB)', bytes: 1e6, system: 'decimal' },
  { id: 'GB', label: 'Gigabytes (GB)', bytes: 1e9, system: 'decimal' },
  { id: 'TB', label: 'Terabytes (TB)', bytes: 1e12, system: 'decimal' },
  { id: 'PB', label: 'Petabytes (PB)', bytes: 1e15, system: 'decimal' },
  { id: 'KiB', label: 'Kibibytes (KiB)', bytes: 1024, system: 'binary' },
  { id: 'MiB', label: 'Mebibytes (MiB)', bytes: 1024 ** 2, system: 'binary' },
  { id: 'GiB', label: 'Gibibytes (GiB)', bytes: 1024 ** 3, system: 'binary' },
  { id: 'TiB', label: 'Tebibytes (TiB)', bytes: 1024 ** 4, system: 'binary' },
  { id: 'PiB', label: 'Pebibytes (PiB)', bytes: 1024 ** 5, system: 'binary' },
  { id: 'bit', label: 'Bits (b)', bytes: 1 / 8, system: 'decimal', bits: true },
  { id: 'Kb', label: 'Kilobits (Kb)', bytes: 1e3 / 8, system: 'decimal', bits: true },
  { id: 'Mb', label: 'Megabits (Mb)', bytes: 1e6 / 8, system: 'decimal', bits: true },
  { id: 'Gb', label: 'Gigabits (Gb)', bytes: 1e9 / 8, system: 'decimal', bits: true },
  { id: 'Tb', label: 'Terabits (Tb)', bytes: 1e12 / 8, system: 'decimal', bits: true },
];

export function toBytes(value: number, unitId: string): number {
  const u = SIZE_UNITS.find(x => x.id === unitId);
  return u ? value * u.bytes : NaN;
}

export function fromBytes(bytes: number, unitId: string): number {
  const u = SIZE_UNITS.find(x => x.id === unitId);
  return u ? bytes / u.bytes : NaN;
}

/** Trim a number for display: 12 significant digits, no exponent below 1e21, no trailing zeros. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e21 || abs < 1e-9) return n.toExponential(6).replace(/\.?0+e/, 'e');
  const s = abs >= 1 ? n.toFixed(Math.max(0, 12 - Math.floor(Math.log10(abs)) - 1)) : n.toPrecision(12);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Best human unit in one system: 1536 binary → "1.5 KiB". */
export function humanSize(bytes: number, system: 'decimal' | 'binary' = 'decimal', digits = 2): string {
  if (!Number.isFinite(bytes)) return '—';
  const base = system === 'binary' ? 1024 : 1000;
  const units = system === 'binary' ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] : ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= base && i < units.length - 1) { v /= base; i++; }
  const num = i === 0 ? String(Math.round(v)) : v.toFixed(digits).replace(/\.?0+$/, '');
  return `${bytes < 0 ? '-' : ''}${num} ${units[i]}`;
}

/** Seconds to move `bytes` over a link of `mbps` megabits/s (decimal) at `efficiency` (0..1]. */
export function transferSeconds(bytes: number, mbps: number, efficiency = 1): number {
  if (!(mbps > 0) || !(efficiency > 0)) return NaN;
  return (bytes * 8) / (mbps * 1e6 * efficiency);
}

// ---------- archives ----------

/** True when an archive entry would escape the extraction folder (zip-slip) or is otherwise unsafe. */
export function unsafeZipPath(name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (name.includes('\\')) {
    if (/(^|\/)\.\.(\/|$)/.test(n)) return 'parent-directory (..) segment';
    return 'backslash in path';
  }
  if (n.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(n)) return 'drive-letter path';
  if (n.split('/').some(seg => seg === '..')) return 'parent-directory (..) segment';
  if (/[\u0000-\u001f]/.test(n)) return 'control characters in name';
  return null;
}

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  compressed: number;
  children: TreeNode[];
}

/** Build a folder tree from flat archive entries, aggregating sizes into folders. */
export function buildTree(entries: { path: string; dir: boolean; size: number; compressed: number }[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dir: true, size: 0, compressed: 0, children: [] };
  for (const e of entries) {
    const parts = e.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let node = root;
    let acc = '';
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const last = i === parts.length - 1;
      const isDir = !last || e.dir;
      let child = node.children.find(c => c.name === part && c.dir === isDir);
      if (!child) {
        child = { name: part, path: isDir ? `${acc}/` : acc, dir: isDir, size: 0, compressed: 0, children: [] };
        node.children.push(child);
      }
      if (!e.dir) { child.size += last ? e.size : 0; }
      node = child;
    });
  }
  const total = (n: TreeNode, entriesByPath: Map<string, { size: number; compressed: number }>): void => {
    if (!n.dir) {
      const e = entriesByPath.get(n.path);
      n.size = e?.size ?? n.size;
      n.compressed = e?.compressed ?? 0;
      return;
    }
    n.children.forEach(c => total(c, entriesByPath));
    n.size = n.children.reduce((s, c) => s + c.size, 0);
    n.compressed = n.children.reduce((s, c) => s + c.compressed, 0);
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
  };
  total(root, new Map(entries.filter(e => !e.dir).map(e => [e.path.replace(/\\/g, '/').replace(/^\/+/, ''), e])));
  return root;
}

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'csv', 'tsv',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'log', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh',
  'bat', 'ps1', 'sql', 'svg', 'env', 'gitignore', 'properties', 'gradle', 'lock', 'rst', 'tex', 'srt', 'vtt']);
const IMAGE_PREVIEW = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);

export function previewKind(name: string): 'text' | 'image' | null {
  const ext = fileExt(name);
  const base = (name.split('/').pop() || '').toLowerCase();
  if (IMAGE_PREVIEW.has(ext)) return 'image';
  if (TEXT_EXT.has(ext) || ['readme', 'license', 'makefile', 'dockerfile', '.gitignore', '.env'].includes(base)) return 'text';
  return null;
}

// ---------- lists ----------

export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= arr.length) return arr;
  const out = arr.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
  return out;
}

// ---------- geo ----------

export function formatDms(deg: number, isLat: boolean): string {
  const hemi = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${d}° ${m}′ ${s.toFixed(2)}″ ${hemi}`;
}

export function osmUrl(lat: number, lon: number, zoom = 16): string {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=${zoom}/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

/** Estimated video bitrate (kbps) needed to hit a target size. */
export function targetVideoKbps(targetMb: number, durationSec: number, audioKbps: number): number {
  if (!(durationSec > 0) || !(targetMb > 0)) return NaN;
  return Math.floor((targetMb * 8192 * 0.96) / durationSec - audioKbps);
}
