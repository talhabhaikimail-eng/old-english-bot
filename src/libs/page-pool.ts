/**
 * @file page-pool.ts
 * @description Per-worker puppeteer connection + page pool.
 *
 * Manages lazy-initialised, reused puppeteer connections and idle page pools
 * keyed by workerId.  Extracted from browser-pool.ts to keep concerns separate.
 */

import type { RemoteBrowser } from './browser-pool';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerConnection {
  browserConn: any;
  wsUrl: string;
  /** Pages available for re-use (idle). */
  freePages: any[];
  /** Pages currently in use. */
  busyPages: Set<any>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Keyed by workerId. Populated lazily on first use, invalidated on error. */
const workerConnections = new Map<string, WorkerConnection>();
const connectionPromises = new Map<string, Promise<WorkerConnection>>();

/** Per-worker consecutive CDP_UNREACHABLE counter. Reset on success or reconnect. */
export const workerCdpFailures = new Map<string, number>();

/** Max idle pages kept alive per worker. Extra pages are closed. */
const MAX_IDLE_PAGES = 3;

/** After this many consecutive CDP failures a worker is evicted. */
export const MAX_WORKER_CDP_FAILURES = 3;

// ---------------------------------------------------------------------------
// Page acquisition / release
// ---------------------------------------------------------------------------

/**
 * Return a ready page from the worker's pool.
 * Creates a new puppeteer connection + page if none cached yet.
 * Throws on failure so the caller can retry with the next worker.
 */
export async function acquirePage(
  browser: RemoteBrowser,
  failFast = false,
): Promise<{ conn: WorkerConnection; page: any }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteer = require('puppeteer-core');

  let conn = workerConnections.get(browser.workerId);

  if (conn && !conn.browserConn.isConnected()) {
    invalidateWorkerConnection(browser.workerId);
    conn = undefined;
  }

  if (!conn) {
    let connPromise = connectionPromises.get(browser.workerId);
    if (!connPromise) {
      connPromise = (async () => {
        let versionResp: any = null;
        let lastErr: any = null;
        const maxAttempts = failFast ? 1 : 5;
        const timeoutMs = failFast ? 3000 : 10_000;
        const retryDelayMs = 1500;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            versionResp = await fetch(`${browser.cdpUrl}/json/version`, {
              signal: AbortSignal.timeout(timeoutMs),
            });
            if (versionResp.ok) break;
          } catch (err: any) {
            lastErr = err;
          }
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
        if (!versionResp || !versionResp.ok) {
          throw lastErr || new Error('CDP_UNREACHABLE');
        }
        const versionInfo = (await versionResp.json()) as {
          webSocketDebuggerUrl?: string;
        };
        const rawWsUrl = versionInfo.webSocketDebuggerUrl;
        if (!rawWsUrl) throw new Error('NO_WS_URL');

        const tunnelHost = new URL(browser.cdpUrl).host;
        const wsUrl = rawWsUrl.replace(/^ws:\/\/[^/]+/, `wss://${tunnelHost}`);

        const browserConn = await puppeteer.connect({
          browserWSEndpoint: wsUrl,
          defaultViewport: null,
        });

        const newConn = { browserConn, wsUrl, freePages: [], busyPages: new Set() };
        workerConnections.set(browser.workerId, newConn);
        connectionPromises.delete(browser.workerId); // Clear promise on success
        console.log(`🔗 New puppeteer connection cached for ${browser.workerId}`);
        return newConn;
      })();
      connectionPromises.set(browser.workerId, connPromise);
    }

    try {
      conn = await connPromise;
    } catch (err) {
      connectionPromises.delete(browser.workerId);
      throw err;
    }
  }

  // Re-use idle page or open a new one
  let page = conn.freePages.pop();
  let isNew = false;
  if (!page) {
    page = await conn.browserConn.newPage();
    isNew = true;
  }

  // Always reset and set the default request interception handler to avoid leaks/races
  page.removeAllListeners('request');
  await page.setRequestInterception(true);
  page.on('request', (req: any) => {
    if (req.isInterceptResolutionHandled()) return;
    const rt = req.resourceType();
    const u = req.url().toLowerCase();
    if (
      ['image', 'font', 'media', 'stylesheet'].includes(rt) ||
      u.includes('google-analytics.com') ||
      u.includes('doubleclick.net')
    ) {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });

  if (isNew) {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1280, height: 800 });
  }

  conn.busyPages.add(page);
  return { conn, page };
}

/**
 * Return a page back to the idle pool (or close it if the pool is full).
 * Always call this in a finally block.
 */
export async function releasePage(
  conn: WorkerConnection,
  page: any,
  discard = false,
): Promise<void> {
  conn.busyPages.delete(page);
  if (discard || conn.freePages.length >= MAX_IDLE_PAGES) {
    try {
      await page.close();
    } catch {
      /* ignore */
    }
  } else {
    conn.freePages.push(page);
  }
}

/** Invalidate and disconnect a cached worker connection (called on fatal errors). */
export function invalidateWorkerConnection(workerId: string): void {
  connectionPromises.delete(workerId);
  const conn = workerConnections.get(workerId);
  if (!conn) return;
  workerConnections.delete(workerId);
  for (const p of [...conn.freePages, ...conn.busyPages]) {
    try {
      p.close().catch(() => { });
    } catch {
      /* ignore */
    }
  }
  try {
    const res = conn.browserConn.disconnect();
    if (res && res.catch) res.catch(() => { });
  } catch {
    /* ignore */
  }
  console.log(`🗑️ Invalidated puppeteer connection for ${workerId}`);
}

/**
 * Eagerly connect to a worker and cache an idle page.
 * Called when a new worker registers.
 */
export function warmupWorker(browser: RemoteBrowser): void {
  acquirePage(browser)
    .then(({ conn, page }) => {
      releasePage(conn, page).catch(() => { });
    })
    .catch((err) => {
      console.error(`Failed to warmup worker ${browser.workerId}: ${err.message}`);
    });
}

/**
 * Check if a worker currently has a cached and connected browser session.
 */
export function isWorkerCached(workerId: string): boolean {
  const conn = workerConnections.get(workerId);
  return !!conn && conn.browserConn.isConnected();
}
