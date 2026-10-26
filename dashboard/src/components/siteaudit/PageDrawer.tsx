import React, { useEffect, useState } from 'react';
import { ExternalLink, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CopyButton, ErrorBox } from '../devtools/shared';
import { auditApi, type PageDetail } from './api';
import { Check, ExtLink, KV, SeverityBadge, StatusPill, fmtBytes, shortUrl } from './ui';

const TABS = ['Summary', 'Issues', 'Headings', 'Links', 'Images', 'Schema', 'Content', 'HTTP'] as const;
type Tab = typeof TABS[number];

export function PageDrawer({ auditId, url, origin, onClose, onOpen }: { auditId: string; url: string; origin: string; onClose: () => void; onOpen: (u: string) => void }) {
  const [d, setD] = useState<PageDetail | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('Summary');

  useEffect(() => {
    setD(null); setError('');
    auditApi.page(auditId, url).then(setD).catch(e => setError((e as Error).message));
  }, [auditId, url]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const p = d?.page;
  const counts: Partial<Record<Tab, number>> = p ? {
    Issues: d!.issues.length, Headings: p.headings?.length || 0, Links: (p.links?.length || 0) + d!.inlinks.length,
    Images: p.images?.length || 0, Schema: p.schema?.length || 0,
  } : {};

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative w-full max-w-3xl h-full bg-background border-l border-border shadow-2xl flex flex-col">
        <header className="px-4 py-3 border-b border-border flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="font-mono text-xs break-all">{url}</p>
            {p && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <StatusPill status={p.status} error={p.error} blocked={p.blockedByRobots} />
                <span className={p.indexable ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>{p.indexable ? 'Indexable' : `Not indexable — ${p.indexReason}`}</span>
                <span>· depth {p.depth < 0 ? 'orphan' : p.depth}</span>
                <span>· {p.inlinks} inlinks</span>
                <span>· link score {p.linkScore}</span>
              </div>
            )}
          </div>
          <CopyButton value={url} />
          <ExtLink href={url}><Button variant="ghost" size="icon-xs" title="Open page"><ExternalLink /></Button></ExtLink>
          <Button variant="ghost" size="icon-xs" onClick={onClose} title="Close (Esc)"><X /></Button>
        </header>
        <nav className="flex gap-0.5 overflow-x-auto border-b border-border px-2">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} className={cn('h-8 px-2.5 text-xs whitespace-nowrap border-b-2 -mb-px cursor-pointer', tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {t}{counts[t] ? <span className="ml-1 opacity-60 tabular-nums">{counts[t]}</span> : null}
            </button>
          ))}
        </nav>
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {error && <ErrorBox message={error} />}
          {!d && !error && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading…</p>}
          {d && p && tab === 'Summary' && <Summary d={d} />}
          {d && tab === 'Issues' && (
            d.issues.length === 0 ? <p className="text-xs text-muted-foreground">No issues on this URL.</p> :
              <div className="space-y-2">{d.issues.map(i => (
                <div key={i.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center gap-2"><SeverityBadge severity={i.severity} /><span className="text-xs font-medium">{i.title}</span></div>
                  {i.details?.[url] && <p className="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">{i.details[url]}</p>}
                  <p className="mt-1.5 text-[11px]"><span className="text-muted-foreground">Fix: </span>{i.fix}</p>
                </div>
              ))}</div>
          )}
          {d && p && tab === 'Headings' && (
            !p.headings?.length ? <p className="text-xs text-muted-foreground">No headings.</p> :
              <div className="space-y-0.5">{p.headings.map((h, i) => (
                <div key={i} className="flex items-baseline gap-2 text-xs" style={{ paddingLeft: (h.level - 1) * 14 }}>
                  <span className={cn('shrink-0 font-mono text-[10px] px-1 rounded', h.level === 1 ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground')}>H{h.level}</span>
                  <span className={cn(!h.text && 'italic text-muted-foreground')}>{h.text || 'empty heading'}</span>
                </div>
              ))}</div>
          )}
          {d && p && tab === 'Links' && <LinksView d={d} origin={origin} onOpen={onOpen} />}
          {d && p && tab === 'Images' && (
            !p.images?.length ? <p className="text-xs text-muted-foreground">No images.</p> :
              <div className="grid gap-2 sm:grid-cols-2">{p.images.map(im => (
                <div key={im.src} className="rounded-md border border-border p-2 flex gap-2 min-w-0">
                  <img src={im.src} alt="" loading="lazy" className="size-14 object-contain rounded bg-secondary shrink-0" onError={e => (e.currentTarget.style.visibility = 'hidden')} />
                  <div className="min-w-0 text-[11px] space-y-0.5">
                    <ExtLink href={im.src} className="font-mono block truncate">{shortUrl(im.src, origin)}</ExtLink>
                    <p className={cn(!im.hasAlt && 'text-red-600 dark:text-red-400')}>{im.hasAlt ? (im.alt ? `alt="${im.alt}"` : 'alt="" (decorative)') : 'missing alt'}</p>
                    <p className="text-muted-foreground">{[im.format, im.size ? fmtBytes(im.size) : '', im.width && im.height ? `${im.width}×${im.height}` : 'no dimensions', im.lazy ? 'lazy' : '', im.srcset ? 'srcset' : ''].filter(Boolean).join(' · ')}
                      {im.status && im.status >= 400 ? <span className="text-red-600 dark:text-red-400"> · HTTP {im.status}</span> : null}</p>
                  </div>
                </div>
              ))}</div>
          )}
          {d && p && tab === 'Schema' && (
            !p.schema?.length ? <p className="text-xs text-muted-foreground">No structured data on this page.</p> :
              <div className="space-y-2">{p.schema.map((s, i) => (
                <div key={i} className="rounded-md border border-border p-3">
                  <p className="text-xs font-medium">{(s.types || []).join(', ') || 'Untyped'} <span className="text-muted-foreground font-normal">({s.format})</span></p>
                  {s.errors?.map(e => <p key={e} className={cn('text-[11px]', e.endsWith('(warning)') ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400')}>{e}</p>)}
                  {s.raw && <pre className="mt-2 text-[11px] font-mono bg-secondary/50 rounded p-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">{prettyJSON(s.raw)}</pre>}
                </div>
              ))}</div>
          )}
          {d && p && tab === 'Content' && (
            <div className="space-y-4">
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 text-xs">
                <Tile label="Words" value={p.wordCount.toLocaleString()} />
                <Tile label="Sentences" value={p.sentences.toLocaleString()} />
                <Tile label="Readability" value={p.readability ? `${p.readability}` : '—'} hint={p.readingLevel} />
                <Tile label="Text / HTML" value={`${p.textRatio}%`} />
              </div>
              {p.keywordCheck && (
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs font-medium mb-1">Focus keyword “{p.keywordCheck.keyword}” — {p.keywordCheck.occurrences} occurrences</p>
                  <div className="grid sm:grid-cols-2">
                    <Check ok={p.keywordCheck.inTitle}>In title</Check><Check ok={p.keywordCheck.inH1}>In H1</Check>
                    <Check ok={p.keywordCheck.inDescription}>In meta description</Check><Check ok={p.keywordCheck.inUrl} warn>In URL</Check>
                    <Check ok={p.keywordCheck.inFirst100} warn>In first 100 words</Check>
                  </div>
                </div>
              )}
              {p.keywords && p.keywords.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-1">Top keywords & phrases</p>
                  <div className="flex flex-wrap gap-1">{p.keywords.map(k => (
                    <span key={k.term} className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-border bg-secondary/50 text-xs">{k.term}<span className="text-[10px] text-muted-foreground tabular-nums">{k.count} · {k.density}%</span></span>
                  ))}</div>
                </div>
              )}
              {p.textSample && <div><p className="text-xs font-medium mb-1">Text sample</p><p className="text-xs text-muted-foreground leading-relaxed">{p.textSample}…</p></div>}
            </div>
          )}
          {d && p && tab === 'HTTP' && (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium mb-1">Timing</p>
                <TimingBar t={p.timing} />
              </div>
              <div>
                <KV label="Protocol">{p.proto}</KV>
                <KV label="Content-Type">{p.contentType}</KV>
                <KV label="Size">{fmtBytes(p.size)} decoded · {fmtBytes(p.transferSize)} transferred {p.compression ? `(${p.compression})` : '(uncompressed)'}</KV>
                <KV label="DOM">{p.domNodes.toLocaleString()} elements · depth {p.domDepth}</KV>
                <KV label="Render-blocking">{p.renderBlocking} resources in &lt;head&gt;</KV>
                <KV label="Inline code">{p.inlineScriptKb} KB JS · {p.inlineStyleKb} KB CSS</KV>
                <KV label="Scripts / CSS">{p.scripts?.length || 0} / {p.styles?.length || 0}</KV>
                {Object.entries(p.headers || {}).map(([k, v]) => <KV key={k} label={k} mono>{v}</KV>)}
              </div>
              {d.chain && (
                <div>
                  <p className="text-xs font-medium mb-1">Redirect chain</p>
                  {d.chain.hops.map((h, i) => <p key={i} className="text-[11px] font-mono">{h.status} {h.url}</p>)}
                  <p className="text-[11px] font-mono">{d.chain.loop ? '↺ loop' : `${d.chain.finalStatus} ${d.chain.final}`}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function Summary({ d }: { d: PageDetail }) {
  const p = d.page;
  const host = (() => { try { return new URL(p.url).host; } catch { return p.url; } })();
  const crumbs = (() => { try { return new URL(p.url).pathname.split('/').filter(Boolean).join(' › '); } catch { return ''; } })();
  const og = p.openGraph || {};
  return (
    <div className="space-y-4">
      {p.isHtml && (
        <div>
          <p className="text-[11px] text-muted-foreground mb-1.5">Google result preview</p>
          <div className="rounded-lg border border-border bg-white dark:bg-zinc-900 p-3 max-w-[600px]">
            <p className="text-[12px] text-zinc-700 dark:text-zinc-300 truncate">{host}{crumbs && <span className="text-zinc-500"> › {crumbs}</span>}</p>
            <p className="text-[18px] leading-snug text-[#1a0dab] dark:text-[#8ab4f8] truncate">{truncPx(p.title || 'Untitled', p.titlePx, 580)}</p>
            <p className="text-[13px] leading-snug text-zinc-600 dark:text-zinc-400 line-clamp-2">{p.description || <em>No meta description — Google will pick text from the page.</em>}</p>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Title {p.title.length} chars (~{p.titlePx}px of 580) · description {p.description.length} chars (~{p.descPx}px of 920)</p>
        </div>
      )}
      <div>
        <KV label="Title">{p.title || <span className="text-red-600 dark:text-red-400">missing</span>}{p.titleCount > 1 && <span className="text-amber-600"> ({p.titleCount} title tags)</span>}</KV>
        <KV label="Meta description">{p.description || <span className="text-red-600 dark:text-red-400">missing</span>}</KV>
        <KV label="H1">{p.h1.length ? p.h1.join(' | ') : <span className="text-red-600 dark:text-red-400">missing</span>}</KV>
        <KV label="Canonical" mono>{p.canonical ? (p.canonical === p.url ? 'self-referencing' : p.canonical) : 'none'}{p.canonicalCount > 1 && ` (${p.canonicalCount} tags)`}</KV>
        <KV label="Meta robots">{p.metaRobots || 'index, follow (default)'}</KV>
        {p.xRobots && <KV label="X-Robots-Tag">{p.xRobots}</KV>}
        <KV label="Language / charset">{p.lang || '—'} · {p.charset || '—'}</KV>
        <KV label="Viewport">{p.viewport || <span className="text-red-600 dark:text-red-400">missing</span>}</KV>
        <KV label="In sitemap">{p.inSitemap ? 'Yes' : 'No'}</KV>
        <KV label="Found from" mono>{p.foundFrom || 'start URL'}</KV>
        {p.redirectTo && <KV label="Redirects to" mono>{p.redirectTo}</KV>}
        {p.hreflang && p.hreflang.length > 0 && <KV label="hreflang">{p.hreflang.map(h => `${h.lang} → ${h.url}`).join('\n')}</KV>}
        {p.amp && <KV label="AMP" mono>{p.amp}</KV>}
        {p.generator && <KV label="Generator">{p.generator}</KV>}
      </div>
      {p.isHtml && (
        <div>
          <p className="text-[11px] text-muted-foreground mb-1.5">Social share preview</p>
          <div className="rounded-lg border border-border overflow-hidden max-w-[420px] bg-card">
            {og['og:image'] ? <img src={og['og:image']} alt="" className="w-full aspect-[1.91/1] object-cover bg-secondary" onError={e => (e.currentTarget.style.display = 'none')} /> :
              <div className="w-full aspect-[1.91/1] bg-secondary flex items-center justify-center text-xs text-muted-foreground">no og:image</div>}
            <div className="p-2.5">
              <p className="text-[11px] uppercase text-muted-foreground">{host}</p>
              <p className="text-sm font-semibold line-clamp-1">{og['og:title'] || p.title}</p>
              <p className="text-xs text-muted-foreground line-clamp-2">{og['og:description'] || p.description}</p>
            </div>
          </div>
        </div>
      )}
      {p.isHtml && (
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">Accessibility quick checks</p>
          <div className="grid sm:grid-cols-2">
            <Check ok={!p.a11y.imagesNoAlt}>Images without alt: {p.a11y.imagesNoAlt}</Check>
            <Check ok={!p.a11y.emptyLinks}>Links without text: {p.a11y.emptyLinks}</Check>
            <Check ok={!p.a11y.inputsNoLabel}>Unlabelled fields: {p.a11y.inputsNoLabel}</Check>
            <Check ok={!p.a11y.buttonsNoName}>Unnamed buttons: {p.a11y.buttonsNoName}</Check>
            <Check ok={!p.a11y.skippedHeadings} warn>Skipped heading levels: {p.a11y.skippedHeadings}</Check>
            <Check ok={!p.a11y.duplicateIds} warn>Duplicate IDs: {p.a11y.duplicateIds}</Check>
          </div>
        </div>
      )}
    </div>
  );
}

function LinksView({ d, origin, onOpen }: { d: PageDetail; origin: string; onOpen: (u: string) => void }) {
  const [dir, setDir] = useState<'out' | 'in'>('out');
  const out = d.page.links || [];
  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md border border-border bg-secondary p-0.5">
        {([['out', `Outlinks (${out.length})`], ['in', `Inlinks (${d.inlinks.length})`]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setDir(k)} className={cn('h-7 px-2.5 rounded-[5px] text-xs font-medium cursor-pointer', dir === k ? 'bg-card border border-border shadow-sm' : 'text-muted-foreground')}>{l}</button>
        ))}
      </div>
      <div className="divide-y divide-border rounded-md border border-border">
        {(dir === 'out' ? out.map(l => ({ url: l.url, anchor: l.anchor, internal: l.internal, nofollow: l.nofollow }))
          : d.inlinks.map(l => ({ url: l.from, anchor: l.anchor, internal: true, nofollow: l.nofollow }))).map((l, i) => (
          <div key={i} className="px-3 py-1.5 text-xs flex items-center gap-2 min-w-0">
            {l.internal ? <button onClick={() => onOpen(l.url)} className="font-mono text-[11px] truncate hover:text-primary cursor-pointer text-left flex-1 min-w-0" title={l.url}>{shortUrl(l.url, origin)}</button>
              : <ExtLink href={l.url} className="font-mono text-[11px] truncate flex-1 min-w-0">{shortUrl(l.url)}</ExtLink>}
            <span className="text-muted-foreground truncate max-w-[40%]" title={l.anchor}>{l.anchor || <em>no anchor</em>}</span>
            {l.nofollow && <span className="text-[10px] text-amber-600">nofollow</span>}
            {!l.internal && <span className="text-[10px] text-muted-foreground">ext</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TimingBar({ t }: { t: PageDetail['page']['timing'] }) {
  const parts = [
    { k: 'DNS', v: t.dnsMs, c: 'bg-violet-500' }, { k: 'Connect', v: t.connectMs, c: 'bg-sky-500' }, { k: 'TLS', v: t.tlsMs, c: 'bg-cyan-500' },
    { k: 'Wait (server)', v: Math.max(0, t.ttfbMs - t.dnsMs - t.connectMs - t.tlsMs), c: 'bg-amber-500' },
    { k: 'Download', v: Math.max(0, t.totalMs - t.ttfbMs), c: 'bg-emerald-500' },
  ];
  const total = Math.max(1, parts.reduce((n, p) => n + p.v, 0));
  return (
    <div>
      <div className="flex h-3 rounded overflow-hidden gap-[2px] bg-secondary">
        {parts.filter(p => p.v > 0).map(p => <div key={p.k} className={p.c} style={{ width: `${(p.v / total) * 100}%` }} title={`${p.k}: ${p.v} ms`} />)}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {parts.map(p => <span key={p.k} className="inline-flex items-center gap-1"><span className={cn('size-2 rounded-sm', p.c)} />{p.k} <b className="text-foreground tabular-nums">{p.v} ms</b></span>)}
        <span>TTFB <b className="text-foreground tabular-nums">{t.ttfbMs} ms</b> · total <b className="text-foreground tabular-nums">{t.totalMs} ms</b></span>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">DNS/connect/TLS are 0 when the crawler reused an open connection.</p>
    </div>
  );
}

function truncPx(s: string, px: number, max: number) {
  if (px <= max) return s;
  const keep = Math.floor(s.length * (max / px)) - 1;
  return s.slice(0, Math.max(10, keep)) + '…';
}

function prettyJSON(raw: string) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}
