import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Checkbox, ErrorBox, FieldLabel, InfoBox, NumberField, Segmented } from '../devtools/shared';
import { auditApi, type AuditOptions, type CheckDef, type ExtractRule, type SearchRule, type Thresholds, type VerifyOptions, type Category } from './api';
import { SEVERITY } from './ui';

/** Everything the settings panel edits. Secrets (PSI key, auth password, header values) are never persisted. */
export interface Settings {
  mode: 'crawl' | 'sitemap' | 'list';
  urlList: string;
  maxPages: number; maxDepth: number; concurrency: number; userAgent: string; crawlDelayMs: number; timeoutSec: number;
  respectRobots: boolean; includeSubdomains: boolean; checkExternal: boolean; checkResources: boolean; useSitemaps: boolean;
  stripQuery: boolean; pageSpeed: boolean; subfolderOnly: boolean; ignoreTracking: boolean; ignoreParams: string;
  retryErrors: boolean; reverifyBroken: boolean;
  include: string; exclude: string; keyword: string;
  authUser: string; authPass: string; headers: string;
  customSearch: SearchRule[]; extract: ExtractRule[];
  thresholds: Required<Thresholds>;
  disabled: string[];
  verify: Required<VerifyOptions>;
}

export const DEFAULT_THRESHOLDS: Required<Thresholds> = {
  titleMin: 30, titleMax: 60, descMin: 70, descMax: 160, thinWords: 200, slowTtfbMs: 800, slowLoadMs: 3000,
  largeHtmlKb: 500, largeImageKb: 200, maxDom: 1500, deepClicks: 4,
};

export const DEFAULT_SETTINGS: Settings = {
  mode: 'crawl', urlList: '',
  maxPages: 100, maxDepth: 10, concurrency: 8, userAgent: 'default', crawlDelayMs: 0, timeoutSec: 20,
  respectRobots: true, includeSubdomains: false, checkExternal: true, checkResources: true, useSitemaps: true,
  stripQuery: false, pageSpeed: true, subfolderOnly: false, ignoreTracking: true, ignoreParams: '',
  retryErrors: true, reverifyBroken: true,
  include: '', exclude: '', keyword: '',
  authUser: '', authPass: '', headers: '',
  customSearch: [], extract: [],
  thresholds: DEFAULT_THRESHOLDS,
  disabled: [],
  verify: { w3c: true, w3cPages: 5, observatory: true, safeBrowsing: true, rdap: true, wayback: true, tranco: true, greenWeb: true, sslLabs: false },
};

const STORE = 'siteaudit_settings_v2';

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null') as Partial<Settings> | null;
    if (!raw) return DEFAULT_SETTINGS;
    return {
      ...DEFAULT_SETTINGS, ...raw, authPass: '',
      thresholds: { ...DEFAULT_THRESHOLDS, ...raw.thresholds },
      verify: { ...DEFAULT_SETTINGS.verify, ...raw.verify },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    // Header values may hold tokens/cookies: keep only the names.
    const headers = s.headers.split('\n').map(l => l.split(':')[0].trim()).filter(Boolean).map(n => `${n}: `).join('\n');
    localStorage.setItem(STORE, JSON.stringify({ ...s, authPass: '', headers }));
  } catch { /* storage unavailable */ }
}

const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);

export function parseHeaders(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const l of lines(text)) {
    const i = l.indexOf(':');
    if (i <= 0) return `Header line "${l}" must look like "Name: value"`;
    const v = l.slice(i + 1).trim();
    if (v) out[l.slice(0, i).trim()] = v;
  }
  return out;
}

/** Converts panel settings into the API payload. Returns an error string for invalid input. */
export function toOptions(url: string, s: Settings, psiKey: string): AuditOptions | string {
  const headers = parseHeaders(s.headers);
  if (typeof headers === 'string') return headers;
  const urls = lines(s.urlList);
  if (s.mode === 'list' && urls.length === 0) return 'Paste at least one URL to audit in list mode.';
  const changed = (Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]).some(k => s.thresholds[k] !== DEFAULT_THRESHOLDS[k]);
  const params = lines(s.ignoreParams.replace(/,/g, '\n'));
  if (s.ignoreTracking) params.push('tracking');
  return {
    url: s.mode === 'list' ? (url.trim() || urls[0]) : url.trim(),
    mode: s.mode, urls: s.mode === 'list' ? urls : undefined,
    maxPages: Number.isFinite(s.maxPages) ? s.maxPages : 100,
    maxDepth: Number.isFinite(s.maxDepth) ? s.maxDepth : 10,
    concurrency: Number.isFinite(s.concurrency) ? s.concurrency : 8,
    crawlDelayMs: Number.isFinite(s.crawlDelayMs) ? s.crawlDelayMs : 0,
    timeoutSec: Number.isFinite(s.timeoutSec) ? s.timeoutSec : 20,
    userAgent: s.userAgent, respectRobots: s.respectRobots, includeSubdomains: s.includeSubdomains,
    checkExternal: s.checkExternal, checkResources: s.checkResources, useSitemaps: s.useSitemaps, stripQuery: s.stripQuery,
    pageSpeed: s.pageSpeed, pageSpeedKey: psiKey.trim() || undefined,
    subfolderOnly: s.subfolderOnly || undefined, ignoreParams: params.length ? params : undefined,
    retryErrors: s.retryErrors, reverifyBroken: s.reverifyBroken,
    include: lines(s.include), exclude: lines(s.exclude), keyword: s.keyword.trim() || undefined,
    authUser: s.authUser.trim() || undefined, authPass: s.authUser.trim() ? s.authPass : undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    customSearch: s.customSearch.filter(r => r.pattern.trim()),
    extract: s.extract.filter(r => r.regex.trim()),
    thresholds: changed ? s.thresholds : undefined,
    disabledChecks: s.disabled.length ? s.disabled : undefined,
    verify: s.verify,
  };
}

const UAS = [
  { value: 'default', label: 'Site Auditor' },
  { value: 'googlebot', label: 'Googlebot' },
  { value: 'googlebot-mobile', label: 'Googlebot Smartphone' },
  { value: 'bingbot', label: 'Bingbot' },
  { value: 'chrome', label: 'Chrome desktop' },
  { value: 'iphone', label: 'iPhone Safari' },
];

const SECTIONS = [
  { value: 'scope', label: 'Scope' },
  { value: 'crawl', label: 'Crawl' },
  { value: 'access', label: 'Access' },
  { value: 'rules', label: 'Custom search' },
  { value: 'checks', label: 'Checks' },
  { value: 'verify', label: 'Verification' },
] as const;
type SectionId = typeof SECTIONS[number]['value'];

const TEXTAREA = 'w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs font-mono';

export function AuditSettings({ s, set, psiKey, setPsiKey, onReset }: {
  s: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  psiKey: string;
  setPsiKey: (v: string) => void;
  onReset: () => void;
}) {
  const [section, setSection] = useState<SectionId>('scope');
  const badge = (id: SectionId) => {
    switch (id) {
      case 'rules': return s.customSearch.length + s.extract.length || undefined;
      case 'checks': return s.disabled.length || undefined;
      case 'access': return (s.authUser ? 1 : 0) + lines(s.headers).length || undefined;
    }
  };
  return (
    <div className="relative mt-5 pt-5 border-t border-border space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<SectionId> value={section} options={SECTIONS.map(x => ({ value: x.value, label: x.label + (badge(x.value) ? ` · ${badge(x.value)}` : '') }))} onChange={setSection} />
        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onReset} title="Restore every setting to its default"><RotateCcw /> Reset</Button>
      </div>
      {section === 'scope' && <ScopeSection s={s} set={set} />}
      {section === 'crawl' && <CrawlSection s={s} set={set} psiKey={psiKey} setPsiKey={setPsiKey} />}
      {section === 'access' && <AccessSection s={s} set={set} />}
      {section === 'rules' && <RulesSection s={s} set={set} />}
      {section === 'checks' && <ChecksSection s={s} set={set} />}
      {section === 'verify' && <VerifySection s={s} set={set} psiKey={psiKey} />}
    </div>
  );
}

type SectionProps = { s: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => void };

function ScopeSection({ s, set }: SectionProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-1.5 md:col-span-2">
        <FieldLabel>What to audit</FieldLabel>
        <Segmented value={s.mode} onChange={v => set('mode', v)} options={[
          { value: 'crawl', label: 'Crawl the site' }, { value: 'sitemap', label: 'Sitemap URLs only' }, { value: 'list', label: 'A list of URLs' },
        ]} />
        <p className="text-[11px] text-muted-foreground">
          {s.mode === 'crawl' ? 'Follows internal links from the start URL (plus sitemap URLs nobody links to).' :
            s.mode === 'sitemap' ? 'Audits exactly the URLs in the XML sitemaps; links are not followed, so orphan/depth checks are off.' :
              'Audits only the URLs you paste (same site as the first URL); links are not followed.'}
        </p>
      </div>
      {s.mode === 'list' && (
        <div className="space-y-1.5 md:col-span-2">
          <FieldLabel>URLs (one per line, max 10,000)</FieldLabel>
          <textarea value={s.urlList} onChange={e => set('urlList', e.target.value)} rows={6} className={TEXTAREA}
            placeholder={'https://example.com/\nhttps://example.com/pricing\nhttps://example.com/blog/launch'} />
          <p className="text-[11px] text-muted-foreground">{lines(s.urlList).length.toLocaleString()} URLs</p>
        </div>
      )}
      <div className="space-y-1.5">
        <FieldLabel>Only crawl URLs matching (regex, one per line)</FieldLabel>
        <textarea value={s.include} onChange={e => set('include', e.target.value)} rows={2} placeholder="/blog/" className={TEXTAREA} />
      </div>
      <div className="space-y-1.5">
        <FieldLabel>Exclude URLs matching (regex, one per line)</FieldLabel>
        <textarea value={s.exclude} onChange={e => set('exclude', e.target.value)} rows={2} placeholder={'/tag/\n\\?page='} className={TEXTAREA} />
      </div>
      <div className="space-y-1.5">
        <FieldLabel>Ignore query parameters (comma or line separated, prefix* allowed)</FieldLabel>
        <Input value={s.ignoreParams} onChange={e => set('ignoreParams', e.target.value)} placeholder="sort, sessionid, ref*" className="h-8 text-xs font-mono" />
      </div>
      <div className="space-y-1.5">
        <FieldLabel>Focus keyword (optional)</FieldLabel>
        <Input value={s.keyword} onChange={e => set('keyword', e.target.value)} placeholder="e.g. running shoes" className="h-8 text-xs" />
      </div>
      <div className="md:col-span-2 flex flex-wrap gap-x-5 gap-y-2">
        <Checkbox checked={s.subfolderOnly} onChange={v => set('subfolderOnly', v)}>Stay inside the start URL's folder</Checkbox>
        <Checkbox checked={s.ignoreTracking} onChange={v => set('ignoreTracking', v)}>Drop tracking params (utm_*, gclid, fbclid…)</Checkbox>
        <Checkbox checked={s.stripQuery} onChange={v => set('stripQuery', v)}>Ignore all query strings</Checkbox>
        <Checkbox checked={s.includeSubdomains} onChange={v => set('includeSubdomains', v)}>Include subdomains</Checkbox>
        {s.mode === 'crawl' && <Checkbox checked={s.useSitemaps} onChange={v => set('useSitemaps', v)}>Crawl sitemap URLs (find orphans)</Checkbox>}
      </div>
    </div>
  );
}

function CrawlSection({ s, set, psiKey, setPsiKey }: SectionProps & { psiKey: string; setPsiKey: (v: string) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <NumberField label="Max pages" value={s.maxPages} min={1} max={10000} onChange={v => set('maxPages', v)} />
      <NumberField label="Max click depth" value={s.maxDepth} min={1} max={50} onChange={v => set('maxDepth', v)} />
      <NumberField label="Parallel requests" value={s.concurrency} min={1} max={32} onChange={v => set('concurrency', v)} />
      <NumberField label="Delay between requests" suffix="ms" value={s.crawlDelayMs} min={0} max={10000} step={100} onChange={v => set('crawlDelayMs', v)} />
      <div className="space-y-1.5">
        <FieldLabel>User agent</FieldLabel>
        <select value={s.userAgent} onChange={e => set('userAgent', e.target.value)} className="w-full h-8 rounded-md border border-input bg-card px-2 text-xs">
          {UAS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
        </select>
      </div>
      <NumberField label="Request timeout" suffix="s" value={s.timeoutSec} min={5} max={60} onChange={v => set('timeoutSec', v)} />
      <div className="space-y-1.5 md:col-span-2">
        <FieldLabel>Google API key (optional — PageSpeed & Safe Browsing)</FieldLabel>
        <Input value={psiKey} onChange={e => setPsiKey(e.target.value)} placeholder="AIza…" type="password" className="h-8 text-xs" />
      </div>
      <div className="md:col-span-2 xl:col-span-4 flex flex-wrap gap-x-5 gap-y-2">
        <Checkbox checked={s.respectRobots} onChange={v => set('respectRobots', v)}>Respect robots.txt</Checkbox>
        <Checkbox checked={s.checkExternal} onChange={v => set('checkExternal', v)}>Check external links</Checkbox>
        <Checkbox checked={s.checkResources} onChange={v => set('checkResources', v)}>Check images, JS & CSS</Checkbox>
        <Checkbox checked={s.pageSpeed} onChange={v => set('pageSpeed', v)}>Lighthouse / Core Web Vitals</Checkbox>
        <Checkbox checked={s.retryErrors} onChange={v => set('retryErrors', v)}>Retry timeouts & 5xx once</Checkbox>
        <Checkbox checked={s.reverifyBroken} onChange={v => set('reverifyBroken', v)}>Re-check broken links with a browser UA</Checkbox>
      </div>
    </div>
  );
}

function AccessSection({ s, set }: SectionProps) {
  const parsed = parseHeaders(s.headers);
  return (
    <div className="space-y-3">
      <InfoBox>For staging sites, password-protected areas or WAF allow-listing. Credentials and headers are only sent to the audited site — never to external links or verification services — and are redacted from saved reports.</InfoBox>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>HTTP basic auth user</FieldLabel>
          <Input value={s.authUser} onChange={e => set('authUser', e.target.value)} autoComplete="off" className="h-8 text-xs" />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Password</FieldLabel>
          <Input value={s.authPass} onChange={e => set('authPass', e.target.value)} type="password" autoComplete="new-password" className="h-8 text-xs" />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <FieldLabel>Extra request headers ("Name: value", one per line)</FieldLabel>
          <textarea value={s.headers} onChange={e => set('headers', e.target.value)} rows={3} className={TEXTAREA}
            placeholder={'Cookie: session=…\nX-Bypass-Token: …'} />
          {typeof parsed === 'string' && <p className="text-[11px] text-red-600 dark:text-red-400">{parsed}</p>}
          <p className="text-[11px] text-muted-foreground">Header names are remembered; values and the password are not.</p>
        </div>
      </div>
    </div>
  );
}

function RulesSection({ s, set }: SectionProps) {
  const updSearch = (i: number, patch: Partial<SearchRule>) => set('customSearch', s.customSearch.map((r, j) => j === i ? { ...r, ...patch } : r));
  const updExtract = (i: number, patch: Partial<ExtractRule>) => set('extract', s.extract.map((r, j) => j === i ? { ...r, ...patch } : r));
  const reErr = (src: string) => { try { new RegExp(src); return ''; } catch (e) { return (e as Error).message; } };
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium flex-1">Custom search</p>
          <Button type="button" size="xs" variant="outline" disabled={s.customSearch.length >= 20}
            onClick={() => set('customSearch', [...s.customSearch, { name: '', pattern: '' }])}><Plus /> Rule</Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Find pages that contain — or are missing — a snippet: tracking codes, out-of-stock text, old brand names, a required disclaimer…</p>
        {s.customSearch.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {[
              { name: 'Google Tag Manager', pattern: 'googletagmanager.com' },
              { name: 'Missing GA4', pattern: 'gtag(', absent: true },
              { name: 'Out of stock', pattern: 'out of stock', inText: true },
              { name: 'Email addresses', pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.]+', regex: true, inText: true },
            ].map(r => <Button key={r.name} type="button" size="xs" variant="ghost" onClick={() => set('customSearch', [...s.customSearch, r])}>+ {r.name}</Button>)}
          </div>
        )}
        {s.customSearch.map((r, i) => (
          <div key={i} className="rounded-md border border-border p-2 space-y-1.5">
            <div className="flex gap-1.5">
              <Input value={r.name} onChange={e => updSearch(i, { name: e.target.value })} placeholder="Name" className="h-7 text-xs w-36" />
              <Input value={r.pattern} onChange={e => updSearch(i, { pattern: e.target.value })} placeholder={r.regex ? 'regular expression' : 'text to find (case-insensitive)'} className="h-7 text-xs font-mono flex-1" />
              <Button type="button" size="icon-xs" variant="ghost" onClick={() => set('customSearch', s.customSearch.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Checkbox checked={!!r.regex} onChange={v => updSearch(i, { regex: v })}>Regex</Checkbox>
              <Checkbox checked={!!r.inText} onChange={v => updSearch(i, { inText: v })}>Visible text only</Checkbox>
              <Checkbox checked={!!r.absent} onChange={v => updSearch(i, { absent: v })}>Report pages that DON'T contain it</Checkbox>
            </div>
            {r.regex && r.pattern && reErr(r.pattern) && <p className="text-[11px] text-red-600 dark:text-red-400">{reErr(r.pattern)}</p>}
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium flex-1">Custom extraction</p>
          <Button type="button" size="xs" variant="outline" disabled={s.extract.length >= 20}
            onClick={() => set('extract', [...s.extract, { name: '', regex: '' }])}><Plus /> Field</Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Pull a value out of every page's HTML with a regex (first capture group). Shown as columns in the Pages tab and CSV export.</p>
        {s.extract.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {[
              { name: 'Price', regex: 'itemprop="price"\\s+content="([^"]+)"' },
              { name: 'Author', regex: '<meta\\s+name="author"\\s+content="([^"]+)"' },
              { name: 'Published', regex: '"datePublished"\\s*:\\s*"([^"]+)"' },
              { name: 'GA ID', regex: '(G-[A-Z0-9]{6,})' },
            ].map(r => <Button key={r.name} type="button" size="xs" variant="ghost" onClick={() => set('extract', [...s.extract, r])}>+ {r.name}</Button>)}
          </div>
        )}
        {s.extract.map((r, i) => (
          <div key={i} className="rounded-md border border-border p-2 space-y-1">
            <div className="flex gap-1.5">
              <Input value={r.name} onChange={e => updExtract(i, { name: e.target.value })} placeholder="Column name" className="h-7 text-xs w-36" />
              <Input value={r.regex} onChange={e => updExtract(i, { regex: e.target.value })} placeholder='data-sku="([^"]+)"' className="h-7 text-xs font-mono flex-1" />
              <Button type="button" size="icon-xs" variant="ghost" onClick={() => set('extract', s.extract.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
            {r.regex && reErr(r.regex) && <p className="text-[11px] text-red-600 dark:text-red-400">{reErr(r.regex)}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

const THRESHOLD_FIELDS: { key: keyof Thresholds; label: string; suffix?: string }[] = [
  { key: 'titleMin', label: 'Title min', suffix: 'chars' }, { key: 'titleMax', label: 'Title max', suffix: 'chars' },
  { key: 'descMin', label: 'Description min', suffix: 'chars' }, { key: 'descMax', label: 'Description max', suffix: 'chars' },
  { key: 'thinWords', label: 'Thin content below', suffix: 'words' }, { key: 'deepClicks', label: 'Deep page after', suffix: 'clicks' },
  { key: 'slowTtfbMs', label: 'Slow TTFB over', suffix: 'ms' }, { key: 'slowLoadMs', label: 'Slow download over', suffix: 'ms' },
  { key: 'largeHtmlKb', label: 'Large HTML over', suffix: 'KB' }, { key: 'largeImageKb', label: 'Large image over', suffix: 'KB' },
  { key: 'maxDom', label: 'Max DOM elements' },
];

let checksCache: Promise<{ checks: CheckDef[]; categories: Category[] }> | null = null;

function ChecksSection({ s, set }: SectionProps) {
  const [data, setData] = useState<{ checks: CheckDef[]; categories: Category[] } | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    checksCache ??= auditApi.checks();
    checksCache.then(setData).catch(e => { checksCache = null; setError((e as Error).message); });
  }, []);
  const off = useMemo(() => new Set(s.disabled), [s.disabled]);
  const toggle = (ids: string[], disable: boolean) => {
    const next = new Set(off);
    ids.forEach(id => disable ? next.add(id) : next.delete(id));
    set('disabled', [...next]);
  };
  const setTh = (k: keyof Thresholds, v: number) => set('thresholds', { ...s.thresholds, [k]: v });

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium mb-2">Thresholds</p>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4 xl:grid-cols-6">
          {THRESHOLD_FIELDS.map(f => (
            <NumberField key={f.key} label={f.label} suffix={f.suffix} value={s.thresholds[f.key]} min={1}
              onChange={v => setTh(f.key, v)} className={cn(s.thresholds[f.key] !== DEFAULT_THRESHOLDS[f.key] && '[&_input]:border-primary')} />
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium flex-1">Enabled checks {data && <span className="text-muted-foreground font-normal">— {data.checks.length - off.size} of {data.checks.length}</span>}</p>
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter checks" className="h-7 text-xs w-44" />
          {off.size > 0 && <Button type="button" size="xs" variant="ghost" onClick={() => set('disabled', [])}>Enable all</Button>}
        </div>
        {error && <ErrorBox message={error} />}
        {!data && !error && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading checks…</p>}
        {data && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 max-h-[420px] overflow-auto pr-1">
            {data.categories.map(cat => {
              const all = data.checks.filter(c => c.category === cat.ID);
              const list = all.filter(c => !q || (c.title + ' ' + c.id).toLowerCase().includes(q.toLowerCase()));
              if (list.length === 0) return null;
              const enabled = all.filter(c => !off.has(c.id)).length;
              return (
                <div key={cat.ID} className="rounded-md border border-border p-2">
                  <label className="flex items-center gap-1.5 text-xs font-medium cursor-pointer">
                    <input type="checkbox" checked={enabled === all.length} ref={el => { if (el) el.indeterminate = enabled > 0 && enabled < all.length; }}
                      onChange={e => toggle(all.map(c => c.id), !e.target.checked)} />
                    {cat.Label} <span className="text-muted-foreground font-normal">{enabled}/{all.length}</span>
                  </label>
                  <div className="mt-1.5 space-y-0.5 pl-1">
                    {list.map(c => (
                      <label key={c.id} className="flex items-start gap-1.5 text-[11px] cursor-pointer" title={c.why}>
                        <input type="checkbox" className="mt-0.5" checked={!off.has(c.id)} onChange={e => toggle([c.id], !e.target.checked)} />
                        <span className={cn('size-1.5 rounded-full mt-1.5 shrink-0', SEVERITY[c.severity].bar)} />
                        <span className={cn(off.has(c.id) && 'line-through text-muted-foreground')}>{c.title}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const VERIFIERS: { key: keyof VerifyOptions; label: string; desc: string }[] = [
  { key: 'w3c', label: 'W3C HTML validator', desc: 'validator.w3.org Nu checker on the homepage and most-linked pages' },
  { key: 'observatory', label: 'Mozilla HTTP Observatory', desc: 'independent security-header & cookie grade' },
  { key: 'safeBrowsing', label: 'Google Safe Browsing', desc: 'malware/phishing status of your pages and outbound links (needs the Google API key)' },
  { key: 'rdap', label: 'Domain registration (RDAP)', desc: 'registrar, age, expiry date and transfer lock' },
  { key: 'wayback', label: 'Internet Archive', desc: 'first and latest Wayback Machine captures' },
  { key: 'tranco', label: 'Tranco top-sites rank', desc: 'research-grade popularity rank (top 1M)' },
  { key: 'greenWeb', label: 'Green Web Foundation', desc: 'whether the host runs on verified green energy' },
  { key: 'sslLabs', label: 'Qualys SSL Labs', desc: 'full TLS assessment — thorough but can take 1–5 minutes' },
];

function VerifySection({ s, set, psiKey }: SectionProps & { psiKey: string }) {
  const v = s.verify;
  const setV = (k: keyof VerifyOptions, val: boolean | number) => set('verify', { ...v, [k]: val });
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">Independent second opinions from public services, run after the crawl. Results appear in the report's Verification tab; failures never break the audit. Skipped automatically for IP addresses and localhost.</p>
      <div className="grid gap-2 md:grid-cols-2">
        {VERIFIERS.map(x => (
          <label key={x.key} className={cn('flex items-start gap-2 rounded-md border border-border px-3 py-2 cursor-pointer', v[x.key] && 'bg-secondary/40')}>
            <input type="checkbox" className="mt-0.5" checked={!!v[x.key]} onChange={e => setV(x.key, e.target.checked)} />
            <span className="min-w-0">
              <span className="block text-xs font-medium">{x.label}</span>
              <span className="block text-[11px] text-muted-foreground">{x.desc}</span>
              {x.key === 'safeBrowsing' && v.safeBrowsing && !psiKey && <span className="block text-[11px] text-amber-600 dark:text-amber-400">Skipped unless a key is set here or on the server (SAFE_BROWSING_API_KEY).</span>}
            </span>
          </label>
        ))}
      </div>
      {v.w3c && <NumberField label="Pages to validate with W3C" value={v.w3cPages} min={1} max={20} onChange={n => setV('w3cPages', n)} className="max-w-48" />}
    </div>
  );
}
