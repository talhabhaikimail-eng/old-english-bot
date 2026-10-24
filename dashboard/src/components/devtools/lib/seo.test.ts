// Run from the repo root: node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/seo.test.ts
import assert from 'node:assert/strict';
import {
  csvCell, estimateLoad, formatMs, imageIssues, lengthStatus, normalizeInput, parseUrlList, PROFILES, scoreLabel, scoreTone,
  serpBreadcrumb, siteName, textWidthPx, toCsv, truncateToWidth,
} from './seo';

let n = 0;
function t(name: string, fn: () => void) {
  try { fn(); n++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n`, e); process.exitCode = 1; }
}

t('score tone/label', () => {
  assert.equal(scoreTone(95), 'good');
  assert.equal(scoreTone(80), 'good');
  assert.equal(scoreTone(79), 'ok');
  assert.equal(scoreTone(49), 'poor');
  assert.equal(scoreLabel(92), 'Excellent');
  assert.equal(scoreLabel(10), 'Critical');
});

t('lengthStatus', () => {
  assert.equal(lengthStatus(0, 30, 60), 'missing');
  assert.equal(lengthStatus(10, 30, 60), 'short');
  assert.equal(lengthStatus(45, 30, 60), 'ok');
  assert.equal(lengthStatus(61, 30, 60), 'long');
});

t('text width and SERP truncation', () => {
  assert.ok(textWidthPx('WWWW', 20) > textWidthPx('iiii', 20) * 3);
  const short = truncateToWidth('Short title', 580, 20);
  assert.equal(short.truncated, false);
  assert.equal(short.text, 'Short title');
  const long = truncateToWidth('A very long page title that goes on and on and on well past the limit of Google results', 580, 20);
  assert.equal(long.truncated, true);
  assert.ok(long.text.endsWith(' …'));
  assert.ok(textWidthPx(long.text, 20) <= 580 + 20);
  assert.ok(!long.text.includes('Google'));
  // CJK characters are wide
  assert.ok(textWidthPx('漢字漢字', 20) >= 80);
});

t('serp breadcrumb', () => {
  const b = serpBreadcrumb('https://www.example.com/blog/my%20post?x=1');
  assert.equal(b.site, 'example.com');
  assert.equal(b.crumbs, 'https://www.example.com › blog › my post');
  assert.equal(serpBreadcrumb('not a url').site, 'not a url');
});

t('load model', () => {
  const m = { origins: 2, https: true, requests: 13, bytes: 1_000_000, criticalOrigins: 1, criticalBytes: 100_000, hasBlocking: true };
  const g2 = estimateLoad(PROFILES[0], m);
  // setup 2×3×800 = 4800, waves (1 + 2)×800 = 2400, transfer 1e6×8/250e3 s = 32 s
  assert.equal(g2.fullMs, 4800 + 2400 + 32000);
  // render: 1×3×800 + 2×800 + 100000×8/250000 s
  assert.equal(g2.renderMs, 2400 + 1600 + 3200);
  const fibre = estimateLoad(PROFILES[4], m);
  assert.ok(fibre.fullMs < g2.fullMs / 20);
  assert.equal(estimateLoad(PROFILES[1], { ...m, https: false, hasBlocking: false, requests: 1 }).fullMs, 2 * 2 * 300 + 300 + 5000);
});

t('formatMs', () => {
  assert.equal(formatMs(120), '120 ms');
  assert.equal(formatMs(1500), '1.50 s');
  assert.equal(formatMs(15_000), '15.0 s');
  assert.equal(formatMs(75_000), '1 m 15 s');
});

t('csv escaping and formula neutralising', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(['nofollow', 'ugc']), 'nofollow ugc');
  assert.equal(toCsv([['a', 1], ['b', true]]), 'a,1\r\nb,true\r\n');
});

t('parseUrlList', () => {
  const r = parseUrlList('https://a.com/x\nexample.org\n\n# comment\nhttps://a.com/x#frag\nftp://nope\nnot a url\nhttps://b.com/ https://c.com/');
  assert.deepEqual(r.urls, ['https://a.com/x', 'https://example.org/', 'https://b.com/', 'https://c.com/']);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.invalid, ['ftp://nope', 'not a url']);
  assert.equal(parseUrlList('a.com\nb.com\nc.com', { max: 2 }).urls.length, 2);
});

t('image issues per platform', () => {
  assert.deepEqual(imageIssues('facebook', { width: 1200, height: 630, bytes: 100_000 }), []);
  assert.equal(imageIssues('facebook', { width: 400, height: 400 }).length, 2); // too small + ratio
  assert.deepEqual(imageIssues('x-summary', { width: 400, height: 400 }), []);
  assert.match(imageIssues('whatsapp', { width: 1200, height: 630, bytes: 2_000_000 })[0], /exceeds/);
  assert.match(imageIssues('slack', null)[0], /No image/);
  assert.deepEqual(imageIssues('linkedin', {}), []);
  assert.match(imageIssues('discord', { contentType: 'image/svg+xml' })[0], /SVG/);
});

t('misc', () => {
  assert.equal(siteName('https://www.example.com/a'), 'example.com');
  assert.equal(normalizeInput(' example.com '), 'https://example.com');
  assert.equal(normalizeInput('http://x.y'), 'http://x.y');
  assert.equal(normalizeInput(''), '');
});

console.log(`\n${n} passed${process.exitCode ? ', some failed' : ''}`);
