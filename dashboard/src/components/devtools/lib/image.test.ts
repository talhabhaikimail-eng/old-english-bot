// Unit tests for lib/image.ts — run from the repo root:
//   node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/image.test.ts
import assert from 'node:assert/strict';
import {
  initialBox, dragBox, applyAspect, clampBox, ratioLabel, resizeTarget, rotatedBounds, autoFontSize, markPosition,
  tilePositions, sniffImage, parseBase64Image, bytesToBase64, base64ToBytes, qualityLabel, sortRows, bestUnder, projectDuration,
} from './image';

let passed = 0;
const failures: string[] = [];
function t(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${(e as Error).message}`); }
}
const near = (a: number, b: number, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b}`);

t('initial crop box is centred and respects aspect', () => {
  assert.deepEqual(initialBox(1000, 500, null), { x: 100, y: 50, w: 800, h: 400 });
  const sq = initialBox(1000, 500, 1);
  assert.deepEqual(sq, { x: 300, y: 50, w: 400, h: 400 });
});

t('move is clamped inside the image', () => {
  const b = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(dragBox(b, 'move', 5000, -5000, 1000, 500, null), { x: 800, y: 0, w: 200, h: 100 });
});

t('free resize from each handle', () => {
  const b = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(dragBox(b, 'se', 50, 30, 1000, 500, null), { x: 100, y: 100, w: 250, h: 130 });
  assert.deepEqual(dragBox(b, 'nw', -50, -30, 1000, 500, null), { x: 50, y: 70, w: 250, h: 130 });
  assert.deepEqual(dragBox(b, 'e', 2000, 0, 1000, 500, null), { x: 100, y: 100, w: 900, h: 100 }, 'clamped to right edge');
  const tiny = dragBox(b, 'w', 1000, 0, 1000, 500, null, 4);
  assert.equal(tiny.w, 4, 'min size');
});

t('aspect-locked corner resize anchors the opposite corner', () => {
  const b = { x: 100, y: 100, w: 160, h: 90 };
  const r = dragBox(b, 'se', 160, 0, 1000, 1000, 16 / 9);
  near(r.w / r.h, 16 / 9, 1e-9); assert.equal(r.x, 100); assert.equal(r.y, 100); near(r.w, 320);
  const r2 = dragBox(b, 'nw', -50, -200, 1000, 1000, 16 / 9);
  near(r2.w / r2.h, 16 / 9, 1e-9); near(r2.x + r2.w, 260); near(r2.y + r2.h, 190);
  assert.ok(r2.x >= 0 && r2.y >= 0, 'stays inside');
  // limited by the bottom edge
  const r3 = dragBox({ x: 0, y: 900, w: 16, h: 9 }, 'se', 900, 900, 1000, 1000, 16 / 9);
  assert.ok(r3.y + r3.h <= 1000 + 1e-9 && r3.x + r3.w <= 1000 + 1e-9);
});

t('aspect-locked edge resize keeps the perpendicular centre', () => {
  const b = { x: 100, y: 100, w: 100, h: 100 };
  const r = dragBox(b, 'e', 100, 0, 1000, 1000, 1);
  assert.deepEqual(r, { x: 100, y: 50, w: 200, h: 200 });
  const r2 = dragBox(b, 's', 0, 2000, 1000, 1000, 2);
  near(r2.w / r2.h, 2); assert.ok(r2.x >= 0 && r2.x + r2.w <= 1000);
});

t('applyAspect / clampBox', () => {
  const r = applyAspect({ x: 0, y: 0, w: 400, h: 300 }, 1, 1000, 1000);
  assert.equal(r.w, r.h);
  assert.deepEqual(clampBox({ x: -10, y: 990, w: 50, h: 50 }, 100, 1000), { x: 0, y: 950, w: 50, h: 50 });
});

t('ratio labels', () => {
  assert.equal(ratioLabel(1920, 1080), '16:9');
  assert.equal(ratioLabel(1200, 630), '40:21');
  assert.equal(ratioLabel(1001, 997), '1.004:1');
});

t('resize targets mirror the backend', () => {
  assert.deepEqual(resizeTarget(640, 480, { mode: 'maxside', maxSide: 200 }), { w: 200, h: 150 });
  assert.deepEqual(resizeTarget(640, 480, { mode: 'maxside', maxSide: 4000 }), { w: 640, h: 480 });
  assert.deepEqual(resizeTarget(640, 480, { mode: 'maxside', maxSide: 4000, noUpscale: false }), { w: 4000, h: 3000 });
  assert.deepEqual(resizeTarget(640, 480, { mode: 'percent', percent: 25 }), { w: 160, h: 120 });
  assert.deepEqual(resizeTarget(640, 480, { mode: 'exact', width: 300, height: 300, fit: 'cover' }), { w: 300, h: 300 });
  assert.deepEqual(resizeTarget(640, 480, { mode: 'exact', width: 300, height: 300, fit: 'inside' }), { w: 300, h: 225 });
  assert.deepEqual(resizeTarget(640, 480, { mode: 'exact', width: 300, height: 300, fit: 'contain' }), { w: 300, h: 300 });
  assert.deepEqual(resizeTarget(640, 480, { mode: 'exact', width: 320, height: 0 }), { w: 320, h: 240 });
  assert.deepEqual(resizeTarget(200, 120, { mode: 'exact', width: 300, height: 300, fit: 'cover' }), { w: 200, h: 120 });
});

t('rotated bounds', () => {
  assert.deepEqual(rotatedBounds(640, 480, 90), { w: 480, h: 640 });
  assert.deepEqual(rotatedBounds(640, 480, -180), { w: 640, h: 480 });
  const b = rotatedBounds(100, 100, 45);
  assert.equal(b.w, 142); assert.equal(b.h, 142);
});

t('watermark layout', () => {
  near(autoFontSize(500, 1000, 25), 50);
  assert.deepEqual(markPosition('br', 1000, 500, 100, 50, 3), { x: 885, y: 435 });
  assert.deepEqual(markPosition('c', 1000, 500, 100, 50, 3), { x: 450, y: 225 });
  assert.deepEqual(markPosition('tl', 1000, 500, 100, 50, 0), { x: 0, y: 0 });
  const tiles = tilePositions(1000, 500, 100, 50, 60);
  assert.ok(tiles.length > 10 && tiles.length < 200);
  assert.ok(tiles.some(p => p.x < 0) && tiles.some(p => p.x + 100 > 1000), 'tiles bleed off both edges');
});

t('image sniffing + base64 parsing', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48]);
  assert.deepEqual(sniffImage(png), { mime: 'image/png', ext: 'png' });
  assert.equal(sniffImage(new TextEncoder().encode('   <svg xmlns="http://www.w3.org/2000/svg"></svg>'))!.ext, 'svg');
  const b64 = bytesToBase64(png);
  assert.deepEqual(Array.from(base64ToBytes(b64)), Array.from(png));
  const p1 = parseBase64Image(`data:image/png;base64,${b64}`);
  assert.ok(!('error' in p1) && p1.ext === 'png' && !p1.warning);
  const p2 = parseBase64Image(b64.replace(/(.{4})/g, '$1\n'));
  assert.ok(!('error' in p2) && p2.mime === 'image/png', 'raw base64 with newlines');
  const p3 = parseBase64Image(`data:image/jpeg;base64,${b64}`);
  assert.ok(!('error' in p3) && p3.warning?.includes('image/jpeg'));
  const p4 = parseBase64Image(`background: url("data:image/png;base64,${b64}")`);
  assert.ok(!('error' in p4) && p4.ext === 'png', 'css url()');
  const svg = parseBase64Image(`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')}`);
  assert.ok(!('error' in svg) && svg.ext === 'svg', 'url-encoded svg');
  assert.ok('error' in parseBase64Image('aGVsbG8gd29ybGQ='), 'text is rejected');
  assert.ok('error' in parseBase64Image('***'), 'garbage is rejected');
  assert.ok('error' in parseBase64Image(''), 'empty');
});

t('quality labels, sorting, best picks, projections', () => {
  assert.equal(qualityLabel(1).label, 'Identical');
  assert.equal(qualityLabel(0.996).label, 'Visually lossless');
  assert.equal(qualityLabel(0.5).tone, 'bad');
  const rows = [{ id: 'a', size: 300, ssim: 0.999 }, { id: 'b', size: 100, ssim: 0.97 }, { id: 'c', size: undefined, ssim: null }, { id: 'd', size: 200, ssim: 0.996 }];
  assert.deepEqual(sortRows(rows, 'size', 'asc').map(r => r.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(sortRows(rows, 'size', 'desc').map(r => r.id), ['a', 'd', 'b', 'c']);
  assert.equal(bestUnder(rows, 0.995)!.id, 'd');
  assert.equal(bestUnder(rows, 0.96)!.id, 'b');
  assert.equal(bestUnder(rows, 1.1), null);
  assert.equal(projectDuration(11000, 7.3), '25 min');
  assert.equal(projectDuration(30, 1), '30 s');
});

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach(f => console.log('  ✗ ' + f)); process.exitCode = 1; }
