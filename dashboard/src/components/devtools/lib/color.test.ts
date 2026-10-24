// Unit tests for lib/color.ts — run from the repo root:
//   node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/color.test.ts
import assert from 'node:assert/strict';
import {
  parseColor, rgbToHex, rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb, rgbToOklch, oklchToRgb, oklchToRgbGamut, inGamut,
  contrastRatio, wcag, suggestContrast, compositeOver, harmony, randomPalette, mulberry32, tailwindScale, TW_STEPS,
  gradientCss, gradientTailwind, colorAt, formatOklch, formatHsl, formatRgb, toHex, readableText, maxChroma, type RGB,
} from './color';

let passed = 0;
const failures: string[] = [];
function t(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${(e as Error).message}`); }
}
const near = (a: number, b: number, eps: number, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b} (±${eps})`);
const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });
const WHITE = rgb(255, 255, 255), BLACK = rgb(0, 0, 0);

t('parse hex forms', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#336699'), { r: 51, g: 102, b: 153, a: 1 });
  assert.deepEqual(parseColor('#33669980'), { r: 51, g: 102, b: 153, a: 0.502 });
  assert.deepEqual(parseColor('abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.equal(parseColor('#12345'), null);
  assert.equal(parseColor('nope'), null);
});

t('parse functional forms + named', () => {
  assert.deepEqual(parseColor('rgb(255, 0, 0)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('rgba(0 128 255 / 50%)'), { r: 0, g: 128, b: 255, a: 0.5 });
  assert.deepEqual(parseColor('rgb(100% 0% 0%)'), { r: 255, g: 0, b: 0, a: 1 });
  const h = parseColor('hsl(120 100% 25%)')!;
  assert.deepEqual([Math.round(h.r), Math.round(h.g), Math.round(h.b)], [0, 128, 0]);
  const h2 = parseColor('hsla(0.5turn, 100%, 50%, 0.25)')!;
  assert.deepEqual([Math.round(h2.r), Math.round(h2.g), Math.round(h2.b), h2.a], [0, 255, 255, 0.25]);
  const ok = parseColor('oklch(62.8% 0.2577 29.23)')!; // CSS red
  assert.deepEqual([Math.round(ok.r), Math.round(ok.g), Math.round(ok.b)], [255, 0, 0]);
  assert.deepEqual(parseColor('RebeccaPurple'), { r: 102, g: 51, b: 153, a: 1 });
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColor('rgb(1,2)'), null);
});

t('hex formatting with alpha', () => {
  assert.equal(rgbToHex(rgb(51, 102, 153)), '#336699');
  assert.equal(rgbToHex(rgb(51, 102, 153), 0.5), '#33669980');
  assert.equal(rgbToHex(rgb(300, -5, 12.6)), '#ff000d');
  assert.equal(toHex('rgb(0 0 0 / 0.5)'), '#00000080');
});

t('HSL / HSV round trips', () => {
  for (const c of [rgb(51, 102, 153), rgb(255, 0, 0), rgb(12, 200, 99), rgb(128, 128, 128), rgb(0, 0, 0), rgb(255, 255, 255)]) {
    const back = hslToRgb(rgbToHsl(c));
    near(back.r, c.r, 0.01); near(back.g, c.g, 0.01); near(back.b, c.b, 0.01);
    const back2 = hsvToRgb(rgbToHsv(c));
    near(back2.r, c.r, 0.01); near(back2.g, c.g, 0.01); near(back2.b, c.b, 0.01);
  }
  const hsl = rgbToHsl(rgb(51, 102, 153));
  near(hsl.h, 210, 0.01); near(hsl.s, 50, 0.01); near(hsl.l, 40, 0.01);
  assert.equal(formatHsl(rgb(51, 102, 153)), 'hsl(210 50% 40%)');
  assert.equal(formatRgb(rgb(51, 102, 153), 0.5), 'rgb(51 102 153 / 0.5)');
});

t('OKLCH matches the CSS Color 4 reference values', () => {
  // Reference: oklch(62.8% 0.2577 29.23) is sRGB red; oklch(100% 0 0) white.
  const red = rgbToOklch(rgb(255, 0, 0));
  near(red.l, 0.628, 0.001, 'L'); near(red.c, 0.2577, 0.0005, 'C'); near(red.h, 29.23, 0.05, 'h');
  const w = rgbToOklch(WHITE);
  near(w.l, 1, 1e-4); near(w.c, 0, 1e-4);
  assert.equal(formatOklch(WHITE), 'oklch(100% 0 0)');
  const back = oklchToRgb(rgbToOklch(rgb(12, 200, 99)));
  near(back.r, 12, 0.01); near(back.g, 200, 0.01); near(back.b, 99, 0.01);
});

t('gamut mapping keeps colours inside sRGB', () => {
  const raw = oklchToRgb({ l: 0.7, c: 0.35, h: 150 });
  assert.ok(!inGamut(raw), 'very saturated green is out of gamut');
  const mapped = oklchToRgbGamut({ l: 0.7, c: 0.35, h: 150 });
  assert.ok(inGamut(mapped, 0));
  near(rgbToOklch(mapped).l, 0.7, 0.01, 'lightness kept');
  const mc = maxChroma(0.7, 150);
  assert.ok(mc > 0.1 && mc < 0.35, `max chroma ${mc}`);
});

t('WCAG contrast ratios', () => {
  near(contrastRatio(BLACK, WHITE), 21, 1e-9);
  near(contrastRatio(WHITE, WHITE), 1, 1e-9);
  near(contrastRatio(rgb(118, 118, 118), WHITE), 4.54, 0.01); // #767676 — the classic AA grey
  near(contrastRatio(rgb(0x77, 0x77, 0x77), WHITE), 4.48, 0.01);
  const r = wcag(4.5);
  assert.deepEqual([r.aaNormal, r.aaaNormal, r.aaLarge, r.aaaLarge, r.ui], [true, false, true, true, true]);
  const r2 = wcag(4.4999);
  assert.equal(r2.aaNormal, false);
  assert.equal(wcag(7).aaaNormal, true);
  assert.equal(readableText(rgb(250, 250, 0)), '#000000');
  assert.equal(readableText(rgb(20, 20, 80)), '#ffffff');
});

t('compositing translucent foregrounds', () => {
  const c = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, WHITE);
  near(c.r, 127.5, 1e-9);
});

t('suggestContrast finds the nearest passing colour', () => {
  const fg = rgb(0x99, 0x99, 0xff), bg = WHITE;
  assert.ok(contrastRatio(fg, bg) < 4.5);
  const s = suggestContrast(fg, bg, 4.5)!;
  assert.ok(s && contrastRatio(s, bg) >= 4.5, 'passes');
  assert.ok(contrastRatio(s, bg) < 5.2, 'is close to the threshold rather than black');
  const h1 = rgbToOklch(fg).h, h2 = rgbToOklch(s).h;
  near(h1, h2, 6, 'keeps hue');
  // Already passing → unchanged
  assert.deepEqual(suggestContrast(BLACK, WHITE, 7), BLACK);
  // Mid grey on mid grey can reach 3:1 by going lighter or darker.
  const g = suggestContrast(rgb(128, 128, 128), rgb(128, 128, 128), 3)!;
  assert.ok(contrastRatio(g, rgb(128, 128, 128)) >= 3);
  // 21:1 is impossible against grey.
  assert.equal(suggestContrast(rgb(128, 128, 128), rgb(128, 128, 128), 21), null);
});

t('harmonies produce 5 in-gamut swatches with expected hues', () => {
  const base = rgb(37, 99, 235);
  const h0 = rgbToOklch(base).h;
  for (const kind of ['complementary', 'analogous', 'triadic', 'tetradic', 'split', 'monochrome'] as const) {
    const p = harmony(base, kind);
    assert.equal(p.length, 5, kind);
    p.forEach(c => assert.ok(inGamut(c, 0), `${kind} in gamut`));
  }
  const comp = harmony(base, 'complementary');
  const dh = Math.abs(((rgbToOklch(comp[3]).h - h0 + 360) % 360) - 180);
  assert.ok(dh < 8, `complement is ~180° away (off by ${dh})`);
  const tri = harmony(base, 'triadic');
  const d1 = (rgbToOklch(tri[1]).h - h0 + 360) % 360;
  near(d1, 120, 8, 'triadic +120');
  const mono = harmony(base, 'monochrome').map(c => rgbToOklch(c).l);
  assert.ok(mono.every((l, i) => i === 0 || l < mono[i - 1]), 'monochrome goes light → dark');
});

t('random palettes respect locks and are reproducible', () => {
  const locked = [null, rgb(10, 20, 30), null, null, null];
  const a = randomPalette(locked, mulberry32(1));
  const b = randomPalette(locked, mulberry32(1));
  assert.deepEqual(a, b);
  assert.deepEqual(a[1], rgb(10, 20, 30));
  a.forEach(c => assert.ok(inGamut(c, 0)));
});

t('tailwind scale is monotonic, contains the base and spans light → dark', () => {
  for (const base of [rgb(37, 99, 235), rgb(239, 68, 68), rgb(16, 185, 129), rgb(250, 204, 21), rgb(100, 116, 139), rgb(15, 23, 42), rgb(254, 242, 242)]) {
    const s = tailwindScale(base);
    assert.deepEqual(s.map(x => x.step), [...TW_STEPS]);
    assert.equal(s.filter(x => x.isBase).length, 1);
    const b = s.find(x => x.isBase)!;
    assert.equal(b.hex, rgbToHex(base));
    const ls = s.map(x => x.oklch.l);
    for (let i = 1; i < ls.length; i++) assert.ok(ls[i] < ls[i - 1], `${rgbToHex(base)} L decreases at ${s[i].step}: ${ls[i - 1]} → ${ls[i]}`);
    assert.ok(ls[0] > 0.93, '50 is very light');
    assert.ok(ls[10] < 0.35, '950 is very dark');
    s.forEach(x => assert.match(x.hex, /^#[0-9a-f]{6}$/));
  }
  // Tailwind blue-600 (#2563eb, L≈0.546) should anchor around 500/600.
  const blue = tailwindScale(rgb(37, 99, 235));
  assert.ok([500, 600].includes(blue.find(x => x.isBase)!.step));
  // Forced anchor
  assert.equal(tailwindScale(rgb(37, 99, 235), { anchor: 500 }).find(x => x.isBase)!.step, 500);
});

t('gradient CSS + Tailwind output', () => {
  const g = { type: 'linear' as const, angle: 90, stops: [{ id: 1, color: '#ff0000', pos: 0 }, { id: 2, color: '#0000ff', pos: 100 }] };
  assert.equal(gradientCss(g), 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)');
  const tw = gradientTailwind(g);
  assert.equal(tw.utilities, 'bg-gradient-to-r from-[#ff0000] to-[#0000ff]');
  assert.equal(tw.arbitrary, 'bg-[linear-gradient(90deg,#ff0000_0%,#0000ff_100%)]');
  assert.equal(gradientTailwind({ ...g, angle: 33 }).utilities, null);
  const r = { type: 'radial' as const, angle: 0, shape: 'ellipse' as const, cx: 30, cy: 70, stops: [{ id: 2, color: '#000', pos: 80 }, { id: 1, color: '#fff', pos: 10 }] };
  assert.equal(gradientCss(r), 'radial-gradient(ellipse at 30% 70%, #fff 10%, #000 80%)');
  assert.equal(gradientCss({ ...r, type: 'conic', angle: 45 }), 'conic-gradient(from 45deg at 30% 70%, #fff 10%, #000 80%)');
  const mid = colorAt(g.stops, 50);
  near(mid.r, 127.5, 0.01); near(mid.b, 127.5, 0.01);
  assert.deepEqual(colorAt(g.stops, -5), { r: 255, g: 0, b: 0, a: 1 });
});

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exitCode = 1; }
