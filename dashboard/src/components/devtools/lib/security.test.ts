// Run: node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/security.test.ts
import assert from 'node:assert/strict';
import {
  analyzePassword, diceRange, formatDuration, generatePassphrase, generatePassword, hibpCount, parseDice, passwordEntropy,
  passwordPool, PASSPHRASE_WORDS, randomBelow, randomDecimal, randomInt, rollDice, sha1Hex, shuffle, uniqueInts, pick,
  validatePasswordOptions, SIMILAR, AMBIGUOUS, type PasswordOptions,
} from './security';
import { COMMON_PASSWORDS, WORDLIST } from './security-words';

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).stack}`); process.exitCode = 1; }
}

await t('word lists are large enough and clean', () => {
  assert.ok(WORDLIST.length >= 1000, `wordlist has ${WORDLIST.length}`);
  assert.ok(PASSPHRASE_WORDS.length >= 1000, `passphrase list has ${PASSPHRASE_WORDS.length}`);
  assert.ok(WORDLIST.every(w => /^[a-z]+$/.test(w)));
  assert.ok(COMMON_PASSWORDS.length >= 450, `common passwords: ${COMMON_PASSWORDS.length}`);
  assert.equal(COMMON_PASSWORDS[0], '123456');
});

await t('randomBelow is in range and roughly uniform (chi-square)', () => {
  const k = 6, N = 60_000;
  const counts = new Array(k).fill(0);
  for (let i = 0; i < N; i++) counts[randomBelow(k)]++;
  const exp = N / k;
  const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
  assert.ok(chi < 25, `chi² ${chi.toFixed(1)} too high for 5 dof: ${counts}`); // p < 0.0002
  for (let i = 0; i < 1000; i++) {
    const v = randomBelow(2 ** 40 + 3);
    assert.ok(v >= 0 && v < 2 ** 40 + 3 && Number.isInteger(v));
  }
  assert.throws(() => randomBelow(0));
});

await t('randomInt / randomDecimal bounds', () => {
  for (let i = 0; i < 2000; i++) {
    const v = randomInt(-5, 5);
    assert.ok(v >= -5 && v <= 5);
    const d = randomDecimal(1, 2, 2);
    assert.ok(d >= 1 && d <= 2 && Number(d.toFixed(2)) === d);
  }
  assert.equal(randomInt(7, 7), 7);
  const seen = new Set(Array.from({ length: 500 }, () => randomInt(1, 3)));
  assert.deepEqual([...seen].sort(), [1, 2, 3]);
});

await t('uniqueInts / shuffle / pick', () => {
  const u = uniqueInts(1, 10, 10);
  assert.deepEqual([...u].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const sparse = uniqueInts(1, 1e9, 50);
  assert.equal(new Set(sparse).size, 50);
  assert.throws(() => uniqueInts(1, 5, 6));
  const s = shuffle([1, 2, 3, 4, 5]);
  assert.deepEqual([...s].sort(), [1, 2, 3, 4, 5]);
  assert.equal(new Set(pick(['a', 'b', 'c'], 3, true)).size, 3);
  assert.equal(pick(['a'], 4, false).length, 4);
});

await t('dice notation', () => {
  const t1 = parseDice('3d6+2') as any[];
  assert.equal(t1.length, 2);
  assert.deepEqual(diceRange(t1), { min: 5, max: 20, mean: 12.5 });
  for (let i = 0; i < 200; i++) {
    const r = rollDice(t1);
    assert.ok(r.total >= 5 && r.total <= 20);
    assert.equal(r.terms[0].rolls.length, 3);
  }
  const adv = parseDice('2d20kh1') as any[];
  for (let i = 0; i < 100; i++) {
    const r = rollDice(adv);
    assert.equal(r.total, Math.max(...r.terms[0].rolls));
    assert.equal(r.terms[0].kept.filter(Boolean).length, 1);
  }
  const stats = parseDice('4d6dl1') as any[];
  const r = rollDice(stats);
  assert.equal(r.total, r.terms[0].rolls.reduce((a: number, b: number) => a + b, 0) - Math.min(...r.terms[0].rolls));
  assert.deepEqual(diceRange(parseDice('d%') as any), { min: 1, max: 100, mean: 50.5 });
  assert.deepEqual(diceRange(parseDice('1d8 - 1d4 - 1') as any), { min: -4, max: 6, mean: 1 });
  assert.ok('error' in (parseDice('3x6') as any));
  assert.ok('error' in (parseDice('2d1') as any));
  assert.ok('error' in (parseDice('2d6kh3') as any));
  assert.ok('error' in (parseDice('') as any));
});

const base: PasswordOptions = { length: 20, upper: true, lower: true, digits: true, symbols: true };

await t('password generator honours every option', () => {
  for (let i = 0; i < 200; i++) {
    const p = generatePassword({ ...base, requireEach: true, length: 4 });
    assert.match(p, /[A-Z]/); assert.match(p, /[a-z]/); assert.match(p, /\d/); assert.match(p, /[^A-Za-z0-9]/);
  }
  const noSim = generatePassword({ ...base, length: 200, excludeSimilar: true, excludeAmbiguous: true });
  assert.ok(![...noSim].some(c => SIMILAR.includes(c) || AMBIGUOUS.includes(c)));
  const uniq = generatePassword({ ...base, length: 60, noRepeats: true });
  assert.equal(new Set(uniq).size, 60);
  const custom = generatePassword({ length: 50, upper: false, lower: false, digits: false, symbols: true, symbolSet: '#%' });
  assert.match(custom, /^[#%]{50}$/);
  const ex = generatePassword({ ...base, length: 300, exclude: 'aeiouAEIOU' });
  assert.doesNotMatch(ex, /[aeiou]/i);
  assert.equal(passwordPool({ length: 8, upper: false, lower: false, digits: true, symbols: false }), '0123456789');
  assert.ok(Math.abs(passwordEntropy({ length: 10, upper: false, lower: true, digits: false, symbols: false }) - 47.0) < 0.01);
  assert.ok(validatePasswordOptions({ ...base, upper: false, lower: false, digits: false, symbols: false }));
  assert.ok(validatePasswordOptions({ length: 11, upper: false, lower: false, digits: true, symbols: false, noRepeats: true }));
  assert.ok(validatePasswordOptions({ ...base, length: 3, requireEach: true }));
  assert.throws(() => generatePassword({ ...base, length: 0 }));
});

await t('passphrase generator', () => {
  const r = generatePassphrase({ words: 5, separator: '-', capitalize: 'first', addNumber: true, addSymbol: false });
  const parts = r.phrase.split('-');
  assert.equal(parts.length, 5);
  assert.ok(parts.every(p => /^[A-Z][a-z]+\d{0,2}$/.test(p)), r.phrase);
  assert.equal(parts.filter(p => /\d/.test(p)).length, 1);
  assert.ok(r.entropy > 5 * Math.log2(1000));
  const plain = generatePassphrase({ words: 4, separator: ' ', capitalize: 'none', addNumber: false, addSymbol: false });
  assert.ok(Math.abs(plain.entropy - 4 * Math.log2(PASSPHRASE_WORDS.length)) < 1e-9);
});

await t('strength: common passwords and patterns are weak', () => {
  const a = analyzePassword('password');
  assert.equal(a.isCommon, true);
  assert.equal(a.score, 0);
  const l = analyzePassword('P@ssw0rd');
  assert.ok(l.score <= 1, `P@ssw0rd score ${l.score}`);
  assert.ok(analyzePassword('M0nk3y').segments.some(s => s.leet));
  assert.ok(analyzePassword('qwertyuiop').score <= 1);
  assert.ok(analyzePassword('qwertyuiop').segments.some(s => s.kind === 'keyboard' || s.kind === 'password'));
  assert.ok(analyzePassword('abcdefgh').segments.some(s => s.kind === 'sequence'));
  assert.ok(analyzePassword('aaaaaaaaaaaa').segments.some(s => s.kind === 'repeat'));
  assert.ok(analyzePassword('aaaaaaaaaaaa').score <= 1);
  const d = analyzePassword('Michael1987');
  assert.ok(d.segments.some(s => s.kind === 'name' || s.kind === 'password'));
  assert.ok(d.segments.some(s => s.kind === 'year' || s.kind === 'date'));
  assert.ok(d.score <= 2);
  assert.ok(analyzePassword('12/05/1990').segments.some(s => s.kind === 'date'));
  assert.ok(analyzePassword('Summer2024!').score <= 2);
});

await t('strength: random and long passwords are strong', () => {
  const r = analyzePassword('t7#Kq9!vZp2@Lm4x');
  assert.equal(r.score, 4);
  assert.ok(r.bits > 80);
  assert.ok(r.crack.find(c => c.id === 'offline-fast')!.seconds > 3.15e7);
  const pp = analyzePassword('correct horse battery staple');
  assert.ok(pp.score >= 3, `passphrase score ${pp.score}`);
  const empty = analyzePassword('');
  assert.equal(empty.length, 0);
  assert.equal(empty.score, 0);
  // segments cover the whole password exactly once
  const mixed = analyzePassword('xX_dragon1987_Xx!');
  assert.equal(mixed.segments.map(s => s.token).join(''), 'xX_dragon1987_Xx!');
});

await t('crack-time formatting', () => {
  assert.equal(formatDuration(0.5), 'instantly');
  assert.equal(formatDuration(45), '45 seconds');
  assert.equal(formatDuration(3600 * 5), '5 hours');
  assert.equal(formatDuration(31557600 * 3), '3 years');
  assert.equal(formatDuration(31557600 * 5000), 'centuries');
  assert.match(formatDuration(1e30), /universe/);
});

await t('HIBP helpers (k-anonymity)', async () => {
  const h = await sha1Hex('password');
  assert.equal(h, '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
  const body = '003D68EB55068C33ACE09247EE4C639306B:3\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n';
  assert.equal(hibpCount(body, h.slice(5)), 9545824);
  assert.equal(hibpCount(body, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), 0);
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}`);
