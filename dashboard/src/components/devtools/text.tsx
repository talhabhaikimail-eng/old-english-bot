import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, Download, Eraser, Loader2, Mic, MicOff, RefreshCw, Search, Shuffle, SpellCheck, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  MONO, FIXED, Checkbox, CopyButton, ErrorBox, FieldLabel, InfoBox, NumberField, Segmented, Stat, copyText, downloadBlob, toolsApi,
} from './shared';
import {
  DEFAULT_DEDUPE, FANCY_STYLES, type DedupeOptions, type LoremUnit, type SortMode, dedupeLines, formatMinutes, graphemeCount, lorem,
  reverseChars, reverseEachWord, reverseLines, reverseWords, smsInfo, textStats, tweetLength, upsideDown,
} from './lib/text';

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

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Load a .txt / .md file into state. */
function LoadFileButton({ onText, accept = '.txt,.md,.csv,.json,.html,.xml,.log,text/*' }: { onText: (t: string) => void; accept?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="ghost" size="xs" onClick={() => ref.current?.click()}><Upload /> Open</Button>
      <input ref={ref} type="file" className="hidden" accept={accept} onChange={async e => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) onText(await f.text());
      }} />
    </>
  );
}

const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });

const SAMPLE_ARTICLE = `Remote work has changed how teams communicate. Instead of tapping a colleague on the shoulder, people now write messages, record short videos and document decisions. Writing clearly has become a core professional skill.

Good written communication is specific. It states the goal, the context and the decision that is needed. It avoids vague phrases and buries no surprises at the end. Teams that write well spend less time in meetings and make decisions faster.

Asynchronous writing also creates a searchable record. New team members can read the history of a project instead of asking the same questions again. Over time, that record becomes one of the most valuable assets a remote team owns.`;

// ───────────────────────── Word counter ─────────────────────────

export function WordCounter() {
  const [text, setText] = useState(SAMPLE_ARTICLE);
  const [wpm, setWpm] = useState(238);
  const s = useMemo(() => textStats(text, { readingWpm: wpm || 238 }), [text, wpm]);
  const maxKw = s.keywords[0]?.count ?? 1;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldLabel action={
          <div className="flex items-center gap-1">
            <LoadFileButton onText={setText} />
            <CopyButton value={text} label="Copy" />
            <Button variant="ghost" size="xs" onClick={() => setText('')}><Eraser /> Clear</Button>
          </div>
        }>Your text</FieldLabel>
        <Textarea className={cn(FIXED, 'h-56 text-sm leading-relaxed')} value={text} onChange={e => setText(e.target.value)} placeholder="Type or paste text…" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Words" value={fmt(s.words)} hint={`${fmt(s.uniqueWords)} unique`} />
        <Stat label="Characters" value={fmt(s.characters)} hint={`${fmt(s.charactersNoSpaces)} without spaces`} />
        <Stat label="Sentences" value={fmt(s.sentences)} hint={`≈ ${fmt(s.avgSentenceWords, 1)} words each`} />
        <Stat label="Paragraphs" value={fmt(s.paragraphs)} hint={`${fmt(s.lines)} lines`} />
        <Stat label="Avg word length" value={fmt(s.avgWordLength, 1)} hint={s.longestWord ? `longest: ${s.longestWord.slice(0, 24)}` : undefined} />
        <Stat label="Reading time" value={formatMinutes(s.readingMinutes)} hint={`at ${wpm || 238} wpm`} />
        <Stat label="Speaking time" value={formatMinutes(s.speakingMinutes)} hint="at 150 wpm" />
        <Stat label="Letters & digits" value={fmt(s.letters)} />
        <Stat label="Pages (≈)" value={fmt(s.words / 500, 1)} hint="single-spaced, 500 words" />
        <NumberField label="Reading speed" value={wpm} onChange={setWpm} min={50} max={1000} step={10} suffix="wpm" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Top keywords</CardTitle>
            <CardDescription className="text-xs">Stop words removed · density = share of all words.</CardDescription>
          </CardHeader>
          <CardContent>
            {s.keywords.length === 0 ? <p className="text-xs text-muted-foreground">No keywords yet.</p> : (
              <div className="space-y-1">
                {s.keywords.map(k => (
                  <div key={k.word} className="flex items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 truncate font-medium" title={k.word}>{k.word}</span>
                    <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
                      <div className="h-full bg-primary/70" style={{ width: `${(k.count / maxKw) * 100}%` }} />
                    </div>
                    <span className="w-8 text-right tabular-nums">{k.count}</span>
                    <span className="w-12 text-right tabular-nums text-muted-foreground">{(k.density * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Repeated phrases</CardTitle>
            <CardDescription className="text-xs">Two-word phrases that appear more than once.</CardDescription>
          </CardHeader>
          <CardContent>
            {s.phrases.length === 0 ? <p className="text-xs text-muted-foreground">No repeated phrases.</p> : (
              <div className="flex flex-wrap gap-1.5">
                {s.phrases.map(p => <Badge key={p.phrase} variant="secondary">{p.phrase} · {p.count}</Badge>)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ───────────────────────── Character counter ─────────────────────────

type Counter = 'graphemes' | 'tweet' | 'sms' | 'utf16';
interface Limit { id: string; label: string; limit: number; counter: Counter; note?: string }

const LIMITS: Limit[] = [
  { id: 'x', label: 'X / Twitter post', limit: 280, counter: 'tweet', note: 'URLs = 23, CJK & emoji = 2' },
  { id: 'meta-title', label: 'Meta title', limit: 60, counter: 'graphemes', note: '≈ 600 px in Google results' },
  { id: 'meta-desc', label: 'Meta description', limit: 160, counter: 'graphemes' },
  { id: 'sms', label: 'SMS', limit: 160, counter: 'sms', note: 'GSM-7 160 / 153 · UCS-2 70 / 67 per segment' },
  { id: 'ig-caption', label: 'Instagram caption', limit: 2200, counter: 'graphemes' },
  { id: 'ig-bio', label: 'Instagram bio', limit: 150, counter: 'graphemes' },
  { id: 'li-post', label: 'LinkedIn post', limit: 3000, counter: 'graphemes' },
  { id: 'li-headline', label: 'LinkedIn headline', limit: 220, counter: 'graphemes' },
  { id: 'threads', label: 'Threads post', limit: 500, counter: 'graphemes' },
  { id: 'bluesky', label: 'Bluesky post', limit: 300, counter: 'graphemes' },
  { id: 'mastodon', label: 'Mastodon post', limit: 500, counter: 'graphemes' },
  { id: 'yt-title', label: 'YouTube title', limit: 100, counter: 'graphemes' },
  { id: 'yt-desc', label: 'YouTube description', limit: 5000, counter: 'graphemes' },
  { id: 'tiktok', label: 'TikTok caption', limit: 4000, counter: 'graphemes' },
  { id: 'discord', label: 'Discord message', limit: 2000, counter: 'utf16' },
  { id: 'gads-h', label: 'Google Ads headline', limit: 30, counter: 'graphemes' },
  { id: 'gads-d', label: 'Google Ads description', limit: 90, counter: 'graphemes' },
  { id: 'push', label: 'Push notification (iOS)', limit: 178, counter: 'graphemes' },
];

export function CharacterCounter() {
  const [text, setText] = useState('Ship faster with fewer meetings: write it down, decide async, and keep a searchable record. 🚀 https://example.com/guide');
  const [selected, setSelected] = useState('x');
  const [custom, setCustom] = useState(100);

  const counts = useMemo(() => ({
    graphemes: graphemeCount(text),
    codePoints: Array.from(text).length,
    utf16: text.length,
    bytes: new TextEncoder().encode(text).length,
    words: (text.match(/\S+/g) ?? []).length,
    lines: text ? text.split('\n').length : 0,
    tweet: tweetLength(text),
    sms: smsInfo(text),
  }), [text]);

  const measure = (l: Limit) => l.counter === 'tweet' ? counts.tweet : l.counter === 'utf16' ? counts.utf16 : l.counter === 'sms' ? counts.sms.units : counts.graphemes;
  const current: Limit = selected === 'custom' ? { id: 'custom', label: 'Custom limit', limit: custom || 1, counter: 'graphemes' } : LIMITS.find(l => l.id === selected)!;
  const used = measure(current);
  const remaining = current.limit - used;
  const pct = Math.min(100, (used / current.limit) * 100);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
        <div className="space-y-1.5">
          <FieldLabel>Limit</FieldLabel>
          <NativeSelect value={selected} onChange={setSelected} options={[...LIMITS.map(l => ({ value: l.id, label: `${l.label} — ${fmt(l.limit)}` })), { value: 'custom', label: 'Custom…' }]} />
        </div>
        {selected === 'custom' && <NumberField label="Custom limit" value={custom} onChange={setCustom} min={1} className="w-36" />}
      </div>

      <div className="space-y-1.5">
        <FieldLabel action={<div className="flex gap-1"><CopyButton value={text} label="Copy" /><Button variant="ghost" size="xs" onClick={() => setText('')}><Eraser /> Clear</Button></div>}>Text</FieldLabel>
        <Textarea className={cn(FIXED, 'h-40 text-sm')} value={text} onChange={e => setText(e.target.value)} placeholder="Type or paste…" />
        <div className="space-y-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span>
              <span className={cn('text-lg font-semibold tabular-nums', remaining < 0 ? 'text-destructive' : '')}>{fmt(used)}</span>
              <span className="text-muted-foreground"> / {fmt(current.limit)} {current.counter === 'sms' ? `units (${counts.sms.encoding})` : 'characters'}</span>
            </span>
            <span className={cn('tabular-nums', remaining < 0 ? 'text-destructive font-medium' : 'text-muted-foreground')}>
              {current.counter === 'sms'
                ? `${counts.sms.segments} segment${counts.sms.segments === 1 ? '' : 's'} · ${counts.sms.remainingInSegment} left in this segment`
                : remaining >= 0 ? `${fmt(remaining)} remaining` : `${fmt(-remaining)} over the limit`}
            </span>
          </div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div className={cn('h-full transition-all', remaining < 0 ? 'bg-destructive' : pct > 90 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${pct}%` }} />
          </div>
          {current.note && <p className="text-[11px] text-muted-foreground">{current.note}</p>}
          {current.counter === 'sms' && counts.sms.nonGsm.length > 0 && (
            <p className="text-[11px] text-muted-foreground">Forces UCS-2 (70 chars/segment): <span className="font-mono">{counts.sms.nonGsm.slice(0, 20).join(' ')}</span></p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Characters" value={fmt(counts.graphemes)} hint="as people see them" />
        <Stat label="Code points" value={fmt(counts.codePoints)} />
        <Stat label="UTF-16 units" value={fmt(counts.utf16)} hint="JS .length" />
        <Stat label="UTF-8 bytes" value={fmt(counts.bytes)} />
        <Stat label="Words" value={fmt(counts.words)} />
        <Stat label="Lines" value={fmt(counts.lines)} />
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 px-3 py-1.5 text-[11px] font-medium text-muted-foreground bg-secondary/40">
          <span>Platform</span><span className="text-right">Used / limit</span><span className="w-16 sm:w-28">Fit</span>
        </div>
        {LIMITS.map(l => {
          const u = measure(l);
          const over = u > l.limit;
          return (
            <button key={l.id} type="button" onClick={() => setSelected(l.id)}
              className={cn('grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 px-3 py-1.5 text-xs text-left border-t border-border hover:bg-secondary/40 cursor-pointer', selected === l.id && 'bg-primary/5')}>
              <span className="truncate">{l.label}</span>
              <span className={cn('tabular-nums text-right', over && 'text-destructive font-medium')}>{fmt(u)} / {fmt(l.limit)}</span>
              <span className="w-16 sm:w-28 h-1.5 rounded-full bg-secondary overflow-hidden">
                <span className={cn('block h-full', over ? 'bg-destructive' : 'bg-primary/70')} style={{ width: `${Math.min(100, (u / l.limit) * 100)}%` }} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────── Remove duplicate lines ─────────────────────────

const SAMPLE_LIST = `react
vue
Svelte
react
angular
  vue
solid

svelte
Qwik
react
Angular`;

export function RemoveDuplicateLines() {
  const [text, setText] = useState(SAMPLE_LIST);
  const [o, setO] = useState<DedupeOptions>(DEFAULT_DEDUPE);
  const [seed, setSeed] = useState(1);
  const set = <K extends keyof DedupeOptions>(k: K, v: DedupeOptions[K]) => setO(p => ({ ...p, [k]: v }));
  const r = useMemo(() => dedupeLines(text, { ...o, seed }), [text, o, seed]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <FieldLabel>Mode</FieldLabel>
          <NativeSelect value={o.mode} onChange={v => set('mode', v)} options={[
            { value: 'dedupe', label: 'Remove duplicates' }, { value: 'duplicates', label: 'Show only duplicated lines' }, { value: 'unique', label: 'Show only lines that appear once' },
          ]} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Keep</FieldLabel>
          <NativeSelect value={o.keep} onChange={v => set('keep', v)} options={[{ value: 'first', label: 'First occurrence' }, { value: 'last', label: 'Last occurrence' }]} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel action={o.sort === 'random' ? <Button variant="ghost" size="xs" onClick={() => setSeed(s => s + 1)}><Shuffle /> Reshuffle</Button> : undefined}>Sort</FieldLabel>
          <NativeSelect<SortMode> value={o.sort} onChange={v => set('sort', v)} options={[
            { value: 'none', label: 'Keep original order' }, { value: 'asc', label: 'A → Z (code point)' }, { value: 'desc', label: 'Z → A (code point)' },
            { value: 'natural', label: 'Natural (item2 < item10)' }, { value: 'natural-desc', label: 'Natural, descending' },
            { value: 'length', label: 'Shortest first' }, { value: 'length-desc', label: 'Longest first' }, { value: 'reverse', label: 'Reverse order' }, { value: 'random', label: 'Random shuffle' },
          ]} />
        </div>
        <div className="flex flex-col gap-1.5 sm:pt-6">
          <Checkbox checked={o.caseInsensitive} onChange={v => set('caseInsensitive', v)}>Ignore case</Checkbox>
          <Checkbox checked={o.ignoreWhitespace} onChange={v => set('ignoreWhitespace', v)}>Ignore extra whitespace when comparing</Checkbox>
          <Checkbox checked={o.trim} onChange={v => set('trim', v)}>Trim lines</Checkbox>
          <Checkbox checked={o.removeEmpty} onChange={v => set('removeEmpty', v)}>Remove empty lines</Checkbox>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">{fmt(r.total)} lines in</Badge>
        <Badge>{fmt(r.kept)} lines out</Badge>
        {o.mode === 'dedupe' && <Badge variant="outline">{fmt(r.duplicatesRemoved)} duplicates removed</Badge>}
        {r.emptyRemoved > 0 && <Badge variant="outline">{fmt(r.emptyRemoved)} empty removed</Badge>}
        <Badge variant="outline">{fmt(r.duplicateGroups)} duplicated values</Badge>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel action={<div className="flex gap-1"><LoadFileButton onText={setText} /><Button variant="ghost" size="xs" onClick={() => setText('')}><Eraser /> Clear</Button></div>}>Input</FieldLabel>
          <Textarea className={cn(MONO, FIXED, 'h-80')} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel action={<div className="flex gap-1">
            <Button variant="ghost" size="xs" disabled={!r.output} onClick={() => setText(r.output)}>Use as input</Button>
            <Button variant="ghost" size="xs" disabled={!r.output} onClick={() => downloadBlob(r.output, 'lines.txt')}><Download /> .txt</Button>
            <CopyButton value={r.output} label="Copy" />
          </div>}>Result</FieldLabel>
          <Textarea readOnly className={cn(MONO, FIXED, 'h-80 bg-secondary/40')} value={r.output} />
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Grammar checker ─────────────────────────

interface GrammarMatch {
  offset: number; length: number; message: string; shortMessage: string; replacements: string[];
  rule: { id: string; description: string; category: string }; issueType: string;
}

const LT_LANGS = [
  ['auto', 'Auto-detect'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['en-CA', 'English (Canada)'],
  ['de-DE', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['pt-BR', 'Portuguese (Brazil)'], ['pt-PT', 'Portuguese (Portugal)'], ['it', 'Italian'],
  ['nl', 'Dutch'], ['pl-PL', 'Polish'], ['ru-RU', 'Russian'], ['uk-UA', 'Ukrainian'], ['sv', 'Swedish'], ['da-DK', 'Danish'], ['ca-ES', 'Catalan'],
  ['el-GR', 'Greek'], ['ro-RO', 'Romanian'], ['sk-SK', 'Slovak'], ['sl-SI', 'Slovenian'], ['ja-JP', 'Japanese'], ['zh-CN', 'Chinese'], ['ar', 'Arabic'], ['fa', 'Persian'],
].map(([value, label]) => ({ value, label }));

function issueTone(t: string) {
  if (t === 'misspelling') return { mark: 'decoration-red-500 bg-red-500/10', dot: 'bg-red-500', label: 'Spelling' };
  if (t === 'style' || t === 'locale-violation' || t === 'register') return { mark: 'decoration-sky-500 bg-sky-500/10', dot: 'bg-sky-500', label: 'Style' };
  if (t === 'typographical' || t === 'whitespace') return { mark: 'decoration-violet-500 bg-violet-500/10', dot: 'bg-violet-500', label: 'Typography' };
  return { mark: 'decoration-amber-500 bg-amber-500/10', dot: 'bg-amber-500', label: 'Grammar' };
}

export function GrammarChecker() {
  const [text, setText] = useState('Their going to the park tomorow, and they has a lot of fun there. I cant wait to here about it!  It was a realy nice day , wasnt it?');
  const [language, setLanguage] = useState('auto');
  const [matches, setMatches] = useState<GrammarMatch[] | null>(null);
  const [detected, setDetected] = useState('');
  const [checkedText, setCheckedText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState<number | null>(null);

  const check = useCallback(async (t = text) => {
    if (!t.trim()) return;
    setLoading(true); setError(''); setActive(null);
    try {
      const r = await toolsApi.post<{ matches: GrammarMatch[]; language: { name: string }; detected: { name: string } | null }>('/text/grammar', { text: t, language });
      setMatches(r.matches);
      setCheckedText(t);
      setDetected(r.detected?.name || r.language.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [text, language]);

  useEffect(() => { void check(); /* initial example */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stale = matches !== null && text !== checkedText;

  /** Apply a replacement and shift the remaining matches so they stay aligned. */
  const apply = (idx: number, replacement: string) => {
    if (!matches) return;
    const m = matches[idx];
    const next = text.slice(0, m.offset) + replacement + text.slice(m.offset + m.length);
    const delta = replacement.length - m.length;
    const rest = matches.filter((_, i) => i !== idx).map(x => (x.offset > m.offset ? { ...x, offset: x.offset + delta } : x));
    setText(next); setCheckedText(next); setMatches(rest); setActive(null);
  };
  const applyAll = () => {
    if (!matches) return;
    let t = text;
    const remaining: GrammarMatch[] = [];
    let lastStart = Infinity;
    for (const m of [...matches].sort((a, b) => b.offset - a.offset)) {
      if (!m.replacements.length || m.offset + m.length > lastStart) { remaining.push(m); continue; }
      t = t.slice(0, m.offset) + m.replacements[0] + t.slice(m.offset + m.length);
      lastStart = m.offset;
    }
    setText(t);
    void check(t);
    if (!remaining.length) setMatches([]);
  };
  const ignore = (idx: number) => { setMatches(ms => ms?.filter((_, i) => i !== idx) ?? null); setActive(null); };

  const segments = useMemo(() => {
    if (!matches || stale) return null;
    const out: React.ReactNode[] = [];
    let pos = 0;
    matches.map((m, i) => ({ m, i })).sort((a, b) => a.m.offset - b.m.offset).forEach(({ m, i }) => {
      if (m.offset < pos) return;
      if (m.offset > pos) out.push(text.slice(pos, m.offset));
      const tone = issueTone(m.issueType);
      out.push(
        <button key={i} type="button" onClick={() => setActive(active === i ? null : i)}
          className={cn('rounded-sm underline decoration-2 underline-offset-4 decoration-wavy cursor-pointer', tone.mark, active === i && 'ring-2 ring-primary/50')}>
          {text.slice(m.offset, m.offset + m.length) || ' '}
        </button>,
      );
      pos = m.offset + m.length;
    });
    out.push(text.slice(pos));
    return out;
  }, [matches, stale, text, active]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of matches ?? []) { const l = issueTone(m.issueType).label; c[l] = (c[l] ?? 0) + 1; }
    return c;
  }, [matches]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5 w-full sm:w-56">
          <FieldLabel>Language</FieldLabel>
          <NativeSelect value={language} onChange={setLanguage} options={LT_LANGS} />
        </div>
        <Button onClick={() => check()} disabled={loading || !text.trim()}>
          {loading ? <Loader2 className="animate-spin" /> : <SpellCheck />} Check text
        </Button>
        <Button variant="outline" onClick={applyAll} disabled={loading || stale || !matches?.some(m => m.replacements.length)}>
          <CheckCheck /> Apply all suggestions
        </Button>
        <span className="text-[11px] text-muted-foreground sm:ml-auto">Ctrl + Enter to check · {text.length.toLocaleString()} / 20,000</span>
      </div>

      <div className="space-y-1.5">
        <FieldLabel action={<div className="flex gap-1"><CopyButton value={text} label="Copy" /><Button variant="ghost" size="xs" onClick={() => { setText(''); setMatches(null); }}><Eraser /> Clear</Button></div>}>Text</FieldLabel>
        <Textarea className={cn(FIXED, 'h-40 text-sm leading-relaxed')} value={text} maxLength={20000}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void check(); } }} />
      </div>

      {error && <ErrorBox message={error} />}
      {stale && <InfoBox>Text changed since the last check — press <b>Check text</b> to refresh the suggestions.</InfoBox>}

      {matches && !stale && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                {matches.length === 0 ? 'No issues found 🎉' : `${matches.length} issue${matches.length === 1 ? '' : 's'}`}
                {Object.entries(counts).map(([k, v]) => <Badge key={k} variant="secondary">{k} {v}</Badge>)}
              </CardTitle>
              {detected && <CardDescription className="text-xs">Language: {detected} · click a highlight to see suggestions.</CardDescription>}
            </CardHeader>
            <CardContent>
              <div className="whitespace-pre-wrap break-words text-sm leading-7">{segments}</div>
            </CardContent>
          </Card>
          <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
            {matches.map((m, i) => ({ m, i })).sort((a, b) => a.m.offset - b.m.offset).map(({ m, i }) => {
              const tone = issueTone(m.issueType);
              return (
                <div key={i} onClick={() => setActive(i)}
                  className={cn('rounded-md border p-2.5 space-y-1.5 text-xs cursor-pointer', active === i ? 'border-primary bg-primary/5' : 'border-border bg-card')}>
                  <div className="flex items-start gap-2">
                    <span className={cn('mt-1 size-2 rounded-full shrink-0', tone.dot)} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">{m.shortMessage || tone.label} <span className="font-normal text-muted-foreground">· “{text.slice(m.offset, m.offset + m.length)}”</span></p>
                      <p className="text-muted-foreground">{m.message}</p>
                    </div>
                    <Button variant="ghost" size="icon-xs" title="Ignore" onClick={e => { e.stopPropagation(); ignore(i); }}><X /></Button>
                  </div>
                  {m.replacements.length > 0 && (
                    <div className="flex flex-wrap gap-1 pl-4">
                      {m.replacements.map(r => (
                        <Button key={r} size="xs" variant={active === i ? 'default' : 'secondary'} onClick={e => { e.stopPropagation(); apply(i, r); }}>
                          {r === '' ? '(remove)' : r.replace(/ /g, '·')}
                        </Button>
                      ))}
                    </div>
                  )}
                  <p className="pl-4 text-[10px] text-muted-foreground/80 font-mono truncate">{m.rule.category} · {m.rule.id}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Checked by LanguageTool on the server (text is sent to the configured LanguageTool instance). The free public API allows ~20 requests/minute.</p>
    </div>
  );
}

// ───────────────────────── Plagiarism / similarity ─────────────────────────

interface SimResult {
  shingleSize: number; jaccard: number; cosine: number; aInB: number; bInA: number;
  words: { a: number; b: number; sharedVocabulary: number };
  passages: { aStart: number; aEnd: number; bStart: number; bEnd: number; words: number; text: string }[];
}

const SIM_A = `Large language models are trained on vast amounts of text from the internet. During training, the model learns to predict the next word in a sequence, which allows it to pick up grammar, facts and some reasoning abilities. However, these models can also reproduce biases that exist in their training data, so careful evaluation is essential before deploying them.`;
const SIM_B = `Modern AI assistants rely on large language models. During training, the model learns to predict the next word in a sequence, which allows it to pick up grammar, facts and some reasoning abilities. Researchers warn that such systems may repeat harmful stereotypes, so careful evaluation is essential before deploying them in production.`;

const PASSAGE_COLORS = ['bg-amber-400/35', 'bg-sky-400/35', 'bg-emerald-400/35', 'bg-fuchsia-400/35', 'bg-orange-400/35', 'bg-lime-400/35'];

function Highlighted({ text, ranges, hover, onHover }: {
  text: string; ranges: { start: number; end: number; id: number }[]; hover: number | null; onHover: (id: number | null) => void;
}) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos) continue;
    if (r.start > pos) out.push(<span key={`t${pos}`}>{text.slice(pos, r.start)}</span>);
    out.push(
      <mark key={`m${r.id}-${r.start}`} onMouseEnter={() => onHover(r.id)} onMouseLeave={() => onHover(null)}
        className={cn('rounded-sm text-foreground px-0.5 -mx-0.5', PASSAGE_COLORS[r.id % PASSAGE_COLORS.length], hover === r.id && 'ring-2 ring-primary')}>
        {text.slice(r.start, r.end)}
      </mark>,
    );
    pos = r.end;
  }
  out.push(<span key="end">{text.slice(pos)}</span>);
  return <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{out}</div>;
}

function ScoreBar({ label, value, hint }: { label: string; value: number; hint: string }) {
  const pct = Math.round(value * 1000) / 10;
  return (
    <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 space-y-1.5 min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="text-base font-semibold tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className={cn('h-full', pct >= 50 ? 'bg-destructive' : pct >= 20 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

export function PlagiarismChecker() {
  const [a, setA] = useState(SIM_A);
  const [b, setB] = useState(SIM_B);
  const [n, setN] = useState(5);
  const [res, setRes] = useState<SimResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const da = useDebounced(a, 500);
  const db = useDebounced(b, 500);

  useEffect(() => {
    if (!da.trim() || !db.trim()) { setRes(null); return; }
    let alive = true;
    setLoading(true);
    toolsApi.post<SimResult>('/text/similarity', { a: da, b: db, n })
      .then(r => { if (alive) { setRes(r); setError(''); } })
      .catch(e => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [da, db, n]);

  const verdict = res ? (res.aInB >= 0.5 || res.jaccard >= 0.3 ? { t: 'High overlap', v: 'destructive' as const } : res.aInB >= 0.15 ? { t: 'Partial overlap', v: 'secondary' as const } : { t: 'Low overlap', v: 'outline' as const }) : null;
  const fresh = res && da === a && db === b;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        {([['Document A (suspected)', a, setA], ['Document B (source)', b, setB]] as const).map(([label, v, set]) => (
          <div key={label} className="space-y-1.5">
            <FieldLabel action={<div className="flex gap-1"><LoadFileButton onText={set} /><Button variant="ghost" size="xs" onClick={() => set('')}><Eraser /> Clear</Button></div>}>
              {label} · {(v.match(/\S+/g) ?? []).length.toLocaleString()} words
            </FieldLabel>
            <Textarea className={cn(FIXED, 'h-44 text-sm')} value={v} onChange={e => set(e.target.value)} />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <NumberField label="Min. shared run (words)" value={n} onChange={v => setN(Math.max(2, Math.min(15, v || 5)))} min={2} max={15} className="w-44" />
        <p className="text-[11px] text-muted-foreground pb-2 flex-1 min-w-48">Passages of at least this many consecutive matching words (case and punctuation ignored) are reported. Lower = more sensitive.</p>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground mb-2" />}
        {verdict && <Badge variant={verdict.v} className="mb-1.5">{verdict.t}</Badge>}
      </div>

      {error && <ErrorBox message={error} />}

      {res && (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <ScoreBar label="A found in B" value={res.aInB} hint="Share of A's words inside shared passages" />
            <ScoreBar label="B found in A" value={res.bInA} hint="Share of B's words inside shared passages" />
            <ScoreBar label="Shingle Jaccard" value={res.jaccard} hint={`Overlap of ${res.shingleSize}-word sequences`} />
            <ScoreBar label="TF-IDF cosine" value={res.cosine} hint={`Vocabulary similarity · ${res.words.sharedVocabulary} shared words`} />
          </div>
          {fresh && (
            <div className="grid gap-3 lg:grid-cols-2">
              <Card size="sm"><CardHeader><CardTitle className="text-sm">Document A</CardTitle></CardHeader>
                <CardContent><Highlighted text={a} ranges={res.passages.map((p, i) => ({ start: p.aStart, end: p.aEnd, id: i }))} hover={hover} onHover={setHover} /></CardContent>
              </Card>
              <Card size="sm"><CardHeader><CardTitle className="text-sm">Document B</CardTitle></CardHeader>
                <CardContent><Highlighted text={b} ranges={res.passages.map((p, i) => ({ start: p.bStart, end: p.bEnd, id: i }))} hover={hover} onHover={setHover} /></CardContent>
              </Card>
            </div>
          )}
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">{res.passages.length} shared passage{res.passages.length === 1 ? '' : 's'}</CardTitle>
              <CardDescription className="text-xs">Hover a passage to locate it in both documents.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {res.passages.length === 0 && <p className="text-xs text-muted-foreground">No runs of {res.shingleSize}+ identical words.</p>}
              {[...res.passages].map((p, i) => ({ p, i })).sort((x, y) => y.p.words - x.p.words).map(({ p, i }) => (
                <div key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                  className={cn('flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs', hover === i ? 'border-primary' : 'border-border')}>
                  <span className={cn('mt-1 size-2.5 rounded-sm shrink-0', PASSAGE_COLORS[i % PASSAGE_COLORS.length])} />
                  <span className="flex-1 min-w-0 break-words">“{p.text}”</span>
                  <Badge variant="secondary" className="shrink-0">{p.words} words</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
      <p className="text-[11px] text-muted-foreground">Compares the two texts you provide (no web search). Paraphrased text lowers the passage scores but usually keeps the cosine score high.</p>
    </div>
  );
}

// ───────────────────────── Speech to text ─────────────────────────

const STT_LANGS = [
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['en-AU', 'English (Australia)'], ['ur-PK', 'Urdu (Pakistan)'],
  ['hi-IN', 'Hindi'], ['ar-SA', 'Arabic'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'], ['fr-FR', 'French'], ['de-DE', 'German'],
  ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['pt-PT', 'Portuguese (Portugal)'], ['nl-NL', 'Dutch'], ['pl-PL', 'Polish'], ['ru-RU', 'Russian'],
  ['uk-UA', 'Ukrainian'], ['tr-TR', 'Turkish'], ['fa-IR', 'Persian'], ['bn-BD', 'Bengali'], ['zh-CN', 'Chinese (Mandarin)'], ['ja-JP', 'Japanese'],
  ['ko-KR', 'Korean'], ['id-ID', 'Indonesian'], ['ms-MY', 'Malay'], ['vi-VN', 'Vietnamese'], ['th-TH', 'Thai'], ['sv-SE', 'Swedish'],
].map(([value, label]) => ({ value, label }));

const PUNCT_COMMANDS: [RegExp, string][] = [
  [/\s*\bnew paragraph\b\s*/gi, '\n\n'], [/\s*\bnew line\b\s*/gi, '\n'], [/\s*\b(period|full stop)\b/gi, '.'], [/\s*\bcomma\b/gi, ','],
  [/\s*\bquestion mark\b/gi, '?'], [/\s*\bexclamation (mark|point)\b/gi, '!'], [/\s*\bsemicolon\b/gi, ';'], [/\s*\bcolon\b/gi, ':'],
  [/\s*\b(dash|hyphen)\b\s*/gi, ' - '], [/\bopen quote\b\s*/gi, '"'], [/\s*\bclose quote\b/gi, '"'], [/\bopen (paren|parenthesis)\b\s*/gi, '('],
  [/\s*\bclose (paren|parenthesis)\b/gi, ')'], [/\s*\bellipsis\b/gi, '…'],
];

function applyCommands(s: string) {
  let t = s;
  for (const [re, rep] of PUNCT_COMMANDS) t = t.replace(re, rep);
  return t;
}

/** Append a final phrase to the transcript with sensible spacing and capitalisation. */
function appendPhrase(prev: string, phrase: string, autoCap: boolean) {
  let p = phrase.trim();
  if (!p) return prev;
  const startsSentence = !prev.trim() || /[.!?…]\s*$|\n\s*$/.test(prev);
  if (autoCap && startsSentence) p = p.charAt(0).toUpperCase() + p.slice(1);
  const needsSpace = prev && !/[\s(“"]$/.test(prev) && !/^[.,;:!?…)\n]/.test(p);
  return prev + (needsSpace ? ' ' : '') + p;
}

export function SpeechToText() {
  const SR: any = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : undefined;
  const [lang, setLang] = useState(() => (STT_LANGS.some(l => l.value === navigator.language) ? navigator.language : 'en-US'));
  const [listening, setListening] = useState(false);
  const [text, setText] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [commands, setCommands] = useState(true);
  const [autoCap, setAutoCap] = useState(true);
  const recRef = useRef<any>(null);
  const wantRef = useRef(false);
  const opts = useRef({ commands, autoCap });
  opts.current = { commands, autoCap };

  const stop = useCallback(() => {
    wantRef.current = false;
    recRef.current?.stop();
    setListening(false);
    setInterim('');
  }, []);

  const start = useCallback(() => {
    if (!SR) return;
    setError('');
    const rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (ev: any) => {
      let live = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0].transcript as string;
        if (r.isFinal) {
          const phrase = opts.current.commands ? applyCommands(t) : t;
          setText(prev => appendPhrase(prev, phrase, opts.current.autoCap));
        } else live += t;
      }
      setInterim(live);
    };
    rec.onerror = (ev: any) => {
      const msg: Record<string, string> = {
        'not-allowed': 'Microphone permission was denied. Allow microphone access for this site and try again.',
        'service-not-allowed': 'Speech recognition is blocked in this browser/context (it needs HTTPS or localhost).',
        'no-speech': '', 'aborted': '',
        'network': 'The browser could not reach its speech recognition service (Chrome sends audio to Google).',
        'audio-capture': 'No microphone was found.',
        'language-not-supported': 'This language is not supported by your browser’s recogniser.',
      };
      const m = msg[ev.error] ?? `Speech recognition error: ${ev.error}`;
      if (m) { setError(m); wantRef.current = false; setListening(false); }
    };
    // Chrome ends sessions after silence; restart while the user still wants to dictate.
    rec.onend = () => {
      if (wantRef.current) { try { rec.start(); } catch { /* already started */ } } else setListening(false);
    };
    recRef.current = rec;
    wantRef.current = true;
    try { rec.start(); setListening(true); } catch (e) { setError((e as Error).message); }
  }, [SR, lang]);

  useEffect(() => () => { wantRef.current = false; recRef.current?.abort?.(); }, []);
  useEffect(() => { if (listening) { stop(); } }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!SR) {
    return (
      <div className="space-y-3">
        <ErrorBox message="This browser doesn't support the Web Speech API's speech recognition (Firefox and some privacy-focused browsers don't). Use Chrome, Edge or Safari for live dictation." />
        <InfoBox>Tip: on mobile, your keyboard's microphone button gives you dictation in any text field — including the box below.</InfoBox>
        <Textarea className={cn(FIXED, 'h-48 text-sm')} value={text} onChange={e => setText(e.target.value)} placeholder="Dictate with your keyboard here…" />
      </div>
    );
  }

  const words = (text.match(/\S+/g) ?? []).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5 w-full sm:w-56">
          <FieldLabel>Language</FieldLabel>
          <NativeSelect value={lang} onChange={setLang} options={STT_LANGS} />
        </div>
        <Button size="lg" variant={listening ? 'destructive' : 'default'} onClick={listening ? stop : start}>
          {listening ? <><MicOff /> Stop</> : <><Mic /> Start dictation</>}
        </Button>
        {listening && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="relative flex size-2.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-75" /><span className="relative inline-flex size-2.5 rounded-full bg-destructive" /></span>
            Listening…
          </span>
        )}
        <div className="flex flex-col gap-1 sm:ml-auto">
          <Checkbox checked={commands} onChange={setCommands}>Voice punctuation commands</Checkbox>
          <Checkbox checked={autoCap} onChange={setAutoCap}>Auto-capitalise sentences</Checkbox>
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      <div className="space-y-1.5">
        <FieldLabel action={
          <div className="flex gap-1">
            <CopyButton value={text} label="Copy" />
            <Button variant="ghost" size="xs" disabled={!text} onClick={() => downloadBlob(text, 'dictation.txt')}><Download /> .txt</Button>
            <Button variant="ghost" size="xs" onClick={() => { setText(''); setInterim(''); }}><Eraser /> Clear</Button>
          </div>
        }>Transcript · {words.toLocaleString()} words</FieldLabel>
        <Textarea className={cn(FIXED, 'h-56 text-sm leading-relaxed')} value={text} onChange={e => setText(e.target.value)} placeholder="Press Start and speak. You can edit the transcript at any time." />
        <div className="min-h-6 rounded-md border border-dashed border-border px-2.5 py-1 text-sm text-muted-foreground italic">
          {interim || (listening ? 'Waiting for speech…' : 'Live (interim) words appear here.')}
        </div>
      </div>

      {commands && (
        <InfoBox>
          Say <b>comma</b>, <b>period</b> / <b>full stop</b>, <b>question mark</b>, <b>exclamation mark</b>, <b>colon</b>, <b>semicolon</b>, <b>dash</b>, <b>open/close quote</b>,
          <b> open/close paren</b>, <b>new line</b> or <b>new paragraph</b> (English commands). Audio is processed by your browser’s speech service (Google in Chrome, Apple in Safari).
        </InfoBox>
      )}
    </div>
  );
}

// ───────────────────────── Fancy text ─────────────────────────

export function FancyTextGenerator() {
  const [text, setText] = useState('Hello World 2025');
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState('');
  const styles = FANCY_STYLES.filter(s => !q || s.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
        <div className="space-y-1.5">
          <FieldLabel>Your text</FieldLabel>
          <Input value={text} onChange={e => setText(e.target.value)} placeholder="Type something…" className="text-sm" />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Filter styles</FieldLabel>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="bold, script…" className="pl-7" />
          </div>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {styles.map(s => {
          const out = s.fn(text);
          return (
            <button key={s.id} type="button"
              onClick={async () => { await copyText(out); setCopied(s.id); setTimeout(() => setCopied(c => (c === s.id ? '' : c)), 1200); }}
              className="group rounded-lg border border-border bg-card px-3 py-2 text-left hover:border-primary/60 hover:bg-secondary/30 cursor-pointer min-w-0 transition-colors">
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>{s.label}</span>
                <span className={cn('transition-opacity', copied === s.id ? 'text-primary opacity-100' : 'opacity-0 group-hover:opacity-100')}>{copied === s.id ? 'Copied!' : 'Click to copy'}</span>
              </div>
              <p className="text-base break-words leading-relaxed min-h-7">{out || <span className="text-muted-foreground">—</span>}</p>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">These are Unicode characters, not fonts — they paste anywhere, but screen readers may read them letter by letter and some apps don't render every symbol. Use them sparingly in names and bios.</p>
    </div>
  );
}

// ───────────────────────── Text reverser ─────────────────────────

export function TextReverser() {
  const [text, setText] = useState('Hello, World! 👋🏽 Ünïcödé stays intact.\nSecond line 🇵🇰 here.');
  const modes = useMemo(() => [
    { id: 'chars', label: 'Reverse characters', hint: 'Grapheme-safe: emoji, flags and accents stay whole', out: reverseChars(text) },
    { id: 'words', label: 'Reverse word order', hint: 'Per line', out: reverseWords(text) },
    { id: 'lines', label: 'Reverse line order', hint: '', out: reverseLines(text) },
    { id: 'each', label: 'Reverse each word', hint: 'Letters of each word, word order kept', out: reverseEachWord(text) },
    { id: 'flip', label: 'Upside down', hint: 'Rotated 180° with Unicode look-alikes', out: upsideDown(text) },
  ], [text]);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => setText('')}><Eraser /> Clear</Button>}>Input</FieldLabel>
        <Textarea className={cn(FIXED, 'h-28 text-sm')} value={text} onChange={e => setText(e.target.value)} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {modes.map(m => (
          <div key={m.id} className="space-y-1.5 min-w-0">
            <FieldLabel action={<div className="flex gap-1"><Button variant="ghost" size="xs" onClick={() => setText(m.out)} title="Use as input"><RefreshCw /></Button><CopyButton value={m.out} label="Copy" /></div>}>
              {m.label}{m.hint && <span className="font-normal text-muted-foreground/70"> · {m.hint}</span>}
            </FieldLabel>
            <div className="rounded-md border border-border bg-secondary/40 px-2.5 py-2 text-sm whitespace-pre-wrap break-words min-h-16">{m.out || <span className="text-muted-foreground">—</span>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────── Lorem ipsum ─────────────────────────

export function LoremIpsumGenerator() {
  const [unit, setUnit] = useState<LoremUnit>('paragraphs');
  const [count, setCount] = useState(3);
  const [start, setStart] = useState(true);
  const [html, setHtml] = useState(false);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const out = useMemo(() => lorem({ unit, count: Number.isFinite(count) ? count : 1, startWithLorem: start, html, seed }), [unit, count, start, html, seed]);
  const words = (out.replace(/<[^>]+>/g, ' ').match(/\S+/g) ?? []).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <FieldLabel>Generate</FieldLabel>
          <Segmented<LoremUnit> value={unit} onChange={u => { setUnit(u); setCount(u === 'words' ? 50 : u === 'paragraphs' ? 3 : 5); }}
            options={[{ value: 'paragraphs', label: 'Paragraphs' }, { value: 'sentences', label: 'Sentences' }, { value: 'words', label: 'Words' }, { value: 'list', label: 'List items' }]} />
        </div>
        <NumberField label="How many" value={count} onChange={v => setCount(Math.max(1, Math.min(1000, v)))} min={1} max={1000} className="w-28" />
        <div className="flex flex-col gap-1 pb-1">
          <Checkbox checked={start} onChange={setStart}>Start with “Lorem ipsum…”</Checkbox>
          <Checkbox checked={html} onChange={setHtml}>Wrap in HTML tags</Checkbox>
        </div>
        <Button variant="outline" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}><Shuffle /> Regenerate</Button>
      </div>
      <div className="space-y-1.5">
        <FieldLabel action={<div className="flex gap-1">
          <Button variant="ghost" size="xs" onClick={() => downloadBlob(out, html ? 'lorem.html' : 'lorem.txt', html ? 'text/html' : 'text/plain')}><Download /> Download</Button>
          <CopyButton value={out} label="Copy" />
        </div>}>{words.toLocaleString()} words · {out.length.toLocaleString()} characters</FieldLabel>
        <Textarea readOnly className={cn(FIXED, html ? MONO : 'text-sm leading-relaxed', 'h-80 bg-secondary/40')} value={out} />
      </div>
    </div>
  );
}

// ───────────────────────── Font pairing ─────────────────────────

type FontCat = 'serif' | 'sans-serif' | 'display' | 'monospace' | 'handwriting';
const FONTS: { family: string; cat: FontCat; weights: number[] }[] = [
  { family: 'Inter', cat: 'sans-serif', weights: [400, 600, 700] }, { family: 'Roboto', cat: 'sans-serif', weights: [400, 500, 700] },
  { family: 'Open Sans', cat: 'sans-serif', weights: [400, 600, 700] }, { family: 'Lato', cat: 'sans-serif', weights: [400, 700] },
  { family: 'Montserrat', cat: 'sans-serif', weights: [400, 600, 800] }, { family: 'Poppins', cat: 'sans-serif', weights: [400, 600, 700] },
  { family: 'Source Sans 3', cat: 'sans-serif', weights: [400, 600, 700] }, { family: 'Work Sans', cat: 'sans-serif', weights: [400, 600, 700] },
  { family: 'DM Sans', cat: 'sans-serif', weights: [400, 500, 700] }, { family: 'Manrope', cat: 'sans-serif', weights: [400, 600, 800] },
  { family: 'Nunito', cat: 'sans-serif', weights: [400, 700, 800] }, { family: 'Raleway', cat: 'sans-serif', weights: [400, 600, 800] },
  { family: 'Space Grotesk', cat: 'sans-serif', weights: [400, 500, 700] }, { family: 'IBM Plex Sans', cat: 'sans-serif', weights: [400, 600, 700] },
  { family: 'Karla', cat: 'sans-serif', weights: [400, 700] }, { family: 'Oswald', cat: 'sans-serif', weights: [400, 600, 700] },
  { family: 'Playfair Display', cat: 'serif', weights: [400, 700, 900] }, { family: 'Merriweather', cat: 'serif', weights: [400, 700, 900] },
  { family: 'Lora', cat: 'serif', weights: [400, 600, 700] }, { family: 'Libre Baskerville', cat: 'serif', weights: [400, 700] },
  { family: 'EB Garamond', cat: 'serif', weights: [400, 600, 700] }, { family: 'Cormorant Garamond', cat: 'serif', weights: [400, 600, 700] },
  { family: 'Source Serif 4', cat: 'serif', weights: [400, 600, 700] }, { family: 'Crimson Pro', cat: 'serif', weights: [400, 600, 700] },
  { family: 'PT Serif', cat: 'serif', weights: [400, 700] }, { family: 'Fraunces', cat: 'serif', weights: [400, 600, 800] },
  { family: 'DM Serif Display', cat: 'serif', weights: [400] }, { family: 'Bitter', cat: 'serif', weights: [400, 600, 700] },
  { family: 'Abril Fatface', cat: 'display', weights: [400] }, { family: 'Bebas Neue', cat: 'display', weights: [400] },
  { family: 'Archivo Black', cat: 'display', weights: [400] }, { family: 'Righteous', cat: 'display', weights: [400] },
  { family: 'Syne', cat: 'display', weights: [400, 600, 800] }, { family: 'Unbounded', cat: 'display', weights: [400, 600, 800] },
  { family: 'JetBrains Mono', cat: 'monospace', weights: [400, 700] }, { family: 'Fira Code', cat: 'monospace', weights: [400, 600] },
  { family: 'IBM Plex Mono', cat: 'monospace', weights: [400, 600] }, { family: 'Space Mono', cat: 'monospace', weights: [400, 700] },
  { family: 'Caveat', cat: 'handwriting', weights: [400, 700] }, { family: 'Pacifico', cat: 'handwriting', weights: [400] },
  { family: 'Dancing Script', cat: 'handwriting', weights: [400, 700] },
];

const PAIRS: { name: string; heading: string; body: string; mood: string }[] = [
  { name: 'Editorial', heading: 'Playfair Display', body: 'Source Sans 3', mood: 'Classic, magazine-like contrast' },
  { name: 'Modern SaaS', heading: 'Inter', body: 'Inter', mood: 'Neutral, highly legible UI' },
  { name: 'Friendly product', heading: 'Poppins', body: 'Lora', mood: 'Geometric headings, warm reading text' },
  { name: 'Tech startup', heading: 'Space Grotesk', body: 'DM Sans', mood: 'Quirky, technical, contemporary' },
  { name: 'Long-form blog', heading: 'Merriweather', body: 'Open Sans', mood: 'Comfortable for long reads' },
  { name: 'Luxury', heading: 'Cormorant Garamond', body: 'Montserrat', mood: 'Elegant, high-end' },
  { name: 'News', heading: 'Libre Baskerville', body: 'Roboto', mood: 'Authoritative and familiar' },
  { name: 'Bold poster', heading: 'Bebas Neue', body: 'Work Sans', mood: 'Loud headlines, clean copy' },
  { name: 'Literary', heading: 'EB Garamond', body: 'Crimson Pro', mood: 'Bookish, traditional' },
  { name: 'Developer docs', heading: 'IBM Plex Sans', body: 'IBM Plex Sans', mood: 'Pair with IBM Plex Mono for code' },
  { name: 'Playful', heading: 'Fraunces', body: 'Nunito', mood: 'Soft, characterful, approachable' },
  { name: 'Corporate', heading: 'Montserrat', body: 'Lato', mood: 'Clean and trustworthy' },
  { name: 'Portfolio', heading: 'Syne', body: 'Manrope', mood: 'Artsy, distinctive' },
  { name: 'Retro', heading: 'Abril Fatface', body: 'Karla', mood: 'Vintage display + simple sans' },
  { name: 'Handmade', heading: 'Caveat', body: 'Nunito', mood: 'Personal, informal' },
  { name: 'Terminal', heading: 'Space Mono', body: 'JetBrains Mono', mood: 'Monospaced everything' },
];

const fontSpec = (family: string) => FONTS.find(f => f.family === family) ?? { family, cat: 'sans-serif' as FontCat, weights: [400, 700] };
const familyParam = (family: string) => `family=${family.trim().replace(/ /g, '+')}:wght@${fontSpec(family).weights.join(';')}`;
const fallback = (cat: FontCat) => (cat === 'serif' ? 'serif' : cat === 'monospace' ? 'monospace' : cat === 'handwriting' ? 'cursive' : 'sans-serif');

function useGoogleFont(family: string) {
  useEffect(() => {
    if (!family) return;
    const id = `gf-${family.replace(/\W+/g, '-').toLowerCase()}`;
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?${familyParam(family)}&display=swap`;
    document.head.appendChild(link);
  }, [family]);
}

export function FontPairingTester() {
  const [heading, setHeading] = useState('Playfair Display');
  const [body, setBody] = useState('Source Sans 3');
  const [title, setTitle] = useState('The quiet art of making things well');
  const [sample, setSample] = useState('Good typography is invisible. It guides the eye, sets the tone and lets the words do their work. Pairing a distinctive heading face with a calm, readable body face creates hierarchy without noise — the reader simply feels that everything is in its right place.');
  const [hSize, setHSize] = useState(40);
  const [bSize, setBSize] = useState(17);
  const [lineHeight, setLineHeight] = useState(1.6);
  const [hWeight, setHWeight] = useState(700);
  const [dark, setDark] = useState(false);
  useGoogleFont(heading);
  useGoogleFont(body);

  const hSpec = fontSpec(heading);
  const bSpec = fontSpec(body);
  const families = [...new Set([heading, body])];
  const importCss = `@import url('https://fonts.googleapis.com/css2?${families.map(familyParam).join('&')}&display=swap');`;
  const css = `${importCss}

h1, h2, h3 {
  font-family: '${heading}', ${fallback(hSpec.cat)};
  font-weight: ${hWeight};
}

body {
  font-family: '${body}', ${fallback(bSpec.cat)};
  font-size: ${bSize}px;
  line-height: ${lineHeight};
}`;
  const linkHtml = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${families.map(familyParam).join('&')}&display=swap" rel="stylesheet">`;
  const fontOptions = (['sans-serif', 'serif', 'display', 'monospace', 'handwriting'] as FontCat[]).flatMap(c =>
    FONTS.filter(f => f.cat === c).map(f => ({ value: f.family, label: `${f.family} · ${c}` })));
  const weightOptions = hSpec.weights.map(w => ({ value: String(w), label: String(w) }));

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
        {PAIRS.map(p => (
          <button key={p.name} type="button" title={p.mood}
            onClick={() => { setHeading(p.heading); setBody(p.body); setHWeight(fontSpec(p.heading).weights.at(-1)!); }}
            className={cn('shrink-0 rounded-md border px-2.5 py-1.5 text-left text-xs cursor-pointer transition-colors',
              heading === p.heading && body === p.body ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/40')}>
            <span className="block font-medium">{p.name}</span>
            <span className="block text-[10px] text-muted-foreground whitespace-nowrap">{p.heading} + {p.body}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5"><FieldLabel>Heading font</FieldLabel><NativeSelect value={heading} onChange={v => { setHeading(v); setHWeight(fontSpec(v).weights.at(-1)!); }} options={fontOptions} /></div>
        <div className="space-y-1.5"><FieldLabel>Body font</FieldLabel><NativeSelect value={body} onChange={setBody} options={fontOptions} /></div>
        <div className="space-y-1.5"><FieldLabel>Heading weight</FieldLabel><NativeSelect value={String(hWeight)} onChange={v => setHWeight(Number(v))} options={weightOptions} /></div>
        <div className="flex items-end pb-1.5"><Checkbox checked={dark} onChange={setDark}>Dark preview</Checkbox></div>
        <RangeField label="Heading size" value={hSize} min={20} max={80} onChange={setHSize} suffix="px" />
        <RangeField label="Body size" value={bSize} min={12} max={24} onChange={setBSize} suffix="px" />
        <RangeField label="Line height" value={lineHeight} min={1.1} max={2.2} step={0.05} onChange={setLineHeight} />
        <div className="flex items-end">
          <Button variant="outline" size="sm" onClick={() => {
            const pick = (cats: FontCat[]) => { const l = FONTS.filter(f => cats.includes(f.cat)); return l[Math.floor(Math.random() * l.length)].family; };
            const h = pick(['serif', 'display', 'sans-serif']);
            setHeading(h); setHWeight(fontSpec(h).weights.at(-1)!); setBody(pick(['sans-serif', 'serif']));
          }}><Shuffle /> Random pair</Button>
        </div>
      </div>

      <div className="rounded-lg border border-border p-5 sm:p-8 space-y-4 overflow-hidden" style={{ background: dark ? '#111318' : '#fdfcf9', color: dark ? '#e8e6e1' : '#1d1d1f' }}>
        <h2 contentEditable suppressContentEditableWarning onBlur={e => setTitle(e.currentTarget.textContent || '')}
          className="outline-none break-words" style={{ fontFamily: `'${heading}', ${fallback(hSpec.cat)}`, fontSize: hSize, fontWeight: hWeight, lineHeight: 1.15 }}>
          {title}
        </h2>
        <p className="text-sm opacity-60" style={{ fontFamily: `'${body}', ${fallback(bSpec.cat)}` }}>{heading} {hWeight} / {body} {bSize}px · line-height {lineHeight}</p>
        <p style={{ fontFamily: `'${body}', ${fallback(bSpec.cat)}`, fontSize: bSize, lineHeight }}>{sample}</p>
        <h3 style={{ fontFamily: `'${heading}', ${fallback(hSpec.cat)}`, fontSize: Math.round(hSize * 0.6), fontWeight: hWeight, lineHeight: 1.2 }}>A smaller subheading</h3>
        <p style={{ fontFamily: `'${body}', ${fallback(bSpec.cat)}`, fontSize: bSize, lineHeight }}>
          <b>Bold text</b>, <i>italic text</i> and numbers 0123456789 — check how the body face handles emphasis, figures and punctuation “like this”.
        </p>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-md px-4 py-2 text-sm" style={{ fontFamily: `'${body}', ${fallback(bSpec.cat)}`, fontWeight: 600, background: dark ? '#e8e6e1' : '#1d1d1f', color: dark ? '#111318' : '#fdfcf9' }}>Get started</span>
          <span className="rounded-md px-4 py-2 text-sm border" style={{ fontFamily: `'${body}', ${fallback(bSpec.cat)}`, borderColor: dark ? '#444' : '#ccc' }}>Learn more</span>
        </div>
      </div>

      <div className="space-y-1.5">
        <FieldLabel>Sample paragraph</FieldLabel>
        <Textarea className={cn(FIXED, 'h-20 text-sm')} value={sample} onChange={e => setSample(e.target.value)} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<CopyButton value={css} label="Copy" />}>CSS</FieldLabel>
          <pre className={cn(MONO, 'rounded-md border border-border bg-secondary/40 p-2.5 overflow-x-auto whitespace-pre')}>{css}</pre>
        </div>
        <div className="space-y-1.5 min-w-0">
          <FieldLabel action={<CopyButton value={linkHtml} label="Copy" />}>HTML &lt;head&gt;</FieldLabel>
          <pre className={cn(MONO, 'rounded-md border border-border bg-secondary/40 p-2.5 overflow-x-auto whitespace-pre')}>{linkHtml}</pre>
        </div>
      </div>
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
