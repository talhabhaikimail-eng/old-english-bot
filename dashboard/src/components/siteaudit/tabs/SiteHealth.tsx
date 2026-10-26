import React from 'react';
import { Bot, Cpu, FileCode2, Globe, Lock, Map, Network, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProbeResult } from '../api';
import type { ReportCtx } from '../Report';
import { Check, ExtLink, KV, Section, fmtBytes } from '../ui';

const gradeTone = (g: string) => g.startsWith('A') ? 'bg-emerald-500' : g === 'B' ? 'bg-lime-500' : g === 'C' ? 'bg-amber-500' : g === 'D' ? 'bg-orange-500' : 'bg-red-500';

export function SiteHealthTab({ ctx }: { ctx: ReportCtx }) {
  const s = ctx.report.site;
  const https = s.finalUrl.startsWith('https://');
  const t = s.tls;
  const techByCat = s.tech.reduce<Record<string, typeof s.tech>>((m, x) => { (m[x.category] ||= []).push(x); return m; }, {});

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="HTTPS & TLS certificate" icon={Lock}>
          <Check ok={https}>{https ? 'Site is served over HTTPS' : 'Site is served over plain HTTP'}</Check>
          <ProbeCheck p={s.httpsRedirect} okText="http:// redirects to https://" failText="http:// does not redirect to https://" />
          {t && (
            <>
              <Check ok={t.valid}>{t.valid ? 'Certificate is valid and trusted' : `Certificate problem: ${t.error}`}</Check>
              {t.notAfter && t.daysLeft !== undefined && <Check ok={t.daysLeft >= 30} warn={t.daysLeft >= 0}>Expires {new Date(t.notAfter).toLocaleDateString()} ({t.daysLeft} days)</Check>}
              <Check ok={s.http2}>{s.http2 ? `HTTP/2 supported (${s.protocol})` : `No HTTP/2 (${s.protocol || 'unknown'})`}</Check>
              <div className="mt-3">
                <KV label="Protocol">{t.version} · {t.cipher}</KV>
                <KV label="Issuer">{t.issuer}</KV>
                <KV label="Subject">{t.subject}</KV>
                <KV label="Key">{t.keyType} · chain of {t.chainLength}</KV>
                {t.sans && <KV label="Covers">{t.sans.slice(0, 8).join(', ')}{t.sans.length > 8 ? ` +${t.sans.length - 8}` : ''}</KV>}
              </div>
            </>
          )}
        </Section>

        <Section title="Security headers" icon={ShieldCheck}
          action={<span className={cn('size-9 rounded-md text-white text-base font-bold flex items-center justify-center', gradeTone(s.securityGrade))} aria-label={`Grade ${s.securityGrade}`}>{s.securityGrade}</span>}>
          {s.securityHeaders.map(h => (
            <Check key={h.name} ok={h.good} warn={h.name === 'Cross-Origin-Opener-Policy' || h.name === 'Permissions-Policy'}>
              <span className="font-medium">{h.name}</span>
              {h.value && <code className="block text-[11px] text-muted-foreground break-all">{h.value}</code>}
              {h.note && <span className="block text-[11px] text-muted-foreground">{h.note}</span>}
            </Check>
          ))}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Crawling & indexing setup" icon={Globe}>
          <Check ok={!!s.robots?.found}>{s.robots?.found ? <>robots.txt found ({fmtBytes(s.robots.size)})</> : `No robots.txt (HTTP ${s.robots?.status ?? '?'})`}</Check>
          <Check ok={(s.robots?.sitemaps?.length ?? 0) > 0} warn>{(s.robots?.sitemaps?.length ?? 0) > 0 ? 'robots.txt references a sitemap' : 'robots.txt has no Sitemap: line'}</Check>
          <Check ok={s.sitemaps.some(x => !x.error)}>{s.sitemapUrls.toLocaleString()} URLs in {s.sitemaps.length} sitemap file(s)</Check>
          <ProbeCheck p={s.soft404} okText="Missing pages return a real 404" failText="Missing pages return 200 (soft 404)" />
          <ProbeCheck p={s.wwwCheck} okText="www / non-www consolidated" failText="www and non-www both serve content" />
          <ProbeCheck p={s.favicon} okText="Favicon available" failText="No favicon" warn />
          <ProbeCheck p={s.securityTxt} okText="security.txt published" failText="No /.well-known/security.txt" warn />
          {s.startRedirects && s.startRedirects.length > 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              Start URL redirects: {s.startRedirects.map(r => `${r.url} (${r.status})`).join(' → ')} → {s.finalUrl}
            </div>
          )}
          {s.robots?.content && (
            <details className="mt-3">
              <summary className="text-xs cursor-pointer text-muted-foreground hover:text-foreground">View robots.txt</summary>
              <pre className="mt-2 text-[11px] font-mono bg-secondary/50 border border-border rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">{s.robots.content}</pre>
            </details>
          )}
        </Section>

        <Section title="AI search & crawler access" icon={Bot}>
          <ProbeCheck p={s.llmsTxt} okText="llms.txt published" failText="No llms.txt" warn />
          <div className="mt-2 grid gap-x-4 sm:grid-cols-2">
            {[...(s.robots?.searchBots || []), ...(s.robots?.aiBots || [])].map(b => (
              <div key={b.token} className="flex items-center gap-2 py-1 text-xs border-b border-border" title={b.rule}>
                <span className={cn('size-2 rounded-full shrink-0', b.allowed ? 'bg-emerald-500' : 'bg-red-500')} />
                <span className="font-medium">{b.token}</span>
                <span className="text-[11px] text-muted-foreground truncate flex-1">{b.owner} · {b.purpose}</span>
                <span className={cn('text-[11px]', b.allowed ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{b.allowed ? 'allowed' : 'blocked'}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Sitemaps" icon={Map}>
          {s.sitemaps.length === 0 ? <p className="text-xs text-muted-foreground">No sitemap found at robots.txt references or /sitemap.xml.</p> : (
            <div className="divide-y divide-border">
              {s.sitemaps.map(x => (
                <div key={x.url} className="py-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={cn('size-2 rounded-full shrink-0', x.error ? 'bg-red-500' : 'bg-emerald-500')} />
                    <ExtLink href={x.url} className="font-mono text-[11px] truncate flex-1">{x.url}</ExtLink>
                    <span className="text-muted-foreground shrink-0">{x.kind === 'sitemapindex' ? `index · ${x.children} sitemaps` : `${x.urlCount.toLocaleString()} URLs`}</span>
                  </div>
                  {x.error && <p className="text-[11px] text-red-600 dark:text-red-400 ml-4">{x.error}</p>}
                  {x.warnings?.map(w => <p key={w} className="text-[11px] text-amber-600 dark:text-amber-400 ml-4">{w}</p>)}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="DNS & email authentication" icon={Network}>
          {!s.dns ? <p className="text-xs text-muted-foreground">Not available.</p> : (
            <>
              <KV label="A / AAAA" mono>{[...(s.dns.a || []), ...(s.dns.aaaa || [])].join(', ') || '—'}</KV>
              {s.dns.cname && <KV label="CNAME" mono>{s.dns.cname}</KV>}
              <KV label="Nameservers" mono>{(s.dns.ns || []).join(', ') || '—'}</KV>
              <KV label="Mail (MX)" mono>{(s.dns.mx || []).join(', ') || 'none'}</KV>
              <div className="mt-2">
                <Check ok={!!s.dns.spf} warn>{s.dns.spf ? <>SPF <code className="text-[11px] text-muted-foreground break-all">{s.dns.spf}</code></> : 'No SPF record'}</Check>
                <Check ok={!!s.dns.dmarc} warn>{s.dns.dmarc ? <>DMARC <code className="text-[11px] text-muted-foreground break-all">{s.dns.dmarc}</code>{/p=none/i.test(s.dns.dmarc) && <span className="block text-[11px] text-amber-600 dark:text-amber-400">Policy is p=none (monitor only)</span>}</> : 'No DMARC record'}</Check>
                <Check ok={s.dns.caa} warn>{s.dns.caa ? 'CAA record restricts certificate issuers' : 'No CAA record'}</Check>
                <Check ok={s.dns.dnssec} warn>{s.dns.dnssec ? 'DNSSEC validated' : 'DNSSEC not enabled'}</Check>
                <Check ok={(s.dns.aaaa || []).length > 0} warn>{(s.dns.aaaa || []).length > 0 ? 'IPv6 (AAAA) available' : 'No IPv6 address'}</Check>
              </div>
            </>
          )}
        </Section>
      </div>

      <Section title={`Technology stack (${s.tech.length})`} icon={Cpu}>
        {s.tech.length === 0 ? <p className="text-xs text-muted-foreground">Nothing recognised.</p> : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Object.entries(techByCat).map(([cat, items]) => (
              <div key={cat}>
                <p className="text-[11px] text-muted-foreground mb-1">{cat}</p>
                <div className="flex flex-wrap gap-1">
                  {items.map(x => (
                    <span key={x.name} title={x.evidence} className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-border bg-secondary/50 text-xs">
                      {x.name}{x.version && <span className="text-muted-foreground text-[10px]">{x.version}</span>}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {s.server && <p className="mt-3 text-[11px] text-muted-foreground flex items-center gap-1"><FileCode2 className="size-3" /> Server header: <code>{s.server}</code>{s.ip?.length ? ` · ${s.ip.join(', ')}` : ''}</p>}
      </Section>
    </div>
  );
}

function ProbeCheck({ p, okText, failText, warn }: { p?: ProbeResult; okText: string; failText: string; warn?: boolean }) {
  if (!p) return null;
  return (
    <Check ok={p.ok} warn={warn}>
      {p.ok ? okText : failText}
      {(p.note || p.error) && <span className="block text-[11px] text-muted-foreground">{p.note || p.error}</span>}
    </Check>
  );
}
