// Run: node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/files.test.ts
import assert from 'node:assert/strict';
import {
  buildTree, commonTargets, countPages, describeSplit, fileExt, fileStem, formatDms, formatNumber, formatTimecode, fromBytes,
  humanDuration, humanSize, kindOf, moveItem, osmUrl, parsePageRanges, parseTimecode, planFor, planJobs, previewKind,
  targetVideoKbps, targetsForFile, toBytes, transferSeconds, unsafeZipPath,
} from './files';

let n = 0;
function t(name: string, fn: () => void) {
  try { fn(); n++; } catch (e) { console.error(`✗ ${name}`); throw e; }
}

t('ext / stem / kind', () => {
  assert.equal(fileExt('Report.Final.DOCX'), 'docx');
  assert.equal(fileExt('noext'), '');
  assert.equal(fileStem('C:\\x\\a.b.pdf'), 'a.b');
  assert.equal(fileStem('.env'), '.env');
  assert.equal(kindOf('a.xlsx'), 'spreadsheet');
  assert.equal(kindOf('a.PPTX'), 'presentation');
  assert.equal(kindOf('a.pdf'), 'pdf');
  assert.equal(kindOf('a.heic'), 'image');
  assert.equal(kindOf('a.mkv'), 'video');
  assert.equal(kindOf('a.flac'), 'audio');
  assert.equal(kindOf('a.exe'), 'unknown');
});

t('format matrix', () => {
  assert.ok(targetsForFile('a.docx').includes('epub'));
  assert.ok(!targetsForFile('a.docx').includes('csv'));
  assert.ok(targetsForFile('a.xlsx').includes('csv'));
  assert.ok(targetsForFile('a.pdf').includes('docx') && targetsForFile('a.pdf').includes('txt'));
  assert.ok(!targetsForFile('a.mp3').includes('mp3'));
  assert.deepEqual(commonTargets(['a.docx', 'b.xlsx']), ['pdf', 'html', 'png']);
  assert.deepEqual(commonTargets(['a.docx', 'b.mp3']), []);
  assert.deepEqual(commonTargets([]), []);
  assert.deepEqual(planFor('a.xlsx', 'csv'), { converter: 'office-convert', options: { target: 'csv' }, maxFiles: 20 });
  assert.equal(planFor('a.md', 'pdf')!.converter, 'html-to-pdf');
  assert.equal(planFor('a.md', 'docx')!.converter, 'office-convert');
  assert.equal(planFor('a.pdf', 'txt')!.converter, 'pdf-text');
  assert.deepEqual(planFor('a.pdf', 'jpg')!.options, { format: 'jpg' });
  assert.equal(planFor('a.mp4', 'mp3')!.converter, 'video-to-mp3');
  assert.equal(planFor('a.mp4', 'flac')!.converter, 'audio-convert');
  assert.equal(planFor('a.mov', 'gif')!.converter, 'video-to-gif');
  assert.equal(planFor('a.jpg', 'pdf')!.converter, 'images-to-pdf');
  assert.equal(planFor('a.xlsx', 'docx'), null);
});

t('planJobs groups by converter and respects maxFiles', () => {
  const files = ['a.docx', 'b.html', 'c.xlsx', 'd.md', 'e.exe'].map(name => ({ name }));
  const { batches, unsupported } = planJobs(files, 'pdf');
  assert.deepEqual(batches.map(b => [b.converter, b.files.map(f => f.name)]), [
    ['office-convert', ['a.docx', 'c.xlsx']], ['html-to-pdf', ['b.html', 'd.md']],
  ]);
  assert.deepEqual(unsupported.map(f => f.name), ['e.exe']);
  const vids = Array.from({ length: 3 }, (_, i) => ({ name: `v${i}.mp4` }));
  assert.equal(planJobs(vids, 'gif').batches.length, 3);
  assert.equal(planJobs(vids, 'webm').batches.length, 1);
});

t('page ranges', () => {
  assert.deepEqual(parsePageRanges('1-3, 5, 8-', 10).ranges, [[1, 3], [5, 5], [8, 10]]);
  assert.deepEqual(parsePageRanges('', 4).ranges, [[1, 4]]);
  assert.deepEqual(parsePageRanges('all', 4).ranges, [[1, 4]]);
  assert.deepEqual(parsePageRanges('-2,last', 9).ranges, [[1, 2], [9, 9]]);
  assert.deepEqual(parsePageRanges('2-99', 5).ranges, [[2, 5]]);
  assert.match(parsePageRanges('7', 5).error!, /after the last page \(5\)/);
  assert.match(parsePageRanges('4-2', 5).error!, /backwards/);
  assert.match(parsePageRanges('x', 5).error!, /isn't a page range/);
  assert.match(parsePageRanges('0', 5).error!, /start at 1/);
  assert.equal(countPages([[1, 3], [2, 5]]), 5);
});

t('describeSplit mirrors backend naming', () => {
  assert.deepEqual(describeSplit('doc.pdf', 5, 'ranges', { ranges: '1-2, 4, 5-' }).parts.map(p => p.name), ['doc_p1-2.pdf', 'doc_p4.pdf', 'doc_p5.pdf']);
  assert.deepEqual(describeSplit('doc.pdf', 12, 'every', { every: 5 }).parts.map(p => [p.name, p.pages]), [['doc_p01-05.pdf', 5], ['doc_p06-10.pdf', 5], ['doc_p11-12.pdf', 2]]);
  assert.equal(describeSplit('doc.pdf', 3, 'each', {}).parts.length, 3);
  const single = describeSplit('doc.pdf', 9, 'ranges', { ranges: '1,3-4', single: true }).parts;
  assert.deepEqual(single, [{ name: 'doc_selected.pdf', pages: 3, label: '1, 3–4' }]);
  assert.match(describeSplit('doc.pdf', 3, 'ranges', { ranges: '9' }).error!, /after the last page/);
  assert.deepEqual(describeSplit('doc.pdf', 0, 'each', {}).parts, []);
});

t('timecodes', () => {
  assert.equal(parseTimecode('75.5'), 75.5);
  assert.equal(parseTimecode('1:15.5'), 75.5);
  assert.equal(parseTimecode('01:02:03.25'), 3723.25);
  assert.equal(parseTimecode('12s'), 12);
  assert.equal(parseTimecode(''), null);
  assert.ok(Number.isNaN(parseTimecode('1:2:3:4')));
  assert.equal(formatTimecode(75.25), '1:15.25');
  assert.equal(formatTimecode(3725.5), '1:02:05.50');
  assert.equal(formatTimecode(5, 1), '0:05.0');
  assert.equal(formatTimecode(-1), '0:00.00');
  assert.equal(parseTimecode(formatTimecode(3725.5)), 3725.5);
  assert.equal(humanDuration(0.25), '250 ms');
  assert.equal(humanDuration(75), '1 min 15 s');
  assert.equal(humanDuration(3700), '1 h 2 min');
});

t('sizes', () => {
  assert.equal(toBytes(1, 'MiB'), 1048576);
  assert.equal(toBytes(1, 'MB'), 1e6);
  assert.equal(toBytes(8, 'bit'), 1);
  assert.equal(fromBytes(1e9, 'GB'), 1);
  assert.equal(fromBytes(1073741824, 'GiB'), 1);
  assert.equal(fromBytes(1e6, 'Mb'), 8);
  assert.equal(humanSize(1536, 'binary'), '1.5 KiB');
  assert.equal(humanSize(1500), '1.5 KB');
  assert.equal(humanSize(999), '999 B');
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(1e6), '1000000');
  assert.equal(formatNumber(1 / 3), '0.333333333333');
  assert.equal(formatNumber(1.5e22), '1.5e+22');
  // 1 GB at 100 Mbps = 80 s; 8 Mb at 8 Mbps = 1 s.
  assert.equal(transferSeconds(1e9, 100), 80);
  assert.equal(transferSeconds(1e6, 8), 1);
  assert.ok(Number.isNaN(transferSeconds(1, 0)));
  assert.equal(targetVideoKbps(10, 60, 128), Math.floor(10 * 8192 * 0.96 / 60 - 128));
});

t('zip safety + tree', () => {
  assert.equal(unsafeZipPath('a/b/c.txt'), null);
  assert.equal(unsafeZipPath('../evil.sh'), 'parent-directory (..) segment');
  assert.equal(unsafeZipPath('a/../../evil'), 'parent-directory (..) segment');
  assert.equal(unsafeZipPath('/etc/passwd'), 'absolute path');
  assert.equal(unsafeZipPath('C:/Windows/x.dll'), 'drive-letter path');
  assert.equal(unsafeZipPath('..\\x'), 'parent-directory (..) segment');
  assert.equal(unsafeZipPath('dir\\x'), 'backslash in path');
  assert.equal(unsafeZipPath('a..b/c'), null);
  const tree = buildTree([
    { path: 'src/', dir: true, size: 0, compressed: 0 },
    { path: 'src/b.ts', dir: false, size: 100, compressed: 40 },
    { path: 'src/a.ts', dir: false, size: 50, compressed: 20 },
    { path: 'README.md', dir: false, size: 10, compressed: 10 },
    { path: 'deep/x/y.txt', dir: false, size: 5, compressed: 5 },
  ]);
  assert.deepEqual(tree.children.map(c => c.name), ['deep', 'src', 'README.md']);
  assert.equal(tree.size, 165);
  assert.equal(tree.compressed, 75);
  const src = tree.children.find(c => c.name === 'src')!;
  assert.deepEqual(src.children.map(c => [c.name, c.size, c.compressed]), [['a.ts', 50, 20], ['b.ts', 100, 40]]);
  assert.equal(src.path, 'src/');
  assert.equal(tree.children[0].children[0].children[0].path, 'deep/x/y.txt');
  assert.equal(previewKind('a/b/readme'), 'text');
  assert.equal(previewKind('x.PNG'), 'image');
  assert.equal(previewKind('x.bin'), null);
});

t('misc', () => {
  assert.deepEqual(moveItem([1, 2, 3, 4], 0, 2), [2, 3, 1, 4]);
  assert.deepEqual(moveItem([1, 2, 3], 2, 0), [3, 1, 2]);
  assert.deepEqual(moveItem([1, 2, 3], 1, 9), [1, 3, 2]);
  assert.equal(formatDms(51.5, true), '51° 30′ 0.00″ N');
  assert.equal(formatDms(-0.1166667, false), '0° 7′ 0.00″ W');
  assert.equal(osmUrl(51.5, -0.12), 'https://www.openstreetmap.org/?mlat=51.500000&mlon=-0.120000#map=16/51.500000/-0.120000');
});

console.log(`files.ts: ${n} test groups passed`);
