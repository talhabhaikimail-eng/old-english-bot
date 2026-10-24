// Pure data-conversion helpers for the Data Converters tools (no React, no path aliases).

// ───────────────────────── CSV ─────────────────────────

export type Delimiter = ',' | '\t' | ';' | '|';
export const DELIMITERS: { value: Delimiter; label: string }[] = [
  { value: ',', label: 'Comma' }, { value: '\t', label: 'Tab' }, { value: ';', label: 'Semicolon' }, { value: '|', label: 'Pipe' },
];

/** Pick the delimiter that occurs most consistently (outside quotes) across the first lines. */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 20_000);
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const d of [',', '\t', ';', '|'] as Delimiter[]) {
    const counts: number[] = [];
    let n = 0, inQ = false;
    for (let i = 0; i < sample.length && counts.length < 20; i++) {
      const c = sample[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ && c === d) n++;
      else if (!inQ && c === '\n') { counts.push(n); n = 0; }
    }
    if (n || !counts.length) counts.push(n);
    const lines = counts.filter((_, i) => i < counts.length);
    if (!lines.some(x => x > 0)) continue;
    const mode = lines.sort((a, b) => a - b)[Math.floor(lines.length / 2)];
    const consistent = lines.filter(x => x === mode).length / lines.length;
    const score = mode > 0 ? consistent * 100 + Math.min(mode, 50) : 0;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

export interface CsvParseResult { rows: string[][]; delimiter: Delimiter; errors: string[] }

/** RFC 4180 parser: quoted fields, "" escapes, CR/LF/CRLF, newlines inside quotes, BOM. */
export function parseCsv(input: string, delimiter: Delimiter | 'auto' = 'auto'): CsvParseResult {
  const text = input.replace(/^﻿/, '');
  const d = delimiter === 'auto' ? detectDelimiter(text) : delimiter;
  const rows: string[][] = [];
  const errors: string[] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  const endField = () => { row.push(field); field = ''; quotedField = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (c === '\n') line++;
      field += c; i++; continue;
    }
    if (c === '"') {
      if (field === '' && !quotedField) { inQuotes = true; quotedField = true; i++; continue; }
      // Stray quote inside an unquoted field — keep it literally (lenient, like Excel).
      field += c; i++; continue;
    }
    if (c === d) { endField(); i++; continue; }
    if (c === '\r' || c === '\n') {
      endRow();
      line++;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (quotedField) { errors.push(`Line ${line}: unexpected character after closing quote`); quotedField = false; }
    field += c; i++;
  }
  if (inQuotes) errors.push(`Unterminated quoted field starting before line ${line}`);
  if (field !== '' || row.length || quotedField) endRow();
  return { rows, delimiter: d, errors };
}

/** "42" → 42, "true" → true, "" / "null" → null. Keeps leading-zero codes ("007") and huge ints as strings. */
export function inferValue(s: string): unknown {
  const t = s.trim();
  if (t === '' || /^null$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n) && (Number.isSafeInteger(n) || !/^-?\d+$/.test(t))) return n;
  }
  return s;
}

export interface CsvToJsonOptions { delimiter: Delimiter | 'auto'; header: boolean; infer: boolean; output: 'objects' | 'arrays'; skipEmpty: boolean }

export function csvToJson(text: string, o: CsvToJsonOptions) {
  const parsed = parseCsv(text, o.delimiter);
  let rows = parsed.rows;
  if (o.skipEmpty) rows = rows.filter(r => r.some(c => c.trim() !== ''));
  const conv = (v: string) => (o.infer ? inferValue(v) : v);
  let headers: string[] = [];
  let body = rows;
  if (o.header && rows.length) {
    const seen = new Map<string, number>();
    headers = rows[0].map((h, i) => {
      let k = h.trim() || `column_${i + 1}`;
      const c = seen.get(k) ?? 0;
      seen.set(k, c + 1);
      if (c) k = `${k}_${c + 1}`;
      return k;
    });
    body = rows.slice(1);
  }
  const width = Math.max(headers.length, ...body.map(r => r.length), 0);
  const data = o.header && o.output === 'objects'
    ? body.map(r => Object.fromEntries(headers.map((h, i) => [h, conv(r[i] ?? '')])))
    : (o.header ? [headers, ...body] : body).map((r, ri) => (o.header && ri === 0 ? r : r.map(conv)));
  const ragged = body.filter(r => r.length !== (o.header ? headers.length : width)).length;
  return { data, headers, rows: body.length, cols: width, delimiter: parsed.delimiter, errors: parsed.errors, ragged };
}

// ───────────────────────── JSON → CSV ─────────────────────────

export interface JsonToCsvOptions {
  delimiter: Delimiter;
  quoteAll: boolean;
  arrays: 'join' | 'index' | 'json';
  joinWith: string;
  header: boolean;
  eol: '\n' | '\r\n';
  bom: boolean;
}

/** Flatten nested objects into dot paths. */
export function flatten(value: unknown, o: Pick<JsonToCsvOptions, 'arrays' | 'joinWith'>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (o.arrays === 'index') {
      if (!value.length && prefix) out[prefix] = '';
      value.forEach((v, i) => flatten(v, o, prefix ? `${prefix}.${i}` : String(i), out));
    } else if (o.arrays === 'json') out[prefix || 'value'] = JSON.stringify(value);
    else out[prefix || 'value'] = value.every(v => v === null || typeof v !== 'object') ? value.map(v => (v === null ? '' : String(v))).join(o.joinWith) : JSON.stringify(value);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length && prefix) out[prefix] = '';
    for (const [k, v] of entries) flatten(v, o, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix || 'value'] = value;
  return out;
}

export function csvCell(v: unknown, delimiter: string, quoteAll: boolean): string {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return quoteAll || s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function jsonToCsv(input: unknown, o: JsonToCsvOptions) {
  let rows: unknown[];
  if (Array.isArray(input)) rows = input;
  else if (input && typeof input === 'object') {
    // { "items": [...] } → use the first array property; otherwise treat the object as one row.
    const arr = Object.values(input as object).find(Array.isArray) as unknown[] | undefined;
    rows = arr ?? [input];
  } else rows = [input];
  const flat = rows.map(r => flatten(r, o));
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of flat) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const lines: string[] = [];
  if (o.header) lines.push(cols.map(c => csvCell(c, o.delimiter, o.quoteAll)).join(o.delimiter));
  for (const r of flat) lines.push(cols.map(c => csvCell(r[c], o.delimiter, o.quoteAll)).join(o.delimiter));
  return { csv: (o.bom ? '﻿' : '') + lines.join(o.eol), columns: cols, rows: flat.length };
}

// ───────────────────────── SQL ─────────────────────────

export type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql';
export interface SqlOptions {
  dialect: Dialect;
  table: string;
  createTable: boolean;
  dropTable: boolean;
  batchSize: number;
  upsert: boolean;
  key: string;
  inferTypes: boolean;
}

type ColType = 'integer' | 'bigint' | 'decimal' | 'boolean' | 'date' | 'timestamp' | 'json' | 'text';

export function quoteIdent(name: string, d: Dialect): string {
  if (d === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  if (d === 'mssql') return '[' + name.replace(/]/g, ']]') + ']';
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Qualified names like schema.table are quoted part by part. */
export const quoteQualified = (name: string, d: Dialect) => name.split('.').map(p => quoteIdent(p.trim(), d)).join('.');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function typeOf(v: unknown): ColType | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? (Math.abs(v) > 2147483647 ? 'bigint' : 'integer') : 'decimal';
  if (typeof v === 'object') return 'json';
  const s = String(v);
  if (ISO_DATE.test(s)) return 'date';
  if (ISO_TS.test(s)) return 'timestamp';
  return 'text';
}

const RANK: ColType[] = ['boolean', 'integer', 'bigint', 'decimal'];
function merge(a: ColType | null, b: ColType | null): ColType | null {
  if (!a) return b;
  if (!b || a === b) return a;
  if (RANK.includes(a) && RANK.includes(b) && a !== 'boolean' && b !== 'boolean') return RANK.indexOf(a) > RANK.indexOf(b) ? a : b;
  if ((a === 'date' && b === 'timestamp') || (a === 'timestamp' && b === 'date')) return 'timestamp';
  return 'text';
}

function sqlType(t: ColType | null, d: Dialect, maxLen: number): string {
  const T = t ?? 'text';
  const map: Record<Dialect, Record<ColType, string>> = {
    postgres: { integer: 'INTEGER', bigint: 'BIGINT', decimal: 'NUMERIC', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMPTZ', json: 'JSONB', text: 'TEXT' },
    mysql: { integer: 'INT', bigint: 'BIGINT', decimal: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'DATETIME', json: 'JSON', text: maxLen <= 255 ? `VARCHAR(${Math.max(1, Math.min(255, nicer(maxLen)))})` : 'TEXT' },
    sqlite: { integer: 'INTEGER', bigint: 'INTEGER', decimal: 'REAL', boolean: 'INTEGER', date: 'TEXT', timestamp: 'TEXT', json: 'TEXT', text: 'TEXT' },
    mssql: { integer: 'INT', bigint: 'BIGINT', decimal: 'FLOAT', boolean: 'BIT', date: 'DATE', timestamp: 'DATETIME2', json: 'NVARCHAR(MAX)', text: maxLen <= 4000 ? `NVARCHAR(${Math.max(1, nicer(maxLen))})` : 'NVARCHAR(MAX)' },
  };
  return map[d][T];
}
/** Round a max length up to a friendly column size. */
const nicer = (n: number) => [16, 32, 64, 100, 128, 255, 500, 1000, 2000, 4000].find(x => x >= n) ?? n;

export function sqlLiteral(v: unknown, t: ColType | null, d: Dialect): string {
  if (v === null || v === undefined || (v === '' && t !== 'text' && t !== null)) return 'NULL';
  if (typeof v === 'boolean') return d === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'object') v = JSON.stringify(v);
  let s = String(v);
  if (t === 'boolean' && /^(true|false)$/i.test(s)) return sqlLiteral(/^true$/i.test(s), t, d);
  if ((t === 'integer' || t === 'bigint' || t === 'decimal') && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s.trim())) return s.trim();
  s = s.replace(/'/g, "''");
  if (d === 'mysql') s = s.replace(/\\/g, '\\\\');
  // Strip NUL bytes, which no dialect accepts inside string literals.
  s = s.replace(/\0/g, '');
  return d === 'mssql' ? `N'${s}'` : `'${s}'`;
}

export interface SqlResult { sql: string; columns: { name: string; type: string }[]; rows: number; statements: number }

export function toSql(records: Record<string, unknown>[], o: SqlOptions): SqlResult {
  const d = o.dialect;
  const table = quoteQualified(o.table.trim() || 'my_table', d);
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const types = new Map<string, ColType | null>();
  const maxLen = new Map<string, number>();
  for (const c of cols) {
    let t: ColType | null = null;
    let len = 0;
    for (const r of records) {
      const v = r[c];
      t = o.inferTypes ? merge(t, typeOf(v)) : (v === null || v === undefined ? t : 'text');
      if (v !== null && v !== undefined) len = Math.max(len, String(typeof v === 'object' ? JSON.stringify(v) : v).length);
    }
    types.set(c, t);
    maxLen.set(c, len);
  }
  const out: string[] = [];
  const colDefs = cols.map(c => ({ name: c, type: sqlType(types.get(c) ?? null, d, maxLen.get(c) ?? 0) }));
  const key = o.key.trim();
  const keyOk = key && cols.includes(key);
  if (o.dropTable) out.push(d === 'mssql' ? `IF OBJECT_ID(N'${o.table.replace(/'/g, "''")}', N'U') IS NOT NULL DROP TABLE ${table};` : `DROP TABLE IF EXISTS ${table};`);
  if (o.createTable) {
    const lines = colDefs.map(c => `  ${quoteIdent(c.name, d)} ${c.type}${keyOk && c.name === key ? (d === 'mysql' && /TEXT/.test(c.type) ? '' : ' NOT NULL') : ''}`);
    if (keyOk) lines.push(`  PRIMARY KEY (${quoteIdent(key, d)})`);
    const ifNot = d === 'mssql' ? '' : 'IF NOT EXISTS ';
    out.push(`CREATE TABLE ${ifNot}${table} (\n${lines.join(',\n')}\n);`);
  }
  const colList = cols.map(c => quoteIdent(c, d)).join(', ');
  const batch = Math.max(1, Math.min(o.batchSize || 100, d === 'mssql' ? 1000 : 10_000));
  let statements = 0;
  const upsert = o.upsert && keyOk;
  const nonKey = cols.filter(c => c !== key);
  for (let i = 0; i < records.length; i += batch) {
    const chunk = records.slice(i, i + batch);
    const values = chunk.map(r => `  (${cols.map(c => sqlLiteral(r[c], types.get(c) ?? null, d)).join(', ')})`).join(',\n');
    if (upsert && d === 'mssql') {
      const k = quoteIdent(key, d);
      out.push(`MERGE INTO ${table} AS target\nUSING (VALUES\n${values}\n) AS source (${colList})\nON target.${k} = source.${k}\n` +
        (nonKey.length ? `WHEN MATCHED THEN UPDATE SET ${nonKey.map(c => `${quoteIdent(c, d)} = source.${quoteIdent(c, d)}`).join(', ')}\n` : '') +
        `WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${cols.map(c => `source.${quoteIdent(c, d)}`).join(', ')});`);
    } else {
      let stmt = `INSERT INTO ${table} (${colList}) VALUES\n${values}`;
      if (upsert) {
        if (d === 'mysql') stmt += `\nON DUPLICATE KEY UPDATE ${(nonKey.length ? nonKey : [key]).map(c => `${quoteIdent(c, d)} = VALUES(${quoteIdent(c, d)})`).join(', ')}`;
        else stmt += nonKey.length
          ? `\nON CONFLICT (${quoteIdent(key, d)}) DO UPDATE SET ${nonKey.map(c => `${quoteIdent(c, d)} = EXCLUDED.${quoteIdent(c, d)}`).join(', ')}`
          : `\nON CONFLICT (${quoteIdent(key, d)}) DO NOTHING`;
      }
      out.push(stmt + ';');
    }
    statements++;
  }
  return { sql: out.join('\n\n') + (out.length ? '\n' : ''), columns: colDefs, rows: records.length, statements };
}

/** Accept a JSON array of objects / arrays, or CSV text, and return records. */
export function parseTabular(input: string): { records: Record<string, unknown>[]; source: 'json' | 'csv' } {
  const t = input.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const v = JSON.parse(t);
    let arr: unknown[] = Array.isArray(v) ? v : (Object.values(v).find(Array.isArray) as unknown[] | undefined) ?? [v];
    if (arr.length && Array.isArray(arr[0])) {
      const [head, ...rest] = arr as unknown[][];
      arr = rest.map(r => Object.fromEntries(head.map((h, i) => [String(h), r[i] ?? null])));
    }
    return { records: arr.map(r => (r && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : { value: r })), source: 'json' };
  }
  const res = csvToJson(input, { delimiter: 'auto', header: true, infer: true, output: 'objects', skipEmpty: true });
  return { records: res.data as Record<string, unknown>[], source: 'csv' };
}

// ───────────────────────── text ⇄ bytes ─────────────────────────

export type ByteBase = 2 | 8 | 10 | 16;
export const BASE_WIDTH: Record<ByteBase, number> = { 2: 8, 8: 3, 10: 3, 16: 2 };

export function encodeBytes(text: string, base: ByteBase, { separator = ' ', pad = true, prefix = false, upper = false } = {}): string {
  const bytes = new TextEncoder().encode(text);
  const pre = prefix ? ({ 2: '0b', 8: '0o', 10: '', 16: '0x' } as const)[base] : '';
  return Array.from(bytes, b => {
    let s = b.toString(base);
    if (pad && base !== 10) s = s.padStart(BASE_WIDTH[base], '0');
    if (upper) s = s.toUpperCase();
    return pre + s;
  }).join(separator);
}

/** Guess the base of a byte dump. */
export function detectBase(input: string): ByteBase {
  const s = input.trim();
  if (/0[xX][0-9a-fA-F]|\\x[0-9a-fA-F]/.test(s)) return 16;
  if (/0[bB][01]/.test(s)) return 2;
  if (/0[oO][0-7]/.test(s)) return 8;
  const tokens = s.split(/[\s,;:|\-_]+/).filter(Boolean);
  const clean = tokens.join('');
  if (/^[01]+$/.test(clean) && (tokens.every(t => t.length === 8) || (tokens.length === 1 && clean.length % 8 === 0))) return 2;
  if (/^[0-9a-fA-F]+$/.test(clean) && (/[a-fA-F]/.test(clean) || tokens.every(t => t.length === 2) || (tokens.length === 1 && clean.length % 2 === 0 && clean.length > 3))) return 16;
  if (tokens.length && tokens.every(t => /^[0-7]{3}$/.test(t))) {
    // 3-digit octal vs decimal: prefer whichever decodes to printable text.
    const printable = (base: number) => tokens.every(t => { const n = Number.parseInt(t, base); return (n >= 32 && n < 127) || n === 9 || n === 10 || n === 13; });
    if (printable(8) && !printable(10)) return 8;
  }
  return 10;
}

export function decodeBytes(input: string, base: ByteBase | 'auto'): { text: string; base: ByteBase; bytes: number; error?: string } {
  const b = base === 'auto' ? detectBase(input) : base;
  // Only strip the prefix that belongs to the chosen base ("0b" is a valid hex byte!).
  const prefix = b === 16 ? /\\x|0[xX]/g : b === 2 ? /0[bB]/g : b === 8 ? /0[oO]/g : null;
  const stripped = prefix ? input.trim().replace(prefix, ' ') : input.trim();
  let tokens = stripped.split(/[\s,;:|\-_]+/).filter(Boolean);
  const valid = b === 2 ? /^[01]+$/ : b === 8 ? /^[0-7]+$/ : b === 10 ? /^\d+$/ : /^[0-9a-fA-F]+$/;
  // A single run with no separators → split into fixed-width groups.
  if (tokens.length === 1 && b !== 10 && tokens[0].length > BASE_WIDTH[b]) {
    const w = BASE_WIDTH[b];
    const t = tokens[0];
    if (t.length % w !== 0) return { text: '', base: b, bytes: 0, error: `Expected groups of ${w} digits for base ${b}` };
    tokens = t.match(new RegExp(`.{${w}}`, 'g')) ?? [];
  }
  const bytes: number[] = [];
  for (const t of tokens) {
    if (!valid.test(t)) return { text: '', base: b, bytes: 0, error: `"${t.slice(0, 20)}" is not a base-${b} number` };
    const n = Number.parseInt(t, b);
    if (n > 255) return { text: '', base: b, bytes: 0, error: `"${t}" is larger than one byte (255)` };
    bytes.push(n);
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)), base: b, bytes: bytes.length };
  } catch {
    return { text: new TextDecoder('utf-8').decode(new Uint8Array(bytes)), base: b, bytes: bytes.length, error: 'Bytes are not valid UTF-8 — invalid sequences shown as �' };
  }
}

// ───────────────────────── Morse ─────────────────────────

export const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
  O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...',
  ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', _: '..--.-', '"': '.-..-.', $: '...-..-', '@': '.--.-.',
  'À': '.--.-', 'Ä': '.-.-', 'É': '..-..', 'Ñ': '--.--', 'Ö': '---.', 'Ü': '..--',
};
export const PROSIGNS: Record<string, string> = {
  '<AR>': '.-.-.', '<SK>': '...-.-', '<BT>': '-...-', '<KN>': '-.--.', '<AS>': '.-...', '<SOS>': '...---...', '<HH>': '........', '<CT>': '-.-.-',
};
const REVERSE_MORSE = new Map<string, string>();
for (const [k, v] of Object.entries(MORSE)) if (!REVERSE_MORSE.has(v)) REVERSE_MORSE.set(v, k);
for (const [k, v] of Object.entries(PROSIGNS)) if (!REVERSE_MORSE.has(v)) REVERSE_MORSE.set(v, k);
REVERSE_MORSE.set('...---...', '<SOS>');
REVERSE_MORSE.set('........', '<HH>');

export function textToMorse(text: string): { morse: string; unknown: string[] } {
  const unknown: string[] = [];
  const words = text.toUpperCase().trim().split(/\s+/).filter(Boolean);
  const morse = words.map(w => {
    const out: string[] = [];
    const re = /<[A-Z]{2,3}>|./gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(w))) {
      const code = PROSIGNS[m[0]] ?? MORSE[m[0]];
      if (code) out.push(code);
      else if (!unknown.includes(m[0])) unknown.push(m[0]);
    }
    return out.join(' ');
  }).filter(Boolean).join(' / ');
  return { morse, unknown };
}

export function morseToText(morse: string): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const norm = morse.replace(/[•·∙]/g, '.').replace(/[_−–—]/g, '-').trim();
  const words = norm.split(/\s*[/|]\s*|\s{3,}|\n+/).filter(w => w.trim());
  const text = words.map(w => w.trim().split(/\s+/).map(code => {
    const ch = REVERSE_MORSE.get(code);
    if (!ch && !unknown.includes(code)) unknown.push(code);
    return ch ?? '�';
  }).join('')).join(' ');
  return { text, unknown };
}

/** On/off schedule in dot units: dot 1, dash 3, intra-char gap 1, letter gap 3, word gap 7. */
export function morseTimeline(morse: string): { on: boolean; units: number; symbolIndex: number }[] {
  const out: { on: boolean; units: number; symbolIndex: number }[] = [];
  const words = morse.trim().split(/\s*\/\s*/).filter(Boolean);
  let idx = 0;
  words.forEach((w, wi) => {
    const letters = w.trim().split(/\s+/);
    letters.forEach((l, li) => {
      Array.from(l).forEach((s, si) => {
        if (s !== '.' && s !== '-') return;
        out.push({ on: true, units: s === '.' ? 1 : 3, symbolIndex: idx++ });
        if (si < l.length - 1) out.push({ on: false, units: 1, symbolIndex: -1 });
      });
      if (li < letters.length - 1) out.push({ on: false, units: 3, symbolIndex: -1 });
    });
    if (wi < words.length - 1) out.push({ on: false, units: 7, symbolIndex: -1 });
  });
  return out;
}

// ───────────────────────── Roman numerals ─────────────────────────

const ROMAN: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
const OVERLINE = '̅';

function basicRoman(n: number): string {
  let s = '';
  for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
  return s;
}

/** 1–3999 standard; with vinculum up to 3,999,999 (overlined part × 1000). */
export function toRoman(n: number, vinculum = false): string {
  if (!Number.isInteger(n) || n < 1) throw new Error('Enter a whole number ≥ 1');
  if (n <= 3999) return basicRoman(n);
  if (!vinculum) throw new Error('Standard Roman numerals stop at 3999 — enable vinculum notation for larger numbers');
  if (n > 3_999_999) throw new Error('Vinculum notation here supports up to 3,999,999');
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  // Keep values < 4000 in the thousands as plain M's (e.g. 4,000 = I̅V̅, 3,000 = MMM).
  const over = Array.from(basicRoman(thousands)).map(c => c + OVERLINE).join('');
  return over + basicRoman(rest);
}

const STRICT = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

export function fromRoman(input: string): number {
  const s = input.trim().toUpperCase().replace(/\s+/g, '').replace(/[̄̅‾]/g, OVERLINE);
  if (!s) throw new Error('Enter a Roman numeral');
  let over = '';
  let plain = s;
  if (s.includes(OVERLINE)) {
    const m = /^((?:[IVXLCDM]̅)+)([IVXLCDM]*)$/.exec(s);
    if (!m) throw new Error('Overlined (vinculum) letters must come first');
    over = m[1].replace(/̅/g, '');
    plain = m[2];
  }
  const parse = (r: string) => {
    if (!r) return 0;
    if (!/^[IVXLCDM]+$/.test(r)) throw new Error(`"${r}" contains characters that are not Roman numerals`);
    if (!STRICT.test(r)) throw new Error(`"${r}" is not a valid (canonical) Roman numeral`);
    let total = 0;
    let i = 0;
    for (const [v, sym] of ROMAN) while (r.startsWith(sym, i)) { total += v; i += sym.length; }
    return total;
  };
  const value = parse(over) * 1000 + parse(plain);
  if (!value) throw new Error('Not a Roman numeral');
  return value;
}

// ───────────────────────── units ─────────────────────────

export interface UnitDef { id: string; label: string; symbol: string; toBase: (v: number) => number; fromBase: (v: number) => number }
export interface UnitCategory { id: string; label: string; units: UnitDef[]; base: string }

const lin = (id: string, label: string, symbol: string, factor: number, offset = 0): UnitDef => ({
  id, label, symbol, toBase: v => v * factor + offset, fromBase: v => (v - offset) / factor,
});
const inv = (id: string, label: string, symbol: string, k: number): UnitDef => ({
  id, label, symbol, toBase: v => k / v, fromBase: v => k / v,
});

export const UNIT_CATEGORIES: UnitCategory[] = [
  { id: 'length', label: 'Length', base: 'm', units: [
    lin('nm', 'Nanometre', 'nm', 1e-9), lin('um', 'Micrometre', 'µm', 1e-6), lin('mm', 'Millimetre', 'mm', 1e-3), lin('cm', 'Centimetre', 'cm', 1e-2),
    lin('m', 'Metre', 'm', 1), lin('km', 'Kilometre', 'km', 1e3), lin('in', 'Inch', 'in', 0.0254), lin('ft', 'Foot', 'ft', 0.3048),
    lin('yd', 'Yard', 'yd', 0.9144), lin('mi', 'Mile', 'mi', 1609.344), lin('nmi', 'Nautical mile', 'nmi', 1852), lin('mil', 'Thou (mil)', 'mil', 2.54e-5),
    lin('au', 'Astronomical unit', 'au', 149_597_870_700), lin('ly', 'Light-year', 'ly', 9.4607304725808e15),
  ] },
  { id: 'mass', label: 'Mass / weight', base: 'kg', units: [
    lin('mg', 'Milligram', 'mg', 1e-6), lin('g', 'Gram', 'g', 1e-3), lin('kg', 'Kilogram', 'kg', 1), lin('t', 'Tonne', 't', 1000),
    lin('oz', 'Ounce', 'oz', 0.028349523125), lin('lb', 'Pound', 'lb', 0.45359237), lin('st', 'Stone', 'st', 6.35029318),
    lin('ust', 'US ton (short)', 'ton', 907.18474), lin('ukt', 'UK ton (long)', 'LT', 1016.0469088), lin('ct', 'Carat', 'ct', 2e-4),
    lin('gr', 'Grain', 'gr', 6.479891e-5), lin('tola', 'Tola', 'tola', 0.0116638038),
  ] },
  { id: 'temperature', label: 'Temperature', base: 'K', units: [
    lin('c', 'Celsius', '°C', 1, 273.15), lin('f', 'Fahrenheit', '°F', 5 / 9, 273.15 - 32 * 5 / 9), lin('k', 'Kelvin', 'K', 1),
    lin('r', 'Rankine', '°R', 5 / 9),
  ] },
  { id: 'volume', label: 'Volume', base: 'L', units: [
    lin('ml', 'Millilitre', 'mL', 1e-3), lin('cl', 'Centilitre', 'cL', 1e-2), lin('l', 'Litre', 'L', 1), lin('m3', 'Cubic metre', 'm³', 1000),
    lin('cm3', 'Cubic centimetre', 'cm³', 1e-3), lin('tsp', 'Teaspoon (US)', 'tsp', 0.00492892159375), lin('tbsp', 'Tablespoon (US)', 'tbsp', 0.01478676478125),
    lin('floz', 'Fluid ounce (US)', 'fl oz', 0.0295735295625), lin('cup', 'Cup (US)', 'cup', 0.2365882365), lin('pt', 'Pint (US)', 'pt', 0.473176473),
    lin('qt', 'Quart (US)', 'qt', 0.946352946), lin('gal', 'Gallon (US)', 'gal', 3.785411784), lin('ukfloz', 'Fluid ounce (UK)', 'fl oz UK', 0.0284130625),
    lin('ukpt', 'Pint (UK)', 'pt UK', 0.56826125), lin('ukgal', 'Gallon (UK)', 'gal UK', 4.54609), lin('in3', 'Cubic inch', 'in³', 0.016387064),
    lin('ft3', 'Cubic foot', 'ft³', 28.316846592), lin('bbl', 'Barrel (oil)', 'bbl', 158.987294928),
  ] },
  { id: 'area', label: 'Area', base: 'm²', units: [
    lin('mm2', 'Square millimetre', 'mm²', 1e-6), lin('cm2', 'Square centimetre', 'cm²', 1e-4), lin('m2', 'Square metre', 'm²', 1),
    lin('ha', 'Hectare', 'ha', 1e4), lin('km2', 'Square kilometre', 'km²', 1e6), lin('in2', 'Square inch', 'in²', 6.4516e-4),
    lin('ft2', 'Square foot', 'ft²', 0.09290304), lin('yd2', 'Square yard', 'yd²', 0.83612736), lin('ac', 'Acre', 'ac', 4046.8564224),
    lin('mi2', 'Square mile', 'mi²', 2_589_988.110336), lin('marla', 'Marla (PK, 272.25 ft²)', 'marla', 25.29285264), lin('kanal', 'Kanal (20 marla)', 'kanal', 505.8570528),
  ] },
  { id: 'speed', label: 'Speed', base: 'm/s', units: [
    lin('mps', 'Metres per second', 'm/s', 1), lin('kph', 'Kilometres per hour', 'km/h', 1 / 3.6), lin('mph', 'Miles per hour', 'mph', 0.44704),
    lin('fps', 'Feet per second', 'ft/s', 0.3048), lin('kn', 'Knot', 'kn', 1852 / 3600), lin('mach', 'Mach (sea level, 15 °C)', 'Ma', 340.29),
    lin('c', 'Speed of light', 'c', 299_792_458),
  ] },
  { id: 'time', label: 'Time', base: 's', units: [
    lin('ns', 'Nanosecond', 'ns', 1e-9), lin('us', 'Microsecond', 'µs', 1e-6), lin('ms', 'Millisecond', 'ms', 1e-3), lin('s', 'Second', 's', 1),
    lin('min', 'Minute', 'min', 60), lin('h', 'Hour', 'h', 3600), lin('d', 'Day', 'd', 86400), lin('wk', 'Week', 'wk', 604800),
    lin('mo', 'Month (avg)', 'mo', 2_629_746), lin('yr', 'Year (365.2425 d)', 'yr', 31_556_952), lin('dec', 'Decade', 'dec', 315_569_520),
    lin('cen', 'Century', 'c', 3_155_695_200),
  ] },
  { id: 'data', label: 'Digital storage', base: 'B', units: [
    lin('bit', 'Bit', 'bit', 1 / 8), lin('B', 'Byte', 'B', 1), lin('kB', 'Kilobyte', 'kB', 1e3), lin('MB', 'Megabyte', 'MB', 1e6),
    lin('GB', 'Gigabyte', 'GB', 1e9), lin('TB', 'Terabyte', 'TB', 1e12), lin('PB', 'Petabyte', 'PB', 1e15), lin('KiB', 'Kibibyte', 'KiB', 1024),
    lin('MiB', 'Mebibyte', 'MiB', 1024 ** 2), lin('GiB', 'Gibibyte', 'GiB', 1024 ** 3), lin('TiB', 'Tebibyte', 'TiB', 1024 ** 4),
    lin('PiB', 'Pebibyte', 'PiB', 1024 ** 5), lin('kbit', 'Kilobit', 'kbit', 125), lin('Mbit', 'Megabit', 'Mbit', 125_000), lin('Gbit', 'Gigabit', 'Gbit', 125_000_000),
  ] },
  { id: 'pressure', label: 'Pressure', base: 'Pa', units: [
    lin('pa', 'Pascal', 'Pa', 1), lin('hpa', 'Hectopascal', 'hPa', 100), lin('kpa', 'Kilopascal', 'kPa', 1000), lin('mpa', 'Megapascal', 'MPa', 1e6),
    lin('bar', 'Bar', 'bar', 1e5), lin('mbar', 'Millibar', 'mbar', 100), lin('atm', 'Atmosphere', 'atm', 101_325), lin('psi', 'Pound per sq inch', 'psi', 6894.757293168),
    lin('mmhg', 'Millimetre of mercury', 'mmHg', 133.322387415), lin('inhg', 'Inch of mercury', 'inHg', 3386.389), lin('torr', 'Torr', 'Torr', 101_325 / 760),
  ] },
  { id: 'energy', label: 'Energy', base: 'J', units: [
    lin('j', 'Joule', 'J', 1), lin('kj', 'Kilojoule', 'kJ', 1000), lin('mj', 'Megajoule', 'MJ', 1e6), lin('cal', 'Calorie', 'cal', 4.184),
    lin('kcal', 'Kilocalorie (food Cal)', 'kcal', 4184), lin('wh', 'Watt-hour', 'Wh', 3600), lin('kwh', 'Kilowatt-hour', 'kWh', 3.6e6),
    lin('btu', 'BTU (IT)', 'BTU', 1055.05585262), lin('ev', 'Electronvolt', 'eV', 1.602176634e-19), lin('ftlb', 'Foot-pound', 'ft·lbf', 1.3558179483),
    lin('therm', 'Therm (US)', 'thm', 105_480_400),
  ] },
  { id: 'power', label: 'Power', base: 'W', units: [
    lin('mw', 'Milliwatt', 'mW', 1e-3), lin('w', 'Watt', 'W', 1), lin('kw', 'Kilowatt', 'kW', 1e3), lin('MW', 'Megawatt', 'MW', 1e6),
    lin('hp', 'Horsepower (mechanical)', 'hp', 745.69987158227), lin('ps', 'Metric horsepower', 'PS', 735.49875), lin('btuh', 'BTU per hour', 'BTU/h', 0.29307107017),
    lin('tr', 'Ton of refrigeration', 'TR', 3516.8528420667), lin('kcalh', 'Kilocalorie per hour', 'kcal/h', 1.163),
  ] },
  { id: 'angle', label: 'Angle', base: 'rad', units: [
    lin('deg', 'Degree', '°', Math.PI / 180), lin('rad', 'Radian', 'rad', 1), lin('grad', 'Gradian', 'gon', Math.PI / 200),
    lin('arcmin', 'Arcminute', '′', Math.PI / 10800), lin('arcsec', 'Arcsecond', '″', Math.PI / 648000), lin('turn', 'Turn', 'tr', 2 * Math.PI),
    lin('mrad', 'Milliradian', 'mrad', 1e-3),
  ] },
  { id: 'frequency', label: 'Frequency', base: 'Hz', units: [
    lin('hz', 'Hertz', 'Hz', 1), lin('khz', 'Kilohertz', 'kHz', 1e3), lin('mhz', 'Megahertz', 'MHz', 1e6), lin('ghz', 'Gigahertz', 'GHz', 1e9),
    lin('rpm', 'Revolutions per minute', 'rpm', 1 / 60), lin('bpm', 'Beats per minute', 'bpm', 1 / 60), lin('rads', 'Radians per second', 'rad/s', 1 / (2 * Math.PI)),
  ] },
  { id: 'fuel', label: 'Fuel economy', base: 'L/100 km', units: [
    lin('l100', 'Litres per 100 km', 'L/100 km', 1), inv('kml', 'Kilometres per litre', 'km/L', 100), inv('mpgus', 'Miles per gallon (US)', 'mpg', 235.214583),
    inv('mpguk', 'Miles per gallon (UK)', 'mpg UK', 282.480936),
  ] },
];

export function convertUnit(cat: UnitCategory, value: number, from: string, to: string): number {
  const f = cat.units.find(u => u.id === from);
  const t = cat.units.find(u => u.id === to);
  if (!f || !t) return NaN;
  return t.fromBase(f.toBase(value));
}

/** Human formatting: up to `sig` significant digits, scientific for very large / small. */
export function formatNumber(n: number, sig = 10): string {
  if (!Number.isFinite(n)) return n === Infinity ? '∞' : n === -Infinity ? '−∞' : '—';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1e15 || a < 1e-7) return n.toExponential(Math.min(sig - 1, 8)).replace(/\.?0+e/, 'e');
  const s = Number(n.toPrecision(sig));
  return s.toLocaleString('en-US', { maximumFractionDigits: 12, useGrouping: true });
}
