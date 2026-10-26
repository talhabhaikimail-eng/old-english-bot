import React, { useEffect, useMemo, useState } from 'react';
import { Globe, Loader2, Play, Settings2, Trash2, History, Square, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Checkbox, ErrorBox, FieldLabel, NumberField, Segmented } from '../devtools/shared';
import { auditApi, type AuditOptions, type AuditSummary } from './api';
import { MiniScore, ScoreRing, Section, SeverityBadge, fmtMs, timeAgo } from './ui';

const PRESETS = [
  { value: 'quick', label: 'Quick (1 page)', pages: 1 },
  { value: 'standard', label: 'Standard (100)', pages: 100 },
  { value: 'deep', label: 'Deep (500)', pages: 500 },
  { value: 'full', label: 'Full (2,000)', pages: 2000 },
] as const;
type Preset = typeof PRESETS[number]['value'] | 'custom';

const UAS = [
  { value: 'default', label: 'Site Auditor' },
  { value: 'googlebot', label: 'Googlebot' },
  { value: 'googlebot-mobile', label: 'Googlebot Smartphone' },
  { value: 'bingbot', label: 'Bingbot' },
  { value: 'chrome', label: 'Chrome desktop' },
  { value: 'iphone', label: 'iPhone Safari' },
];

const KEY_STORE = 'siteaudit_psi_key';
function storageGet(k: string) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function storageSet(k: string, v: string) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* unavailable */ } }

export const FEATURES = [
  ['Site crawler', 'Screaming Frog-style crawl with robots.txt, sitemaps, depth & link graph'],
  ['130+ checks', 'Semrush / Ahrefs site-audit issues with why-it-matters and how-to-fix'],
  ['Broken links', 'Internal, external, images, JS & CSS — with every page linking to them'],
  ['Duplicates', 'Duplicate titles, descriptions, H1s and near-duplicate content (simhash)'],
  ['Lighthouse', 'PageSpeed Insights lab scores + real-user Core Web Vitals (CrUX)'],
  ['Security', 'TLS certificate, HTTPS, HSTS, security-header grade, mixed content'],
  ['DNS & email', 'A/AAAA, NS, MX, SPF, DMARC, CAA and DNSSEC'],
  ['Tech stack', 'Wappalyzer-style detection of CMS, frameworks, CDN, analytics…'],
  ['Structured data', 'JSON-LD / microdata types and rich-result property validation'],
  ['International', 'hreflang codes, self-references, return links and x-default'],
  ['Accessibility', 'Alt text, labels, button names, heading order, duplicate IDs'],
  ['AI search', 'AI crawler access, llms.txt and JavaScript-only content'],
];

export function NewAudit({ onStarted, onOpen }: { onStarted: (id: string) => void; onOpen: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [preset, setPreset] = useState<Preset>('standard');
  const [advanced, setAdvanced] = useState(false);
  const [opts, setOpts] = useState<Required<Pick<AuditOptions, 'maxPages' | 'maxDepth' | 'concurrency' | 'userAgent' | 'respectRobots' | 'includeSubdomains' | 'checkExternal' | 'checkResources' | 'useSitemaps' | 'stripQuery' | 'crawlDelayMs' | 'timeoutSec' | 'pageSpeed'>>>({
    maxPages: 100, maxDepth: 10, concurrency: 8, userAgent: 'default', respectRobots: true, includeSubdomains: false,
    checkExternal: true, checkResources: true, useSitemaps: true, stripQuery: false, crawlDelayMs: 0, timeoutSec: 20, pageSpeed: true,
  });
  const [keyword, setKeyword] = useState('');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [psiKey, setPsiKey] = useState(() => storageGet(KEY_STORE));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof typeof opts>(k: K, v: (typeof opts)[K]) => setOpts(o => ({ ...o, [k]: v }));

  const start = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!url.trim()) return;
    setStarting(true);
    setError('');
    storageSet(KEY_STORE, psiKey.trim());
    const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);
    try {
      const res = await auditApi.start({
        url: url.trim(), ...opts,
        maxPages: Number.isFinite(opts.maxPages) ? opts.maxPages : 100,
        keyword: keyword.trim() || undefined, include: lines(include), exclude: lines(exclude),
        pageSpeedKey: psiKey.trim() || undefined,
      });
      onStarted(res.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-5 sm:p-6 relative overflow-hidden">
        <div className="absolute -right-24 -top-24 size-72 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
        <div className="relative max-w-3xl">
          <h2 className="text-lg font-semibold tracking-tight">Audit any website</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Crawls the site and runs every check from the premium SEO suites — technical SEO, content, links, speed, security, schema and AI-search readiness — in one report.
          </p>
          <form onSubmit={start} className="mt-4 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="example.com" className="pl-8 h-10" autoFocus />
            </div>
            <Button type="submit" size="lg" disabled={starting || !url.trim()}>
              {starting ? <Loader2 className="animate-spin" /> : <Play />} Start audit
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Segmented<Preset> value={preset} options={[...PRESETS.map(p => ({ value: p.value as Preset, label: p.label })), { value: 'custom', label: 'Custom' }]}
              onChange={v => {
                setPreset(v);
                const p = PRESETS.find(x => x.value === v);
                if (p) set('maxPages', p.pages);
                if (v === 'custom') setAdvanced(true);
              }} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdvanced(a => !a)}>
              <Settings2 /> {advanced ? 'Hide' : 'Crawl'} settings
            </Button>
          </div>
          {error && <div className="mt-3"><ErrorBox message={error} /></div>}
        </div>

        {advanced && (
          <div className="relative mt-5 pt-5 border-t border-border grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <NumberField label="Max pages" value={opts.maxPages} min={1} max={10000} onChange={v => { set('maxPages', v); setPreset('custom'); }} />
            <NumberField label="Max click depth" value={opts.maxDepth} min={1} max={50} onChange={v => set('maxDepth', v)} />
            <NumberField label="Parallel requests" value={opts.concurrency} min={1} max={32} onChange={v => set('concurrency', v)} />
            <NumberField label="Delay between requests" suffix="ms" value={opts.crawlDelayMs} min={0} max={10000} step={100} onChange={v => set('crawlDelayMs', v)} />
            <div className="space-y-1.5">
              <FieldLabel>User agent</FieldLabel>
              <select value={opts.userAgent} onChange={e => set('userAgent', e.target.value)}
                className="w-full h-8 rounded-md border border-input bg-card px-2 text-xs">
                {UAS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </div>
            <NumberField label="Request timeout" suffix="s" value={opts.timeoutSec} min={5} max={60} onChange={v => set('timeoutSec', v)} />
            <div className="space-y-1.5">
              <FieldLabel>Focus keyword (optional)</FieldLabel>
              <Input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="e.g. running shoes" className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>PageSpeed API key (optional)</FieldLabel>
              <Input value={psiKey} onChange={e => setPsiKey(e.target.value)} placeholder="AIza…" type="password" className="h-8 text-xs" />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <FieldLabel>Only crawl URLs matching (regex, one per line)</FieldLabel>
              <textarea value={include} onChange={e => setInclude(e.target.value)} rows={2} placeholder="/blog/"
                className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs font-mono" />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <FieldLabel>Exclude URLs matching (regex, one per line)</FieldLabel>
              <textarea value={exclude} onChange={e => setExclude(e.target.value)} rows={2} placeholder={'/tag/\n\\?page='}
                className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs font-mono" />
            </div>
            <div className="md:col-span-2 xl:col-span-4 flex flex-wrap gap-x-5 gap-y-2">
              <Checkbox checked={opts.respectRobots} onChange={v => set('respectRobots', v)}>Respect robots.txt</Checkbox>
              <Checkbox checked={opts.useSitemaps} onChange={v => set('useSitemaps', v)}>Crawl sitemap URLs (find orphans)</Checkbox>
              <Checkbox checked={opts.checkExternal} onChange={v => set('checkExternal', v)}>Check external links</Checkbox>
              <Checkbox checked={opts.checkResources} onChange={v => set('checkResources', v)}>Check images, JS & CSS</Checkbox>
              <Checkbox checked={opts.pageSpeed} onChange={v => set('pageSpeed', v)}>Lighthouse / Core Web Vitals</Checkbox>
              <Checkbox checked={opts.includeSubdomains} onChange={v => set('includeSubdomains', v)}>Include subdomains</Checkbox>
              <Checkbox checked={opts.stripQuery} onChange={v => set('stripQuery', v)}>Ignore query strings</Checkbox>
            </div>
          </div>
        )}
      </section>

      <AuditHistory onOpen={onOpen} />

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {FEATURES.map(([t, d]) => (
          <div key={t} className="rounded-lg border border-border bg-card px-3 py-2.5">
            <p className="text-xs font-medium">{t}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const [audits, setAudits] = useState<AuditSummary[] | null>(null);
  const [error, setError] = useState('');
  const load = () => auditApi.list().then(a => { setAudits(a); setError(''); }).catch(e => setError((e as Error).message));

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  // Score trend vs. the previous finished audit of the same host.
  const prevScore = useMemo(() => {
    const m: Record<string, number | undefined> = {};
    if (!audits) return m;
    const done = audits.filter(a => a.status === 'done');
    for (const a of done) {
      const older = done.find(b => b.host === a.host && new Date(b.createdAt) < new Date(a.createdAt));
      m[a.id] = older?.score;
    }
    return m;
  }, [audits]);

  if (error) return <ErrorBox message={error} />;
  if (!audits) return <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading audits…</p>;
  if (audits.length === 0) return null;

  return (
    <Section title="Audit history" icon={History}>
      <div className="divide-y divide-border -mx-4">
        {audits.map(a => {
          const running = a.status === 'running' || a.status === 'queued';
          const prev = prevScore[a.id];
          const delta = prev === undefined ? undefined : a.score - prev;
          return (
            <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/40 cursor-pointer" onClick={() => onOpen(a.id)}>
              {a.status === 'done' ? <ScoreRing score={a.score} size={40} /> : (
                <div className="size-10 rounded-full border border-border flex items-center justify-center shrink-0">
                  {running ? <Loader2 className="size-4 animate-spin text-primary" /> : <Square className="size-3.5 text-muted-foreground" />}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate">{a.host}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {running ? `${a.status === 'queued' ? 'Queued' : `${a.progress?.phase ?? 'running'} · ${a.pages} pages`}` :
                    a.status === 'done' ? `${a.pages.toLocaleString()} pages · ${fmtMs(a.durationMs)} · ${timeAgo(a.createdAt)}` :
                      `${a.status}${a.error ? ` — ${a.error}` : ''} · ${timeAgo(a.createdAt)}`}
                </p>
              </div>
              {delta !== undefined && (
                <span className={cn('hidden sm:inline-flex items-center gap-0.5 text-[11px] tabular-nums',
                  delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : delta < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}
                  title={`Previous audit of ${a.host}: ${prev}`}>
                  {delta > 0 ? <TrendingUp className="size-3.5" /> : delta < 0 ? <TrendingDown className="size-3.5" /> : <Minus className="size-3.5" />}
                  {delta > 0 ? '+' : ''}{delta}
                </span>
              )}
              {a.status === 'done' && (
                <div className="hidden md:flex items-center gap-1">
                  <SeverityBadge severity="error" count={a.errors} />
                  <SeverityBadge severity="warning" count={a.warnings} />
                  <SeverityBadge severity="notice" count={a.notices} />
                </div>
              )}
              {a.status === 'done' && a.categories && <div className="hidden xl:block w-28"><MiniScore score={a.score} /></div>}
              {!running && (
                <Button variant="ghost" size="icon-xs" title="Delete audit" onClick={async e => {
                  e.stopPropagation();
                  if (!confirm(`Delete the audit of ${a.host}?`)) return;
                  await auditApi.remove(a.id).catch(err => alert((err as Error).message));
                  load();
                }}><Trash2 /></Button>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
