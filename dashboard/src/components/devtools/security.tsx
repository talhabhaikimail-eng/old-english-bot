import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Check, CircleCheck, CircleX, Coins, Dice5, Download, Eye, EyeOff, KeyRound, ListOrdered,
  Loader2, RefreshCw, ShieldAlert, ShieldCheck, Shuffle, Sparkles, Trash2, Wand2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  MONO, FIXED, Checkbox, CopyButton, ErrorBox, FieldLabel, FileDrop, InfoBox, NumberField, Segmented, Stat,
  downloadBlob, formatBytes, toolsApi,
} from './shared';
import {
  analyzePassword, diceRange, formatDuration, generatePassphrase, generatePassword, hibpCount, parseDice, passwordEntropy,
  passwordPool, pick, randomBelow, randomDecimal, randomInt, rollDice, sha1Hex, shuffle, strengthLabel, uniqueInts,
  validatePasswordOptions, CHARSETS, PASSPHRASE_WORDS, type DiceRoll, type Match, type PasswordOptions,
} from './lib/security';

// ── shared bits ──────────────────────────────────────────────────────────────

/** The shared Tabs use Tailwind v4 data-* variants; these are the Tailwind 3 equivalents. */
const TAB_ACTIVE = 'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:border-border data-[state=active]:shadow-sm';

/** Tinted backgrounds via color-mix (opacity modifiers don't apply to the var()-based theme colors). */
const TINT = {
  ok: 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] border-[color-mix(in_srgb,var(--primary)_45%,transparent)]',
  bad: 'bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] border-[color-mix(in_srgb,var(--destructive)_45%,transparent)]',
  warn: 'bg-amber-500/10 border-amber-500/40',
};

const SELECT = 'h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-primary';

function SelectBox<T extends string>({ value, onChange, options, className }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string;
}) {
  return (
    <select className={cn(SELECT, className)} value={value} onChange={e => onChange(e.target.value as T)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Slider({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return <input type="range" className="w-full accent-primary" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />;
}

const LEVEL_COLOR = ['bg-destructive', 'bg-destructive', 'bg-amber-500', 'bg-primary', 'bg-primary'];
const LEVEL_TEXT = ['text-destructive', 'text-destructive', 'text-amber-600 dark:text-amber-400', 'text-primary', 'text-primary'];

function StrengthBar({ level, label, detail }: { level: 0 | 1 | 2 | 3 | 4; label: string; detail?: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-5 gap-1">
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className={cn('h-1.5 rounded-full', i <= level ? LEVEL_COLOR[level] : 'bg-secondary')} />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className={cn('font-medium', LEVEL_TEXT[level])}>{label}</span>
        {detail && <span className="text-muted-foreground">{detail}</span>}
      </div>
    </div>
  );
}

/** Read-only code block with copy + optional download. */
function CodeBlock({ label, value, filename, rows = 6, hint }: { label: string; value: string; filename?: string; rows?: number; hint?: React.ReactNode }) {
  return (
    <div className="space-y-1.5 min-w-0">
      <FieldLabel action={
        <div className="flex items-center gap-1">
          <CopyButton value={value} label="Copy" />
          {filename && <Button variant="ghost" size="xs" onClick={() => downloadBlob(value, filename)}><Download /> {filename}</Button>}
        </div>
      }>{label}</FieldLabel>
      <Textarea readOnly spellCheck={false} className={cn(MONO, FIXED, 'bg-secondary break-all')} style={{ height: `${rows * 1.25 + 1}rem` }} value={value} />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function randomSecret(bytes = 48) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Checksum / hash generator ───────────────────────────────────────────────

const HASH_LABELS: Record<string, string> = {
  md5: 'MD5', sha1: 'SHA-1', sha224: 'SHA-224', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512',
  'sha512-256': 'SHA-512/256', 'sha3-256': 'SHA3-256', 'sha3-384': 'SHA3-384', 'sha3-512': 'SHA3-512',
  ripemd160: 'RIPEMD-160', blake2b512: 'BLAKE2b-512', blake2s256: 'BLAKE2s-256', crc32: 'CRC-32',
};
const FALLBACK_HASHES = Object.keys(HASH_LABELS);
const WEAK_HASHES = new Set(['md5', 'sha1', 'crc32']);

function normDigest(s: string) {
  return s.trim().replace(/^[a-z0-9-]+[:=]\s*/i, '').replace(/\s+/g, '').toLowerCase();
}

function digestEquals(expected: string, value: string) {
  const e = normDigest(expected);
  if (!e) return false;
  return /^[0-9a-f]+$/.test(e) ? e === value.toLowerCase() : expected.trim() === value;
}

function HashRows({ hashes, expected, upper }: { hashes: Record<string, string>; expected: string; upper: boolean }) {
  return (
    <div className="rounded-md border border-border px-3">
      {Object.entries(hashes).map(([alg, v]) => {
        const shown = upper ? v.toUpperCase() : v;
        const match = expected.trim() ? digestEquals(expected, v) : null;
        return (
          <div key={alg} className={cn('flex items-center gap-2 py-1.5 border-b border-border last:border-0', match && '-mx-3 px-3 ' + TINT.ok)}>
            <span className="w-24 shrink-0 text-xs text-muted-foreground flex items-center gap-1">
              {HASH_LABELS[alg] ?? alg}
              {WEAK_HASHES.has(alg) && <span title="Not collision-resistant — fine for checksums, not for security" className="text-amber-500">•</span>}
            </span>
            <code className={cn(MONO, 'flex-1 min-w-0 break-all')}>{shown}</code>
            {match && <Badge className="shrink-0"><Check /> match</Badge>}
            <CopyButton value={shown} />
          </div>
        );
      })}
    </div>
  );
}

function MatchSummary({ expected, matched }: { expected: string; matched: boolean | null }) {
  if (!expected.trim() || matched === null) return null;
  return matched
    ? <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-xs', TINT.ok)}><CircleCheck className="size-4 text-primary" /> Expected hash matches.</div>
    : <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-xs', TINT.bad)}><CircleX className="size-4 text-destructive" /> No selected algorithm produces the expected hash.</div>;
}

export function ChecksumGenerator() {
  const [available, setAvailable] = useState<string[]>(FALLBACK_HASHES);
  const [algs, setAlgs] = useState<string[]>(['md5', 'sha1', 'sha256', 'sha512']);
  const [encoding, setEncoding] = useState<'hex' | 'base64'>('hex');
  const [upper, setUpper] = useState(false);
  const [hmacKey, setHmacKey] = useState('');
  const [expected, setExpected] = useState('');
  const [tab, setTab] = useState('text');

  useEffect(() => {
    toolsApi.get<{ hashes: string[] }>('/crypto/algorithms').then(r => setAvailable(r.hashes)).catch(() => {});
  }, []);

  const toggle = (a: string) => setAlgs(l => (l.includes(a) ? l.filter(x => x !== a) : [...l, a]));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <FieldLabel action={
          <div className="flex gap-1">
            <Button variant="ghost" size="xs" onClick={() => setAlgs(available)}>All</Button>
            <Button variant="ghost" size="xs" onClick={() => setAlgs(['sha256'])}>SHA-256 only</Button>
          </div>
        }>Algorithms</FieldLabel>
        <div className="flex flex-wrap gap-1.5">
          {available.map(a => (
            <button key={a} type="button" onClick={() => toggle(a)}
              className={cn('h-7 px-2.5 rounded-md border text-xs cursor-pointer transition-colors',
                algs.includes(a) ? 'border-primary text-foreground bg-secondary' : 'border-border text-muted-foreground hover:text-foreground')}>
              {HASH_LABELS[a] ?? a}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 items-end">
        <div className="space-y-1.5">
          <FieldLabel>Output</FieldLabel>
          <div className="flex items-center gap-3 flex-wrap">
            <Segmented value={encoding} onChange={setEncoding} options={[{ value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }]} />
            {encoding === 'hex' && <Checkbox checked={upper} onChange={setUpper}>Uppercase</Checkbox>}
          </div>
        </div>
        <div className="space-y-1.5">
          <FieldLabel>HMAC key (optional)</FieldLabel>
          <Input className={MONO} placeholder="Leave empty for plain digests" value={hmacKey} onChange={e => setHmacKey(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <FieldLabel>Compare with expected hash</FieldLabel>
          <Input className={MONO} placeholder="Paste a published checksum to verify" value={expected} onChange={e => setExpected(e.target.value)} />
        </div>
      </div>
      {!algs.length && <ErrorBox message="Select at least one algorithm." />}
      <Tabs className="flex-col" value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger className={TAB_ACTIVE} value="text">Text</TabsTrigger>
          <TabsTrigger className={TAB_ACTIVE} value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="text" className="pt-2">
          <TextHashes algs={algs} encoding={encoding} upper={upper} hmacKey={hmacKey} expected={expected} />
        </TabsContent>
        <TabsContent value="files" className="pt-2">
          <FileHashes algs={algs} encoding={encoding} upper={upper} hmacKey={hmacKey} expected={expected} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface HashProps { algs: string[]; encoding: 'hex' | 'base64'; upper: boolean; hmacKey: string; expected: string }

function TextHashes({ algs, encoding, upper, hmacKey, expected }: HashProps) {
  const [text, setText] = useState('The quick brown fox jumps over the lazy dog');
  const [inputEncoding, setInputEncoding] = useState<'utf8' | 'hex' | 'base64'>('utf8');
  const [result, setResult] = useState<{ hashes: Record<string, string>; bytes: number; ms: number } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const req = useDebounced(JSON.stringify({ text, algorithms: algs, encoding, hmacKey, inputEncoding }), 250);

  useEffect(() => {
    const body = JSON.parse(req);
    if (!body.algorithms.length) { setResult(null); return; }
    let alive = true;
    setLoading(true);
    toolsApi.post('/crypto/hash', body)
      .then(r => { if (alive) { setResult(r); setError(''); } })
      .catch(e => { if (alive) setError((e as Error).message); })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [req]);

  const matched = result && expected.trim() ? Object.values(result.hashes).some(v => digestEquals(expected, v)) : null;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel action={
          <div className="flex items-center gap-2">
            <Segmented value={inputEncoding} onChange={setInputEncoding} options={[{ value: 'utf8', label: 'UTF-8' }, { value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }]} />
            <Button variant="ghost" size="xs" onClick={() => setText('')}>Clear</Button>
          </div>
        }>Input</FieldLabel>
        <Textarea className={cn(MONO, FIXED, 'h-28')} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
        <p className="text-[11px] text-muted-foreground flex items-center gap-2">
          {result ? `${formatBytes(result.bytes)} · ${result.ms} ms` : ' '}
          {loading && <Loader2 className="size-3 animate-spin" />}
          {hmacKey && <Badge variant="secondary">HMAC</Badge>}
        </p>
      </div>
      {error && <ErrorBox message={error} />}
      <MatchSummary expected={expected} matched={matched} />
      {result && <HashRows hashes={result.hashes} expected={expected} upper={upper && encoding === 'hex'} />}
    </div>
  );
}

interface FileHashResult { name: string; size: number; hashes: Record<string, string>; ms: number; mbps: number | null }

function FileHashes({ algs, encoding, upper, hmacKey, expected }: HashProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<FileHashResult[] | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const total = files.reduce((a, f) => a + f.size, 0);
  const tooBig = total > 500 * 1024 * 1024;

  const run = async () => {
    setRunning(true);
    setError('');
    setResults(null);
    try {
      const form = new FormData();
      form.append('algorithms', algs.join(','));
      form.append('encoding', encoding);
      if (hmacKey) form.append('hmacKey', hmacKey);
      files.forEach(f => form.append('files', f, f.name));
      const r = await toolsApi.postForm<{ files: FileHashResult[] }>('/crypto/hash-file', form);
      setResults(r.files);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const sumAlg = algs.includes('sha256') ? 'sha256' : algs[0];
  const sumFile = results && sumAlg ? results.map(r => `${r.hashes[sumAlg]}  ${r.name}`).join('\n') + '\n' : '';

  return (
    <div className="space-y-3">
      <FileDrop files={files} onFiles={f => { setFiles(f); setResults(null); }} multiple
        hint={`Any file type · up to 50 files / 500 MB total${files.length ? ` · selected ${formatBytes(total)}` : ''}`} />
      {tooBig && <ErrorBox message="Selected files exceed 500 MB." />}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!files.length || !algs.length || running || tooBig} onClick={run}>
          {running ? <Loader2 className="animate-spin" /> : <ShieldCheck />} {running ? `Hashing ${formatBytes(total)}…` : 'Compute checksums'}
        </Button>
        {results && sumFile && (
          <>
            <CopyButton value={sumFile} label={`Copy ${HASH_LABELS[sumAlg] ?? sumAlg} list`} />
            <Button variant="ghost" size="xs" onClick={() => downloadBlob(sumFile, `CHECKSUMS.${sumAlg}`)}><Download /> {`CHECKSUMS.${sumAlg}`}</Button>
          </>
        )}
      </div>
      {error && <ErrorBox message={error} />}
      {results?.map((r, i) => {
        const matched = expected.trim() ? Object.values(r.hashes).some(v => digestEquals(expected, v)) : null;
        return (
          <div key={i} className="space-y-2 rounded-lg border border-border p-3 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium truncate max-w-full">{r.name}</span>
              <span className="text-muted-foreground">{formatBytes(r.size)} · {r.ms} ms{r.mbps ? ` · ${r.mbps} MB/s` : ''}</span>
              {matched === true && <Badge><Check /> matches expected</Badge>}
              {matched === false && <Badge variant="destructive">no match</Badge>}
            </div>
            <HashRows hashes={r.hashes} expected={expected} upper={upper && encoding === 'hex'} />
          </div>
        );
      })}
    </div>
  );
}

// ── Password generator ──────────────────────────────────────────────────────

const SEPARATORS = [
  { value: '-', label: 'Hyphen (-)' }, { value: ' ', label: 'Space' }, { value: '.', label: 'Period (.)' },
  { value: '_', label: 'Underscore (_)' }, { value: '', label: 'None' }, { value: 'custom', label: 'Custom…' },
];

function crackTimeFromBits(bits: number) {
  return formatDuration(2 ** bits / 2 / 1e10);
}

export function PasswordGenerator() {
  const [mode, setMode] = useState<'password' | 'passphrase'>('password');
  const [opts, setOpts] = useState<PasswordOptions>({
    length: 20, upper: true, lower: true, digits: true, symbols: true, symbolSet: CHARSETS.symbols,
    excludeSimilar: false, excludeAmbiguous: false, exclude: '', requireEach: true, noRepeats: false,
  });
  const [pp, setPp] = useState({ words: 5, separator: '-', custom: '~', capitalize: 'first' as 'none' | 'first' | 'all' | 'random', addNumber: true, addSymbol: false });
  const [count, setCount] = useState(1);
  const [list, setList] = useState<string[]>([]);
  const [shown, setShown] = useState(true);
  const set = <K extends keyof PasswordOptions>(k: K, v: PasswordOptions[K]) => setOpts(o => ({ ...o, [k]: v }));

  const error = mode === 'password' ? validatePasswordOptions(opts) : null;
  const pool = passwordPool(opts);
  const sep = pp.separator === 'custom' ? pp.custom : pp.separator;
  const ppOpts = { words: pp.words, separator: sep, capitalize: pp.capitalize, addNumber: pp.addNumber, addSymbol: pp.addSymbol };
  const bits = mode === 'password' ? passwordEntropy(opts) : generatePassphrase(ppOpts).entropy;
  const strength = strengthLabel(bits);

  const generate = useCallback(() => {
    const n = Math.max(1, Math.min(count || 1, 500));
    if (mode === 'password') {
      if (validatePasswordOptions(opts)) { setList([]); return; }
      setList(Array.from({ length: n }, () => generatePassword(opts)));
    } else {
      setList(Array.from({ length: n }, () => generatePassphrase(ppOpts).phrase));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, JSON.stringify(opts), JSON.stringify(ppOpts), count]);

  useEffect(generate, [generate]);

  const first = list[0] ?? '';
  const all = list.join('\n');

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm">Options</CardTitle>
            <Segmented value={mode} onChange={setMode} options={[{ value: 'password', label: 'Password' }, { value: 'passphrase', label: 'Passphrase' }]} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {mode === 'password' ? (
            <>
              <div className="space-y-1.5">
                <FieldLabel action={<Input type="number" className="w-20 h-7" min={4} max={1024} value={opts.length} onChange={e => set('length', Number(e.target.value) || 1)} />}>Length</FieldLabel>
                <Slider value={Math.min(opts.length, 128)} min={4} max={128} onChange={v => set('length', v)} />
                <div className="flex gap-1 flex-wrap">
                  {[12, 16, 20, 32, 64].map(n => <Button key={n} variant={opts.length === n ? 'secondary' : 'ghost'} size="xs" onClick={() => set('length', n)}>{n}</Button>)}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Checkbox checked={opts.upper} onChange={v => set('upper', v)}>Uppercase (A–Z)</Checkbox>
                <Checkbox checked={opts.lower} onChange={v => set('lower', v)}>Lowercase (a–z)</Checkbox>
                <Checkbox checked={opts.digits} onChange={v => set('digits', v)}>Digits (0–9)</Checkbox>
                <Checkbox checked={opts.symbols} onChange={v => set('symbols', v)}>Symbols</Checkbox>
              </div>
              {opts.symbols && (
                <div className="space-y-1.5">
                  <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => set('symbolSet', CHARSETS.symbols)}>Reset</Button>}>Symbol set</FieldLabel>
                  <Input className={MONO} value={opts.symbolSet} onChange={e => set('symbolSet', e.target.value)} placeholder={CHARSETS.symbols} />
                  <p className="text-[11px] text-muted-foreground">Trim this to what a site accepts, e.g. <code>!@#$%</code>.</p>
                </div>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <Checkbox checked={!!opts.excludeSimilar} onChange={v => set('excludeSimilar', v)}>Exclude similar (i l 1 L o 0 O)</Checkbox>
                <Checkbox checked={!!opts.excludeAmbiguous} onChange={v => set('excludeAmbiguous', v)}>Exclude ambiguous ({'{ } [ ] ( ) / \\ \' " ` ~ , ; : . < >'})</Checkbox>
                <Checkbox checked={!!opts.requireEach} onChange={v => set('requireEach', v)}>At least one from each set</Checkbox>
                <Checkbox checked={!!opts.noRepeats} onChange={v => set('noRepeats', v)}>No repeated characters</Checkbox>
              </div>
              <div className="space-y-1.5">
                <FieldLabel>Never use these characters</FieldLabel>
                <Input className={MONO} value={opts.exclude} placeholder="e.g. $&quot;'" onChange={e => set('exclude', e.target.value)} />
              </div>
              <p className="text-[11px] text-muted-foreground">Pool: {pool.length} characters</p>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <FieldLabel action={<span className="text-xs tabular-nums">{pp.words} words</span>}>Words</FieldLabel>
                <Slider value={pp.words} min={3} max={12} onChange={v => setPp(p => ({ ...p, words: v }))} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <FieldLabel>Separator</FieldLabel>
                  <SelectBox value={pp.separator} onChange={v => setPp(p => ({ ...p, separator: v }))} options={SEPARATORS} />
                  {pp.separator === 'custom' && <Input className={MONO} value={pp.custom} onChange={e => setPp(p => ({ ...p, custom: e.target.value }))} />}
                </div>
                <div className="space-y-1.5">
                  <FieldLabel>Capitalisation</FieldLabel>
                  <SelectBox value={pp.capitalize} onChange={v => setPp(p => ({ ...p, capitalize: v }))} options={[
                    { value: 'none', label: 'lowercase' }, { value: 'first', label: 'Capitalise Each Word' },
                    { value: 'all', label: 'UPPERCASE' }, { value: 'random', label: 'Random words (+1 bit each)' },
                  ]} />
                </div>
              </div>
              <div className="flex flex-wrap gap-4">
                <Checkbox checked={pp.addNumber} onChange={v => setPp(p => ({ ...p, addNumber: v }))}>Add a number</Checkbox>
                <Checkbox checked={pp.addSymbol} onChange={v => setPp(p => ({ ...p, addSymbol: v }))}>Add a symbol</Checkbox>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Words are drawn uniformly from a built-in list of {PASSPHRASE_WORDS.length.toLocaleString()} common English words
                ({Math.log2(PASSPHRASE_WORDS.length).toFixed(1)} bits per word).
              </p>
            </>
          )}
          <NumberField label="How many" value={count} min={1} max={500} onChange={v => setCount(v)} className="max-w-40" />
        </CardContent>
      </Card>

      <div className="space-y-3 min-w-0">
        {error ? <ErrorBox message={error} /> : (
          <>
            <div className="rounded-lg border border-border bg-secondary p-4 space-y-3">
              <div className="flex items-start gap-2">
                <code className={cn('flex-1 min-w-0 break-all font-mono text-base leading-relaxed select-all', !shown && 'blur-sm select-none')}>{first || '…'}</code>
                <div className="flex shrink-0">
                  <Button variant="ghost" size="icon-xs" title={shown ? 'Hide' : 'Show'} onClick={() => setShown(s => !s)}>{shown ? <EyeOff /> : <Eye />}</Button>
                  <Button variant="ghost" size="icon-xs" title="Regenerate" onClick={generate}><RefreshCw /></Button>
                  <CopyButton value={first} />
                </div>
              </div>
              <StrengthBar level={strength.level} label={`${strength.label} · ${bits.toFixed(1)} bits`} detail={`≈ ${crackTimeFromBits(bits)} at 10B guesses/s`} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="Entropy" value={`${bits.toFixed(1)} bits`} />
              <Stat label="Length" value={mode === 'password' ? opts.length : `${first.length} chars`} />
              <Stat label={mode === 'password' ? 'Pool' : 'Words'} value={mode === 'password' ? pool.length : pp.words} />
            </div>
            {list.length > 1 && (
              <div className="space-y-1.5">
                <FieldLabel action={
                  <div className="flex gap-1">
                    <CopyButton value={all} label="Copy all" />
                    <Button variant="ghost" size="xs" onClick={() => downloadBlob(all + '\n', mode === 'password' ? 'passwords.txt' : 'passphrases.txt')}><Download /> .txt</Button>
                  </div>
                }>{list.length} {mode === 'password' ? 'passwords' : 'passphrases'}</FieldLabel>
                <Textarea readOnly className={cn(MONO, FIXED, 'h-64 bg-secondary', !shown && 'blur-sm')} value={all} />
              </div>
            )}
            <InfoBox>Generated in your browser with <code>crypto.getRandomValues</code> and rejection sampling — nothing is sent to the server.</InfoBox>
          </>
        )}
      </div>
    </div>
  );
}

// ── Password strength meter ─────────────────────────────────────────────────

const KIND_LABEL: Record<Match['kind'], string> = {
  password: 'common password', dictionary: 'dictionary word', name: 'name', keyboard: 'keyboard pattern',
  sequence: 'sequence', repeat: 'repeat', date: 'date', year: 'year', bruteforce: 'random',
};

export function PasswordStrengthMeter() {
  const [pw, setPw] = useState('Summer2024!');
  const [show, setShow] = useState(true);
  const [hibp, setHibp] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; count?: number; prefix?: string; error?: string }>({ state: 'idle' });
  const a = useMemo(() => analyzePassword(pw), [pw]);

  useEffect(() => { setHibp({ state: 'idle' }); }, [pw]);

  const checkBreaches = async () => {
    setHibp({ state: 'loading' });
    try {
      const hash = await sha1Hex(pw);
      const prefix = hash.slice(0, 5);
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true' } });
      if (!res.ok) throw new Error(`HIBP returned HTTP ${res.status}`);
      const count = hibpCount(await res.text(), hash.slice(5));
      setHibp({ state: 'done', count, prefix });
    } catch (e) {
      setHibp({ state: 'error', error: (e as Error).message });
    }
  };

  const classes: [keyof typeof a.classes, string][] = [['lower', 'a–z'], ['upper', 'A–Z'], ['digit', '0–9'], ['symbol', 'symbols'], ['space', 'spaces'], ['unicode', 'unicode']];

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldLabel>Password</FieldLabel>
        <div className="flex gap-2">
          <Input type={show ? 'text' : 'password'} className="font-mono" value={pw} onChange={e => setPw(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Type a password to analyse" />
          <Button variant="outline" size="icon" title={show ? 'Hide' : 'Show'} onClick={() => setShow(s => !s)}>{show ? <EyeOff /> : <Eye />}</Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Analysed locally in your browser — the password is never sent anywhere.</p>
      </div>

      {pw && (
        <>
          <div className="rounded-lg border border-border p-4 space-y-4">
            <StrengthBar level={a.score} label={a.label} detail={`≈ ${a.bits.toFixed(1)} bits · 10^${a.log10Guesses.toFixed(1)} guesses`} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Length" value={a.length} />
              <Stat label="Character pool" value={a.pool} />
              <Stat label="Naive entropy" value={`${a.naiveBits.toFixed(0)} bits`} hint="length × log₂(pool)" />
              <Stat label="Effective entropy" value={`${a.bits.toFixed(0)} bits`} hint="after pattern detection" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {classes.map(([k, l]) => (
                <Badge key={k} variant={a.classes[k] ? 'default' : 'outline'} className={cn(!a.classes[k] && 'text-muted-foreground')}>
                  {a.classes[k] ? <Check /> : <X />} {l}
                </Badge>
              ))}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card size="sm">
              <CardHeader><CardTitle className="text-sm">How an attacker sees it</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1">
                  {a.segments.map((s, i) => (
                    <span key={i} className={cn('inline-flex flex-col rounded-md border px-2 py-1 min-w-0 max-w-full',
                      s.kind === 'bruteforce' ? 'border-border' : s.kind === 'password' ? TINT.bad : TINT.warn)}>
                      <code className="font-mono text-sm break-all">{s.token}</code>
                      <span className="text-[10px] text-muted-foreground">
                        {KIND_LABEL[s.kind]}{s.leet ? ' · l33t' : ''}{s.caps === 'first' ? ' · Capitalised' : ''} · 10^{s.log10.toFixed(1)}
                      </span>
                    </span>
                  ))}
                </div>
                {a.warnings.length > 0 && (
                  <ul className="space-y-1">
                    {a.warnings.map((w, i) => <li key={i} className="flex gap-2 text-xs"><AlertTriangle className="size-3.5 shrink-0 text-amber-500 mt-0.5" />{w}</li>)}
                  </ul>
                )}
                {a.suggestions.length > 0 && (
                  <ul className="space-y-1">
                    {a.suggestions.map((w, i) => <li key={i} className="flex gap-2 text-xs text-muted-foreground"><Sparkles className="size-3.5 shrink-0 text-primary mt-0.5" />{w}</li>)}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm">Estimated time to crack</CardTitle>
                <CardDescription className="text-xs">Average time to find it (half the guesses).</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border border-border px-3">
                  {a.crack.map(c => (
                    <div key={c.id} className="flex items-center gap-2 py-2 border-b border-border last:border-0 text-xs">
                      <div className="flex-1 min-w-0">
                        <p>{c.label}</p>
                        <p className="text-[11px] text-muted-foreground">{c.rate}</p>
                      </div>
                      <span className={cn('font-medium text-right', c.seconds < 3600 ? 'text-destructive' : c.seconds < 31557600 * 10 ? 'text-amber-600 dark:text-amber-400' : 'text-primary')}>{c.display}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Breach check (Have I Been Pwned)</CardTitle>
              <CardDescription className="text-xs">
                Uses k-anonymity: only the first 5 characters of the password's SHA-1 hash leave your browser
                {hibp.prefix ? <> (<code>{hibp.prefix}</code>)</> : null}; the match is done locally against the returned list.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" disabled={hibp.state === 'loading'} onClick={checkBreaches}>
                {hibp.state === 'loading' ? <Loader2 className="animate-spin" /> : <ShieldAlert />} Check breaches
              </Button>
              {hibp.state === 'done' && (hibp.count
                ? <span className="text-xs text-destructive font-medium flex items-center gap-1.5"><CircleX className="size-4" /> Found in {hibp.count.toLocaleString()} breached records — do not use it.</span>
                : <span className="text-xs text-primary font-medium flex items-center gap-1.5"><CircleCheck className="size-4" /> Not found in known breaches.</span>)}
              {hibp.state === 'error' && <span className="text-xs text-destructive">{hibp.error}</span>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Random number generator ─────────────────────────────────────────────────

const DICE_PRESETS = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100', '2d6', '3d6+2', '4d6dl1', '2d20kh1', '2d20kl1'];
const DICE_HINT: Record<string, string> = { '4d6dl1': 'D&D ability score', '2d20kh1': 'advantage', '2d20kl1': 'disadvantage' };

export function RandomNumberGenerator() {
  return (
    <Tabs className="flex-col" defaultValue="numbers">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger className={TAB_ACTIVE} value="numbers"><ListOrdered /> Numbers</TabsTrigger>
        <TabsTrigger className={TAB_ACTIVE} value="dice"><Dice5 /> Dice</TabsTrigger>
        <TabsTrigger className={TAB_ACTIVE} value="coin"><Coins /> Coin</TabsTrigger>
        <TabsTrigger className={TAB_ACTIVE} value="list"><Shuffle /> List</TabsTrigger>
      </TabsList>
      <TabsContent value="numbers" className="pt-2"><NumbersTab /></TabsContent>
      <TabsContent value="dice" className="pt-2"><DiceTab /></TabsContent>
      <TabsContent value="coin" className="pt-2"><CoinTab /></TabsContent>
      <TabsContent value="list" className="pt-2"><ListTab /></TabsContent>
    </Tabs>
  );
}

function NumbersTab() {
  const [min, setMin] = useState(1);
  const [max, setMax] = useState(100);
  const [count, setCount] = useState(1);
  const [kind, setKind] = useState<'int' | 'dec'>('int');
  const [decimals, setDecimals] = useState(2);
  const [unique, setUnique] = useState(false);
  const [sort, setSort] = useState<'none' | 'asc' | 'desc'>('none');
  const [sep, setSep] = useState<'\n' | ', ' | ' '>('\n');
  const [values, setValues] = useState<number[]>([]);
  const [error, setError] = useState('');

  const generate = () => {
    setError('');
    try {
      if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('Enter a minimum and maximum.');
      const n = Math.max(1, Math.min(Math.floor(count) || 1, 10000));
      let out: number[];
      if (kind === 'int') {
        if (!Number.isInteger(min) || !Number.isInteger(max)) throw new Error('Integer mode needs whole-number bounds.');
        out = unique ? uniqueInts(min, max, n) : Array.from({ length: n }, () => randomInt(min, max));
      } else {
        const d = Math.max(0, Math.min(decimals, 10));
        if (unique) {
          const f = 10 ** d;
          out = uniqueInts(Math.ceil(Math.min(min, max) * f), Math.floor(Math.max(min, max) * f), n).map(x => x / f);
        } else out = Array.from({ length: n }, () => randomDecimal(min, max, d));
      }
      if (sort !== 'none') out.sort((a, b) => (sort === 'asc' ? a - b : b - a));
      setValues(out);
    } catch (e) {
      setError((e as Error).message);
      setValues([]);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(generate, []);

  const fmt = (v: number) => (kind === 'dec' ? v.toFixed(Math.max(0, Math.min(decimals, 10))) : String(v));
  const text = values.map(fmt).join(sep);
  const sum = values.reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <NumberField label="Minimum" value={min} onChange={setMin} step={kind === 'dec' ? 0.01 : 1} />
        <NumberField label="Maximum" value={max} onChange={setMax} step={kind === 'dec' ? 0.01 : 1} />
        <NumberField label="How many" value={count} onChange={setCount} min={1} max={10000} />
        {kind === 'dec' && <NumberField label="Decimal places" value={decimals} onChange={setDecimals} min={0} max={10} />}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={kind} onChange={setKind} options={[{ value: 'int', label: 'Integers' }, { value: 'dec', label: 'Decimals' }]} />
        <Checkbox checked={unique} onChange={setUnique}>No duplicates</Checkbox>
        <SelectBox className="w-36" value={sort} onChange={setSort} options={[{ value: 'none', label: 'Unsorted' }, { value: 'asc', label: 'Sort ascending' }, { value: 'desc', label: 'Sort descending' }]} />
        <SelectBox className="w-36" value={sep} onChange={setSep} options={[{ value: '\n', label: 'One per line' }, { value: ', ', label: 'Comma separated' }, { value: ' ', label: 'Space separated' }]} />
        <div className="flex gap-1">
          {[[1, 6], [1, 10], [1, 100], [0, 255], [1000, 9999]].map(([a, b]) => (
            <Button key={`${a}-${b}`} variant="ghost" size="xs" onClick={() => { setMin(a); setMax(b); setKind('int'); }}>{a}–{b}</Button>
          ))}
        </div>
      </div>
      <Button onClick={generate}><Dice5 /> Generate</Button>
      {error && <ErrorBox message={error} />}
      {values.length === 1 && (
        <div className="rounded-lg border border-border bg-secondary p-6 text-center">
          <p className="text-5xl font-semibold tabular-nums break-all">{fmt(values[0])}</p>
          <div className="mt-2 flex justify-center"><CopyButton value={fmt(values[0])} label="Copy" /></div>
        </div>
      )}
      {values.length > 1 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Count" value={values.length} />
            <Stat label="Min" value={fmt(Math.min(...values))} />
            <Stat label="Max" value={fmt(Math.max(...values))} />
            <Stat label="Mean" value={(sum / values.length).toFixed(2)} />
          </div>
          <div className="space-y-1.5">
            <FieldLabel action={<div className="flex gap-1"><CopyButton value={text} label="Copy" /><Button variant="ghost" size="xs" onClick={() => downloadBlob(values.map(fmt).join('\n') + '\n', 'random-numbers.txt')}><Download /> .txt</Button></div>}>Results</FieldLabel>
            <Textarea readOnly className={cn(MONO, FIXED, 'h-48 bg-secondary')} value={text} />
          </div>
        </>
      )}
      <p className="text-[11px] text-muted-foreground">Cryptographically secure (<code>crypto.getRandomValues</code>) with rejection sampling — no modulo bias.</p>
    </div>
  );
}

function DiceTab() {
  const [expr, setExpr] = useState('3d6+2');
  const [times, setTimes] = useState(1);
  const [history, setHistory] = useState<{ expr: string; roll: DiceRoll }[]>([]);
  const parsed = useMemo(() => parseDice(expr), [expr]);
  const range = Array.isArray(parsed) ? diceRange(parsed) : null;

  const roll = (e = expr) => {
    const p = parseDice(e);
    if (!Array.isArray(p)) return;
    const n = Math.max(1, Math.min(times || 1, 100));
    const rolls = Array.from({ length: n }, () => ({ expr: e, roll: rollDice(p) }));
    setHistory(h => [...rolls.reverse(), ...h].slice(0, 100));
  };

  const latest = history[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5 flex-1 min-w-48">
          <FieldLabel>Dice notation</FieldLabel>
          <Input className="font-mono" value={expr} onChange={e => setExpr(e.target.value)} onKeyDown={e => e.key === 'Enter' && roll()} placeholder="e.g. 2d6+3, 4d6dl1, 2d20kh1" />
        </div>
        <NumberField label="Times" value={times} onChange={setTimes} min={1} max={100} className="w-24" />
        <Button onClick={() => roll()} disabled={!Array.isArray(parsed)}><Dice5 /> Roll</Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {DICE_PRESETS.map(p => (
          <Button key={p} variant="outline" size="xs" title={DICE_HINT[p]} onClick={() => { setExpr(p); roll(p); }}>{p}{DICE_HINT[p] ? ` · ${DICE_HINT[p]}` : ''}</Button>
        ))}
      </div>
      {!Array.isArray(parsed) ? <ErrorBox message={parsed.error} /> : range && (
        <p className="text-[11px] text-muted-foreground">Range {range.min}–{range.max}{!parsed.some(t => t.kind === 'dice' && t.mod) ? ` · average ${range.mean}` : ''}. Supports <code>NdS</code>, <code>d%</code>, <code>khN</code>/<code>klN</code> (keep highest/lowest), <code>dlN</code>/<code>dhN</code> (drop) and <code>±N</code>.</p>
      )}
      {latest && (
        <div className="rounded-lg border border-border bg-secondary p-4 space-y-2">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-5xl font-semibold tabular-nums">{latest.roll.total}</span>
            <span className="text-xs text-muted-foreground font-mono">{latest.expr}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {latest.roll.terms.map((t, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1">
                {t.rolls.length ? t.rolls.map((r, k) => (
                  <span key={k} className={cn('inline-flex size-8 items-center justify-center rounded-md border text-sm font-medium tabular-nums',
                    t.kept[k] ? 'border-border bg-card' : 'border-dashed border-border text-muted-foreground line-through')}>{r}</span>
                )) : <span className="text-sm font-mono text-muted-foreground">{t.text}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {history.length > 1 && (
        <div className="space-y-1.5">
          <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setHistory([])}><Trash2 /> Clear</Button>}>History</FieldLabel>
          <div className="rounded-md border border-border max-h-56 overflow-auto divide-y divide-border">
            {history.slice(1).map((h, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                <span className="w-10 font-semibold tabular-nums">{h.roll.total}</span>
                <span className="font-mono text-muted-foreground">{h.expr}</span>
                <span className="font-mono text-muted-foreground truncate">[{h.roll.terms.flatMap(t => t.rolls.map((r, k) => (t.kept[k] ? r : `~${r}~`))).join(', ')}]</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CoinTab() {
  const [n, setN] = useState(1);
  const [flips, setFlips] = useState<boolean[]>([]);
  const flip = () => setFlips(Array.from({ length: Math.max(1, Math.min(n || 1, 10000)) }, () => randomBelow(2) === 1));
  const heads = flips.filter(Boolean).length;
  let streak = 0, cur = 0;
  flips.forEach((f, i) => { cur = i && f === flips[i - 1] ? cur + 1 : 1; streak = Math.max(streak, cur); });

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2 flex-wrap">
        <NumberField label="Flips" value={n} onChange={setN} min={1} max={10000} className="w-28" />
        <Button onClick={flip}><Coins /> Flip</Button>
        {[1, 10, 100, 1000].map(k => <Button key={k} variant="ghost" size="xs" onClick={() => setN(k)}>{k}</Button>)}
      </div>
      {flips.length === 1 && (
        <div className="rounded-lg border border-border bg-secondary p-8 text-center">
          <div className={cn('mx-auto mb-3 flex size-24 items-center justify-center rounded-full border-4 text-3xl font-bold',
            flips[0] ? 'border-primary text-primary' : 'border-border text-muted-foreground')}>{flips[0] ? 'H' : 'T'}</div>
          <p className="text-2xl font-semibold">{flips[0] ? 'Heads' : 'Tails'}</p>
        </div>
      )}
      {flips.length > 1 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Heads" value={heads} hint={`${((heads / flips.length) * 100).toFixed(1)}%`} />
            <Stat label="Tails" value={flips.length - heads} hint={`${(((flips.length - heads) / flips.length) * 100).toFixed(1)}%`} />
            <Stat label="Flips" value={flips.length} />
            <Stat label="Longest streak" value={streak} />
          </div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-primary" style={{ width: `${(heads / flips.length) * 100}%` }} />
          </div>
          {flips.length <= 500 && <p className={cn(MONO, 'break-all text-muted-foreground')}>{flips.map(f => (f ? 'H' : 'T')).join('')}</p>}
        </>
      )}
    </div>
  );
}

function ListTab() {
  const [text, setText] = useState('Alice\nBob\nCharlie\nDiana\nEthan\nFatima\nGeorge\nHana');
  const [mode, setMode] = useState<'pick' | 'shuffle' | 'groups'>('pick');
  const [n, setN] = useState(1);
  const [unique, setUnique] = useState(true);
  const [dedupe, setDedupe] = useState(true);
  const [out, setOut] = useState<string[][] | null>(null);
  const items = useMemo(() => {
    const l = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return dedupe ? [...new Set(l)] : l;
  }, [text, dedupe]);

  const go = () => {
    if (!items.length) return setOut(null);
    if (mode === 'pick') setOut([pick(items, Math.max(1, n || 1), unique)]);
    else if (mode === 'shuffle') setOut([shuffle(items)]);
    else {
      const groups = Math.max(1, Math.min(n || 1, items.length));
      const s = shuffle(items);
      setOut(Array.from({ length: groups }, (_, g) => s.filter((_, i) => i % groups === g)));
    }
  };

  const result = out ? (out.length > 1 ? out.map((g, i) => `Group ${i + 1}: ${g.join(', ')}`).join('\n') : out[0].join('\n')) : '';

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <FieldLabel action={<span className="text-[11px] text-muted-foreground">{items.length} items</span>}>Items (one per line)</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-56')} value={text} onChange={e => setText(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={mode} onChange={v => { setMode(v); if (v === 'groups' && n < 2) setN(2); }} options={[{ value: 'pick', label: 'Pick' }, { value: 'shuffle', label: 'Shuffle' }, { value: 'groups', label: 'Split into groups' }]} />
          {mode !== 'shuffle' && <Input type="number" min={1} className="w-20" value={n} onChange={e => setN(Number(e.target.value))} title={mode === 'pick' ? 'How many' : 'Number of groups'} />}
          {mode === 'pick' && <Checkbox checked={unique} onChange={setUnique}>No repeats</Checkbox>}
          <Checkbox checked={dedupe} onChange={setDedupe}>Ignore duplicate lines</Checkbox>
        </div>
        <Button onClick={go} disabled={!items.length}><Shuffle /> {mode === 'pick' ? `Pick ${n || 1}` : mode === 'shuffle' ? 'Shuffle' : `Make ${n || 1} group${(n || 1) === 1 ? '' : 's'}`}</Button>
      </div>
      <div className="space-y-1.5 min-w-0">
        <FieldLabel action={<CopyButton value={result} label="Copy" />}>Result</FieldLabel>
        {out && out.length === 1 && mode === 'pick' && out[0].length === 1 ? (
          <div className="rounded-lg border border-border bg-secondary p-6 text-center text-2xl font-semibold break-all">{out[0][0]}</div>
        ) : out && out.length > 1 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {out.map((g, i) => (
              <div key={i} className="rounded-md border border-border p-2">
                <p className="text-xs font-medium mb-1">Group {i + 1} <span className="text-muted-foreground">({g.length})</span></p>
                <ul className="text-xs space-y-0.5">{g.map((x, k) => <li key={k} className="break-all">{x}</li>)}</ul>
              </div>
            ))}
          </div>
        ) : (
          <Textarea readOnly className={cn(MONO, FIXED, 'h-56 bg-secondary')} value={result} placeholder="Press the button to pick / shuffle." />
        )}
      </div>
    </div>
  );
}

// ── JWT generator ───────────────────────────────────────────────────────────

const JWT_ALGS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'] as const;
type JwtAlg = typeof JWT_ALGS[number];
const isHmac = (a: string) => a.startsWith('HS');

function keypairFor(alg: JwtAlg) {
  if (alg === 'EdDSA') return { type: 'ed25519' };
  if (alg.startsWith('ES')) return { type: 'ec', curve: { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' }[alg as 'ES256'] };
  return { type: 'rsa', bits: 2048 };
}

const now = () => Math.floor(Date.now() / 1000);

const JWT_TEMPLATES: Record<string, () => Record<string, unknown>> = {
  Basic: () => ({ sub: '1234567890', name: 'Jane Doe', iat: now(), exp: now() + 3600 }),
  'Access token': () => ({ iss: 'https://auth.example.com/', sub: 'user_42', aud: 'https://api.example.com', scope: 'read:items write:items', iat: now(), nbf: now(), exp: now() + 900, jti: crypto.randomUUID?.() ?? randomSecret(16) }),
  'ID token': () => ({ iss: 'https://auth.example.com/', sub: 'user_42', aud: 'my-client-id', email: 'jane@example.com', email_verified: true, name: 'Jane Doe', nonce: randomSecret(12), auth_time: now(), iat: now(), exp: now() + 3600 }),
  'Service / API': () => ({ iss: 'billing-service', sub: 'billing-service', aud: 'internal-api', role: 'service', iat: now(), exp: now() + 300 }),
};

function TokenView({ token }: { token: string }) {
  const [h, p, s] = token.split('.');
  return (
    <code className={cn(MONO, 'block break-all rounded-md border border-border bg-secondary p-3')}>
      <span className="text-destructive">{h}</span>.<span className="text-amber-600 dark:text-amber-400">{p}</span>.<span className="text-primary">{s}</span>
    </code>
  );
}

export function JwtGenerator() {
  const [tab, setTab] = useState('sign');
  const [alg, setAlg] = useState<JwtAlg>('HS256');
  const [header, setHeader] = useState('{\n  "typ": "JWT"\n}');
  const [payload, setPayload] = useState(() => JSON.stringify(JWT_TEMPLATES.Basic(), null, 2));
  const [secret, setSecret] = useState(() => randomSecret(32));
  const [secretEncoding, setSecretEncoding] = useState<'utf8' | 'base64' | 'hex'>('utf8');
  const [privateKey, setPrivateKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [genLoading, setGenLoading] = useState(false);
  const [signed, setSigned] = useState<{ token: string; warnings: string[]; header: any; payload: any } | null>(null);
  const [error, setError] = useState('');

  const jsonErr = (s: string) => { try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? '' : 'Must be a JSON object'; } catch (e) { return (e as Error).message; } };
  const headerErr = jsonErr(header);
  const payloadErr = jsonErr(payload);
  const needsKey = !isHmac(alg);
  const req = useDebounced(JSON.stringify({ alg, header, payload, secret, secretEncoding, privateKey, passphrase }), 350);

  useEffect(() => {
    const b = JSON.parse(req);
    if (jsonErr(b.header) || jsonErr(b.payload)) return;
    if (isHmac(b.alg) ? !b.secret : !b.privateKey.trim()) { setSigned(null); return; }
    let alive = true;
    toolsApi.post('/crypto/jwt/sign', isHmac(b.alg)
      ? { alg: b.alg, header: b.header, payload: b.payload, secret: b.secret, secretEncoding: b.secretEncoding }
      : { alg: b.alg, header: b.header, payload: b.payload, privateKeyPem: b.privateKey, passphrase: b.passphrase || undefined })
      .then(r => { if (alive) { setSigned(r); setError(''); } })
      .catch(e => { if (alive) { setSigned(null); setError((e as Error).message); } });
    return () => { alive = false; };
  }, [req]);

  const editClaims = (fn: (p: Record<string, any>) => void) => {
    try {
      const p = JSON.parse(payload);
      fn(p);
      setPayload(JSON.stringify(p, null, 2));
    } catch { /* invalid JSON — leave as is */ }
  };

  const generateKey = async () => {
    setGenLoading(true);
    setError('');
    try {
      const k = await toolsApi.post('/crypto/keypair', keypairFor(alg));
      setPrivateKey(k.privatePem);
      setPublicKey(k.publicPem);
      setPassphrase('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenLoading(false);
    }
  };

  // Switching between key families invalidates the key.
  const family = (a: string) => (a.startsWith('HS') ? 'h' : a.startsWith('ES') ? a : a === 'EdDSA' ? 'ed' : 'rsa');
  const prevAlg = useRef(alg);
  useEffect(() => {
    if (family(prevAlg.current) !== family(alg) && !isHmac(alg)) { setPrivateKey(''); setPublicKey(''); }
    prevAlg.current = alg;
  }, [alg]);

  return (
    <Tabs className="flex-col" value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger className={TAB_ACTIVE} value="sign">Sign</TabsTrigger>
        <TabsTrigger className={TAB_ACTIVE} value="verify">Verify</TabsTrigger>
      </TabsList>
      <TabsContent value="sign" className="pt-2">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 min-w-0">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <FieldLabel>Algorithm</FieldLabel>
                <SelectBox value={alg} onChange={setAlg} options={JWT_ALGS.map(a => ({ value: a, label: `${a}${a.startsWith('HS') ? ' · HMAC' : a.startsWith('RS') ? ' · RSA' : a.startsWith('PS') ? ' · RSA-PSS' : a.startsWith('ES') ? ' · ECDSA' : ' · Ed25519'}` }))} />
              </div>
              <div className="space-y-1.5">
                <FieldLabel>Template</FieldLabel>
                <SelectBox value="" onChange={v => v && setPayload(JSON.stringify(JWT_TEMPLATES[v](), null, 2))}
                  options={[{ value: '', label: 'Load a payload template…' }, ...Object.keys(JWT_TEMPLATES).map(k => ({ value: k, label: k }))]} />
              </div>
            </div>
            <div className="space-y-1.5">
              <FieldLabel action={headerErr ? <span className="text-[11px] text-destructive">{headerErr}</span> : <span className="text-[11px] text-muted-foreground">"alg" is set for you</span>}>Header</FieldLabel>
              <Textarea className={cn(MONO, FIXED, 'h-20')} value={header} onChange={e => setHeader(e.target.value)} spellCheck={false} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel action={payloadErr ? <span className="text-[11px] text-destructive">{payloadErr}</span> : null}>Payload</FieldLabel>
              <Textarea className={cn(MONO, FIXED, 'h-48')} value={payload} onChange={e => setPayload(e.target.value)} spellCheck={false} />
              <div className="flex flex-wrap gap-1">
                <Button variant="outline" size="xs" onClick={() => editClaims(p => { p.iat = now(); })}>iat = now</Button>
                <Button variant="outline" size="xs" onClick={() => editClaims(p => { p.nbf = now(); })}>nbf = now</Button>
                {[['15m', 900], ['1h', 3600], ['1d', 86400], ['7d', 604800], ['30d', 2592000]].map(([l, s]) => (
                  <Button key={l} variant="outline" size="xs" onClick={() => editClaims(p => { p.exp = now() + (s as number); })}>exp +{l}</Button>
                ))}
                <Button variant="outline" size="xs" onClick={() => editClaims(p => { p.exp = now() - 60; })}>expired</Button>
                <Button variant="outline" size="xs" onClick={() => editClaims(p => { p.jti = crypto.randomUUID?.() ?? randomSecret(16); })}>jti</Button>
                <Button variant="outline" size="xs" onClick={() => editClaims(p => { delete p.exp; delete p.nbf; })}>no expiry</Button>
              </div>
            </div>
            {!needsKey ? (
              <div className="space-y-1.5">
                <FieldLabel action={
                  <div className="flex items-center gap-1">
                    <SelectBox className="h-7 w-24" value={secretEncoding} onChange={setSecretEncoding} options={[{ value: 'utf8', label: 'UTF-8' }, { value: 'base64', label: 'Base64' }, { value: 'hex', label: 'Hex' }]} />
                    <Button variant="ghost" size="xs" onClick={() => { setSecret(randomSecret(Number(alg.slice(2)) / 8 + 16)); setSecretEncoding('utf8'); }}><Wand2 /> Random</Button>
                  </div>
                }>Secret</FieldLabel>
                <Input className={MONO} value={secret} onChange={e => setSecret(e.target.value)} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <FieldLabel action={
                  <Button variant="ghost" size="xs" disabled={genLoading} onClick={generateKey}>
                    {genLoading ? <Loader2 className="animate-spin" /> : <KeyRound />} Generate {keypairFor(alg).type.toUpperCase()} key pair
                  </Button>
                }>Private key (PEM)</FieldLabel>
                <Textarea className={cn(MONO, FIXED, 'h-32')} value={privateKey} onChange={e => setPrivateKey(e.target.value)} spellCheck={false} placeholder="-----BEGIN PRIVATE KEY-----" />
                {/ENCRYPTED/.test(privateKey) && <Input type="password" placeholder="Key passphrase" value={passphrase} onChange={e => setPassphrase(e.target.value)} />}
              </div>
            )}
          </div>
          <div className="space-y-3 min-w-0">
            {error && <ErrorBox message={error} />}
            {signed ? (
              <>
                <div className="space-y-1.5">
                  <FieldLabel action={
                    <div className="flex gap-1">
                      <CopyButton value={signed.token} label="Copy" />
                      <CopyButton value={`Authorization: Bearer ${signed.token}`} label="Header" />
                      <Button variant="ghost" size="xs" onClick={() => setTab('verify')}>Verify <ArrowRight /></Button>
                    </div>
                  }>Token <span className="font-normal">({signed.token.length} chars)</span></FieldLabel>
                  <TokenView token={signed.token} />
                </div>
                {signed.warnings.map((w, i) => <div key={i} className={cn('flex gap-2 rounded-md border px-3 py-2 text-xs', TINT.warn)}><AlertTriangle className="size-4 shrink-0 text-amber-500" />{w}</div>)}
                <div className="grid gap-3 sm:grid-cols-2">
                  <CodeBlock label="Decoded header" value={JSON.stringify(signed.header, null, 2)} rows={4} />
                  <CodeBlock label="Decoded payload" value={JSON.stringify(signed.payload, null, 2)} rows={4} />
                </div>
                {['iat', 'nbf', 'exp'].filter(k => typeof signed.payload[k] === 'number').map(k => (
                  <p key={k} className="text-[11px] text-muted-foreground"><code>{k}</code> {new Date(signed.payload[k] * 1000).toLocaleString()}</p>
                ))}
                {needsKey && publicKey && <CodeBlock label="Public key (for verifiers)" value={publicKey} filename="public.pem" rows={5} />}
              </>
            ) : !error && (
              <InfoBox>{needsKey ? 'Paste a private key or generate a key pair to sign.' : 'Enter a secret to sign.'}</InfoBox>
            )}
          </div>
        </div>
      </TabsContent>
      <TabsContent value="verify" className="pt-2">
        <JwtVerify initialToken={signed?.token ?? ''} initialSecret={isHmac(alg) ? secret : ''} initialSecretEncoding={secretEncoding} initialKey={publicKey} />
      </TabsContent>
    </Tabs>
  );
}

function JwtVerify({ initialToken, initialSecret, initialSecretEncoding, initialKey }: { initialToken: string; initialSecret: string; initialSecretEncoding: string; initialKey: string }) {
  const [token, setToken] = useState(initialToken);
  const [secret, setSecret] = useState(initialSecret);
  const [secretEncoding, setSecretEncoding] = useState(initialSecretEncoding);
  const [key, setKey] = useState(initialKey);
  const [leeway, setLeeway] = useState(0);
  const [issuer, setIssuer] = useState('');
  const [audience, setAudience] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const alg = useMemo(() => {
    try { return String(JSON.parse(atob(token.trim().replace(/^Bearer\s+/i, '').split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).alg || ''); } catch { return ''; }
  }, [token]);
  const hmac = alg.startsWith('HS');

  const verify = async () => {
    setLoading(true);
    setError('');
    try {
      setResult(await toolsApi.post('/crypto/jwt/verify', {
        token, leewaySeconds: leeway, issuer: issuer || undefined, audience: audience || undefined,
        ...(hmac ? { secret, secretEncoding } : { publicKeyPem: key }),
      }));
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3 min-w-0">
        <div className="space-y-1.5">
          <FieldLabel action={alg ? <Badge variant="secondary">alg: {alg}</Badge> : null}>Token</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-28 break-all')} value={token} onChange={e => setToken(e.target.value)} placeholder="eyJhbGciOi…" spellCheck={false} />
        </div>
        {hmac || !alg ? (
          <div className="space-y-1.5">
            <FieldLabel action={<SelectBox className="h-7 w-24" value={secretEncoding} onChange={setSecretEncoding} options={[{ value: 'utf8', label: 'UTF-8' }, { value: 'base64', label: 'Base64' }, { value: 'hex', label: 'Hex' }]} />}>Secret</FieldLabel>
            <Input className={MONO} value={secret} onChange={e => setSecret(e.target.value)} />
          </div>
        ) : (
          <div className="space-y-1.5">
            <FieldLabel>Public key (PEM, JWK, or certificate)</FieldLabel>
            <Textarea className={cn(MONO, FIXED, 'h-32')} value={key} onChange={e => setKey(e.target.value)} placeholder="-----BEGIN PUBLIC KEY-----" spellCheck={false} />
          </div>
        )}
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
          <NumberField label="Clock leeway (s)" value={leeway} onChange={setLeeway} min={0} max={86400} />
          <div className="space-y-1.5"><FieldLabel>Expected iss</FieldLabel><Input value={issuer} onChange={e => setIssuer(e.target.value)} placeholder="optional" /></div>
          <div className="space-y-1.5"><FieldLabel>Expected aud</FieldLabel><Input value={audience} onChange={e => setAudience(e.target.value)} placeholder="optional" /></div>
        </div>
        <Button onClick={verify} disabled={!token.trim() || loading}>{loading ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify</Button>
      </div>
      <div className="space-y-3 min-w-0">
        {error && <ErrorBox message={error} />}
        {result && (
          <>
            <div className={cn('flex items-center gap-3 rounded-lg border p-4', result.valid ? TINT.ok : TINT.bad)}>
              {result.valid ? <CircleCheck className="size-8 text-primary" /> : <CircleX className="size-8 text-destructive" />}
              <div>
                <p className="font-semibold">{result.valid ? 'Valid token' : 'Invalid token'}</p>
                <p className="text-xs text-muted-foreground">Signature {result.signatureValid ? 'verified' : 'NOT verified'} · {result.alg}</p>
              </div>
            </div>
            {result.errors.map((e: string, i: number) => <div key={i} className="flex gap-2 text-xs text-destructive"><CircleX className="size-4 shrink-0" />{e}</div>)}
            {result.warnings.map((w: string, i: number) => <div key={i} className="flex gap-2 text-xs"><AlertTriangle className="size-4 shrink-0 text-amber-500" />{w}</div>)}
            {Object.keys(result.claims).length > 0 && (
              <div className="rounded-md border border-border px-3">
                {Object.entries(result.claims as Record<string, { date: string; ok: boolean; note: string }>).map(([k, c]) => (
                  <div key={k} className="flex flex-wrap items-center gap-2 py-1.5 border-b border-border last:border-0 text-xs">
                    <code className="w-10">{k}</code>
                    <span className="flex-1 min-w-0">{new Date(c.date).toLocaleString()}</span>
                    <span className={c.ok ? 'text-muted-foreground' : 'text-destructive'}>{c.note}</span>
                  </div>
                ))}
              </div>
            )}
            {result.payload && <CodeBlock label="Payload" value={JSON.stringify(result.payload, null, 2)} rows={8} />}
          </>
        )}
      </div>
    </div>
  );
}

// ── Bcrypt ──────────────────────────────────────────────────────────────────

export function BcryptTool() {
  const [tab, setTab] = useState('hash');
  const [password, setPassword] = useState('correct horse battery staple');
  const [cost, setCost] = useState(10);
  const [hash, setHash] = useState<{ hash: string; ms: number; rounds: number; warnings: string[] } | null>(null);
  const [timing, setTiming] = useState<{ cost: number; ms: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [vPassword, setVPassword] = useState('');
  const [vHash, setVHash] = useState('');
  const [verify, setVerify] = useState<any>(null);
  const [vError, setVError] = useState('');
  const [vLoading, setVLoading] = useState(false);

  const estimate = timing ? timing.ms * 2 ** (cost - timing.cost) : null;

  const doHash = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await toolsApi.post('/crypto/bcrypt/hash', { password, rounds: cost });
      setHash(r);
      setTiming({ cost: r.rounds, ms: Math.max(r.ms, 1) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const doVerify = async () => {
    setVLoading(true);
    setVError('');
    try {
      setVerify(await toolsApi.post('/crypto/bcrypt/verify', { password: vPassword, hash: vHash }));
    } catch (e) {
      setVerify(null);
      setVError((e as Error).message);
    } finally {
      setVLoading(false);
    }
  };

  const parts = hash ? /^(\$2[abxy]\$)(\d{2})(\$)(.{22})(.{31})$/.exec(hash.hash) : null;

  return (
    <Tabs className="flex-col" value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger className={TAB_ACTIVE} value="hash">Hash</TabsTrigger>
        <TabsTrigger className={TAB_ACTIVE} value="verify">Verify</TabsTrigger>
      </TabsList>
      <TabsContent value="hash" className="pt-2 space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <FieldLabel action={<span className={cn('text-[11px]', new TextEncoder().encode(password).length > 72 ? 'text-destructive' : 'text-muted-foreground')}>{new TextEncoder().encode(password).length} / 72 bytes</span>}>Password</FieldLabel>
              <Input className="font-mono" value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel action={<span className="text-xs tabular-nums">cost {cost} · 2^{cost} = {(2 ** cost).toLocaleString()} rounds</span>}>Cost factor</FieldLabel>
              <Slider value={cost} min={4} max={15} onChange={setCost} />
              <p className="text-[11px] text-muted-foreground">
                {estimate !== null ? `Estimated ≈ ${estimate < 1000 ? `${Math.round(estimate)} ms` : `${(estimate / 1000).toFixed(1)} s`} on this server (each +1 doubles the work). ` : 'Each +1 doubles the work. '}
                OWASP recommends ≥ 10; aim for ~250 ms–1 s per hash.
              </p>
            </div>
            <Button onClick={doHash} disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : <ShieldCheck />} {loading ? 'Hashing…' : 'Generate hash'}</Button>
            {error && <ErrorBox message={error} />}
          </div>
          <div className="space-y-3 min-w-0">
            {hash ? (
              <>
                <div className="space-y-1.5">
                  <FieldLabel action={
                    <div className="flex gap-1">
                      <CopyButton value={hash.hash} label="Copy" />
                      <Button variant="ghost" size="xs" onClick={() => { setVHash(hash.hash); setVPassword(password); setVerify(null); setTab('verify'); }}>Verify <ArrowRight /></Button>
                    </div>
                  }>Hash</FieldLabel>
                  <code className={cn(MONO, 'block break-all rounded-md border border-border bg-secondary p-3 text-sm')}>
                    {parts ? <><span className="text-muted-foreground">{parts[1]}</span><span className="text-amber-600 dark:text-amber-400">{parts[2]}</span><span className="text-muted-foreground">{parts[3]}</span><span className="text-primary">{parts[4]}</span><span>{parts[5]}</span></> : hash.hash}
                  </code>
                  <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                    <span><span className="text-amber-600 dark:text-amber-400">■</span> cost</span>
                    <span><span className="text-primary">■</span> salt (22 chars, 128 bits)</span>
                    <span>■ hash (31 chars)</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Time" value={`${hash.ms} ms`} />
                  <Stat label="Cost" value={hash.rounds} />
                </div>
                {hash.warnings.map((w, i) => <div key={i} className={cn('flex gap-2 rounded-md border px-3 py-2 text-xs', TINT.warn)}><AlertTriangle className="size-4 shrink-0 text-amber-500" />{w}</div>)}
              </>
            ) : <InfoBox>Hashes are computed on the server with bcryptjs. A new random salt is used every time, so the same password gives a different hash on each run.</InfoBox>}
          </div>
        </div>
      </TabsContent>
      <TabsContent value="verify" className="pt-2">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <FieldLabel>Password</FieldLabel>
              <Input className="font-mono" value={vPassword} onChange={e => setVPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>Bcrypt hash</FieldLabel>
              <Input className={MONO} value={vHash} onChange={e => setVHash(e.target.value)} placeholder="$2b$10$…" />
              <p className="text-[11px] text-muted-foreground">Accepts $2a$, $2b$ and PHP's $2y$ hashes.</p>
            </div>
            <Button onClick={doVerify} disabled={vLoading || !vHash}>{vLoading ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify</Button>
          </div>
          <div className="space-y-3 min-w-0">
            {vError && <ErrorBox message={vError} />}
            {verify && (
              <>
                <div className={cn('flex items-center gap-3 rounded-lg border p-4', verify.match ? TINT.ok : TINT.bad)}>
                  {verify.match ? <CircleCheck className="size-8 text-primary" /> : <CircleX className="size-8 text-destructive" />}
                  <div>
                    <p className="font-semibold">{verify.match ? 'Password matches' : 'Does not match'}</p>
                    <p className="text-xs text-muted-foreground">Checked in {verify.ms} ms</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <Stat label="Version" value={`$${verify.info.version}$`} />
                  <Stat label="Cost" value={verify.info.cost} hint={`${(2 ** verify.info.cost).toLocaleString()} rounds`} />
                  <Stat label="Salt" value={<span className="font-mono text-xs">{verify.info.salt}</span>} />
                </div>
                {verify.warnings.map((w: string, i: number) => <p key={i} className="text-xs text-muted-foreground">{w}</p>)}
              </>
            )}
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}

// ── RSA / EC / Ed25519 key generator ────────────────────────────────────────

interface KeyResult {
  type: string; keyType: string; bits?: number; curve?: string; encrypted: boolean; ms: number;
  privatePem: string; publicPem: string; sshPublic: string; sshPrivate: string | null; fingerprint: string; fingerprintMd5: string;
  pkcs1Private?: string; pkcs1Public?: string; sec1Private?: string; jwk: { public: any; private: any | null };
}

export function RsaKeyGenerator() {
  const [type, setType] = useState<'rsa' | 'ec' | 'ed25519'>('ed25519');
  const [bits, setBits] = useState('3072');
  const [curve, setCurve] = useState('P-256');
  const [comment, setComment] = useState('user@example.com');
  const [passphrase, setPassphrase] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [privFormat, setPrivFormat] = useState<'pkcs8' | 'legacy' | 'openssh'>('openssh');
  const [key, setKey] = useState<KeyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const generate = async () => {
    setLoading(true);
    setError('');
    try {
      const k = await toolsApi.post<KeyResult>('/crypto/keypair', { type, bits: Number(bits), curve, comment, passphrase: passphrase || undefined });
      setKey(k);
      if (k.encrypted && privFormat === 'openssh') setPrivFormat('pkcs8');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const base = key ? (key.type === 'ed25519' ? 'id_ed25519' : key.type === 'ec' ? 'id_ecdsa' : 'id_rsa') : 'id_key';
  const privValue = !key ? '' : privFormat === 'openssh' ? key.sshPrivate ?? '' : privFormat === 'legacy' ? key.pkcs1Private ?? key.sec1Private ?? '' : key.privatePem;
  const legacyLabel = key?.type === 'rsa' ? 'PKCS#1 (RSA)' : 'SEC1 (EC)';

  return (
    <div className="space-y-4">
      <Card size="sm">
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <FieldLabel>Key type</FieldLabel>
              <Segmented value={type} onChange={setType} options={[{ value: 'ed25519', label: 'Ed25519' }, { value: 'ec', label: 'ECDSA' }, { value: 'rsa', label: 'RSA' }]} />
            </div>
            {type === 'rsa' && (
              <div className="space-y-1.5 w-36">
                <FieldLabel>Key size</FieldLabel>
                <SelectBox value={bits} onChange={setBits} options={[{ value: '2048', label: '2048 bits' }, { value: '3072', label: '3072 bits' }, { value: '4096', label: '4096 bits (slow)' }]} />
              </div>
            )}
            {type === 'ec' && (
              <div className="space-y-1.5 w-36">
                <FieldLabel>Curve</FieldLabel>
                <SelectBox value={curve} onChange={setCurve} options={[{ value: 'P-256', label: 'P-256 (ES256)' }, { value: 'P-384', label: 'P-384 (ES384)' }, { value: 'P-521', label: 'P-521 (ES512)' }]} />
              </div>
            )}
            <div className="space-y-1.5 flex-1 min-w-40">
              <FieldLabel>Comment</FieldLabel>
              <Input value={comment} onChange={e => setComment(e.target.value)} placeholder="user@host" />
            </div>
            <div className="space-y-1.5 flex-1 min-w-40">
              <FieldLabel>Passphrase (optional)</FieldLabel>
              <div className="flex gap-1">
                <Input type={showPass ? 'text' : 'password'} value={passphrase} onChange={e => setPassphrase(e.target.value)} placeholder="Encrypts the PEM private key" autoComplete="new-password" />
                <Button variant="ghost" size="icon" onClick={() => setShowPass(s => !s)}>{showPass ? <EyeOff /> : <Eye />}</Button>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={generate} disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : <KeyRound />} {loading ? 'Generating…' : 'Generate key pair'}</Button>
            <span className="text-[11px] text-muted-foreground">
              {type === 'ed25519' ? 'Ed25519: small, fast, recommended for SSH.' : type === 'ec' ? 'ECDSA: widely supported (TLS, JWT ES*).' : 'RSA: maximum compatibility; 3072+ bits recommended.'}
            </span>
          </div>
        </CardContent>
      </Card>
      {error && <ErrorBox message={error} />}
      {key && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Algorithm" value={key.keyType?.toUpperCase()} hint={key.bits ? `${key.bits} bits` : key.curve} />
            <Stat label="Generated in" value={`${key.ms} ms`} />
            <Stat label="Private key" value={key.encrypted ? 'Encrypted' : 'Unencrypted'} hint={key.encrypted ? 'AES-256-CBC (PKCS#8)' : 'protect the file'} />
            <Stat label="JWK kid" value={<span className="font-mono text-xs">{String(key.jwk.public.kid).slice(0, 16)}…</span>} />
          </div>
          <div className="rounded-md border border-border px-3">
            <div className="flex items-center gap-2 py-1.5 border-b border-border"><span className="w-28 shrink-0 text-xs text-muted-foreground">Fingerprint</span><code className={cn(MONO, 'flex-1 min-w-0 break-all')}>{key.fingerprint}</code><CopyButton value={key.fingerprint} /></div>
            <div className="flex items-center gap-2 py-1.5"><span className="w-28 shrink-0 text-xs text-muted-foreground">MD5 (legacy)</span><code className={cn(MONO, 'flex-1 min-w-0 break-all')}>{key.fingerprintMd5}</code><CopyButton value={key.fingerprintMd5} /></div>
          </div>
          <CodeBlock label="OpenSSH public key (authorized_keys)" value={key.sshPublic} filename={`${base}.pub`} rows={3}
            hint={<>Append to <code>~/.ssh/authorized_keys</code> on the server, or paste into GitHub → Settings → SSH keys.</>} />
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Private key format</span>
                <Segmented value={privFormat} onChange={setPrivFormat} options={[
                  ...(key.sshPrivate ? [{ value: 'openssh' as const, label: 'OpenSSH' }] : []),
                  { value: 'pkcs8' as const, label: 'PKCS#8' },
                  ...(key.pkcs1Private || key.sec1Private ? [{ value: 'legacy' as const, label: legacyLabel }] : []),
                ]} />
              </div>
              <CodeBlock label="Private key — keep secret" value={privValue} filename={privFormat === 'openssh' ? base : `${base}.${privFormat === 'pkcs8' ? 'key' : 'pem'}`} rows={10}
                hint={privFormat === 'openssh'
                  ? <>Save as <code>~/.ssh/{base}</code> and run <code>chmod 600 ~/.ssh/{base}</code>. Add a passphrase later with <code>ssh-keygen -p -f ~/.ssh/{base}</code>.</>
                  : key.encrypted ? 'Encrypted with your passphrase.' : 'PEM encoding for OpenSSL, TLS servers and JWT libraries.'} />
            </div>
            <CodeBlock label="Public key (SPKI PEM)" value={key.publicPem} filename={`${base}.pub.pem`} rows={10} />
          </div>
          {key.pkcs1Public && <CodeBlock label="Public key (PKCS#1)" value={key.pkcs1Public} filename={`${base}.pkcs1.pub.pem`} rows={6} />}
          <div className="grid gap-4 lg:grid-cols-2">
            <CodeBlock label="Public JWK" value={JSON.stringify(key.jwk.public, null, 2)} filename="public.jwk.json" rows={8} />
            {key.jwk.private
              ? <CodeBlock label="Private JWK — keep secret" value={JSON.stringify(key.jwk.private, null, 2)} filename="private.jwk.json" rows={8} />
              : <InfoBox>Private JWK and OpenSSH private formats are only produced for unencrypted keys.</InfoBox>}
          </div>
          <CodeBlock label="JWKS (for /.well-known/jwks.json)" value={JSON.stringify({ keys: [key.jwk.public] }, null, 2)} filename="jwks.json" rows={6} />
          <InfoBox>Keys are generated on the server with Node's crypto module and are not stored. For long-lived production keys, prefer generating them on the machine that will use them (<code>ssh-keygen -t ed25519</code>).</InfoBox>
        </div>
      )}
    </div>
  );
}

