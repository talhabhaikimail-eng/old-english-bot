import React, { useEffect, useMemo, useState } from 'react';
import { Globe, Loader2, Play, Settings2, Trash2, History, Square, TrendingDown, TrendingUp, Minus, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ErrorBox, Segmented } from '../devtools/shared';
import { auditApi, type AuditSummary } from './api';
import { AuditSettings, DEFAULT_SETTINGS, loadSettings, saveSettings, toOptions, type Settings } from './AuditSettings';
import { MiniScore, ScoreRing, Section, SeverityBadge, fmtMs, timeAgo } from './ui';

const PRESETS = [
  { value: 'quick', label: 'Quick (1 page)', pages: 1 },
  { value: 'standard', label: 'Standard (100)', pages: 100 },
  { value: 'deep', label: 'Deep (500)', pages: 500 },
  { value: 'full', label: 'Full (2,000)', pages: 2000 },
] as const;
type Preset = typeof PRESETS[number]['value'] | 'custom';

const KEY_STORE = 'siteaudit_psi_key';
function storageGet(k: string) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function storageSet(k: string, v: string) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* unavailable */ } }

export const FEATURES = [
  ['Site crawler', 'Crawl, sitemap-only or URL-list audits with robots.txt, depth, folder scope & param rules'],
  ['145+ checks', 'Site-audit issues with why-it-matters and how-to-fix; tune thresholds or switch checks off'],
  ['Broken links', 'Internal, external, images, JS & CSS — re-verified with a browser UA to cut false positives'],
  ['Duplicates', 'Duplicate titles, descriptions, H1s and near-duplicate content (simhash)'],
  ['Lighthouse', 'PageSpeed Insights lab scores + real-user Core Web Vitals (CrUX)'],
  ['3rd-party verification', 'W3C validator, Mozilla Observatory, Safe Browsing, SSL Labs, RDAP, Wayback, Tranco'],
  ['Security', 'TLS certificate, HTTPS, HSTS, security-header grade, mixed content, domain expiry'],
  ['Custom search', 'Find pages containing (or missing) any text/regex and extract fields into columns'],
  ['Staging sites', 'Basic auth and custom headers, sent only to the audited host and never stored'],
  ['Change tracking', 'Compare any two audits: new and fixed issues, added/removed pages, status changes'],
  ['Client reports', 'Printable HTML report plus CSV/JSON exports of pages, issues, links and assets'],
  ['AI search', 'AI crawler access, llms.txt and JavaScript-only content'],
];

export function NewAudit({ onStarted, onOpen }: { onStarted: (id: string) => void; onOpen: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [preset, setPreset] = useState<Preset>(() => PRESETS.find(p => p.pages === settings.maxPages)?.value ?? 'custom');
  const [advanced, setAdvanced] = useState(false);
  const [psiKey, setPsiKey] = useState(() => storageGet(KEY_STORE));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings(o => ({ ...o, [k]: v }));
    if (k === 'maxPages') setPreset(PRESETS.find(p => p.pages === v)?.value ?? 'custom');
  };
  useEffect(() => { saveSettings(settings); }, [settings]);

  const listMode = settings.mode === 'list';
  const listCount = settings.urlList.split('\n').filter(l => l.trim()).length;
  const canStart = listMode ? listCount > 0 : !!url.trim();
  const customised = useMemo(() => {
    const n: string[] = [];
    if (settings.mode !== 'crawl') n.push(settings.mode === 'list' ? `${listCount} listed URLs` : 'sitemap only');
    if (settings.subfolderOnly) n.push('folder only');
    if (settings.customSearch.length + settings.extract.length) n.push(`${settings.customSearch.length + settings.extract.length} custom rules`);
    if (settings.disabled.length) n.push(`${settings.disabled.length} checks off`);
    if (settings.authUser || settings.headers.trim()) n.push('authenticated');
    if (settings.verify.sslLabs) n.push('SSL Labs');
    return n;
  }, [settings, listCount]);

  const start = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canStart) return;
    const opts = toOptions(url, settings, psiKey);
    if (typeof opts === 'string') { setError(opts); setAdvanced(true); return; }
    setStarting(true);
    setError('');
    storageSet(KEY_STORE, psiKey.trim());
    try {
      const res = await auditApi.start(opts);
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
            Crawls the site and runs every check from the premium SEO suites — technical SEO, content, links, speed, security, schema and AI-search readiness — then cross-checks the results with independent third-party services.
          </p>
          <form onSubmit={start} className="mt-4 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              {listMode ? <ListChecks className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" /> : <Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />}
              <Input value={listMode ? `${listCount.toLocaleString()} URLs from your list — edit in Crawl settings › Scope` : url} readOnly={listMode}
                onChange={e => setUrl(e.target.value)} placeholder="example.com" className={cn('pl-8 h-10', listMode && 'text-muted-foreground cursor-pointer')} autoFocus
                onClick={() => listMode && setAdvanced(true)} />
            </div>
            <Button type="submit" size="lg" disabled={starting || !canStart}>
              {starting ? <Loader2 className="animate-spin" /> : <Play />} Start audit
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Segmented<Preset> value={preset} options={[...PRESETS.map(p => ({ value: p.value as Preset, label: p.label })), { value: 'custom', label: 'Custom' }]}
              onChange={v => {
                setPreset(v);
                const p = PRESETS.find(x => x.value === v);
                if (p) setSettings(o => ({ ...o, maxPages: p.pages }));
                if (v === 'custom') setAdvanced(true);
              }} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdvanced(a => !a)}>
              <Settings2 /> {advanced ? 'Hide' : 'Crawl'} settings
            </Button>
            {customised.length > 0 && <span className="text-[11px] text-muted-foreground">{customised.join(' · ')}</span>}
          </div>
          {error && <div className="mt-3"><ErrorBox message={error} /></div>}
        </div>

        {advanced && (
          <AuditSettings s={settings} set={set} psiKey={psiKey} setPsiKey={setPsiKey}
            onReset={() => { if (confirm('Reset all audit settings to their defaults?')) { setSettings(DEFAULT_SETTINGS); setPreset('standard'); } }} />
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
