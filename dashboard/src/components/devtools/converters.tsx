import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, Download, Eraser, Play, Search, Square, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  MONO, FIXED, Checkbox, ConverterTool, CopyButton, ErrorBox, FieldLabel, InfoBox, NumberField, Segmented, downloadBlob, jobsApi,
  type ToolJob,
} from './shared';
import {
  DELIMITERS, UNIT_CATEGORIES, convertUnit, csvToJson, decodeBytes, encodeBytes, formatNumber, fromRoman, jsonToCsv, morseTimeline,
  morseToText, parseTabular, textToMorse, toRoman, toSql, type ByteBase, type Delimiter, type Dialect, type JsonToCsvOptions, type SqlOptions,
} from './lib/data';

// ───────────────────────── local helpers ─────────────────────────

function NativeSelect<T extends string>({ value, onChange, options, className }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string;
}) {
  return (
    <select
      className={cn('h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-primary [&>option]:bg-card', className)}
      value={value}
      onChange={e => onChange(e.target.value as T)}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function LoadFileButton({ onText, accept }: { onText: (t: string, name: string) => void; accept?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="ghost" size="xs" onClick={() => ref.current?.click()}><Upload /> Open file</Button>
      <input ref={ref} type="file" className="hidden" accept={accept} onChange={async e => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) onText(await f.text(), f.name);
      }} />
    </>
  );
}

const cellText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Scrollable preview table (scrolls inside its own box, never the page). */
function PreviewTable({ headers, rows, max = 50 }: { headers: string[]; rows: unknown[][]; max?: number }) {
  if (!headers.length && !rows.length) return null;
  return (
    <div className="rounded-md border border-border overflow-auto max-h-80">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-secondary">
          <tr>
            <th className="px-2 py-1.5 text-right font-medium text-muted-foreground w-8">#</th>
            {headers.map((h, i) => <th key={i} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i} className="border-t border-border even:bg-secondary/20">
              <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">{i + 1}</td>
              {headers.map((_, j) => {
                const v = r[j];
                return (
                  <td key={j} className={cn('px-2 py-1 whitespace-nowrap max-w-64 truncate', typeof v === 'number' && 'text-right tabular-nums', v === null && 'text-muted-foreground/60 italic')} title={cellText(v)}>
                    {v === null ? 'null' : typeof v === 'boolean' ? <Badge variant="outline" className="text-[10px]">{String(v)}</Badge> : cellText(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <p className="px-2 py-1 text-[11px] text-muted-foreground border-t border-border">Showing {max} of {rows.length.toLocaleString()} rows</p>}
    </div>
  );
}

const DELIM_LABEL: Record<string, string> = { ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe' };

// ───────────────────────── CSV → JSON ─────────────────────────

const SAMPLE_CSV = `id,name,email,active,balance,joined,notes
1,Ada Lovelace,ada@example.com,true,1250.50,2024-01-15,"Wrote the first ""program"""
2,"Hopper, Grace",grace@example.com,false,0,2023-11-02,
3,Alan Turing,alan@example.com,TRUE,-42.1,2022-06-23,"Multi-line
note"
4,Linus,linus@example.com,true,007,2021-08-25,null`;

export function CsvToJson() {
  const [input, setInput] = useState(SAMPLE_CSV);
  const [name, setName] = useState('data');
  const [delimiter, setDelimiter] = useState<Delimiter | 'auto'>('auto');
  const [header, setHeader] = useState(true);
  const [infer, setInfer] = useState(true);
  const [output, setOutput] = useState<'objects' | 'arrays'>('objects');
  const [indent, setIndent] = useState<'2' | '4' | 'min'>('2');
  const [skipEmpty, setSkipEmpty] = useState(true);

  const r = useMemo(() => {
    if (!input.trim()) return null;
    return csvToJson(input, { delimiter, header, infer, output: header ? output : 'arrays', skipEmpty });
  }, [input, delimiter, header, infer, output, skipEmpty]);
  const json = useMemo(() => (r ? JSON.stringify(r.data, null, indent === 'min' ? undefined : Number(indent)) : ''), [r, indent]);
  const preview = useMemo(() => {
    if (!r) return { headers: [] as string[], rows: [] as unknown[][] };
    if (header && output === 'objects') return { headers: r.headers, rows: (r.data as Record<string, unknown>[]).map(o => r.headers.map(h => o[h])) };
    const rows = r.data as unknown[][];
    return { headers: Array.from({ length: r.cols }, (_, i) => `col ${i + 1}`), rows: header ? rows.slice(1) : rows };
  }, [r, header, output]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5 w-40">
          <FieldLabel>Delimiter</FieldLabel>
          <NativeSelect<Delimiter | 'auto'> value={delimiter} onChange={setDelimiter} options={[{ value: 'auto', label: 'Auto-detect' }, ...DELIMITERS]} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Output</FieldLabel>
          <Segmented value={header ? output : 'arrays'} onChange={setOutput} options={[{ value: 'objects', label: 'Array of objects' }, { value: 'arrays', label: 'Array of arrays' }]} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Indent</FieldLabel>
          <Segmented value={indent} onChange={setIndent} options={[{ value: '2', label: '2' }, { value: '4', label: '4' }, { value: 'min', label: 'Minified' }]} />
        </div>
        <div className="flex flex-col gap-1 pb-0.5">
          <Checkbox checked={header} onChange={setHeader}>First row is header</Checkbox>
          <Checkbox checked={infer} onChange={setInfer}>Infer numbers, booleans, null</Checkbox>
          <Checkbox checked={skipEmpty} onChange={setSkipEmpty}>Skip empty rows</Checkbox>
        </div>
      </div>

      {r && (
        <div className="flex flex-wrap gap-2">
          <Badge>{r.rows.toLocaleString()} rows</Badge>
          <Badge variant="secondary">{r.cols} columns</Badge>
          <Badge variant="outline">delimiter: {DELIM_LABEL[r.delimiter]}{delimiter === 'auto' ? ' (detected)' : ''}</Badge>
          {r.ragged > 0 && <Badge variant="destructive">{r.ragged} rows with a different column count</Badge>}
        </div>
      )}
      {r?.errors.map((e, i) => <ErrorBox key={i} message={e} />)}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<div className="flex gap-1">
            <LoadFileButton accept=".csv,.tsv,.txt,text/csv" onText={(t, n) => { setInput(t); setName(n.replace(/\.[^.]+$/, '')); }} />
            <Button variant="ghost" size="xs" onClick={() => setInput('')}><Eraser /> Clear</Button>
          </div>}>CSV / TSV</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-80')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} placeholder="Paste CSV…" />
        </div>
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<div className="flex gap-1">
            <Button variant="ghost" size="xs" disabled={!json} onClick={() => downloadBlob(json, `${name}.json`, 'application/json')}><Download /> .json</Button>
            <CopyButton value={json} label="Copy" />
          </div>}>JSON · {(json.length / 1024).toFixed(1)} KB</FieldLabel>
          <Textarea readOnly className={cn(MONO, FIXED, 'h-80 bg-secondary/40')} value={json} />
        </div>
      </div>
      {preview.rows.length > 0 && (
        <div className="space-y-1.5">
          <FieldLabel>Preview</FieldLabel>
          <PreviewTable headers={preview.headers} rows={preview.rows} max={20} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────── JSON → CSV ─────────────────────────

const SAMPLE_JSON = JSON.stringify([
  { id: 1, name: 'Ada Lovelace', contact: { email: 'ada@example.com', phone: null }, tags: ['math', 'poetry'], active: true },
  { id: 2, name: 'Grace "Amazing" Hopper', contact: { email: 'grace@example.com', phone: '+1 555 0100' }, tags: ['cobol'], active: false },
  { id: 3, name: 'Alan Turing', contact: { email: 'alan@example.com' }, tags: [], active: true, notes: 'Has, commas\nand a newline' },
], null, 2);

export function JsonToCsv() {
  const [input, setInput] = useState(SAMPLE_JSON);
  const [name, setName] = useState('data');
  const [o, setO] = useState<JsonToCsvOptions>({ delimiter: ',', quoteAll: false, arrays: 'join', joinWith: '; ', header: true, eol: '\n', bom: false });
  const set = <K extends keyof JsonToCsvOptions>(k: K, v: JsonToCsvOptions[K]) => setO(p => ({ ...p, [k]: v }));

  const r = useMemo(() => {
    if (!input.trim()) return { csv: '', columns: [] as string[], rows: 0, error: '', parsed: [] as unknown[] };
    try {
      const v = JSON.parse(input);
      const res = jsonToCsv(v, o);
      return { ...res, error: '' };
    } catch (e) {
      return { csv: '', columns: [] as string[], rows: 0, error: (e as Error).message };
    }
  }, [input, o]);
  const preview = useMemo(() => {
    if (!r.csv) return [];
    const res = csvToJson(r.csv.replace(/^﻿/, ''), { delimiter: o.delimiter, header: o.header, infer: false, output: 'arrays', skipEmpty: false });
    return (res.data as unknown[][]).slice(o.header ? 1 : 0);
  }, [r.csv, o.delimiter, o.header]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5"><FieldLabel>Delimiter</FieldLabel><NativeSelect value={o.delimiter} onChange={v => set('delimiter', v)} options={DELIMITERS} /></div>
        <div className="space-y-1.5">
          <FieldLabel>Arrays</FieldLabel>
          <NativeSelect value={o.arrays} onChange={v => set('arrays', v)} options={[
            { value: 'join', label: 'Join into one cell' }, { value: 'index', label: 'Separate columns (tags.0, tags.1…)' }, { value: 'json', label: 'Keep as JSON text' },
          ]} />
        </div>
        {o.arrays === 'join'
          ? <div className="space-y-1.5"><FieldLabel>Join with</FieldLabel><Input value={o.joinWith} onChange={e => set('joinWith', e.target.value)} className={MONO} /></div>
          : <div className="hidden lg:block" />}
        <div className="flex flex-col gap-1 sm:pt-1">
          <Checkbox checked={o.header} onChange={v => set('header', v)}>Header row</Checkbox>
          <Checkbox checked={o.quoteAll} onChange={v => set('quoteAll', v)}>Quote every field</Checkbox>
          <Checkbox checked={o.eol === '\r\n'} onChange={v => set('eol', v ? '\r\n' : '\n')}>Windows line endings (CRLF)</Checkbox>
          <Checkbox checked={o.bom} onChange={v => set('bom', v)}>UTF-8 BOM (for Excel)</Checkbox>
        </div>
      </div>
      {r.error ? <ErrorBox message={`Invalid JSON: ${r.error}`} /> : r.csv && (
        <div className="flex flex-wrap gap-2"><Badge>{r.rows.toLocaleString()} rows</Badge><Badge variant="secondary">{r.columns.length} columns</Badge><Badge variant="outline">Nested keys flattened with dots</Badge></div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<div className="flex gap-1">
            <LoadFileButton accept=".json,application/json" onText={(t, n) => { setInput(t); setName(n.replace(/\.[^.]+$/, '')); }} />
            <Button variant="ghost" size="xs" onClick={() => setInput('')}><Eraser /> Clear</Button>
          </div>}>JSON (array of objects)</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-80')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<div className="flex gap-1">
            <Button variant="ghost" size="xs" disabled={!r.csv} onClick={() => downloadBlob(r.csv, `${name}.csv`, 'text/csv;charset=utf-8')}><Download /> .csv</Button>
            <CopyButton value={r.csv} label="Copy" />
          </div>}>CSV</FieldLabel>
          <Textarea readOnly className={cn(MONO, FIXED, 'h-80 bg-secondary/40')} value={r.csv} />
        </div>
      </div>
      {preview.length > 0 && <div className="space-y-1.5"><FieldLabel>Preview</FieldLabel><PreviewTable headers={r.columns} rows={preview} max={20} /></div>}
    </div>
  );
}

// ───────────────────────── Spreadsheet → JSON / CSV ─────────────────────────

interface SheetMeta { name: string; rows: number; cols: number; headers: string[]; preview: unknown[][] | Record<string, unknown>[]; outputs: { json?: number; csv?: number } }
interface FileMeta { file: string; sheetNames: string[]; sheets: SheetMeta[] }

function SheetResults({ job }: { job: ToolJob }) {
  const meta = job.meta as { header: boolean; files: FileMeta[] } | undefined;
  const [fileIdx, setFileIdx] = useState(0);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [copied, setCopied] = useState('');
  if (!meta?.files?.length) return null;
  const file = meta.files[Math.min(fileIdx, meta.files.length - 1)];
  const sheet = file.sheets[Math.min(sheetIdx, file.sheets.length - 1)];
  const rows: unknown[][] = (sheet.preview as unknown[]).map(r => (Array.isArray(r) ? r : sheet.headers.map(h => (r as Record<string, unknown>)[h])));

  const copyOutput = async (idx: number, kind: string) => {
    const blob = await jobsApi.outputBlob(job, idx);
    await navigator.clipboard.writeText(await blob.text()).catch(() => {});
    setCopied(kind); setTimeout(() => setCopied(''), 1200);
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">Sheets</CardTitle>
        <CardDescription className="text-xs">Preview of the first 50 rows of each converted sheet.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {meta.files.length > 1 && (
          <NativeSelect value={String(fileIdx)} onChange={v => { setFileIdx(Number(v)); setSheetIdx(0); }} options={meta.files.map((f, i) => ({ value: String(i), label: f.file }))} />
        )}
        <div className="flex gap-1 overflow-x-auto pb-1">
          {file.sheets.map((s, i) => (
            <button key={s.name} type="button" onClick={() => setSheetIdx(i)}
              className={cn('shrink-0 rounded-md border px-2.5 py-1 text-xs cursor-pointer', i === sheetIdx ? 'border-primary bg-primary/5 font-medium' : 'border-border hover:bg-secondary/40')}>
              {s.name} <span className="text-muted-foreground">· {s.rows.toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{sheet.rows.toLocaleString()} rows</Badge>
          <Badge variant="secondary">{sheet.cols} columns</Badge>
          <div className="ml-auto flex flex-wrap gap-1">
            {sheet.outputs.json !== undefined && <>
              <Button size="xs" variant="outline" onClick={() => copyOutput(sheet.outputs.json!, 'json')}>{copied === 'json' ? 'Copied!' : 'Copy JSON'}</Button>
              <Button size="xs" variant="outline" onClick={() => jobsApi.download(job, sheet.outputs.json)}><Download /> JSON</Button>
            </>}
            {sheet.outputs.csv !== undefined && <>
              <Button size="xs" variant="outline" onClick={() => copyOutput(sheet.outputs.csv!, 'csv')}>{copied === 'csv' ? 'Copied!' : 'Copy CSV'}</Button>
              <Button size="xs" variant="outline" onClick={() => jobsApi.download(job, sheet.outputs.csv)}><Download /> CSV</Button>
            </>}
          </div>
        </div>
        {rows.length ? <PreviewTable headers={sheet.headers} rows={rows} /> : <InfoBox>This sheet is empty.</InfoBox>}
        {file.sheetNames.length > file.sheets.length && (
          <p className="text-[11px] text-muted-foreground">Other sheets in this file: {file.sheetNames.filter(n => !file.sheets.some(s => s.name === n)).join(', ')}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function SpreadsheetConverter() {
  return (
    <div className="space-y-3">
      <InfoBox>Upload Excel (.xlsx, .xlsm, .xlsb, .xls), OpenDocument (.ods), Apple Numbers or CSV/TSV files. Each sheet becomes its own JSON and/or CSV file; dates are exported as ISO-8601.</InfoBox>
      <ConverterTool converterId="sheet-to-data">{job => <SheetResults key={job.id} job={job} />}</ConverterTool>
    </div>
  );
}

// ───────────────────────── JSON / CSV → SQL ─────────────────────────

const SAMPLE_SQL_INPUT = JSON.stringify([
  { id: 1, name: "O'Reilly Media", country: 'US', active: true, revenue: 1250000.5, founded: '1978-01-01', tags: ['books', 'tech'] },
  { id: 2, name: 'Packt', country: 'UK', active: true, revenue: 830000, founded: '2004-03-15', tags: ['books'] },
  { id: 3, name: 'No Starch Press', country: 'US', active: false, revenue: null, founded: '1994-06-01', tags: [] },
], null, 2);

export function JsonCsvToSql() {
  const [input, setInput] = useState(SAMPLE_SQL_INPUT);
  const [o, setO] = useState<SqlOptions>({ dialect: 'postgres', table: 'publishers', createTable: true, dropTable: false, batchSize: 500, upsert: false, key: 'id', inferTypes: true });
  const set = <K extends keyof SqlOptions>(k: K, v: SqlOptions[K]) => setO(p => ({ ...p, [k]: v }));

  const parsed = useMemo(() => {
    if (!input.trim()) return null;
    try { return { ...parseTabular(input), error: '' }; } catch (e) { return { records: [], source: 'json' as const, error: (e as Error).message }; }
  }, [input]);
  const cols = useMemo(() => {
    const s = new Set<string>();
    for (const r of parsed?.records ?? []) for (const k of Object.keys(r)) s.add(k);
    return [...s];
  }, [parsed]);
  const res = useMemo(() => (parsed && !parsed.error && parsed.records.length ? toSql(parsed.records, o) : null), [parsed, o]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <FieldLabel>Dialect</FieldLabel>
          <NativeSelect<Dialect> value={o.dialect} onChange={v => set('dialect', v)} options={[
            { value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL / MariaDB' }, { value: 'sqlite', label: 'SQLite' }, { value: 'mssql', label: 'SQL Server' },
          ]} />
        </div>
        <div className="space-y-1.5"><FieldLabel>Table name</FieldLabel><Input value={o.table} onChange={e => set('table', e.target.value)} className={MONO} placeholder="schema.table" /></div>
        <NumberField label="Rows per INSERT" value={o.batchSize} onChange={v => set('batchSize', Math.max(1, v || 1))} min={1} max={o.dialect === 'mssql' ? 1000 : 10000} />
        <div className="space-y-1.5">
          <FieldLabel>Primary key / upsert key</FieldLabel>
          <NativeSelect value={cols.includes(o.key) ? o.key : ''} onChange={v => set('key', v)} options={[{ value: '', label: '(none)' }, ...cols.map(c => ({ value: c, label: c }))]} />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Checkbox checked={o.createTable} onChange={v => set('createTable', v)}>CREATE TABLE</Checkbox>
        <Checkbox checked={o.dropTable} onChange={v => set('dropTable', v)}>DROP TABLE first</Checkbox>
        <Checkbox checked={o.inferTypes} onChange={v => set('inferTypes', v)}>Infer column types</Checkbox>
        <Checkbox checked={o.upsert} onChange={v => set('upsert', v)}>Upsert on key ({o.dialect === 'mysql' ? 'ON DUPLICATE KEY' : o.dialect === 'mssql' ? 'MERGE' : 'ON CONFLICT'})</Checkbox>
      </div>
      {o.upsert && !cols.includes(o.key) && <InfoBox>Choose a key column to generate upserts.</InfoBox>}
      {parsed?.error && <ErrorBox message={`Could not parse input: ${parsed.error}`} />}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<div className="flex gap-1">
            <LoadFileButton accept=".json,.csv,.tsv,.txt" onText={(t, n) => { setInput(t); set('table', n.replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_').toLowerCase()); }} />
            <Button variant="ghost" size="xs" onClick={() => setInput('')}><Eraser /> Clear</Button>
          </div>}>JSON array or CSV {parsed && !parsed.error && <Badge variant="outline" className="ml-1">{parsed.source.toUpperCase()} · {parsed.records.length} rows</Badge>}</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-96')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<div className="flex gap-1">
            <Button variant="ghost" size="xs" disabled={!res} onClick={() => res && downloadBlob(res.sql, `${o.table || 'data'}.sql`, 'application/sql')}><Download /> .sql</Button>
            <CopyButton value={res?.sql ?? ''} label="Copy" />
          </div>}>SQL {res && <span className="font-normal">· {res.statements} statement{res.statements === 1 ? '' : 's'}</span>}</FieldLabel>
          <Textarea readOnly className={cn(MONO, FIXED, 'h-96 bg-secondary/40')} value={res?.sql ?? ''} />
        </div>
      </div>
      {res && (
        <div className="flex flex-wrap gap-1.5">
          {res.columns.map(c => <Badge key={c.name} variant="secondary" className="font-mono">{c.name}: {c.type}</Badge>)}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Text ⇄ binary / hex / octal / decimal ─────────────────────────

const BASES: { value: string; label: string }[] = [{ value: '2', label: 'Binary' }, { value: '16', label: 'Hex' }, { value: '8', label: 'Octal' }, { value: '10', label: 'Decimal' }];
const SEPARATORS = [{ value: ' ', label: 'Space' }, { value: '', label: 'None' }, { value: ', ', label: 'Comma' }, { value: '\n', label: 'New line' }, { value: '-', label: 'Dash' }];

export function BinaryConverter() {
  const [mode, setMode] = useState<'encode' | 'decode'>('encode');
  const [text, setText] = useState('Hi! 👋 ü');
  const [code, setCode] = useState('01001000 01101001');
  const [base, setBase] = useState('2');
  const [decBase, setDecBase] = useState('auto');
  const [sep, setSep] = useState(' ');
  const [prefix, setPrefix] = useState(false);
  const [upper, setUpper] = useState(false);

  const encoded = useMemo(() => encodeBytes(text, Number(base) as ByteBase, { separator: sep, prefix, upper }), [text, base, sep, prefix, upper]);
  const decoded = useMemo(() => (code.trim() ? decodeBytes(code, decBase === 'auto' ? 'auto' : Number(decBase) as ByteBase) : null), [code, decBase]);
  const breakdown = useMemo(() => Array.from(text).slice(0, 200).map(ch => {
    const bytes = new TextEncoder().encode(ch);
    return { ch, cp: 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'), hex: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' '), bin: Array.from(bytes, b => b.toString(2).padStart(8, '0')).join(' '), dec: Array.from(bytes).join(' ') };
  }), [text]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'encode', label: 'Text → bytes' }, { value: 'decode', label: 'Bytes → text' }]} />
        <Button variant="outline" size="sm" onClick={() => {
          if (mode === 'encode') { setCode(encoded); setDecBase(base); setMode('decode'); } else if (decoded && !decoded.error) { setText(decoded.text); setMode('encode'); }
        }}><ArrowUpDown /> Swap</Button>
      </div>

      {mode === 'encode' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5"><FieldLabel>Output</FieldLabel><NativeSelect value={base} onChange={setBase} options={BASES} /></div>
            <div className="space-y-1.5"><FieldLabel>Separator</FieldLabel><NativeSelect value={sep} onChange={setSep} options={SEPARATORS} /></div>
            <div className="flex flex-col gap-1 sm:pt-6">
              <Checkbox checked={prefix} onChange={setPrefix}>Prefix (0x / 0b / 0o)</Checkbox>
              {base === '16' && <Checkbox checked={upper} onChange={setUpper}>Uppercase hex</Checkbox>}
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-1.5 min-w-0">
              <FieldLabel>Text (UTF-8) · {new TextEncoder().encode(text).length} bytes</FieldLabel>
              <Textarea className={cn(FIXED, 'h-40 text-sm')} value={text} onChange={e => setText(e.target.value)} />
            </div>
            <div className="space-y-1.5 min-w-0">
              <FieldLabel action={<CopyButton value={encoded} label="Copy" />}>{BASES.find(b => b.value === base)?.label}</FieldLabel>
              <Textarea readOnly className={cn(MONO, FIXED, 'h-40 bg-secondary/40')} value={encoded} />
            </div>
          </div>
          {breakdown.length > 0 && (
            <div className="rounded-md border border-border overflow-auto max-h-72">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-secondary"><tr>{['Char', 'Code point', 'UTF-8 hex', 'Binary', 'Decimal'].map(h => <th key={h} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
                <tbody className="font-mono">
                  {breakdown.map((b, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-2 py-1 font-sans text-sm">{b.ch === ' ' ? '␠' : b.ch === '\n' ? '↵' : b.ch}</td>
                      <td className="px-2 py-1">{b.cp}</td><td className="px-2 py-1">{b.hex}</td><td className="px-2 py-1 whitespace-nowrap">{b.bin}</td><td className="px-2 py-1">{b.dec}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="space-y-1.5 w-full sm:w-56">
            <FieldLabel>Input base</FieldLabel>
            <NativeSelect value={decBase} onChange={setDecBase} options={[{ value: 'auto', label: 'Auto-detect' }, ...BASES]} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-1.5 min-w-0">
              <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setCode('')}><Eraser /> Clear</Button>}>
                Bytes {decoded && <Badge variant="outline" className="ml-1">{BASES.find(b => b.value === String(decoded.base))?.label}{decBase === 'auto' ? ' (detected)' : ''} · {decoded.bytes} bytes</Badge>}
              </FieldLabel>
              <Textarea className={cn(MONO, FIXED, 'h-40')} value={code} onChange={e => setCode(e.target.value)} spellCheck={false} placeholder="01001000 01101001 · 48 69 · 0x48,0x69 · \x48\x69 · 72 105" />
            </div>
            <div className="space-y-1.5 min-w-0">
              <FieldLabel action={<CopyButton value={decoded?.text ?? ''} label="Copy" />}>Text</FieldLabel>
              <Textarea readOnly className={cn(FIXED, 'h-40 text-sm bg-secondary/40')} value={decoded?.text ?? ''} />
              {decoded?.error && <ErrorBox message={decoded.error} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────── Morse code ─────────────────────────

/** Render a mono 16-bit WAV of the Morse timeline. */
function morseWav(morse: string, wpm: number, freq: number, farnsworth: number): Blob {
  const rate = 22050;
  const unit = 1.2 / wpm;
  const gapScale = farnsworth < wpm ? (60 / farnsworth - 31 * unit) / 19 / unit : 1;
  const tl = morseTimeline(morse);
  const dur = tl.reduce((s, x) => s + x.units * unit * (x.on || x.units === 1 ? 1 : gapScale), 0) + 0.2;
  const n = Math.ceil(dur * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let t = 0.1;
  const ramp = 0.005;
  for (const x of tl) {
    const len = x.units * unit * (x.on || x.units === 1 ? 1 : gapScale);
    if (x.on) {
      const s0 = Math.floor(t * rate), s1 = Math.floor((t + len) * rate);
      for (let i = s0; i < s1 && i < n; i++) {
        const tt = (i - s0) / rate;
        const env = Math.min(1, tt / ramp, (len - tt) / ramp);
        v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * freq * (i / rate)) * env * 0.6 * 32767), true);
      }
    }
    t += len;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function MorseCodeConverter() {
  const [text, setText] = useState('SOS. Hello world!');
  const [morse, setMorse] = useState(() => textToMorse('SOS. Hello world!').morse);
  const [edited, setEdited] = useState<'text' | 'morse'>('text');
  const [wpm, setWpm] = useState(18);
  const [farnsworth, setFarnsworth] = useState(18);
  const [freq, setFreq] = useState(650);
  const [playing, setPlaying] = useState(false);
  const [lamp, setLamp] = useState(false);
  const [progress, setProgress] = useState(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);

  const unknown = useMemo(() => (edited === 'text' ? textToMorse(text).unknown : morseToText(morse).unknown), [edited, text, morse]);

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setPlaying(false); setLamp(false); setProgress(0);
  };
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const play = () => {
    stop();
    const tl = morseTimeline(morse);
    if (!tl.length) return;
    const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AC();
    ctxRef.current = ctx;
    const unit = 1.2 / wpm;
    const eff = Math.min(farnsworth, wpm);
    const gapScale = eff < wpm ? (60 / eff - 31 * unit) / 19 / unit : 1;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    const start = ctx.currentTime + 0.1;
    let t = start;
    const spans: [number, number][] = [];
    for (const x of tl) {
      const len = x.units * unit * (x.on || x.units === 1 ? 1 : gapScale);
      if (x.on) {
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.5, t + 0.005);
        gain.gain.setValueAtTime(0.5, t + len - 0.005);
        gain.gain.linearRampToValueAtTime(0, t + len);
        spans.push([t, t + len]);
      }
      t += len;
    }
    const end = t;
    osc.start(start);
    osc.stop(end + 0.05);
    setPlaying(true);
    const tick = () => {
      if (ctxRef.current !== ctx) return;
      const now = ctx.currentTime;
      setLamp(spans.some(([a, b]) => now >= a && now < b));
      setProgress(Math.min(1, (now - start) / (end - start)));
      if (now >= end) { stop(); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const totalUnits = useMemo(() => morseTimeline(morse).reduce((s, x) => s + x.units, 0), [morse]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<CopyButton value={text} label="Copy" />}>Text</FieldLabel>
          <Textarea className={cn(FIXED, 'h-40 text-sm')} value={text} onChange={e => { setText(e.target.value); setEdited('text'); setMorse(textToMorse(e.target.value).morse); }} placeholder="Type text… (prosigns like <AR> or <SK> work too)" />
        </div>
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<div className="flex gap-1"><CopyButton value={morse} label="Copy" /></div>}>Morse ( . - , letters separated by spaces, words by / )</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-40 text-sm tracking-wider')} value={morse} spellCheck={false}
            onChange={e => { setMorse(e.target.value); setEdited('morse'); setText(morseToText(e.target.value).text); }} placeholder="... --- ..." />
        </div>
      </div>
      {unknown.length > 0 && <ErrorBox message={`No Morse equivalent for: ${unknown.slice(0, 20).join('  ')}`} />}

      <Card size="sm">
        <CardContent className="space-y-3 pt-3">
          <div className="flex flex-wrap items-center gap-4">
            <div className={cn('size-14 rounded-full border-4 transition-colors shrink-0', lamp ? 'bg-amber-300 border-amber-500 shadow-[0_0_24px_6px_rgba(251,191,36,0.6)]' : 'bg-secondary border-border')} aria-label="Signal lamp" />
            <div className="flex flex-wrap gap-2">
              <Button onClick={playing ? stop : play} disabled={!morse.trim()}>{playing ? <><Square /> Stop</> : <><Play /> Play</>}</Button>
              <Button variant="outline" disabled={!morse.trim()} onClick={() => downloadBlob(morseWav(morse, wpm, freq, Math.min(farnsworth, wpm)), 'morse.wav')}><Download /> .wav</Button>
            </div>
            <p className="text-xs text-muted-foreground">Duration ≈ {(totalUnits * 1.2 / wpm).toFixed(1)} s at {wpm} WPM</p>
          </div>
          <div className="h-1 rounded-full bg-secondary overflow-hidden"><div className="h-full bg-primary" style={{ width: `${progress * 100}%` }} /></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <RangeField label="Speed" value={wpm} min={5} max={40} onChange={v => { setWpm(v); if (farnsworth > v) setFarnsworth(v); }} suffix=" WPM" />
            <RangeField label="Farnsworth (effective)" value={Math.min(farnsworth, wpm)} min={5} max={wpm} onChange={setFarnsworth} suffix=" WPM" />
            <RangeField label="Tone" value={freq} min={300} max={1200} step={10} onChange={setFreq} suffix=" Hz" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RangeField({ label, value, onChange, min, max, step = 1, suffix = '' }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string;
}) {
  return (
    <div className="space-y-1.5">
      <FieldLabel>{label} <span className="tabular-nums text-foreground">{value}{suffix}</span></FieldLabel>
      <input type="range" className="w-full accent-primary" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
    </div>
  );
}

// ───────────────────────── Roman numerals ─────────────────────────

const ROMAN_PARTS: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];

function romanBreakdown(n: number): string[] {
  const out: string[] = [];
  let rest = n % 1000;
  if (n >= 4000) out.push(`${toRoman(Math.floor(n / 1000) * 1000, true).replace(/[IVXLCDM](?!̅)/g, '')} = ${(Math.floor(n / 1000) * 1000).toLocaleString()}`);
  else rest = n;
  for (const [v, s] of ROMAN_PARTS) while (rest >= v) { out.push(`${s} = ${v}`); rest -= v; }
  return out;
}

export function RomanNumeralConverter() {
  const [num, setNum] = useState('2025');
  const [roman, setRoman] = useState('MMXXV');
  const [vinculum, setVinculum] = useState(false);
  const [err, setErr] = useState<{ side: 'num' | 'roman'; msg: string } | null>(null);

  const fromNumber = (s: string, vin = vinculum) => {
    setNum(s);
    if (!s.trim()) { setRoman(''); setErr(null); return; }
    const n = Number(s.replace(/[,_\s]/g, ''));
    try { setRoman(toRoman(n, vin)); setErr(null); } catch (e) { setErr({ side: 'num', msg: (e as Error).message }); }
  };
  const fromRomanStr = (s: string) => {
    setRoman(s);
    if (!s.trim()) { setNum(''); setErr(null); return; }
    try { setNum(String(fromRoman(s))); setErr(null); } catch (e) { setErr({ side: 'roman', msg: (e as Error).message }); }
  };
  const value = Number(num);
  const valid = !err && Number.isInteger(value) && value > 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Number</FieldLabel>
          <Input value={num} onChange={e => fromNumber(e.target.value)} inputMode="numeric" className="h-12 text-xl tabular-nums" />
          {err?.side === 'num' && <ErrorBox message={err.msg} />}
        </div>
        <div className="space-y-1.5">
          <FieldLabel action={<CopyButton value={roman} label="Copy" />}>Roman numeral</FieldLabel>
          <Input value={roman} onChange={e => fromRomanStr(e.target.value)} className="h-12 text-xl tracking-wider font-serif" spellCheck={false} />
          {err?.side === 'roman' && <ErrorBox message={err.msg} />}
        </div>
      </div>
      <Checkbox checked={vinculum} onChange={v => { setVinculum(v); fromNumber(num, v); }}>Vinculum notation above 3,999 (overline = ×1000, up to 3,999,999)</Checkbox>
      {valid && (
        <div className="flex flex-wrap gap-1.5">
          {romanBreakdown(value).map((p, i) => <Badge key={i} variant="secondary" className="font-mono">{p}</Badge>)}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
        {[[1, 'I'], [5, 'V'], [10, 'X'], [50, 'L'], [100, 'C'], [500, 'D'], [1000, 'M']].map(([v, s]) => (
          <button key={s} type="button" onClick={() => fromNumber(String(v))} className="rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-center cursor-pointer hover:border-primary/50">
            <p className="text-lg font-serif">{s}</p><p className="text-[11px] text-muted-foreground tabular-nums">{Number(v).toLocaleString()}</p>
          </button>
        ))}
      </div>
      <InfoBox>Rules: a smaller numeral before a larger one subtracts (IV = 4, CM = 900); only I, X and C can subtract, and only from the next two larger numerals; no symbol repeats more than three times. Non-canonical forms like IIII or IC are rejected.</InfoBox>
    </div>
  );
}

// ───────────────────────── Unit converter ─────────────────────────

export function UnitConverter() {
  const [catId, setCatId] = useState('length');
  const [value, setValue] = useState('1');
  const [from, setFrom] = useState('m');
  const [q, setQ] = useState('');
  const cat = UNIT_CATEGORIES.find(c => c.id === catId)!;
  const v = Number(value.replace(/,/g, ''));
  const fromUnit = cat.units.find(u => u.id === from) ?? cat.units[0];

  const query = q.trim().toLowerCase();
  const matchesUnit = (u: { label: string; symbol: string; id: string }) => !query || u.label.toLowerCase().includes(query) || u.symbol.toLowerCase() === query || u.id.toLowerCase() === query;
  const catMatches = (c: typeof cat) => !query || c.label.toLowerCase().includes(query) || c.units.some(matchesUnit);

  const pickCat = (id: string) => {
    const c = UNIT_CATEGORIES.find(x => x.id === id)!;
    setCatId(id);
    setFrom((c.units.find(u => u.symbol === c.base || u.id === c.base.toLowerCase()) ?? c.units[0]).id);
  };
  useEffect(() => {
    // Jump to the first matching category when the current one has no match.
    if (query && !catMatches(cat)) { const c = UNIT_CATEGORIES.find(catMatches); if (c) pickCat(c.id); }
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = cat.units.filter(u => (cat.label.toLowerCase().includes(query) ? true : matchesUnit(u)));

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search units — e.g. psi, gallon, mpg, kWh…" className="pl-7" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {UNIT_CATEGORIES.filter(catMatches).map(c => (
          <button key={c.id} type="button" onClick={() => pickCat(c.id)}
            className={cn('rounded-md border px-2.5 py-1 text-xs cursor-pointer transition-colors', c.id === catId ? 'border-primary bg-primary/10 font-medium' : 'border-border hover:bg-secondary/40')}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
        <div className="space-y-1.5">
          <FieldLabel>Value</FieldLabel>
          <Input value={value} onChange={e => setValue(e.target.value)} inputMode="decimal" className="h-10 text-base tabular-nums" />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>From</FieldLabel>
          <NativeSelect value={fromUnit.id} onChange={setFrom} options={cat.units.map(u => ({ value: u.id, label: `${u.label} (${u.symbol})` }))} className="h-10 text-sm" />
        </div>
      </div>
      {value.trim() && !Number.isFinite(v) && <ErrorBox message="Enter a number (e.g. 12.5 or 1e6)." />}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(u => {
          const out = Number.isFinite(v) ? convertUnit(cat, v, fromUnit.id, u.id) : NaN;
          const s = formatNumber(out);
          return (
            <div key={u.id} className={cn('flex items-center gap-2 rounded-md border px-3 py-2 min-w-0', u.id === fromUnit.id ? 'border-primary bg-primary/5' : 'border-border bg-card')}>
              <button type="button" className="flex-1 min-w-0 text-left cursor-pointer" title="Convert from this unit" onClick={() => { setFrom(u.id); setValue(Number.isFinite(out) ? String(Number(out.toPrecision(12))) : value); }}>
                <p className="text-sm font-semibold tabular-nums break-all">{s} <span className="font-normal text-muted-foreground">{u.symbol}</span></p>
                <p className="text-[11px] text-muted-foreground truncate">{u.label}</p>
              </button>
              <CopyButton value={Number.isFinite(out) ? String(Number(out.toPrecision(12))) : ''} />
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">Click a result to convert from that unit. Data units: kB/MB/GB are decimal (1000), KiB/MiB/GiB are binary (1024). US and UK gallons/pints differ.</p>
    </div>
  );
}

