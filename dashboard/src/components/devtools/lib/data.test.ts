// Run: node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/data.test.ts
import assert from 'node:assert/strict';
import {
  parseCsv, detectDelimiter, inferValue, csvToJson, flatten, jsonToCsv, toSql, quoteIdent, sqlLiteral, parseTabular,
  encodeBytes, decodeBytes, detectBase, textToMorse, morseToText, morseTimeline, toRoman, fromRoman,
  UNIT_CATEGORIES, convertUnit, formatNumber, type SqlOptions,
} from './data';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failures.push(name); console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

test('CSV: quotes, escaped quotes, embedded newlines, CRLF, BOM', () => {
  const r = parseCsv('﻿name,quote\r\n"Smith, J","He said ""hi"""\r\n"multi\nline",x\r\n');
  assert.deepEqual(r.rows, [['name', 'quote'], ['Smith, J', 'He said "hi"'], ['multi\nline', 'x']]);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(parseCsv('a,b\n1,').rows, [['a', 'b'], ['1', '']]);
  assert.deepEqual(parseCsv('"",x').rows, [['', 'x']]);
  assert.ok(parseCsv('"unterminated,1').errors.length > 0);
});

test('CSV: delimiter detection', () => {
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1,5;2;3'), ';');
  assert.equal(detectDelimiter('a|b\n1|2'), '|');
  assert.equal(detectDelimiter('a,b\n"x;y;z",2'), ',');
  assert.equal(detectDelimiter('single column\nvalue'), ',');
});

test('CSV: type inference', () => {
  assert.equal(inferValue('42'), 42);
  assert.equal(inferValue('-3.5e2'), -350);
  assert.equal(inferValue('007'), '007');
  assert.equal(inferValue('TRUE'), true);
  assert.equal(inferValue(''), null);
  assert.equal(inferValue('12345678901234567890'), '12345678901234567890');
  assert.equal(inferValue('1,000'), '1,000');
});

test('CSV → JSON objects / arrays, duplicate headers', () => {
  const r = csvToJson('id;name;id\n1;Ann;x\n\n2;Bob;y', { delimiter: 'auto', header: true, infer: true, output: 'objects', skipEmpty: true });
  assert.deepEqual(r.data, [{ id: 1, name: 'Ann', id_2: 'x' }, { id: 2, name: 'Bob', id_2: 'y' }]);
  assert.equal(r.delimiter, ';');
  const a = csvToJson('a,b\n1,2', { delimiter: ',', header: false, infer: false, output: 'arrays', skipEmpty: true });
  assert.deepEqual(a.data, [['a', 'b'], ['1', '2']]);
});

test('flatten + JSON → CSV', () => {
  assert.deepEqual(flatten({ a: { b: 1, c: [1, 2] } }, { arrays: 'join', joinWith: ';' }), { 'a.b': 1, 'a.c': '1;2' });
  assert.deepEqual(flatten({ c: [{ x: 1 }, { x: 2 }] }, { arrays: 'index', joinWith: ';' }), { 'c.0.x': 1, 'c.1.x': 2 });
  const opts = { delimiter: ',' as const, quoteAll: false, arrays: 'join' as const, joinWith: '|', header: true, eol: '\n' as const, bom: false };
  const r = jsonToCsv([{ id: 1, user: { name: 'A, B' } }, { id: 2, note: 'say "hi"', user: { name: 'C' } }], opts);
  assert.equal(r.csv, 'id,user.name,note\n1,"A, B",\n2,C,"say ""hi"""');
  assert.equal(jsonToCsv({ items: [{ a: 1 }] }, opts).csv, 'a\n1');
  assert.equal(jsonToCsv([{ a: 'x' }], { ...opts, quoteAll: true, delimiter: '\t' }).csv, '"a"\n"x"');
});

const SQL: SqlOptions = { dialect: 'postgres', table: 'users', createTable: true, dropTable: false, batchSize: 2, upsert: false, key: 'id', inferTypes: true };
const ROWS = [
  { id: 1, name: "O'Brien", active: true, score: 9.5, joined: '2024-01-02', meta: { tags: ['a'] } },
  { id: 2, name: 'back\\slash', active: false, score: 7, joined: '2024-02-03T10:00:00Z', meta: null },
  { id: 3, name: null, active: true, score: null, joined: null, meta: null },
];

test('SQL: identifier quoting and literal escaping per dialect', () => {
  assert.equal(quoteIdent('we"ird', 'postgres'), '"we""ird"');
  assert.equal(quoteIdent('we`ird', 'mysql'), '`we``ird`');
  assert.equal(quoteIdent('we]ird', 'mssql'), '[we]]ird]');
  assert.equal(sqlLiteral("O'Brien", 'text', 'postgres'), "'O''Brien'");
  assert.equal(sqlLiteral('a\\b', 'text', 'mysql'), "'a\\\\b'");
  assert.equal(sqlLiteral('a\\b', 'text', 'postgres'), "'a\\b'");
  assert.equal(sqlLiteral('ünï', 'text', 'mssql'), "N'ünï'");
  assert.equal(sqlLiteral(true, 'boolean', 'mysql'), '1');
  assert.equal(sqlLiteral(null, 'text', 'sqlite'), 'NULL');
});

test('SQL: CREATE TABLE types + batched INSERTs (postgres)', () => {
  const r = toSql(ROWS, SQL);
  assert.equal(r.statements, 2);
  assert.match(r.sql, /CREATE TABLE IF NOT EXISTS "users" \(/);
  assert.match(r.sql, /"id" INTEGER NOT NULL/);
  assert.match(r.sql, /"active" BOOLEAN/);
  assert.match(r.sql, /"score" NUMERIC/);
  assert.match(r.sql, /"joined" TIMESTAMPTZ/);
  assert.match(r.sql, /"meta" JSONB/);
  assert.match(r.sql, /PRIMARY KEY \("id"\)/);
  assert.match(r.sql, /\(1, 'O''Brien', TRUE, 9\.5, '2024-01-02', '\{"tags":\["a"\]\}'\)/);
  assert.equal((r.sql.match(/INSERT INTO/g) ?? []).length, 2);
});

test('SQL: upserts for every dialect', () => {
  assert.match(toSql(ROWS, { ...SQL, upsert: true }).sql, /ON CONFLICT \("id"\) DO UPDATE SET "name" = EXCLUDED\."name"/);
  assert.match(toSql(ROWS, { ...SQL, dialect: 'sqlite', upsert: true }).sql, /ON CONFLICT/);
  const my = toSql(ROWS, { ...SQL, dialect: 'mysql', upsert: true }).sql;
  assert.match(my, /ON DUPLICATE KEY UPDATE `name` = VALUES\(`name`\)/);
  assert.match(my, /`name` VARCHAR\(16\)/);
  const ms = toSql(ROWS, { ...SQL, dialect: 'mssql', upsert: true, dropTable: true, table: 'dbo.users' }).sql;
  assert.match(ms, /MERGE INTO \[dbo\]\.\[users\] AS target/);
  assert.match(ms, /IF OBJECT_ID\(N'dbo\.users', N'U'\) IS NOT NULL DROP TABLE/);
  assert.match(ms, /\[active\] BIT/);
});

test('parseTabular: JSON objects, array-of-arrays, CSV', () => {
  assert.equal(parseTabular('[{"a":1}]').records[0].a, 1);
  assert.deepEqual(parseTabular('[["a","b"],[1,2]]').records, [{ a: 1, b: 2 }]);
  const c = parseTabular('a,b\n1,x');
  assert.equal(c.source, 'csv');
  assert.deepEqual(c.records, [{ a: 1, b: 'x' }]);
});

test('bytes: encode/decode UTF-8 in every base + auto-detect', () => {
  const t = 'Hé😀';
  for (const base of [2, 8, 10, 16] as const) {
    const enc = encodeBytes(t, base);
    const dec = decodeBytes(enc, base);
    assert.equal(dec.text, t, `base ${base}`);
    assert.equal(dec.bytes, 7);
  }
  assert.equal(encodeBytes('A', 2), '01000001');
  assert.equal(encodeBytes('Hi', 16, { prefix: true, upper: true, separator: ', ' }), '0x48, 0x69');
  assert.equal(detectBase('01001000 01101001'), 2);
  assert.equal(detectBase('48 65 6c 6c 6f'), 16);
  assert.equal(detectBase('48656c6c6f'), 16);
  assert.equal(detectBase('72 101 108 108 111'), 10);
  assert.equal(detectBase('110 145 154 154 157'), 8);
  assert.equal(detectBase('0x0b 0x1f'), 16);
  assert.equal(decodeBytes('0x48 0x0b', 'auto').base, 16);
  assert.equal(decodeBytes('0100100001101001', 'auto').text, 'Hi');
  assert.equal(decodeBytes('\\x48\\x69', 'auto').text, 'Hi');
  assert.ok(decodeBytes('300', 10).error);
  assert.ok(decodeBytes('ff', 16).error); // invalid UTF-8
  assert.ok(decodeBytes('zz', 16).error);
});

test('morse: round trip, prosigns, punctuation, timeline', () => {
  const m = textToMorse('SOS help, me!');
  assert.equal(m.morse, '... --- ... / .... . .-.. .--. --..-- / -- . -.-.--');
  assert.equal(morseToText(m.morse).text, 'SOS HELP, ME!');
  assert.equal(textToMorse('<AR>').morse, '.-.-.');
  assert.equal(morseToText('...---...').text, '<SOS>');
  assert.equal(morseToText('•••  ___').text, 'S O'.replace(' ', '')); // 2 spaces = letter gap
  assert.equal(morseToText('... | ---').text, 'S O');
  assert.deepEqual(textToMorse('a#').unknown, ['#']);
  const tl = morseTimeline('.- / -');
  assert.deepEqual(tl.map(x => [x.on, x.units]), [[true, 1], [false, 1], [true, 3], [false, 7], [true, 3]]);
});

test('roman numerals', () => {
  assert.equal(toRoman(1994), 'MCMXCIV');
  assert.equal(toRoman(3999), 'MMMCMXCIX');
  assert.throws(() => toRoman(4000));
  assert.throws(() => toRoman(0));
  assert.equal(toRoman(4000, true), 'I̅V̅');
  assert.equal(toRoman(1_000_000, true), 'M̅');
  assert.equal(fromRoman('mcmxciv'), 1994);
  assert.equal(fromRoman('I̅V̅CD'), 4400);
  assert.throws(() => fromRoman('IIII'));
  assert.throws(() => fromRoman('IC'));
  assert.throws(() => fromRoman('ABC'));
  for (const n of [1, 4, 9, 14, 40, 90, 400, 944, 2024, 3888]) assert.equal(fromRoman(toRoman(n)), n);
  for (const n of [4001, 12_345, 3_999_999]) assert.equal(fromRoman(toRoman(n, true)), n);
});

test('units', () => {
  const cat = (id: string) => UNIT_CATEGORIES.find(c => c.id === id)!;
  const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);
  close(convertUnit(cat('length'), 1, 'mi', 'km'), 1.609344);
  close(convertUnit(cat('temperature'), 100, 'c', 'f'), 212);
  close(convertUnit(cat('temperature'), -40, 'f', 'c'), -40);
  close(convertUnit(cat('temperature'), 0, 'c', 'k'), 273.15);
  close(convertUnit(cat('data'), 1, 'GiB', 'MB'), 1073.741824);
  close(convertUnit(cat('fuel'), 10, 'l100', 'kml'), 10);
  close(convertUnit(cat('fuel'), 30, 'mpgus', 'l100'), 7.84048610, 1e-6);
  close(convertUnit(cat('mass'), 1, 'lb', 'g'), 453.59237);
  close(convertUnit(cat('angle'), 180, 'deg', 'rad'), Math.PI);
  close(convertUnit(cat('pressure'), 1, 'atm', 'psi'), 14.6959488, 1e-6);
  assert.ok(UNIT_CATEGORIES.length >= 14);
  assert.equal(formatNumber(1234.5), '1,234.5');
  assert.equal(formatNumber(1e20), '1e+20');
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
