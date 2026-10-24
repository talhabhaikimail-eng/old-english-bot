// Run: node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/text.test.ts
import assert from 'node:assert/strict';
import {
  graphemeCount, wordList, textStats, formatMinutes, smsInfo, tweetLength, dedupeLines, DEFAULT_DEDUPE, sortLines,
  FANCY_STYLES, upsideDown, reverseChars, reverseWords, reverseLines, reverseEachWord, lorem, zalgo,
} from './text';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failures.push(name); console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

test('graphemes keep emoji sequences whole', () => {
  assert.equal(graphemeCount('👨‍👩‍👧‍👦'), 1);
  assert.equal(graphemeCount('🇵🇰🇺🇸'), 2);
  assert.equal(graphemeCount('é'), 1); // e + combining acute
  assert.equal(graphemeCount('héllo'), 5);
  assert.equal(graphemeCount(''), 0);
});

test('word list handles punctuation, contractions and unicode', () => {
  assert.deepEqual(wordList("Don't stop—it's 2024, café!"), ["Don't", 'stop', "it's", '2024', 'café']);
});

test('text stats', () => {
  const s = textStats('The cat sat. The cat ran away!\n\nA new paragraph about the cat? Yes.');
  assert.equal(s.words, 14);
  assert.equal(s.sentences, 4);
  assert.equal(s.paragraphs, 2);
  assert.equal(s.keywords[0].word, 'cat');
  assert.equal(s.keywords[0].count, 3);
  assert.ok(s.characters > s.charactersNoSpaces);
  assert.equal(s.longestWord, 'paragraph');
  const empty = textStats('');
  assert.equal(empty.words, 0);
  assert.equal(empty.sentences, 0);
  assert.equal(empty.paragraphs, 0);
  assert.equal(formatMinutes(0.2), '12 s');
  assert.equal(formatMinutes(1.5), '1 min 30 s');
  assert.equal(formatMinutes(125), '2 h 5 min');
});

test('SMS segments GSM-7 vs UCS-2', () => {
  assert.deepEqual([smsInfo('a'.repeat(160)).segments, smsInfo('a'.repeat(160)).encoding], [1, 'GSM-7']);
  assert.equal(smsInfo('a'.repeat(161)).segments, 2);
  assert.equal(smsInfo('a'.repeat(306)).segments, 2);
  assert.equal(smsInfo('a'.repeat(307)).segments, 3);
  assert.equal(smsInfo('€').units, 2); // extension table
  const u = smsInfo('hello 😀');
  assert.equal(u.encoding, 'UCS-2');
  assert.equal(u.units, 8);
  assert.deepEqual(u.nonGsm, ['😀']);
  assert.equal(smsInfo('x'.repeat(71) + 'ü').encoding, 'GSM-7');
  assert.equal(smsInfo('ж'.repeat(71)).segments, 2);
});

test('tweet length weighting', () => {
  assert.equal(tweetLength('hello'), 5);
  assert.equal(tweetLength('日本'), 4);
  assert.equal(tweetLength('hi 👋🏽'), 5);
  assert.equal(tweetLength('see https://example.com/a/very/long/path?x=1'), 4 + 23);
});

test('dedupe lines: keep first/last, case, whitespace, empties', () => {
  const t = 'apple\nBanana\napple \n\nbanana\ncherry\napple';
  let r = dedupeLines(t, DEFAULT_DEDUPE);
  assert.equal(r.output, 'apple\nBanana\nbanana\ncherry');
  assert.equal(r.emptyRemoved, 1);
  assert.equal(r.duplicatesRemoved, 2);
  r = dedupeLines(t, { ...DEFAULT_DEDUPE, caseInsensitive: true });
  assert.equal(r.output, 'apple\nBanana\ncherry');
  r = dedupeLines(t, { ...DEFAULT_DEDUPE, keep: 'last', caseInsensitive: true });
  assert.equal(r.output, 'banana\ncherry\napple');
  r = dedupeLines(t, { ...DEFAULT_DEDUPE, mode: 'duplicates' });
  assert.equal(r.output, 'apple');
  r = dedupeLines(t, { ...DEFAULT_DEDUPE, mode: 'unique', caseInsensitive: true });
  assert.equal(r.output, 'cherry');
  r = dedupeLines('a\n a\n\n', { ...DEFAULT_DEDUPE, trim: false, ignoreWhitespace: false, removeEmpty: false });
  assert.equal(r.output, 'a\n a\n');
});

test('sorting: natural, length, random is a seeded permutation', () => {
  assert.deepEqual(sortLines(['item10', 'item2', 'Item1'], 'natural'), ['Item1', 'item2', 'item10']);
  assert.deepEqual(sortLines(['bbb', 'a', 'cc'], 'length'), ['a', 'cc', 'bbb']);
  assert.deepEqual(sortLines(['b', 'a', 'c'], 'desc'), ['c', 'b', 'a']);
  const r1 = sortLines(['1', '2', '3', '4', '5'], 'random', 42);
  assert.deepEqual(r1, sortLines(['1', '2', '3', '4', '5'], 'random', 42));
  assert.deepEqual([...r1].sort(), ['1', '2', '3', '4', '5']);
});

test('fancy text styles', () => {
  assert.ok(FANCY_STYLES.length >= 20);
  const by = (id: string) => FANCY_STYLES.find(s => s.id === id)!.fn;
  assert.equal(by('bold')('Ab1'), '𝐀𝐛𝟏');
  assert.equal(by('italic')('h'), 'ℎ');
  assert.equal(by('script')('Be'), 'ℬℯ');
  assert.equal(by('fraktur')('C'), 'ℭ');
  assert.equal(by('double-struck')('R1'), 'ℝ𝟙');
  assert.equal(by('monospace')('x'), '𝚡');
  assert.equal(by('circled')('a0'), 'ⓐ⓪');
  assert.equal(by('squared')('a'), '🄰');
  assert.equal(by('fullwidth')('A b'), 'Ａ　ｂ');
  assert.equal(by('small-caps')('hi'), 'ʜɪ');
  assert.equal(by('strike')('a b'), 'a̶ b̶');
  for (const s of FANCY_STYLES) assert.ok(s.fn('Hello World 123').length > 0, s.id);
  assert.equal(zalgo('ab', 1, 3), zalgo('ab', 1, 3));
});

test('reversers are grapheme-safe', () => {
  assert.equal(reverseChars('ab👨‍👩‍👧c'), 'c👨‍👩‍👧ba');
  assert.equal(reverseChars('🇵🇰x'), 'x🇵🇰');
  assert.equal(reverseWords('one two  three\nfour five'), 'three  two one\nfive four');
  assert.equal(reverseLines('a\nb\nc'), 'c\nb\na');
  assert.equal(reverseEachWord('hello world'), 'olleh dlrow');
  assert.equal(upsideDown('hello'), 'ollǝɥ');
  assert.equal(upsideDown('ab\ncd'), 'pɔ\nqɐ');
});

test('lorem ipsum', () => {
  const p = lorem({ unit: 'paragraphs', count: 3, startWithLorem: true, html: false, seed: 1 });
  assert.ok(p.startsWith('Lorem ipsum dolor sit amet'));
  assert.equal(p.split('\n\n').length, 3);
  assert.equal(lorem({ unit: 'words', count: 7, startWithLorem: false, html: false, seed: 2 }).split(' ').length, 7);
  assert.equal(lorem({ unit: 'words', count: 3, startWithLorem: true, html: false, seed: 2 }), 'Lorem ipsum dolor');
  const html = lorem({ unit: 'list', count: 4, startWithLorem: false, html: true, seed: 3 });
  assert.equal((html.match(/<li>/g) ?? []).length, 4);
  assert.ok(html.startsWith('<ul>'));
  const s = lorem({ unit: 'sentences', count: 5, startWithLorem: false, html: false, seed: 4 });
  assert.equal((s.match(/[.?](\s|$)/g) ?? []).length, 5);
  assert.equal(p, lorem({ unit: 'paragraphs', count: 3, startWithLorem: true, html: false, seed: 1 }));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
