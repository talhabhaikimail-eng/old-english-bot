import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Download, Eraser, Loader2, Plus, RotateCcw, Shuffle, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { MONO, FIXED, Checkbox, CopyButton, ErrorBox, FieldLabel, InfoBox, NumberField, Segmented, Stat, downloadBlob, toolsApi } from './shared';

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

function LoadFileButton({ onText }: { onText: (t: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="ghost" size="xs" onClick={() => ref.current?.click()}><Upload /> Open</Button>
      <input ref={ref} type="file" className="hidden" accept=".txt,.md,.markdown,.json,.csv,.html,.xml,.py,.ts,.js,.log,text/*" onChange={async e => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) onText(await f.text());
      }} />
    </>
  );
}

const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d });
/** Rough GPT-style estimate used where an exact count isn't needed (≈ 4 chars per token). */
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

// Token / chunk colours live only inside visualisations (allowed to be hard-coded).
const VIZ = ['rgba(99,102,241,0.28)', 'rgba(16,185,129,0.28)', 'rgba(245,158,11,0.30)', 'rgba(236,72,153,0.26)', 'rgba(14,165,233,0.28)', 'rgba(132,204,22,0.30)'];

// ───────────────────────── Token counter ─────────────────────────

interface TokensResult {
  chars: number; words: number; bytes: number; lines: number;
  encodings: Record<string, { label: string; tokens: number }>;
  estimates: Record<'claude' | 'gemini', { label: string; tokens: number; method: string }>;
  visualized: { encoding: string; truncated: boolean; pieces: { text: string; ids: number[] }[] };
}

type CounterKey = 'o200k_base' | 'cl100k_base' | 'claude' | 'gemini';
interface PriceRow { model: string; counter: CounterKey; input: number; output: number }

// Defaults as of late 2026 — clearly editable; providers change prices often.
const DEFAULT_PRICES: PriceRow[] = [
  { model: 'GPT-5', counter: 'o200k_base', input: 1.25, output: 10 },
  { model: 'GPT-5 mini', counter: 'o200k_base', input: 0.25, output: 2 },
  { model: 'GPT-4.1', counter: 'o200k_base', input: 2, output: 8 },
  { model: 'GPT-4o', counter: 'o200k_base', input: 2.5, output: 10 },
  { model: 'GPT-4o mini', counter: 'o200k_base', input: 0.15, output: 0.6 },
  { model: 'o4-mini', counter: 'o200k_base', input: 1.1, output: 4.4 },
  { model: 'Claude Opus 5.5', counter: 'claude', input: 4, output: 20 },
  { model: 'Claude Sonnet 5.5', counter: 'claude', input: 2, output: 10 },
  { model: 'Claude Haiku 5.5', counter: 'claude', input: 0.1, output: 0.5 },
  { model: 'Gemini 2.5 Pro', counter: 'gemini', input: 1.25, output: 10 },
  { model: 'Gemini 2.5 Flash', counter: 'gemini', input: 0.3, output: 2.5 },
];
const PRICE_KEY = 'devtools.tokenPrices.v1';

function loadPrices(): PriceRow[] {
  try { const v = JSON.parse(localStorage.getItem(PRICE_KEY) || 'null'); if (Array.isArray(v) && v.length) return v; } catch { /* ignore */ }
  return DEFAULT_PRICES;
}

const COUNTER_LABEL: Record<CounterKey, string> = { o200k_base: 'o200k (exact)', cl100k_base: 'cl100k (exact)', claude: 'Claude (est.)', gemini: 'Gemini (est.)' };

const SAMPLE_PROMPT = `You are a senior support engineer for Acme Cloud. Answer the customer's question using only the documentation excerpts provided.

<documents>
Acme Cloud Storage buckets are private by default. To share a file publicly, generate a signed URL (valid for up to 7 days) or enable public access on the bucket in Settings → Access.
</documents>

Customer: Hi! How can I share a single file with a partner for a week without making the whole bucket public? 🙏`;

const money = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`);

export function TokenCounter() {
  const [text, setText] = useState(SAMPLE_PROMPT);
  const [res, setRes] = useState<TokensResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [vizEnc, setVizEnc] = useState<'o200k_base' | 'cl100k_base'>('o200k_base');
  const [showIds, setShowIds] = useState(false);
  const [prices, setPrices] = useState<PriceRow[]>(loadPrices);
  const [outTokens, setOutTokens] = useState(500);
  const [requests, setRequests] = useState(1000);
  const debounced = useDebounced(text, text.length > 200_000 ? 900 : 350);

  useEffect(() => { try { localStorage.setItem(PRICE_KEY, JSON.stringify(prices)); } catch { /* ignore */ } }, [prices]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    toolsApi.post<TokensResult>('/ai/tokens', { text: debounced, encodings: ['o200k_base', 'cl100k_base'], visualize: vizEnc })
      .then(r => { if (alive) { setRes(r); setError(''); } })
      .catch(e => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [debounced, vizEnc]);

  const countFor = (c: CounterKey) => (!res ? 0 : c === 'claude' || c === 'gemini' ? res.estimates[c].tokens : res.encodings[c]?.tokens ?? 0);
  const setRow = (i: number, patch: Partial<PriceRow>) => setPrices(p => p.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldLabel action={<div className="flex items-center gap-1">
          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <LoadFileButton onText={setText} />
          <Button variant="ghost" size="xs" onClick={() => setText('')}><Eraser /> Clear</Button>
        </div>}>Prompt / text (up to 2 MB)</FieldLabel>
        <Textarea className={cn(FIXED, MONO, 'h-48')} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
      </div>
      {error && <ErrorBox message={error} />}

      {res && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label="GPT-4o / 4.1 / 5 / o-series" value={fmt(res.encodings.o200k_base?.tokens ?? 0)} hint="o200k_base · exact" />
          <Stat label="GPT-4 / 3.5 / embeddings-3" value={fmt(res.encodings.cl100k_base?.tokens ?? 0)} hint="cl100k_base · exact" />
          <Stat label="Claude (estimate)" value={`≈ ${fmt(res.estimates.claude.tokens)}`} hint={res.estimates.claude.method} />
          <Stat label="Gemini (estimate)" value={`≈ ${fmt(res.estimates.gemini.tokens)}`} hint={res.estimates.gemini.method} />
          <Stat label="Characters" value={fmt(res.chars)} />
          <Stat label="Words" value={fmt(res.words)} />
          <Stat label="UTF-8 bytes" value={fmt(res.bytes)} />
          <Stat label="Chars / token (o200k)" value={res.encodings.o200k_base?.tokens ? (res.chars / res.encodings.o200k_base.tokens).toFixed(2) : '—'} />
        </div>
      )}

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Cost estimate</CardTitle>
          <CardDescription className="text-xs">Prices are USD per 1M tokens — <b>defaults may be out of date: edit them to match current pricing</b> (saved in this browser).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <NumberField label="Expected output tokens / request" value={outTokens} onChange={v => setOutTokens(Math.max(0, v || 0))} min={0} className="w-56" />
            <NumberField label="Number of requests" value={requests} onChange={v => setRequests(Math.max(1, v || 1))} min={1} className="w-40" />
            <div className="flex items-end gap-1">
              <Button variant="outline" size="sm" onClick={() => setPrices(p => [...p, { model: 'Custom model', counter: 'o200k_base', input: 1, output: 4 }])}><Plus /> Add model</Button>
              <Button variant="ghost" size="sm" onClick={() => setPrices(DEFAULT_PRICES)}><RotateCcw /> Reset</Button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs min-w-[640px]">
              <thead className="bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Model</th><th className="px-2 py-1.5 text-left font-medium">Tokenizer</th>
                  <th className="px-2 py-1.5 text-right font-medium">Input $/1M</th><th className="px-2 py-1.5 text-right font-medium">Output $/1M</th>
                  <th className="px-2 py-1.5 text-right font-medium">Input tokens</th><th className="px-2 py-1.5 text-right font-medium">Per request</th>
                  <th className="px-2 py-1.5 text-right font-medium">× {fmt(requests)}</th><th />
                </tr>
              </thead>
              <tbody>
                {prices.map((r, i) => {
                  const tin = countFor(r.counter);
                  const per = (tin * r.input + outTokens * r.output) / 1e6;
                  return (
                    <tr key={i} className="border-t border-border">
                      <td className="px-1 py-1"><Input value={r.model} onChange={e => setRow(i, { model: e.target.value })} className="h-7 text-xs min-w-32" /></td>
                      <td className="px-1 py-1 w-32"><NativeSelect<CounterKey> value={r.counter} onChange={v => setRow(i, { counter: v })} className="h-7" options={(Object.keys(COUNTER_LABEL) as CounterKey[]).map(k => ({ value: k, label: COUNTER_LABEL[k] }))} /></td>
                      <td className="px-1 py-1 w-24"><Input type="number" step="0.01" min={0} value={r.input} onChange={e => setRow(i, { input: Number(e.target.value) || 0 })} className="h-7 text-xs text-right" /></td>
                      <td className="px-1 py-1 w-24"><Input type="number" step="0.01" min={0} value={r.output} onChange={e => setRow(i, { output: Number(e.target.value) || 0 })} className="h-7 text-xs text-right" /></td>
                      <td className="px-2 py-1 text-right tabular-nums">{r.counter === 'claude' || r.counter === 'gemini' ? '≈ ' : ''}{fmt(tin)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{money(per)}</td>
                      <td className="px-2 py-1 text-right tabular-nums font-medium">{money(per * requests)}</td>
                      <td className="px-1 py-1"><Button variant="ghost" size="icon-xs" title="Remove" onClick={() => setPrices(p => p.filter((_, j) => j !== i))}><Trash2 /></Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">Claude and Gemini tokenizers can't be run offline, so their counts are heuristics (typically within ±15% for English; newer Claude models can use noticeably more tokens). Use the provider's count-tokens API for exact numbers. Caching, batch discounts and long-context surcharges aren't included.</p>
        </CardContent>
      </Card>

      {res && (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm flex flex-wrap items-center gap-2">
              Token visualisation
              <Segmented value={vizEnc} onChange={setVizEnc} options={[{ value: 'o200k_base', label: 'o200k' }, { value: 'cl100k_base', label: 'cl100k' }]} />
              <Checkbox checked={showIds} onChange={setShowIds}>Show token IDs</Checkbox>
            </CardTitle>
            {res.visualized.truncated && <CardDescription className="text-xs">Showing the first {fmt(res.visualized.pieces.reduce((s, p) => s + p.ids.length, 0))} tokens.</CardDescription>}
          </CardHeader>
          <CardContent>
            <div className="max-h-96 overflow-y-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs leading-6 whitespace-pre-wrap break-words">
              {res.visualized.pieces.map((p, i) => (
                <span key={i} title={`#${i} · id ${p.ids.join(', ')}`} className="rounded-[3px] text-foreground" style={{ background: VIZ[i % VIZ.length] }}>
                  {showIds ? `${p.ids.join('·')} ` : p.text.replace(/\n/g, '↵\n').replace(/\t/g, '⇥') || '·'}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ───────────────────────── System prompt builder ─────────────────────────

interface PromptFields {
  role: string; context: string; task: string; constraints: string; tone: string; format: string;
  examples: { input: string; output: string }[]; tools: string; refusals: string;
}

const EMPTY_FIELDS: PromptFields = { role: '', context: '', task: '', constraints: '', tone: '', format: '', examples: [], tools: '', refusals: '' };

const TEMPLATES: Record<string, { label: string; fields: PromptFields }> = {
  support: { label: 'Customer support agent', fields: {
    role: 'You are a friendly, precise customer-support agent for Acme Cloud, a file storage and sharing service.',
    context: 'Customers are small-business owners, often non-technical. You can see the account plan and the documentation excerpts provided in each conversation.',
    task: 'Answer the customer\'s question, troubleshoot step by step, and resolve the issue in as few messages as possible.',
    constraints: '- Only use facts from the provided documentation; if something is not covered, say so and offer to escalate.\n- Never ask for passwords or full card numbers.\n- Keep answers under 150 words unless steps are required.',
    tone: 'Warm, plain-language, confident. No jargon unless the customer uses it first.',
    format: 'Short paragraphs. Use a numbered list for multi-step instructions. End with a one-line check-in question.',
    examples: [{ input: 'How do I share a file with someone outside my company?', output: 'You can create a share link:\n1. Open the file and click Share.\n2. Choose "Anyone with the link" and set an expiry.\n3. Copy the link and send it.\nWant me to walk you through setting a password on the link too?' }],
    tools: 'lookup_account(email) — returns plan and usage.\ncreate_ticket(summary, priority) — escalates to a human.',
    refusals: 'Politely decline requests unrelated to Acme Cloud, legal or financial advice, and anything that would expose another customer\'s data.',
  } },
  code: { label: 'Code reviewer', fields: {
    role: 'You are a senior software engineer performing code review.',
    context: 'The team writes TypeScript (Node 20, React 18) and values readability, correctness and test coverage over cleverness.',
    task: 'Review the diff you are given. Identify bugs, security issues, performance problems and unclear code, and suggest concrete fixes.',
    constraints: '- Prioritise correctness and security findings.\n- Quote the exact line(s) you are commenting on.\n- Do not rewrite the whole file; suggest minimal changes.',
    tone: 'Direct and constructive, like a respected colleague.',
    format: 'A list of findings, each with: severity (high/medium/low), location, problem, suggested fix. Finish with a one-sentence overall verdict.',
    examples: [], tools: '', refusals: 'If asked to review code for malware or exploitation of systems you are not authorised to test, decline.',
  } },
  extract: { label: 'Data extractor (JSON)', fields: {
    role: 'You are a meticulous data-extraction engine.',
    context: 'Inputs are unstructured invoices and receipts pasted as text (OCR output may contain errors).',
    task: 'Extract the vendor name, invoice number, issue date, currency, line items and total.',
    constraints: '- Output valid JSON only, no commentary.\n- Use null for missing fields; never guess.\n- Dates in ISO-8601 (YYYY-MM-DD). Amounts as numbers.',
    tone: '',
    format: '{"vendor": string|null, "invoice_number": string|null, "date": string|null, "currency": string|null, "items": [{"description": string, "quantity": number, "unit_price": number}], "total": number|null}',
    examples: [], tools: '', refusals: '',
  } },
  editor: { label: 'Writing editor', fields: {
    role: 'You are an experienced copy editor.',
    context: 'Users paste drafts of blog posts, emails and documentation.',
    task: 'Improve clarity, concision and flow while preserving the author\'s voice and meaning.',
    constraints: '- Do not add new facts or claims.\n- Keep the original structure unless it is clearly confusing.\n- Flag (do not fix) statements that look factually wrong.',
    tone: 'Neutral and professional.',
    format: 'First the edited text, then a bullet list "Changes" summarising the most important edits (max 5).',
    examples: [], tools: '', refusals: '',
  } },
  tutor: { label: 'Socratic tutor', fields: {
    role: 'You are a patient tutor for high-school mathematics.',
    context: 'Students are 14–18 years old and may be anxious about maths.',
    task: 'Help the student solve the problem themselves by asking guiding questions, one step at a time.',
    constraints: '- Never give the final answer outright unless the student has tried at least twice.\n- Check understanding before moving on.\n- Use LaTeX for formulas.',
    tone: 'Encouraging, curious, never condescending.',
    format: 'One short explanation or hint plus exactly one question per message.',
    examples: [], tools: '', refusals: 'If asked to complete graded homework or exams directly, explain you can help them learn the method instead.',
  } },
};

function assemblePrompt(f: PromptFields, style: 'xml' | 'markdown'): string {
  const sections: [string, string, string][] = [
    ['role', 'Role', f.role], ['context', 'Context', f.context], ['task', 'Task', f.task], ['constraints', 'Constraints', f.constraints],
    ['tone', 'Tone & style', f.tone], ['output_format', 'Output format', f.format], ['tools', 'Tools', f.tools], ['refusals', 'When to decline', f.refusals],
  ];
  const ex = f.examples.filter(e => e.input.trim() || e.output.trim());
  const out: string[] = [];
  for (const [tag, title, body] of sections) {
    const b = body.trim();
    if (!b) continue;
    if (tag === 'role' && style === 'markdown') { out.push(b); continue; }
    out.push(style === 'xml' ? `<${tag}>\n${b}\n</${tag}>` : `## ${title}\n${b}`);
  }
  if (ex.length) {
    out.push(style === 'xml'
      ? `<examples>\n${ex.map(e => `<example>\n<input>\n${e.input.trim()}\n</input>\n<ideal_output>\n${e.output.trim()}\n</ideal_output>\n</example>`).join('\n')}\n</examples>`
      : `## Examples\n${ex.map((e, i) => `### Example ${i + 1}\n**Input:**\n${e.input.trim()}\n\n**Ideal output:**\n${e.output.trim()}`).join('\n\n')}`);
  }
  return out.join('\n\n');
}

export function SystemPromptBuilder() {
  const [f, setF] = useState<PromptFields>(TEMPLATES.support.fields);
  const [style, setStyle] = useState<'xml' | 'markdown'>('xml');
  const [tpl, setTpl] = useState('support');
  const set = <K extends keyof PromptFields>(k: K, v: PromptFields[K]) => setF(p => ({ ...p, [k]: v }));
  const prompt = useMemo(() => assemblePrompt(f, style), [f, style]);
  const missing = (['role', 'task'] as const).filter(k => !f[k].trim());

  const field = (k: Exclude<keyof PromptFields, 'examples'>, label: string, hint: string, rows = 'h-20') => (
    <div className="space-y-1.5">
      <FieldLabel>{label}</FieldLabel>
      <Textarea className={cn(FIXED, rows, 'text-xs')} value={f[k]} onChange={e => set(k, e.target.value)} placeholder={hint} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5 w-full sm:w-64">
          <FieldLabel>Template</FieldLabel>
          <NativeSelect value={tpl} onChange={v => { setTpl(v); setF(v === 'blank' ? EMPTY_FIELDS : TEMPLATES[v].fields); }}
            options={[...Object.entries(TEMPLATES).map(([value, t]) => ({ value, label: t.label })), { value: 'blank', label: 'Blank' }]} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Style</FieldLabel>
          <Segmented value={style} onChange={setStyle} options={[{ value: 'xml', label: 'XML tags' }, { value: 'markdown', label: 'Markdown' }]} />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 min-w-0">
          {field('role', 'Role / persona', 'Who the model is, e.g. "You are a senior data analyst…"', 'h-14')}
          {field('context', 'Context', 'Audience, product, background knowledge the model needs')}
          {field('task', 'Task', 'What the model should do in each conversation')}
          {field('constraints', 'Constraints & rules', 'One rule per line — must / must not')}
          {field('tone', 'Tone & style', 'e.g. concise, friendly, formal…', 'h-14')}
          {field('format', 'Output format', 'Structure, length, JSON schema, headings…')}
          <div className="space-y-1.5">
            <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => set('examples', [...f.examples, { input: '', output: '' }])}><Plus /> Add example</Button>}>Examples (few-shot)</FieldLabel>
            {f.examples.length === 0 && <p className="text-[11px] text-muted-foreground">Examples are the most reliable way to show the exact format and quality you want.</p>}
            {f.examples.map((ex, i) => (
              <div key={i} className="rounded-md border border-border p-2 space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">Example {i + 1}
                  <Button variant="ghost" size="icon-xs" title="Remove" onClick={() => set('examples', f.examples.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
                <Textarea className={cn(FIXED, 'h-14 text-xs')} value={ex.input} placeholder="User input" onChange={e => set('examples', f.examples.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)))} />
                <Textarea className={cn(FIXED, 'h-16 text-xs')} value={ex.output} placeholder="Ideal response" onChange={e => set('examples', f.examples.map((x, j) => (j === i ? { ...x, output: e.target.value } : x)))} />
              </div>
            ))}
          </div>
          {field('tools', 'Tools available (optional)', 'name(args) — when to use it', 'h-14')}
          {field('refusals', 'When to decline (optional)', 'Out-of-scope or unsafe requests and how to respond', 'h-14')}
        </div>
        <div className="space-y-1.5 min-w-0 lg:sticky lg:top-2 self-start">
          <FieldLabel action={<div className="flex gap-1">
            <Button variant="ghost" size="xs" disabled={!prompt} onClick={() => downloadBlob(prompt, style === 'xml' ? 'system-prompt.txt' : 'system-prompt.md')}><Download /> Download</Button>
            <CopyButton value={prompt} label="Copy" />
          </div>}>Assembled prompt · ≈ {fmt(estimateTokens(prompt))} tokens · {fmt(prompt.length)} chars</FieldLabel>
          <Textarea readOnly className={cn(MONO, FIXED, 'h-[36rem] bg-secondary/40')} value={prompt} />
          {missing.length > 0 && <InfoBox>Add a {missing.join(' and a ')} — they're the core of an effective system prompt.</InfoBox>}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Text to embeddings ─────────────────────────

interface EmbedResult { model: string; dimensions: number; taskType: string; embeddings: { text: string; norm: number; values: number[] }[]; similarity: number[][] }

const SAMPLE_TEXTS = [
  'How do I reset my password?',
  'I forgot my login credentials and can\'t sign in.',
  'What are your opening hours on weekends?',
  'The cat is sleeping on the warm windowsill.',
  'A kitten naps in the sunshine by the window.',
];

/** Diverging-ish scale for cosine similarity (viz-only colours). */
function simColor(v: number) {
  const t = Math.max(0, Math.min(1, (v - 0.3) / 0.7));
  return `hsla(${220 - t * 200}, 85%, ${55 - t * 10}%, ${0.15 + t * 0.75})`;
}

export function TextToEmbeddings() {
  const [texts, setTexts] = useState<string[]>(SAMPLE_TEXTS);
  const [dims, setDims] = useState('768');
  const [task, setTask] = useState('SEMANTIC_SIMILARITY');
  const [res, setRes] = useState<EmbedResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true); setError('');
    try {
      setRes(await toolsApi.post<EmbedResult>('/ai/embeddings', { texts: texts.filter(t => t.trim()), dimensions: Number(dims), taskType: task }));
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  };

  const pairs = useMemo(() => {
    if (!res) return [];
    const out: { a: number; b: number; s: number }[] = [];
    res.similarity.forEach((row, i) => row.forEach((s, j) => { if (j > i) out.push({ a: i, b: j, s }); }));
    return out.sort((x, y) => y.s - x.s);
  }, [res]);

  const json = useMemo(() => (res ? JSON.stringify({ model: res.model, dimensions: res.dimensions, taskType: res.taskType, embeddings: res.embeddings.map(e => ({ text: e.text, embedding: e.values })) }) : ''), [res]);
  const short = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <FieldLabel action={<div className="flex gap-1">
          <Button variant="ghost" size="xs" disabled={texts.length >= 20} onClick={() => setTexts(t => [...t, ''])}><Plus /> Add text</Button>
          <Button variant="ghost" size="xs" onClick={() => setTexts([''])}><Eraser /> Clear</Button>
        </div>}>Texts ({texts.length}/20)</FieldLabel>
        {texts.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
            <Input value={t} onChange={e => setTexts(ts => ts.map((x, j) => (j === i ? e.target.value : x)))} placeholder="Sentence, query or passage…" className="text-xs" />
            <Button variant="ghost" size="icon-xs" title="Remove" disabled={texts.length <= 1} onClick={() => setTexts(ts => ts.filter((_, j) => j !== i))}><Trash2 /></Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5 w-32">
          <FieldLabel>Dimensions</FieldLabel>
          <NativeSelect value={dims} onChange={setDims} options={['128', '256', '512', '768', '1536', '3072'].map(v => ({ value: v, label: v }))} />
        </div>
        <div className="space-y-1.5 w-56">
          <FieldLabel>Task type</FieldLabel>
          <NativeSelect value={task} onChange={setTask} options={[
            { value: 'SEMANTIC_SIMILARITY', label: 'Semantic similarity' }, { value: 'RETRIEVAL_DOCUMENT', label: 'Retrieval — document' },
            { value: 'RETRIEVAL_QUERY', label: 'Retrieval — query' }, { value: 'CLASSIFICATION', label: 'Classification' }, { value: 'CLUSTERING', label: 'Clustering' },
            { value: 'QUESTION_ANSWERING', label: 'Question answering' }, { value: 'FACT_VERIFICATION', label: 'Fact verification' }, { value: 'CODE_RETRIEVAL_QUERY', label: 'Code retrieval query' },
          ]} />
        </div>
        <Button onClick={run} disabled={loading || !texts.some(t => t.trim())}>{loading ? <Loader2 className="animate-spin" /> : <Brain />} Generate embeddings</Button>
        <span className="text-[11px] text-muted-foreground">Model: gemini-embedding-001 (runs on the server with its Gemini key)</span>
      </div>
      {error && <ErrorBox message={error} />}

      {res && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-sm">Cosine similarity</CardTitle>
                <CardDescription className="text-xs">1.0 = identical meaning. Hover a cell for the pair.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="text-[11px] border-separate border-spacing-0.5">
                    <thead><tr><th />{res.embeddings.map((_, j) => <th key={j} className="w-12 font-medium text-muted-foreground">{j + 1}</th>)}</tr></thead>
                    <tbody>
                      {res.similarity.map((row, i) => (
                        <tr key={i}>
                          <th className="pr-2 text-left font-normal text-muted-foreground whitespace-nowrap max-w-48 truncate" title={res.embeddings[i].text}>{i + 1}. {short(res.embeddings[i].text)}</th>
                          {row.map((s, j) => (
                            <td key={j} title={`${i + 1} ↔ ${j + 1}: ${s.toFixed(4)}`} className="w-12 h-9 text-center tabular-nums rounded text-foreground" style={{ background: simColor(s) }}>{s.toFixed(2)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader><CardTitle className="text-sm">Most similar pairs</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 max-h-80 overflow-y-auto">
                {pairs.slice(0, 15).map(p => (
                  <div key={`${p.a}-${p.b}`} className="flex items-center gap-2 text-xs">
                    <span className="w-12 shrink-0 tabular-nums font-medium">{p.s.toFixed(3)}</span>
                    <span className="flex-1 min-w-0 truncate" title={`${res.embeddings[p.a].text} ↔ ${res.embeddings[p.b].text}`}>{p.a + 1}. {short(res.embeddings[p.a].text, 24)} ↔ {p.b + 1}. {short(res.embeddings[p.b].text, 24)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                Vectors <Badge variant="secondary">{res.dimensions} dims</Badge> <Badge variant="outline">{res.model}</Badge>
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" size="xs" onClick={() => downloadBlob(json, 'embeddings.json', 'application/json')}><Download /> JSON</Button>
                  <CopyButton value={json} label="Copy JSON" />
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {res.embeddings.map((e, i) => {
                const preview = e.values.slice(0, 48);
                const max = Math.max(...preview.map(Math.abs), 1e-9);
                return (
                  <div key={i} className="rounded-md border border-border p-2 space-y-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="flex-1 min-w-0 truncate">{i + 1}. {e.text}</span>
                      <span className="text-muted-foreground tabular-nums shrink-0">‖v‖ {e.norm.toFixed(3)}</span>
                      <CopyButton value={JSON.stringify(e.values)} />
                    </div>
                    <div className="flex h-6 items-center gap-px" title="First 48 dimensions">
                      {preview.map((v, j) => (
                        <span key={j} className="flex-1 rounded-[1px]" style={{ height: `${Math.max(8, (Math.abs(v) / max) * 100)}%`, background: v >= 0 ? 'rgba(99,102,241,0.75)' : 'rgba(244,63,94,0.75)' }} />
                      ))}
                    </div>
                    <p className={cn(MONO, 'text-[10px] text-muted-foreground truncate')}>[{e.values.slice(0, 8).map(v => v.toFixed(5)).join(', ')}, …]</p>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ───────────────────────── AI image prompt generator ─────────────────────────

const IMG = {
  style: ['photorealistic', 'cinematic film still', 'editorial photography', 'studio product shot', 'digital painting', 'watercolor illustration', 'oil painting', 'flat vector illustration', 'isometric 3D render', 'claymation', 'low-poly 3D', 'anime cel shading', 'comic book ink', 'pixel art', 'charcoal sketch', 'ukiyo-e woodblock print', 'art nouveau poster', 'synthwave', 'minimalist line art', 'papercraft diorama'],
  lighting: ['soft natural window light', 'golden hour backlight', 'blue hour ambience', 'dramatic rim lighting', 'overcast diffused light', 'neon glow', 'candlelight', 'studio softbox lighting', 'harsh midday sun', 'volumetric god rays', 'bioluminescent glow', 'moody low-key lighting'],
  camera: ['35mm lens', '50mm f/1.8', '85mm portrait lens, shallow depth of field', '24mm wide angle', '200mm telephoto compression', 'macro lens, extreme close-up', 'tilt-shift miniature effect', 'fisheye lens', 'drone aerial view', 'shot on medium-format film', 'anamorphic lens flare'],
  composition: ['rule of thirds', 'centered symmetrical composition', 'low-angle hero shot', 'top-down flat lay', 'over-the-shoulder', 'close-up portrait', 'wide establishing shot', 'leading lines', 'negative space', 'dutch angle'],
  mood: ['serene', 'whimsical', 'mysterious', 'nostalgic', 'epic', 'cozy', 'melancholic', 'energetic', 'dreamlike', 'ominous', 'joyful', 'futuristic'],
  palette: ['muted earth tones', 'pastel palette', 'vibrant complementary colors', 'monochrome black and white', 'teal and orange', 'warm amber and cream', 'cool blues and silver', 'neon magenta and cyan', 'forest greens and browns', 'duotone'],
  detail: ['highly detailed', 'intricate textures', 'sharp focus', 'film grain', 'bokeh', 'subsurface scattering', 'atmospheric haze', 'ray-traced reflections', 'clean background', 'award-winning composition'],
};
const SUBJECTS = ['a lighthouse keeper reading by a storm-lashed window', 'a fox in a knitted scarf exploring a snowy market', 'an astronaut tending a greenhouse on Mars', 'a vintage motorcycle parked outside a rainy Tokyo café', 'a giant whale floating above a desert town', 'a cozy reading nook built into a treehouse', 'a ceramic coffee cup with steam on a marble counter', 'an elderly baker shaping bread at dawn'];
const ASPECTS = ['1:1', '4:5', '3:2', '16:9', '9:16', '21:9', '2:3'];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

interface ImgFields {
  subject: string; style: string; lighting: string; camera: string; composition: string; mood: string; palette: string;
  details: string[]; aspect: string; negative: string; weight: number; mjVersion: string; mjStylize: number; mjRaw: boolean;
}

export function ImagePromptGenerator() {
  const [f, setF] = useState<ImgFields>({
    subject: 'a lighthouse keeper reading by a storm-lashed window', style: 'cinematic film still', lighting: 'candlelight', camera: '35mm lens',
    composition: 'rule of thirds', mood: 'cozy', palette: 'warm amber and cream', details: ['highly detailed', 'film grain'], aspect: '16:9',
    negative: 'blurry, low quality, extra fingers, watermark, text, deformed hands', weight: 1.2, mjVersion: '7', mjStylize: 250, mjRaw: true,
  });
  const set = <K extends keyof ImgFields>(k: K, v: ImgFields[K]) => setF(p => ({ ...p, [k]: v }));

  const parts = [f.style, f.lighting, f.camera, f.composition, f.mood && `${f.mood} mood`, f.palette, ...f.details].filter(Boolean);
  const midjourney = `${[f.subject, ...parts].filter(Boolean).join(', ')} --ar ${f.aspect} --v ${f.mjVersion} --stylize ${f.mjStylize}${f.mjRaw ? ' --style raw' : ''}${f.negative.trim() ? ` --no ${f.negative.split(',').map(s => s.trim()).filter(Boolean).join(', ')}` : ''}`;
  const sdxl = `(${f.subject}:${f.weight.toFixed(1)}), ${[f.style && `(${f.style}:1.1)`, ...parts.slice(1)].filter(Boolean).join(', ')}`;
  const [w, h] = f.aspect.split(':').map(Number);
  const sdxlSize = (() => { const area = 1024 * 1024; const width = Math.round(Math.sqrt(area * (w / h)) / 64) * 64; return `${width}×${Math.round(area / width / 64) * 64}`; })();
  const article = (s: string) => (/^[aeiou]/i.test(s) ? 'An' : 'A');
  const natural = f.subject.trim()
    ? `${f.style ? `${article(f.style)} ${f.style}` : 'An image'} of ${f.subject.trim()}. ${f.lighting ? `The scene is lit by ${f.lighting}` : ''}${f.palette ? `, with a ${f.palette} color palette` : ''}. ${f.mood ? `The overall mood is ${f.mood}.` : ''} ${f.camera || f.composition ? `Shot with ${[f.camera, f.composition].filter(Boolean).join(', using ')}.` : ''} ${f.details.length ? `${f.details.join(', ')}.`.replace(/^./, c => c.toUpperCase()) : ''} ${f.negative.trim() ? `Avoid: ${f.negative.trim()}.` : ''} Aspect ratio ${f.aspect}.`.replace(/\s+/g, ' ').replace(/ \./g, '.').trim()
    : '';

  const randomise = () => setF(p => ({
    ...p, subject: pick(SUBJECTS), style: pick(IMG.style), lighting: pick(IMG.lighting), camera: pick(IMG.camera), composition: pick(IMG.composition),
    mood: pick(IMG.mood), palette: pick(IMG.palette), details: [...new Set([pick(IMG.detail), pick(IMG.detail)])], aspect: pick(ASPECTS),
  }));

  const sel = (k: 'style' | 'lighting' | 'camera' | 'composition' | 'mood' | 'palette', label: string) => (
    <div className="space-y-1.5">
      <FieldLabel>{label}</FieldLabel>
      <NativeSelect value={f[k]} onChange={v => set(k, v)} options={[{ value: '', label: '— none —' }, ...IMG[k].map(v => ({ value: v, label: v }))]} />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldLabel action={<Button variant="ghost" size="xs" onClick={randomise}><Shuffle /> Randomise</Button>}>Subject</FieldLabel>
        <Textarea className={cn(FIXED, 'h-16 text-sm')} value={f.subject} onChange={e => set('subject', e.target.value)} placeholder="What should the image show? Be specific about who/what, action and setting." />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sel('style', 'Style / medium')}
        {sel('lighting', 'Lighting')}
        {sel('camera', 'Camera / lens')}
        {sel('composition', 'Composition')}
        {sel('mood', 'Mood')}
        {sel('palette', 'Colour palette')}
      </div>
      <div className="space-y-1.5">
        <FieldLabel>Detail modifiers</FieldLabel>
        <div className="flex flex-wrap gap-1.5">
          {IMG.detail.map(d => {
            const on = f.details.includes(d);
            return (
              <button key={d} type="button" onClick={() => set('details', on ? f.details.filter(x => x !== d) : [...f.details, d])}
                className={cn('rounded-full border px-2.5 py-0.5 text-xs cursor-pointer transition-colors', on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                {d}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5"><FieldLabel>Aspect ratio</FieldLabel><Segmented value={f.aspect} onChange={v => set('aspect', v)} options={ASPECTS.map(a => ({ value: a, label: a }))} /></div>
        <div className="space-y-1.5 lg:col-span-3"><FieldLabel>Negative prompt (things to avoid)</FieldLabel><Input value={f.negative} onChange={e => set('negative', e.target.value)} className="text-xs" /></div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between gap-2">Midjourney <CopyButton value={midjourney} label="Copy" /></CardTitle>
            <div className="grid grid-cols-3 gap-2 pt-1">
              <div className="space-y-1"><FieldLabel>--v</FieldLabel><NativeSelect value={f.mjVersion} onChange={v => set('mjVersion', v)} options={['7', '6.1', '6', 'niji 6'].map(v => ({ value: v, label: v }))} /></div>
              <NumberField label="--stylize" value={f.mjStylize} onChange={v => set('mjStylize', Math.max(0, Math.min(1000, v || 0)))} min={0} max={1000} step={50} />
              <div className="flex items-end pb-1.5"><Checkbox checked={f.mjRaw} onChange={v => set('mjRaw', v)}>raw</Checkbox></div>
            </div>
          </CardHeader>
          <CardContent><p className={cn(MONO, 'whitespace-pre-wrap break-words rounded-md bg-secondary/40 p-2')}>{midjourney}</p></CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between gap-2">Stable Diffusion XL <CopyButton value={`${sdxl}\nNegative prompt: ${f.negative}`} label="Copy" /></CardTitle>
            <div className="pt-1 w-36"><NumberField label="Subject weight" value={f.weight} onChange={v => set('weight', Math.max(0.5, Math.min(2, v || 1)))} min={0.5} max={2} step={0.1} /></div>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className={cn(MONO, 'whitespace-pre-wrap break-words rounded-md bg-secondary/40 p-2')}>{sdxl}</p>
            <p className={cn(MONO, 'whitespace-pre-wrap break-words rounded-md bg-secondary/40 p-2')}><span className="text-muted-foreground">Negative: </span>{f.negative}</p>
            <p className="text-[11px] text-muted-foreground">Suggested size {sdxlSize} · CFG 5–7 · 25–35 steps</p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader><CardTitle className="text-sm flex items-center justify-between gap-2">DALL·E / Flux / Imagen <CopyButton value={natural} label="Copy" /></CardTitle>
            <CardDescription className="text-xs">Natural-language prompt — these models follow full sentences best.</CardDescription>
          </CardHeader>
          <CardContent><p className="text-xs leading-relaxed whitespace-pre-wrap break-words rounded-md bg-secondary/40 p-2">{natural}</p></CardContent>
        </Card>
      </div>
    </div>
  );
}

// ───────────────────────── RAG chunking visualiser ─────────────────────────

type Strategy = 'fixed' | 'sentence' | 'paragraph' | 'recursive' | 'token';
interface Chunk { index: number; start: number; end: number; chars: number; tokens: number; text: string }
interface ChunkResult { strategy: Strategy; unit: 'chars' | 'tokens'; size: number; overlap: number; totalChars: number; totalTokens: number; chunks: Chunk[] }

const STRATEGIES: { value: Strategy; label: string; hint: string }[] = [
  { value: 'recursive', label: 'Recursive', hint: 'Paragraph → line → sentence → word, packed up to the size (LangChain-style)' },
  { value: 'paragraph', label: 'Paragraph', hint: 'Whole paragraphs packed together; oversize ones split by sentence' },
  { value: 'sentence', label: 'Sentence', hint: 'Whole sentences packed up to the size' },
  { value: 'fixed', label: 'Fixed', hint: 'Fixed windows of N characters/tokens — ignores structure' },
  { value: 'token', label: 'Token', hint: 'Fixed windows of N tokens (o200k tokenizer)' },
];

const SAMPLE_DOC = `# Employee Handbook: Remote Work Policy

## 1. Eligibility
All full-time employees who have completed their 90-day probation period are eligible for remote work. Part-time employees may work remotely with written approval from their manager. Contractors follow the terms of their individual agreements.

## 2. Equipment
The company provides a laptop, a monitor and a headset to every remote employee. Employees may claim up to $500 per year for ergonomic furniture. Receipts must be submitted through the expenses portal within 30 days of purchase.

## 3. Working hours
Core collaboration hours are 10:00 to 15:00 in the employee's local time zone. Outside core hours, employees may organise their schedule freely, provided they work their contracted hours. Meetings should not be scheduled outside core hours without consent.

## 4. Security
Company data must only be accessed on company-managed devices. Public Wi-Fi may be used only with the corporate VPN enabled. Lost or stolen devices must be reported to IT within 24 hours. Two-factor authentication is mandatory for all accounts.

## 5. Communication
Use the team chat for quick questions and the project tracker for decisions. Document important decisions in writing so colleagues in other time zones can catch up asynchronously. Respond to direct messages within one working day.`;

export function RagChunkingVisualizer() {
  const [text, setText] = useState(SAMPLE_DOC);
  const [strategy, setStrategy] = useState<Strategy>('recursive');
  const [unit, setUnit] = useState<'chars' | 'tokens'>('chars');
  const [size, setSize] = useState(400);
  const [overlap, setOverlap] = useState(50);
  const [results, setResults] = useState<Partial<Record<Strategy, ChunkResult>>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const params = useDebounced(JSON.stringify({ text, unit, size, overlap }), 400);

  useEffect(() => {
    const p = JSON.parse(params) as { text: string; unit: 'chars' | 'tokens'; size: number; overlap: number };
    if (!p.text.trim() || !(p.size > 0)) { setResults({}); return; }
    let alive = true;
    setLoading(true);
    // Run every strategy so they can be compared side by side.
    Promise.all(STRATEGIES.map(s => toolsApi.post<ChunkResult>('/ai/chunk', {
      text: p.text, strategy: s.value, unit: s.value === 'token' ? 'tokens' : p.unit,
      size: s.value === 'token' && p.unit === 'chars' ? Math.max(8, Math.round(p.size / 4)) : p.size,
      overlap: s.value === 'token' && p.unit === 'chars' ? Math.round(p.overlap / 4) : Math.min(p.overlap, p.size - 1),
    }).then(r => [s.value, r] as const)))
      .then(rs => { if (alive) { setResults(Object.fromEntries(rs)); setError(''); } })
      .catch(e => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [params]);

  const res = results[strategy];

  /** Split the text at every chunk boundary; each segment knows which chunks cover it. */
  const segments = useMemo(() => {
    if (!res) return [];
    const limit = Math.min(text.length, 150_000);
    const points = new Set<number>([0, limit]);
    for (const c of res.chunks) { if (c.start < limit) points.add(c.start); if (c.end < limit) points.add(c.end); }
    const sorted = [...points].sort((a, b) => a - b);
    const out: { start: number; end: number; cover: number[] }[] = [];
    let ci = 0;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const s = sorted[i], e = sorted[i + 1];
      while (ci < res.chunks.length && res.chunks[ci].end <= s) ci++;
      const cover: number[] = [];
      for (let j = ci; j < res.chunks.length && res.chunks[j].start <= s; j++) if (res.chunks[j].end >= e) cover.push(j);
      out.push({ start: s, end: e, cover });
    }
    return out;
  }, [res, text]);

  const stats = (r?: ChunkResult) => {
    if (!r?.chunks.length) return null;
    const m = r.unit === 'tokens' ? r.chunks.map(c => c.tokens) : r.chunks.map(c => c.chars);
    const overlapChars = r.chunks.reduce((s, c, i) => s + (i ? Math.max(0, r.chunks[i - 1].end - c.start) : 0), 0);
    return { n: r.chunks.length, avg: m.reduce((a, b) => a + b, 0) / m.length, min: Math.min(...m), max: Math.max(...m), dup: overlapChars / Math.max(1, r.totalChars) };
  };

  const exportJson = res ? JSON.stringify({ strategy: res.strategy, unit: res.unit, size: res.size, overlap: res.overlap, chunks: res.chunks }, null, 2) : '';

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldLabel action={<div className="flex items-center gap-1">
          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <LoadFileButton onText={setText} />
          <Button variant="ghost" size="xs" onClick={() => setText('')}><Eraser /> Clear</Button>
        </div>}>Document · {fmt(text.length)} chars</FieldLabel>
        <Textarea className={cn(FIXED, MONO, 'h-40')} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <FieldLabel>Measure size in</FieldLabel>
          <Segmented value={unit} onChange={u => { setUnit(u); if (u === 'tokens') { setSize(s => Math.max(8, Math.round(s / 4))); setOverlap(o => Math.round(o / 4)); } else { setSize(s => s * 4); setOverlap(o => o * 4); } }}
            options={[{ value: 'chars', label: 'Characters' }, { value: 'tokens', label: 'Tokens' }]} />
        </div>
        <NumberField label={`Chunk size (${unit})`} value={size} onChange={v => setSize(Math.max(unit === 'tokens' ? 8 : 20, v || 0))} min={unit === 'tokens' ? 8 : 20} step={unit === 'tokens' ? 16 : 50} className="w-36" />
        <NumberField label={`Overlap (${unit})`} value={overlap} onChange={v => setOverlap(Math.max(0, Math.min(size - 1, v || 0)))} min={0} max={size - 1} step={unit === 'tokens' ? 8 : 25} className="w-32" />
      </div>
      {error && <ErrorBox message={error} />}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs min-w-[560px]">
          <thead className="bg-secondary/60 text-muted-foreground">
            <tr>{['Strategy', 'Chunks', `Avg ${unit}`, 'Min', 'Max', 'Duplicated by overlap'].map(h => <th key={h} className="px-2 py-1.5 text-left font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {STRATEGIES.map(s => {
              const st = stats(results[s.value]);
              const tokUnit = s.value === 'token' || unit === 'tokens';
              return (
                <tr key={s.value} onClick={() => setStrategy(s.value)} title={s.hint}
                  className={cn('border-t border-border cursor-pointer hover:bg-secondary/40', strategy === s.value && 'bg-primary/5')}>
                  <td className="px-2 py-1.5"><span className={cn('font-medium', strategy === s.value && 'text-primary')}>{s.label}</span></td>
                  <td className="px-2 py-1.5 tabular-nums">{st?.n ?? '—'}</td>
                  <td className="px-2 py-1.5 tabular-nums">{st ? `${fmt(st.avg)}${tokUnit && unit === 'chars' ? ' tok' : ''}` : '—'}</td>
                  <td className="px-2 py-1.5 tabular-nums">{st ? fmt(st.min) : '—'}</td>
                  <td className="px-2 py-1.5 tabular-nums">{st ? fmt(st.max) : '—'}</td>
                  <td className="px-2 py-1.5 tabular-nums">{st ? `${(st.dup * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">{STRATEGIES.find(s => s.value === strategy)?.hint}{strategy === 'token' && unit === 'chars' ? ' — size and overlap converted at ≈ 4 chars/token.' : ''}</p>

      {res && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">Chunk boundaries</CardTitle>
              <CardDescription className="text-xs">Each colour is one chunk; striped text is overlap shared by two chunks. Hover to inspect.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-h-[32rem] overflow-y-auto rounded-md border border-border bg-background p-2.5 text-xs leading-6 whitespace-pre-wrap break-words font-mono">
                {segments.map(seg => {
                  const t = text.slice(seg.start, seg.end);
                  if (!seg.cover.length) return <span key={seg.start}>{t}</span>;
                  const main = seg.cover[seg.cover.length - 1];
                  const overlapSeg = seg.cover.length > 1;
                  const isHover = hover !== null && seg.cover.includes(hover);
                  const bg = overlapSeg
                    ? `repeating-linear-gradient(135deg, ${VIZ[seg.cover[0] % VIZ.length]} 0 6px, ${VIZ[main % VIZ.length]} 6px 12px)`
                    : VIZ[main % VIZ.length];
                  return (
                    <span key={seg.start} onMouseEnter={() => setHover(main)} onMouseLeave={() => setHover(null)}
                      className={cn('text-foreground rounded-[2px]', isHover && 'outline outline-2 outline-primary')} style={{ background: bg }}>
                      {t}
                    </span>
                  );
                })}
                {text.length > 150_000 && <span className="text-muted-foreground">{'\n'}… visualisation limited to the first 150,000 characters</span>}
              </div>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                {res.chunks.length} chunks
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" size="xs" onClick={() => downloadBlob(exportJson, `chunks-${res.strategy}.json`, 'application/json')}><Download /> JSON</Button>
                  <CopyButton value={exportJson} label="Copy" />
                </span>
              </CardTitle>
              <CardDescription className="text-xs">{fmt(res.totalTokens)} tokens in the document (o200k).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5 max-h-[32rem] overflow-y-auto">
              {res.chunks.slice(0, 500).map(c => {
                const target = res.unit === 'tokens' ? c.tokens : c.chars;
                return (
                  <div key={c.index} onMouseEnter={() => setHover(c.index)} onMouseLeave={() => setHover(null)}
                    className={cn('rounded-md border p-2 space-y-1 text-xs', hover === c.index ? 'border-primary' : 'border-border')}>
                    <div className="flex items-center gap-2">
                      <span className="size-2.5 rounded-sm shrink-0" style={{ background: VIZ[c.index % VIZ.length].replace(/[\d.]+\)$/, '0.9)') }} />
                      <span className="font-medium">#{c.index + 1}</span>
                      <span className="text-muted-foreground tabular-nums">{fmt(c.chars)} chars · {fmt(c.tokens)} tok · {c.start}–{c.end}</span>
                    </div>
                    <div className="h-1 rounded-full bg-secondary overflow-hidden"><div className="h-full bg-primary/60" style={{ width: `${Math.min(100, (target / res.size) * 100)}%` }} /></div>
                    <p className="text-muted-foreground line-clamp-2 break-words">{c.text.trim()}</p>
                  </div>
                );
              })}
              {res.chunks.length > 500 && <p className="text-[11px] text-muted-foreground">Showing 500 of {res.chunks.length} — export JSON for all.</p>}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
