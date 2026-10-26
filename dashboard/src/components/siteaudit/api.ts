/** Client + types for the Go site-auditor, proxied by the dashboard server at /api/site-audit/*. */
import { BASE, authFetch } from '../../api';

export type Severity = 'error' | 'warning' | 'notice';

export interface AuditOptions {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  userAgent?: string;
  respectRobots?: boolean;
  includeSubdomains?: boolean;
  checkExternal?: boolean;
  checkResources?: boolean;
  useSitemaps?: boolean;
  stripQuery?: boolean;
  crawlDelayMs?: number;
  timeoutSec?: number;
  include?: string[];
  exclude?: string[];
  pageSpeed?: boolean;
  pageSpeedKey?: string;
  keyword?: string;
}

export interface Progress {
  phase: string;
  crawled: number;
  queued: number;
  discovered: number;
  errors: number;
  resourcesChecked: number;
  resourcesTotal: number;
  current?: string;
  startedAt: string;
  elapsedMs: number;
  pagesPerSec: number;
  log?: string[];
}

export interface AuditSummary {
  id: string;
  url: string;
  host: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  error?: string;
  score: number;
  grade: string;
  pages: number;
  errors: number;
  warnings: number;
  notices: number;
  createdAt: string;
  finishedAt: string;
  durationMs: number;
  categories?: Record<string, number>;
  progress?: Progress;
  options: AuditOptions;
}

export interface IssueResult {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  why: string;
  fix: string;
  site?: boolean;
  asset?: boolean;
  count: number;
  urls?: string[];
  details?: Record<string, string>;
  ratio: number;
}

export interface Category { ID: string; Label: string; Weight: number }

export interface PageRow {
  url: string;
  status: number;
  error?: string;
  blocked?: boolean;
  contentType?: string;
  depth: number;
  indexable: boolean;
  indexReason?: string;
  title?: string;
  titleLen: number;
  description?: string;
  descLen: number;
  h1?: string;
  h1Count: number;
  words: number;
  ttfbMs: number;
  loadMs: number;
  sizeKb: number;
  inlinks: number;
  outlinks: number;
  external: number;
  linkScore: number;
  inSitemap: boolean;
  canonical?: string;
  redirectTo?: string;
  readability: number;
  images: number;
  schema?: string[];
  issues: string[];
  isHtml: boolean;
}

export interface TLSInfo {
  valid: boolean; error?: string; version?: string; cipher?: string; alpn?: string; subject?: string; issuer?: string;
  sans?: string[]; notBefore: string; notAfter: string; daysLeft: number; keyType?: string; chainLength: number;
}
export interface HeaderCheck { name: string; present: boolean; value?: string; good: boolean; note?: string }
export interface DNSInfo {
  a: string[] | null; aaaa: string[] | null; ns: string[] | null; mx: string[] | null; txt: string[] | null;
  spf?: string; dmarc?: string; caa: boolean; dnssec: boolean; cname?: string; error?: string;
}
export interface ProbeResult { url: string; status: number; location?: string; error?: string; ok: boolean; note?: string }
export interface BotAccess { token: string; owner: string; purpose: string; allowed: boolean; rule?: string }
export interface RobotsInfo {
  url: string; status: number; found: boolean; size: number; content?: string; sitemaps?: string[]; agents?: string[];
  crawlDelay?: number; aiBots?: BotAccess[]; searchBots?: BotAccess[];
}
export interface SitemapInfo { url: string; status: number; kind: string; urlCount: number; children?: number; error?: string; warnings?: string[]; sizeBytes: number }
export interface Tech { name: string; category: string; version?: string; evidence?: string }
export interface Metric { value: number; display: string; category?: string; score: number }
export interface PageSpeedRun {
  strategy: string; error?: string; scores?: Record<string, number>; metrics?: Record<string, Metric>;
  field?: Record<string, Metric>; fieldScope?: string;
  opportunities?: { id: string; title: string; savingsMs: number; display?: string; score: number }[];
}
export interface SiteInfo {
  origin: string; finalUrl: string; startRedirects?: ProbeResult[]; ip?: string[]; server?: string; protocol?: string; http2: boolean;
  tls?: TLSInfo; securityHeaders: HeaderCheck[]; securityGrade: string; dns?: DNSInfo; httpsRedirect?: ProbeResult;
  wwwCheck?: ProbeResult; soft404?: ProbeResult; llmsTxt?: ProbeResult; securityTxt?: ProbeResult; favicon?: ProbeResult;
  robots?: RobotsInfo; sitemaps: SitemapInfo[]; sitemapUrls: number; tech: Tech[]; pageSpeed?: PageSpeedRun[]; homeSchema?: string[];
}

export interface Summary {
  pagesCrawled: number; htmlPages: number; indexable: number; nonIndexable: number; redirects: number; clientErrors: number;
  serverErrors: number; blocked: number; failed: number; internalLinks: number; externalLinks: number; brokenLinks: number;
  images: number; avgTtfbMs: number; avgLoadMs: number; avgWords: number; avgSizeKb: number; totalBytes: number; maxDepth: number;
  orphans: number; statusCodes: Record<string, number>; depthHist: Record<string, number>; contentTypes: Record<string, number>;
  errors: number; warnings: number; notices: number; ttfbHist: Record<string, number>; wordHist: Record<string, number>;
  schemaTypes: Record<string, number>;
}

export interface DupGroup { value: string; urls: string[] }
export interface NearDup { a: string; b: string; similarity: number }
export interface RedirectChain { start: string; hops: { url: string; status: number }[]; final: string; finalStatus: number; loop: boolean }

export interface AuditReport {
  id: string;
  status: AuditSummary['status'];
  error?: string;
  options: AuditOptions;
  startUrl: string;
  host: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  score: number;
  grade: string;
  categoryScores: Record<string, number>;
  categories: Category[];
  summary: Summary;
  issues: IssueResult[];
  site: SiteInfo;
  pages: PageRow[];
  dupTitles: DupGroup[];
  dupDescriptions: DupGroup[];
  dupH1: DupGroup[];
  dupContent: DupGroup[];
  nearDuplicates: NearDup[];
  redirectChains: RedirectChain[];
  truncated: boolean;
  progress: Progress;
  resourceStats: Record<string, Record<string, number>>;
  edgeCount: number;
}

export interface RunningAudit { id: string; status: 'queued' | 'running'; progress: Progress; options: AuditOptions; startUrl: string }

export interface Heading { level: number; text: string }
export interface ImageRef { src: string; alt: string; hasAlt: boolean; width?: string; height?: string; lazy: boolean; srcset: boolean; inLink: boolean; status?: number; size?: number; format?: string }
export interface LinkRef { url: string; anchor: string; rel?: string; internal: boolean; nofollow: boolean; imgLink?: boolean }
export interface SchemaItem { format: string; types: string[] | null; errors?: string[]; raw?: string }

export interface PageDetail {
  page: {
    url: string; status: number; error?: string; blockedByRobots?: boolean; robotsRule?: string; contentType?: string; proto?: string;
    depth: number; foundFrom?: string; redirectTo?: string; size: number; transferSize: number; compression?: string;
    timing: { dnsMs: number; connectMs: number; tlsMs: number; ttfbMs: number; totalMs: number };
    headers?: Record<string, string>; isHtml: boolean; indexable: boolean; indexReason?: string;
    title: string; titleCount: number; titlePx: number; description: string; descCount: number; descPx: number;
    metaRobots?: string; xRobots?: string; canonical?: string; canonicalCount: number; h1: string[]; headings?: Heading[];
    lang?: string; charset?: string; viewport?: string; doctype: boolean; generator?: string; favicon?: string; amp?: string;
    prev?: string; next?: string; hreflang?: { lang: string; url: string }[]; openGraph?: Record<string, string>; twitter?: Record<string, string>;
    schema?: SchemaItem[]; wordCount: number; textRatio: number; readability: number; readingLevel?: string; sentences: number;
    keywords?: { term: string; count: number; density: number }[]; textSample?: string; links?: LinkRef[];
    internalLinks: number; externalLinks: number; nofollowLinks: number; images?: ImageRef[]; scripts?: string[]; styles?: string[];
    renderBlocking: number; inlineScriptKb: number; inlineStyleKb: number; domNodes: number; domDepth: number; iframes: number; forms: number;
    mixedContent?: string[]; deprecated?: string[];
    a11y: Record<string, number>; inlinks: number; uniqueInlinks: number; linkScore: number; inSitemap: boolean; issues?: string[];
    keywordCheck?: { keyword: string; inTitle: boolean; inDescription: boolean; inH1: boolean; inUrl: boolean; inFirst100: boolean; occurrences: number };
  };
  inlinks: { from: string; to: string; anchor: string; nofollow: boolean }[];
  issues: IssueResult[];
  chain?: RedirectChain | null;
}

export interface LinkRow { from: string; to: string; anchor: string; nofollow: boolean; internal: boolean; status: number; error?: string; redirectTo?: string }
export interface ResourceRow {
  url: string; kind: string; status: number; error?: string; contentType?: string; size: number; cacheControl?: string;
  compression?: string; redirectTo?: string; internal: boolean; timeMs: number; foundOn: string[] | null; foundOnCount: number;
}
export interface Paged<T> { total: number; offset: number; limit: number; rows: T[] }

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(e.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const root = () => `${BASE}/api/site-audit`;
const qs = (p: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();

export const auditApi = {
  list: () => authFetch(`${root()}/audits`).then(r => parse<{ audits: AuditSummary[] }>(r)).then(r => r.audits),
  start: (opts: AuditOptions) => authFetch(`${root()}/audits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts),
  }).then(r => parse<AuditSummary>(r)),
  get: (id: string) => authFetch(`${root()}/audits/${id}`).then(r => parse<AuditReport | RunningAudit>(r)),
  progress: (id: string) => authFetch(`${root()}/audits/${id}/progress`).then(r => parse<{ status: string; progress: Progress }>(r)),
  cancel: (id: string) => authFetch(`${root()}/audits/${id}/cancel`, { method: 'POST' }).then(r => parse<{ ok: boolean }>(r)),
  remove: (id: string) => authFetch(`${root()}/audits/${id}`, { method: 'DELETE' }).then(r => parse<{ ok: boolean }>(r)),
  page: (id: string, url: string) => authFetch(`${root()}/audits/${id}/page?${qs({ url })}`).then(r => parse<PageDetail>(r)),
  links: (id: string, p: { type?: string; q?: string; offset?: number; limit?: number }) =>
    authFetch(`${root()}/audits/${id}/links?${qs(p)}`).then(r => parse<Paged<LinkRow>>(r)),
  resources: (id: string, p: { kind?: string; filter?: string; q?: string; offset?: number; limit?: number }) =>
    authFetch(`${root()}/audits/${id}/resources?${qs(p)}`).then(r => parse<Paged<ResourceRow>>(r)),
  export: async (id: string, type: string, format: 'csv' | 'json') => {
    const res = await authFetch(`${root()}/audits/${id}/export?${qs({ type, format })}`);
    if (!res.ok) await parse(res);
    const cd = res.headers.get('content-disposition') || '';
    const name = /filename="([^"]+)"/.exec(cd)?.[1] || `audit-${type}.${format}`;
    return { blob: await res.blob(), name };
  },
};

export function isRunning(r: AuditReport | RunningAudit): r is RunningAudit {
  return r.status === 'queued' || r.status === 'running';
}
