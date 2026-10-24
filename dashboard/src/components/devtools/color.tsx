import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Check, Download, Lock, LockOpen, Plus, Repeat, Shuffle, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { CopyButton, FIXED, FieldLabel, MONO, OutputRow, Segmented, copyText, downloadBlob } from './shared';
import {
  HARMONIES, TW_STEPS, colorAt, compositeOver, contrastRatio, formatHsl, formatOklch, formatRgb, gradientCss,
  gradientTailwind, harmony, hslToRgb, parseColor, randomPalette, readableText, rgbToHex, rgbToHsl, rgbToOklch,
  sortedStops, suggestContrast, tailwindScale, toHex, wcag,
  type Gradient, type GradientStop, type GradientType, type Harmony, type RGB, type RGBA,
} from './lib/color';

// Colour tools — all browser-side; maths lives in lib/color.ts (unit-tested).

export const CHECKER = 'bg-[repeating-conic-gradient(#8883_0_25%,transparent_0_50%)] bg-[length:16px_16px]';

const THUMB = '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-neutral-700 [&::-webkit-slider-thumb]:shadow-md [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-neutral-700';

/** Range slider with an optional gradient track (used for hue / saturation / alpha etc.). */
export function Slider({ value, min, max, step = 1, onChange, track, label, suffix, className }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
  track?: string; label?: string; suffix?: string; className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      {label && (
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">{label}</span>
          <span className="tabular-nums">{Number.isInteger(step) ? Math.round(value) : value.toFixed(2)}{suffix}</span>
        </div>
      )}
      <div className="relative h-5 flex items-center">
        <div className={cn('absolute inset-x-0 h-2.5 rounded-full border border-border overflow-hidden', track ? CHECKER : 'bg-secondary')}>
          {track && <div className="absolute inset-0" style={{ background: track }} />}
        </div>
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          className={cn('relative w-full appearance-none !bg-transparent !border-0 !rounded-none focus:!shadow-none cursor-pointer h-5 accent-primary', THUMB)}
        />
      </div>
    </div>
  );
}

/** Native picker + free-text input that accepts any CSS colour; calls onChange with #rrggbb[aa]. */
export function ColorField({ value, onChange, label, className }: {
  value: string; onChange: (hex: string) => void; label?: string; className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(value); }, [value, focused]);
  const valid = !!parseColor(draft);
  return (
    <div className={cn('space-y-1.5 min-w-0', className)}>
      {label && <FieldLabel>{label}</FieldLabel>}
      <div className="flex items-center gap-1.5">
        <label className={cn('relative size-8 shrink-0 rounded-md border border-border overflow-hidden cursor-pointer', CHECKER)} title="Pick colour">
          <span className="absolute inset-0" style={{ background: value }} />
          <input type="color" className="absolute inset-0 opacity-0 cursor-pointer" value={value.slice(0, 7)}
            onChange={e => onChange(e.target.value + (value.length === 9 ? value.slice(7) : ''))} />
        </label>
        <Input
          className={cn(MONO, !valid && 'border-destructive focus-visible:ring-destructive/30')}
          value={draft}
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); setDraft(value); }}
          onChange={e => {
            setDraft(e.target.value);
            const hex = toHex(e.target.value);
            if (hex) onChange(hex);
          }}
          placeholder="#3b82f6, rgb(), hsl(), oklch()…"
        />
      </div>
    </div>
  );
}

const rgbOf = (hex: string): RGBA => parseColor(hex) ?? { r: 0, g: 0, b: 0, a: 1 };

function Code({ label, value, rows: minRows = 1 }: { label: string; value: string; rows?: number }) {
  const rows = minRows > 1 ? Math.max(2, value.split('\n').length) : 1;
  return (
    <div className="space-y-1 min-w-0">
      <FieldLabel action={<CopyButton value={value} />}>{label}</FieldLabel>
      {rows > 1
        ? <Textarea readOnly value={value} className={cn(MONO, FIXED, 'bg-secondary/40')} style={{ height: `${rows * 1.21 + 1.1}rem` }} />
        : <code className={cn(MONO, 'block rounded-md border border-border bg-secondary/40 px-2.5 py-1.5 break-all')}>{value}</code>}
    </div>
  );
}

// =============================================================================================
// Gradient generator
// =============================================================================================

let stopId = 100;
const mk = (color: string, pos: number): GradientStop => ({ id: stopId++, color, pos });

const GRADIENT_PRESETS: { name: string; g: Omit<Gradient, 'stops'> & { stops: [string, number][] } }[] = [
  { name: 'Sunset', g: { type: 'linear', angle: 135, stops: [['#ff7e5f', 0], ['#feb47b', 100]] } },
  { name: 'Ocean', g: { type: 'linear', angle: 120, stops: [['#2e3192', 0], ['#1bffff', 100]] } },
  { name: 'Aurora', g: { type: 'linear', angle: 90, stops: [['#00c9ff', 0], ['#92fe9d', 100]] } },
  { name: 'Grape', g: { type: 'linear', angle: 45, stops: [['#8e2de2', 0], ['#4a00e0', 100]] } },
  { name: 'Peach', g: { type: 'linear', angle: 160, stops: [['#ffecd2', 0], ['#fcb69f', 100]] } },
  { name: 'Instagram', g: { type: 'linear', angle: 45, stops: [['#f09433', 0], ['#dc2743', 50], ['#bc1888', 100]] } },
  { name: 'Midnight', g: { type: 'linear', angle: 180, stops: [['#0f2027', 0], ['#203a43', 50], ['#2c5364', 100]] } },
  { name: 'Lime', g: { type: 'linear', angle: 90, stops: [['#a8e063', 0], ['#56ab2f', 100]] } },
  { name: 'Glow', g: { type: 'radial', angle: 0, shape: 'circle', cx: 50, cy: 40, stops: [['#fde68a', 0], ['#f97316', 45], ['#7c2d12', 100]] } },
  { name: 'Spotlight', g: { type: 'radial', angle: 0, shape: 'ellipse', cx: 50, cy: 0, stops: [['#6366f180', 0], ['#0b1020', 70]] } },
  { name: 'Rainbow', g: { type: 'conic', angle: 0, cx: 50, cy: 50, stops: [['#ff0000', 0], ['#ffff00', 17], ['#00ff00', 33], ['#00ffff', 50], ['#0000ff', 67], ['#ff00ff', 83], ['#ff0000', 100]] } },
  { name: 'Mesh-ish', g: { type: 'conic', angle: 210, cx: 30, cy: 70, stops: [['#22d3ee', 0], ['#a855f7', 33], ['#f43f5e', 66], ['#22d3ee', 100]] } },
];

const fromPreset = (p: (typeof GRADIENT_PRESETS)[number]['g']): Gradient => ({ ...p, stops: p.stops.map(([c, pos]) => mk(c, pos)) });

export function GradientGenerator() {
  const [g, setG] = useState<Gradient>(() => ({ ...fromPreset(GRADIENT_PRESETS[5].g), shape: 'circle', cx: 50, cy: 50 }));
  const [sel, setSel] = useState<number>(g.stops[0].id);
  const barRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<number | null>(null);

  const css = gradientCss(g);
  const tw = gradientTailwind(g);
  const selected = g.stops.find(s => s.id === sel) ?? g.stops[0];
  const set = (patch: Partial<Gradient>) => setG(prev => ({ ...prev, ...patch }));
  const setStop = (id: number, patch: Partial<GradientStop>) => setG(prev => ({ ...prev, stops: prev.stops.map(s => (s.id === id ? { ...s, ...patch } : s)) }));
  const posFromEvent = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)) * 10) / 10;
  };
  const addAt = (pos: number) => {
    const c = colorAt(g.stops, pos);
    const s = mk(rgbToHex(c, c.a), pos);
    setG(prev => ({ ...prev, stops: [...prev.stops, s] }));
    setSel(s.id);
  };
  const removeStop = (id: number) => {
    if (g.stops.length <= 2) return;
    const rest = g.stops.filter(s => s.id !== id);
    setG(prev => ({ ...prev, stops: rest }));
    setSel(rest[0].id);
  };
  const barGradient = `linear-gradient(90deg, ${sortedStops(g.stops).map(s => `${s.color} ${s.pos}%`).join(', ')})`;
  const selRgb = rgbOf(selected.color);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3 min-w-0">
          {/* Preview — click to move the centre of radial/conic gradients */}
          <div
            className={cn('relative h-56 sm:h-72 rounded-lg border border-border overflow-hidden', CHECKER, g.type !== 'linear' && 'cursor-crosshair')}
            onClick={e => {
              if (g.type === 'linear') return;
              const r = e.currentTarget.getBoundingClientRect();
              set({ cx: Math.round(((e.clientX - r.left) / r.width) * 100), cy: Math.round(((e.clientY - r.top) / r.height) * 100) });
            }}
          >
            <div className="absolute inset-0" style={{ background: css }} />
            {g.type !== 'linear' && (
              <div className="absolute size-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white shadow ring-1 ring-black/40 pointer-events-none" style={{ left: `${g.cx}%`, top: `${g.cy}%` }} />
            )}
          </div>

          {/* Stops bar */}
          <div className="space-y-1">
            <FieldLabel action={<span className="text-[11px] text-muted-foreground">Click the bar to add a stop · drag handles to move</span>}>Color stops</FieldLabel>
            <div className="px-2">
              <div
                ref={barRef}
                className={cn('relative h-8 rounded-md border border-border cursor-copy select-none touch-none', CHECKER)}
                onPointerDown={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.bar) addAt(posFromEvent(e.clientX)); }}
              >
                <div data-bar="1" className="absolute inset-0 rounded-md" style={{ background: barGradient }} />
                {g.stops.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    title={`${s.color} at ${s.pos}%`}
                    className={cn('absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-10 w-4 rounded-md border-2 shadow cursor-grab active:cursor-grabbing touch-none',
                      s.id === sel ? 'border-primary ring-2 ring-primary/40 z-10' : 'border-white ring-1 ring-black/30')}
                    style={{ left: `${s.pos}%`, background: s.color }}
                    onPointerDown={e => {
                      e.stopPropagation();
                      setSel(s.id);
                      dragId.current = s.id;
                      (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={e => { if (dragId.current === s.id) setStop(s.id, { pos: posFromEvent(e.clientX) }); }}
                    onPointerUp={() => { dragId.current = null; }}
                    onDoubleClick={() => removeStop(s.id)}
                    onKeyDown={e => {
                      if (e.key === 'ArrowLeft') setStop(s.id, { pos: Math.max(0, s.pos - (e.shiftKey ? 10 : 1)) });
                      if (e.key === 'ArrowRight') setStop(s.id, { pos: Math.min(100, s.pos + (e.shiftKey ? 10 : 1)) });
                      if (e.key === 'Delete' || e.key === 'Backspace') removeStop(s.id);
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Selected stop */}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end rounded-md border border-border p-3">
            <ColorField label="Stop colour" value={selected.color} onChange={hex => setStop(selected.id, { color: hex })} />
            <Slider label="Alpha" min={0} max={100} value={Math.round(selRgb.a * 100)} suffix="%"
              track={`linear-gradient(90deg, transparent, ${rgbToHex(selRgb)})`}
              onChange={v => setStop(selected.id, { color: rgbToHex(selRgb, v / 100) })} />
            <div className="flex items-end gap-1.5">
              <div className="space-y-1.5 w-20">
                <FieldLabel>Position</FieldLabel>
                <Input type="number" min={0} max={100} value={selected.pos} onChange={e => setStop(selected.id, { pos: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
              </div>
              <Button variant="outline" size="icon" title="Remove stop" disabled={g.stops.length <= 2} onClick={() => removeStop(selected.id)}><Trash2 /></Button>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="space-y-3 min-w-0">
          <Segmented<GradientType> value={g.type} onChange={type => set({ type })}
            options={[{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'conic', label: 'Conic' }]} />
          {g.type !== 'radial' && (
            <div className="space-y-2">
              <Slider label={g.type === 'conic' ? 'Start angle' : 'Angle'} min={0} max={360} value={g.angle} suffix="°" onChange={angle => set({ angle })} />
              <div className="flex flex-wrap gap-1">
                {[0, 45, 90, 135, 180, 225, 270, 315].map(a => (
                  <Button key={a} variant={g.angle === a ? 'secondary' : 'ghost'} size="xs" onClick={() => set({ angle: a })}>{a}°</Button>
                ))}
              </div>
            </div>
          )}
          {g.type === 'radial' && (
            <Segmented value={g.shape ?? 'circle'} onChange={shape => set({ shape })} options={[{ value: 'circle', label: 'Circle' }, { value: 'ellipse', label: 'Ellipse' }]} />
          )}
          {g.type !== 'linear' && (
            <div className="grid grid-cols-2 gap-3">
              <Slider label="Center X" min={0} max={100} value={g.cx ?? 50} suffix="%" onChange={cx => set({ cx })} />
              <Slider label="Center Y" min={0} max={100} value={g.cy ?? 50} suffix="%" onChange={cy => set({ cy })} />
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setG(prev => ({ ...prev, stops: prev.stops.map(s => ({ ...s, pos: 100 - s.pos })) }))}><Repeat /> Reverse</Button>
            <Button variant="outline" size="sm" onClick={() => addAt(50)}><Plus /> Add stop</Button>
            <Button variant="outline" size="sm" onClick={() => {
              const p = randomPalette([null, null, null]);
              const stops = p.map((c, i) => mk(rgbToHex(c), i * 50));
              setG(prev => ({ ...prev, stops, angle: Math.round(Math.random() * 8) * 45 }));
              setSel(stops[0].id);
            }}><Shuffle /> Random</Button>
          </div>
          <div className="space-y-1.5">
            <FieldLabel>Presets</FieldLabel>
            <div className="grid grid-cols-6 gap-1.5">
              {GRADIENT_PRESETS.map(p => (
                <button key={p.name} type="button" title={p.name}
                  className="h-9 rounded-md border border-border hover:ring-2 hover:ring-primary/50 transition"
                  style={{ background: gradientCss(fromPreset(p.g)) }}
                  onClick={() => { const ng = { shape: 'circle' as const, cx: 50, cy: 50, ...fromPreset(p.g) }; setG(ng); setSel(ng.stops[0].id); }} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Code label="CSS" value={`background: ${css};`} rows={3} />
        <div className="space-y-3 min-w-0">
          <Code label="Tailwind (arbitrary value)" value={tw.arbitrary} />
          {tw.utilities
            ? <Code label="Tailwind v3 utilities" value={tw.utilities} />
            : <p className="text-[11px] text-muted-foreground">Tailwind from/via/to utilities need a linear gradient at a 45° step with 2–3 stops — use the arbitrary value instead.</p>}
        </div>
      </div>
    </div>
  );
}

// =============================================================================================
// CSS colour generator
// =============================================================================================

export function CssColorGenerator() {
  const [hsl, setHsl] = useState({ h: 217, s: 91, l: 60 });
  const [alpha, setAlpha] = useState(100);
  const [varName, setVarName] = useState('primary');

  const rgb = hslToRgb(hsl);
  const a = alpha / 100;
  const hex = rgbToHex(rgb);
  const hexA = rgbToHex(rgb, a);
  const name = varName.trim().replace(/[^\w-]/g, '-') || 'color';
  const hslChannels = `${Math.round(hsl.h)} ${Math.round(hsl.s)}% ${Math.round(hsl.l)}%`;
  const pure = (h: number, s: number, l: number) => formatHsl(hslToRgb({ h, s, l }));
  const text = readableText(compositeOver({ ...rgb, a }, { r: 255, g: 255, b: 255 }));

  const setFromHex = (v: string) => {
    const c = parseColor(v);
    if (!c) return;
    const x = rgbToHsl(c);
    setHsl({ h: Math.round(x.h), s: Math.round(x.s), l: Math.round(x.l) });
    setAlpha(Math.round(c.a * 100));
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4 min-w-0">
        <div className={cn('relative h-40 rounded-lg border border-border overflow-hidden', CHECKER)}>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1" style={{ background: hexA, color: text }}>
            <span className="text-2xl font-semibold tracking-tight font-mono">{hexA}</span>
            <span className="text-xs opacity-80 font-mono">{formatOklch(rgb, a)}</span>
          </div>
        </div>
        <ColorField label="Paste any colour" value={hexA} onChange={setFromHex} />
        <Slider label="Hue" min={0} max={360} value={hsl.h} suffix="°" onChange={h => setHsl({ ...hsl, h })}
          track={`linear-gradient(90deg, ${[0, 60, 120, 180, 240, 300, 360].map(h => pure(h, hsl.s, hsl.l)).join(', ')})`} />
        <Slider label="Saturation" min={0} max={100} value={hsl.s} suffix="%" onChange={s => setHsl({ ...hsl, s })}
          track={`linear-gradient(90deg, ${pure(hsl.h, 0, hsl.l)}, ${pure(hsl.h, 100, hsl.l)})`} />
        <Slider label="Lightness" min={0} max={100} value={hsl.l} suffix="%" onChange={l => setHsl({ ...hsl, l })}
          track={`linear-gradient(90deg, #000, ${pure(hsl.h, hsl.s, 50)}, #fff)`} />
        <Slider label="Alpha" min={0} max={100} value={alpha} suffix="%" onChange={setAlpha}
          track={`linear-gradient(90deg, transparent, ${hex})`} />
        <div className="flex flex-wrap gap-1.5">
          {['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b', '#0f172a'].map(c => (
            <button key={c} type="button" title={c} onClick={() => setFromHex(c)} className="size-7 rounded-md border border-border hover:scale-110 transition" style={{ background: c }} />
          ))}
        </div>
      </div>
      <div className="space-y-3 min-w-0">
        <div className="rounded-md border border-border px-3">
          <OutputRow label="HEX" value={hex} />
          {a < 1 && <OutputRow label="HEX + alpha" value={hexA} />}
          <OutputRow label="RGB" value={formatRgb(rgb, a)} />
          <OutputRow label="HSL" value={formatHsl(rgb, a)} />
          <OutputRow label="OKLCH" value={formatOklch(rgb, a)} />
          <OutputRow label="HSL channels" value={hslChannels} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Variable name</FieldLabel>
          <Input className={MONO} value={varName} onChange={e => setVarName(e.target.value)} />
        </div>
        <Code label="CSS variable" rows={3} value={`:root {\n  --${name}: ${a < 1 ? formatOklch(rgb, a) : hex};\n  --${name}-oklch: ${formatOklch(rgb, a)};\n}`} />
        <Code label="shadcn/ui style (HSL channels)" value={`--${name}: ${hslChannels};${a < 1 ? ` /* use hsl(var(--${name}) / ${a}) */` : ''}`} />
        <Code label="Tailwind" rows={4} value={`// tailwind.config.js → theme.extend.colors\n'${name}': '${a < 1 ? hexA : hex}',\n\n// class: bg-[${a < 1 ? hexA : hex}]  text-[${a < 1 ? hexA : hex}]`} />
      </div>
    </div>
  );
}

// =============================================================================================
// Palette generator
// =============================================================================================

type PaletteMode = Harmony | 'random';
type ExportFmt = 'css' | 'json' | 'tailwind' | 'scss' | 'list';

export function PaletteGenerator() {
  const [base, setBase] = useState('#2563eb');
  const [mode, setMode] = useState<PaletteMode>('analogous');
  const [random, setRandom] = useState<RGB[]>(() => randomPalette([null, null, null, null, null]));
  const [locked, setLocked] = useState<boolean[]>([false, false, false, false, false]);
  const [prefix, setPrefix] = useState('palette');
  const [fmt, setFmt] = useState<ExportFmt>('css');

  const colors: RGB[] = useMemo(() => (mode === 'random' ? random : harmony(rgbOf(base), mode)), [mode, random, base]);
  const hexes = colors.map(c => rgbToHex(c));

  const regenerate = () => setRandom(prev => randomPalette(prev.map((c, i) => (locked[i] ? c : null))));
  const toRandom = () => { setRandom(colors.map(c => ({ ...c }))); setMode('random'); };

  useEffect(() => {
    if (mode !== 'random') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName) && !t.isContentEditable) { e.preventDefault(); regenerate(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const p = prefix.trim().replace(/[^\w-]/g, '-') || 'palette';
  const exportText = (() => {
    switch (fmt) {
      case 'css': return `:root {\n${hexes.map((h, i) => `  --${p}-${i + 1}: ${h};`).join('\n')}\n}\n`;
      case 'scss': return hexes.map((h, i) => `$${p}-${i + 1}: ${h};`).join('\n') + '\n';
      case 'json': return JSON.stringify({ [p]: hexes }, null, 2) + '\n';
      case 'tailwind': return `// tailwind.config.js → theme.extend.colors\n'${p}': {\n${hexes.map((h, i) => `  ${(i + 1) * 100}: '${h}',`).join('\n')}\n},\n`;
      default: return hexes.join('\n') + '\n';
    }
  })();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <ColorField label="Base colour" value={base} onChange={v => { setBase(v.slice(0, 7)); if (mode === 'random') setMode('analogous'); }} className="w-56" />
        <Segmented<PaletteMode> value={mode} onChange={m => (m === 'random' ? toRandom() : setMode(m))}
          options={[...HARMONIES, { value: 'random', label: 'Random' }]} />
        {mode === 'random' && <Button size="sm" onClick={regenerate}><Shuffle /> Generate <kbd className="ml-1 text-[10px] opacity-70 hidden sm:inline">space</kbd></Button>}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {colors.map((c, i) => {
          const hex = hexes[i];
          const fg = readableText(c);
          return (
            <div key={i} className="rounded-lg border border-border overflow-hidden min-w-0">
              <div className="h-28 sm:h-40 p-2 flex flex-col justify-between" style={{ background: hex, color: fg }}>
                <div className="flex justify-end gap-0.5">
                  {mode === 'random' && (
                    <button type="button" className="p-1 rounded hover:bg-black/10" title={locked[i] ? 'Unlock' : 'Lock'}
                      onClick={() => setLocked(l => l.map((x, j) => (j === i ? !x : x)))}>
                      {locked[i] ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5 opacity-60" />}
                    </button>
                  )}
                  {mode !== 'random' && i === colors.findIndex(x => rgbToHex(x) === base) && <Badge variant="outline" className="text-[10px]" style={{ color: fg, borderColor: fg }}>base</Badge>}
                </div>
                <button type="button" className="text-left font-mono text-sm font-semibold" onClick={() => copyText(hex)} title="Copy">{hex}</button>
              </div>
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground space-y-0.5 bg-card">
                <p className="font-mono truncate">{formatRgb(c)}</p>
                <p className="font-mono truncate">{formatOklch(c)}</p>
                <div className="flex items-center justify-between">
                  <span>vs white {contrastRatio(c, { r: 255, g: 255, b: 255 }).toFixed(1)}</span>
                  <CopyButton value={hex} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="h-8 rounded-md overflow-hidden flex border border-border">
        {hexes.map((h, i) => <div key={i} className="flex-1" style={{ background: h }} />)}
      </div>

      <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <FieldLabel>Name / prefix</FieldLabel>
            <Input className={MONO} value={prefix} onChange={e => setPrefix(e.target.value)} />
          </div>
          <Segmented<ExportFmt> value={fmt} onChange={setFmt} options={[
            { value: 'css', label: 'CSS' }, { value: 'scss', label: 'SCSS' }, { value: 'tailwind', label: 'Tailwind' },
            { value: 'json', label: 'JSON' }, { value: 'list', label: 'HEX' },
          ]} />
        </div>
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={
            <div className="flex gap-1">
              <CopyButton value={exportText} label="Copy" />
              <Button variant="ghost" size="xs" onClick={() => downloadBlob(exportText, `${p}.${fmt === 'json' ? 'json' : fmt === 'scss' ? 'scss' : fmt === 'css' ? 'css' : fmt === 'tailwind' ? 'js' : 'txt'}`)}><Download /> Download</Button>
            </div>
          }>Export</FieldLabel>
          <Textarea readOnly value={exportText} className={cn(MONO, FIXED, 'h-40 bg-secondary/40')} />
        </div>
      </div>
    </div>
  );
}

// =============================================================================================
// Contrast checker
// =============================================================================================

function PassBadge({ ok, label, need }: { ok: boolean; label: string; need: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs',
      ok ? 'border-primary/40 bg-primary/5' : 'border-destructive/40 bg-destructive/5')}>
      <span className="min-w-0"><span className="font-medium">{label}</span> <span className="text-muted-foreground">≥ {need}</span></span>
      <span className={cn('flex items-center gap-1 font-semibold shrink-0', ok ? 'text-primary' : 'text-destructive')}>
        {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}{ok ? 'Pass' : 'Fail'}
      </span>
    </div>
  );
}

export function ContrastChecker() {
  const [fg, setFg] = useState('#6b7280');
  const [bg, setBg] = useState('#ffffff');
  const bgRgb = rgbOf(bg);
  const bgOpaque: RGB = compositeOver(bgRgb, { r: 255, g: 255, b: 255 });
  const fgRgba = rgbOf(fg);
  const fgEff = compositeOver(fgRgba, bgOpaque);
  const ratio = contrastRatio(fgEff, bgOpaque);
  const r = wcag(ratio);
  const display = Math.floor(ratio * 100) / 100; // never round a failing 4.499 up to 4.50

  const suggestions = [
    { label: 'AA normal text', target: 4.5, ok: r.aaNormal },
    { label: 'AAA normal text', target: 7, ok: r.aaaNormal },
    { label: 'AA large text / UI', target: 3, ok: r.aaLarge },
  ].filter(s => !s.ok).map(s => ({
    ...s,
    fg: suggestContrast(fgEff, bgOpaque, s.target),
    bg: suggestContrast(bgOpaque, fgEff, s.target),
  }));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end">
        <ColorField label="Text (foreground)" value={fg} onChange={setFg} />
        <Button variant="outline" size="icon" title="Swap" onClick={() => { setFg(bg); setBg(fg); }}><ArrowLeftRight /></Button>
        <ColorField label="Background" value={bg} onChange={setBg} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-lg border border-border overflow-hidden" style={{ background: rgbToHex(bgOpaque), color: fg }}>
          <div className="p-5 space-y-3">
            <p className="text-2xl font-bold leading-tight">Large heading text</p>
            <p className="text-sm leading-relaxed">
              Body copy at 14px. The quick brown fox jumps over the lazy dog — check that small text stays comfortable to read for everyone.
            </p>
            <p className="text-xs">Small caption text · 12px</p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="inline-flex h-8 items-center rounded-md border-2 px-3 text-sm font-medium" style={{ borderColor: fg }}>Outlined button</span>
              <span className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium" style={{ background: fg, color: bg }}>Filled button</span>
              <span className="inline-block size-5 rounded-full border-2" style={{ borderColor: fg }} title="UI icon / focus ring" />
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-end gap-3">
            <div>
              <p className="text-[11px] text-muted-foreground">Contrast ratio</p>
              <p className="text-4xl font-bold tabular-nums tracking-tight">{display.toFixed(2)}<span className="text-xl text-muted-foreground">:1</span></p>
            </div>
            <Badge variant={r.aaNormal ? 'default' : r.aaLarge ? 'secondary' : 'destructive'} className="mb-1.5">
              {r.aaaNormal ? 'AAA' : r.aaNormal ? 'AA' : r.aaLarge ? 'AA large only' : 'Fails'}
            </Badge>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            <PassBadge ok={r.aaNormal} label="AA · normal text" need="4.5" />
            <PassBadge ok={r.aaaNormal} label="AAA · normal text" need="7" />
            <PassBadge ok={r.aaLarge} label="AA · large text" need="3" />
            <PassBadge ok={r.aaaLarge} label="AAA · large text" need="4.5" />
            <PassBadge ok={r.ui} label="UI components & graphics" need="3" />
          </div>
          <p className="text-[11px] text-muted-foreground">Large text = 24px+ regular or 18.66px+ bold. {fgRgba.a < 1 && 'Translucent text is blended over the background before measuring.'}</p>
        </div>
      </div>

      {suggestions.length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Nearest passing colours</CardTitle>
            <CardDescription>Same hue, only lightness adjusted (OKLCH).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {suggestions.map(s => (
              <div key={s.label} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-36 font-medium">{s.label}</span>
                {[{ which: 'text', c: s.fg, apply: (h: string) => setFg(h) }, { which: 'background', c: s.bg, apply: (h: string) => setBg(h) }].map(x => x.c ? (
                  <button key={x.which} type="button" onClick={() => x.apply(rgbToHex(x.c!))}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 hover:bg-secondary transition">
                    <span className="size-4 rounded border border-border" style={{ background: rgbToHex(x.c) }} />
                    <span className="font-mono">{rgbToHex(x.c)}</span>
                    <span className="text-muted-foreground">as {x.which} · {contrastRatio(x.which === 'text' ? x.c : fgEff, x.which === 'text' ? bgOpaque : x.c).toFixed(2)}:1</span>
                  </button>
                ) : <span key={x.which} className="text-muted-foreground">no {x.which} fix possible</span>)}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// =============================================================================================
// Tailwind shade generator
// =============================================================================================

type TwOut = 'v3' | 'v4' | 'css' | 'json';

export function TailwindColorGenerator() {
  const [base, setBase] = useState('#3b82f6');
  const [name, setName] = useState('brand');
  const [anchor, setAnchor] = useState<'auto' | number>('auto');
  const [hueShift, setHueShift] = useState(0);
  const [out, setOut] = useState<TwOut>('v3');
  const scale = useMemo(() => tailwindScale(rgbOf(base), { anchor, hueShift }), [base, anchor, hueShift]);
  const n = name.trim().replace(/[^\w-]/g, '-') || 'brand';

  const text = (() => {
    switch (out) {
      case 'v4': return `@theme {\n${scale.map(s => `  --color-${n}-${s.step}: ${formatOklch(s.rgb)};`).join('\n')}\n}\n`;
      case 'css': return `:root {\n${scale.map(s => `  --${n}-${s.step}: ${s.hex};`).join('\n')}\n}\n`;
      case 'json': return JSON.stringify({ [n]: Object.fromEntries(scale.map(s => [s.step, s.hex])) }, null, 2) + '\n';
      default: return `// tailwind.config.js\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: {\n        '${n}': {\n${scale.map(s => `          ${s.step}: '${s.hex}',`).join('\n')}\n          DEFAULT: '${scale.find(s => s.isBase)!.hex}',\n        },\n      },\n    },\n  },\n};\n`;
    }
  })();

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 items-end">
        <ColorField label="Base colour" value={base} onChange={v => setBase(v.slice(0, 7))} />
        <div className="space-y-1.5">
          <FieldLabel>Name</FieldLabel>
          <Input className={MONO} value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Base sits at</FieldLabel>
          <select className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-primary"
            value={String(anchor)} onChange={e => setAnchor(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}>
            <option value="auto">Auto (closest lightness)</option>
            {TW_STEPS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <Slider label="Hue drift (dark end)" min={-30} max={30} value={hueShift} suffix="°" onChange={setHueShift} />
      </div>

      <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-11 gap-1.5">
        {scale.map(s => (
          <button key={s.step} type="button" title={`Copy ${s.hex}`} onClick={() => copyText(s.hex)}
            className={cn('rounded-md border overflow-hidden text-left transition hover:scale-[1.03] min-w-0', s.isBase ? 'border-primary ring-2 ring-primary/40' : 'border-border')}>
            <div className="h-16 p-1.5 flex items-end justify-between" style={{ background: s.hex, color: readableText(s.rgb) }}>
              <span className="text-xs font-semibold">{s.step}</span>
              {s.isBase && <span className="text-[9px] font-semibold uppercase">base</span>}
            </div>
            <div className="px-1.5 py-1 bg-card">
              <p className="font-mono text-[10px] truncate">{s.hex}</p>
              <p className="font-mono text-[9px] text-muted-foreground truncate">L {(s.oklch.l * 100).toFixed(0)} C {s.oklch.c.toFixed(2)}</p>
            </div>
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<CopyButton value={text} label="Copy" />}>
            <Segmented<TwOut> value={out} onChange={setOut} options={[{ value: 'v3', label: 'tailwind.config' }, { value: 'v4', label: 'v4 @theme' }, { value: 'css', label: 'CSS vars' }, { value: 'json', label: 'JSON' }]} />
          </FieldLabel>
          <Textarea readOnly value={text} className={cn(MONO, FIXED, 'h-72 bg-secondary/40')} />
        </div>
        <div className="space-y-1.5 min-w-0">
          <FieldLabel>Preview</FieldLabel>
          <div className="rounded-lg border border-border p-4 space-y-3" style={{ background: scale[0].hex }}>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium text-white" style={{ background: scale[6].hex }}>Primary ({n}-600)</span>
              <span className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium" style={{ background: scale[1].hex, color: scale[8].hex }}>Soft ({n}-100)</span>
              <span className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium border" style={{ borderColor: scale[3].hex, color: scale[7].hex }}>Outline</span>
            </div>
            <div className="rounded-md p-3 text-sm border" style={{ background: '#fff', borderColor: scale[2].hex, color: scale[9].hex }}>
              <p className="font-semibold" style={{ color: scale[7].hex }}>Card title</p>
              <p className="text-xs mt-1">Body text in {n}-900 on white: {contrastRatio(scale[9].rgb, { r: 255, g: 255, b: 255 }).toFixed(1)}:1 contrast.</p>
            </div>
            <div className="rounded-md p-3 text-sm" style={{ background: scale[10].hex, color: scale[2].hex }}>
              Dark surface ({n}-950) with {n}-200 text: {contrastRatio(scale[2].rgb, scale[10].rgb).toFixed(1)}:1
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
