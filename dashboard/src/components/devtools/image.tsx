import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Download, FlipHorizontal2, FlipVertical2, Image as ImageIcon, Loader2, Play,
  RotateCcw, RotateCw, Sparkles, Trash2, Upload, ZoomIn,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  MONO, FIXED, Checkbox, CopyButton, ErrorBox, FieldLabel, FileDrop, InfoBox, JobResult, NumberField, OutputRow, Segmented, Stat,
  copyText, downloadBlob, formatBytes, jobsApi, toolsApi, useConverter, useJob, type ToolJob,
} from './shared';
import { CHECKER, ColorField, Slider } from './color';
import { formatHsl, formatOklch, formatRgb, rgbToHex, type RGB } from './lib/color';
import {
  type Box, type Handle, type WmPosition, applyAspect, autoFontSize, bestUnder, bytesToBase64, clampBox, dragBox,
  initialBox, markPosition, parseBase64Image, projectDuration, qualityLabel, ratioLabel, resizeTarget, rotatedBounds,
  roundBox, sortRows, tilePositions,
} from './lib/image';

// Image tools. Heavy work runs on the server (src/libs/tools/image.ts → image_tools.py / sharp);
// previews, cropping UI, colour picking and Base64 run in the browser.

const IMG_ACCEPT = '.jpg,.jpeg,.png,.webp,.avif,.heic,.heif,.gif,.bmp,.tif,.tiff,.ico';
type Fmt = 'jpg' | 'png' | 'webp' | 'avif' | 'heic' | 'gif' | 'bmp' | 'tiff' | 'ico';
const FORMATS: { value: Fmt; label: string; lossy: boolean; alpha: boolean }[] = [
  { value: 'jpg', label: 'JPG', lossy: true, alpha: false }, { value: 'png', label: 'PNG', lossy: false, alpha: true },
  { value: 'webp', label: 'WebP', lossy: true, alpha: true }, { value: 'avif', label: 'AVIF', lossy: true, alpha: true },
  { value: 'heic', label: 'HEIC', lossy: true, alpha: true }, { value: 'gif', label: 'GIF', lossy: false, alpha: true },
  { value: 'bmp', label: 'BMP', lossy: false, alpha: false }, { value: 'tiff', label: 'TIFF', lossy: false, alpha: true },
  { value: 'ico', label: 'ICO', lossy: false, alpha: true },
];
const fmtInfo = (f: string) => FORMATS.find(x => x.value === f);

// ---------- capabilities ----------

interface ImageCaps {
  python: boolean; pillow: boolean; error?: string; cpus: number;
  encode: Partial<Record<Fmt, boolean>>; decode: Partial<Record<Fmt, boolean>>;
  versions: Record<string, string | undefined>;
}
let capsPromise: Promise<ImageCaps> | null = null;
function useImageCaps() {
  const [caps, setCaps] = useState<ImageCaps | null>(null);
  useEffect(() => {
    let alive = true;
    capsPromise ??= toolsApi.get<ImageCaps>('/image/caps').catch(e => { capsPromise = null; throw e; });
    capsPromise.then(c => alive && setCaps(c)).catch(() => {});
    return () => { alive = false; };
  }, []);
  return caps;
}
const canEncode = (caps: ImageCaps | null, f: string) => f === 'keep' || !caps || caps.encode[f as Fmt] !== false;

/** Availability banner for a converter (missing Python modules etc.). */
function useGate(id: string) {
  const { converter, loading, error } = useConverter(id);
  let gate: React.ReactNode = null;
  if (error) gate = <ErrorBox message={`Could not reach the tools backend: ${error}`} />;
  else if (!loading && !converter) gate = <ErrorBox message={`Converter "${id}" is not registered on the server.`} />;
  else if (converter && !converter.available) gate = <ErrorBox message={`This tool can't run on this server yet — missing: ${converter.missing.join(', ')}.`} />;
  return { gate, ready: !!converter?.available };
}

// ---------- sample images (so every tool has something to show immediately) ----------

function canvasToFile(c: HTMLCanvasElement, name: string, type: string, q = 0.95): Promise<File> {
  return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(new File([b], name, { type: b.type || type })) : reject(new Error('Canvas encode failed'))), type, q));
}

/** Synthetic landscape with film grain — compresses like a real photo. */
function drawLandscape(w: number, h: number, hue = 210, seed = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const sky = g.createLinearGradient(0, 0, 0, h * 0.65);
  sky.addColorStop(0, `hsl(${hue} 70% 35%)`);
  sky.addColorStop(0.6, `hsl(${hue + 150} 80% 70%)`);
  sky.addColorStop(1, `hsl(${hue + 170} 90% 80%)`);
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  const sun = g.createRadialGradient(w * 0.7, h * 0.42, 0, w * 0.7, h * 0.42, h * 0.25);
  sun.addColorStop(0, 'rgba(255,250,220,1)'); sun.addColorStop(0.25, 'rgba(255,220,150,0.9)'); sun.addColorStop(1, 'rgba(255,200,150,0)');
  g.fillStyle = sun; g.fillRect(0, 0, w, h);
  [[0.45, 25, 0.55], [0.55, 18, 0.62], [0.68, 10, 0.72]].forEach(([base, l, amp], i) => {
    g.beginPath(); g.moveTo(0, h);
    let y = h * base;
    for (let i = 0; i <= 60; i++) { y += (rnd() - 0.5) * h * 0.05 * amp; y = Math.min(h * (base + 0.12), Math.max(h * (base - 0.15), y)); g.lineTo((i * w) / 60, y); }
    g.lineTo(w, h); g.closePath();
    g.fillStyle = `hsl(${hue + 20 + i * 15} 35% ${l}%)`; g.fill();
  });
  const water = g.createLinearGradient(0, h * 0.78, 0, h);
  water.addColorStop(0, `hsla(${hue} 60% 40% / 0.85)`); water.addColorStop(1, `hsla(${hue} 70% 15% / 0.95)`);
  g.fillStyle = water; g.fillRect(0, h * 0.8, w, h * 0.2);
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(255,240,200,${0.08 + rnd() * 0.2})`; g.fillRect(w * (0.55 + rnd() * 0.3), h * (0.82 + rnd() * 0.16), w * (0.02 + rnd() * 0.08), 2); }
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  // Mild sensor-like grain (strong per-pixel noise would make every lossy codec look bad).
  for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 3; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  g.font = `600 ${Math.round(h * 0.035)}px system-ui, sans-serif`;
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillText('Sample photo', w * 0.04, h * 0.08);
  return c;
}

const sampleJpg = (w = 1600, h = 1067, name = 'sample-landscape.jpg', hue = 210, seed = 1) => canvasToFile(drawLandscape(w, h, hue, seed), name, 'image/jpeg', 0.95);

function sampleLogoSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs>
  <rect width="256" height="256" rx="56" fill="url(#g)"/>
  <path d="M78 176V80h52c22 0 36 12 36 30 0 12-7 21-18 25 14 3 23 13 23 28 0 21-16 35-40 35H78zm28-56h20c9 0 14-5 14-12s-5-12-14-12h-20v24zm0 40h23c10 0 16-5 16-13s-6-13-16-13h-23v26z" fill="#fff"/>
</svg>`;
}
const sampleSvgFile = () => new File([sampleLogoSvg()], 'sample-logo.svg', { type: 'image/svg+xml' });

async function samplePng(): Promise<File> {
  const c = document.createElement('canvas');
  c.width = 800; c.height = 500;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 800, 500);
  grad.addColorStop(0, '#22d3ee'); grad.addColorStop(1, '#a855f7');
  g.fillStyle = grad;
  g.beginPath(); g.roundRect(100, 60, 600, 380, 60); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.9)'; g.font = '700 72px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText('Transparent PNG', 400, 270);
  return canvasToFile(c, 'sample-transparent.png', 'image/png');
}

/** Pre-fill a file list with sample(s) once, unless the user already added files. */
function useSampleFiles(make: (() => Promise<File[]>) | null) {
  const [files, setFiles] = useState<File[]>([]);
  useEffect(() => {
    if (!make) return;
    let alive = true;
    make().then(fs => alive && setFiles(cur => (cur.length ? cur : fs))).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [files, setFiles] as const;
}

function useObjectUrl(blob: Blob | null | undefined) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function useImageSize(url: string) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    setSize(null);
    if (!url) return;
    const img = new Image();
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = url;
  }, [url]);
  return size;
}

/** Object URL of one job output (fetched with auth). */
function useOutputUrl(job: ToolJob | null, filename: string | undefined) {
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    setBlob(null);
    if (!job || job.status !== 'done' || !filename) return;
    const o = job.outputs.find(x => x.filename === filename);
    if (!o) return;
    let alive = true;
    jobsApi.outputBlob(job, o.index).then(b => alive && setBlob(b)).catch(() => {});
    return () => { alive = false; };
  }, [job?.id, job?.status, filename]);
  return useObjectUrl(blob);
}

const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v > 0 ? '−' : v < 0 ? '+' : ''}${Math.abs(v).toFixed(d)}%`);
const psnrText = (r: { psnr?: number | null; psnrInf?: boolean }) => (r.psnrInf ? '∞' : r.psnr == null ? '—' : `${r.psnr.toFixed(1)} dB`);

function QualityBadge({ ssim, psnrInf }: { ssim?: number | null; psnrInf?: boolean }) {
  const q = qualityLabel(ssim, psnrInf);
  return <Badge variant={q.tone === 'bad' ? 'destructive' : q.tone === 'good' ? 'default' : 'secondary'} className="text-[10px] whitespace-nowrap">{q.label}</Badge>;
}

function RunButton({ running, disabled, onClick, children }: { running: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button disabled={running || disabled} onClick={onClick}>
      {running ? <Loader2 className="animate-spin" /> : <Play />}
      {running ? 'Working…' : children}
    </Button>
  );
}

function FormatPicker({ value, onChange, caps, include, allowKeep }: {
  value: string; onChange: (v: string) => void; caps: ImageCaps | null; include?: Fmt[]; allowKeep?: boolean;
}) {
  const list = FORMATS.filter(f => !include || include.includes(f.value));
  return (
    <div className="flex flex-wrap gap-1">
      {allowKeep && <Button size="xs" variant={value === 'keep' ? 'default' : 'outline'} onClick={() => onChange('keep')}>Same as input</Button>}
      {list.map(f => {
        const ok = canEncode(caps, f.value);
        return (
          <Button key={f.value} size="xs" variant={value === f.value ? 'default' : 'outline'} disabled={!ok}
            title={ok ? undefined : `${f.label} encoding isn't available on this server`} onClick={() => onChange(f.value)}>
            {f.label}
          </Button>
        );
      })}
    </div>
  );
}

// ---------- before/after compare ----------

function CompareSlider({ before, after, beforeLabel = 'Original', afterLabel = 'Result', className }: {
  before: string; after: string; beforeLabel?: string; afterLabel?: string; className?: string;
}) {
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [origin, setOrigin] = useState('50% 50%');
  const [broken, setBroken] = useState(false);
  const dragging = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setBroken(false), [after]);
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };
  const style = { transform: `scale(${zoom})`, transformOrigin: origin };
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>Drag to compare{zoom > 1 ? ' · hover to pan the zoom' : ''}</span>
        <div className="flex items-center gap-1">
          <ZoomIn className="size-3.5" />
          {[1, 2, 4].map(z => <Button key={z} size="xs" variant={zoom === z ? 'secondary' : 'ghost'} onClick={() => setZoom(z)}>{z}×</Button>)}
        </div>
      </div>
      <div
        ref={ref}
        className={cn('relative rounded-lg border border-border overflow-hidden select-none touch-none cursor-ew-resize', CHECKER)}
        onPointerDown={e => { dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setSplit(Math.max(0, Math.min(100, at(e).x))); }}
        onPointerMove={e => {
          const p = at(e);
          if (dragging.current) setSplit(Math.max(0, Math.min(100, p.x)));
          else if (zoom > 1) setOrigin(`${p.x}% ${p.y}%`);
        }}
        onPointerUp={() => { dragging.current = false; }}
      >
        <img src={before} alt={beforeLabel} draggable={false} className="block w-full h-auto max-h-[65vh] object-contain" style={style} />
        {!broken && (
          <img src={after} alt={afterLabel} draggable={false} onError={() => setBroken(true)}
            className="absolute inset-0 w-full h-full object-contain" style={{ ...style, clipPath: `inset(0 0 0 ${split}%)` }} />
        )}
        <div className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] pointer-events-none" style={{ left: `${split}%` }}>
          <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 size-7 rounded-full bg-white shadow ring-1 ring-black/30 flex items-center justify-center text-neutral-700 text-xs">⇆</div>
        </div>
        <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{beforeLabel}</span>
        <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{afterLabel}</span>
        {broken && <div className="absolute inset-y-0 right-0 flex items-center justify-center bg-black/50 text-xs text-white p-3 text-center" style={{ left: `${split}%` }}>Your browser can't display this format (e.g. HEIC) — download it to view.</div>}
      </div>
    </div>
  );
}

function SampleButton({ onClick, label = 'Use sample image' }: { onClick: () => void; label?: string }) {
  return <Button variant="ghost" size="xs" onClick={onClick}><Sparkles /> {label}</Button>;
}

function Th({ children, k, sort, onSort, className }: { children: React.ReactNode; k?: string; sort?: { key: string; dir: 'asc' | 'desc' }; onSort?: (k: string) => void; className?: string }) {
  const active = k && sort?.key === k;
  return (
    <th className={cn('px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap', k && 'cursor-pointer hover:text-foreground select-none', className)} onClick={() => k && onSort?.(k)}>
      <span className="inline-flex items-center gap-1">{children}{k && (active ? (sort!.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-30" />)}</span>
    </th>
  );
}

// =============================================================================================
// Image compressor
// =============================================================================================

const PRESETS = [
  { id: 'lossless', title: 'Lossless', desc: 'Strip EXIF / APP markers. Pixels stay bit-identical.', hint: 'JPEG −1–5%' },
  { id: 'near', title: 'Near-lossless', desc: 'SSIM > 0.995 · JPG Q85 · WebP Q85 · AVIF Q75', hint: 'AVIF ≈ −80%' },
  { id: 'web', title: 'Web sweet spot', desc: 'JPG Q75 · WebP Q75 · AVIF Q65 · max 2560 px', hint: 'WebP ≈ −82%' },
  { id: 'aggressive', title: 'Aggressive', desc: 'Q50 · AVIF Q40 · max 1600 px', hint: '−90%+' },
  { id: 'custom', title: 'Custom', desc: 'Your own quality, size and palette.', hint: '' },
] as const;
type PresetId = (typeof PRESETS)[number]['id'];

interface CompressRow {
  file: string; output?: string; error?: string; origSize: number; newSize?: number; savedPct?: number;
  psnr?: number | null; psnrInf?: boolean; ssim?: number | null; width?: number; height?: number;
  origWidth?: number; origHeight?: number; method?: string; format?: string; keptOriginal?: boolean; ms?: number;
}

export function ImageCompressor() {
  const caps = useImageCaps();
  const { gate, ready } = useGate('image-compress');
  const [files, setFiles] = useSampleFiles(() => sampleJpg().then(f => [f]));
  const [preset, setPreset] = useState<PresetId>('web');
  const [format, setFormat] = useState('webp');
  const [quality, setQuality] = useState(80);
  const [maxDim, setMaxDim] = useState(0);
  const [pngColors, setPngColors] = useState(0);
  const [keepMetadata, setKeepMetadata] = useState(false);
  const [keepIcc, setKeepIcc] = useState(true);
  const [neverLarger, setNeverLarger] = useState(true);
  const [resample, setResample] = useState('lanczos');
  const { run, job, running, error, cancel } = useJob();
  const [sel, setSel] = useState(0);

  const rows: CompressRow[] = job?.status === 'done' ? job.meta?.files ?? [] : [];
  const totals = job?.status === 'done' ? job.meta?.totals : null;
  const selRow = rows[sel];
  const beforeUrl = useObjectUrl(files[sel] ?? null);
  const afterUrl = useOutputUrl(job, selRow?.output);

  const go = () => {
    setSel(0);
    run('image-compress', files, {
      preset, format: preset === 'lossless' && !['keep', 'png', 'webp'].includes(format) ? 'keep' : format,
      quality, maxDim, pngColors, keepMetadata, keepIcc, neverLarger, resample,
    });
  };

  return (
    <div className="space-y-4">
      {gate}
      <FileDrop files={files} onFiles={setFiles} accept={IMG_ACCEPT} multiple hint="JPG · PNG · WebP · AVIF · HEIC · GIF · BMP · TIFF — up to 50 images" />
      <div className="flex justify-end -mt-2"><SampleButton onClick={() => sampleJpg().then(f => setFiles([f]))} /></div>

      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {PRESETS.map(p => (
          <button key={p.id} type="button" onClick={() => setPreset(p.id)}
            className={cn('rounded-lg border p-2.5 text-left transition-colors', preset === p.id ? 'border-primary bg-primary/5 ring-1 ring-primary/40' : 'border-border hover:bg-secondary/50')}>
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-semibold">{p.title}</span>
              {p.hint && <span className="text-[10px] text-muted-foreground whitespace-nowrap">{p.hint}</span>}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{p.desc}</p>
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Output format</FieldLabel>
          <FormatPicker value={format} onChange={setFormat} caps={caps} allowKeep include={preset === 'lossless' ? ['png', 'webp'] : ['jpg', 'webp', 'avif', 'heic', 'png']} />
          <p className="text-[11px] text-muted-foreground">
            {preset === 'lossless' ? 'Lossless keeps the format (JPEG marker strip) or re-encodes PNG/WebP losslessly.' : 'AVIF and WebP are typically 2–4× smaller than JPEG at the same visual quality.'}
          </p>
        </div>
        {preset !== 'lossless' && (
          <div className="grid gap-3 grid-cols-2">
            {preset === 'custom' && <Slider className="col-span-2" label="Quality" min={1} max={100} value={quality} onChange={setQuality} />}
            <NumberField label={preset === 'custom' ? 'Max dimension (0 = keep)' : 'Max dimension (0 = preset)'} value={maxDim} min={0} onChange={v => setMaxDim(Math.max(0, v || 0))} suffix="px" />
            <div className="space-y-1.5">
              <FieldLabel>Resampling</FieldLabel>
              <Segmented value={resample} onChange={setResample} options={[{ value: 'lanczos', label: 'Lanczos' }, { value: 'bicubic', label: 'Bicubic' }]} />
            </div>
            {preset === 'custom' && format === 'png' && <NumberField label="PNG palette colours (0 = lossless)" value={pngColors} min={0} max={256} onChange={v => setPngColors(Math.max(0, Math.min(256, v || 0)))} />}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Checkbox checked={keepMetadata} onChange={setKeepMetadata}>Keep EXIF (camera, GPS, dates)</Checkbox>
        <Checkbox checked={keepIcc} onChange={setKeepIcc}>Keep ICC colour profile</Checkbox>
        <Checkbox checked={neverLarger} onChange={setNeverLarger}>Never output a larger file</Checkbox>
      </div>

      <RunButton running={running} disabled={!ready || !files.length} onClick={go}>Compress {files.length > 1 ? `${files.length} images` : 'image'}</RunButton>
      <JobResult job={job?.status === 'done' ? null : job} error={error} running={running} onCancel={cancel} />

      {job?.status === 'done' && totals && (
        <div className="space-y-3">
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            <Stat label="Images" value={totals.count} hint={totals.errors ? `${totals.errors} failed` : `${job.meta.workers} worker(s)`} />
            <Stat label="Before" value={formatBytes(totals.before)} />
            <Stat label="After" value={formatBytes(totals.after)} />
            <Stat label="Saved" value={pct(totals.savedPct)} hint={formatBytes(totals.before - totals.after)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => jobsApi.download(job)}><Download /> {job.outputs.length > 1 ? 'Download all (.zip)' : 'Download'}</Button>
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50">
                <tr><Th>File</Th><Th>Size</Th><Th>Saved</Th><Th>PSNR</Th><Th>SSIM</Th><Th>Dimensions</Th><Th>Method</Th><Th className="w-8"> </Th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} onClick={() => !r.error && setSel(i)} className={cn('border-t border-border cursor-pointer', i === sel ? 'bg-primary/5' : 'hover:bg-secondary/40')}>
                    <td className="px-2 py-1.5 max-w-48 truncate" title={r.file}>{r.output ?? r.file}</td>
                    {r.error ? <td colSpan={7} className="px-2 py-1.5 text-destructive">{r.error}</td> : (
                      <>
                        <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{formatBytes(r.origSize)} → <b>{formatBytes(r.newSize ?? 0)}</b></td>
                        <td className={cn('px-2 py-1.5 tabular-nums font-medium', (r.savedPct ?? 0) > 0 ? 'text-primary' : 'text-destructive')}>{pct(r.savedPct)}</td>
                        <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{psnrText(r)}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap"><span className="tabular-nums mr-1.5">{r.ssim?.toFixed(4) ?? '—'}</span><QualityBadge ssim={r.ssim} psnrInf={r.psnrInf} /></td>
                        <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{r.origWidth === r.width && r.origHeight === r.height ? `${r.width}×${r.height}` : `${r.origWidth}×${r.origHeight} → ${r.width}×${r.height}`}</td>
                        <td className="px-2 py-1.5 text-muted-foreground min-w-40">{r.method}</td>
                        <td className="px-1">
                          <Button variant="ghost" size="icon-xs" title="Download" onClick={e => { e.stopPropagation(); const o = job.outputs.find(x => x.filename === r.output); if (o) jobsApi.download(job, o.index); }}><Download /></Button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selRow && !selRow.error && beforeUrl && afterUrl && (
            <CompareSlider before={beforeUrl} after={afterUrl} beforeLabel={`Original · ${formatBytes(selRow.origSize)}`} afterLabel={`${selRow.format?.toUpperCase()} · ${formatBytes(selRow.newSize ?? 0)}`} />
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================================
// Batch compressor
// =============================================================================================

const BATCH_PROFILES = [
  { id: 'web', label: 'Web standard', desc: 'WebP Q75 · 1200 px', o: { format: 'webp', quality: 75, maxDim: 1200 } },
  { id: 'avif', label: 'AVIF web', desc: 'AVIF Q60 · 1200 px', o: { format: 'avif', quality: 60, maxDim: 1200 } },
  { id: 'retina', label: 'Retina / 2K', desc: 'WebP Q80 · 2560 px', o: { format: 'webp', quality: 80, maxDim: 2560 } },
  { id: 'thumbs', label: 'Thumbnails', desc: 'WebP Q70 · 400 px', o: { format: 'webp', quality: 70, maxDim: 400 } },
  { id: 'jpeg', label: 'JPEG fallback', desc: 'JPG Q80 · 1920 px', o: { format: 'jpg', quality: 80, maxDim: 1920 } },
  { id: 'archive', label: 'Archive', desc: 'Same format · Q90 · full size', o: { format: 'keep', quality: 90, maxDim: 0 } },
] as const;

export function BatchImageCompressor() {
  const caps = useImageCaps();
  const { gate, ready } = useGate('image-batch');
  const [files, setFiles] = useSampleFiles(() => Promise.all([0, 1, 2, 3, 4, 5].map(i => sampleJpg(2400, 1600, `album/sample-${i + 1}.jpg`, (i * 47) % 360, i + 1))));
  const [profile, setProfile] = useState<string>('web');
  const [format, setFormat] = useState('webp');
  const [quality, setQuality] = useState(75);
  const [maxDim, setMaxDim] = useState(1200);
  const [resample, setResample] = useState('lanczos');
  const [fastDecode, setFastDecode] = useState(false);
  const [keepMetadata, setKeepMetadata] = useState(false);
  const [workers, setWorkers] = useState(0);
  const { run, job, running, error, cancel } = useJob();
  const totalIn = files.reduce((s, f) => s + f.size, 0);
  const zips = files.filter(f => f.name.toLowerCase().endsWith('.zip')).length;

  const pick = (id: string) => {
    const p = BATCH_PROFILES.find(x => x.id === id);
    setProfile(id);
    if (p) { setFormat(p.o.format); setQuality(p.o.quality); setMaxDim(p.o.maxDim); }
  };
  const custom = (fn: () => void) => { fn(); setProfile('custom'); };
  const s = job?.status === 'done' ? job.meta?.stats : null;

  return (
    <div className="space-y-4">
      {gate}
      <FileDrop files={files} onFiles={setFiles} accept={`${IMG_ACCEPT},.zip`} multiple
        hint="Up to 500 images and/or .zip archives (folder structure is preserved in the output zip)" />
      <div className="flex flex-wrap items-center justify-between gap-2 -mt-2 text-xs text-muted-foreground">
        <span>{files.length} file{files.length === 1 ? '' : 's'}{zips ? ` (${zips} zip)` : ''} · {formatBytes(totalIn)}</span>
        {files.length > 0 && <Button variant="ghost" size="xs" onClick={() => setFiles([])}><Trash2 /> Clear</Button>}
      </div>

      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
        {BATCH_PROFILES.map(p => (
          <button key={p.id} type="button" onClick={() => pick(p.id)}
            className={cn('rounded-lg border p-2.5 text-left transition-colors', profile === p.id ? 'border-primary bg-primary/5 ring-1 ring-primary/40' : 'border-border hover:bg-secondary/50')}>
            <p className="text-xs font-semibold">{p.label}</p>
            <p className="text-[11px] text-muted-foreground">{p.desc}</p>
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <FieldLabel>Output format</FieldLabel>
            <FormatPicker value={format} onChange={v => custom(() => setFormat(v))} caps={caps} allowKeep include={['webp', 'avif', 'jpg', 'png']} />
          </div>
          <Slider label="Quality" min={1} max={100} value={quality} onChange={v => custom(() => setQuality(v))} />
          <NumberField label="Max dimension (0 = keep size)" value={maxDim} min={0} suffix="px" onChange={v => custom(() => setMaxDim(Math.max(0, v || 0)))} />
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <FieldLabel>Resampling</FieldLabel>
            <Segmented value={resample} onChange={setResample} options={[{ value: 'lanczos', label: 'Lanczos (max quality)' }, { value: 'bicubic', label: 'Bicubic (~20% faster)' }]} />
          </div>
          <NumberField label={`Parallel workers (0 = all ${caps?.cpus ?? ''} cores)`} value={workers} min={0} max={64} onChange={v => setWorkers(Math.max(0, v || 0))} />
          <div className="flex flex-col gap-2">
            <Checkbox checked={fastDecode} onChange={setFastDecode}>Fast JPEG draft decode (~30% faster when downscaling)</Checkbox>
            <Checkbox checked={keepMetadata} onChange={setKeepMetadata}>Keep EXIF metadata</Checkbox>
          </div>
        </div>
      </div>

      <RunButton running={running} disabled={!ready || !files.length} onClick={() => run('image-batch', files, { format, quality, maxDim, resample, fastDecode, keepMetadata, workers })}>
        Compress batch
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />

      {s && (
        <div className="space-y-3">
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            <Stat label="Images" value={s.count} hint={s.errors ? `${s.errors} failed` : s.skipped ? `${s.skipped} non-images skipped` : 'no errors'} />
            <Stat label="Size" value={`${formatBytes(s.before)} → ${formatBytes(s.after)}`} hint={`saved ${formatBytes(s.before - s.after)}`} />
            <Stat label="Reduction" value={pct(s.savedPct)} hint={s.after ? `${(s.before / s.after).toFixed(1)}:1 ratio` : undefined} />
            <Stat label="Throughput" value={`${s.throughput ?? '—'} img/s`} hint={`${s.elapsedSec}s on ${s.workers} worker(s)`} />
          </div>
          {s.throughput > 0 && (
            <InfoBox>
              At this speed: 1,000 images ≈ {projectDuration(1000, s.throughput)} · 10,000 ≈ {projectDuration(10000, s.throughput)}.
              {s.count > 0 && ` Average output ${formatBytes(s.after / s.count)} per image.`}
            </InfoBox>
          )}
          {job!.meta.errors?.length > 0 && (
            <ErrorBox message={job!.meta.errors.slice(0, 20).map((e: any) => `${e.file}: ${e.error}`).join('\n')} />
          )}
          {job!.meta.files?.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border max-h-80">
              <table className="w-full text-xs">
                <thead className="bg-secondary/50 sticky top-0"><tr><Th>Output</Th><Th>Before</Th><Th>After</Th><Th>Saved</Th><Th>Dimensions</Th></tr></thead>
                <tbody>
                  {job!.meta.files.slice(0, 300).map((f: any) => (
                    <tr key={f.output} className="border-t border-border">
                      <td className="px-2 py-1 font-mono truncate max-w-64" title={f.output}>{f.output}</td>
                      <td className="px-2 py-1 tabular-nums">{formatBytes(f.origSize)}</td>
                      <td className="px-2 py-1 tabular-nums">{formatBytes(f.newSize)}</td>
                      <td className="px-2 py-1 tabular-nums text-primary">{pct((1 - f.newSize / f.origSize) * 100)}</td>
                      <td className="px-2 py-1 tabular-nums">{f.width}×{f.height}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================================
// Compression benchmark
// =============================================================================================

const BENCH_CATS = [
  { id: 'lossless', label: 'Lossless' }, { id: 'near', label: 'Near-lossless' }, { id: 'web', label: 'Web sweet spot' },
  { id: 'aggressive', label: 'Aggressive' }, { id: 'resized', label: 'Resolution + format' },
];

interface BenchRow {
  id: string; name: string; category: string; categoryLabel: string; format: string; quality: number | null; notes: string; output: string;
  size?: number; reductionPct?: number; ratio?: number; psnr?: number | null; psnrInf?: boolean; ssim?: number | null; encodeMs?: number;
  width?: number; height?: number; skipped?: string; error?: string;
}

export function CompressionBenchmark() {
  const { gate, ready } = useGate('image-benchmark');
  const [files, setFiles] = useSampleFiles(() => sampleJpg().then(f => [f]));
  const [cats, setCats] = useState<string[]>(BENCH_CATS.map(c => c.id));
  const [parallel, setParallel] = useState(true);
  const { run, job, running, error, cancel } = useJob();
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'id', dir: 'asc' });
  const [filter, setFilter] = useState('all');
  const [selId, setSelId] = useState<string>('');

  const rows: BenchRow[] = job?.status === 'done' ? job.meta?.rows ?? [] : [];
  const orig = job?.status === 'done' ? job.meta?.original : null;
  const visible = useMemo(() => sortRows(rows.filter(r => filter === 'all' || r.category === filter), sort.key as keyof BenchRow, sort.dir), [rows, filter, sort]);
  // Prefer real re-encodes over the lossless rows (a marker strip "wins" near-lossless with ~0% saving).
  const lossy = rows.filter(r => r.category !== 'lossless');
  const near = bestUnder(lossy, 0.995) ?? bestUnder(rows, 0.995);
  const webPick = bestUnder(lossy, 0.985) ?? bestUnder(rows, 0.985);
  const sel = rows.find(r => r.id === selId) ?? webPick ?? rows.find(r => r.size);
  const beforeUrl = useObjectUrl(files[0] ?? null);
  const afterUrl = useOutputUrl(job, sel?.size ? sel.output : undefined);
  const onSort = (key: string) => setSort(s => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
  const maxSize = Math.max(orig?.size ?? 0, ...rows.map(r => r.size ?? 0));

  return (
    <div className="space-y-4">
      {gate}
      <FileDrop files={files} onFiles={setFiles} accept={IMG_ACCEPT} hint="One image → ~33 encoder profiles (JPEG / WebP / AVIF / HEIC / PNG, resized variants)" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {BENCH_CATS.map(c => (
          <Checkbox key={c.id} checked={cats.includes(c.id)} onChange={v => setCats(cs => (v ? [...cs, c.id] : cs.filter(x => x !== c.id)))}>{c.label}</Checkbox>
        ))}
        <Checkbox checked={parallel} onChange={setParallel}>Parallel (faster; encode times include contention)</Checkbox>
        <SampleButton onClick={() => sampleJpg().then(f => setFiles([f]))} />
      </div>
      <RunButton running={running} disabled={!ready || !files.length || !cats.length}
        onClick={() => { setSelId(''); run('image-benchmark', files, { categories: cats.length === BENCH_CATS.length ? '' : cats.join(','), parallel }); }}>
        Run benchmark
      </RunButton>
      <JobResult job={job?.status === 'done' ? null : job} error={error} running={running} onCancel={cancel} />

      {orig && (
        <div className="space-y-3">
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            <Stat label="Original" value={formatBytes(orig.size)} hint={`${orig.format?.toUpperCase()} · ${orig.width}×${orig.height} (${orig.megapixels} MP)`} />
            <Stat label="Best near-lossless (SSIM ≥ 0.995)" value={near ? formatBytes(near.size!) : '—'} hint={near ? `${near.name} · ${pct(near.reductionPct)}` : 'none qualified'} />
            <Stat label="Best web pick (SSIM ≥ 0.985)" value={webPick ? formatBytes(webPick.size!) : '—'} hint={webPick ? `${webPick.name} · ${pct(webPick.reductionPct)}` : 'none qualified'} />
            <Stat label="Profiles" value={`${rows.filter(r => r.size).length} / ${rows.length}`} hint={`${job!.meta.workers} worker(s)`} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, ...BENCH_CATS.map(c => ({ value: c.id, label: c.label }))]} />
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => jobsApi.download(job!)}><Download /> All variants (.zip)</Button>
            <Button size="sm" variant="outline" onClick={() => {
              const head = 'id,profile,category,format,size_bytes,reduction_pct,ratio,psnr_db,ssim,encode_ms,width,height,notes';
              const csv = [head, ...rows.map(r => [r.id, `"${r.name}"`, r.category, r.format, r.size ?? '', r.reductionPct ?? '', r.ratio ?? '', r.psnrInf ? 'inf' : r.psnr ?? '', r.ssim ?? '', r.encodeMs ?? '', r.width ?? '', r.height ?? '', `"${r.skipped || r.error || r.notes}"`].join(','))].join('\n');
              downloadBlob(csv, 'compression-benchmark.csv', 'text/csv');
            }}><Download /> CSV</Button>
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-secondary/50">
                <tr>
                  <Th k="id" sort={sort} onSort={onSort}>#</Th>
                  <Th k="name" sort={sort} onSort={onSort}>Profile</Th>
                  <Th k="size" sort={sort} onSort={onSort}>Size</Th>
                  <Th k="reductionPct" sort={sort} onSort={onSort}>Reduction</Th>
                  <Th k="ratio" sort={sort} onSort={onSort}>Ratio</Th>
                  <Th k="psnr" sort={sort} onSort={onSort}>PSNR</Th>
                  <Th k="ssim" sort={sort} onSort={onSort}>SSIM</Th>
                  <Th k="encodeMs" sort={sort} onSort={onSort}>Encode</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr key={r.id} onClick={() => r.size && setSelId(r.id)}
                    className={cn('border-t border-border', r.size ? 'cursor-pointer' : 'opacity-60', sel?.id === r.id ? 'bg-primary/5' : r.size && 'hover:bg-secondary/40')}>
                    <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{r.id}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="font-medium">{r.name}</span>
                      <span className="ml-1.5 text-[10px] text-muted-foreground">{r.categoryLabel}</span>
                      {r === near && <Badge className="ml-1.5 text-[9px]">best ≥.995</Badge>}
                      {r === webPick && r !== near && <Badge variant="secondary" className="ml-1.5 text-[9px]">web pick</Badge>}
                    </td>
                    {r.size ? (
                      <>
                        <td className="px-2 py-1.5 min-w-28">
                          <div className="tabular-nums">{formatBytes(r.size)}</div>
                          <div className="mt-0.5 h-1 rounded-full bg-secondary overflow-hidden"><div className={cn('h-full', (r.reductionPct ?? 0) >= 0 ? 'bg-primary' : 'bg-destructive')} style={{ width: `${Math.min(100, (r.size / maxSize) * 100)}%` }} /></div>
                        </td>
                        <td className={cn('px-2 py-1.5 tabular-nums', (r.reductionPct ?? 0) < 0 && 'text-destructive')}>{pct(r.reductionPct)}</td>
                        <td className="px-2 py-1.5 tabular-nums">{r.ratio?.toFixed(2)}×</td>
                        <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{psnrText(r)}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap"><span className="tabular-nums mr-1">{r.ssim?.toFixed(4)}</span><QualityBadge ssim={r.ssim} psnrInf={r.psnrInf} /></td>
                        <td className="px-2 py-1.5 tabular-nums">{r.encodeMs != null ? `${Math.round(r.encodeMs)} ms` : '—'}</td>
                        <td className="px-2 py-1.5 text-muted-foreground min-w-48">{r.notes}{r.width && orig && r.width !== orig.width ? ` · ${r.width}×${r.height}` : ''}</td>
                      </>
                    ) : <td colSpan={7} className={cn('px-2 py-1.5', r.error ? 'text-destructive' : 'text-muted-foreground')}>{r.skipped || r.error}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sel && beforeUrl && afterUrl && (
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm">{sel.id} · {sel.name}</CardTitle>
                <CardDescription>{formatBytes(sel.size ?? 0)} · {pct(sel.reductionPct)} · PSNR {psnrText(sel)} · SSIM {sel.ssim?.toFixed(4)} — click a row to compare another profile.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <CompareSlider before={beforeUrl} after={afterUrl} afterLabel={`${sel.format.toUpperCase()}${sel.quality ? ` Q${sel.quality}` : ''}`} />
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => { const o = job!.outputs.find(x => x.filename === sel.output); if (o) jobsApi.download(job!, o.index); }}><Download /> {sel.output}</Button>
                </div>
              </CardContent>
            </Card>
          )}
          <InfoBox>
            Picture element for the best formats: <code className="font-mono">{'<picture><source type="image/avif" srcset="img.avif"><source type="image/webp" srcset="img.webp"><img src="img.jpg" loading="lazy" decoding="async"></picture>'}</code>
          </InfoBox>
        </div>
      )}
    </div>
  );
}

// =============================================================================================
// Format converter (+ fixed presets)
// =============================================================================================

function FileResultsTable({ job }: { job: ToolJob }) {
  const files: any[] = job.meta?.files ?? [];
  if (!files.length) return null;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-secondary/50"><tr><Th>Input</Th><Th>Output</Th><Th>Size</Th><Th>Dimensions</Th><Th>Notes</Th></tr></thead>
        <tbody>
          {files.map((f, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-2 py-1.5 truncate max-w-40" title={f.file}>{f.file}</td>
              {f.error ? <td colSpan={4} className="px-2 py-1.5 text-destructive">{f.error}</td> : (
                <>
                  <td className="px-2 py-1.5 font-mono truncate max-w-40">{f.output}</td>
                  <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{formatBytes(f.origSize)} → {formatBytes(f.newSize)}</td>
                  <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">{f.origWidth === f.width && f.origHeight === f.height ? `${f.width}×${f.height}` : `${f.origWidth}×${f.origHeight} → ${f.width}×${f.height}`}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{f.note ?? (f.frames ? `${f.frames} frames` : '')}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FormatConverter({ fixed, defaultFormat = 'webp', accept = IMG_ACCEPT, sample, note }: {
  fixed?: Fmt; defaultFormat?: Fmt; accept?: string; sample?: () => Promise<File[]>; note?: React.ReactNode;
}) {
  const caps = useImageCaps();
  const { gate, ready } = useGate('image-convert');
  const [files, setFiles] = useSampleFiles(sample ?? null);
  const [format, setFormat] = useState<string>(fixed ?? defaultFormat);
  const [quality, setQuality] = useState(88);
  const [background, setBackground] = useState('#ffffff');
  const [lossless, setLossless] = useState(false);
  const [keepAnimation, setKeepAnimation] = useState(true);
  const { run, job, running, error, cancel } = useJob();
  const info = fmtInfo(format);
  const unsupported = !canEncode(caps, format);

  return (
    <div className="space-y-4">
      {gate}
      {note}
      <FileDrop files={files} onFiles={setFiles} accept={accept} multiple hint={`${accept.split(',').join(' ')} · up to 50 files`} />
      {!fixed && (
        <div className="space-y-1.5">
          <FieldLabel>Convert to</FieldLabel>
          <FormatPicker value={format} onChange={setFormat} caps={caps} />
        </div>
      )}
      {unsupported && <ErrorBox message={`${info?.label} encoding isn't available on this server.`} />}
      <div className="grid gap-4 sm:grid-cols-2">
        {info?.lossy && !lossless && <Slider label="Quality" min={1} max={100} value={quality} onChange={setQuality} />}
        {info && !info.alpha && <ColorField label="Background for transparent areas" value={background} onChange={v => setBackground(v.slice(0, 7))} />}
        <div className="flex flex-col gap-2 justify-end">
          {(format === 'webp' || format === 'avif') && <Checkbox checked={lossless} onChange={setLossless}>Lossless</Checkbox>}
          {(format === 'gif' || format === 'webp') && <Checkbox checked={keepAnimation} onChange={setKeepAnimation}>Keep animation frames</Checkbox>}
          {format === 'ico' && <p className="text-[11px] text-muted-foreground">ICO includes 16–256 px sizes (padded to square). For full favicon sets use the Favicon Generator.</p>}
        </div>
      </div>
      <RunButton running={running} disabled={!ready || !files.length || unsupported}
        onClick={() => run('image-convert', files, { format, quality, background, lossless, keepAnimation })}>
        Convert to {info?.label ?? format.toUpperCase()}
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {job?.status === 'done' && <FileResultsTable job={job} />}
    </div>
  );
}

export function ImageConverter() {
  return <FormatConverter sample={() => sampleJpg(1200, 800).then(f => [f])} />;
}
export function PngToJpg() {
  return <FormatConverter fixed="jpg" accept=".png" sample={() => samplePng().then(f => [f])} note={<InfoBox>Transparent areas are flattened onto the background colour you choose.</InfoBox>} />;
}
export function JpgToPng() {
  return <FormatConverter fixed="png" accept=".jpg,.jpeg,.jfif" sample={() => sampleJpg(1200, 800).then(f => [f])} note={<InfoBox>PNG is lossless — expect larger files than the JPEG for photos (see the Compression Benchmark).</InfoBox>} />;
}
export function WebpToPng() {
  return (
    <FormatConverter fixed="png" accept=".webp"
      sample={() => canvasToFile(drawLandscape(1000, 667), 'sample.webp', 'image/webp', 0.8).then(f => (f.type === 'image/webp' ? [f] : []))} />
  );
}
export function HeicToJpg() {
  const caps = useImageCaps();
  return (
    <FormatConverter fixed="jpg" accept=".heic,.heif"
      note={caps && caps.decode.heic === false
        ? <ErrorBox message="HEIC decoding needs the pillow-heif Python package on the server." />
        : <InfoBox>Converts iPhone HEIC/HEIF photos to JPG, applying the EXIF rotation. Drop up to 50 files.</InfoBox>} />
  );
}

// =============================================================================================
// SVG → raster
// =============================================================================================

export function SvgToRaster() {
  const { gate, ready } = useGate('svg-raster');
  const [files, setFiles] = useSampleFiles(() => Promise.resolve([sampleSvgFile()]));
  const [format, setFormat] = useState('png');
  const [mode, setMode] = useState<'width' | 'scale'>('width');
  const [width, setWidth] = useState(1024);
  const [scale, setScale] = useState(2);
  const [transparent, setTransparent] = useState(true);
  const [background, setBackground] = useState('#ffffff');
  const [quality, setQuality] = useState(90);
  const { run, job, running, error, cancel } = useJob();
  const url = useObjectUrl(files[0] ?? null);
  const size = useImageSize(url);
  const outW = mode === 'width' ? width : size ? Math.round(size.w * scale) : 0;
  const outH = size && outW ? Math.round((size.h * outW) / size.w) : 0;
  const bg = transparent && format !== 'jpg' ? 'transparent' : background;

  return (
    <div className="space-y-4">
      {gate}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-2 min-w-0">
          <FileDrop files={files} onFiles={setFiles} accept=".svg" multiple hint="SVG files · up to 50" />
          {url && (
            <div className={cn('rounded-lg border border-border h-48 flex items-center justify-center p-3', CHECKER)} style={bg !== 'transparent' ? { background: bg } : undefined}>
              <img src={url} alt="SVG preview" className="max-h-full max-w-full" />
            </div>
          )}
          {size && <p className="text-[11px] text-muted-foreground">Intrinsic size {size.w}×{size.h} → output <b>{outW}×{outH}</b> px</p>}
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <FieldLabel>Format</FieldLabel>
            <Segmented value={format} onChange={setFormat} options={[{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WebP' }, { value: 'avif', label: 'AVIF' }]} />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>Size</FieldLabel>
            <Segmented value={mode} onChange={setMode} options={[{ value: 'width', label: 'Width (px)' }, { value: 'scale', label: 'Scale ×' }]} />
          </div>
          {mode === 'width'
            ? <div className="space-y-2">
                <NumberField label="Width" value={width} min={1} max={16384} suffix="px" onChange={v => setWidth(Math.max(1, Math.min(16384, v || 1)))} />
                <div className="flex flex-wrap gap-1">{[64, 128, 256, 512, 1024, 2048, 4096].map(w => <Button key={w} size="xs" variant={width === w ? 'secondary' : 'ghost'} onClick={() => setWidth(w)}>{w}</Button>)}</div>
              </div>
            : <div className="space-y-2">
                <NumberField label="Scale" value={scale} min={0.1} max={64} step={0.5} suffix="×" onChange={v => setScale(Math.max(0.1, Math.min(64, v || 1)))} />
                <div className="flex flex-wrap gap-1">{[1, 2, 3, 4, 8].map(s => <Button key={s} size="xs" variant={scale === s ? 'secondary' : 'ghost'} onClick={() => setScale(s)}>{s}×</Button>)}</div>
              </div>}
          {format !== 'jpg' && <Checkbox checked={transparent} onChange={setTransparent}>Transparent background</Checkbox>}
          {(format === 'jpg' || !transparent) && <ColorField label="Background" value={background} onChange={v => setBackground(v.slice(0, 7))} />}
          {format !== 'png' && <Slider label="Quality" min={1} max={100} value={quality} onChange={setQuality} />}
        </div>
      </div>
      <RunButton running={running} disabled={!ready || !files.length}
        onClick={() => run('svg-raster', files, { format, width: mode === 'width' ? width : 0, scale: mode === 'scale' ? scale : 1, background: bg, quality })}>
        Rasterise
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
    </div>
  );
}

// =============================================================================================
// Resizer
// =============================================================================================

const SIZE_PRESETS: { label: string; w: number; h: number; fit?: 'cover' | 'contain' }[] = [
  { label: 'Full HD 1920×1080', w: 1920, h: 1080, fit: 'cover' }, { label: 'HD 1280×720', w: 1280, h: 720, fit: 'cover' },
  { label: 'Open Graph 1200×630', w: 1200, h: 630, fit: 'cover' }, { label: 'Instagram 1080×1080', w: 1080, h: 1080, fit: 'cover' },
  { label: 'Instagram portrait 1080×1350', w: 1080, h: 1350, fit: 'cover' }, { label: 'Story 1080×1920', w: 1080, h: 1920, fit: 'cover' },
  { label: 'YouTube thumb 1280×720', w: 1280, h: 720, fit: 'cover' }, { label: 'Avatar 512×512', w: 512, h: 512, fit: 'cover' },
];

const FITS = [
  { value: 'contain', label: 'Contain', desc: 'Fit inside, pad to exact size' },
  { value: 'cover', label: 'Cover', desc: 'Fill exactly, crop overflow' },
  { value: 'fill', label: 'Stretch', desc: 'Ignore aspect ratio' },
  { value: 'inside', label: 'Inside', desc: 'Fit inside, no padding' },
] as const;

export function ImageResizer() {
  const caps = useImageCaps();
  const { gate, ready } = useGate('image-resize');
  const [files, setFiles] = useSampleFiles(() => sampleJpg(2400, 1600).then(f => [f]));
  const [mode, setMode] = useState<'maxside' | 'exact' | 'percent'>('maxside');
  const [maxSide, setMaxSide] = useState(1200);
  const [w, setW] = useState(1200);
  const [h, setH] = useState(630);
  const [lock, setLock] = useState(false);
  const [fit, setFit] = useState<'contain' | 'cover' | 'fill' | 'inside'>('cover');
  const [gravity, setGravity] = useState('center');
  const [percent, setPercent] = useState(50);
  const [noUpscale, setNoUpscale] = useState(true);
  const [resample, setResample] = useState('lanczos');
  const [background, setBackground] = useState('transparent');
  const [format, setFormat] = useState('keep');
  const [quality, setQuality] = useState(88);
  const { run, job, running, error, cancel } = useJob();
  const url = useObjectUrl(files[0] ?? null);
  const size = useImageSize(url);
  const target = size ? resizeTarget(size.w, size.h, { mode, maxSide, width: w, height: h, percent, fit, noUpscale }) : null;
  const aspect = size ? size.w / size.h : 1;

  return (
    <div className="space-y-4">
      {gate}
      <FileDrop files={files} onFiles={setFiles} accept={IMG_ACCEPT} multiple hint="Up to 50 images — all get the same settings" />
      <Segmented value={mode} onChange={setMode} options={[{ value: 'maxside', label: 'Max side' }, { value: 'exact', label: 'Exact size' }, { value: 'percent', label: 'Percentage' }]} />

      {mode === 'maxside' && (
        <div className="space-y-2 max-w-md">
          <NumberField label="Longest side" value={maxSide} min={1} suffix="px" onChange={v => setMaxSide(Math.max(1, v || 1))} />
          <div className="flex flex-wrap gap-1">{[320, 640, 800, 1024, 1200, 1600, 1920, 2560, 3840].map(v => <Button key={v} size="xs" variant={maxSide === v ? 'secondary' : 'ghost'} onClick={() => setMaxSide(v)}>{v}</Button>)}</div>
        </div>
      )}
      {mode === 'percent' && (
        <div className="space-y-2 max-w-md">
          <Slider label="Scale" min={1} max={200} value={percent} suffix="%" onChange={setPercent} />
          <div className="flex flex-wrap gap-1">{[10, 25, 33, 50, 75, 150, 200].map(v => <Button key={v} size="xs" variant={percent === v ? 'secondary' : 'ghost'} onClick={() => setPercent(v)}>{v}%</Button>)}</div>
        </div>
      )}
      {mode === 'exact' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <NumberField className="w-32" label="Width" value={w} min={0} suffix="px" onChange={v => { const n = Math.max(0, v || 0); setW(n); if (lock) setH(Math.round(n / aspect)); }} />
            <NumberField className="w-32" label="Height" value={h} min={0} suffix="px" onChange={v => { const n = Math.max(0, v || 0); setH(n); if (lock) setW(Math.round(n * aspect)); }} />
            <Checkbox checked={lock} onChange={v => { setLock(v); if (v) setH(Math.round(w / aspect)); }}>Lock to image aspect</Checkbox>
          </div>
          <div className="flex flex-wrap gap-1">
            {SIZE_PRESETS.map(p => <Button key={p.label} size="xs" variant={w === p.w && h === p.h ? 'secondary' : 'outline'} onClick={() => { setLock(false); setW(p.w); setH(p.h); if (p.fit) setFit(p.fit); }}>{p.label}</Button>)}
          </div>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            {FITS.map(f => (
              <button key={f.value} type="button" onClick={() => setFit(f.value)}
                className={cn('rounded-md border p-2 text-left', fit === f.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50')}>
                <p className="text-xs font-medium">{f.label}</p>
                <p className="text-[11px] text-muted-foreground">{f.desc}</p>
              </button>
            ))}
          </div>
          {fit === 'cover' && (
            <div className="space-y-1.5"><FieldLabel>Crop anchor</FieldLabel>
              <Segmented value={gravity} onChange={setGravity} options={['center', 'top', 'bottom', 'left', 'right'].map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} />
            </div>
          )}
          {fit === 'contain' && (
            <div className="flex flex-wrap items-end gap-3">
              <Checkbox checked={background === 'transparent'} onChange={v => setBackground(v ? 'transparent' : '#ffffff')}>Transparent padding</Checkbox>
              {background !== 'transparent' && <ColorField className="w-56" label="Padding colour" value={background} onChange={v => setBackground(v.slice(0, 7))} />}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Output format</FieldLabel>
          <FormatPicker value={format} onChange={setFormat} caps={caps} allowKeep include={['jpg', 'png', 'webp', 'avif']} />
        </div>
        <div className="space-y-2">
          <div className="space-y-1.5">
            <FieldLabel>Resampling</FieldLabel>
            <Segmented value={resample} onChange={setResample} options={[{ value: 'lanczos', label: 'Lanczos' }, { value: 'bicubic', label: 'Bicubic' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'nearest', label: 'Nearest' }]} />
          </div>
          <Checkbox checked={noUpscale} onChange={setNoUpscale}>Never upscale</Checkbox>
        </div>
        {format !== 'png' && <Slider label="Quality (lossy formats)" min={1} max={100} value={quality} onChange={setQuality} />}
      </div>

      {size && target && (
        <InfoBox>
          {files[0]?.name}: {size.w}×{size.h} → <b className="text-foreground">{target.w}×{target.h}</b> ({ratioLabel(target.w, target.h)})
          {files.length > 1 && ` · other files keep their own aspect ratio rules`}
        </InfoBox>
      )}

      <RunButton running={running} disabled={!ready || !files.length}
        onClick={() => run('image-resize', files, { mode, maxSide, width: w, height: h, fit, gravity, percent, noUpscale, resample, background, format, quality })}>
        Resize {files.length > 1 ? `${files.length} images` : ''}
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
      {job?.status === 'done' && <FileResultsTable job={job} />}
    </div>
  );
}

// =============================================================================================
// Cropper
// =============================================================================================

const ASPECTS: { label: string; v: number | null }[] = [
  { label: 'Free', v: null }, { label: '1:1', v: 1 }, { label: '4:3', v: 4 / 3 }, { label: '3:2', v: 3 / 2 }, { label: '16:9', v: 16 / 9 },
  { label: '9:16', v: 9 / 16 }, { label: '4:5', v: 4 / 5 }, { label: '2:1', v: 2 }, { label: 'OG 1.91:1', v: 1200 / 630 },
];
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_POS: Record<string, string> = {
  nw: 'left-0 top-0 cursor-nwse-resize', n: 'left-1/2 top-0 cursor-ns-resize', ne: 'left-full top-0 cursor-nesw-resize', e: 'left-full top-1/2 cursor-ew-resize',
  se: 'left-full top-full cursor-nwse-resize', s: 'left-1/2 top-full cursor-ns-resize', sw: 'left-0 top-full cursor-nesw-resize', w: 'left-0 top-1/2 cursor-ew-resize',
};

function useSingleImage(make: (() => Promise<File>) | null) {
  const [files, setFiles] = useSampleFiles(make ? () => make().then(f => [f]) : null);
  const file = files[0] ?? null;
  const url = useObjectUrl(file);
  const size = useImageSize(url);
  return { files, setFiles, file, url, size };
}

export function ImageCropper() {
  const caps = useImageCaps();
  const { gate, ready } = useGate('image-crop');
  const { files, setFiles, url, size } = useSingleImage(() => sampleJpg(1600, 1067));
  const [aspect, setAspect] = useState<number | null>(16 / 9);
  const [box, setBox] = useState<Box | null>(null);
  const [format, setFormat] = useState('keep');
  const [quality, setQuality] = useState(92);
  const drag = useRef<{ handle: Handle; sx: number; sy: number; start: Box } | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const { run, job, running, error, cancel, reset } = useJob();

  useEffect(() => { if (size) setBox(initialBox(size.w, size.h, aspect)); reset(); }, [size?.w, size?.h, url]);

  const W = size?.w ?? 1, H = size?.h ?? 1;
  const toImg = (clientX: number, clientY: number) => {
    const r = areaRef.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H, k: W / r.width };
  };
  const start = (e: React.PointerEvent, handle: Handle, b: Box) => {
    e.preventDefault();
    e.stopPropagation();
    areaRef.current!.setPointerCapture(e.pointerId);
    drag.current = { handle, sx: e.clientX, sy: e.clientY, start: b };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !size) return;
    const k = W / areaRef.current!.getBoundingClientRect().width;
    setBox(dragBox(d.start, d.handle, (e.clientX - d.sx) * k, (e.clientY - d.sy) * k, W, H, aspect, 8));
  };
  const b = box ? roundBox(box) : null;
  const setNum = (key: keyof Box, v: number) => box && setBox(clampBox({ ...roundBox(box), [key]: Math.max(0, Math.round(v || 0)) }, W, H));

  return (
    <div className="space-y-4">
      {gate}
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex">
          <input type="file" accept={IMG_ACCEPT} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) setFiles([f]); e.target.value = ''; }} />
          <span className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-secondary"><Upload className="size-3.5" /> Choose image</span>
        </label>
        <span className="text-xs text-muted-foreground truncate max-w-60">{files[0]?.name}</span>
        <SampleButton onClick={() => sampleJpg(1600, 1067).then(f => setFiles([f]))} />
      </div>
      <div className="flex flex-wrap gap-1">
        {ASPECTS.map(a => (
          <Button key={a.label} size="xs" variant={aspect === a.v ? 'default' : 'outline'} onClick={() => { setAspect(a.v); if (box && size) setBox(applyAspect(box, a.v, W, H)); }}>{a.label}</Button>
        ))}
        {size && <Button size="xs" variant="ghost" onClick={() => setBox({ x: 0, y: 0, w: W, h: H })}>Select all</Button>}
      </div>

      {url && size && b && (
        <div className="flex justify-center rounded-lg border border-border bg-secondary/30 p-2 sm:p-4">
          <div
            ref={areaRef}
            className="relative inline-block max-w-full select-none touch-none overflow-hidden"
            onPointerMove={onMove}
            onPointerUp={() => { drag.current = null; }}
            onPointerDown={e => {
              // Drag on the image outside the box draws a new selection.
              const p = toImg(e.clientX, e.clientY);
              start(e, 'se', { x: Math.min(W - 8, p.x), y: Math.min(H - 8, p.y), w: 8, h: aspect ? 8 / aspect : 8 });
            }}
          >
            <img src={url} alt="To crop" draggable={false} className="block max-w-full max-h-[60vh] w-auto h-auto" />
            <div
              className="absolute border border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] cursor-move"
              style={{ left: `${(b.x / W) * 100}%`, top: `${(b.y / H) * 100}%`, width: `${(b.w / W) * 100}%`, height: `${(b.h / H) * 100}%` }}
              onPointerDown={e => start(e, 'move', box!)}
            >
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute left-1/3 inset-y-0 border-l border-white/40" /><div className="absolute left-2/3 inset-y-0 border-l border-white/40" />
                <div className="absolute top-1/3 inset-x-0 border-t border-white/40" /><div className="absolute top-2/3 inset-x-0 border-t border-white/40" />
              </div>
              {HANDLES.map(h => (
                <div key={h} onPointerDown={e => start(e, h, box!)}
                  className={cn('absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-neutral-700 bg-white shadow', HANDLE_POS[h])} />
              ))}
              <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white pointer-events-none">{b.w}×{b.h}</span>
            </div>
          </div>
        </div>
      )}

      {b && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <NumberField label="X" value={b.x} min={0} max={W} onChange={v => setNum('x', v)} suffix="px" />
          <NumberField label="Y" value={b.y} min={0} max={H} onChange={v => setNum('y', v)} suffix="px" />
          <NumberField label="Width" value={b.w} min={1} max={W} onChange={v => setNum('w', v)} suffix="px" />
          <NumberField label="Height" value={b.h} min={1} max={H} onChange={v => setNum('h', v)} suffix="px" />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Output format</FieldLabel>
          <FormatPicker value={format} onChange={setFormat} caps={caps} allowKeep include={['jpg', 'png', 'webp', 'avif']} />
        </div>
        {format !== 'png' && <Slider label="Quality" min={1} max={100} value={quality} onChange={setQuality} />}
      </div>
      {b && size && <p className="text-[11px] text-muted-foreground">Image {W}×{H} · crop {b.w}×{b.h} ({ratioLabel(b.w, b.h)}) at {b.x},{b.y} · drag on the image to draw a new box</p>}
      <RunButton running={running} disabled={!ready || !files.length || !b}
        onClick={() => b && run('image-crop', files, { x: b.x, y: b.y, width: b.w, height: b.h, format, quality })}>
        Crop
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
    </div>
  );
}

// =============================================================================================
// Rotator
// =============================================================================================

export function ImageRotator() {
  const caps = useImageCaps();
  const { gate, ready } = useGate('image-rotate');
  const [files, setFiles] = useSampleFiles(() => sampleJpg(1200, 800).then(f => [f]));
  const url = useObjectUrl(files[0] ?? null);
  const size = useImageSize(url);
  const [angle, setAngle] = useState(15);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [expand, setExpand] = useState(true);
  const [transparent, setTransparent] = useState(true);
  const [fill, setFill] = useState('#ffffff');
  const [format, setFormat] = useState('png');
  const [quality, setQuality] = useState(92);
  const { run, job, running, error, cancel } = useJob();

  const W = size?.w ?? 4, H = size?.h ?? 3;
  const bounds = expand ? rotatedBounds(W, H, angle) : { w: W, h: H };
  const fillValue = transparent ? 'transparent' : fill;
  const loses = transparent && (format === 'jpg' || (format === 'keep' && /\.(jpe?g|bmp)$/i.test(files[0]?.name ?? '')));

  return (
    <div className="space-y-4">
      {gate}
      <FileDrop files={files} onFiles={setFiles} accept={IMG_ACCEPT} multiple hint="Up to 50 images — the same rotation is applied to all; the preview shows the first" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className={cn('rounded-lg border border-border p-3 flex items-center justify-center min-h-64', CHECKER)}>
          {url && size && (
            <div className="relative w-full max-w-xl overflow-hidden" style={{ aspectRatio: `${bounds.w} / ${bounds.h}`, background: transparent ? undefined : fill }}>
              <img src={url} alt="Preview" draggable={false} className="absolute left-1/2 top-1/2 max-w-none"
                style={{ width: `${(W / bounds.w) * 100}%`, transform: `translate(-50%, -50%) rotate(${angle}deg) scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})` }} />
            </div>
          )}
        </div>
        <div className="space-y-3">
          <Slider label="Angle (clockwise)" min={-180} max={180} step={0.5} value={angle} suffix="°" onChange={setAngle} />
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="outline" onClick={() => setAngle(a => ((a - 90 + 540) % 360) - 180)}><RotateCcw /> 90°</Button>
            <Button size="sm" variant="outline" onClick={() => setAngle(a => ((a + 90 + 540) % 360) - 180)}><RotateCw /> 90°</Button>
            <Button size="sm" variant="outline" onClick={() => setAngle(a => ((a + 180 + 540) % 360) - 180)}>180°</Button>
            <Button size="sm" variant="ghost" onClick={() => { setAngle(0); setFlipH(false); setFlipV(false); }}>Reset</Button>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant={flipH ? 'default' : 'outline'} onClick={() => setFlipH(v => !v)}><FlipHorizontal2 /> Flip H</Button>
            <Button size="sm" variant={flipV ? 'default' : 'outline'} onClick={() => setFlipV(v => !v)}><FlipVertical2 /> Flip V</Button>
          </div>
          <Checkbox checked={expand} onChange={setExpand}>Expand canvas to fit (no corners cut off)</Checkbox>
          <Checkbox checked={transparent} onChange={setTransparent}>Transparent corners</Checkbox>
          {!transparent && <ColorField label="Fill colour" value={fill} onChange={v => setFill(v.slice(0, 7))} />}
          <div className="space-y-1.5">
            <FieldLabel>Output format</FieldLabel>
            <FormatPicker value={format} onChange={setFormat} caps={caps} allowKeep include={['png', 'webp', 'jpg', 'avif']} />
          </div>
          {format !== 'png' && <Slider label="Quality" min={1} max={100} value={quality} onChange={setQuality} />}
          {loses && <p className="text-[11px] text-muted-foreground">JPG can't store transparency — corners will be white. Pick PNG/WebP to keep them transparent.</p>}
          {size && <p className="text-[11px] text-muted-foreground">{W}×{H} → {bounds.w}×{bounds.h} px{angle % 90 === 0 ? ' · lossless quarter turn' : ''}</p>}
        </div>
      </div>
      <RunButton running={running} disabled={!ready || !files.length}
        onClick={() => run('image-rotate', files, { angle, flipH, flipV, expand, fill: fillValue, format, quality, background: '#ffffff' })}>
        Apply
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
    </div>
  );
}

// =============================================================================================
// Watermarker
// =============================================================================================

interface WmOpts {
  mode: 'text' | 'logo'; text: string; position: WmPosition; opacity: number; scale: number; fontSize: number;
  margin: number; angle: number; gap: number; color: string; outline: boolean;
}

function luminance(hex: string) {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

/** Canvas preview that mirrors image_tools.apply_watermark (same layout maths from lib/image). */
function drawWatermarkPreview(canvas: HTMLCanvasElement, img: HTMLImageElement, logo: HTMLImageElement | null, o: WmOpts) {
  const maxW = 900;
  const k = Math.min(1, maxW / img.naturalWidth);
  const W = Math.round(img.naturalWidth * k), H = Math.round(img.naturalHeight * k);
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.drawImage(img, 0, 0, W, H);
  let mark: HTMLCanvasElement | null = null;
  const font = (px: number) => `bold ${px}px Arial, "Helvetica Neue", sans-serif`;
  if (o.mode === 'logo') {
    if (!logo) return;
    const tw = Math.max(1, W * (o.scale / 100));
    mark = document.createElement('canvas');
    mark.width = Math.round(tw); mark.height = Math.max(1, Math.round((logo.naturalHeight * tw) / logo.naturalWidth));
    mark.getContext('2d')!.drawImage(logo, 0, 0, mark.width, mark.height);
  } else {
    const text = o.text || '© Watermark';
    g.font = font(100);
    const size = o.fontSize > 0 ? o.fontSize * k : autoFontSize(g.measureText(text).width, W, o.scale);
    const stroke = o.outline ? Math.max(1, Math.round(size / 18)) : 0;
    g.font = font(size);
    const m = g.measureText(text);
    mark = document.createElement('canvas');
    mark.width = Math.ceil(m.width + stroke * 2 + 2);
    mark.height = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + stroke * 2 + 2);
    const mg = mark.getContext('2d')!;
    mg.font = font(size);
    mg.textBaseline = 'alphabetic';
    const x = stroke + 1, y = stroke + 1 + m.actualBoundingBoxAscent;
    if (stroke) { mg.lineWidth = stroke * 2; mg.lineJoin = 'round'; mg.strokeStyle = luminance(o.color) > 128 ? 'rgba(0,0,0,0.63)' : 'rgba(255,255,255,0.63)'; mg.strokeText(text, x, y); }
    mg.fillStyle = o.color;
    mg.fillText(text, x, y);
  }
  if (o.angle) {
    const r = (o.angle * Math.PI) / 180;
    const bw = Math.ceil(Math.abs(mark.width * Math.cos(r)) + Math.abs(mark.height * Math.sin(r)));
    const bh = Math.ceil(Math.abs(mark.width * Math.sin(r)) + Math.abs(mark.height * Math.cos(r)));
    const rc = document.createElement('canvas');
    rc.width = bw; rc.height = bh;
    const rg = rc.getContext('2d')!;
    rg.translate(bw / 2, bh / 2); rg.rotate(r); rg.drawImage(mark, -mark.width / 2, -mark.height / 2);
    mark = rc;
  }
  g.globalAlpha = o.opacity / 100;
  const pts = o.position === 'tiled' ? tilePositions(W, H, mark.width, mark.height, o.gap) : [markPosition(o.position, W, H, mark.width, mark.height, o.margin)];
  pts.forEach(p => g.drawImage(mark!, p.x, p.y));
  g.globalAlpha = 1;
}

function useHtmlImage(url: string) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    setImg(null);
    if (!url) return;
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = url;
  }, [url]);
  return img;
}

export function ImageWatermarker() {
  const caps = useImageCaps();
  const { gate, ready } = useGate('image-watermark');
  const [files, setFiles] = useSampleFiles(() => sampleJpg(1600, 1067).then(f => [f]));
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [o, setO] = useState<WmOpts>({ mode: 'text', text: '© 2025 Your Studio', position: 'br', opacity: 70, scale: 30, fontSize: 0, margin: 3, angle: 0, gap: 60, color: '#ffffff', outline: true });
  const [format, setFormat] = useState('keep');
  const [quality, setQuality] = useState(90);
  const { run, job, running, error, cancel } = useJob();
  const set = (p: Partial<WmOpts>) => setO(prev => ({ ...prev, ...p }));
  const img = useHtmlImage(useObjectUrl(files[0] ?? null));
  const logo = useHtmlImage(useObjectUrl(logoFile));
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { if (img && canvasRef.current) drawWatermarkPreview(canvasRef.current, img, logo, o); }, [img, logo, o]);

  const go = () => {
    const list = [...files];
    if (o.mode === 'logo' && logoFile) {
      const ext = logoFile.name.split('.').pop() || 'png';
      list.push(new File([logoFile], `__wmlogo.${ext}`, { type: logoFile.type }));
    }
    run('image-watermark', list, { ...o, format, quality });
  };

  const grid: Exclude<WmPosition, 'tiled'>[] = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];

  return (
    <div className="space-y-4">
      {gate}
      <FileDrop files={files} onFiles={setFiles} accept={IMG_ACCEPT} multiple hint="Up to 50 images — preview shows the first" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className={cn('rounded-lg border border-border p-2 flex items-center justify-center min-h-48', CHECKER)}>
          {img ? <canvas ref={canvasRef} className="max-w-full max-h-[60vh] h-auto" /> : <p className="text-xs text-muted-foreground">Add an image to preview</p>}
        </div>
        <div className="space-y-3">
          <Segmented value={o.mode} onChange={mode => set({ mode })} options={[{ value: 'text', label: 'Text' }, { value: 'logo', label: 'Logo image' }]} />
          {o.mode === 'text' ? (
            <>
              <div className="space-y-1.5"><FieldLabel>Text</FieldLabel><Input value={o.text} onChange={e => set({ text: e.target.value })} maxLength={200} /></div>
              <div className="grid grid-cols-2 gap-2 items-end">
                <ColorField label="Colour" value={o.color} onChange={v => set({ color: v.slice(0, 7) })} />
                <NumberField label="Font px (0 = auto)" value={o.fontSize} min={0} onChange={v => set({ fontSize: Math.max(0, v || 0) })} />
              </div>
              <Checkbox checked={o.outline} onChange={outline => set({ outline })}>Contrast outline</Checkbox>
            </>
          ) : (
            <div className="space-y-1.5">
              <FieldLabel>Logo (PNG with transparency works best)</FieldLabel>
              <FileDrop files={logoFile ? [logoFile] : []} onFiles={f => setLogoFile(f[0] ?? null)} accept=".png,.webp,.svg,.jpg,.jpeg" label="Drop a logo" />
              {!logoFile && <Button size="xs" variant="ghost" onClick={() => {
                const c = document.createElement('canvas'); c.width = 512; c.height = 512;
                const im = new Image();
                im.onload = () => { c.getContext('2d')!.drawImage(im, 0, 0, 512, 512); canvasToFile(c, 'sample-logo.png', 'image/png').then(setLogoFile); };
                im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sampleLogoSvg());
              }}><Sparkles /> Use sample logo</Button>}
            </div>
          )}
          <div className="space-y-1.5">
            <FieldLabel>Position</FieldLabel>
            <div className="flex items-center gap-3">
              <div className="grid grid-cols-3 gap-1 w-24">
                {grid.map(p => (
                  <button key={p} type="button" title={p} onClick={() => set({ position: p })}
                    className={cn('h-6 rounded border', o.position === p ? 'bg-primary border-primary' : 'border-border hover:bg-secondary')} />
                ))}
              </div>
              <Button size="sm" variant={o.position === 'tiled' ? 'default' : 'outline'} onClick={() => set({ position: 'tiled', angle: o.angle || -30, opacity: Math.min(o.opacity, 35), scale: Math.min(o.scale, 22) })}>Tiled</Button>
            </div>
          </div>
          <Slider label="Opacity" min={0} max={100} value={o.opacity} suffix="%" onChange={opacity => set({ opacity })} />
          <Slider label="Size (% of image width)" min={1} max={100} value={o.scale} suffix="%" onChange={scale => set({ scale, fontSize: 0 })} />
          <Slider label="Angle" min={-90} max={90} value={o.angle} suffix="°" onChange={angle => set({ angle })} />
          {o.position === 'tiled'
            ? <Slider label="Tile spacing" min={20} max={300} value={o.gap} suffix="%" onChange={gap => set({ gap })} />
            : <Slider label="Margin (% of short side)" min={0} max={20} step={0.5} value={o.margin} suffix="%" onChange={margin => set({ margin })} />}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5"><FieldLabel>Output format</FieldLabel><FormatPicker value={format} onChange={setFormat} caps={caps} allowKeep include={['jpg', 'png', 'webp', 'avif']} /></div>
        {format !== 'png' && <Slider label="Quality" min={1} max={100} value={quality} onChange={setQuality} />}
      </div>
      <RunButton running={running} disabled={!ready || !files.length || (o.mode === 'logo' && !logoFile)} onClick={go}>
        Watermark {files.length > 1 ? `${files.length} images` : 'image'}
      </RunButton>
      <JobResult job={job} error={error} running={running} onCancel={cancel} />
    </div>
  );
}

// =============================================================================================
// Favicon generator
// =============================================================================================

export function FaviconGenerator() {
  const { gate, ready } = useGate('favicon');
  const [files, setFiles] = useSampleFiles(() => Promise.resolve([sampleSvgFile()]));
  const [transparent, setTransparent] = useState(true);
  const [background, setBackground] = useState('#ffffff');
  const [padding, setPadding] = useState(0);
  const [shape, setShape] = useState('square');
  const [appName, setAppName] = useState('My App');
  const [shortName, setShortName] = useState('');
  const [themeColor, setThemeColor] = useState('#6366f1');
  const { run, job, running, error, cancel } = useJob();
  const url = useObjectUrl(files[0] ?? null);
  const [icons, setIcons] = useState<{ name: string; url: string; size: number }[]>([]);
  const bg = transparent ? 'transparent' : background;

  useEffect(() => {
    if (job?.status !== 'done') { setIcons([]); return; }
    let alive = true;
    const urls: string[] = [];
    Promise.all(job.outputs.filter(o => o.filename.endsWith('.png') || o.filename === 'favicon.ico').map(async o => {
      const b = await jobsApi.outputBlob(job, o.index);
      const u = URL.createObjectURL(b);
      urls.push(u);
      return { name: o.filename, url: u, size: o.size };
    })).then(list => alive && setIcons(list)).catch(() => {});
    return () => { alive = false; urls.forEach(u => URL.revokeObjectURL(u)); };
  }, [job?.id, job?.status]);

  const radius = shape === 'circle' ? '50%' : shape === 'rounded' ? '18%' : '0';
  const Preview = ({ px, label, r = radius }: { px: number; label: string; r?: string }) => (
    <div className="flex flex-col items-center gap-1">
      <div className={cn('flex items-center justify-center overflow-hidden', bg === 'transparent' && CHECKER)} style={{ width: px, height: px, borderRadius: r, background: bg === 'transparent' ? undefined : bg, padding: `${(padding / 100) * px}px` }}>
        {url && <img src={url} alt="" className="w-full h-full object-contain" />}
      </div>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      {gate}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3 min-w-0">
          <FileDrop files={files} onFiles={setFiles} accept=".svg,.png,.jpg,.jpeg,.webp,.avif,.gif" hint="SVG (best) or a square PNG/JPG ≥ 512 px" />
          <div className="rounded-lg border border-border p-3 space-y-3">
            <div className="flex items-end gap-4 flex-wrap">
              <Preview px={16} label="16" /><Preview px={32} label="32" /><Preview px={48} label="48" /><Preview px={96} label="96" />
              <Preview px={90} label="Apple (180)" r="22%" />
            </div>
            <div className="flex items-center gap-2 rounded-t-md border border-b-0 border-border bg-secondary/60 px-3 py-1.5 w-fit max-w-full">
              <div className="size-4 shrink-0 overflow-hidden" style={{ borderRadius: radius, background: bg === 'transparent' ? undefined : bg, padding: `${(padding / 100) * 16}px` }}>
                {url && <img src={url} alt="" className="w-full h-full object-contain" />}
              </div>
              <span className="text-xs truncate">{appName || 'My App'} — browser tab</span>
            </div>
          </div>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5"><FieldLabel>Shape</FieldLabel>
            <Segmented value={shape} onChange={setShape} options={[{ value: 'square', label: 'Square' }, { value: 'rounded', label: 'Rounded' }, { value: 'circle', label: 'Circle' }]} />
          </div>
          <Slider label="Padding" min={0} max={30} value={padding} suffix="%" onChange={setPadding} />
          <Checkbox checked={transparent} onChange={setTransparent}>Transparent background (apple-touch-icon is always filled)</Checkbox>
          {!transparent && <ColorField label="Background" value={background} onChange={v => setBackground(v.slice(0, 7))} />}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5"><FieldLabel>App name</FieldLabel><Input value={appName} onChange={e => setAppName(e.target.value)} /></div>
            <div className="space-y-1.5"><FieldLabel>Short name</FieldLabel><Input value={shortName} placeholder={appName} onChange={e => setShortName(e.target.value)} /></div>
          </div>
          <ColorField label="Theme colour" value={themeColor} onChange={v => setThemeColor(v.slice(0, 7))} />
        </div>
      </div>
      <RunButton running={running} disabled={!ready || !files.length}
        onClick={() => run('favicon', files, { background: bg, padding, shape, appName, shortName, themeColor })}>
        Generate favicon set
      </RunButton>
      <JobResult job={job?.status === 'done' ? null : job} error={error} running={running} onCancel={cancel} />
      {job?.status === 'done' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{job.outputs.length} files</Badge>
            <Button size="sm" onClick={() => jobsApi.download(job)}><Download /> Download all (.zip)</Button>
          </div>
          <div className="grid gap-2 grid-cols-3 sm:grid-cols-4 lg:grid-cols-6">
            {icons.map(i => {
              const px = Number(/(\d+)x\1/.exec(i.name)?.[1] ?? (i.name.startsWith('apple') ? 180 : 48));
              return (
                <button key={i.name} type="button" title={`Download ${i.name}`}
                  onClick={() => { const o = job.outputs.find(x => x.filename === i.name); if (o) jobsApi.download(job, o.index); }}
                  className={cn('rounded-md border border-border p-2 flex flex-col items-center gap-1 hover:bg-secondary/40 min-w-0')}>
                  <div className={cn('flex items-center justify-center h-16 w-full', CHECKER)}>
                    <img src={i.url} alt={i.name} style={{ width: Math.min(64, px), height: Math.min(64, px), imageRendering: px < 48 ? 'pixelated' : undefined }} />
                  </div>
                  <span className="text-[10px] truncate w-full text-center">{i.name}</span>
                  <span className="text-[10px] text-muted-foreground">{formatBytes(i.size)}</span>
                </button>
              );
            })}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-1.5 min-w-0">
              <FieldLabel action={<CopyButton value={job.meta?.html ?? ''} label="Copy" />}>HTML — paste into &lt;head&gt;</FieldLabel>
              <Textarea readOnly value={job.meta?.html ?? ''} className={cn(MONO, FIXED, 'h-44 bg-secondary/40')} />
            </div>
            <div className="space-y-1.5 min-w-0">
              <FieldLabel action={<CopyButton value={job.meta?.manifest ?? ''} label="Copy" />}>site.webmanifest</FieldLabel>
              <Textarea readOnly value={job.meta?.manifest ?? ''} className={cn(MONO, FIXED, 'h-44 bg-secondary/40')} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================================
// SVG optimizer
// =============================================================================================

const SAMPLE_SVG = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     x="0px" y="0px" width="200px" height="200px" viewBox="0 0 200 200" enable-background="new 0 0 200 200" xml:space="preserve">
  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description about="sample"/></rdf:RDF>
  </metadata>
  <title>Badge</title>
  <defs>
    <linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="0.000000" y1="0.000000" x2="200.000000" y2="200.000000">
      <stop offset="0.000000" style="stop-color:#FF6A00;stop-opacity:1.000000"/>
      <stop offset="1.000000" style="stop-color:#EE0979;stop-opacity:1.000000"/>
    </linearGradient>
    <linearGradient id="unused_gradient"><stop offset="0" stop-color="#000000"/></linearGradient>
  </defs>
  <g id="Group_1">
    <g id="Group_2">
      <rect x="10.000000" y="10.000000" fill="url(#SVGID_1_)" width="180.000000" height="180.000000" rx="40.000000" ry="40.000000"/>
    </g>
  </g>
  <g id="Star" opacity="1.000000">
    <polygon fill="#FFFFFF" stroke="none" points="100.000000,40.000000 117.633600,75.729700 157.063100,81.459000 128.531600,109.270300 135.267000,148.540900 100.000000,130.000000 64.733000,148.540900 71.468400,109.270300 42.936900,81.459000 82.366400,75.729700 "/>
  </g>
  <circle cx="100" cy="100" r="0" fill="#000000"/>
</svg>`;

export function SvgOptimizer() {
  const [svg, setSvg] = useState(SAMPLE_SVG);
  const [opts, setOpts] = useState({
    multipass: true, precision: 2, removeViewBox: false, removeDimensions: false, cleanupIds: true, removeTitle: false,
    removeComments: true, removeMetadata: true, convertColors: true, mergePaths: true, pretty: false, removeXMLNS: false,
  });
  const [res, setRes] = useState<{ svg: string; before: number; after: number; savedPct: number; gzipBefore: number; gzipAfter: number } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!svg.trim()) { setRes(null); setErr(''); return; }
    const my = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      toolsApi.post('/image/svgo', { svg, ...opts })
        .then(r => { if (my === seq.current) { setRes(r); setErr(''); } })
        .catch(e => { if (my === seq.current) { setErr((e as Error).message); setRes(null); } })
        .finally(() => my === seq.current && setBusy(false));
    }, 350);
    return () => clearTimeout(t);
  }, [svg, opts]);

  const toggle = (k: keyof typeof opts, label: string) => (
    <Checkbox checked={!!opts[k]} onChange={v => setOpts(o => ({ ...o, [k]: v }))}>{label}</Checkbox>
  );
  const dataUrl = (s: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {toggle('multipass', 'Multipass')}
        <div className="w-44"><Slider label="Precision" min={0} max={6} value={opts.precision} onChange={precision => setOpts(o => ({ ...o, precision }))} /></div>
        {toggle('removeComments', 'Remove comments')}
        {toggle('removeMetadata', 'Remove metadata')}
        {toggle('cleanupIds', 'Minify IDs')}
        {toggle('convertColors', 'Shorten colours')}
        {toggle('mergePaths', 'Merge paths')}
        {toggle('removeTitle', 'Remove <title>')}
        {toggle('removeDimensions', 'Remove width/height')}
        {toggle('removeViewBox', 'Remove viewBox')}
        {toggle('removeXMLNS', 'Remove xmlns (inline SVG)')}
        {toggle('pretty', 'Pretty print')}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={
            <div className="flex gap-1">
              <label className="inline-flex">
                <input type="file" accept=".svg,image/svg+xml" className="hidden" onChange={async e => { const f = e.target.files?.[0]; if (f) setSvg(await f.text()); e.target.value = ''; }} />
                <span className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-xs hover:bg-secondary"><Upload className="size-3" /> Open .svg</span>
              </label>
              <Button variant="ghost" size="xs" onClick={() => setSvg('')}>Clear</Button>
            </div>
          }>Input SVG</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-72')} value={svg} onChange={e => setSvg(e.target.value)} spellCheck={false} placeholder="<svg …>" />
        </div>
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={
            <div className="flex gap-1 items-center">
              {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
              <CopyButton value={res?.svg ?? ''} label="Copy" />
              <Button variant="ghost" size="xs" disabled={!res} onClick={() => res && downloadBlob(res.svg, 'optimized.svg', 'image/svg+xml')}><Download /> Download</Button>
            </div>
          }>Optimized</FieldLabel>
          {err ? <ErrorBox message={err} /> : <Textarea readOnly className={cn(MONO, FIXED, 'h-72 bg-secondary/40')} value={res?.svg ?? ''} />}
        </div>
      </div>
      {res && (
        <>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            <Stat label="Before" value={formatBytes(res.before)} hint={`gzip ${formatBytes(res.gzipBefore)}`} />
            <Stat label="After" value={formatBytes(res.after)} hint={`gzip ${formatBytes(res.gzipAfter)}`} />
            <Stat label="Saved" value={pct(res.savedPct)} hint={formatBytes(res.before - res.after)} />
            <Stat label="Gzipped saving" value={pct(res.gzipBefore ? (1 - res.gzipAfter / res.gzipBefore) * 100 : 0)} />
          </div>
          <div className="grid gap-3 grid-cols-2">
            {[['Original', svg], ['Optimized', res.svg]].map(([label, s]) => (
              <div key={label} className="space-y-1">
                <p className="text-[11px] text-muted-foreground">{label}</p>
                <div className={cn('h-44 rounded-lg border border-border flex items-center justify-center p-3', CHECKER)}>
                  <img src={dataUrl(s)} alt={label} className="max-h-full max-w-full" />
                </div>
              </div>
            ))}
          </div>
          <Code label="Data URI (for CSS)" value={`url("${dataUrl(res.svg)}")`} />
        </>
      )}
    </div>
  );
}

function Code({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1 min-w-0">
      <FieldLabel action={<CopyButton value={value} />}>{label}</FieldLabel>
      <code className={cn(MONO, 'block rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 break-all max-h-32 overflow-auto')}>{value}</code>
    </div>
  );
}

// =============================================================================================
// Image colour picker + palette extraction
// =============================================================================================

interface Picked { hex: string; rgb: RGB; x: number; y: number }

export function ImageColorPicker() {
  const [file, setFile] = useState<File | null>(null);
  const url = useObjectUrl(file);
  const img = useHtmlImage(url);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; cx: number; cy: number; hex: string; w: number; h: number } | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [history, setHistory] = useState<Picked[]>([]);
  const [count, setCount] = useState(8);
  const [method, setMethod] = useState<'kmeans' | 'median'>('kmeans');
  const [palette, setPalette] = useState<{ hex: string; rgb: [number, number, number]; percent: number }[]>([]);
  const [palErr, setPalErr] = useState('');
  const [palBusy, setPalBusy] = useState(false);

  useEffect(() => { if (!file) sampleJpg(1200, 800).then(f => setFile(cur => cur ?? f)).catch(() => {}); }, []);

  // Paste an image from the clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'));
      const f = item?.getAsFile();
      if (f) setFile(new File([f], f.name || 'pasted.png', { type: f.type }));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  useEffect(() => {
    if (!img || !canvasRef.current) return;
    const k = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = canvasRef.current;
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0, c.width, c.height);
  }, [img]);

  useEffect(() => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('count', String(count));
    form.append('method', method);
    setPalBusy(true);
    const t = setTimeout(() => {
      toolsApi.postForm('/image/palette', form)
        .then(r => { setPalette(r.colors); setPalErr(''); })
        .catch(e => { setPalErr((e as Error).message); setPalette([]); })
        .finally(() => setPalBusy(false));
    }, 200);
    return () => clearTimeout(t);
  }, [file, count, method]);

  const sample = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * c.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * c.height);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const [R, G, B] = g.getImageData(x, y, 1, 1).data;
    const loupe = loupeRef.current;
    if (loupe) {
      const N = 11, Z = 10;
      loupe.width = N * Z; loupe.height = N * Z;
      const lg = loupe.getContext('2d')!;
      lg.imageSmoothingEnabled = false;
      lg.clearRect(0, 0, loupe.width, loupe.height);
      lg.drawImage(c, x - 5, y - 5, N, N, 0, 0, N * Z, N * Z);
      lg.strokeStyle = (R * 0.299 + G * 0.587 + B * 0.114) > 128 ? '#000' : '#fff';
      lg.lineWidth = 2;
      lg.strokeRect(5 * Z, 5 * Z, Z, Z);
    }
    const rgb = { r: R, g: G, b: B };
    return { x, y, cx: e.clientX - r.left, cy: e.clientY - r.top, hex: rgbToHex(rgb), rgb, w: r.width, h: r.height };
  };

  const pick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = sample(e);
    if (!s) return;
    const p = { hex: s.hex, rgb: s.rgb, x: s.x, y: s.y };
    setPicked(p);
    setHistory(h => [p, ...h.filter(x => x.hex !== p.hex)].slice(0, 16));
  };

  const paletteCss = `:root {\n${palette.map((c, i) => `  --image-${i + 1}: ${c.hex};`).join('\n')}\n}\n`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex">
          <input type="file" accept={`${IMG_ACCEPT},.svg`} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ''; }} />
          <span className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-secondary"><Upload className="size-3.5" /> Choose image</span>
        </label>
        <span className="text-xs text-muted-foreground">or paste an image (Ctrl+V) · {file?.name}</span>
        <SampleButton onClick={() => sampleJpg(1200, 800).then(setFile)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div
          className="relative rounded-lg border border-border bg-secondary/30 p-2 flex justify-center"
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}
        >
          <div className="relative inline-block max-w-full">
            <canvas ref={canvasRef} className="block max-w-full max-h-[60vh] w-auto h-auto cursor-crosshair touch-none"
              onPointerMove={e => { const s = sample(e); setHover(s); if (s && e.buttons === 1 && e.pointerType !== 'mouse') pick(e); }}
              onPointerLeave={() => setHover(null)}
              onPointerDown={pick} />
            <div className={cn('pointer-events-none absolute rounded-lg border border-border bg-card shadow-lg overflow-hidden', !hover && 'hidden')}
              style={hover ? { left: hover.cx + (hover.cx > hover.w - 140 ? -130 : 18), top: hover.cy + (hover.cy > hover.h - 150 ? -140 : 18) } : undefined}>
              <canvas ref={loupeRef} className="block size-[110px]" />
              <div className="flex items-center gap-1.5 px-1.5 py-1 text-[10px] font-mono">
                <span className="size-3 rounded-sm border border-border" style={{ background: hover?.hex }} />{hover?.hex}<span className="text-muted-foreground ml-auto">{hover?.x},{hover?.y}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3 min-w-0">
          {picked ? (
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="h-20 flex items-end p-2" style={{ background: picked.hex }}>
                <span className="font-mono text-sm font-semibold" style={{ color: (picked.rgb.r * 0.299 + picked.rgb.g * 0.587 + picked.rgb.b * 0.114) > 128 ? '#000' : '#fff' }}>{picked.hex}</span>
              </div>
              <div className="px-3">
                <OutputRow label="HEX" value={picked.hex} />
                <OutputRow label="RGB" value={formatRgb(picked.rgb)} />
                <OutputRow label="HSL" value={formatHsl(picked.rgb)} />
                <OutputRow label="OKLCH" value={formatOklch(picked.rgb)} />
                <OutputRow label="Pixel" value={`${picked.x}, ${picked.y}`} />
              </div>
            </div>
          ) : <InfoBox>Hover the image for a zoomed loupe, click to pick a pixel.</InfoBox>}
          {history.length > 0 && (
            <div className="space-y-1.5">
              <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setHistory([])}>Clear</Button>}>Picked</FieldLabel>
              <div className="flex flex-wrap gap-1">
                {history.map(h => <button key={h.hex} type="button" title={`${h.hex} — click to copy`} onClick={() => { copyText(h.hex); setPicked(h); }} className="size-7 rounded-md border border-border" style={{ background: h.hex }} />)}
              </div>
            </div>
          )}
        </div>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">Dominant colours {palBusy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}</CardTitle>
          <CardDescription>Extracted on the server from a downsampled copy (transparent pixels ignored).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-48"><Slider label="Colours" min={2} max={16} value={count} onChange={setCount} /></div>
            <Segmented value={method} onChange={setMethod} options={[{ value: 'kmeans', label: 'k-means' }, { value: 'median', label: 'Median cut' }]} />
            {palette.length > 0 && <CopyButton value={paletteCss} label="CSS vars" />}
            {palette.length > 0 && <CopyButton value={JSON.stringify(palette.map(c => c.hex))} label="JSON" />}
          </div>
          {palErr && <ErrorBox message={palErr} />}
          {palette.length > 0 && (
            <>
              <div className="flex h-10 rounded-md overflow-hidden border border-border">
                {palette.map(c => <div key={c.hex} style={{ background: c.hex, width: `${c.percent}%` }} title={`${c.hex} · ${c.percent}%`} />)}
              </div>
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
                {palette.map(c => (
                  <button key={c.hex} type="button" onClick={() => copyText(c.hex)} title="Copy"
                    className="rounded-md border border-border overflow-hidden text-left hover:ring-2 hover:ring-primary/40 min-w-0">
                    <div className="h-12" style={{ background: c.hex }} />
                    <div className="px-1.5 py-1">
                      <p className="font-mono text-[11px]">{c.hex}</p>
                      <p className="text-[10px] text-muted-foreground">{c.percent}% · rgb {c.rgb.join(' ')}</p>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============================================================================================
// Image ⇄ Base64
// =============================================================================================

export function ImageToBase64() {
  const [file, setFile] = useState<File | null>(null);
  const [reencode, setReencode] = useState<'original' | 'webp' | 'jpeg' | 'png'>('original');
  const [maxW, setMaxW] = useState(800);
  const [quality, setQuality] = useState(80);
  const [dataUrl, setDataUrl] = useState('');
  const [err, setErr] = useState('');
  const srcUrl = useObjectUrl(file);
  const img = useHtmlImage(srcUrl);

  useEffect(() => { sampleJpg(480, 320, 'sample.jpg').then(f => setFile(cur => cur ?? f)).catch(() => {}); }, []);

  useEffect(() => {
    if (!file) { setDataUrl(''); return; }
    let alive = true;
    (async () => {
      try {
        if (reencode === 'original' || !img) {
          const buf = new Uint8Array(await file.arrayBuffer());
          if (alive) setDataUrl(`data:${file.type || 'application/octet-stream'};base64,${bytesToBase64(buf)}`);
        } else {
          const k = Math.min(1, maxW / img.naturalWidth);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
          const g = c.getContext('2d')!;
          if (reencode === 'jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
          g.drawImage(img, 0, 0, c.width, c.height);
          const out = c.toDataURL(`image/${reencode}`, quality / 100);
          if (alive) setDataUrl(out);
        }
        if (alive) setErr('');
      } catch (e) { if (alive) setErr((e as Error).message); }
    })();
    return () => { alive = false; };
  }, [file, reencode, maxW, quality, img]);

  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  const big = dataUrl.length > 1_000_000;

  return (
    <div className="space-y-4">
      <FileDrop files={file ? [file] : []} onFiles={f => setFile(f[0] ?? null)} accept="image/*" hint="Encoded in your browser — nothing is uploaded" />
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <FieldLabel>Encode as</FieldLabel>
          <Segmented value={reencode} onChange={setReencode} options={[{ value: 'original', label: 'Original bytes' }, { value: 'webp', label: 'WebP' }, { value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }]} />
        </div>
        {reencode !== 'original' && <NumberField className="w-32" label="Max width" value={maxW} min={1} suffix="px" onChange={v => setMaxW(Math.max(1, v || 1))} />}
        {(reencode === 'webp' || reencode === 'jpeg') && <div className="w-40"><Slider label="Quality" min={1} max={100} value={quality} onChange={setQuality} /></div>}
      </div>
      {err && <ErrorBox message={err} />}
      {dataUrl && (
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className={cn('rounded-lg border border-border h-48 flex items-center justify-center p-2', CHECKER)}><img src={dataUrl} alt="" className="max-h-full max-w-full" /></div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Image" value={formatBytes(bytes)} hint={mime} />
              <Stat label="Base64" value={formatBytes(dataUrl.length)} hint={file ? `${(dataUrl.length / Math.max(1, file.size) * 100).toFixed(0)}% of file` : undefined} />
            </div>
            {img && <p className="text-[11px] text-muted-foreground">{img.naturalWidth}×{img.naturalHeight} source</p>}
          </div>
          <div className="space-y-3 min-w-0">
            {big && <InfoBox>Data URLs over ~1 MB slow down HTML/CSS parsing — consider re-encoding as WebP with a smaller max width.</InfoBox>}
            <div className="space-y-1.5">
              <FieldLabel action={<div className="flex gap-1"><CopyButton value={dataUrl} label="Copy" /><Button variant="ghost" size="xs" onClick={() => downloadBlob(dataUrl, 'image-data-url.txt')}><Download /> .txt</Button></div>}>Data URL</FieldLabel>
              <Textarea readOnly value={dataUrl} className={cn(MONO, FIXED, 'h-28 break-all bg-secondary/40')} />
            </div>
            <Code label="Raw Base64" value={b64.length > 4000 ? b64.slice(0, 4000) + '…' : b64} />
            <div className="flex flex-wrap gap-2">
              <CopyButton value={b64} label="Copy raw Base64" />
              <CopyButton value={`<img src="${dataUrl}" alt="" width="${img?.naturalWidth ?? ''}" height="${img?.naturalHeight ?? ''}">`} label="Copy <img>" />
              <CopyButton value={`background-image: url("${dataUrl}");`} label="Copy CSS" />
              <CopyButton value={`![image](${dataUrl})`} label="Copy Markdown" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Base64ToImage() {
  const [input, setInput] = useState('');
  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    const g = c.getContext('2d')!;
    const gr = g.createLinearGradient(0, 0, 96, 96);
    gr.addColorStop(0, '#22d3ee'); gr.addColorStop(1, '#6366f1');
    g.fillStyle = gr; g.beginPath(); g.roundRect(4, 4, 88, 88, 20); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('64', 48, 52);
    setInput(cur => cur || c.toDataURL('image/png'));
  }, []);

  const parsed = useMemo(() => (input.trim() ? parseBase64Image(input) : null), [input]);
  const ok = parsed && !('error' in parsed) ? parsed : null;
  const blob = useMemo(() => (ok ? new Blob([ok.bytes as BlobPart], { type: ok.mime }) : null), [ok]);
  const url = useObjectUrl(blob);
  const size = useImageSize(url);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-1.5 min-w-0">
        <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setInput('')}>Clear</Button>}>Data URL or Base64</FieldLabel>
        <Textarea className={cn(MONO, FIXED, 'h-72 break-all')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false}
          placeholder="data:image/png;base64,iVBORw0… — raw Base64, CSS url(…) and <img src=…> also work" />
        {parsed && 'error' in parsed && <ErrorBox message={parsed.error} />}
        {ok?.warning && <InfoBox>{ok.warning}</InfoBox>}
      </div>
      <div className="space-y-3 min-w-0">
        <div className={cn('rounded-lg border border-border h-64 flex items-center justify-center p-3', CHECKER)}>
          {url && !broken ? <img src={url} alt="Decoded" className="max-h-full max-w-full" onError={() => setBroken(true)} />
            : <span className="text-xs text-muted-foreground flex items-center gap-1.5"><ImageIcon className="size-4" />{broken ? 'Your browser cannot display this format — download it instead.' : 'Preview'}</span>}
        </div>
        {ok && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Type" value={ok.ext.toUpperCase()} hint={ok.mime} />
              <Stat label="Size" value={formatBytes(ok.bytes.length)} />
              <Stat label="Dimensions" value={size ? `${size.w}×${size.h}` : '—'} />
            </div>
            <Button onClick={() => blob && downloadBlob(blob, `image.${ok.ext}`)}><Download /> Download .{ok.ext}</Button>
          </>
        )}
      </div>
    </div>
  );
}
