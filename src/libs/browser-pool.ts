/**
 * @file browser-pool.ts
 * @description In-memory pool manager for remote browser instances.
 *
 * Remote browser workers (GitHub Actions jobs) register themselves via webhook,
 * send heartbeats every 60 s, and deregister on shutdown.  This module tracks
 * their lifecycle, prunes stale/dead entries, and provides round-robin selection
 * for distributed search.
 *
 * Page-pool / puppeteer connection management lives in page-pool.ts.
 */

import {
  acquirePage,
  releasePage,
  invalidateWorkerConnection,
  workerCdpFailures,
  MAX_WORKER_CDP_FAILURES,
  warmupWorker,
  isWorkerCached,
} from './page-pool';
import type { WorkerConnection } from './page-pool';
import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoteBrowser {
  workerId: string;
  cdpUrl: string;          // https://xxx.trycloudflare.com  (proxies Puppeteer CDP :9222)
  sbCdpUrl?: string;       // https://xxx.trycloudflare.com  (proxies SeleniumBase UC CDP :9223)
  seleniumCdpUrl?: string; // Alias for SeleniumBase CDP
  apiUrl?: string;         // https://xxx.trycloudflare.com  (proxies Python API :8000)
  vscodeUrl?: string;      // https://xxx.trycloudflare.com  (proxies Web VS Code :8088)
  vscodePassword?: string; // Generated session password for Web VS Code
  antigravityCli?: boolean;// True if Antigravity CLI (agy) is available on the worker
  antigravityAuth?: boolean;// True if Antigravity CLI OAuth token is configured on the worker
  courseWorkerUrl?: string;// https://xxx.trycloudflare.com  (proxies Go Course Worker :8085)
  shellWsUrl?: string;     // wss://xxx.trycloudflare.com/ws/shell (Interactive PTY terminal WebSocket)
  sshUrl?: string;         // tcp://xxx.trycloudflare.com:port (OpenSSH Cloudflare tunnel)
  sshPort?: number;        // SSH port (default 2222)
  sshUser?: string;        // SSH username (e.g. runner)
  sshPassword?: string;    // SSH session password
  sshCommand?: string;     // One-click connection string (e.g. ssh -p 2222 runner@host)
  registeredAt: number;    // Date.now() ms
  lastHeartbeat: number;   // Date.now() ms — updated on every heartbeat
  status: 'active' | 'stale' | 'dead';
  runId?: string;
  captchaTimes: number[];
  tempBlockedUntil?: number;
  blockCount: number;
}

export type WebhookEvent = 'register' | 'heartbeat' | 'deregister';

export interface WebhookPayload {
  event: WebhookEvent;
  workerId: string;
  cdpUrl: string;
  sbCdpUrl?: string;
  seleniumCdpUrl?: string;
  apiUrl?: string;
  vscodeUrl?: string;
  vscodePassword?: string;
  antigravityCli?: boolean;
  antigravityAuth?: boolean;
  courseWorkerUrl?: string;
  shellWsUrl?: string;
  sshUrl?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  sshCommand?: string;
  runId?: string;
  timestamp: string;       // ISO-8601
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** If no heartbeat for 75 s → mark stale (skip for new search requests). */
const STALE_TIMEOUT_MS = 75 * 1000;

/** If no heartbeat for 2 min → remove entirely. */
const DEAD_TIMEOUT_MS = 120 * 1000;

/** Background cleanup interval. */
const CLEANUP_INTERVAL_MS = 15 * 1000;

// ---------------------------------------------------------------------------
// BrowserPool
// ---------------------------------------------------------------------------

class BrowserPool {
  private browsers = new Map<string, RemoteBrowser>();
  private roundRobinIndex = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private failureTimestamps: number[] = [];
  private lastRestartTime = 0;
  private readonly RESTART_COOLDOWN_MS = 2 * 60 * 1000;
  public onRegister?: (browser: RemoteBrowser) => void;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Register a new remote browser (or update existing — idempotent upsert). */
  register(
    workerId: string,
    cdpUrl: string,
    runId?: string,
    skipWarmup = false,
    apiUrl?: string,
    sbCdpUrl?: string,
    seleniumCdpUrl?: string,
    vscodeUrl?: string,
    vscodePassword?: string,
    antigravityCli?: boolean,
    courseWorkerUrl?: string,
    shellWsUrl?: string,
    sshUrl?: string,
    sshPort?: number,
    sshUser?: string,
    sshPassword?: string,
    sshCommand?: string,
    antigravityAuth?: boolean
  ): void {
    const now = Date.now();
    const existing = this.browsers.get(workerId);
    const resolvedSbCdpUrl = sbCdpUrl || seleniumCdpUrl;
    const resolvedShellWs = shellWsUrl || (apiUrl ? apiUrl.replace(/^http/i, 'ws') + '/ws/shell' : undefined);

    let browserEntry: RemoteBrowser;
    if (existing) {
      existing.cdpUrl = cdpUrl;
      if (resolvedSbCdpUrl) {
        existing.sbCdpUrl = resolvedSbCdpUrl;
        existing.seleniumCdpUrl = resolvedSbCdpUrl;
      }
      existing.apiUrl = apiUrl;
      if (vscodeUrl) existing.vscodeUrl = vscodeUrl;
      if (vscodePassword) existing.vscodePassword = vscodePassword;
      if (antigravityCli !== undefined) existing.antigravityCli = antigravityCli;
      if (antigravityAuth !== undefined) existing.antigravityAuth = antigravityAuth;
      if (courseWorkerUrl) existing.courseWorkerUrl = courseWorkerUrl;
      if (resolvedShellWs) existing.shellWsUrl = resolvedShellWs;
      if (sshUrl) existing.sshUrl = sshUrl;
      if (sshPort) existing.sshPort = sshPort;
      if (sshUser) existing.sshUser = sshUser;
      if (sshPassword) existing.sshPassword = sshPassword;
      if (sshCommand) existing.sshCommand = sshCommand;
      existing.lastHeartbeat = now;
      existing.status = 'active';
      if (runId) existing.runId = runId;
      browserEntry = existing;
    } else {
      browserEntry = {
        workerId,
        cdpUrl,
        sbCdpUrl: resolvedSbCdpUrl,
        seleniumCdpUrl: resolvedSbCdpUrl,
        apiUrl,
        vscodeUrl,
        vscodePassword,
        antigravityCli,
        antigravityAuth,
        courseWorkerUrl,
        shellWsUrl: resolvedShellWs,
        sshUrl,
        sshPort: sshPort || 2222,
        sshUser: sshUser || 'runner',
        sshPassword,
        sshCommand,
        registeredAt: now,
        lastHeartbeat: now,
        status: 'active',
        runId,
        captchaTimes: [],
        blockCount: 0,
      };
      this.browsers.set(workerId, browserEntry);
    }

    // Eagerly connect to the browser and open an idle page for caching
    if (!skipWarmup) {
      warmupWorker(browserEntry);
    }

    if (this.onRegister) {
      this.onRegister(browserEntry);
    }
  }

  /** Update heartbeat timestamp for a known worker. Returns false if unknown. */
  heartbeat(
    workerId: string,
    runId?: string,
    extra?: {
      cdpUrl?: string;
      sbCdpUrl?: string;
      seleniumCdpUrl?: string;
      apiUrl?: string;
      vscodeUrl?: string;
      vscodePassword?: string;
      antigravityCli?: boolean;
      antigravityAuth?: boolean;
      courseWorkerUrl?: string;
      shellWsUrl?: string;
      sshUrl?: string;
      sshPort?: number;
      sshUser?: string;
      sshPassword?: string;
      sshCommand?: string;
    }
  ): boolean {
    const entry = this.browsers.get(workerId);
    if (!entry) return false;
    entry.lastHeartbeat = Date.now();
    entry.status = 'active';
    if (runId) entry.runId = runId;
    if (extra) {
      if (extra.cdpUrl) entry.cdpUrl = extra.cdpUrl;
      const resolvedSb = extra.sbCdpUrl || extra.seleniumCdpUrl;
      if (resolvedSb) {
        entry.sbCdpUrl = resolvedSb;
        entry.seleniumCdpUrl = resolvedSb;
      }
      if (extra.apiUrl) entry.apiUrl = extra.apiUrl;
      if (extra.vscodeUrl) entry.vscodeUrl = extra.vscodeUrl;
      if (extra.vscodePassword) entry.vscodePassword = extra.vscodePassword;
      if (extra.antigravityCli !== undefined) entry.antigravityCli = extra.antigravityCli;
      if (extra.antigravityAuth !== undefined) entry.antigravityAuth = extra.antigravityAuth;
      if (extra.courseWorkerUrl) entry.courseWorkerUrl = extra.courseWorkerUrl;
      if (extra.shellWsUrl) {
        entry.shellWsUrl = extra.shellWsUrl;
      } else if (extra.apiUrl && !entry.shellWsUrl) {
        entry.shellWsUrl = extra.apiUrl.replace(/^http/i, 'ws') + '/ws/shell';
      }
      if (extra.sshUrl) entry.sshUrl = extra.sshUrl;
      if (extra.sshPort) entry.sshPort = extra.sshPort;
      if (extra.sshUser) entry.sshUser = extra.sshUser;
      if (extra.sshPassword) entry.sshPassword = extra.sshPassword;
      if (extra.sshCommand) entry.sshCommand = extra.sshCommand;
    }
    return true;
  }


  /** Explicitly remove a worker. */
  deregister(workerId: string): void {
    const existed = this.browsers.delete(workerId);
    if (existed) {
      invalidateWorkerConnection(workerId);
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────

  /** Return all browsers (any status). */
  getAll(): RemoteBrowser[] {
    const now = Date.now();
    for (const id of Array.from(this.browsers.keys())) {
      const entry = this.browsers.get(id);
      if (entry) {
        const elapsed = now - entry.lastHeartbeat;
        if (elapsed > DEAD_TIMEOUT_MS) {
          this.browsers.delete(id);
          invalidateWorkerConnection(id);
        } else if (elapsed > STALE_TIMEOUT_MS) {
          entry.status = 'stale';
        }
      }
    }
    return Array.from(this.browsers.values());
  }

  /** Return only active browsers. */
  getActive(): RemoteBrowser[] {
    const now = Date.now();
    for (const id of Array.from(this.browsers.keys())) {
      const entry = this.browsers.get(id);
      if (entry) {
        const elapsed = now - entry.lastHeartbeat;
        if (elapsed > DEAD_TIMEOUT_MS) {
          this.browsers.delete(id);
          invalidateWorkerConnection(id);
        } else if (elapsed > STALE_TIMEOUT_MS) {
          entry.status = 'stale';
        }
      }
    }
    return Array.from(this.browsers.values()).filter((b) =>
      b.status === 'active' &&
      (!b.tempBlockedUntil || b.tempBlockedUntil <= now)
    );
  }

  /** Return active workers with configured apiUrl. */
  getApiWorkers(): RemoteBrowser[] {
    return this.getActive().filter((b) => !!b.apiUrl);
  }

  /** Round-robin pick from active browsers (preferring workers with API URL). Returns null if none available. */
  getNext(): RemoteBrowser | null {
    const apiWorkers = this.getApiWorkers();
    const active = apiWorkers.length > 0 ? apiWorkers : this.getActive();
    if (active.length === 0) return null;
    this.roundRobinIndex = this.roundRobinIndex % active.length;
    const picked = active[this.roundRobinIndex];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % active.length;
    return picked;
  }

  /** Pool size (all statuses). */
  get size(): number {
    return this.browsers.size;
  }

  // ── Background cleanup ─────────────────────────────────────────────────

  /** Start the periodic cleanup loop (call once at server startup). */
  startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      (this.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the cleanup loop. */
  stopCleanupLoop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Record a CAPTCHA / hard failure. */
  recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.failureTimestamps = this.failureTimestamps.filter((t) => now - t < 60_000);

    if (this.failureTimestamps.length >= 20) {
      console.warn(`⚠️ Warning: ${this.failureTimestamps.length} failures recorded in last minute.`);
      this.failureTimestamps = [];
    }
  }

  /** Record a CAPTCHA and block/evict the worker if threshold reached. */
  recordCaptcha(workerId: string): void {
    const entry = this.browsers.get(workerId);
    if (!entry) return;

    const now = Date.now();
    entry.captchaTimes.push(now);
    const windowMs = 5 * 60 * 1000; // 5 minute window
    entry.captchaTimes = entry.captchaTimes.filter((t) => now - t < windowMs);

    console.warn(`[BrowserPool] CAPTCHA recorded for worker ${workerId}. Count in last 5m: ${entry.captchaTimes.length}`);

    if (entry.captchaTimes.length >= 10) {
      entry.blockCount += 1;
      const cooldownMs = 5 * 60 * 1000; // 5 minute cooldown
      entry.tempBlockedUntil = now + cooldownMs;
      entry.captchaTimes = []; // Clear for next cycle
      console.error(`[BrowserPool] Worker ${workerId} temporarily blocked for 5 minutes (temp-block count: ${entry.blockCount}) due to excessive CAPTCHAs.`);

      if (entry.blockCount >= 2) {
        console.error(`[BrowserPool] Worker ${workerId} has reached max temp-blocks. Permanently removing.`);
        this.deregister(workerId);
      }
    }
  }

  /** Cancel the GitHub Actions workflow run for a worker and deregister all its browsers. */
  async stopWorker(runId: string): Promise<boolean> {
    const pat = process.env.GITHUB_PAT || process.env.PAT_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPO || 'talharhshdh/discord-to-whatsapp';

    if (!pat || !runId) {
      console.warn(`[BrowserPool] Cannot stop worker run ${runId} (missing token or runId).`);
      return false;
    }

    try {
      console.log(`[BrowserPool] Cancelling GitHub Action run: ${runId}`);
      const resp = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/cancel`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${pat}`,
          'X-GitHub-Api-Version': '2022-11-28',
        }
      });
      if (resp.ok) {
        console.log(`[BrowserPool] GitHub Action run ${runId} cancelled successfully.`);
      } else {
        console.warn(`[BrowserPool] GitHub Action run cancel returned status: ${resp.status}`);
      }
    } catch (e) {
      console.error(`[BrowserPool] Failed to cancel GitHub Actions run ${runId}:`, e);
    }

    // Now deregister all browsers with this runId
    for (const [id, entry] of this.browsers) {
      if (entry.runId === runId) {
        console.log(`[BrowserPool] Deregistering worker ${id} associated with cancelled run ${runId}`);
        this.deregister(id);
      }
    }
    return true;
  }

  /** Execute Node.js, Python, or Shell code on a specific worker or auto-selected active worker with fallback retries. */
  async executeCode(
    workerId: string | undefined,
    lang: 'node' | 'python' | 'shell',
    code: string,
    timeout = 30
  ): Promise<{ exit_code: number; stdout: string; stderr: string; execution_time_ms: number; workerId: string }> {
    let candidates: RemoteBrowser[] = [];

    if (workerId && this.browsers.has(workerId)) {
      const specificWorker = this.browsers.get(workerId)!;
      candidates.push(specificWorker);
      const others = this.getApiWorkers().filter((b) => b.workerId !== workerId);
      candidates.push(...others);
    } else {
      const allApiWorkers = this.getApiWorkers();
      if (allApiWorkers.length > 0) {
        this.roundRobinIndex = this.roundRobinIndex % allApiWorkers.length;
        candidates = [
          ...allApiWorkers.slice(this.roundRobinIndex),
          ...allApiWorkers.slice(0, this.roundRobinIndex),
        ];
        this.roundRobinIndex = (this.roundRobinIndex + 1) % allApiWorkers.length;
      }
    }

    if (candidates.length === 0) {
      this.restartWorkers().catch(() => {});
      throw new Error('No active browser worker with an API URL is available. Triggered worker restart via GitHub Actions.');
    }

    const endpointMap = {
      node: '/exec/node',
      python: '/exec/python',
      shell: '/exec/shell',
    };
    const payload = lang === 'shell' ? { command: code, timeout } : { code, timeout };
    let lastError = '';

    for (const worker of candidates) {
      if (!worker.apiUrl) continue;

      try {
        const resp = await fetch(`${worker.apiUrl}${endpointMap[lang]}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (resp.ok) {
          const result = await resp.json();
          return { ...result, workerId: worker.workerId };
        }

        const errText = await resp.text();
        lastError = `Worker ${worker.workerId} exec HTTP ${resp.status}: ${errText}`;
        console.warn(`[BrowserPool] ${lastError}. Retrying next worker...`);
      } catch (e: any) {
        lastError = `Worker ${worker.workerId} connection failed: ${e.message}`;
        console.warn(`[BrowserPool] ${lastError}. Retrying next worker...`);
      }
    }

    this.restartWorkers().catch(() => {});
    throw new Error(`Worker execution error: All available browser worker(s) failed. (${lastError})`);
  }

  /** Proxy an arbitrary HTTP/HTTPS request through a specific worker or auto-selected active worker's IP with fallback retries. */
  async proxyRequest(
    workerId: string | undefined,
    req: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number }
  ): Promise<{ status_code: number; headers: Record<string, string>; body: string; execution_time_ms: number; workerId: string }> {
    let candidates: RemoteBrowser[] = [];

    if (workerId && this.browsers.has(workerId)) {
      const specificWorker = this.browsers.get(workerId)!;
      candidates.push(specificWorker);
      const others = this.getApiWorkers().filter((b) => b.workerId !== workerId);
      candidates.push(...others);
    } else {
      const allApiWorkers = this.getApiWorkers();
      if (allApiWorkers.length > 0) {
        this.roundRobinIndex = this.roundRobinIndex % allApiWorkers.length;
        candidates = [
          ...allApiWorkers.slice(this.roundRobinIndex),
          ...allApiWorkers.slice(0, this.roundRobinIndex),
        ];
        this.roundRobinIndex = (this.roundRobinIndex + 1) % allApiWorkers.length;
      }
    }

    if (candidates.length === 0) {
      this.restartWorkers().catch(() => {});
      throw new Error('No active browser worker with an API URL is available. Triggered worker restart via GitHub Actions.');
    }

    let lastError = '';

    for (const worker of candidates) {
      if (!worker.apiUrl) continue;

      try {
        const resp = await fetch(`${worker.apiUrl}/proxy/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        });

        if (resp.ok) {
          const result = await resp.json();
          return { ...result, workerId: worker.workerId };
        }

        const errText = await resp.text();
        lastError = `Worker ${worker.workerId} proxy HTTP ${resp.status}: ${errText}`;
        console.warn(`[BrowserPool] ${lastError}. Retrying next worker...`);
      } catch (e: any) {
        lastError = `Worker ${worker.workerId} connection failed: ${e.message}`;
        console.warn(`[BrowserPool] ${lastError}. Retrying next worker...`);
      }
    }

    this.restartWorkers().catch(() => {});
    throw new Error(`Worker proxy error: All available browser worker(s) failed. (${lastError})`);
  }


  /** Trigger a restart of all browser workers via GitHub Actions. */
  async restartWorkers(forceRestart = false): Promise<void> {
    const now = Date.now();
    if (now - this.lastRestartTime < this.RESTART_COOLDOWN_MS) {
      return;
    }
    this.lastRestartTime = now;

    const pat = process.env.GITHUB_PAT || process.env.PAT_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPO || 'talharhshdh/discord-to-whatsapp';

    if (!pat) {
      return;
    }

    try {
      // Get all active runs of browser-worker.yml
      const listUrl = `https://api.github.com/repos/${repo}/actions/workflows/browser-worker.yml/runs?per_page=100`;
      const response = await fetch(listUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${pat}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        const activeRuns = (data.workflow_runs || []).filter(
          (run: any) => run.status !== 'completed'
        );

        if (forceRestart) {
          console.log(`[BrowserPool] Force restart requested. Cancelling all ${activeRuns.length} active runs...`);
          for (const run of activeRuns) {
            const cancelUrl = `https://api.github.com/repos/${repo}/actions/runs/${run.id}/cancel`;
            try {
              await fetch(cancelUrl, {
                method: 'POST',
                headers: {
                  Accept: 'application/vnd.github+json',
                  Authorization: `Bearer ${pat}`,
                  'X-GitHub-Api-Version': '2022-11-28',
                },
              });
              console.log(`[BrowserPool] Cancelled run ${run.id}.`);
            } catch (err) {
              console.error(`[BrowserPool] Failed to cancel run ${run.id}:`, err);
            }
          }
          if (activeRuns.length > 0) {
            // Wait for GitHub Actions API to process cancellation
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } else {
          // Check if there is any active run created in the last 4 minutes
          const RECENT_RUN_THRESHOLD_MS = 4 * 60 * 1000;
          const recentRun = activeRuns.find((run: any) => {
            const createdTime = new Date(run.created_at).getTime();
            return now - createdTime < RECENT_RUN_THRESHOLD_MS;
          });

          if (recentRun) {
            const elapsedSec = Math.round((now - new Date(recentRun.created_at).getTime()) / 1000);
            console.log(`[BrowserPool] A browser worker run (ID: ${recentRun.id}) was triggered recently (${elapsedSec}s ago). Skipping duplicate spawn.`);
            return;
          }

          // Cancel stale QUEUED runs before dispatching a fresh one.
          // A run stuck in "queued" for >4 min will not produce workers in
          // time; leaving them piles up an unbounded Actions backlog (this
          // caused hundreds of queued runs). In-progress runs are real
          // workers and must NOT be touched here.
          const staleQueued = activeRuns.filter(
            (run: any) => run.status === 'queued' || run.status === 'waiting' || run.status === 'pending'
          );
          if (staleQueued.length > 0) {
            console.log(`[BrowserPool] Cancelling ${staleQueued.length} stale queued browser-worker run(s) before new dispatch...`);
            for (const run of staleQueued) {
              try {
                await fetch(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/cancel`, {
                  method: 'POST',
                  headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${pat}`,
                    'X-GitHub-Api-Version': '2022-11-28',
                  },
                });
                console.log(`[BrowserPool] Cancelled stale queued run ${run.id}.`);
              } catch (err) {
                console.error(`[BrowserPool] Failed to cancel stale queued run ${run.id}:`, err);
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(`[BrowserPool] Error checking/cancelling runs:`, e);
    }

    try {
      await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${pat}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: 'spawn-browsers' }),
      });
      console.log(`[BrowserPool] Spawning browser workers dispatched successfully.`);
    } catch (e) {
      // Error suppressed
    }
  }
  // ── Internal cleanup pass ──────────────────────────────────────────────

  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.browsers) {
      const elapsed = now - entry.lastHeartbeat;

      if (elapsed > DEAD_TIMEOUT_MS) {
        this.browsers.delete(id);
        invalidateWorkerConnection(id);
      } else if (elapsed > STALE_TIMEOUT_MS && entry.status === 'active') {
        entry.status = 'stale';
      }
    }

    // Auto-scaling: If active browsers drop below 3, and total browsers are below 30, trigger new spawn.
    const activeCount = this.getActive().length;
    const MAX_TOTAL_BROWSERS = 30;
    if (activeCount < 3 && this.browsers.size < MAX_TOTAL_BROWSERS) {
      console.warn(`[BrowserPool] Active browsers dropped below 3 (active: ${activeCount}, total: ${this.browsers.size}). Triggering new worker spawn...`);
      this.restartWorkers();
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const browserPool = new BrowserPool();

// ---------------------------------------------------------------------------
// Distributed Google search helper
// ---------------------------------------------------------------------------

/**
 * Execute a Google web search via a remote browser from the pool.
 *
 * The cloudflared tunnel proxies HTTP/WS traffic to Chrome's CDP port (9222).
 * We fetch `/json/version` to discover the WebSocket debugger URL, rewrite the
 * host to point at the tunnel, then connect puppeteer-core over `wss://`.
 */
export async function searchViaPool(
  text: string,
  pageNumber: number = 1,
  includeAI: boolean = false,
  category: string = 'all',
): Promise<{
  organic: Array<{ title: string; link: string; snippet: string }>;
  aiResponse: string | null;
  featuredSnippet?: { title: string; link: string; snippet: string } | null;
  knowledgePanel?: {
    title: string;
    subtitle?: string;
    description?: string;
    sourceUrl?: string;
    attributes?: Array<{ label: string; value: string }>;
  } | null;
  peopleAlsoAsk?: Array<{ question: string; answer?: string; sourceTitle?: string; sourceUrl?: string }>;
  directAnswer?: { type: string; answer: string; details?: string } | null;
  news?: Array<{ title: string; source: string; time: string; link: string }>;
  videos?: Array<{ title: string; source: string; duration?: string; uploadedAt?: string; link: string }>;
  images?: Array<{ alt: string; sourceUrl: string; imageUrl?: string }>;
  shopping?: Array<{ title: string; price: string; merchant: string; rating?: string; link: string }>;
  relatedSearches?: string[];
  localResults?: Array<{ title: string; rating?: string; reviewsCount?: string; address?: string; phone?: string; link?: string }>;
} | null> {
  const normCategory = category.toLowerCase().trim();
  let categoryKey = 'all';
  if (normCategory === 'videos' || normCategory === 'video') {
    categoryKey = 'videos';
  } else if (normCategory === 'images' || normCategory === 'image') {
    categoryKey = 'images';
  } else if (normCategory === 'news') {
    categoryKey = 'news';
  } else if (normCategory === 'shopping' || normCategory === 'shop') {
    categoryKey = 'shopping';
  }

  const activeBrowsers = browserPool.getActive();
  const maxAttempts = Math.max(1, activeBrowsers.length);
  const hasAnyCached = activeBrowsers.some(b => isWorkerCached(b.workerId));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    // If this browser isn't cached, but there are other cached browsers available, skip this one
    // and run a background warmup so it's ready for future requests.
    if (hasAnyCached && !isWorkerCached(browser.workerId)) {
      warmupWorker(browser);
      continue;
    }



    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    try {
      const acquired = await acquirePage(browser, true);
      conn = acquired.conn;
      page = acquired.page;

      try {
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.detach();
      } catch { /* ignore */ }

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.evaluateOnNewDocument(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch { }
      });

      // ── Request interception: block heavy assets ───────────────────────
      page.removeAllListeners('request');
      await page.setRequestInterception(true);
      page.on('request', async (req: any) => {
        try {
          if (req.isInterceptResolutionHandled()) return;

          const type = req.resourceType();
          const url = req.url();

          // Never block the main document navigation
          if (type === 'document') {
            try { await req.continue(); } catch { }
            return;
          }

          // Block unnecessary heavy resource types
          if (
            [
              'font',
              'media',
              'websocket',
              'manifest',
              'other',
            ].includes(type)
          ) {
            try { await req.abort(); } catch { }
            return;
          }

          // Block telemetry / tracking / analytics
          if (
            url.includes('gen_204') ||
            url.includes('/log?') ||
            url.includes('sodar') ||
            url.includes('batchexecute') ||
            url.includes('async=') ||
            url.includes('google-analytics') ||
            url.includes('play.google.com/log') ||
            url.includes('/gen_204') ||
            url.includes('clients1.google.com')
          ) {
            try { await req.abort(); } catch { }
            return;
          }

          try { await req.continue(); } catch { }
        } catch (err) {
          // ignore
        }
      });

      const startParam = (pageNumber - 1) * 10;
      let targetUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}&start=${startParam}&num=10&hl=en&pws=0`;
      if (categoryKey === 'images') {
        await new Promise((resolve) => setTimeout(resolve, 200));
        targetUrl += '&udm=2';
      } else {
        if (categoryKey === 'videos') {
          targetUrl += '&udm=7';
        } else if (categoryKey === 'news') {
          targetUrl += '&udm=14';
        } else if (categoryKey === 'shopping') {
          targetUrl += '&udm=3';
        }
      }


      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((err: any) => {
        console.warn(`[BrowserPool] Navigation notice for ${targetUrl}:`, err.message);
      });

      if (categoryKey === 'images') {
        await page
          .waitForSelector('div[data-ri], a[href*="imgres"], form[action*="/sorry/"], #captcha, .g-recaptcha', { timeout: 4000 })
          .catch(() => { });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Traffic flow generation for "talhatech"
      if (text.toLowerCase().includes('talhatech')) {
        const decodeGoogleLink = (href: string | null): string => {
          if (!href) return '';
          try {
            if (href.startsWith('/url?q=')) {
              const urlPart = href.split('/url?q=')[1]?.split('&')[0];
              if (urlPart) return decodeURIComponent(urlPart);
            } else if (href.startsWith('/url?url=')) {
              const urlPart = href.split('/url?url=')[1]?.split('&')[0];
              if (urlPart) return decodeURIComponent(urlPart);
            }
          } catch (e) { }
          return href;
        };

        const linkSelector = 'a[href*="talhacodes.site"]';
        let clicked = false;
        try {
          console.log(`[BrowserPool] Waiting for target link on Google Search for "talhatech"...`);

          // Wait up to 10 seconds for either the link selector or a captcha to appear
          const foundType = await Promise.race([
            page.waitForSelector(linkSelector, { timeout: 10000 }).then(() => 'link'),
            page.waitForSelector('form[action*="/sorry/"], #captcha, .g-recaptcha', { timeout: 10000 }).then(() => 'captcha'),
          ]).catch(() => 'timeout');

          if (foundType === 'link') {
            // Find the actual target link selector (filtering out Google internal / utility links)
            const targetLinkSelector = await page.evaluate(() => {
              const decodeGoogleLinkInner = (href: string | null): string => {
                if (!href) return '';
                try {
                  if (href.startsWith('/url?q=')) {
                    const urlPart = href.split('/url?q=')[1]?.split('&')[0];
                    if (urlPart) return decodeURIComponent(urlPart);
                  } else if (href.startsWith('/url?url=')) {
                    const urlPart = href.split('/url?url=')[1]?.split('&')[0];
                    if (urlPart) return decodeURIComponent(urlPart);
                  }
                } catch (e) { }
                return href;
              };

              const els = Array.from(document.querySelectorAll('a[href*="talhacodes.site"]'));
              for (const el of els) {
                const href = el.getAttribute('href') || '';
                const decoded = decodeGoogleLinkInner(href);
                if (
                  decoded.includes('talhacodes.site') &&
                  !decoded.includes('google.com') &&
                  !decoded.includes('/search?') &&
                  !href.startsWith('/search?')
                ) {
                  el.setAttribute('data-target-talhatech-link', 'true');
                  return 'a[data-target-talhatech-link="true"]';
                }
              }
              return null;
            });

            if (targetLinkSelector) {
              console.log(`[BrowserPool] Found target link on Google Search for "talhatech". Selector: ${targetLinkSelector}`);

              // Get the href attribute to have a reliable direct navigation fallback
              const rawHref = await page.evaluate((sel: string) => {
                const el = document.querySelector(sel);
                return el ? el.getAttribute('href') : null;
              }, targetLinkSelector);

              const targetUrl = decodeGoogleLink(rawHref);
              console.log(`[BrowserPool] Target URL decoded: ${targetUrl}`);

              // Turn off request interception to allow target site assets/scripts to load
              await page.setRequestInterception(false);
              page.removeAllListeners('request');

              let navigated = false;

              // 1. Try Puppeteer's click first
              try {
                console.log(`[BrowserPool] Clicking target link via Puppeteer...`);
                await Promise.all([
                  page.click(targetLinkSelector),
                  page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 })
                ]);
                navigated = true;
              } catch (clickErr: any) {
                console.warn(`[BrowserPool] Puppeteer click/navigation failed: ${clickErr.message}`);
              }

              // 2. Try DOM click fallback if Puppeteer click failed to navigate
              if (!navigated) {
                try {
                  console.log(`[BrowserPool] Puppeteer click failed. Trying DOM-level click fallback...`);
                  await Promise.all([
                    page.evaluate((sel: string) => {
                      const el = document.querySelector(sel) as HTMLElement;
                      if (el) el.click();
                    }, targetLinkSelector),
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 })
                  ]);
                  navigated = true;
                } catch (domClickErr: any) {
                  console.warn(`[BrowserPool] DOM click fallback failed: ${domClickErr.message}`);
                }
              }

              // 3. Try direct navigation fallback if clicking failed entirely
              if (!navigated && targetUrl) {
                try {
                  console.log(`[BrowserPool] Clicking failed. Performing direct page.goto fallback to ${targetUrl}...`);
                  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                  navigated = true;
                } catch (gotoErr: any) {
                  console.warn(`[BrowserPool] Direct navigation fallback warning: ${gotoErr.message}`);
                  // If page URL shows we actually arrived at the target site, consider it navigated
                  if (page.url().includes('talhacodes.site')) {
                    navigated = true;
                  }
                }
              }

              if (navigated) {
                console.log(`[BrowserPool] Successfully navigated to: ${page.url()}`);
                // Scroll and move mouse randomly on the page to simulate real user behavior
                console.log(`[BrowserPool] Simulating human interaction (random scrolls & mouse movements)...`);

                try {
                  const viewport = await page.viewport() || { width: 1280, height: 800 };
                  const width = viewport.width;
                  const height = viewport.height;

                  // Move mouse to initial random position
                  await page.mouse.move(Math.floor(Math.random() * width), Math.floor(Math.random() * height));

                  const scrollSteps = 5 + Math.floor(Math.random() * 8); // 5 to 12 scroll steps
                  for (let i = 0; i < scrollSteps; i++) {
                    // 85% chance to scroll down, 15% chance to scroll up slightly
                    const direction = Math.random() > 0.15 ? 1 : -1;
                    const scrollAmount = Math.floor(Math.random() * (height / 2)) * direction;

                    await Promise.race([
                      page.evaluate((amount: number) => {
                        window.scrollBy(0, amount);
                      }, scrollAmount),
                      new Promise((_, reject) => setTimeout(() => reject(new Error('Scroll evaluation timeout')), 4000))
                    ]);

                    // Move mouse randomly on 70% of steps
                    if (Math.random() > 0.3) {
                      const targetX = Math.floor(Math.random() * width);
                      const targetY = Math.floor(Math.random() * height);
                      await page.mouse.move(targetX, targetY, { steps: 5 });
                    }

                    // Wait random time between scrolls (e.g. 1000ms to 3000ms)
                    const sleepTime = 1000 + Math.floor(Math.random() * 2000);
                    await new Promise(r => setTimeout(r, sleepTime));
                  }
                } catch (simErr: any) {
                  console.warn(`[BrowserPool] Warning during human simulation: ${simErr.message}`);
                }

                clicked = true;
              }
            } else {
              console.warn(`[BrowserPool] Target link not found/timed out on Google search results page (after filtering).`);
            }
          } else if (foundType === 'captcha') {
            console.error(`[BrowserPool] CAPTCHA detected during "talhatech" search.`);
            browserPool.recordCaptcha(browser.workerId);
          } else {
            console.warn(`[BrowserPool] Target link not found/timed out on Google search results page.`);
          }
        } catch (err: any) {
          console.error(`[BrowserPool] Error during traffic flow:`, err);
        } finally {
          pageErrored = true;
        }

        return {
          organic: [{ title: 'Talhatech Traffic Flow', link: 'https://talhacodes.site/', snippet: `Successfully clicked: ${clicked}` }],
          aiResponse: null
        };
      }

      const extractResults = async (categoryParam: string) => page.evaluate((categoryParamInner: string) => {
        if (document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha')) {
          return { captcha: true, organic: [] as any[], aiResponse: null as string | null };
        }

        document
          .querySelectorAll('[jsname="VwDHjd"], [aria-label="Show more"], .LGOjhe, .cUnQKe')
          .forEach((b) => (b as HTMLElement).click());

        const organic: Array<{ title: string; link: string; snippet: string; displayedLink?: string; favicon?: string }> = [];
        let aiResponse: string | null = null;
        const seen = new Set<string>();

        const cleanText = (str: string | null) => str ? str.trim().replace(/\s+/g, ' ') : '';

        const decodeGoogleLink = (href: string | null) => {
          if (!href) return '';
          try {
            if (href.startsWith('/url?q=')) {
              const urlPart = href.split('/url?q=')[1]?.split('&')[0];
              if (urlPart) return decodeURIComponent(urlPart);
            } else if (href.startsWith('/url?url=')) {
              const urlPart = href.split('/url?url=')[1]?.split('&')[0];
              if (urlPart) return decodeURIComponent(urlPart);
            }
          } catch (e) { }
          return href;
        };

        // 1. EXTRACT AI OVERVIEW / RESPONSE (SGE)
        for (const sel of [
          '.M8OgIe', '.LLtROe', '.IZ6rdc',
          '[data-attrid="wa:/description"]', '.wDYxhc[data-md]', '.kp-blk',
        ]) {
          const el = document.querySelector(sel);
          if (el && (el as HTMLElement).innerText?.trim().length > 20) {
            const txt = (el as HTMLElement).innerText;
            if (txt.includes('AI Overview is not available') || txt.includes("Can't generate an AI overview")) {
              continue;
            }
            // Filter out maps/places listing blocks incorrectly matched by generic card wrapper selectors
            if (
              el.querySelector('[href*="/maps/"]') ||
              el.querySelector('.YzSd') ||
              (el.textContent?.includes('Places') && el.textContent?.includes('Reviews'))
            ) {
              continue;
            }
            aiResponse = (el as HTMLElement).innerHTML || (el as HTMLElement).innerText.trim();
            break;
          }
        }

        // 2. EXTRACT FEATURED SNIPPET
        let featuredSnippet: any = null;
        const fsContainer = document.querySelector('[data-attrid="wa:/description"], .kp-blk, .hp-xpd, .c2d06b');
        if (fsContainer) {
          const titleEl = fsContainer.querySelector('h3, .LC20lb');
          const aEl = fsContainer.querySelector('a');
          const snippetEl = fsContainer.querySelector('.YyVvo, .di3YZe, .ilUpNd.H66NU.aSRlid, .H66NU');
          if (titleEl && aEl && snippetEl) {
            featuredSnippet = {
              title: cleanText(titleEl.textContent),
              link: decodeGoogleLink(aEl.getAttribute('href') || ''),
              snippet: cleanText(snippetEl.textContent)
            };
          }
        }

        // 3. EXTRACT KNOWLEDGE PANEL
        let knowledgePanel: any = null;
        const kpContainer = document.querySelector('.kp-sidebar, #rhs, .rhs, .kp-blk, .KPDxwd');
        if (kpContainer) {
          const titleEl = kpContainer.querySelector('[role="heading"], .HPwZGe, .DU1Mzb, .kno-ecr-pt');
          const subtitleEl = kpContainer.querySelector('.wDYxhc.mod, .kno-meta, .bV3FIe');
          const descEl = kpContainer.querySelector('[data-attrid="kc:/common/topic:description"], .kno-rdesc span');
          const sourceEl = kpContainer.querySelector('.kno-rdesc a');

          const attributes: any[] = [];
          kpContainer.querySelectorAll('.rVusM, .zVnNfc, .Lrzca').forEach(el => {
            const label = el.querySelector('.wDYxhc, .zVnNfc, .fl');
            const val = el.querySelector('.Lrzca, .kno-fv');
            if (label && val) {
              attributes.push({
                label: cleanText(label.textContent),
                value: cleanText(val.textContent)
              });
            }
          });

          if (titleEl) {
            knowledgePanel = {
              title: cleanText(titleEl.textContent),
              subtitle: subtitleEl ? cleanText(subtitleEl.textContent) : undefined,
              description: descEl ? cleanText(descEl.textContent) : undefined,
              sourceUrl: sourceEl ? decodeGoogleLink(sourceEl.getAttribute('href') || '') : undefined,
              attributes: attributes.length > 0 ? attributes : undefined
            };
          }
        }

        // 4. EXTRACT PEOPLE ALSO ASK (PAA)
        const peopleAlsoAsk: any[] = [];
        document.querySelectorAll('[jsname="N760bc"], [data-init-query], .cb76Od, .E3VR9e').forEach((el) => {
          const headerText = cleanText(el.textContent);
          if (headerText.toLowerCase().includes('people also ask') || headerText.toLowerCase().includes('questions')) {
            const parent = el.parentElement;
            if (parent) {
              parent.querySelectorAll('[jsname="j96n9e"], .ask-xpd, .mB12ae').forEach((qEl) => {
                const qText = cleanText(qEl.textContent);
                if (qText) {
                  peopleAlsoAsk.push({ question: qText });
                }
              });
            }
          }
        });

        // 5. EXTRACT DIRECT ANSWERS (WEATHER, TRANSLATION, DICTIONARY, CALCULATOR)
        let directAnswer: any = null;

        // Calculator
        const calcResult = document.querySelector('#cwos');
        if (calcResult) {
          const calcEq = document.querySelector('.rN17ge, .SwHCTb');
          directAnswer = {
            type: 'calculator',
            answer: cleanText(calcResult.textContent),
            details: calcEq ? cleanText(calcEq.textContent) : undefined
          };
        }

        // Weather
        const weatherTemp = document.querySelector('#wob_tm, .vk_bk.wob-t');
        if (weatherTemp && !directAnswer) {
          const tempVal = weatherTemp.textContent ? weatherTemp.textContent.trim() : '';

          let unit = '°F';
          const tempUnitEl = document.querySelector('#wob_temp_unit, [aria-selected="true"] .wob_t, .wob_t[style*="inline"]');
          if (tempUnitEl && tempUnitEl.textContent?.includes('C')) {
            unit = '°C';
          } else {
            const weatherContainer = weatherTemp.closest('.Ww4FFb, .vk_c, .card');
            if (weatherContainer && weatherContainer.textContent?.includes('°C') && !weatherContainer.textContent?.includes('°F')) {
              unit = '°C';
            }
          }

          const locEl = document.querySelector('.BBwThe, #wob_loc, .wob_loc');
          let location = locEl ? cleanText(locEl.textContent) : 'Tokyo';
          if (location === 'Weather') {
            const cityEl = document.querySelector('.BBwThe, .wob_loc');
            if (cityEl) location = cleanText(cityEl.textContent);
          }

          const condEl = document.querySelector('#wob_dc, .wob_dc, #wob_dts + span');
          const condition = condEl ? cleanText(condEl.textContent) : '';

          const precipEl = document.querySelector('#wob_pp');
          const humidEl = document.querySelector('#wob_hm');
          const windEl = document.querySelector('#wob_ws');

          let details = `${location} - ${condition}`;
          if (precipEl || humidEl || windEl) {
            details += ` (Precipitation: ${precipEl ? precipEl.textContent : 'N/A'}, Humidity: ${humidEl ? humidEl.textContent : 'N/A'}, Wind: ${windEl ? windEl.textContent : 'N/A'})`;
          }

          directAnswer = {
            type: 'weather',
            answer: `${tempVal}${unit}`,
            details: details
          };
        }

        // Time / Timezone
        const timeVal = document.querySelector('.vk_bk, .gsrt.vk_bk');
        if (timeVal && timeVal.textContent && timeVal.textContent.includes(':') && !directAnswer) {
          const timeZone = document.querySelector('.vk_gy, .vk_sh');
          directAnswer = {
            type: 'time',
            answer: cleanText(timeVal.textContent),
            details: timeZone ? cleanText(timeZone.textContent) : undefined
          };
        }

        // Dictionary
        const dictWord = document.querySelector('.v9i61e, [data-attrid="kc:/common/dictionary:definition"]');
        if (dictWord && !directAnswer) {
          const dictMean = document.querySelector('.LT1Tbd, .lr_dct_ent');
          directAnswer = {
            type: 'dictionary',
            answer: cleanText(dictWord.textContent),
            details: dictMean ? cleanText(dictMean.textContent) : undefined
          };
        }

        // Translation
        const transTarget = document.querySelector('#tw-target-text');
        if (transTarget && !directAnswer) {
          const transSource = document.querySelector('#tw-source-text-ta');
          directAnswer = {
            type: 'translation',
            answer: cleanText(transTarget.textContent),
            details: transSource ? cleanText((transSource as any).value || transSource.textContent) : undefined
          };
        }

        // 6. EXTRACT NEWS / STORIES
        const news: any[] = [];
        document.querySelectorAll('g-card, .YLwUee, .WlydOe, .MjjYud').forEach((el) => {
          const a = el.querySelector('a');
          const isNews = el.querySelector('.OSrXXb, .LfNcr') || el.querySelector('.NUnG9b');
          if (a && isNews) {
            const h3 = el.querySelector('[role="heading"], h3, .mCBkyc, .nD1swb');
            const srcEl = el.querySelector('.NUnG9b, .h1UuCc, .ap3aec');
            const timeEl = el.querySelector('.OSrXXb, .LfNcr');
            if (h3 && a.getAttribute('href')) {
              const link = decodeGoogleLink(a.getAttribute('href'));
              if (link && !seen.has(link)) {
                news.push({
                  title: cleanText(h3.textContent),
                  source: srcEl ? cleanText(srcEl.textContent) : '',
                  time: timeEl ? cleanText(timeEl.textContent) : '',
                  link
                });
              }
            }
          }
        });

        // 7. EXTRACT VIDEOS
        const videos: any[] = [];
        document.querySelectorAll('g-card, .V2Ew3b, .z3HNeb, .MjjYud, [data-curl], .EyBRub, .hIwNKe').forEach((el) => {
          let a = el.querySelector('a');
          if (!a && el.tagName === 'A') {
            a = el as HTMLAnchorElement;
          }
          const href = a ? (a.getAttribute('href') || '') : '';
          const dataCurl = el.getAttribute('data-curl') || '';
          const targetLink = decodeGoogleLink(dataCurl || href);
          if (!targetLink) return;

          const isVideo = targetLink.includes('youtube.com') || targetLink.includes('vimeo.com') || targetLink.includes('tiktok.com') || el.querySelector('.vP1iyc') || el.querySelector('.J1y2db') || el.getAttribute('data-pubr') || el.querySelector('.O1KYjb');
          if (isVideo && !seen.has(targetLink)) {
            seen.add(targetLink);
            const h3 = el.querySelector('h3, h1, .mCBkyc, .z3HNeb, .WQWxe');
            const durEl = el.querySelector('.vP1iyc, .J1y2db, .ZwRhJd');
            const uploadedEl = el.querySelector('.ap3aec, .PCvXJ, .PLq9Je, .DKsccc');

            let duration = durEl ? cleanText(durEl.textContent) : undefined;
            let uploadedAt = uploadedEl ? cleanText(uploadedEl.textContent) : undefined;

            const ariaEl = el.querySelector('[aria-label]');
            if (ariaEl) {
              const label = ariaEl.getAttribute('aria-label') || '';
              if (label && !duration) {
                const durationMatch = label.match(/(\d+:\d+)/);
                if (durationMatch) duration = durationMatch[1];
              }
            }

            const pubr = el.getAttribute('data-pubr');
            const srcEl = el.querySelector('.NUnG9b, .h1UuCc, .ap3aec, .sjVJQd, .KrMNbf');
            const source = pubr ? cleanText(pubr) : (srcEl ? cleanText(srcEl.textContent) : (targetLink.includes('youtube.com') ? 'YouTube' : 'Video'));

            if (h3) {
              videos.push({
                title: cleanText(h3.textContent),
                source,
                duration,
                uploadedAt,
                link: targetLink
              });
            }
          }
        });

        // 8. EXTRACT IMAGES (both JS-enabled and JS-disabled, inline & traditional)
        const images: any[] = [];
        const seenImages = new Set<string>();

        // Method A: Script-based high-res image extraction for images category
        if (categoryParamInner === 'images') {
          const pageHtml = document.documentElement.innerHTML;
          const imgRegex = /\[0\s*,\s*"([^"]+)"\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g;
          let imgMatch;
          while ((imgMatch = imgRegex.exec(pageHtml)) !== null) {
            const imgUrl = imgMatch[5].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
            if (seenImages.has(imgUrl)) continue;
            seenImages.add(imgUrl);

            const nextChunk = pageHtml.substring(imgMatch.index, imgMatch.index + 2000);
            const metaRegex = /"2003"\s*:\s*\[\s*null\s*,\s*"[^"]*"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/;
            const metaMatch = metaRegex.exec(nextChunk);

            let sourceUrl = '';
            let title = '';
            if (metaMatch) {
              sourceUrl = metaMatch[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
              title = metaMatch[2];
            }

            images.push({
              alt: cleanText(title || 'Image'),
              sourceUrl: sourceUrl || imgUrl,
              imageUrl: imgUrl
            });
          }
        }

        // Method B: DOM-based fallback if no script-based images are found or for non-images category
        if (images.length === 0) {
          // Method B.1: CSS class-independent heading-based images block parsing
          document.querySelectorAll('span, div, h2, h3').forEach((el) => {
            const text = el.textContent ? el.textContent.trim() : '';
            if (text === 'Images') {
              let parent = el.parentElement;
              while (parent && parent.querySelectorAll('img').length < 3 && parent.tagName !== 'BODY') {
                parent = parent.parentElement;
              }
              if (parent) {
                parent.querySelectorAll('img').forEach((img) => {
                  const alt = img.getAttribute('alt') || '';
                  const imageUrl = img.getAttribute('src') || '';
                  if (!imageUrl) return;

                  let p = img.parentElement;
                  let sourceUrl = '';
                  while (p && p !== parent && p.tagName !== 'BODY') {
                    const anchor = p.querySelector('a');
                    if (anchor) {
                      const href = anchor.getAttribute('href') || '';
                      if (href) {
                        sourceUrl = decodeGoogleLink(href);
                        break;
                      }
                    }
                    p = p.parentElement;
                  }

                  if (sourceUrl && !seenImages.has(imageUrl)) {
                    seenImages.add(imageUrl);
                    images.push({
                      alt: cleanText(alt),
                      sourceUrl,
                      imageUrl
                    });
                  }
                });
              }
            }
          });

          // Method B.2: Traditional imgres fallback links (e.g. JS-disabled/fallback page)
          document.querySelectorAll('a[href*="imgres"]').forEach((el) => {
            const img = el.querySelector('img');
            const alt = img ? img.getAttribute('alt') || '' : '';
            const href = el.getAttribute('href') || '';

            let sourceUrl = '';
            let imageUrl = '';
            try {
              const urlObj = new URL(href, window.location.href);
              imageUrl = urlObj.searchParams.get('imgurl') || '';
              sourceUrl = urlObj.searchParams.get('imgrefurl') || '';
            } catch (e) {
              const imgMatch = href.match(/[?&]imgurl=([^&]+)/);
              const refMatch = href.match(/[?&]imgrefurl=([^&]+)/);
              if (imgMatch) imageUrl = decodeURIComponent(imgMatch[1]);
              if (refMatch) sourceUrl = decodeURIComponent(refMatch[1]);
            }

            sourceUrl = decodeGoogleLink(sourceUrl || href);
            if (sourceUrl && imageUrl && !seenImages.has(imageUrl)) {
              seenImages.add(imageUrl);
              images.push({
                alt: cleanText(alt),
                sourceUrl,
                imageUrl: imageUrl || undefined
              });
            }
          });
        }


        // 9. EXTRACT SHOPPING RESULTS
        const shopping: any[] = [];
        document.querySelectorAll('.sh-dgr__grid-cell, .sh-dlr__list-result, .sh-np__click-target').forEach((el) => {
          const a = el.querySelector('a');
          const titleEl = el.querySelector('.Xj73ed, .tAxDx');
          const priceEl = el.querySelector('.a8c5bc, .h1N1A');
          const merchantEl = el.querySelector('.I5cFL, .mB12ae');
          if (a && titleEl && priceEl) {
            const link = decodeGoogleLink(a.getAttribute('href') || '');
            shopping.push({
              title: cleanText(titleEl.textContent),
              price: cleanText(priceEl.textContent),
              merchant: merchantEl ? cleanText(merchantEl.textContent) : '',
              link
            });
          }
        });

        // 10. EXTRACT LOCAL RESULTS
        const localResults: any[] = [];
        document.querySelectorAll('.rllt__card, .Vk2fBe').forEach((el) => {
          const titleEl = el.querySelector('[role="heading"], .dbg0pd');
          const ratingEl = el.querySelector('.rGhul, .Yw7Nj');
          const reviewsEl = el.querySelector('.R3Y11e');
          const addressEl = el.querySelector('.Lrzca');
          const a = el.querySelector('a');
          if (titleEl) {
            localResults.push({
              title: cleanText(titleEl.textContent),
              rating: ratingEl ? cleanText(ratingEl.textContent) : undefined,
              reviewsCount: reviewsEl ? cleanText(reviewsEl.textContent) : undefined,
              address: addressEl ? cleanText(addressEl.textContent) : undefined,
              link: a ? decodeGoogleLink(a.getAttribute('href') || '') : undefined
            });
          }
        });

        // 11. EXTRACT RELATED SEARCHES
        const relatedSearches: string[] = [];
        document.querySelectorAll('a.title, .s75cqc, .card-section a, .E3VR9e').forEach((el) => {
          const headerText = cleanText(el.textContent);
          if (headerText.toLowerCase().includes('people also search') || headerText.toLowerCase().includes('related search')) {
            let parent = el.parentElement;
            while (parent && !parent.className.includes('Gx5Zad') && parent.tagName !== 'BODY') {
              parent = parent.parentElement;
            }
            if (parent) {
              parent.querySelectorAll('a').forEach((aEl) => {
                const text = cleanText(aEl.textContent);
                if (text && text !== headerText && !relatedSearches.includes(text)) {
                  relatedSearches.push(text);
                }
              });
            }
          }
        });

        // 12. EXTRACT ORGANIC SEARCH RESULTS
        if (categoryParamInner === 'all') {
          document.querySelectorAll('h3').forEach((h3) => {
            const headingText = cleanText(h3.textContent);
            if (
              headingText === 'Search Results' ||
              headingText === 'Weather Result' ||
              headingText === 'Web results' ||
              headingText === 'Featured snippet' ||
              headingText.includes('People also ask')
            ) {
              return;
            }

            const container = h3.closest('.g, .MjjYud, .xpd, .Gx5Zad') || h3.parentElement;
            if (!container) return;

            const a = container.tagName === 'A' ? container : container.querySelector('a');
            if (!a) return;

            const rawLink = a.getAttribute('href') || '';
            const link = decodeGoogleLink(rawLink);

            if (!link || link.includes('google.com') || link.includes('sorry/index') || seen.has(link)) return;
            seen.add(link);

            let snippet = '';
            for (const s of ['.VwiC3b', '.lEBKkf', '.lyLwlc', '[data-sncf]', '.IsZvec', '.ilUpNd.H66NU.aSRlid', '.H66NU', '.lQigmf']) {
              const sn = container.querySelector(s);
              if (sn && sn.textContent && sn.textContent.trim()) {
                const txt = cleanText(sn.textContent);
                if (txt !== cleanText(h3.textContent) && !txt.includes('www.') && txt.length > 10) {
                  snippet = txt;
                  break;
                }
              }
            }

            if (!snippet) {
              container.querySelectorAll('div, span, p').forEach((sub) => {
                if (!snippet && sub.className && sub.textContent && sub.children.length === 0) {
                  const txt = cleanText(sub.textContent);
                  if (txt.length > 30 && !txt.includes('www.') && txt !== cleanText(h3.textContent)) {
                    snippet = txt;
                  }
                }
              });
            }

            const dispEl = container.querySelector('.TbwUpd, .byrV5b, .ylgVCe, .BamJPe');
            const displayedLink = dispEl ? cleanText(dispEl.textContent) : undefined;

            const favEl = container.querySelector('img.H1u2de, img.XNo5Ab, .wb41ae img');
            const favicon = favEl ? favEl.getAttribute('src') || undefined : undefined;

            organic.push({
              title: cleanText(h3.textContent),
              link,
              snippet,
              displayedLink,
              favicon
            });
          });
        }

        // Strict Category Tab Filtering / Isolation
        const cleanOrganic = categoryParamInner === 'all' ? organic : [];
        const cleanNews = categoryParamInner === 'news' ? news : [];
        const cleanVideos = categoryParamInner === 'videos' ? videos : [];
        const cleanImages = categoryParamInner === 'images' ? images : [];
        const cleanShopping = categoryParamInner === 'shopping' ? shopping : [];

        return {
          captcha: false,
          organic: cleanOrganic,
          aiResponse: categoryParamInner === 'all' ? aiResponse : null,
          featuredSnippet: categoryParamInner === 'all' ? featuredSnippet : null,
          knowledgePanel: categoryParamInner === 'all' ? knowledgePanel : null,
          peopleAlsoAsk: categoryParamInner === 'all' ? peopleAlsoAsk : undefined,
          directAnswer: categoryParamInner === 'all' ? directAnswer : null,
          news: cleanNews.length > 0 ? cleanNews : undefined,
          videos: cleanVideos.length > 0 ? cleanVideos : undefined,
          images: cleanImages.length > 0 ? cleanImages : undefined,
          shopping: cleanShopping.length > 0 ? cleanShopping : undefined,
          relatedSearches: categoryParamInner === 'all' ? relatedSearches : undefined,
          localResults: categoryParamInner === 'all' && localResults.length > 0 ? localResults : undefined
        };
      }, categoryParam);

      const hasCategoryResults = (res: any) => {
        if (categoryKey === 'all') return res.organic && res.organic.length > 0;
        if (categoryKey === 'images') return res.images && res.images.length > 0;
        if (categoryKey === 'videos') return res.videos && res.videos.length > 0;
        if (categoryKey === 'news') return res.news && res.news.length > 0;
        if (categoryKey === 'shopping') return res.shopping && res.shopping.length > 0;
        return false;
      };

      let results = await extractResults(categoryKey);

      if (!results.captcha && !hasCategoryResults(results)) {
        // Fallback: wait up to 500ms for a CAPTCHA/sorry form to load if results are empty
        await page
          .waitForSelector('form[action="/sorry/index"], #captcha, .g-recaptcha', {
            timeout: 100,
          })
          .catch(() => { /* timeout is fine */ });

        results = await extractResults(categoryKey);
      }

      // If organic results are less than 10, try re-parsing once immediately
      if (!results.captcha && categoryKey === 'all' && results.organic.length < 10) {
        results = await extractResults(categoryKey);
      }

      if (results.captcha) {
        pageErrored = true;
        throw new Error('CAPTCHA_DETECTED');
      }

      workerCdpFailures.delete(browser.workerId);

      // Offload clearing cookies in the background so it doesn't block returning the search results
      if (page) {
        (async () => {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        })();
      }

      let cleanAiResponse: string | null = null;
      if (results.aiResponse) {
        const $ = cheerio.load(results.aiResponse);
        $('script, style').remove();
        cleanAiResponse = $.text()
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .join('\n');
      }

      // Warm up the other active browsers in the background since this query succeeded
      const otherBrowsers = activeBrowsers.filter(b => b.workerId !== browser.workerId);
      for (const b of otherBrowsers) {
        if (!isWorkerCached(b.workerId)) {
          warmupWorker(b);
        }
      }

      return {
        organic: results.organic,
        aiResponse: cleanAiResponse,
        featuredSnippet: results.featuredSnippet,
        knowledgePanel: results.knowledgePanel,
        peopleAlsoAsk: results.peopleAlsoAsk,
        directAnswer: results.directAnswer,
        news: results.news,
        videos: results.videos,
        images: results.images,
        shopping: results.shopping,
        relatedSearches: results.relatedSearches,
        localResults: results.localResults
      };

    } catch (e) {
      const msg = (e as Error).message;
      browserPool.recordFailure();

      if (msg.includes('CAPTCHA_DETECTED')) {
        browserPool.recordCaptcha(browser.workerId);
        if (page) {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        }
        pageErrored = true;
      } else if ([
        'CDP_UNREACHABLE', 'NO_WS_URL', 'WebSocket', 'Connection closed'
      ].some((k) => msg.includes(k)) || (conn && !conn.browserConn.isConnected())) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      } else {
        pageErrored = true;
      }
    } finally {
      if (conn && page) {
        // Reuse pages used for Search, discard if page errored
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    browserPool.restartWorkers();
  }

  return null;
}

/**
 * Execute a DuckDuckGo web search via a remote browser from the pool.
 *
 * Uses the DuckDuckGo HTML endpoint (html.duckduckgo.com/html/) which renders
 * server-side and is far less aggressive with bot-blocking than Google.
 * Same pool/acquire/release mechanics as searchViaPool.
 */
export async function searchDuckViaPool(
  text: string,
  pageNumber: number = 1,
): Promise<{
  organic: Array<{ title: string; link: string; snippet: string }>;
  aiResponse: string | null;
  relatedSearches?: string[];
} | null> {
  const activeBrowsers = browserPool.getActive();
  const maxAttempts = Math.max(1, activeBrowsers.length);
  const hasAnyCached = activeBrowsers.some(b => isWorkerCached(b.workerId));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    // Skip uncached browsers if cached ones are available, warming them up in background
    if (hasAnyCached && !isWorkerCached(browser.workerId)) {
      warmupWorker(browser);
      continue;
    }

    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    try {
      const acquired = await acquirePage(browser, true);
      conn = acquired.conn;
      page = acquired.page;

      try {
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.detach();
      } catch { /* ignore */ }

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.evaluateOnNewDocument(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch { }
      });

      // ── Request interception: block heavy assets ───────────────────────
      page.removeAllListeners('request');
      await page.setRequestInterception(true);
      page.on('request', async (req: any) => {
        try {
          if (req.isInterceptResolutionHandled()) return;
          const type = req.resourceType();
          if (type === 'document') {
            try { await req.continue(); } catch { }
            return;
          }
          if (['font', 'media', 'websocket', 'manifest', 'other'].includes(type)) {
            try { await req.abort(); } catch { }
            return;
          }
          try { await req.continue(); } catch { }
        } catch { /* ignore */ }
      });

      // DDG html endpoint paginates with the `s` offset param (~30 results/page)
      const offset = (pageNumber - 1) * 30;
      const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(text)}${offset > 0 ? `&s=${offset}` : ''}`;

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((err: any) => {
        console.warn(`[BrowserPool] DuckDuckGo navigation notice for ${targetUrl}:`, err.message);
      });

      await page
        .waitForSelector('.result, .no-results, #links_wrapper', { timeout: 5000 })
        .catch(() => { });

      const results = await page.evaluate(() => {
        const organic: Array<{ title: string; link: string; snippet: string }> = [];
        const seen = new Set<string>();

        // DDG wraps outbound links: //duckduckgo.com/l/?uddg=<url-encoded>
        const decodeDuckLink = (href: string | null): string => {
          if (!href) return '';
          try {
            const u = new URL(href, location.origin);
            const uddg = u.searchParams.get('uddg');
            if (uddg) return decodeURIComponent(uddg);
          } catch { }
          return href;
        };

        document.querySelectorAll('.result').forEach(el => {
          const a = el.querySelector('.result__a');
          if (!a) return;
          const link = decodeDuckLink(a.getAttribute('href'));
          if (!link || seen.has(link)) return;
          seen.add(link);
          const sn = el.querySelector('.result__snippet');
          organic.push({
            title: (a.textContent || '').trim(),
            link,
            snippet: sn ? (sn.textContent || '').trim() : '',
          });
        });

        const relatedSearches: string[] = [];
        document.querySelectorAll('.did-you-mean a, #did_you_mean a').forEach(a => {
          const t = (a.textContent || '').trim();
          if (t) relatedSearches.push(t);
        });

        return { organic, relatedSearches };
      });

      if (results.organic.length === 0) {
        console.warn(`[BrowserPool] DuckDuckGo returned no results on ${browser.workerId}. Trying next browser...`);
        pageErrored = true;
        continue;
      }

      workerCdpFailures.delete(browser.workerId);

      return {
        organic: results.organic,
        aiResponse: null,
        relatedSearches: results.relatedSearches.length > 0 ? results.relatedSearches : undefined,
      };

    } catch (e) {
      const msg = (e as Error).message;
      console.warn(`[BrowserPool] DuckDuckGo search failed on ${browser.workerId}: ${msg}`);
      browserPool.recordFailure();

      if ([
        'CDP_UNREACHABLE', 'NO_WS_URL', 'WebSocket', 'Connection closed'
      ].some((k) => msg.includes(k)) || (conn && !conn.browserConn.isConnected())) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      } else {
        pageErrored = true;
      }
    } finally {
      if (conn && page) {
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    browserPool.restartWorkers();
  }

  return null;
}

export interface IndeedJobResult {
  jk: string;
  title: string;
  company: string;
  location: string;
  salary: string;
  snippet: string;
  description?: string;
  url: string;
  source: 'indeed';
  scrapedAt: string;
}

/**
 * Execute an Indeed job search via a remote browser from the pool.
 */
export async function searchIndeedViaPool(
  query: string,
  location: string = '',
  pageNumber: number = 1,
): Promise<{ jobs: IndeedJobResult[]; captcha?: boolean } | null> {
  const activeBrowsers = browserPool.getActive();
  const maxAttempts = Math.max(1, activeBrowsers.length);
  const hasAnyCached = activeBrowsers.some(b => isWorkerCached(b.workerId));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    // Skip uncached browsers if cached ones are available, warming them up in background
    if (hasAnyCached && !isWorkerCached(browser.workerId)) {
      warmupWorker(browser);
      continue;
    }

    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    try {
      const acquired = await acquirePage(browser, true);
      conn = acquired.conn;
      page = acquired.page;

      try {
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.detach();
      } catch { /* ignore */ }

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.evaluateOnNewDocument(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch { }
      });

      // Request interception: block heavy assets
      page.removeAllListeners('request');
      await page.setRequestInterception(true);
      page.on('request', async (req: any) => {
        try {
          if (req.isInterceptResolutionHandled()) return;
          const type = req.resourceType();
          const url = req.url();

          if (type === 'document') {
            try { await req.continue(); } catch { }
            return;
          }

          if (['font', 'media', 'websocket', 'manifest', 'other'].includes(type)) {
            try { await req.abort(); } catch { }
            return;
          }

          if (
            url.includes('google-analytics') ||
            url.includes('doubleclick') ||
            url.includes('facebook') ||
            url.includes('datadog')
          ) {
            try { await req.abort(); } catch { }
            return;
          }

          try { await req.continue(); } catch { }
        } catch {
          try { await req.continue(); } catch { }
        }
      });

      const startParam = (pageNumber - 1) * 10;
      const targetUrl = `https://www.indeed.com/jobs?q=${encodeURIComponent(query)}&l=${encodeURIComponent(location)}&start=${startParam}`;

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch((err: any) => {
        console.warn(`[BrowserPool] Indeed navigation notice for ${targetUrl}:`, err.message);
      });

      await page.waitForSelector('.job_seen_beacon, td.resultContent, div.cardOutline, #challenge-stage, .g-recaptcha, form[action*="/sorry/"]', { timeout: 4000 }).catch(() => { });

      const extracted = await page.evaluate((queryParam: string, locationParam: string) => {
        const titleText = document.title || '';
        if (
          titleText.toLowerCase().includes('just a moment') ||
          titleText.toLowerCase().includes('human verification') ||
          document.querySelector('#challenge-stage, .g-recaptcha, form[action*="/sorry/"], #captcha')
        ) {
          return { captcha: true, jobs: [] as any[] };
        }

        const jobs: any[] = [];
        const seenJk = new Set<string>();

        const cleanText = (str: string | null) => str ? str.trim().replace(/\s+/g, ' ') : '';

        const cards = document.querySelectorAll('.job_seen_beacon, td.resultContent, div.cardOutline, li.css-5lfssb, .jobsearch-ResultsList > li');

        cards.forEach((card) => {
          let jk = '';
          const titleEl = card.querySelector('h2.jobTitle, a[data-jk], [data-jk]');
          const linkEl = card.querySelector('a[data-jk], h2.jobTitle a, a[id^="job_"]');

          if (linkEl) {
            jk = linkEl.getAttribute('data-jk') || '';
            if (!jk) {
              const href = linkEl.getAttribute('href') || '';
              const match = href.match(/[?&]jk=([^&]+)/);
              if (match) jk = match[1];
            }
          }
          if (!jk && titleEl) {
            jk = titleEl.getAttribute('data-jk') || '';
          }

          if (!jk) {
            const cardJk = card.getAttribute('data-jk');
            if (cardJk) jk = cardJk;
          }

          if (!jk || seenJk.has(jk)) return;
          seenJk.add(jk);

          const jobTitleStr = titleEl ? cleanText(titleEl.textContent) : queryParam;
          const companyEl = card.querySelector('[data-testid="company-name"], .companyName, .company_location .companyName');
          const companyStr = companyEl ? cleanText(companyEl.textContent) : 'Unknown Company';

          const locEl = card.querySelector('[data-testid="text-location"], .companyLocation, .location');
          const locStr = locEl ? cleanText(locEl.textContent) : locationParam;

          const salEl = card.querySelector('[data-testid="attribute_snippet_testid"], .metadata.salary-snippet-container, .salary-snippet, .estimated-salary');
          const salaryStr = salEl ? cleanText(salEl.textContent) : '';

          const snipEl = card.querySelector('.job-snippet, [data-testid="under-link-snippet"], .under-link-snippet');
          const snippetStr = snipEl ? cleanText(snipEl.textContent) : '';

          jobs.push({
            jk,
            title: jobTitleStr,
            company: companyStr,
            location: locStr,
            salary: salaryStr,
            snippet: snippetStr,
            description: snippetStr,
            url: `https://www.indeed.com/viewjob?jk=${jk}`,
            source: 'indeed',
            scrapedAt: new Date().toISOString()
          });
        });

        return { captcha: false, jobs };
      }, query, location);

      if (extracted.captcha) {
        pageErrored = true;
        throw new Error('CAPTCHA_DETECTED');
      }

      workerCdpFailures.delete(browser.workerId);

      if (page) {
        (async () => {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        })();
      }

      const otherBrowsers = activeBrowsers.filter(b => b.workerId !== browser.workerId);
      for (const b of otherBrowsers) {
        if (!isWorkerCached(b.workerId)) {
          warmupWorker(b);
        }
      }

      return { jobs: extracted.jobs };

    } catch (e) {
      const msg = (e as Error).message;
      browserPool.recordFailure();

      if (msg.includes('CAPTCHA_DETECTED')) {
        browserPool.recordCaptcha(browser.workerId);
        if (page) {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        }
        pageErrored = true;
      } else if ([
        'CDP_UNREACHABLE', 'NO_WS_URL', 'WebSocket', 'Connection closed'
      ].some((k) => msg.includes(k)) || (conn && !conn.browserConn.isConnected())) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      } else {
        pageErrored = true;
      }
    } finally {
      if (conn && page) {
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    browserPool.restartWorkers();
  }

  return null;
}


/**
 * Execute an Instagram GraphQL query via a remote browser from the pool.
 */
export async function queryInstagramGraphQLViaPool(
  postData: any,
  headers: any,
): Promise<any | null> {
  const activeBrowsers = browserPool.getActive();
  const maxAttempts = Math.max(1, activeBrowsers.length);
  const hasAnyCached = activeBrowsers.some(b => isWorkerCached(b.workerId));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    // Skip uncached browsers if we have cached ones, warming them up in background
    if (hasAnyCached && !isWorkerCached(browser.workerId)) {
      warmupWorker(browser);
      continue;
    }

    let conn: WorkerConnection | null = null;
    let page: any = null;
    let pageErrored = false;

    try {
      const acquired = await acquirePage(browser, true);
      conn = acquired.conn;
      page = acquired.page;

      // ── Request interception: block heavy assets to load robots.txt fast ──
      page.removeAllListeners('request');
      await page.setRequestInterception(true);
      page.on('request', async (req: any) => {
        try {
          if (req.isInterceptResolutionHandled()) return;
          const type = req.resourceType();
          if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
            await req.abort();
          } else {
            await req.continue();
          }
        } catch {
          try { await req.continue(); } catch { }
        }
      });

      // 1. Set the cookies
      const cookieStr = headers.cookie || '';
      if (cookieStr) {
        const cookies = cookieStr.split(';').map((c: string) => {
          const [name, ...valParts] = c.trim().split('=');
          const value = valParts.join('=');
          return {
            name,
            value,
            domain: '.instagram.com',
            path: '/',
            secure: true,
          };
        }).filter((c: any) => c.name && c.value);

        if (cookies.length > 0) {
          await page.setCookie(...cookies);
        }
      }

      // 2. Navigate to robots.txt to set origin to www.instagram.com (only if not already on instagram.com)
      const currentUrl = page.url() || '';
      if (!currentUrl.includes('instagram.com')) {
        await page.goto('https://www.instagram.com/robots.txt', {
          waitUntil: 'domcontentloaded',
          timeout: 10000,
        });
      }

      // Disable request interception so that the fetch call is not routed back to Puppeteer host,
      // saving extra websocket round-trip latency.
      await page.setRequestInterception(false);

      // 3. Prepare body and fetch headers for execution inside the browser
      const body = new URLSearchParams(postData).toString();
      const fetchHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        const lowerK = k.toLowerCase();
        if (!['cookie', 'referer', 'user-agent', 'content-length', 'host'].includes(lowerK)) {
          fetchHeaders[k] = v as string;
        }
      }

      // 4. Perform fetch in page context
      const json = await page.evaluate(async (url: string, fetchBody: string, fetchHeaders: any) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: fetchHeaders,
          body: fetchBody,
        });
        if (!res.ok) {
          throw new Error(`HTTP_${res.status}`);
        }
        return res.json();
      }, 'https://www.instagram.com/graphql/query', body, fetchHeaders);

      // Warm up the other active browsers in the background since this query succeeded
      const otherBrowsers = activeBrowsers.filter(b => b.workerId !== browser.workerId);
      for (const b of otherBrowsers) {
        if (!isWorkerCached(b.workerId)) {
          warmupWorker(b);
        }
      }

      return json;

    } catch (e) {
      const msg = (e as Error).message;
      console.error(
        `❌ Instagram GraphQL query failed via ${browser.workerId} (attempt ${attempt + 1}/${maxAttempts}):`,
        msg,
      );
      browserPool.recordFailure();

      if (msg.includes('HTTP_403') || msg.includes('HTTP_429')) {
        browserPool.recordCaptcha(browser.workerId);
        if (page) {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        }
        pageErrored = true;
      } else if ([
        'CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket', 'Connection closed'
      ].some((k) => msg.includes(k)) || (conn && !conn.browserConn.isConnected())) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          console.warn(`🔥 Worker ${browser.workerId} hit ${cdpFails} consecutive CDP failures — evicting.`);
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      } else {
        pageErrored = true;
      }
    } finally {
      if (conn && page) {
        await releasePage(conn, page, pageErrored);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    console.error('🚨 All pool workers are dead or none available. Triggering emergency worker restart...');
    browserPool.restartWorkers();
  }

  return null;
}

/** Execute an Instagram GraphQL query through a worker's lightweight HTTP proxy. */
export async function queryInstagramGraphQLViaProxy(
  postData: Record<string, string>,
  headers: Record<string, string>,
): Promise<any> {
  const result = await browserPool.proxyRequest(undefined, {
    url: 'https://www.instagram.com/graphql/query',
    method: 'POST',
    headers,
    body: new URLSearchParams(postData).toString(),
    timeout: 10,
  });

  if (result.status_code < 200 || result.status_code >= 300) {
    throw new Error(`Instagram proxy GraphQL HTTP ${result.status_code}`);
  }

  return JSON.parse(result.body);
}

