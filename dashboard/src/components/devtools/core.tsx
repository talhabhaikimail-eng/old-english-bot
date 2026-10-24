import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { MONO, CopyButton, ErrorBox, FieldLabel, OutputRow, Segmented } from './shared';

// The original Dev Tools set. Everything here runs in the browser — nothing is sent to the
// backend, so it's safe to paste tokens / secrets into these.

// ---------- byte helpers ----------

export const utf8ToBytes = (s: string) => new TextEncoder().encode(s);
export const bytesToUtf8 = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b);

export function bytesToBase64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string) {
  let s = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

// ---------- JSON ----------

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object).sort().map(k => [k, sortKeysDeep((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function JsonTool() {
  const [input, setInput] = useState('{"hello":"world","items":[1,2,3],"nested":{"b":true,"a":null}}');
  const [indent, setIndent] = useState<'2' | '4' | 'tab' | 'min'>('2');
  const [sortKeys, setSortKeys] = useState(false);

  const result = useMemo(() => {
    if (!input.trim()) return { output: '', error: '' };
    try {
      let parsed = JSON.parse(input);
      if (sortKeys) parsed = sortKeysDeep(parsed);
      const space = indent === 'min' ? undefined : indent === 'tab' ? '\t' : Number(indent);
      return { output: JSON.stringify(parsed, null, space), error: '' };
    } catch (e) {
      const msg = (e as Error).message;
      // Translate "at position N" into line/column so errors are findable in big payloads.
      const pos = /position (\d+)/.exec(msg);
      if (pos) {
        const before = input.slice(0, Number(pos[1]));
        const line = before.split('\n').length;
        const col = before.length - before.lastIndexOf('\n');
        return { output: '', error: `${msg} (line ${line}, column ${col})` };
      }
      return { output: '', error: msg };
    }
  }, [input, indent, sortKeys]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={indent}
          onChange={setIndent}
          options={[
            { value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' },
            { value: 'tab', label: 'Tab' }, { value: 'min', label: 'Minify' },
          ]}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={sortKeys} onChange={e => setSortKeys(e.target.checked)} />
          Sort keys
        </label>
        {input.trim() && (
          result.error
            ? <Badge variant="destructive">Invalid</Badge>
            : <Badge>Valid JSON</Badge>
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setInput('')}>Clear</Button>}>Input</FieldLabel>
          <Textarea className={cn(MONO, 'h-80 field-sizing-fixed')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel action={<CopyButton value={result.output} label="Copy" />}>Output</FieldLabel>
          {result.error
            ? <ErrorBox message={result.error} />
            : <Textarea readOnly className={cn(MONO, 'h-80 field-sizing-fixed bg-secondary/40')} value={result.output} />}
        </div>
      </div>
    </div>
  );
}

// ---------- Base64 ----------

export function Base64Tool() {
  const [mode, setMode] = useState<'encode' | 'decode'>('encode');
  const [urlSafe, setUrlSafe] = useState(false);
  const [input, setInput] = useState('');

  const result = useMemo(() => {
    if (!input) return { output: '', error: '' };
    try {
      if (mode === 'encode') {
        let out = bytesToBase64(utf8ToBytes(input));
        if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return { output: out, error: '' };
      }
      const bytes = base64ToBytes(input);
      try {
        return { output: bytesToUtf8(bytes), error: '' };
      } catch {
        return { output: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' '), error: 'Decoded bytes are not valid UTF-8 — showing hex instead.' };
      }
    } catch {
      return { output: '', error: 'Input is not valid Base64.' };
    }
  }, [input, mode, urlSafe]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'encode', label: 'Encode' }, { value: 'decode', label: 'Decode' }]} />
        {mode === 'encode' && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={urlSafe} onChange={e => setUrlSafe(e.target.checked)} />
            URL-safe (base64url)
          </label>
        )}
        <Button variant="outline" size="sm" disabled={!result.output || !!result.error} onClick={() => { setInput(result.output); setMode(mode === 'encode' ? 'decode' : 'encode'); }}>
          <RefreshCw /> Swap
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>{mode === 'encode' ? 'Plain text' : 'Base64'}</FieldLabel>
          <Textarea className={cn(MONO, 'h-56 field-sizing-fixed')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel action={<CopyButton value={result.output} label="Copy" />}>{mode === 'encode' ? 'Base64' : 'Plain text'}</FieldLabel>
          <Textarea readOnly className={cn(MONO, 'h-56 field-sizing-fixed bg-secondary/40')} value={result.output} />
          {result.error && <ErrorBox message={result.error} />}
        </div>
      </div>
    </div>
  );
}

// ---------- URL ----------

export function UrlTool() {
  const [text, setText] = useState('');
  const [url, setUrl] = useState('https://example.com:8080/path/to/page?q=hello%20world&lang=en&tag=a&tag=b#section');

  const encoded = useMemo(() => encodeURIComponent(text), [text]);
  const decoded = useMemo(() => {
    try { return { v: decodeURIComponent(text.replace(/\+/g, ' ')), err: '' }; } catch { return { v: '', err: 'Malformed percent-encoding.' }; }
  }, [text]);

  const parsed = useMemo(() => {
    if (!url.trim()) return null;
    try { return new URL(url.trim()); } catch { return undefined; }
  }, [url]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Encode / decode</CardTitle>
          <CardDescription className="text-xs">Percent-encoding for query values and path segments.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea className={cn(MONO, 'h-28 field-sizing-fixed')} placeholder="Text or encoded string…" value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
          <OutputRow label="Encoded" value={encoded} />
          <OutputRow label="Decoded" value={decoded.v} />
          {decoded.err && text && <ErrorBox message={decoded.err} />}
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">URL parser</CardTitle>
          <CardDescription className="text-xs">Break a URL into its parts and query parameters.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input className={MONO} value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} />
          {parsed === undefined && <ErrorBox message="Not a valid absolute URL." />}
          {parsed && (
            <>
              <div>
                <OutputRow label="Protocol" value={parsed.protocol} />
                <OutputRow label="Host" value={parsed.hostname} />
                <OutputRow label="Port" value={parsed.port} />
                <OutputRow label="Path" value={parsed.pathname} />
                <OutputRow label="Hash" value={parsed.hash} />
                <OutputRow label="Origin" value={parsed.origin} />
              </div>
              {[...parsed.searchParams].length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Query parameters</p>
                  <div className="rounded-md border border-border px-2">
                    {[...parsed.searchParams].map(([k, v], i) => <OutputRow key={i} label={k} value={v} />)}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- JWT ----------

export function JwtTool() {
  const [token, setToken] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const decoded = useMemo(() => {
    const t = token.trim().replace(/^Bearer\s+/i, '');
    if (!t) return null;
    const parts = t.split('.');
    if (parts.length !== 3) return { error: `Expected 3 dot-separated segments, got ${parts.length}.` };
    try {
      const header = JSON.parse(bytesToUtf8(base64ToBytes(parts[0])));
      const payload = JSON.parse(bytesToUtf8(base64ToBytes(parts[1])));
      return { header, payload, signature: parts[2] };
    } catch (e) {
      return { error: `Could not decode token: ${(e as Error).message}` };
    }
  }, [token]);

  const claimDate = (v: unknown) => typeof v === 'number' ? new Date(v * 1000) : null;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel>Token</FieldLabel>
        <Textarea className={cn(MONO, 'h-24 field-sizing-fixed break-all')} placeholder="eyJhbGciOi… (a leading “Bearer ” is stripped)" value={token} onChange={e => setToken(e.target.value)} spellCheck={false} />
        <p className="text-[11px] text-muted-foreground">Decoded locally. The signature is <b>not</b> verified.</p>
      </div>
      {decoded && 'error' in decoded && <ErrorBox message={decoded.error!} />}
      {decoded && 'payload' in decoded && (
        <>
          <div className="flex flex-wrap gap-2">
            {(() => {
              const exp = claimDate(decoded.payload.exp);
              if (!exp) return <Badge variant="secondary">No expiry</Badge>;
              const expired = exp.getTime() < now;
              const mins = Math.round(Math.abs(exp.getTime() - now) / 60000);
              return expired
                ? <Badge variant="destructive">Expired {mins} min ago</Badge>
                : <Badge>Valid for {mins} more min</Badge>;
            })()}
            {decoded.header.alg && <Badge variant="secondary">alg: {String(decoded.header.alg)}</Badge>}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel action={<CopyButton value={JSON.stringify(decoded.header, null, 2)} />}>Header</FieldLabel>
              <pre className={cn(MONO, 'rounded-md border border-border bg-secondary/40 p-3 overflow-auto max-h-80')}>{JSON.stringify(decoded.header, null, 2)}</pre>
            </div>
            <div className="space-y-1.5">
              <FieldLabel action={<CopyButton value={JSON.stringify(decoded.payload, null, 2)} />}>Payload</FieldLabel>
              <pre className={cn(MONO, 'rounded-md border border-border bg-secondary/40 p-3 overflow-auto max-h-80')}>{JSON.stringify(decoded.payload, null, 2)}</pre>
            </div>
          </div>
          <div className="rounded-md border border-border px-3">
            {(['iat', 'nbf', 'exp'] as const).map(k => {
              const d = claimDate(decoded.payload[k]);
              return d ? <OutputRow key={k} label={k} value={`${d.toLocaleString()}  (${d.toISOString()})`} /> : null;
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Hash ----------

const HASH_ALGOS = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const;

export function HashTool() {
  const [input, setInput] = useState('');
  const [hmacKey, setHmacKey] = useState('');
  const [hashes, setHashes] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = utf8ToBytes(input);
      const entries = await Promise.all(HASH_ALGOS.map(async algo => {
        if (hmacKey) {
          const key = await crypto.subtle.importKey('raw', utf8ToBytes(hmacKey), { name: 'HMAC', hash: algo }, false, ['sign']);
          return [algo, toHex(await crypto.subtle.sign('HMAC', key, data))] as const;
        }
        return [algo, toHex(await crypto.subtle.digest(algo, data))] as const;
      }));
      if (!cancelled) setHashes(Object.fromEntries(entries));
    })().catch(() => { if (!cancelled) setHashes({}); });
    return () => { cancelled = true; };
  }, [input, hmacKey]);

  if (!window.crypto?.subtle) {
    return <ErrorBox message="Web Crypto is only available over HTTPS or localhost." />;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel>Input text</FieldLabel>
        <Textarea className={cn(MONO, 'h-32 field-sizing-fixed')} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} />
      </div>
      <div className="space-y-1.5 max-w-md">
        <FieldLabel>HMAC secret (optional)</FieldLabel>
        <Input className={MONO} placeholder="Leave empty for a plain digest" value={hmacKey} onChange={e => setHmacKey(e.target.value)} />
      </div>
      <div className="rounded-md border border-border px-3">
        {HASH_ALGOS.map(a => <OutputRow key={a} label={hmacKey ? `HMAC-${a}` : a} value={hashes[a] ?? ''} />)}
      </div>
    </div>
  );
}

// ---------- UUID / random ----------

const CHARSETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/',
};

function randomString(length: number, charset: string) {
  // Rejection sampling avoids modulo bias.
  const out: string[] = [];
  const limit = 256 - (256 % charset.length);
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit) out.push(charset[b % charset.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

function uuidV4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function RandomTool() {
  const [count, setCount] = useState(5);
  const [upper, setUpper] = useState(false);
  const [uuids, setUuids] = useState<string[]>([]);
  const [length, setLength] = useState(32);
  const [sets, setSets] = useState({ lower: true, upper: true, digits: true, symbols: false });
  const [secret, setSecret] = useState('');

  const charset = (Object.keys(sets) as (keyof typeof sets)[]).filter(k => sets[k]).map(k => CHARSETS[k]).join('');
  const genUuids = () => setUuids(Array.from({ length: Math.min(Math.max(count, 1), 500) }, uuidV4));
  const genSecret = () => setSecret(charset ? randomString(Math.min(Math.max(length, 1), 4096), charset) : '');

  useEffect(genUuids, [count]);
  useEffect(genSecret, [length, charset]);

  const uuidText = uuids.map(u => upper ? u.toUpperCase() : u).join('\n');

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">UUID v4</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input type="number" min={1} max={500} className="w-20" value={count} onChange={e => setCount(Number(e.target.value) || 1)} />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={upper} onChange={e => setUpper(e.target.checked)} /> Uppercase
            </label>
            <Button size="sm" variant="outline" onClick={genUuids}><RefreshCw /> Regenerate</Button>
            <CopyButton value={uuidText} label="Copy all" />
          </div>
          <Textarea readOnly className={cn(MONO, 'h-56 field-sizing-fixed bg-secondary/40')} value={uuidText} />
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Random secret / password</CardTitle>
          <CardDescription className="text-xs">Generated with crypto.getRandomValues.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Length
              <Input type="number" min={1} max={4096} className="w-20" value={length} onChange={e => setLength(Number(e.target.value) || 1)} />
            </label>
            {(Object.keys(sets) as (keyof typeof sets)[]).map(k => (
              <label key={k} className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer capitalize">
                <input type="checkbox" checked={sets[k]} onChange={e => setSets(s => ({ ...s, [k]: e.target.checked }))} /> {k}
              </label>
            ))}
          </div>
          <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 p-3">
            <code className={cn(MONO, 'flex-1 break-all')}>{secret || 'Select at least one character set.'}</code>
            <Button variant="ghost" size="icon-xs" title="Regenerate" onClick={genSecret}><RefreshCw /></Button>
            <CopyButton value={secret} />
          </div>
          {secret && (
            <p className="text-[11px] text-muted-foreground">
              ≈ {Math.floor(secret.length * Math.log2(charset.length))} bits of entropy
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Timestamp ----------

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function relativeTime(d: Date, now: number) {
  const diff = (d.getTime() - now) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs || unit === 'second') return rtf.format(Math.round(diff / secs), unit);
  }
  return '';
}

export function TimestampTool() {
  const [now, setNow] = useState(() => Date.now());
  const [input, setInput] = useState(() => String(Math.floor(Date.now() / 1000)));
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const parsed = useMemo(() => {
    const s = input.trim();
    if (!s) return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      // Heuristic: 13+ digit values are milliseconds, otherwise seconds.
      const isMs = Math.abs(n) >= 1e11;
      return { date: new Date(isMs ? n : n * 1000), unit: isMs ? 'milliseconds' : 'seconds' };
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : { date: d, unit: 'date string' };
  }, [input]);

  const valid = parsed && !isNaN(parsed.date.getTime());

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-secondary/40 p-3">
          <p className="text-[11px] text-muted-foreground">Now (seconds)</p>
          <div className="flex items-center justify-between">
            <code className="font-mono text-lg tabular-nums">{Math.floor(now / 1000)}</code>
            <CopyButton value={String(Math.floor(now / 1000))} />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-secondary/40 p-3">
          <p className="text-[11px] text-muted-foreground">Now (milliseconds)</p>
          <div className="flex items-center justify-between">
            <code className="font-mono text-lg tabular-nums">{now}</code>
            <CopyButton value={String(now)} />
          </div>
        </div>
      </div>
      <div className="space-y-1.5 max-w-xl">
        <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>Use now</Button>}>
          Epoch (s / ms) or any date string
        </FieldLabel>
        <Input className={MONO} value={input} onChange={e => setInput(e.target.value)} placeholder="1735689600, 2025-01-01T00:00:00Z, Jan 1 2025…" />
      </div>
      {parsed === undefined && <ErrorBox message="Could not parse that as a timestamp or date." />}
      {valid && (
        <div className="rounded-md border border-border px-3">
          <OutputRow label="Detected as" value={parsed.unit} />
          <OutputRow label="ISO 8601" value={parsed.date.toISOString()} />
          <OutputRow label="UTC" value={parsed.date.toUTCString()} />
          <OutputRow label="Local" value={parsed.date.toLocaleString()} />
          <OutputRow label="Relative" value={relativeTime(parsed.date, now)} />
          <OutputRow label="Epoch (s)" value={String(Math.floor(parsed.date.getTime() / 1000))} />
          <OutputRow label="Epoch (ms)" value={String(parsed.date.getTime())} />
        </div>
      )}
    </div>
  );
}

// ---------- Regex ----------

const MAX_MATCHES = 1000;

export function RegexTool() {
  const [pattern, setPattern] = useState('(\\w+)@(\\w+)\\.com');
  const [flags, setFlags] = useState('gi');
  const [text, setText] = useState('Contact alice@example.com or bob@test.com for details.');
  const [replacement, setReplacement] = useState('');

  const result = useMemo(() => {
    if (!pattern) return { matches: [] as RegExpMatchArray[], replaced: '', error: '' };
    try {
      // Always scan globally for highlighting; the user's flags still govern the replace preview.
      const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
      const matches: RegExpMatchArray[] = [];
      for (const m of text.matchAll(re)) {
        matches.push(m);
        if (matches.length >= MAX_MATCHES) break;
      }
      const replaced = replacement ? text.replace(new RegExp(pattern, flags), replacement) : '';
      return { matches, replaced, error: '' };
    } catch (e) {
      return { matches: [], replaced: '', error: (e as Error).message };
    }
  }, [pattern, flags, text, replacement]);

  const highlighted = useMemo(() => {
    const out: React.ReactNode[] = [];
    let last = 0;
    result.matches.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (start > last) out.push(text.slice(last, start));
      out.push(<mark key={i} className="bg-primary/25 text-foreground rounded-sm outline outline-1 outline-primary/40">{m[0] || '​'}</mark>);
      last = end;
    });
    out.push(text.slice(last));
    return out;
  }, [result.matches, text]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="flex-1 flex items-center rounded-md border border-input focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
          <span className="pl-2.5 text-muted-foreground font-mono">/</span>
          <input className={cn(MONO, 'flex-1 bg-transparent outline-none px-1 h-8')} value={pattern} onChange={e => setPattern(e.target.value)} spellCheck={false} />
          <span className="text-muted-foreground font-mono">/</span>
          <input className={cn(MONO, 'w-14 bg-transparent outline-none px-1 h-8')} value={flags} onChange={e => setFlags(e.target.value.replace(/[^dgimsuyv]/g, ''))} spellCheck={false} />
        </div>
        <Badge variant="secondary" className="h-8">{result.matches.length}{result.matches.length >= MAX_MATCHES ? '+' : ''} matches</Badge>
      </div>
      {result.error && <ErrorBox message={result.error} />}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Test string</FieldLabel>
          <Textarea className={cn(MONO, 'h-48 field-sizing-fixed')} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Matches highlighted</FieldLabel>
          <div className={cn(MONO, 'h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-secondary/40 px-2.5 py-2')}>{highlighted}</div>
        </div>
      </div>
      <div className="space-y-1.5">
        <FieldLabel>Replace with (supports $1, $&lt;name&gt;)</FieldLabel>
        <Input className={MONO} value={replacement} onChange={e => setReplacement(e.target.value)} placeholder="Optional replacement…" />
        {replacement && !result.error && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 p-2.5">
            <code className={cn(MONO, 'flex-1 whitespace-pre-wrap break-all')}>{result.replaced}</code>
            <CopyButton value={result.replaced} />
          </div>
        )}
      </div>
      {result.matches.length > 0 && (
        <div className="rounded-md border border-border overflow-auto max-h-64">
          <table className="w-full text-xs">
            <thead className="bg-secondary text-muted-foreground sticky top-0">
              <tr><th className="text-left px-2 py-1.5 w-10">#</th><th className="text-left px-2 py-1.5 w-16">Index</th><th className="text-left px-2 py-1.5">Match</th><th className="text-left px-2 py-1.5">Groups</th></tr>
            </thead>
            <tbody>
              {result.matches.slice(0, 200).map((m, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                  <td className="px-2 py-1 tabular-nums">{m.index}</td>
                  <td className="px-2 py-1 font-mono break-all">{m[0]}</td>
                  <td className="px-2 py-1 font-mono break-all text-muted-foreground">
                    {m.groups
                      ? Object.entries(m.groups).map(([k, v]) => `${k}=${v ?? ''}`).join(', ')
                      : m.slice(1).map((g, j) => `$${j + 1}=${g ?? ''}`).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Diff ----------

type DiffLine = { type: 'same' | 'add' | 'del'; text: string; a?: number; b?: number };
const MAX_DIFF_LINES = 3000;

function diffLines(a: string[], b: string[]): DiffLine[] {
  // Classic LCS table — fine for the line counts we allow.
  const n = a.length, m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { out.push({ type: 'del', text: a[i], a: i + 1 }); i++; }
    else { out.push({ type: 'add', text: b[j], b: j + 1 }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i], a: i + 1 }); i++; }
  while (j < m) { out.push({ type: 'add', text: b[j], b: j + 1 }); j++; }
  return out;
}

export function DiffTool() {
  const [left, setLeft] = useState('line one\nline two\nline three');
  const [right, setRight] = useState('line one\nline 2\nline three\nline four');
  const [ignoreWs, setIgnoreWs] = useState(false);

  const result = useMemo(() => {
    const norm = (s: string) => s.split(/\r?\n/).map(l => ignoreWs ? l.trim().replace(/\s+/g, ' ') : l);
    const a = norm(left), b = norm(right);
    if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
      return { lines: [] as DiffLine[], error: `Each side is limited to ${MAX_DIFF_LINES} lines.` };
    }
    return { lines: diffLines(a, b), error: '' };
  }, [left, right, ignoreWs]);

  const added = result.lines.filter(l => l.type === 'add').length;
  const removed = result.lines.filter(l => l.type === 'del').length;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Original</FieldLabel>
          <Textarea className={cn(MONO, 'h-48 field-sizing-fixed')} value={left} onChange={e => setLeft(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Changed</FieldLabel>
          <Textarea className={cn(MONO, 'h-48 field-sizing-fixed')} value={right} onChange={e => setRight(e.target.value)} spellCheck={false} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>+{added}</Badge>
        <Badge variant="destructive">−{removed}</Badge>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={ignoreWs} onChange={e => setIgnoreWs(e.target.checked)} /> Ignore whitespace
        </label>
      </div>
      {result.error ? <ErrorBox message={result.error} /> : (
        <div className="rounded-md border border-border overflow-auto max-h-[28rem] font-mono text-xs">
          {result.lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                'flex',
                l.type === 'add' && 'bg-primary/10',
                l.type === 'del' && 'bg-destructive/10',
              )}
            >
              <span className="w-10 shrink-0 text-right pr-2 text-muted-foreground/60 select-none">{l.a ?? ''}</span>
              <span className="w-10 shrink-0 text-right pr-2 text-muted-foreground/60 select-none">{l.b ?? ''}</span>
              <span className={cn('w-4 shrink-0 select-none', l.type === 'add' ? 'text-primary' : l.type === 'del' ? 'text-destructive' : 'text-muted-foreground/40')}>
                {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
              </span>
              <span className="whitespace-pre-wrap break-all pr-2">{l.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Case / text stats ----------

function words(s: string) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

const CASES: { label: string; fn: (s: string) => string }[] = [
  { label: 'camelCase', fn: s => words(s).map((w, i) => i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join('') },
  { label: 'PascalCase', fn: s => words(s).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('') },
  { label: 'snake_case', fn: s => words(s).map(w => w.toLowerCase()).join('_') },
  { label: 'CONSTANT_CASE', fn: s => words(s).map(w => w.toUpperCase()).join('_') },
  { label: 'kebab-case', fn: s => words(s).map(w => w.toLowerCase()).join('-') },
  { label: 'dot.case', fn: s => words(s).map(w => w.toLowerCase()).join('.') },
  { label: 'Title Case', fn: s => words(s).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') },
  { label: 'lowercase', fn: s => s.toLowerCase() },
  { label: 'UPPERCASE', fn: s => s.toUpperCase() },
  { label: 'Slug', fn: s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') },
];

export function CaseTool() {
  const [text, setText] = useState('Hello world from the devTools panel');

  const stats = useMemo(() => ({
    Characters: text.length,
    Words: text.trim() ? text.trim().split(/\s+/).length : 0,
    Lines: text ? text.split(/\r?\n/).length : 0,
    'Bytes (UTF-8)': utf8ToBytes(text).length,
  }), [text]);

  return (
    <div className="space-y-3">
      <Textarea className={cn(MONO, 'h-28 field-sizing-fixed')} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {Object.entries(stats).map(([k, v]) => (
          <div key={k} className="rounded-md border border-border bg-secondary/40 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{k}</p>
            <p className="text-sm font-semibold tabular-nums">{v.toLocaleString()}</p>
          </div>
        ))}
      </div>
      <div className="rounded-md border border-border px-3">
        {CASES.map(c => <OutputRow key={c.label} label={c.label} value={text ? c.fn(text) : ''} />)}
      </div>
    </div>
  );
}

// ---------- Number base ----------

const BASES = [
  { base: 10, label: 'Decimal', prefix: '', re: /^[0-9]+$/ },
  { base: 16, label: 'Hex', prefix: '0x', re: /^[0-9a-f]+$/i },
  { base: 8, label: 'Octal', prefix: '0o', re: /^[0-7]+$/ },
  { base: 2, label: 'Binary', prefix: '0b', re: /^[01]+$/ },
] as const;

export function BaseTool() {
  const [value, setValue] = useState<bigint | null>(255n);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [error, setError] = useState('');

  const update = (base: number, raw: string) => {
    setDrafts({ [base]: raw });
    const cfg = BASES.find(b => b.base === base)!;
    let s = raw.trim().replace(/[_\s]/g, '');
    const neg = s.startsWith('-');
    if (neg) s = s.slice(1);
    if (cfg.prefix && s.toLowerCase().startsWith(cfg.prefix)) s = s.slice(2);
    if (!s) { setValue(null); setError(''); return; }
    if (!cfg.re.test(s)) { setError(`Not a valid ${cfg.label.toLowerCase()} number.`); return; }
    const v = BigInt(cfg.prefix ? cfg.prefix + s : s);
    setValue(neg ? -v : v);
    setError('');
  };

  const display = (base: number) => {
    if (base in drafts) return drafts[base];
    if (value === null) return '';
    return value < 0n ? '-' + (-value).toString(base) : value.toString(base);
  };

  return (
    <div className="space-y-3 max-w-2xl">
      {BASES.map(b => (
        <div key={b.base} className="space-y-1.5">
          <FieldLabel action={<CopyButton value={display(b.base)} />}>{b.label} <span className="opacity-60">(base {b.base})</span></FieldLabel>
          <Input className={MONO} value={display(b.base)} onChange={e => update(b.base, e.target.value)} onBlur={() => setDrafts({})} spellCheck={false} />
        </div>
      ))}
      {error && <ErrorBox message={error} />}
      {value !== null && value >= 0n && (
        <p className="text-[11px] text-muted-foreground">
          {value.toString(2).length} bits · {Math.ceil(value.toString(2).length / 8)} byte(s)
        </p>
      )}
    </div>
  );
}

// ---------- Color ----------

type RGB = { r: number; g: number; b: number; a: number };

function parseColor(s: string): RGB | null {
  const str = s.trim().toLowerCase();
  let m = /^#?([0-9a-f]{3,8})$/.exec(str);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    let h = m[1];
    if (h.length <= 4) h = h.split('').map(c => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(str);
  if (m) {
    const a = m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(str);
  if (m) {
    const h = +m[1] / 360, sat = +m[2] / 100, l = +m[3] / 100;
    const a = m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
    const f = (n: number) => {
      const k = (n + h * 12) % 12;
      return Math.round(255 * (l - sat * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return { r: f(0), g: f(8), b: f(4), a };
  }
  return null;
}

function toHsl({ r, g, b }: RGB) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function luminance({ r, g, b }: RGB) {
  const ch = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function ColorTool() {
  const [input, setInput] = useState('#6366f1');
  const color = useMemo(() => parseColor(input), [input]);

  const hex = color ? '#' + [color.r, color.g, color.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('') : '';
  const hsl = color ? toHsl(color) : null;
  const alpha = color && color.a < 1 ? color.a : null;
  const lum = color ? luminance(color) : 0;
  const contrast = (l2: number) => ((Math.max(lum, l2) + 0.05) / (Math.min(lum, l2) + 0.05)).toFixed(2);

  return (
    <div className="space-y-3 max-w-2xl">
      <div className="flex items-center gap-2">
        <input type="color" value={hex || '#000000'} onChange={e => setInput(e.target.value)} className="size-8 rounded-md border border-border bg-transparent cursor-pointer" />
        <Input className={MONO} value={input} onChange={e => setInput(e.target.value)} placeholder="#hex, rgb(…), hsl(…)" spellCheck={false} />
      </div>
      {!color && input.trim() && <ErrorBox message="Unrecognised color. Try #RRGGBB, rgb(r, g, b) or hsl(h, s%, l%)." />}
      {color && hsl && (
        <>
          <div className="h-20 rounded-lg border border-border flex items-center justify-center gap-6 text-sm font-medium" style={{ background: `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})` }}>
            <span style={{ color: '#fff' }}>White {contrast(1)}:1</span>
            <span style={{ color: '#000' }}>Black {contrast(0)}:1</span>
          </div>
          <div className="rounded-md border border-border px-3">
            <OutputRow label="HEX" value={alpha !== null ? hex + Math.round(alpha * 255).toString(16).padStart(2, '0') : hex} />
            <OutputRow label="RGB" value={alpha !== null ? `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})` : `rgb(${color.r}, ${color.g}, ${color.b})`} />
            <OutputRow label="HSL" value={alpha !== null ? `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${alpha})` : `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`} />
            <OutputRow label="Tailwind arb." value={`[${hex}]`} />
          </div>
        </>
      )}
    </div>
  );
}
