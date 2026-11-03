import React, { useState } from 'react';
import { BadgeCheck, ChevronDown, ChevronRight, ExternalLink, Leaf, Globe2, History, ShieldCheck, ShieldAlert, FileCode2, Lock, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ThirdParty, VerifyCheck } from '../api';
import type { ReportCtx } from '../Report';
import { ExtLink, KV, Section, shortUrl } from '../ui';

const fmtDate = (s?: string) => s && !s.startsWith('0001') ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

function gradeTone(g?: string) {
  const x = (g || '').replace(/[+-]/g, '');
  if (x === 'A') return 'text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10';
  if (x === 'B') return 'text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10';
  return 'text-red-600 dark:text-red-400 border-red-500/40 bg-red-500/10';
}

function Grade({ g }: { g?: string }) {
  return <span className={cn('inline-flex items-center justify-center min-w-10 h-10 px-2 rounded-lg border text-lg font-semibold', gradeTone(g))}>{g || '?'}</span>;
}

function Card({ title, icon, check, children }: { title: string; icon: React.ElementType; check?: VerifyCheck; children?: React.ReactNode }) {
  if (!check) return null;
  return (
    <Section title={title} icon={icon} action={
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {check.ms > 0 && <span className="tabular-nums">{(check.ms / 1000).toFixed(1)}s</span>}
        {check.reportUrl && <ExtLink href={check.reportUrl} className="inline-flex items-center gap-1 hover:text-primary">Full report <ExternalLink className="size-3" /></ExtLink>}
      </span>
    }>
      {check.status === 'ok' ? children : (
        <p className={cn('text-xs', check.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
          {check.status === 'skipped' ? 'Skipped' : 'Failed'}{check.error ? ` — ${check.error}` : ''}
        </p>
      )}
    </Section>
  );
}

export function VerificationTab({ ctx }: { ctx: ReportCtx }) {
  const { report: r, openPage, goTo } = ctx;
  const tp: ThirdParty | undefined = r.site.thirdParty;
  if (!tp || Object.keys(tp).length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
        No third-party verification ran for this audit. It's skipped for IP addresses and localhost, and when every verifier is switched off in Crawl settings › Verification.
      </div>
    );
  }
  const linkIssue = (id: string) => r.issues.some(i => i.id === id) && (
    <button className="text-[11px] text-primary hover:underline cursor-pointer" onClick={() => goTo('issues', { issue: id })}>View issue →</button>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Mozilla HTTP Observatory" icon={ShieldCheck} check={tp.observatory}>
        {tp.observatory && (
          <div className="flex items-center gap-4">
            <Grade g={tp.observatory.grade} />
            <div className="text-xs space-y-0.5">
              <p><b className="tabular-nums">{tp.observatory.score}</b>/100 score</p>
              <p className="text-muted-foreground">{tp.observatory.testsPassed} of {tp.observatory.testsTotal} tests passed{tp.observatory.testsFailed ? `, ${tp.observatory.testsFailed} failed` : ''}</p>
              {linkIssue('observatory-low-grade')}
            </div>
          </div>
        )}
      </Card>

      <Card title="Qualys SSL Labs" icon={Lock} check={tp.sslLabs}>
        {tp.sslLabs && (
          <div className="flex items-start gap-4">
            <Grade g={tp.sslLabs.grade} />
            <div className="text-xs space-y-0.5 min-w-0">
              {tp.sslLabs.endpoints?.map(e => (
                <p key={e.ip} className="font-mono text-[11px]">{e.ip} — <b>{e.grade || e.message}</b>{e.hasWarnings ? ' (warnings)' : ''}</p>
              ))}
              {linkIssue('ssllabs-low-grade')}
            </div>
          </div>
        )}
      </Card>

      <Card title="Google Safe Browsing" icon={tp.safeBrowsing?.matches?.length ? ShieldAlert : BadgeCheck} check={tp.safeBrowsing}>
        {tp.safeBrowsing && (tp.safeBrowsing.matches.length === 0 ? (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">No malware, phishing or unwanted-software matches across {tp.safeBrowsing.checked.toLocaleString()} URLs (your pages + outbound links).</p>
        ) : (
          <div className="space-y-1.5 text-xs">
            <p className="text-red-600 dark:text-red-400 font-medium">{tp.safeBrowsing.matches.length} flagged URL{tp.safeBrowsing.matches.length > 1 ? 's' : ''}</p>
            {tp.safeBrowsing.matches.map(m => (
              <p key={m.url + m.threatType} className="font-mono text-[11px] break-all">
                <span className="mr-1.5 rounded bg-red-500/10 text-red-600 dark:text-red-400 px-1">{m.threatType}</span>
                {m.own ? 'your page ' : 'outbound '}{m.url}
              </p>
            ))}
            {linkIssue('links-to-unsafe')}
          </div>
        ))}
      </Card>

      <Card title="Domain registration (RDAP)" icon={Globe2} check={tp.rdap}>
        {tp.rdap && (
          <div className="text-xs">
            <KV label="Domain">{tp.rdap.domain}</KV>
            <KV label="Registrar">{tp.rdap.registrar || '—'}</KV>
            <KV label="Registered">{fmtDate(tp.rdap.registered)}{tp.rdap.ageYears > 0 && <span className="text-muted-foreground"> · {tp.rdap.ageYears} years old</span>}</KV>
            <KV label="Expires"><span className={cn(tp.rdap.expires && tp.rdap.daysLeft < 30 && 'text-red-600 dark:text-red-400 font-medium')}>{fmtDate(tp.rdap.expires)}{tp.rdap.expires && !tp.rdap.expires.startsWith('0001') && ` · ${tp.rdap.daysLeft} days left`}</span></KV>
            <KV label="DNSSEC">{tp.rdap.dnssec ? 'signed' : 'not signed'}</KV>
            {tp.rdap.nameservers?.length ? <KV label="Nameservers" mono>{tp.rdap.nameservers.join(', ')}</KV> : null}
            {tp.rdap.statuses?.length ? <KV label="Status">{tp.rdap.statuses.join(', ')}</KV> : null}
          </div>
        )}
      </Card>

      <Card title="W3C HTML validator" icon={FileCode2} check={tp.w3c}>
        {tp.w3c && <W3CList pages={tp.w3c.pages} origin={r.site.origin} openPage={openPage} />}
      </Card>

      <div className="grid gap-4 content-start">
        <Card title="Internet Archive" icon={History} check={tp.wayback}>
          {tp.wayback && (!tp.wayback.firstCapture || tp.wayback.firstCapture.startsWith('0001') ? (
            <p className="text-xs text-muted-foreground">The Wayback Machine has no captures of this host yet.</p>
          ) : (
            <div className="text-xs">
              <KV label="First capture">{fmtDate(tp.wayback.firstCapture)}</KV>
              <KV label="Latest capture">{tp.wayback.lastUrl ? <ExtLink href={tp.wayback.lastUrl} className="hover:text-primary">{fmtDate(tp.wayback.lastCapture)}</ExtLink> : fmtDate(tp.wayback.lastCapture)}</KV>
            </div>
          ))}
        </Card>
        <Card title="Tranco popularity rank" icon={TrendingUp} check={tp.tranco}>
          {tp.tranco && (
            <p className="text-xs">{tp.tranco.rank ? <><b className="text-base tabular-nums">#{tp.tranco.rank.toLocaleString()}</b> <span className="text-muted-foreground">of the top 1M ({tp.tranco.date}){tp.tranco.best && tp.tranco.best < tp.tranco.rank ? `, best #${tp.tranco.best.toLocaleString()} in the last 30 days` : ''}</span></> :
              <span className="text-muted-foreground">{tp.tranco.domain} is not in the Tranco top 1M.</span>}</p>
          )}
        </Card>
        <Card title="Green Web Foundation" icon={Leaf} check={tp.greenWeb}>
          {tp.greenWeb && (
            <p className={cn('text-xs', tp.greenWeb.green ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
              {tp.greenWeb.green ? <>Runs on verified green energy{tp.greenWeb.hostedBy && <> — hosted by {tp.greenWeb.hostUrl ? <ExtLink href={tp.greenWeb.hostUrl.startsWith('http') ? tp.greenWeb.hostUrl : `https://${tp.greenWeb.hostUrl}`} className="underline">{tp.greenWeb.hostedBy}</ExtLink> : tp.greenWeb.hostedBy}</>}.</> :
                'Not verified as green hosting by the Green Web Foundation.'}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

function W3CList({ pages, origin, openPage }: { pages: NonNullable<ThirdParty['w3c']>['pages']; origin: string; openPage: (u: string) => void }) {
  const [open, setOpen] = useState<string | null>(pages.find(p => p.errors > 0)?.url ?? null);
  return (
    <div className="divide-y divide-border -mx-4 -mb-4 text-xs">
      {pages.map(p => (
        <div key={p.url}>
          <button onClick={() => setOpen(o => o === p.url ? null : p.url)} className="w-full flex items-center gap-2 px-4 py-2 hover:bg-secondary/40 cursor-pointer text-left">
            {open === p.url ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
            <span className="font-mono text-[11px] truncate flex-1">{shortUrl(p.url, origin)}</span>
            {p.error ? <span className="text-muted-foreground">{p.error}</span> : <>
              <span className={cn('tabular-nums', p.errors ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>{p.errors} errors</span>
              <span className="tabular-nums text-amber-600 dark:text-amber-400">{p.warnings} warnings</span>
            </>}
          </button>
          {open === p.url && (
            <div className="px-4 pb-3 space-y-1.5">
              <div className="flex gap-3 text-[11px]">
                <button className="text-primary hover:underline cursor-pointer" onClick={() => openPage(p.url)}>Page details</button>
                <ExtLink href={`https://validator.w3.org/nu/?doc=${encodeURIComponent(p.url)}`} className="text-primary hover:underline">Validate on w3.org ↗</ExtLink>
              </div>
              {(p.messages || []).map((m, i) => (
                <div key={i} className="rounded border border-border px-2 py-1.5">
                  <p><span className={cn('mr-1.5 text-[10px] uppercase font-semibold', m.type === 'error' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')}>{m.type}</span>{m.message}{m.line ? <span className="text-muted-foreground"> · line {m.line}</span> : null}</p>
                  {m.extract && <pre className="mt-1 font-mono text-[10px] text-muted-foreground whitespace-pre-wrap break-all">{m.extract}</pre>}
                </div>
              ))}
              {!p.error && !p.messages?.length && <p className="text-emerald-600 dark:text-emerald-400">Valid HTML — no errors or warnings.</p>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
