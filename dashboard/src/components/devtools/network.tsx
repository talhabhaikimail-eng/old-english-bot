import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Clock, Download, ExternalLink, Globe,
  Loader2, Lock, Play, Radar, Route, Search, Server, ShieldCheck, Square, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  MONO, Checkbox, CopyButton, ErrorBox, FieldLabel, InfoBox, NumberField, OutputRow, Segmented, Stat, downloadBlob, formatBytes, toolsApi,
} from './shared';
import {
  PORT_PRESETS, chunk, countryFlag, formatMs, formatTtl, ipv4Info, ipv6Info, parseIPv4, parsePortSpec, parseV4Input,
  parseV6Input, prefixForHosts, prefixForSubnetCount, rangeToCidrs, sparklinePoints, splitIPv4, splitIPv6, formatBig,
} from './lib/network';

// ── shared bits ──────────────────────────────────────────────────────────────

/** The shared Tabs use Tailwind v4 data-* variants; these are the Tailwind 3 equivalents. */
const TAB_ACTIVE = 'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:border-border data-[state=active]:shadow-sm';

const TINT = {
  ok: 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] border-[color-mix(in_srgb,var(--primary)_45%,transparent)]',
  bad: 'bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] border-[color-mix(in_srgb,var(--destructive)_45%,transparent)]',
  warn: 'bg-amber-500/10 border-amber-500/40',
};
const WARN_TEXT = 'text-amber-600 dark:text-amber-400';
const SELECT = 'h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-primary';

function SelectBox<T extends string>({ value, onChange, options, className }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string;
}) {
  return (
    <select className={cn(SELECT, className)} value={value} onChange={e => onChange(e.target.value as T)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Host / URL input + run button, submits on Enter. */
function QueryBar({ value, onChange, onRun, loading, placeholder, label, button = 'Look up', icon, examples, children, disabled }: {
  value: string; onChange: (v: string) => void; onRun: () => void; loading: boolean; placeholder?: string; label: string;
  button?: string; icon?: React.ReactNode; examples?: string[]; children?: React.ReactNode; disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5 flex-1 min-w-52">
          <FieldLabel>{label}</FieldLabel>
          <Input className="font-mono" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !loading && !disabled) onRun(); }} autoCapitalize="off" spellCheck={false} />
        </div>
        {children}
        <Button onClick={onRun} disabled={loading || disabled || !value.trim()}>
          {loading ? <Loader2 className="animate-spin" /> : icon ?? <Search />} {button}
        </Button>
      </div>
      {examples && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          Try:
          {examples.map(x => <Button key={x} variant="ghost" size="xs" className="font-mono" onClick={() => onChange(x)}>{x}</Button>)}
        </div>
      )}
    </div>
  );
}

function useRequest<T>() {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const run = async (fn: () => Promise<T>) => {
    setLoading(true);
    setError('');
    try {
      const r = await fn();
      setData(r);
      return r;
    } catch (e) {
      setData(null);
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  };
  return { data, error, loading, run, setData };
}

const fmtDate = (s?: string) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDay = (s?: string) => (s ? new Date(s).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const daysFromNow = (s?: string) => (s ? Math.floor((new Date(s).getTime() - Date.now()) / 86400000) : null);

function ageText(s?: string) {
  const d = daysFromNow(s);
  if (d === null) return '';
  const a = Math.abs(d);
  const txt = a >= 730 ? `${Math.floor(a / 365)} years` : a >= 60 ? `${Math.floor(a / 30)} months` : `${a} days`;
  return d < 0 ? `${txt} ago` : `in ${txt}`;
}

function KV({ rows }: { rows: [string, React.ReactNode, string?][] }) {
  return (
    <div className="rounded-md border border-border px-3">
      {rows.filter(r => r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v, copy]) => (
        <div key={k} className="flex items-start gap-2 py-1.5 border-b border-border last:border-0 text-xs">
          <span className="w-32 shrink-0 text-muted-foreground">{k}</span>
          <span className="flex-1 min-w-0 break-all">{v}</span>
          {copy && <CopyButton value={copy} />}
        </div>
      ))}
    </div>
  );
}

// ── IP lookup ────────────────────────────────────────────────────────────────

interface IpResult {
  server: { ip: string | null };
  client: { ip: string; source: string; private?: boolean };
  query: string | null;
  host?: string;
  addresses?: string[];
  lookup: {
    ip: string; type?: string; country?: string; countryCode?: string; region?: string; city?: string; postal?: string;
    latitude?: number; longitude?: number; timezone?: string; asn?: string; org?: string; isp?: string; domain?: string;
    flags?: { proxy?: boolean; hosting?: boolean; mobile?: boolean }; source: string; ptr: string[];
  };
}

export function IpLookup() {
  const [q, setQ] = useState('');
  const { data, error, loading, run } = useRequest<IpResult>();
  const [mine, setMine] = useState<IpResult | null>(null);

  useEffect(() => {
    toolsApi.get<IpResult>('/net/ip').then(r => setMine(r)).catch(() => {});
  }, []);

  const lookup = () => run(() => toolsApi.get<IpResult>(`/net/ip?q=${encodeURIComponent(q.trim())}`));
  const shown = data ?? mine;
  const g = shown?.lookup;
  const localTime = g?.timezone ? (() => { try { return new Date().toLocaleTimeString(undefined, { timeZone: g.timezone, hour: '2-digit', minute: '2-digit' }); } catch { return ''; } })() : '';

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Stat label="Your IP (as seen by the server)" value={mine ? <span className="font-mono">{mine.client.ip || '—'}</span> : <Loader2 className="size-4 animate-spin" />}
          hint={mine ? `via ${mine.client.source}${mine.client.private ? ' · private address (you are on the same network or behind a proxy)' : ''}` : ' '} />
        <Stat label="Server public IP" value={mine ? <span className="font-mono">{mine.server.ip || 'unknown'}</span> : <Loader2 className="size-4 animate-spin" />} hint="Outbound address of this dashboard's host" />
      </div>
      <QueryBar label="Look up an IP address or hostname" value={q} onChange={setQ} onRun={lookup} loading={loading}
        placeholder="8.8.8.8, 2606:4700::1111 or example.com" examples={['1.1.1.1', '8.8.8.8', 'github.com', '2606:4700:4700::1111']} />
      {error && <ErrorBox message={error} />}
      {g && (
        <Card size="sm">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xl leading-none">{countryFlag(g.countryCode)}</span>
              <CardTitle className="text-base font-mono">{g.ip}</CardTitle>
              {shown?.host && <Badge variant="secondary">{shown.host}</Badge>}
              {g.type && <Badge variant="outline">{g.type}</Badge>}
              {g.flags?.hosting && <Badge variant="outline">hosting / datacenter</Badge>}
              {g.flags?.proxy && <Badge variant="destructive">proxy / VPN</Badge>}
              {g.flags?.mobile && <Badge variant="outline">mobile</Badge>}
              {!data && <Badge variant="secondary">{mine?.client.ip === g.ip ? 'you' : 'server'}</Badge>}
            </div>
            <CardDescription className="text-xs">{[g.city, g.region, g.country].filter(Boolean).join(', ') || 'Unknown location'}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            <KV rows={[
              ['Country', g.country ? `${g.country} (${g.countryCode})` : undefined],
              ['Region / city', [g.region, g.city].filter(Boolean).join(' / ')],
              ['Postal code', g.postal],
              ['Coordinates', g.latitude !== undefined ? (
                <a className="text-primary hover:underline inline-flex items-center gap-1" target="_blank" rel="noreferrer"
                  href={`https://www.openstreetmap.org/?mlat=${g.latitude}&mlon=${g.longitude}#map=10/${g.latitude}/${g.longitude}`}>
                  {g.latitude?.toFixed(4)}, {g.longitude?.toFixed(4)} <ExternalLink className="size-3" />
                </a>
              ) : undefined, g.latitude !== undefined ? `${g.latitude},${g.longitude}` : undefined],
              ['Time zone', g.timezone ? `${g.timezone}${localTime ? ` · local time ${localTime}` : ''}` : undefined],
            ]} />
            <KV rows={[
              ['ASN', g.asn, g.asn],
              ['Organisation', g.org],
              ['ISP', g.isp],
              ['Domain', g.domain],
              ['Reverse DNS', g.ptr?.length ? g.ptr.join(', ') : 'none', g.ptr?.[0]],
              ['Resolved addresses', shown?.addresses && shown.addresses.length > 1 ? shown.addresses.join(', ') : undefined],
              ['Data source', g.source],
            ]} />
          </CardContent>
        </Card>
      )}
      <p className="text-[11px] text-muted-foreground">Geolocation is approximate (city-level at best). Private and internal addresses are refused.</p>
    </div>
  );
}

// ── DNS lookup ───────────────────────────────────────────────────────────────

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'SRV'] as const;
const RESOLVERS = [
  { value: 'cloudflare', label: 'Cloudflare 1.1.1.1' }, { value: 'google', label: 'Google 8.8.8.8' },
  { value: 'quad9', label: 'Quad9 9.9.9.9' }, { value: 'system', label: 'Server resolver' },
] as const;
type ResolverId = typeof RESOLVERS[number]['value'];

interface DnsRecord { value: string; ttl?: number; priority?: number; [k: string]: unknown }
interface DnsResult {
  name: string; resolver: { label: string; servers: string[]; doh?: string }; nxdomain: boolean; dnssec?: boolean; totalMs: number;
  results: { type: string; records: DnsRecord[]; ms: number; via: string; code?: string; error?: string; dnssec?: boolean }[];
}

function txtTag(v: string): string | null {
  if (/^v=spf1/i.test(v)) return 'SPF';
  if (/^v=DMARC1/i.test(v)) return 'DMARC';
  if (/^v=DKIM1/i.test(v)) return 'DKIM';
  if (/^v=BIMI1/i.test(v)) return 'BIMI';
  if (/^v=STSv1/i.test(v)) return 'MTA-STS';
  if (/verification|verify|site-verification|-domain-verification=|_?challenge/i.test(v)) return 'verification';
  return null;
}

export function DnsLookup() {
  const [name, setName] = useState('github.com');
  const [types, setTypes] = useState<string[]>([...DNS_TYPES]);
  const [resolver, setResolver] = useState<ResolverId>('cloudflare');
  const { data, error, loading, run } = useRequest<DnsResult>();
  const [compare, setCompare] = useState<{ resolver: string; values: string[]; error?: string; ms: number }[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);

  const lookup = (n = name, t = types) => run(() => toolsApi.post<DnsResult>('/net/dns', { name: n.trim(), types: t, resolver }));
  const toggle = (t: string) => setTypes(l => (l.includes(t) ? l.filter(x => x !== t) : [...l, t]));

  const propagation = async () => {
    setComparing(true);
    const n = name.trim();
    const res = await Promise.all(RESOLVERS.map(async r => {
      try {
        const d = await toolsApi.post<DnsResult>('/net/dns', { name: n, types: ['A', 'AAAA'], resolver: r.value });
        return { resolver: r.label, values: d.results.flatMap(x => x.records.map(rec => rec.value)).sort(), ms: d.totalMs, error: d.results.every(x => x.error) ? d.results[0].error : undefined };
      } catch (e) {
        return { resolver: r.label, values: [], ms: 0, error: (e as Error).message };
      }
    }));
    setCompare(res);
    setComparing(false);
  };

  const apex = name.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const withData = data?.results.filter(r => r.records.length) ?? [];
  const empty = data?.results.filter(r => !r.records.length) ?? [];

  return (
    <div className="space-y-4">
      <QueryBar label="Domain or IP (IPs get a PTR lookup)" value={name} onChange={setName} onRun={() => lookup()} loading={loading}
        placeholder="example.com" examples={['github.com', 'gmail.com', '_dmarc.google.com', '1.1.1.1']}>
        <div className="space-y-1.5">
          <FieldLabel>Resolver</FieldLabel>
          <SelectBox value={resolver} onChange={setResolver} options={[...RESOLVERS]} />
        </div>
      </QueryBar>
      <div className="flex flex-wrap items-center gap-1.5">
        {DNS_TYPES.map(t => (
          <button key={t} type="button" onClick={() => toggle(t)}
            className={cn('h-7 px-2.5 rounded-md border text-xs font-mono cursor-pointer transition-colors',
              types.includes(t) ? 'border-primary text-foreground bg-secondary' : 'border-border text-muted-foreground hover:text-foreground')}>{t}</button>
        ))}
        <Button variant="ghost" size="xs" onClick={() => setTypes([...DNS_TYPES])}>All</Button>
        <Button variant="ghost" size="xs" onClick={() => setTypes(['A', 'AAAA'])}>Addresses</Button>
        <Button variant="ghost" size="xs" onClick={() => setTypes(['MX', 'TXT'])}>Mail</Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button variant="outline" size="xs" disabled={!apex} onClick={() => { const n = `_dmarc.${apex}`; setName(n); lookup(n, ['TXT']); }}>Check DMARC</Button>
        <Button variant="outline" size="xs" disabled={!name.trim() || comparing} onClick={propagation}>
          {comparing ? <Loader2 className="animate-spin" /> : <Globe />} Compare resolvers
        </Button>
      </div>
      {error && <ErrorBox message={error} />}
      {compare && (
        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">A / AAAA across resolvers</CardTitle>
              <Button variant="ghost" size="icon-xs" onClick={() => setCompare(null)}><X /></Button>
            </div>
            <CardDescription className="text-xs">
              {new Set(compare.filter(c => !c.error).map(c => c.values.join(','))).size <= 1 ? 'All resolvers agree.' : 'Resolvers disagree — a change may still be propagating (or the name uses geo-DNS).'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-border divide-y divide-border">
              {compare.map(c => (
                <div key={c.resolver} className="flex flex-wrap gap-2 px-3 py-1.5 text-xs">
                  <span className="w-36 shrink-0 text-muted-foreground">{c.resolver}</span>
                  <span className={cn('flex-1 min-w-0 break-all font-mono', c.error && 'text-destructive')}>{c.error || c.values.join(', ') || '—'}</span>
                  <span className="text-muted-foreground tabular-nums">{c.ms} ms</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      {data && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono text-foreground">{data.name}</span>
            <span>· {data.resolver.label}{data.resolver.doh ? ' (DNS-over-HTTPS)' : ''}</span>
            <span>· {data.totalMs} ms</span>
            {data.dnssec === true && <Badge><ShieldCheck /> DNSSEC validated</Badge>}
            {data.dnssec === false && <Badge variant="outline">not DNSSEC-signed</Badge>}
          </div>
          {data.nxdomain && <ErrorBox message={`${data.name} does not exist (NXDOMAIN).`} />}
          <div className="grid gap-3 lg:grid-cols-2">
            {withData.map(r => (
              <Card key={r.type} size="sm" className={cn(r.type === 'TXT' || r.type === 'SOA' ? 'lg:col-span-2' : '')}>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="font-mono">{r.type}</Badge>
                    <span className="text-xs text-muted-foreground">{r.records.length} record{r.records.length === 1 ? '' : 's'} · {r.ms} ms · {r.via}</span>
                    <span className="ml-auto"><CopyButton value={r.records.map(x => x.value).join('\n')} /></span>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="divide-y divide-border rounded-md border border-border">
                    {r.records.map((rec, i) => (
                      <div key={i} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-1.5 text-xs">
                        {rec.priority !== undefined && r.type === 'MX' && <span className="w-8 tabular-nums text-muted-foreground">{rec.priority}</span>}
                        {r.type === 'SOA' ? (
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 flex-1 min-w-0">
                            {(['nsname', 'hostmaster', 'serial', 'refresh', 'retry', 'expire', 'minttl'] as const).map(k => (
                              <div key={k} className="min-w-0"><span className="text-muted-foreground">{k} </span><span className="font-mono break-all">{String(rec[k])}</span></div>
                            ))}
                          </div>
                        ) : (
                          <span className="flex-1 min-w-0 font-mono break-all">
                            {r.type === 'TXT' && txtTag(rec.value) && <Badge variant="outline" className="mr-1.5">{txtTag(rec.value)}</Badge>}
                            {rec.value}
                          </span>
                        )}
                        {rec.ttl !== undefined && <span className="text-muted-foreground tabular-nums" title={`${rec.ttl} seconds`}>TTL {formatTtl(rec.ttl)}</span>}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {empty.length > 0 && !data.nxdomain && (
            <div className="space-y-1.5">
              <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer" onClick={() => setShowEmpty(s => !s)}>
                {showEmpty ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {empty.length} type{empty.length === 1 ? '' : 's'} without records: {empty.map(e => e.type).join(', ')}
              </button>
              {showEmpty && (
                <div className="rounded-md border border-border divide-y divide-border">
                  {empty.map(e => (
                    <div key={e.type} className="flex gap-3 px-3 py-1.5 text-xs">
                      <span className="w-14 font-mono">{e.type}</span>
                      <span className={cn('flex-1', e.code === 'ENODATA' ? 'text-muted-foreground' : 'text-destructive')}>{e.error}</span>
                      <span className="text-muted-foreground tabular-nums">{e.ms} ms</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── SSL / TLS inspector ─────────────────────────────────────────────────────

interface CertInfo {
  subject: Record<string, string>; issuer: Record<string, string>; sans: string[]; validFrom: string; validTo: string; daysRemaining: number;
  serialNumber: string; fingerprint256: string; fingerprint1: string; keyType?: string; keyBits?: number; curve?: string;
  signatureAlgorithm?: string; isCA: boolean; selfSigned: boolean; pem: string; infoAccess?: string[];
}
interface SslResult {
  host: string; port: number; servername?: string; ip: string; handshakeMs: number; authorized: boolean; authorizationError?: string;
  hostnameMatch: boolean; hostnameError?: string; protocol: string; cipher: { name?: string; standardName?: string };
  ephemeralKey?: { type: string; name?: string; size: number }; alpn: string | null; leaf: CertInfo; chain: CertInfo[];
  protocols?: { version: string; supported: boolean | null; note?: string }[];
}

function certRole(c: CertInfo, i: number, n: number) {
  if (i === 0) return 'Leaf';
  if (c.selfSigned) return 'Root';
  return i === n - 1 ? 'Intermediate (top of served chain)' : 'Intermediate';
}

export function SslInspector() {
  const [host, setHost] = useState('github.com');
  const [port, setPort] = useState(443);
  const [sni, setSni] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const { data, error, loading, run } = useRequest<SslResult>();
  const [showSans, setShowSans] = useState(false);

  const inspect = () => run(() => toolsApi.post<SslResult>('/net/ssl', { host: host.trim(), port, servername: sni.trim() || undefined }));

  const status = data ? (
    data.leaf.daysRemaining < 0 ? { tone: 'bad', text: 'Certificate expired' }
      : !data.hostnameMatch ? { tone: 'bad', text: 'Hostname mismatch' }
        : !data.authorized ? { tone: 'bad', text: `Not trusted: ${data.authorizationError}` }
          : data.leaf.daysRemaining < 14 ? { tone: 'warn', text: 'Valid — expires soon' }
            : { tone: 'ok', text: 'Valid and trusted' }
  ) : null;

  return (
    <div className="space-y-4">
      <QueryBar label="Host" value={host} onChange={setHost} onRun={inspect} loading={loading} button="Inspect" icon={<Lock />}
        placeholder="example.com" examples={['github.com', 'expired.badssl.com', 'wrong.host.badssl.com', 'smtp.gmail.com:465']}>
        <NumberField label="Port" value={port} onChange={setPort} min={1} max={65535} className="w-24" />
      </QueryBar>
      <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer" onClick={() => setAdvanced(a => !a)}>
        {advanced ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Advanced
      </button>
      {advanced && (
        <div className="max-w-sm space-y-1.5">
          <FieldLabel>SNI server name override</FieldLabel>
          <Input className="font-mono" value={sni} onChange={e => setSni(e.target.value)} placeholder="defaults to the host" />
        </div>
      )}
      {error && <ErrorBox message={error} />}
      {data && status && (
        <div className="space-y-4">
          <div className={cn('rounded-lg border p-4 grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] items-center', status.tone === 'ok' ? TINT.ok : status.tone === 'warn' ? TINT.warn : TINT.bad)}>
            <div className="text-center px-2">
              <p className={cn('text-4xl font-bold tabular-nums', data.leaf.daysRemaining < 0 ? 'text-destructive' : data.leaf.daysRemaining < 14 ? WARN_TEXT : 'text-primary')}>{data.leaf.daysRemaining}</p>
              <p className="text-[11px] text-muted-foreground">days {data.leaf.daysRemaining < 0 ? 'since expiry' : 'remaining'}</p>
            </div>
            <div className="space-y-1 min-w-0">
              <p className="font-semibold flex items-center gap-2">
                {status.tone === 'ok' ? <CircleCheck className="size-5 text-primary" /> : status.tone === 'warn' ? <AlertTriangle className="size-5 text-amber-500" /> : <CircleX className="size-5 text-destructive" />}
                {status.text}
              </p>
              <p className="text-xs break-all"><span className="text-muted-foreground">Issued to</span> {data.leaf.subject.CN || data.leaf.sans[0]} <span className="text-muted-foreground">by</span> {data.leaf.issuer.O || data.leaf.issuer.CN}</p>
              <p className="text-xs text-muted-foreground">{fmtDay(data.leaf.validFrom)} → {fmtDay(data.leaf.validTo)}</p>
              {data.hostnameError && <p className="text-xs text-destructive break-all">{data.hostnameError}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Protocol" value={data.protocol} hint={data.alpn ? `ALPN ${data.alpn}` : 'no ALPN'} />
            <Stat label="Cipher" value={<span className="text-xs font-mono">{data.cipher.standardName || data.cipher.name}</span>} />
            <Stat label="Key" value={`${data.leaf.keyType?.toUpperCase()} ${data.leaf.keyBits ?? ''}`} hint={data.leaf.curve} />
            <Stat label="Handshake" value={formatMs(data.handshakeMs)} hint={`${data.ip}:${data.port}`} />
          </div>
          {data.protocols && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground mr-1">Protocol support</span>
              {data.protocols.map(p => {
                const legacy = p.version === 'TLSv1' || p.version === 'TLSv1.1';
                const variant = p.supported === null ? 'outline' : p.supported ? (legacy ? 'destructive' : 'default') : 'outline';
                return (
                  <Badge key={p.version} variant={variant} title={p.note || (legacy && p.supported ? 'Deprecated protocol still enabled' : '')} className={cn(!p.supported && 'text-muted-foreground')}>
                    {p.supported ? <Check /> : p.supported === null ? '?' : <X />} {p.version.replace('TLSv', 'TLS ')}
                  </Badge>
                );
              })}
            </div>
          )}
          <KV rows={[
            ['Subject', Object.entries(data.leaf.subject).map(([k, v]) => `${k}=${v}`).join(', ')],
            ['Issuer', Object.entries(data.leaf.issuer).map(([k, v]) => `${k}=${v}`).join(', ')],
            ['Signature', data.leaf.signatureAlgorithm],
            ['Serial', <span className="font-mono">{data.leaf.serialNumber}</span>, data.leaf.serialNumber],
            ['SHA-256', <span className="font-mono">{data.leaf.fingerprint256}</span>, data.leaf.fingerprint256],
            ['Key exchange', data.ephemeralKey ? `${data.ephemeralKey.name || data.ephemeralKey.type} (${data.ephemeralKey.size} bits)` : undefined],
            ['OCSP / CA issuers', data.leaf.infoAccess?.join(' · ')],
          ]} />
          <div className="space-y-1.5">
            <FieldLabel action={data.leaf.sans.length > 12 ? <Button variant="ghost" size="xs" onClick={() => setShowSans(s => !s)}>{showSans ? 'Show fewer' : `Show all ${data.leaf.sans.length}`}</Button> : null}>
              Subject Alternative Names ({data.leaf.sans.length})
            </FieldLabel>
            <div className="flex flex-wrap gap-1">
              {(showSans ? data.leaf.sans : data.leaf.sans.slice(0, 12)).map(s => <Badge key={s} variant="outline" className="font-mono">{s.replace(/^DNS:/, '')}</Badge>)}
            </div>
          </div>
          <div className="space-y-2">
            <FieldLabel action={<Button variant="ghost" size="xs" onClick={() => downloadBlob(data.chain.map(c => c.pem).join(''), `${data.host}-chain.pem`)}><Download /> chain.pem</Button>}>
              Certificate chain ({data.chain.length})
            </FieldLabel>
            <div className="space-y-2">
              {data.chain.map((c, i) => (
                <div key={c.fingerprint256} className="relative rounded-md border border-border p-3 space-y-1 text-xs" style={{ marginLeft: `${Math.min(i, 3) * 12}px` }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={i === 0 ? 'default' : 'secondary'}>{certRole(c, i, data.chain.length)}</Badge>
                    <span className="font-medium break-all">{c.subject.CN || c.subject.O || '(no CN)'}</span>
                    {c.daysRemaining < 0 && <Badge variant="destructive">expired</Badge>}
                    <span className="ml-auto flex gap-1">
                      <CopyButton value={c.pem} />
                      <Button variant="ghost" size="icon-xs" title="Download PEM" onClick={() => downloadBlob(c.pem, `${(c.subject.CN || 'cert').replace(/[^\w.-]+/g, '_')}.pem`)}><Download /></Button>
                    </span>
                  </div>
                  <p className="text-muted-foreground break-all">Issuer: {c.issuer.CN || c.issuer.O} · {fmtDay(c.validFrom)} → {fmtDay(c.validTo)} · {c.keyType?.toUpperCase()} {c.keyBits}{c.signatureAlgorithm ? ` · ${c.signatureAlgorithm}` : ''}</p>
                  <p className="font-mono text-[11px] text-muted-foreground break-all">{c.fingerprint256}</p>
                </div>
              ))}
            </div>
            {!data.chain[data.chain.length - 1]?.selfSigned && data.authorized && (
              <p className="text-[11px] text-muted-foreground">The root certificate isn't sent by the server (normal) — it comes from the client's trust store.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── WHOIS / RDAP ─────────────────────────────────────────────────────────────

interface RdapData {
  kind: string; handle?: string; name?: string; status: string[]; created?: string; updated?: string; expires?: string;
  registrar?: { name?: string; ianaId?: string; url?: string }; abuse?: { email?: string; phone?: string; name?: string };
  registrant?: { org?: string; country?: string }; nameservers: string[]; dnssec?: boolean; startAddress?: string; endAddress?: string;
  cidrs: string[]; ipVersion?: string; country?: string; networkType?: string; parentHandle?: string; orgs?: string[]; remarks: string[];
}
interface WhoisResult {
  query: string; type: 'domain' | 'ip'; rdap: { url: string; registrarUrl?: string; domain?: string; data: RdapData } | null; rdapError?: string;
  raw: { server: string; text: string; error?: string }[]; rawError?: string; available: boolean;
}

const EPP_HINTS: Record<string, string> = {
  'client transfer prohibited': 'Registrar lock: transfers blocked (good)',
  'server transfer prohibited': 'Registry lock on transfers',
  'client delete prohibited': 'Cannot be deleted by registrar',
  'client update prohibited': 'Changes locked by registrar',
  'server update prohibited': 'Changes locked by registry',
  'server delete prohibited': 'Deletion locked by registry',
  'redemption period': 'Expired — can still be restored',
  'pending delete': 'About to be released',
  active: 'Active', ok: 'No restrictions',
};

export function WhoisLookup() {
  const [q, setQ] = useState('github.com');
  const { data, error, loading, run } = useRequest<WhoisResult>();
  const [rawIdx, setRawIdx] = useState(0);
  const lookup = () => { setRawIdx(0); run(() => toolsApi.post<WhoisResult>('/net/whois', { query: q.trim() })); };
  const d = data?.rdap?.data;
  const expDays = daysFromNow(d?.expires);
  const raw = data?.raw ?? [];

  return (
    <div className="space-y-4">
      <QueryBar label="Domain or IP address" value={q} onChange={setQ} onRun={lookup} loading={loading}
        placeholder="example.com or 8.8.8.8" examples={['github.com', 'bbc.co.uk', '8.8.8.8', 'some-unregistered-name-4821.com']} />
      {error && <ErrorBox message={error} />}
      {data?.available && (
        <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-sm', TINT.ok)}><CircleCheck className="size-4 text-primary" /> <b>{data.query}</b> appears to be available for registration.</div>
      )}
      {data && !d && !data.available && data.rdapError && <InfoBox>RDAP: {data.rdapError}. Raw WHOIS below may still have details.</InfoBox>}
      {d && (
        <Card size="sm">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base font-mono break-all">{d.name || data?.rdap?.domain || data?.query}</CardTitle>
              {d.handle && <Badge variant="outline">{d.handle}</Badge>}
              {d.dnssec !== undefined && (d.dnssec ? <Badge><ShieldCheck /> DNSSEC</Badge> : <Badge variant="outline">no DNSSEC</Badge>)}
            </div>
            {data?.type === 'domain' && d.created && (
              <CardDescription className="text-xs">Registered {ageText(d.created)}{d.expires ? ` · expires ${ageText(d.expires)}` : ''}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {data?.type === 'domain' ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Stat label="Created" value={fmtDay(d.created)} hint={ageText(d.created)} />
                  <Stat label="Updated" value={fmtDay(d.updated)} hint={ageText(d.updated)} />
                  <Stat label="Expires" value={<span className={cn(expDays !== null && expDays < 30 && (expDays < 0 ? 'text-destructive' : WARN_TEXT))}>{fmtDay(d.expires)}</span>} hint={expDays !== null ? (expDays < 0 ? `${-expDays} days ago` : `${expDays} days left`) : undefined} />
                </div>
                <KV rows={[
                  ['Registrar', d.registrar?.name ? <>{d.registrar.name}{d.registrar.ianaId ? <span className="text-muted-foreground"> (IANA {d.registrar.ianaId})</span> : null}</> : undefined],
                  ['Registrant', d.registrant?.org ? `${d.registrant.org}${d.registrant.country ? `, ${d.registrant.country}` : ''}` : 'Redacted for privacy'],
                  ['Abuse contact', [d.abuse?.email, d.abuse?.phone].filter(Boolean).join(' · ') || undefined, d.abuse?.email],
                  ['Name servers', d.nameservers.length ? <span className="font-mono">{d.nameservers.join(', ')}</span> : undefined, d.nameservers.join('\n')],
                ]} />
              </>
            ) : (
              <KV rows={[
                ['Network name', d.name],
                ['Range', d.startAddress ? <span className="font-mono">{d.startAddress} – {d.endAddress}</span> : undefined],
                ['CIDR', d.cidrs.length ? <span className="font-mono">{d.cidrs.join(', ')}</span> : undefined, d.cidrs.join(', ')],
                ['Organisation', d.orgs?.join(', ')],
                ['Type', d.networkType],
                ['Country', d.country ? `${countryFlag(d.country)} ${d.country}` : undefined],
                ['Parent', d.parentHandle],
                ['Registered', d.created ? fmtDay(d.created) : undefined],
                ['Updated', d.updated ? fmtDay(d.updated) : undefined],
                ['Abuse contact', [d.abuse?.email, d.abuse?.phone].filter(Boolean).join(' · ') || undefined, d.abuse?.email],
              ]} />
            )}
            {d.status.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {d.status.map(s => <Badge key={s} variant="outline" title={EPP_HINTS[s.toLowerCase()] || ''}>{s}</Badge>)}
              </div>
            )}
            {data?.rdap && (
              <p className="text-[11px] text-muted-foreground break-all">
                Source: <a className="text-primary hover:underline" href={data.rdap.url} target="_blank" rel="noreferrer">{data.rdap.url}</a>
                {data.rdap.registrarUrl && <> + <a className="text-primary hover:underline" href={data.rdap.registrarUrl} target="_blank" rel="noreferrer">registrar RDAP</a></>}
              </p>
            )}
          </CardContent>
        </Card>
      )}
      {raw.length > 0 && (
        <div className="space-y-1.5">
          <FieldLabel action={<CopyButton value={raw[rawIdx]?.text ?? ''} label="Copy" />}>Raw WHOIS (port 43)</FieldLabel>
          <div className="flex flex-wrap items-center gap-1">
            {raw.map((h, i) => (
              <React.Fragment key={h.server}>
                {i > 0 && <ChevronRight className="size-3 text-muted-foreground" />}
                <Button variant={i === rawIdx ? 'secondary' : 'ghost'} size="xs" className="font-mono" onClick={() => setRawIdx(i)}>
                  {h.server}{h.error ? ' ⚠' : ''}
                </Button>
              </React.Fragment>
            ))}
          </div>
          {raw[rawIdx]?.error
            ? <ErrorBox message={raw[rawIdx].error!} />
            : <pre className={cn(MONO, 'max-h-96 overflow-auto rounded-md border border-border bg-secondary p-3 whitespace-pre-wrap break-all')}>{raw[rawIdx]?.text || '(empty response)'}</pre>}
        </div>
      )}
    </div>
  );
}

// ── Port scanner ─────────────────────────────────────────────────────────────

interface PortRow { port: number; status: 'open' | 'closed' | 'filtered'; ms?: number; banner?: string; service?: string; error?: string }

export function PortScanner() {
  const [host, setHost] = useState('scanme.nmap.org');
  const [spec, setSpec] = useState('common');
  const [timeoutMs, setTimeoutMs] = useState(1500);
  const [banner, setBanner] = useState(true);
  const [rows, setRows] = useState<PortRow[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [ip, setIp] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [showClosed, setShowClosed] = useState(false);
  const cancel = useRef(false);

  const parsed = useMemo(() => parsePortSpec(spec), [spec]);
  const ports = Array.isArray(parsed) ? parsed : null;

  const scan = async () => {
    if (!ports) return;
    setRunning(true);
    setError('');
    setRows([]);
    setIp('');
    cancel.current = false;
    const t0 = Date.now();
    setProgress({ done: 0, total: ports.length });
    try {
      for (const batch of chunk(ports, 64)) {
        if (cancel.current) break;
        const r = await toolsApi.post<{ ip: string; results: PortRow[] }>('/net/ports', { host: host.trim(), ports: batch.join(','), timeoutMs, banner });
        setIp(r.ip);
        setRows(prev => [...prev, ...r.results]);
        setProgress(p => p && { ...p, done: p.done + batch.length });
        setElapsed(Date.now() - t0);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      setElapsed(Date.now() - t0);
    }
  };

  const open = rows.filter(r => r.status === 'open');
  const closed = rows.filter(r => r.status === 'closed');
  const filtered = rows.filter(r => r.status === 'filtered');
  const others = [...closed, ...filtered].sort((a, b) => a.port - b.port);
  const estimate = ports ? Math.ceil(ports.length / 64) * timeoutMs : 0;

  const PortTable = ({ list }: { list: PortRow[] }) => (
    <div className="rounded-md border border-border overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border text-left">
            <th className="px-3 py-1.5 font-medium w-16">Port</th><th className="px-3 py-1.5 font-medium">Service</th>
            <th className="px-3 py-1.5 font-medium">State</th><th className="px-3 py-1.5 font-medium">Latency</th>
            <th className="px-3 py-1.5 font-medium">Banner</th>
          </tr>
        </thead>
        <tbody>
          {list.map(r => (
            <tr key={r.port} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5 font-mono tabular-nums">{r.port}</td>
              <td className="px-3 py-1.5">{r.service || <span className="text-muted-foreground">—</span>}</td>
              <td className="px-3 py-1.5">
                <Badge variant={r.status === 'open' ? 'default' : 'outline'} className={cn(r.status !== 'open' && 'text-muted-foreground')}>{r.status}</Badge>
              </td>
              <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{r.ms !== undefined ? formatMs(r.ms) : r.error || '—'}</td>
              <td className="px-3 py-1.5 font-mono text-[11px] break-all min-w-40">{r.banner || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <QueryBar label="Host" value={host} onChange={setHost} onRun={scan} loading={running} button="Scan" icon={<Radar />}
        placeholder="example.com or 203.0.113.10" disabled={!ports}>
        {running && <Button variant="outline" onClick={() => { cancel.current = true; }}><Square /> Stop</Button>}
      </QueryBar>
      <div className="space-y-1.5">
        <FieldLabel>Ports</FieldLabel>
        <div className="flex flex-wrap gap-1">
          {Object.entries(PORT_PRESETS).map(([k, p]) => (
            <Button key={k} variant={spec === k ? 'secondary' : 'outline'} size="xs" onClick={() => setSpec(k)}>{p.label}</Button>
          ))}
        </div>
        <Input className="font-mono" value={spec} onChange={e => setSpec(e.target.value)} placeholder="22,80,443,8000-8100" />
        <p className={cn('text-[11px]', ports ? 'text-muted-foreground' : 'text-destructive')}>
          {ports ? `${ports.length} port${ports.length === 1 ? '' : 's'} · worst case ≈ ${Math.round(estimate / 1000)} s` : (parsed as { error: string }).error}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="space-y-1 w-56">
          <FieldLabel action={<span className="text-xs tabular-nums">{timeoutMs} ms</span>}>Timeout per port</FieldLabel>
          <input type="range" className="w-full accent-primary" min={200} max={5000} step={100} value={timeoutMs} onChange={e => setTimeoutMs(Number(e.target.value))} />
        </div>
        <Checkbox checked={banner} onChange={setBanner}>Grab banners from open ports</Checkbox>
      </div>
      {progress && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-2">{running && <Loader2 className="size-3.5 animate-spin" />} {progress.done} / {progress.total} scanned{ip ? ` · ${ip}` : ''}</span>
            <span className="tabular-nums">{(elapsed / 1000).toFixed(1)} s</span>
          </div>
          <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
          </div>
        </div>
      )}
      {error && <ErrorBox message={error} />}
      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Open" value={<span className="text-primary">{open.length}</span>} />
            <Stat label="Closed" value={closed.length} hint="host replied with RST" />
            <Stat label="Filtered" value={filtered.length} hint="no reply (firewall)" />
          </div>
          {open.length ? <PortTable list={open} /> : <InfoBox>No open ports found in this range.</InfoBox>}
          {others.length > 0 && (
            <div className="space-y-1.5">
              <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer" onClick={() => setShowClosed(s => !s)}>
                {showClosed ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} {others.length} closed / filtered ports
              </button>
              {showClosed && <PortTable list={others} />}
            </div>
          )}
          <div className="flex gap-1">
            <CopyButton value={open.map(r => `${r.port}/tcp open ${r.service ?? ''}`.trim()).join('\n')} label="Copy open ports" />
            <Button variant="ghost" size="xs" onClick={() => downloadBlob('port,status,service,latency_ms,banner\n' + rows.map(r => [r.port, r.status, r.service ?? '', r.ms ?? '', JSON.stringify(r.banner ?? '')].join(',')).join('\n') + '\n', `scan-${host}.csv`)}><Download /> CSV</Button>
          </div>
        </>
      )}
      <p className="text-[11px] text-muted-foreground">TCP connect scan from the dashboard server (max 1024 ports, 64 in parallel). Only scan hosts you own or are authorised to test — scanme.nmap.org is provided by the Nmap project for this purpose.</p>
    </div>
  );
}

// ── Ping / traceroute ───────────────────────────────────────────────────────

interface PingResult {
  mode: 'tcp' | 'icmp'; host: string; ip: string; port?: number; ttl?: number; raw?: string;
  samples: { seq: number; ms: number | null; error?: string }[];
  stats: { sent: number; received: number; loss: number; min: number | null; avg: number | null; max: number | null; stddev: number | null; jitter: number | null };
}
interface TraceResult {
  host: string; ip: string; tool: string; maxHops: number; reached: boolean; timedOut: boolean; ms: number; raw: string;
  hops: { hop: number; ip: string | null; rtts: (number | null)[]; private?: boolean }[];
}

function Sparkline({ values }: { values: (number | null)[] }) {
  const w = 320, h = 56;
  const pts = sparklinePoints(values, w, h, 4);
  const ok = values.filter((v): v is number => v !== null);
  const min = Math.min(...ok), max = Math.max(...ok);
  return (
    <div className="rounded-md border border-border p-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-14" preserveAspectRatio="none" role="img" aria-label="Latency per probe">
        {pts && <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
        {values.map((v, i) => v === null && (
          <line key={i} x1={4 + (i * (w - 8)) / Math.max(values.length - 1, 1)} x2={4 + (i * (w - 8)) / Math.max(values.length - 1, 1)} y1={4} y2={h - 4} stroke="var(--destructive)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {ok.length > 0 && <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums"><span>min {formatMs(min)}</span><span>max {formatMs(max)}</span></div>}
    </div>
  );
}

export function PingTraceroute() {
  const [host, setHost] = useState('cloudflare.com');
  const [tab, setTab] = useState('ping');
  const [mode, setMode] = useState<'tcp' | 'icmp'>('tcp');
  const [port, setPort] = useState(443);
  const [count, setCount] = useState(8);
  const [maxHops, setMaxHops] = useState(20);
  const ping = useRequest<PingResult>();
  const trace = useRequest<TraceResult>();
  const [tick, setTick] = useState(0);
  const started = useRef(0);

  useEffect(() => {
    if (!trace.loading && !ping.loading) return;
    const t = setInterval(() => setTick(Date.now() - started.current), 250);
    return () => clearInterval(t);
  }, [trace.loading, ping.loading]);

  const runPing = () => { started.current = Date.now(); ping.run(() => toolsApi.post<PingResult>('/net/ping', { host: host.trim(), mode, port, count })); };
  const runTrace = () => { started.current = Date.now(); trace.run(() => toolsApi.post<TraceResult>('/net/traceroute', { host: host.trim(), maxHops })); };
  const p = ping.data;
  const tr = trace.data;
  const maxAvg = tr ? Math.max(1, ...tr.hops.map(h => avg(h.rtts) ?? 0)) : 1;

  return (
    <Tabs className="flex-col" value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger className={TAB_ACTIVE} value="ping">Ping</TabsTrigger>
        <TabsTrigger className={TAB_ACTIVE} value="trace">Traceroute</TabsTrigger>
      </TabsList>
      <TabsContent value="ping" className="pt-2 space-y-4">
        <QueryBar label="Host" value={host} onChange={setHost} onRun={runPing} loading={ping.loading} button="Ping" icon={<Play />} examples={['cloudflare.com', '1.1.1.1', 'google.com']}>
          <div className="space-y-1.5">
            <FieldLabel>Method</FieldLabel>
            <Segmented value={mode} onChange={setMode} options={[{ value: 'tcp', label: 'TCP connect' }, { value: 'icmp', label: 'ICMP' }]} />
          </div>
          {mode === 'tcp' && <NumberField label="Port" value={port} onChange={setPort} min={1} max={65535} className="w-24" />}
          <NumberField label="Count" value={count} onChange={setCount} min={1} max={20} className="w-20" />
        </QueryBar>
        <p className="text-[11px] text-muted-foreground">
          {mode === 'tcp' ? 'Measures TCP handshake time to the port — works everywhere, even where ICMP is blocked or not permitted.' : 'Uses the server\'s ping binary. Containers often lack ICMP permission; switch to TCP if it fails.'}
        </p>
        {ping.loading && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Pinging… {(tick / 1000).toFixed(1)} s</p>}
        {ping.error && <ErrorBox message={ping.error} />}
        {p && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground"><span className="font-mono text-foreground">{p.host}</span> ({p.ip}){p.mode === 'tcp' ? ` port ${p.port}` : ''}{p.ttl ? ` · TTL ${p.ttl}` : ''}</p>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              <Stat label="Min" value={formatMs(p.stats.min)} />
              <Stat label="Avg" value={formatMs(p.stats.avg)} />
              <Stat label="Max" value={formatMs(p.stats.max)} />
              <Stat label="Std dev" value={formatMs(p.stats.stddev)} />
              <Stat label="Jitter" value={formatMs(p.stats.jitter)} />
              <Stat label="Loss" value={<span className={p.stats.loss > 0 ? 'text-destructive' : 'text-primary'}>{p.stats.loss}%</span>} hint={`${p.stats.received}/${p.stats.sent}`} />
            </div>
            {p.stats.received > 0 && <Sparkline values={p.samples.map(s => s.ms)} />}
            <div className="rounded-md border border-border divide-y divide-border max-h-64 overflow-auto">
              {p.samples.map(s => (
                <div key={s.seq} className="flex items-center gap-3 px-3 py-1 text-xs">
                  <span className="w-8 text-muted-foreground tabular-nums">#{s.seq}</span>
                  <span className={cn('tabular-nums w-20', s.ms === null && 'text-destructive')}>{s.ms === null ? 'lost' : formatMs(s.ms)}</span>
                  {s.ms !== null && p.stats.max ? <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden"><div className="h-full bg-primary" style={{ width: `${(s.ms / p.stats.max) * 100}%` }} /></div> : <span className="flex-1" />}
                  {s.error && <span className="text-muted-foreground">{s.error}</span>}
                </div>
              ))}
            </div>
            {p.raw && <RawOutput text={p.raw} />}
          </div>
        )}
      </TabsContent>
      <TabsContent value="trace" className="pt-2 space-y-4">
        <QueryBar label="Host" value={host} onChange={setHost} onRun={runTrace} loading={trace.loading} button="Trace" icon={<Route />} examples={['cloudflare.com', '8.8.8.8']}>
          <NumberField label="Max hops" value={maxHops} onChange={setMaxHops} min={1} max={30} className="w-24" />
        </QueryBar>
        {trace.loading && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Tracing route… {(tick / 1000).toFixed(0)} s (can take up to 90 s)</p>}
        {trace.error && <ErrorBox message={trace.error} />}
        {tr && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono text-foreground">{tr.host}</span> ({tr.ip}) · {tr.hops.length} hops · {(tr.ms / 1000).toFixed(1)} s · {tr.tool}
              {tr.reached ? <Badge><Check /> reached</Badge> : <Badge variant="outline">destination not reached</Badge>}
            </div>
            <div className="rounded-md border border-border overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border text-left">
                    <th className="px-3 py-1.5 font-medium w-10">#</th><th className="px-3 py-1.5 font-medium">Address</th>
                    <th className="px-3 py-1.5 font-medium">Probes</th><th className="px-3 py-1.5 font-medium w-1/3">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {tr.hops.map(h => {
                    const a = avg(h.rtts);
                    return (
                      <tr key={h.hop} className="border-b border-border last:border-0">
                        <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{h.hop}</td>
                        <td className="px-3 py-1.5 font-mono break-all">
                          {h.ip ?? <span className="text-muted-foreground">* no reply</span>}
                          {h.private && <Badge variant="outline" className="ml-1.5">private</Badge>}
                          {h.ip === tr.ip && <Badge className="ml-1.5">target</Badge>}
                        </td>
                        <td className="px-3 py-1.5 tabular-nums text-muted-foreground whitespace-nowrap">{h.rtts.map(r => (r === null ? '*' : formatMs(r))).join('  ')}</td>
                        <td className="px-3 py-1.5">
                          {a !== null && (
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden min-w-12"><div className="h-full bg-primary" style={{ width: `${(a / maxAvg) * 100}%` }} /></div>
                              <span className="tabular-nums w-16 text-right">{formatMs(a)}</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <RawOutput text={tr.raw} />
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

function avg(r: (number | null)[]) {
  const ok = r.filter((x): x is number => x !== null);
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
}

function RawOutput({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1.5">
      <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />} Raw output
      </button>
      {open && <pre className={cn(MONO, 'max-h-72 overflow-auto rounded-md border border-border bg-secondary p-3 whitespace-pre-wrap break-all')}>{text}</pre>}
    </div>
  );
}

// ── HTTP header inspector ───────────────────────────────────────────────────

interface Hop {
  url: string; ip?: string; status?: number; statusText?: string; httpVersion?: string; headers: [string, string][]; location?: string;
  timings: { dns: number; connect: number; tls?: number; ttfb: number; total: number }; bodyBytes?: number; decodedBytes?: number;
  truncated?: boolean; contentEncoding?: string; error?: string;
  tls?: { protocol?: string; cipher?: string; authorized: boolean; error?: string; subject?: string; issuer?: string; validTo?: string; alpn?: string };
}
interface Check { id: string; label: string; status: 'pass' | 'warn' | 'fail' | 'info'; value?: string; detail: string }
interface HttpResult {
  url: string; finalUrl: string; redirects: number; upgradedToHttps: boolean; totalMs: number; hops: Hop[]; error?: string;
  security: { grade: string; score: number; checks: Check[]; cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite: string | null; issues: string[] }[] } | null;
}

const USER_AGENTS = {
  default: { label: 'Default (inspector)', ua: '' },
  chrome: { label: 'Chrome · Windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
  iphone: { label: 'Safari · iPhone', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  googlebot: { label: 'Googlebot', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  curl: { label: 'curl', ua: 'curl/8.10.1' },
} as const;
type UaKey = keyof typeof USER_AGENTS;

function statusTone(s?: number) {
  if (!s) return 'destructive';
  if (s < 300) return 'default';
  if (s < 400) return 'secondary';
  return 'destructive';
}

const GRADE_COLOR: Record<string, string> = { 'A+': 'text-primary', A: 'text-primary', B: 'text-primary', C: WARN_TEXT, D: WARN_TEXT, E: 'text-destructive', F: 'text-destructive' };

function Waterfall({ t }: { t: Hop['timings'] }) {
  const download = Math.max(0, t.total - t.dns - t.ttfb);
  const phases = [
    { k: 'DNS', v: t.dns, c: 'bg-sky-500' },
    { k: 'Connect', v: t.connect, c: 'bg-amber-500' },
    { k: 'TLS', v: t.tls ?? 0, c: 'bg-violet-500' },
    { k: 'Waiting (TTFB)', v: Math.max(0, t.ttfb - t.connect - (t.tls ?? 0)), c: 'bg-primary' },
    { k: 'Download', v: download, c: 'bg-muted-foreground' },
  ];
  const total = Math.max(phases.reduce((a, p) => a + p.v, 0), 1);
  return (
    <div className="space-y-1.5">
      <div className="flex h-3 rounded-full overflow-hidden bg-secondary">
        {phases.map(p => p.v > 0 && <div key={p.k} className={p.c} style={{ width: `${(p.v / total) * 100}%` }} title={`${p.k}: ${formatMs(p.v)}`} />)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {phases.map(p => <span key={p.k} className="flex items-center gap-1"><span className={cn('size-2 rounded-full', p.c)} />{p.k} {formatMs(p.v)}</span>)}
      </div>
    </div>
  );
}

function HeadersTable({ headers }: { headers: [string, string][] }) {
  return (
    <div className="rounded-md border border-border divide-y divide-border">
      {headers.map(([k, v], i) => (
        <div key={i} className="flex flex-col sm:flex-row gap-x-3 px-3 py-1 text-xs">
          <span className="sm:w-56 shrink-0 font-mono text-muted-foreground break-all">{k}</span>
          <span className="flex-1 min-w-0 font-mono break-all">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function HttpHeaderInspector() {
  const [url, setUrl] = useState('http://github.com');
  const [method, setMethod] = useState<'GET' | 'HEAD'>('GET');
  const [follow, setFollow] = useState(true);
  const [ua, setUa] = useState<UaKey>('default');
  const [customUa, setCustomUa] = useState('');
  const { data, error, loading, run } = useRequest<HttpResult>();
  const [openHop, setOpenHop] = useState<number | null>(null);

  const inspect = async () => {
    const r = await run(() => toolsApi.post<HttpResult>('/net/http', { url: url.trim(), method, followRedirects: follow, userAgent: customUa || USER_AGENTS[ua].ua || undefined }));
    if (r) setOpenHop(r.hops.length - 1);
  };
  const final = data?.hops[data.hops.length - 1];

  return (
    <div className="space-y-4">
      <QueryBar label="URL" value={url} onChange={setUrl} onRun={inspect} loading={loading} button="Inspect" icon={<Server />}
        placeholder="https://example.com" examples={['http://github.com', 'https://www.google.com', 'http://example.com', 'https://securityheaders.com']}>
        <div className="space-y-1.5">
          <FieldLabel>Method</FieldLabel>
          <Segmented value={method} onChange={setMethod} options={[{ value: 'GET', label: 'GET' }, { value: 'HEAD', label: 'HEAD' }]} />
        </div>
      </QueryBar>
      <div className="flex flex-wrap items-center gap-3">
        <Checkbox checked={follow} onChange={setFollow}>Follow redirects (max 10)</Checkbox>
        <SelectBox value={ua} onChange={v => { setUa(v); setCustomUa(''); }} options={Object.entries(USER_AGENTS).map(([k, v]) => ({ value: k as UaKey, label: v.label }))} />
        <Input className="font-mono flex-1 min-w-48 h-8" value={customUa} onChange={e => setCustomUa(e.target.value)} placeholder="…or a custom User-Agent" />
      </div>
      {error && <ErrorBox message={error} />}
      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Final status" value={final?.status ?? '—'} hint={final?.statusText} />
            <Stat label="Redirects" value={data.redirects} hint={data.upgradedToHttps ? 'upgrades to HTTPS ✓' : undefined} />
            <Stat label="Total time" value={formatMs(data.totalMs)} />
            <Stat label="Body" value={final?.bodyBytes !== undefined ? formatBytes(final.bodyBytes) : '—'}
              hint={final?.contentEncoding ? `${final.contentEncoding} → ${formatBytes(final.decodedBytes ?? 0)}${final.truncated ? ' (truncated)' : ''}` : final?.truncated ? 'truncated at 5 MB' : undefined} />
          </div>
          {data.error && <div className={cn('flex gap-2 rounded-md border px-3 py-2 text-xs', TINT.warn)}><AlertTriangle className="size-4 shrink-0 text-amber-500" />{data.error}</div>}

          <div className="space-y-1">
            <FieldLabel>Redirect chain</FieldLabel>
            {data.hops.map((h, i) => (
              <div key={i}>
                {i > 0 && <div className="flex items-center gap-2 pl-4 py-0.5 text-[11px] text-muted-foreground"><ArrowDown className="size-3" /> {data.hops[i - 1].status} redirect</div>}
                <button type="button" onClick={() => setOpenHop(openHop === i ? null : i)}
                  className="w-full text-left rounded-md border border-border px-3 py-2 hover:bg-secondary cursor-pointer transition-colors">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant={statusTone(h.status) as 'default'}>{h.status ?? 'ERR'}</Badge>
                    <span className="font-mono break-all flex-1 min-w-0">{h.url}</span>
                    {h.url.startsWith('https:') ? <Lock className={cn('size-3.5', h.tls?.authorized ? 'text-primary' : 'text-destructive')} /> : <span className="text-[10px] text-amber-500">http</span>}
                    <span className="text-muted-foreground tabular-nums">{formatMs(h.timings.total)}</span>
                    {openHop === i ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </div>
                </button>
                {openHop === i && (
                  <div className="mt-2 mb-3 ml-2 space-y-3 border-l-2 border-border pl-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      {h.ip && <span>IP {h.ip}</span>}
                      {h.httpVersion && <span>HTTP/{h.httpVersion}</span>}
                      {h.tls?.protocol && <span>{h.tls.protocol} · {h.tls.cipher}</span>}
                      {h.tls?.subject && <span>cert {h.tls.subject} ({h.tls.issuer}) · expires {fmtDay(h.tls.validTo)}</span>}
                      {h.tls && !h.tls.authorized && <span className="text-destructive">TLS: {h.tls.error}</span>}
                    </div>
                    <Waterfall t={h.timings} />
                    {h.error && <ErrorBox message={h.error} />}
                    {h.headers.length > 0 && (
                      <div className="space-y-1.5">
                        <FieldLabel action={<CopyButton value={h.headers.map(([k, v]) => `${k}: ${v}`).join('\n')} label="Copy" />}>Response headers ({h.headers.length})</FieldLabel>
                        <HeadersTable headers={h.headers} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {data.security && (
            <Card size="sm">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <div className={cn('text-5xl font-bold leading-none w-16 text-center', GRADE_COLOR[data.security.grade])}>{data.security.grade}</div>
                  <div className="space-y-1">
                    <CardTitle className="text-sm">Security headers</CardTitle>
                    <CardDescription className="text-xs">Score {data.security.score}/100 for the final response · {new URL(data.finalUrl).host}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="divide-y divide-border rounded-md border border-border">
                  {data.security.checks.map(c => (
                    <div key={c.id} className="flex gap-2 px-3 py-2 text-xs">
                      {c.status === 'pass' ? <CircleCheck className="size-4 shrink-0 text-primary" /> : c.status === 'warn' ? <AlertTriangle className="size-4 shrink-0 text-amber-500" /> : c.status === 'fail' ? <CircleX className="size-4 shrink-0 text-destructive" /> : <Clock className="size-4 shrink-0 text-muted-foreground" />}
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <p className="font-medium">{c.label}</p>
                        <p className="text-muted-foreground">{c.detail}</p>
                        {c.value && <p className="font-mono text-[11px] break-all text-muted-foreground">{c.value.length > 300 ? c.value.slice(0, 300) + '…' : c.value}</p>}
                      </div>
                    </div>
                  ))}
                </div>
                {data.security.cookies.length > 0 && (
                  <div className="rounded-md border border-border overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground"><tr className="border-b border-border text-left"><th className="px-3 py-1.5 font-medium">Cookie</th><th className="px-3 py-1.5 font-medium">Secure</th><th className="px-3 py-1.5 font-medium">HttpOnly</th><th className="px-3 py-1.5 font-medium">SameSite</th></tr></thead>
                      <tbody>
                        {data.security.cookies.map((c, i) => (
                          <tr key={i} className="border-b border-border last:border-0">
                            <td className="px-3 py-1.5 font-mono break-all">{c.name}</td>
                            <td className="px-3 py-1.5">{c.secure ? <Check className="size-3.5 text-primary" /> : <X className="size-3.5 text-destructive" />}</td>
                            <td className="px-3 py-1.5">{c.httpOnly ? <Check className="size-3.5 text-primary" /> : <X className="size-3.5 text-destructive" />}</td>
                            <td className="px-3 py-1.5">{c.sameSite ?? <span className="text-destructive">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ── Subnet calculator ───────────────────────────────────────────────────────

/** Dotted binary with network bits highlighted. */
function BinaryBits({ bits, prefix }: { bits: string; prefix: number }) {
  let seen = 0;
  return (
    <span className="font-mono text-[11px] sm:text-xs break-all">
      {bits.split('').map((ch, i) => {
        if (ch === '.') return <span key={i} className="text-muted-foreground">.</span>;
        const net = seen++ < prefix;
        return <span key={i} className={net ? 'text-primary' : 'text-muted-foreground'}>{ch}</span>;
      })}
    </span>
  );
}

export function SubnetCalculator() {
  return (
    <Tabs className="flex-col" defaultValue="v4">
      <TabsList>
        <TabsTrigger className={TAB_ACTIVE} value="v4">IPv4</TabsTrigger>
        <TabsTrigger className={TAB_ACTIVE} value="v6">IPv6</TabsTrigger>
        <TabsTrigger className={TAB_ACTIVE} value="range">Range → CIDR</TabsTrigger>
      </TabsList>
      <TabsContent value="v4" className="pt-2"><SubnetV4 /></TabsContent>
      <TabsContent value="v6" className="pt-2"><SubnetV6 /></TabsContent>
      <TabsContent value="range" className="pt-2"><RangeToCidr /></TabsContent>
    </Tabs>
  );
}

function SubnetV4() {
  const [input, setInput] = useState('192.168.1.130/26');
  const [splitMode, setSplitMode] = useState<'count' | 'hosts' | 'prefix'>('count');
  const [splitN, setSplitN] = useState(4);
  const parsed = useMemo(() => parseV4Input(input), [input]);
  const ok = !('error' in parsed);
  const info = ok ? ipv4Info(parsed.ip, parsed.prefix) : null;

  const setPrefix = (p: number) => {
    const ip = input.trim().split(/[\s/]/)[0];
    setInput(`${ip}/${p}`);
  };

  const newPrefix = !info ? 0 : splitMode === 'count' ? prefixForSubnetCount(info.prefix, Math.max(1, splitN || 1))
    : splitMode === 'hosts' ? prefixForHosts(Math.max(1, splitN || 1)) : Math.round(splitN || 0);
  const split = info && ok ? splitIPv4(parsed.ip, parsed.prefix, newPrefix, 256) : null;
  const csv = split && !('error' in split) ? 'network,prefix,first_host,last_host,broadcast,usable_hosts\n' + split.subnets.map(s => [s.network, s.prefix, s.firstHost, s.lastHost, s.broadcast, s.hosts].join(',')).join('\n') + '\n' : '';

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-end">
        <div className="space-y-1.5">
          <FieldLabel>Address with prefix or netmask</FieldLabel>
          <Input className="font-mono" value={input} onChange={e => setInput(e.target.value)} placeholder="10.0.0.0/8 or 10.0.0.1 255.255.255.0" />
        </div>
        {info && (
          <div className="space-y-1.5">
            <FieldLabel action={<span className="text-xs font-mono">/{info.prefix} · {info.netmask}</span>}>Prefix length</FieldLabel>
            <input type="range" className="w-full accent-primary" min={0} max={32} value={info.prefix} onChange={e => setPrefix(Number(e.target.value))} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1 text-[11px] text-muted-foreground items-center">
        Try:
        {['10.0.0.0/8', '172.16.5.4/20', '192.168.0.1 255.255.255.0', '100.64.12.9/10', '8.8.8.8/32'].map(x => <Button key={x} variant="ghost" size="xs" className="font-mono" onClick={() => setInput(x)}>{x}</Button>)}
      </div>
      {'error' in parsed && <ErrorBox message={parsed.error} />}
      {info && ok && (
        <>
          {!parsed.prefixGiven && <InfoBox>No prefix given — using the classful default /{info.prefix}.</InfoBox>}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Network" value={<span className="font-mono text-sm">{info.network}/{info.prefix}</span>} />
            <Stat label="Usable hosts" value={info.usableHosts.toLocaleString()} hint={`${info.totalAddresses.toLocaleString()} addresses`} />
            <Stat label="Host range" value={<span className="font-mono text-xs">{info.firstHost} – {info.lastHost}</span>} />
            <Stat label="Broadcast" value={<span className="font-mono text-sm">{info.prefix >= 31 ? 'n/a' : info.broadcast}</span>} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">Class {info.cls}</Badge>
            {info.tags.map(t => <Badge key={t.label} variant={t.scope === 'public' ? 'default' : 'secondary'}>{t.label}</Badge>)}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border border-border px-3">
              <OutputRow label="Address" value={info.ip} />
              <OutputRow label="Netmask" value={info.netmask} />
              <OutputRow label="Wildcard" value={info.wildcard} />
              <OutputRow label="Network" value={`${info.network}/${info.prefix}`} />
              <OutputRow label="First host" value={info.firstHost} />
              <OutputRow label="Last host" value={info.lastHost} />
              <OutputRow label="Broadcast" value={info.broadcast} />
              <OutputRow label="Hex / integer" value={`${info.hex} / ${info.integer}`} />
              <OutputRow label="Reverse zone" value={info.arpa} />
            </div>
            <div className="rounded-md border border-border p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Binary <span className="font-normal">(<span className="text-primary">network</span> / host bits)</span></p>
              {([['Address', info.binary.ip], ['Netmask', info.binary.netmask], ['Network', info.binary.network], ['Broadcast', info.binary.broadcast]] as const).map(([k, b]) => (
                <div key={k} className="flex flex-col sm:flex-row sm:items-center gap-x-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">{k}</span>
                  <BinaryBits bits={b} prefix={info.prefix} />
                </div>
              ))}
            </div>
          </div>
          <Card size="sm">
            <CardHeader><CardTitle className="text-sm">Split this network</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <Segmented value={splitMode} onChange={v => { setSplitMode(v); setSplitN(v === 'prefix' ? Math.min(info.prefix + 2, 32) : v === 'hosts' ? 50 : 4); }}
                  options={[{ value: 'count', label: 'Into N subnets' }, { value: 'hosts', label: 'By hosts per subnet' }, { value: 'prefix', label: 'By prefix' }]} />
                <Input type="number" className="w-24" value={splitN} min={splitMode === 'prefix' ? info.prefix : 1} max={splitMode === 'prefix' ? 32 : undefined} onChange={e => setSplitN(Number(e.target.value))} />
                <span className="text-xs text-muted-foreground">→ /{newPrefix}{split && !('error' in split) ? ` · ${split.count.toLocaleString()} subnets × ${split.subnets[0]?.hosts.toLocaleString()} hosts` : ''}</span>
              </div>
              {split && 'error' in split && <ErrorBox message={split.error} />}
              {split && !('error' in split) && (
                <>
                  <div className="rounded-md border border-border overflow-x-auto max-h-80">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground sticky top-0 bg-card">
                        <tr className="border-b border-border text-left"><th className="px-3 py-1.5 font-medium">#</th><th className="px-3 py-1.5 font-medium">Subnet</th><th className="px-3 py-1.5 font-medium">Host range</th><th className="px-3 py-1.5 font-medium">Broadcast</th><th className="px-3 py-1.5 font-medium">Hosts</th></tr>
                      </thead>
                      <tbody>
                        {split.subnets.map((s, i) => (
                          <tr key={s.network} className="border-b border-border last:border-0 font-mono">
                            <td className="px-3 py-1 text-muted-foreground">{i + 1}</td>
                            <td className="px-3 py-1 whitespace-nowrap">{s.network}/{s.prefix}</td>
                            <td className="px-3 py-1 whitespace-nowrap">{s.firstHost} – {s.lastHost}</td>
                            <td className="px-3 py-1">{s.broadcast}</td>
                            <td className="px-3 py-1 tabular-nums">{s.hosts.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center gap-2">
                    {split.count > split.subnets.length && <span className="text-[11px] text-muted-foreground">Showing the first {split.subnets.length} of {split.count.toLocaleString()}.</span>}
                    <CopyButton value={csv} label="Copy CSV" />
                    <Button variant="ghost" size="xs" onClick={() => downloadBlob(csv, `subnets-${info.network}-${newPrefix}.csv`)}><Download /> CSV</Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function SubnetV6() {
  const [input, setInput] = useState('2001:db8:abcd:12::5/48');
  const [newPrefix, setNewPrefix] = useState(52);
  const parsed = useMemo(() => parseV6Input(input), [input]);
  const info = 'error' in parsed ? null : ipv6Info(parsed.ip, parsed.prefix);
  const split = info && !('error' in parsed) ? splitIPv6(parsed.ip, parsed.prefix, newPrefix, 64) : null;
  const setPrefix = (p: number) => setInput(`${input.trim().split('/')[0]}/${p}`);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 items-end">
        <div className="space-y-1.5">
          <FieldLabel>IPv6 address / prefix</FieldLabel>
          <Input className="font-mono" value={input} onChange={e => setInput(e.target.value)} placeholder="2001:db8::/32" />
        </div>
        {info && (
          <div className="space-y-1.5">
            <FieldLabel action={<span className="text-xs font-mono">/{info.prefix}</span>}>Prefix length</FieldLabel>
            <input type="range" className="w-full accent-primary" min={0} max={128} value={info.prefix} onChange={e => setPrefix(Number(e.target.value))} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1 text-[11px] text-muted-foreground items-center">
        Try:
        {['2001:db8::/32', 'fd12:3456:789a::1/64', 'fe80::1ff:fe23:4567:890a/64', '2606:4700:4700::1111/128'].map(x => <Button key={x} variant="ghost" size="xs" className="font-mono" onClick={() => setInput(x)}>{x}</Button>)}
      </div>
      {'error' in parsed && <ErrorBox message={parsed.error} />}
      {info && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Stat label="Type" value={<span className="text-sm">{info.type}</span>} />
            <Stat label="Addresses" value={<span className="text-sm">{info.addressesPow}</span>} hint={info.addresses.length > 30 ? `${info.addresses.slice(0, 30)}…` : info.addresses} />
            <Stat label="/64 networks" value={<span className="text-sm">{info.subnets64 ?? '— (smaller than /64)'}</span>} />
          </div>
          <div className="rounded-md border border-border px-3">
            <OutputRow label="Compressed" value={info.compressed} />
            <OutputRow label="Expanded" value={info.expanded} />
            <OutputRow label="Network" value={`${info.network}/${info.prefix}`} />
            <OutputRow label="First address" value={info.networkExpanded} />
            <OutputRow label="Last address" value={info.lastExpanded} />
            <OutputRow label="Total addresses" value={info.addresses} />
            <OutputRow label="Reverse zone" value={info.arpa} />
          </div>
          <Card size="sm">
            <CardHeader><CardTitle className="text-sm">Split into smaller prefixes</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">New prefix</span>
                <Input type="number" className="w-24" min={info.prefix} max={128} value={newPrefix} onChange={e => setNewPrefix(Number(e.target.value))} />
                {split && !('error' in split) && <span className="text-xs text-muted-foreground">{formatBig(split.count)} subnets</span>}
              </div>
              {split && 'error' in split && <ErrorBox message={split.error} />}
              {split && !('error' in split) && (
                <>
                  <pre className={cn(MONO, 'max-h-64 overflow-auto rounded-md border border-border bg-secondary p-3')}>{split.subnets.join('\n')}{split.count > BigInt(split.subnets.length) ? '\n…' : ''}</pre>
                  <CopyButton value={split.subnets.join('\n')} label="Copy" />
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function RangeToCidr() {
  const [start, setStart] = useState('10.0.0.1');
  const [end, setEnd] = useState('10.0.0.100');
  const a = parseIPv4(start);
  const b = parseIPv4(end);
  const err = a === null ? 'Start is not a valid IPv4 address' : b === null ? 'End is not a valid IPv4 address' : a > b ? 'Start must not be after end' : '';
  const cidrs = !err ? rangeToCidrs(a!, b!) : [];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><FieldLabel>Start address</FieldLabel><Input className="font-mono" value={start} onChange={e => setStart(e.target.value)} /></div>
        <div className="space-y-1.5"><FieldLabel>End address</FieldLabel><Input className="font-mono" value={end} onChange={e => setEnd(e.target.value)} /></div>
      </div>
      {err ? <ErrorBox message={err} /> : (
        <div className="space-y-1.5">
          <FieldLabel action={<CopyButton value={cidrs.join('\n')} label="Copy" />}>{cidrs.length} CIDR block{cidrs.length === 1 ? '' : 's'} · {(b! - a! + 1).toLocaleString()} addresses</FieldLabel>
          <div className="flex flex-wrap gap-1.5">{cidrs.map(c => <Badge key={c} variant="outline" className="font-mono">{c}</Badge>)}</div>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">The minimal set of CIDR blocks that exactly covers the range — handy for firewall rules and allow-lists.</p>
    </div>
  );
}

