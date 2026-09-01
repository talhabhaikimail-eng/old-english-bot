/**
 * @file google-places-search.ts
 * @description Google Maps Places scraper via puppeteer through the remote browser pool.
 *
 * Scrapes the maximum amount of data available from Google Maps place cards:
 *  - name, address, coordinates (from URL data params !3d/!4d), phone, website
 *  - rating, review count, price level, category/type
 *  - hours (open/closed status + today's hours string)
 *  - description / editorial summary
 *  - place_id (hex pair 0x…:0x… from URL)
 *
 * Pagination: Google Maps uses infinite scroll on [role="feed"].
 * We scroll the panel until stable (no new cards), then slice the requested
 * "page" window out of the full card list (20 cards per logical page).
 */

import { browserPool } from './browser-pool';
import {
  acquirePage,
  releasePage,
  invalidateWorkerConnection,
  workerCdpFailures,
  MAX_WORKER_CDP_FAILURES,
} from './page-pool';
import type { WorkerConnection } from './page-pool';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlaceResult {
  /** Display name of the place */
  name: string;
  /** Formatted address */
  address: string | null;
  /** Phone number */
  phone: string | null;
  /** Official website */
  website: string | null;
  /** Star rating (1–5) */
  rating: number | null;
  /** Total number of reviews */
  reviewCount: number | null;
  /** Price level string, e.g. '$10–20', '$$', '$$$' or null */
  priceLevel: string | null;
  /** Primary category / type */
  category: string | null;
  /** Open now status */
  openNow: boolean | null;
  /** Today's hours / status string, e.g. "Open · Closes 5 AM" */
  todaysHours: string | null;
  /** Full open/closed status line including phone/extra info */
  openStatus: string | null;
  /** Full weekly schedule keyed by day name (deep-scrape only) */
  weeklyHours: Record<string, string> | null;
  /** Editorial summary / description */
  description: string | null;
  /** Number of photos listed (deep-scrape only) */
  photosCount: number | null;
  /** Google Maps URL for the place */
  mapsUrl: string | null;
  /** place_id hex pair extracted from URL data params (e.g. "0x89c25...") */
  placeId: string | null;
  /** Latitude extracted from URL data params */
  lat: number | null;
  /** Longitude extracted from URL data params */
  lng: number | null;
  /** Whether popular times section exists (deep-scrape only) */
  hasPopularTimes: boolean;
  /** Claimed/verified status (deep-scrape only) */
  isClaimed: boolean | null;
  /** Amenities / attributes listed (deep-scrape only) */
  amenities: string[];
  /** "People also search for" related place names (deep-scrape only) */
  relatedPlaces: string[];
  /** First review snippet if visible on the card */
  firstReview: string | null;
}

export interface PlaceReview {
  authorName: string | null;
  authorAvatar: string | null;
  rating: number | null;
  relativeTime: string | null;
  text: string | null;
}

export interface PlaceDetailResult extends PlaceResult {
  plusCode: string | null;
  attributes: string[];
  services: string[];
  reviews: PlaceReview[];
  images: string[];
}

export interface PlacesSearchResult {
  query: string;
  page: number;
  results: PlaceResult[];
  hasNextPage: boolean;
  totalResultsText: string | null;
}

/** Emitted progressively during a streaming search. */
export interface PlacesBatchEvent {
  type: 'batch' | 'progress' | 'done' | 'error';
  /** New cards in this batch (type=batch) */
  cards?: PlaceResult[];
  /** Running total of cards scraped so far */
  total?: number;
  /** Scroll round info */
  round?: number;
  /** Whether the feed has been fully loaded */
  reachedEnd?: boolean;
  /** Error message (type=error) */
  message?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Logical results per page (Google Maps shows ~20 per scroll batch). */
const PAGE_SIZE = 20;

/** User-agent that matches the tested scratch-test environment. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// In-browser scraping helpers
// NOTE: These functions run inside page.evaluate — no Node.js APIs allowed.
// ---------------------------------------------------------------------------

/**
 * Extract all visible card data from the [role="feed"] panel.
 *
 * DOM observations (verified 2026-05-10):
 *  - Scroll container: [role="feed"]  (aria-label="Results for …")
 *  - Card:            [role="article"].Nv2PK
 *  - Name:            .qBF1Pd
 *  - Place link:      a.hfpxzc  (href contains !3d<lat>!4d<lng> and hex placeId)
 *  - Rating row:      .AJB7ye → innerText "4.6(6,999) · $20–70"
 *  - Info rows:       .W4Efsd children of the outer .W4Efsd container
 *    - Row 0: "Category · ♿ · Address"
 *    - Row 1: "Editorial description"   (optional)
 *    - Row 2: "Open · Closes 5 AM"     (optional, coloured span inside)
 *  - Open status detected by inline color style:
 *    green rgba(25,134,57) = open | red rgba(220,54,46) = closed
 */
function extractAllCards(): Array<{
  name: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  category: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
  openNow: boolean | null;
  todaysHours: string | null;
  openStatus: string | null;
  mapsUrl: string | null;
  lat: number | null;
  lng: number | null;
  placeId: string | null;
  firstReview: string | null;
}> {
  const results: ReturnType<typeof extractAllCards> = [];
  const seen = new Set<string>();

  document.querySelectorAll<HTMLElement>('[role="article"]').forEach((card) => {
    // ── Name ────────────────────────────────────────────────────────────
    const name = card.querySelector<HTMLElement>('.qBF1Pd')?.innerText?.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);

    // ── Link → lat/lng/placeId ──────────────────────────────────────────
    const linkEl = card.querySelector<HTMLAnchorElement>('a.hfpxzc, a[href*="maps/place"]');
    const mapsUrl = linkEl?.href || null;

    // Coords encoded as !3d<lat>!4d<lng> in the data= query param
    const latM = mapsUrl?.match(/!3d(-?\d+\.\d+)/);
    const lngM = mapsUrl?.match(/!4d(-?\d+\.\d+)/);
    const lat = latM ? parseFloat(latM[1]) : null;
    const lng = lngM ? parseFloat(lngM[1]) : null;

    // place_id: hex address pair "0x…:0x…"
    const pidM = mapsUrl?.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
    const placeId = pidM ? pidM[0] : null;

    // ── Rating + Reviews ──────────────────────────────────────────────────
    const ratingRowText = card.querySelector<HTMLElement>('.AJB7ye')?.textContent?.trim() ?? '';
    const ratingEl = card.querySelector('.MW4etd');
    const rating = ratingEl ? parseFloat(ratingEl.textContent?.trim() || '') : null;

    const reviewEl = card.querySelector('.UY7F9');
    const reviewText = reviewEl ? reviewEl.textContent?.replace(/[()]/g, '').trim() : '';
    const reviewCount = reviewText ? parseInt(reviewText.replace(/,/g, ''), 10) : null;

    // Price: anything after last · e.g. "$20–70" or "$$"
    const priceM = ratingRowText.match(/·\s*(\$[^\s·]+)/);
    const priceLevel = priceM ? priceM[1] : null;

    // ── Info rows: children .W4Efsd of the outer .W4Efsd block ─────────
    // The outer W4Efsd wraps the info section (not the rating row).
    // We pick the W4Efsd that is a parent of another W4Efsd (i.e. the outer one).
    let outerW4: HTMLElement | null = null;
    card.querySelectorAll<HTMLElement>('.W4Efsd').forEach((el) => {
      if (!outerW4 && el.querySelector('.W4Efsd')) {
        outerW4 = el;
      }
    });

    const infoRows = outerW4
      ? Array.from((outerW4 as HTMLElement).querySelectorAll<HTMLElement>(':scope > .W4Efsd'))
      : [];

    // Row 0: "Category · ♿ · Address"
    const row0Text = infoRows[0]?.textContent?.trim() ?? '';
    const row0Parts = row0Text.split('·').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
    const category = row0Parts[0] || null;
    const address = row0Parts.length > 1 ? row0Parts[row0Parts.length - 1] || null : null;

    // ── Phone ───────────────────────────────────────────────────────────
    const phone = card.querySelector('.UsdlK')?.textContent?.trim() || null;

    // ── Website ─────────────────────────────────────────────────────────
    const websiteEl = card.querySelector<HTMLAnchorElement>('a[data-value="Website"], a[aria-label*="website"], a[aria-label*="Website"]');
    const website = websiteEl?.href || null;

    // ── First Review ────────────────────────────────────────────────────
    const reviewRaw = card.querySelector('.ah5Ghc, .Ahnjwc')?.textContent?.trim() || null;
    const firstReview = reviewRaw ? reviewRaw.replace(/^["'“”]|["'“”]$/g, '').trim() : null;

    // Remaining rows: description and open-status
    let description: string | null = null;
    let openStatus: string | null = null;
    let openNow: boolean | null = null;

    for (let i = 1; i < infoRows.length; i++) {
      const rowText = infoRows[i]?.innerText?.trim() ?? '';
      const coloredSpan = infoRows[i]?.querySelector<HTMLElement>('span[style*="color"]');
      const colorStyle = coloredSpan?.getAttribute('style') ?? '';

      if (coloredSpan && (colorStyle.includes('25,134,57') || colorStyle.includes('220,54,46'))) {
        // Open/closed row detected via inline color style
        openStatus = rowText;
        openNow = colorStyle.includes('25,134,57'); // green = open
      } else if (rowText && !description) {
        description = rowText;
      }
    }

    results.push({
      name,
      rating,
      reviewCount,
      priceLevel,
      category,
      address,
      phone,
      website,
      description,
      openNow,
      todaysHours: openStatus,
      openStatus,
      mapsUrl,
      lat,
      lng,
      placeId,
      firstReview,
    });
  });

  return results;
}

/**
 * Extract all available data from an open Google Maps place side-panel.
 * Runs INSIDE the browser via page.evaluate — no Node.js APIs allowed.
 */
function extractPlaceFromPanel(): PlaceResult {
  function text(sel: string, root: Document | Element = document): string | null {
    const el = root.querySelector(sel);
    return el ? (el as HTMLElement).innerText?.trim() || null : null;
  }

  const name =
    text('h1.DUwDvf') ||
    text('[data-attrid="title"] span') ||
    text('h1') ||
    'Unknown';

  const address =
    text('[data-item-id="address"] .Io6YTe') ||
    text('button[data-item-id="address"] .fontBodyMedium') ||
    text('.rogA2c .Io6YTe') ||
    null;

  const phone =
    text('[data-item-id^="phone:tel:"] .Io6YTe') ||
    text('button[data-tooltip="Copy phone number"] .Io6YTe') ||
    null;

  const websiteEl =
    document.querySelector<HTMLAnchorElement>('a[data-item-id="authority"]') ||
    document.querySelector<HTMLAnchorElement>('[data-item-id="website"] a');
  const website = websiteEl?.href || null;

  const ratingText =
    text('.F7nice span[aria-hidden="true"]') ||
    text('.ceNzKf span[aria-hidden="true"]');
  const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

  const reviewText =
    text('.F7nice span[aria-label*="review"]') ||
    text('[aria-label*="reviews"]') ||
    text('.HHrUdb') ||
    null;
  const reviewMatch = reviewText?.replace(/,/g, '').match(/[\d.]+/);
  const reviewCount = reviewMatch ? parseInt(reviewMatch[0], 10) : null;

  const priceEl = document.querySelector('[aria-label*="Price: "], [aria-label*="price"]');
  const priceLabel = priceEl?.getAttribute('aria-label') || '';
  const priceMatch = priceLabel.match(/\$+/);
  const priceLevel = priceMatch ? priceMatch[0] : null;

  const category =
    text('.DkEaL') ||
    text('button.DkEaL') ||
    text('[jsaction*="category"] span') ||
    null;

  const openSpan = document.querySelector<HTMLElement>('.eXlsfd span, .o0Svhf span, .dHvSe span');
  const openText = openSpan?.innerText?.toLowerCase() || '';
  let openNow: boolean | null = null;
  if (openText.includes('open')) openNow = true;
  else if (openText.includes('closed')) openNow = false;

  const todaysHours =
    text('.t39EBf .G8aQO') ||
    text('[data-item-id="oh"] .fontBodyMedium') ||
    null;

  const weeklyHours: Record<string, string> = {};
  document.querySelectorAll('.t39EBf table tr, [jsaction*="hours"] tr').forEach((row) => {
    const day = (row.querySelector('td:first-child') as HTMLElement)?.innerText?.trim();
    const hrs = (row.querySelector('td:last-child') as HTMLElement)?.innerText?.trim();
    if (day && hrs) weeklyHours[day] = hrs;
  });

  const description =
    text('.PYvSYb') ||
    text('[data-attrid="description"] .iKbnQ') ||
    text('.xt2b0d .WeS02d') ||
    null;

  const photoCountEl = document.querySelector('[aria-label*="photo"], [aria-label*="Photo"]');
  const photoMatch = photoCountEl?.getAttribute('aria-label')?.match(/[\d,]+/);
  const photosCount = photoMatch ? parseInt(photoMatch[0].replace(/,/g, ''), 10) : null;

  const mapsUrl = window.location.href;
  // Try URL-encoded place path first, then data param hex pair
  const pidM = mapsUrl.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
  const placeId = pidM ? pidM[0] : null;
  const latM = mapsUrl.match(/!3d(-?\d+\.\d+)/);
  const lngM = mapsUrl.match(/!4d(-?\d+\.\d+)/);
  const lat = latM ? parseFloat(latM[1]) : null;
  const lng = lngM ? parseFloat(lngM[1]) : null;

  const hasPopularTimes =
    !!document.querySelector('.g2BVhd, [jsdata*="popular"], [aria-label*="Popular times"]');

  const isClaimed =
    !!document.querySelector('[aria-label*="Claimed"], [aria-label*="verified owner"]');

  const amenities: string[] = [];
  document
    .querySelectorAll('.E0DTEd .CK16pd, .LTs0Rc .CK16pd, [jsaction*="amenity"] .CK16pd')
    .forEach((el) => {
      const t = (el as HTMLElement).innerText?.trim();
      if (t) amenities.push(t);
    });

  const relatedPlaces: string[] = [];
  document.querySelectorAll('.Hk4XGb .qBF1Pd, .YhemCb .qBF1Pd').forEach((el) => {
    const t = (el as HTMLElement).innerText?.trim();
    if (t) relatedPlaces.push(t);
  });

  return {
    name,
    address,
    phone,
    website,
    rating: isNaN(rating as number) ? null : rating,
    reviewCount: isNaN(reviewCount as number) ? null : reviewCount,
    priceLevel,
    category,
    openNow,
    todaysHours,
    openStatus: todaysHours,
    weeklyHours: Object.keys(weeklyHours).length ? weeklyHours : null,
    description,
    photosCount,
    mapsUrl,
    placeId,
    lat,
    lng,
    hasPopularTimes,
    isClaimed,
    amenities,
    relatedPlaces,
    firstReview: null,
  };
}

// ---------------------------------------------------------------------------
// Scroll helper — mirrors the working scratch-test.ts technique
// ---------------------------------------------------------------------------

/**
 * Scrolls the feed (or its real scrollable ancestor) until no new cards appear
 * for MAX_RETRIES × 100 ms.  Runs entirely inside the browser in a single
 * page.evaluate call — no 2.5 s round-trip waits.
 *
 * Dynamic scroller resolution (same as scratch-test.ts):
 *  1. Probe [role="feed"].scrollTop — if it moves, feed is the scroller.
 *  2. Walk up the DOM for an overflow-y: scroll/auto ancestor.
 *  3. Fall back to document.documentElement.
 */
async function scrollFeedForMore(
  page: any,
): Promise<{ loaded: number; total: number; reachedEnd: boolean }> {
  let prevHeight = 0;
  let stableRounds = 0;
  let scrollRound = 0;
  const maxRounds = 30;
  const waitMs = 2000;

  while (scrollRound < maxRounds) {
    const { count, scrollHeight } = await page.evaluate(() => {
      const el = document.querySelector('[role="main"]')?.firstElementChild?.firstElementChild as HTMLElement;
      if (!el) return { count: 0, scrollHeight: 0 };
      
      // Scroll to the bottom
      el.scrollTop = el.scrollHeight;
      
      return {
        count: document.querySelectorAll('[role="article"]').length,
        scrollHeight: el.scrollHeight
      };
    });

    if (scrollHeight === prevHeight) {
      stableRounds++;
      if (stableRounds >= 3) {
        break;
      }
    } else {
      stableRounds = 0;
    }

    prevHeight = scrollHeight;
    scrollRound++;
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const finalCount = await page.evaluate(() => document.querySelectorAll('[role="article"]').length);
  return { loaded: finalCount, total: finalCount, reachedEnd: true };
}


// ---------------------------------------------------------------------------
// Main exported search function
// ---------------------------------------------------------------------------

/**
 * Search Google Maps Places via the remote browser pool.
 *
 * @param query      - Search query, e.g. "pizza restaurants in Manhattan"
 * @param pageNumber - 1-based logical page (20 results per page).
 *                     Page 1 = items 0–19, page 2 = items 20–39, etc.
 *                     We always load the full scroll-list then slice.
 * @param deepScrape - If true, click into each card for full detail.
 *                     If false (default), only card-level data returned.
 */
export async function searchPlacesViaPool(
  query: string,
  pageNumber = 1,
  deepScrape = false,
): Promise<PlacesSearchResult | null> {
  const maxAttempts = Math.max(1, browserPool.getActive().length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    let conn: WorkerConnection | null = null;
    let page: any = null;

    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;

      await page.setUserAgent(USER_AGENT);

      // ── Navigate ──────────────────────────────────────────────────────
      const encodedQuery = encodeURIComponent(query);
      await page.goto(
        `https://www.google.com/maps/search/${encodedQuery}`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );

      await page
        .waitForSelector('[role="feed"]', { timeout: 15_000 })
        .catch(() => { /* proceed even if it times out */ });

      // ── Captcha check ─────────────────────────────────────────────────
      const hasCaptcha: boolean = await page.evaluate(() =>
        !!document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha'),
      );
      if (hasCaptcha) throw new Error('CAPTCHA_DETECTED');

      // ── Scroll the feed until we have enough cards for this page ─────
      // Early-exit once we've loaded (pageNumber × PAGE_SIZE) cards so the
      // browser worker isn't held for 50s just to serve page 1.
      // Pass Infinity when deep-scraping so all handles are available.
      const neededCards = deepScrape ? Infinity : pageNumber * PAGE_SIZE;
      const scrollResult = await scrollFeedForMore(page);
      console.log(`📋 Places: loaded ${scrollResult.total} cards for "${query}" (needed ≥${neededCards})`);

      // ── Extract cards ─────────────────────────────────────────────────
      if (!deepScrape) {
        const allCardData = await page.evaluate(extractAllCards);

        // Slice logical page window
        const start = (pageNumber - 1) * PAGE_SIZE;
        const end = start + PAGE_SIZE;
        const pageSlice = allCardData.slice(start, end);
        const hasNextPage = allCardData.length > end;

        const results: PlaceResult[] = pageSlice.map(
          (c: ReturnType<typeof extractAllCards>[number]) => ({
            ...c,
            phone: c.phone || null,
            website: c.website || null,
            firstReview: c.firstReview || null,
            weeklyHours: null,
            photosCount: null,
            hasPopularTimes: false,
            isClaimed: null,
            amenities: [],
            relatedPlaces: [],
          }),
        );

        workerCdpFailures.delete(browser.workerId);
        return {
          query,
          page: pageNumber,
          results,
          hasNextPage,
          totalResultsText: `${scrollResult.total} places loaded`,
        };
      }

      // ── Deep scrape: click into each card ────────────────────────────
      const allHandles: any[] = await page.$$('[role="article"]');
      const start = (pageNumber - 1) * PAGE_SIZE;
      const handles = allHandles.slice(start, start + PAGE_SIZE);
      const hasNextPage = allHandles.length > start + PAGE_SIZE;
      const results: PlaceResult[] = [];

      for (const handle of handles) {
        try {
          await handle.click();
          await page
            .waitForSelector('h1.DUwDvf, h1, .DUwDvf', { timeout: 8_000 })
            .catch(() => { /* ignore */ });

          // Try to expand hours
          await page.evaluate(() => {
            const btn = document.querySelector<HTMLElement>(
              'button[data-item-id="oh"], [aria-label*="hours"], .t39EBf button',
            );
            if (btn) btn.click();
          });
          await new Promise<void>((r) => setTimeout(r, 600));

          const placeData = await page.evaluate(extractPlaceFromPanel);
          results.push(placeData);
        } catch (e) {
          console.warn('⚠️ Failed to extract place detail:', (e as Error).message);
        }

        await page
          .goBack({ waitUntil: 'domcontentloaded', timeout: 12_000 })
          .catch(() => { /* ignore */ });
        await page
          .waitForSelector('[role="article"]', { timeout: 8_000 })
          .catch(() => { /* ignore */ });
      }

      workerCdpFailures.delete(browser.workerId);
      return {
        query,
        page: pageNumber,
        results,
        hasNextPage,
        totalResultsText: `${scrollResult.total} places loaded`,
      };

    } catch (e) {
      const msg = (e as Error).message;
      console.error(
        `❌ Places search failed via ${browser.workerId} (attempt ${attempt + 1}/${maxAttempts}):`,
        msg,
      );
      browserPool.recordFailure();

      if (msg.includes('CAPTCHA_DETECTED')) {
        if (page) {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        }
        console.warn(`🔥 CAPTCHA detected on ${browser.workerId} — killing action job run ${browser.runId || 'N/A'} & spawning replacement worker...`);
        browserPool.recordCaptcha(browser.workerId);
        page = null;
      } else if (['CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket'].some((k) => msg.includes(k))) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          console.warn(
            `🔥 Worker ${browser.workerId} hit ${cdpFails} consecutive CDP failures — evicting.`,
          );
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      }
    } finally {
      if (conn && page) {
        // Always discard pages used for Maps — Google Maps navigation leaves
        // the page in a state (detached frames, stale request interception)
        // that causes "Detached Frame" errors on reuse.
        await releasePage(conn, page, /* discard= */ true);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    console.error('🚨 All pool workers are dead. Triggering emergency worker restart...');
    browserPool.restartWorkers();
  }

  return null;
}

/**
 * Streaming variant: emits PlaceResult batches in real-time as each scroll
 * round loads new cards.
 *
 * Uses the SAME scroll logic as test-places-search.ts — one scroll per round,
 * wait SCROLL_WAIT_MS, check afterCount vs prevCount. After each round that
 * reveals new cards, extract them and emit a 'batch' event immediately.
 * Terminates on 2 consecutive stable rounds or MAX_SCROLL_ROUNDS.
 */
export async function searchPlacesStream(
  query: string,
  onEvent: (event: PlacesBatchEvent) => void,
): Promise<void> {
  const maxAttempts = Math.max(1, browserPool.getActive().length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    let conn: WorkerConnection | null = null;
    let page: any = null;

    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;

      await page.setUserAgent(USER_AGENT);

      // ── Request interception: block heavy assets (mirrors scratch-test) ──
      // Blocking image/font/media makes Google Maps render and lazy-load
      // cards 3-4× faster, so the scroll loop loads far more results within
      // the same 3 s retry window. Stylesheets are intentionally allowed so
      // the feed layout height is computed correctly for scrollTop to work.
      // We clear stale listeners first (recycled pages keep old handlers).
      page.removeAllListeners('request');
      await page.setRequestInterception(true);
      page.on('request', (req: any) => {
        // Guard against double-fire from any remaining internal handlers.
        if (req.isInterceptResolutionHandled()) return;
        if (['image', 'font', 'media'].includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // ── Navigate ──────────────────────────────────────────────────────
      const encodedQuery = encodeURIComponent(query);
      await page.goto(
        `https://www.google.com/maps/search/${encodedQuery}`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );

      await page
        .waitForSelector('[role="feed"]', { timeout: 15_000 })
        .catch(() => { /* proceed anyway */ });

      const hasCaptcha: boolean = await page.evaluate(() =>
        !!document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha'),
      );
      if (hasCaptcha) throw new Error('CAPTCHA_DETECTED');

      // ── Expose a Node.js callback into the browser context ────────────
      // page.exposeFunction bridges browser → Node so the scroll loop can
      // push newly-discovered cards in real-time without waiting for the
      // entire scroll to finish.
      // exposeFunction throws if the name is already registered on the CDP
      // session (recycled page), so we swallow that specific error.
      const seenNames = new Set<string>();
      let round = 0;

      await page.exposeFunction(
        '__emitCards',
        (rawCards: ReturnType<typeof extractAllCards>) => {
          const newCards: PlaceResult[] = rawCards
            .filter((c) => !seenNames.has(c.name))
            .map((c) => ({
              ...c,
              phone: c.phone || null,
              website: c.website || null,
              firstReview: c.firstReview || null,
              weeklyHours: null,
              photosCount: null,
              hasPopularTimes: false,
              isClaimed: null,
              amenities: [],
              relatedPlaces: [],
            }));

          if (newCards.length === 0) return;

          newCards.forEach((c) => seenNames.add(c.name));
          round++;
          onEvent({ type: 'batch', cards: newCards, total: seenNames.size, round });
        },
      ).catch((err: Error) => {
        // On recycled pages the binding already exists on the CDP session — safe to ignore.
        if (!err.message.includes('already exists') && !err.message.includes('already been registered')) throw err;
      });

      // ── Scroll + stream entirely in-browser ───────────────────────────
      // The feed is scrolled directly (scratch-test approach).
      // Every time the article count grows, extractAllCards() is called for
      // the new slice and __emitCards() bridges the data to Node.js.
      // MAX_RETRIES × 100 ms = 3 s max stable wait before declaring end.
      await page.evaluate(async (extractFn: string) => {
        // Reconstruct extractAllCards inside the browser from its serialised source.
        // eslint-disable-next-line no-new-func
        const extractAllCardsBrowser = new Function(`return (${extractFn})`)() as () => unknown[];

        const feed = document.querySelector('[role="main"]')?.firstElementChild?.firstElementChild as HTMLElement;
        if (!feed) return;

        const emitCards = (window as any).__emitCards as (cards: unknown[]) => void;

        let previousCount = 0;
        let retries = 0;
        const MAX_RETRIES = 30;

        while (true) {
          const cards = document.querySelectorAll('[role="article"]');
          const currentCount = cards.length;

          if (currentCount > previousCount) {
            // New cards loaded — extract and stream them immediately.
            // We pass ALL cards each time; Node deduplicates via seenNames.
            const extracted = (extractAllCardsBrowser as unknown as () => unknown[])();
            await emitCards(extracted);
            retries = 0;
            previousCount = currentCount;
          } else {
            retries++;
            if (retries >= MAX_RETRIES) break;
          }

          feed.scrollTop = feed.scrollHeight;
          await new Promise((r) => setTimeout(r, 100));
        }
      }, extractAllCards.toString());

      onEvent({ type: 'done', total: seenNames.size, reachedEnd: true });
      workerCdpFailures.delete(browser.workerId);
      return;

    } catch (e) {
      const msg = (e as Error).message;
      const isTransportError = [
        'CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket',
        'Connection closed', 'Detached Frame', 'Target closed', 'Session closed',
      ].some((k) => msg.includes(k));

      console.error(
        `❌ Places stream failed via ${browser.workerId} (attempt ${attempt + 1}/${maxAttempts}): ${msg}`,
      );
      browserPool.recordFailure();

      if (msg.includes('CAPTCHA_DETECTED')) {
        if (page) {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        }
        console.warn(`⏳ Temporarily evicting ${browser.workerId} for IP cooldown.`);
        browserPool.deregister(browser.workerId);
        page = null;
      } else if (isTransportError) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          console.warn(`🔥 Worker ${browser.workerId} hit ${cdpFails} consecutive transport failures — evicting.`);
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      }

      // Only emit error to API on final attempt
      if (attempt >= maxAttempts - 1) {
        onEvent({ type: 'error', message: msg });
      }

      if (attempt < maxAttempts - 1) continue;

    } finally {
      if (conn && page) {
        await releasePage(conn, page, /* discard= */ true);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Google Search (udm=1) scraper — URL-based pagination
// ---------------------------------------------------------------------------
//
// Target URL pattern:
//   https://www.google.com/search?q=<query>&udm=1&start=<offset>
//
// DOM observations (verified from data.html 2026-05-10):
//   - Card:       [role="article"].Nv2PK  (same as Maps feed view)
//   - Name:       .qBF1Pd
//   - Link:       a.hfpxzc  (href = maps/place/... with !3d/!4d coords)
//   - Rating row: .AJB7ye → e.g. "4.5 stars 25,367 Reviews · $10–20"
//     * Rating value: .MW4etd
//     * Review count: .UY7F9  e.g. "(25,367)"
//   - Info rows:  outer .W4Efsd → direct-child .W4Efsd rows
//     * Row 0: "Category · ♿ · Address"
//     * Row 1: editorial description  (optional)
//     * Row 2: open/closed status with inline color span (optional)
//
// Pagination: each page = 20 results; next page = start += 20.
// hasNextPage is determined by whether Google rendered 20 cards on this page.
// ---------------------------------------------------------------------------

/**
 * Extract all visible place cards from a Google Search `udm=1` result page.
 *
 * Selectors derived from verified HTML (2026-05-10):
 *   - Card container: .w7Dbne  (stable class — no dynamic tsuid_* IDs used)
 *   - Details block:  .rllt__details
 *   - Name:           .OSrXXb span (or .dbg0pd fallback)
 *   - Rating:         .yi40Hd  e.g. "3.8"
 *   - Reviews:        .RDApEe  e.g. "(34)"
 *   - Category:       text after "·" in 2nd child of .rllt__details
 *   - Addr + Phone:   3rd child of .rllt__details — "addr · phone"
 *   - Open status:    4th child — span[style*="color"], green=open
 *   - Amenities:      .BI0Dve > span:first-child
 *   - Place ID:       [role="button"][id^="pv-"] → strip "pv-" prefix
 *
 * NOTE: Runs inside page.evaluate — no Node.js APIs allowed.
 */
function extractGoogleSearchCards(): Array<{
  name: string;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  category: string | null;
  address: string | null;
  phone: string | null;
  description: string | null;
  openNow: boolean | null;
  todaysHours: string | null;
  openStatus: string | null;
  mapsUrl: string | null;
  lat: number | null;
  lng: number | null;
  placeId: string | null;
  amenities: string[];
}> {
  const results: ReturnType<typeof extractGoogleSearchCards> = [];
  const seen = new Set<string>();

  document.querySelectorAll<HTMLElement>('.w7Dbne').forEach((card) => {
    const details = card.querySelector<HTMLElement>('.rllt__details');
    if (!details) return;

    // ── Name (.OSrXXb is the visible name span inside the .dbg0pd heading) ─
    const name = (
      details.querySelector<HTMLElement>('.OSrXXb')?.innerText?.trim() ||
      details.querySelector<HTMLElement>('.dbg0pd')?.innerText?.trim()
    );
    if (!name || seen.has(name)) return;
    seen.add(name);

    // ── Rating (.yi40Hd) and review count (.RDApEe "( 34 )") ─────────────
    const ratingEl = details.querySelector<HTMLElement>('.yi40Hd');
    const rating = ratingEl ? parseFloat(ratingEl.innerText.trim()) : null;

    const reviewEl = details.querySelector<HTMLElement>('.RDApEe');
    const reviewRaw = reviewEl?.innerText?.replace(/[^0-9,]/g, '') ?? '';
    const reviewCount = reviewRaw ? parseInt(reviewRaw.replace(/,/g, ''), 10) : null;

    // ── Children of .rllt__details (by index, not by class) ──────────────
    // [0] .dbg0pd   — name heading
    // [1] div       — "3.8 (34) · Category"
    // [2] div       — "Address · (phone)"
    // [3] div       — "Open · Closes 8 pm"  (optional)
    // [4] .pJ3Ci    — amenities row          (optional)
    const children = Array.from(details.children) as HTMLElement[];

    // Category — last segment after "·" in the rating/category row
    let category: string | null = null;
    const catRow = children[1];
    if (catRow) {
      const parts = (catRow.innerText?.trim() ?? '').split('·').map((s: string) => s.trim()).filter(Boolean);
      const last = parts[parts.length - 1] ?? '';
      // Exclude if it's just a number (rating leaked)
      if (last && !/^\d/.test(last)) category = last;
    }

    // Address and phone — split by "·"
    let address: string | null = null;
    let phone: string | null = null;
    const addrRow = children[2];
    if (addrRow) {
      const parts = (addrRow.innerText?.trim() ?? '').split('·').map((s: string) => s.trim());
      if (parts.length >= 2) {
        address = parts[0] || null;
        const last = parts[parts.length - 1];
        // Phone numbers start with (, +, or a digit
        phone = /^[(+\d]/.test(last) ? last : null;
      } else {
        address = parts[0] || null;
      }
    }

    // Open status — look for the first child that has a colored span
    let openStatus: string | null = null;
    let openNow: boolean | null = null;
    // Scan from index 3 onward (open status can occasionally shift)
    for (let i = 3; i < Math.min(children.length, 5); i++) {
      const row = children[i];
      const colorSpan = row?.querySelector<HTMLElement>('span[style*="color"]');
      if (!colorSpan) continue;
      openStatus = row.innerText?.trim() || null;
      const style = colorSpan.getAttribute('style') ?? '';
      // Green = rgba(109,213,140,...) or rgba(25,134,57,...) = open
      openNow = style.includes('109,213,140') || style.includes('25,134,57');
      break;
    }

    // Place ID — from [role="button"][id^="pv-"]
    // "pv-/g/12mkwhmk2" → placeId = "/g/12mkwhmk2"
    // Uses role attribute (semantic, stable), never tsuid_* IDs
    const btnEl = card.querySelector<HTMLElement>('[role="button"][id^="pv-"]');
    const rawId = btnEl?.id ?? '';
    const placeId = rawId.startsWith('pv-') ? rawId.slice(3) : null;
    const mapsUrl = placeId
      ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`
      : null;

    // Amenities — each .BI0Dve contains label + separator dot
    const amenities: string[] = [];
    card.querySelectorAll<HTMLElement>('.BI0Dve').forEach((el) => {
      const label = el.querySelector<HTMLElement>('span:first-child')?.innerText?.trim();
      if (label) amenities.push(label);
    });

    results.push({
      name,
      rating,
      reviewCount,
      priceLevel: null,
      category,
      address,
      phone,
      description: null,
      openNow,
      todaysHours: openStatus,
      openStatus,
      mapsUrl,
      lat: null,
      lng: null,
      placeId,
      amenities,
    });
  });

  return results;
}


/**
 * Build the Google Search `udm=1` URL for the given query and page.
 */
function buildGoogleSearchUrl(query: string, pageNumber: number): string {
  const start = (pageNumber - 1) * PAGE_SIZE;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=1&start=${start}&hl=en`;
}

/**
 * Scrape a single page of Google Search `?udm=1` results.
 *
 * @param query      - Search query, e.g. "banks in pakistan"
 * @param pageNumber - 1-based page number (20 results per page)
 */
export async function searchViaGoogleSearchUrl(
  query: string,
  pageNumber = 1,
): Promise<PlacesSearchResult | null> {
  const maxAttempts = Math.max(1, browserPool.getActive().length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    let conn: WorkerConnection | null = null;
    let page: any = null;

    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;

      await page.setUserAgent(USER_AGENT);

      // ── Request interception: block heavy assets ───────────────────────
      page.removeAllListeners('request');
      await page.setRequestInterception(true);
      page.on('request', (req: any) => {
        if (req.isInterceptResolutionHandled()) return;
        const type = req.resourceType();
        if (['image', 'font', 'media', 'stylesheet', 'script', 'xhr', 'fetch'].includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // ── Navigate to the correct paginated URL ─────────────────────────
      const url = buildGoogleSearchUrl(query, pageNumber);
      console.log(`🔍 Google Search (udm=1) page ${pageNumber}: ${url}`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // Wait for at least one result card (.w7Dbne is the stable card container)
      await page
        .waitForSelector('.w7Dbne', { timeout: 15_000 })
        .catch(() => { /* proceed even if it times out */ });

      // ── Captcha check ─────────────────────────────────────────────────
      const hasCaptcha: boolean = await page.evaluate(() =>
        !!document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha'),
      );
      if (hasCaptcha) throw new Error('CAPTCHA_DETECTED');

      // ── Extract cards ─────────────────────────────────────────────────
      const rawCards = await page.evaluate(extractGoogleSearchCards);

      console.log(`📋 Google Search (udm=1): found ${rawCards.length} cards on page ${pageNumber}`);

      // hasNextPage: check for Google's "Next" pagination link (#pnnext is stable)
      const hasNextPage: boolean = await page.evaluate(() =>
        !!document.querySelector('#pnnext'),
      );

      const results: PlaceResult[] = rawCards.map(
        (c: ReturnType<typeof extractGoogleSearchCards>[number]) => ({
          name: c.name,
          rating: c.rating,
          reviewCount: c.reviewCount,
          priceLevel: c.priceLevel,
          category: c.category,
          address: c.address,
          phone: c.phone,
          website: null,
          weeklyHours: null,
          photosCount: null,
          hasPopularTimes: false,
          isClaimed: null,
          amenities: c.amenities,
          relatedPlaces: [],
          description: c.description,
          openNow: c.openNow,
          todaysHours: c.todaysHours,
          openStatus: c.openStatus,
          mapsUrl: c.mapsUrl,
          lat: c.lat,
          lng: c.lng,
          placeId: c.placeId,
          firstReview: null,
        }),
      );

      workerCdpFailures.delete(browser.workerId);
      return {
        query,
        page: pageNumber,
        results,
        hasNextPage,
        totalResultsText: `${rawCards.length} results on page ${pageNumber}`,
      };

    } catch (e) {
      const msg = (e as Error).message;
      const isTransportError = [
        'CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket',
        'Connection closed', 'Detached Frame', 'Target closed', 'Session closed',
      ].some((k) => msg.includes(k));

      console.error(
        `❌ Google Search scrape failed via ${browser.workerId} (attempt ${attempt + 1}/${maxAttempts}): ${msg}`,
      );
      browserPool.recordFailure();

      if (msg.includes('CAPTCHA_DETECTED')) {
        if (page) {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        }
        console.warn(`⏳ Temporarily evicting ${browser.workerId} for IP cooldown.`);
        browserPool.deregister(browser.workerId);
        page = null;
      } else if (isTransportError) {
        invalidateWorkerConnection(browser.workerId);
        page = null;

        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);

        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      }

      if (attempt < maxAttempts - 1) continue;

    } finally {
      if (conn && page) {
        await releasePage(conn, page, /* discard= */ true);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    console.error('🚨 All pool workers are dead. Triggering emergency worker restart...');
    browserPool.restartWorkers();
  }

  return null;
}

/**
 * Streaming variant of the Google Search (udm=1) scraper.
 *
 * Iterates pages (start=0, 20, 40, …) up to `maxPages` and emits a 'batch'
 * event after each page. Stops early when a page returns fewer than PAGE_SIZE
 * results (last page) or when `maxPages` is reached.
 *
 * @param query    - Search query
 * @param onEvent  - Callback receiving PlacesBatchEvent
 * @param maxPages - Maximum number of pages to scrape (default: 10 = 200 results)
 */
export async function searchViaGoogleSearchStream(
  query: string,
  onEvent: (event: PlacesBatchEvent) => void,
  maxPages = 40,
): Promise<void> {
  const seenNames = new Set<string>();
  let totalEmitted = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    let pageSuccess = false;

    // Fixed 5 attempts per page; re-query pool each time so newly-registered
    // workers (after a restart) are picked up automatically.
    const MAX_PAGE_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_PAGE_ATTEMPTS; attempt++) {
      // If the pool is empty, wait up to 60 s for workers to come back
      if (browserPool.getActive().length === 0) {
        console.warn(`⏳ No active workers for page ${pageNumber} attempt ${attempt + 1} — waiting 10 s…`);
        await new Promise((r) => setTimeout(r, 10_000));
        if (browserPool.getActive().length === 0) {
          browserPool.restartWorkers();
          await new Promise((r) => setTimeout(r, 15_000));
        }
        if (browserPool.getActive().length === 0) continue;
      }

      const browser = browserPool.getNext();
      if (!browser) {
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }

      let conn: WorkerConnection | null = null;
      let page: any = null;

      try {
        const acquired = await acquirePage(browser);
        conn = acquired.conn;
        page = acquired.page;

        await page.setUserAgent(USER_AGENT);

        // ── Request interception ─────────────────────────────────────────
        page.removeAllListeners('request');
        await page.setRequestInterception(true);
        page.on('request', (req: any) => {
          if (req.isInterceptResolutionHandled()) return;
          const type = req.resourceType();
          if (['image', 'font', 'media', 'stylesheet', 'script', 'xhr', 'fetch'].includes(type)) {
            req.abort();
          } else {
            req.continue();
          }
        });

        // ── Navigate ─────────────────────────────────────────────────────
        const url = buildGoogleSearchUrl(query, pageNumber);
        console.log(`🔍 Google Search stream page ${pageNumber}/${maxPages}: ${url}`);

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

        // Wait for at least one card (.w7Dbne is the stable card container)
        await page
          .waitForSelector('.w7Dbne', { timeout: 15_000 })
          .catch(() => { /* proceed anyway */ });

        // ── Captcha check ─────────────────────────────────────────────────
        const hasCaptcha: boolean = await page.evaluate(() =>
          !!document.querySelector('form[action="/sorry/index"], #captcha, .g-recaptcha'),
        );
        if (hasCaptcha) throw new Error('CAPTCHA_DETECTED');

        // ── Extract cards for this page ───────────────────────────────────
        const rawCards = await page.evaluate(extractGoogleSearchCards);

        const newCards: PlaceResult[] = rawCards
          .filter((c: ReturnType<typeof extractGoogleSearchCards>[number]) => !seenNames.has(c.name))
          .map((c: ReturnType<typeof extractGoogleSearchCards>[number]) => ({
            name: c.name,
            rating: c.rating,
            reviewCount: c.reviewCount,
            priceLevel: c.priceLevel,
            category: c.category,
            address: c.address,
            phone: c.phone,
            website: null,
            weeklyHours: null,
            photosCount: null,
            hasPopularTimes: false,
            isClaimed: null,
            amenities: c.amenities,
            relatedPlaces: [],
            description: c.description,
            openNow: c.openNow,
            todaysHours: c.todaysHours,
            openStatus: c.openStatus,
            mapsUrl: c.mapsUrl,
            lat: c.lat,
            lng: c.lng,
            placeId: c.placeId,
            firstReview: null,
          }));

        newCards.forEach((c) => seenNames.add(c.name));
        totalEmitted += newCards.length;

        if (newCards.length > 0) {
          onEvent({ type: 'batch', cards: newCards, total: totalEmitted, round: pageNumber });
        }

        console.log(`📋 Page ${pageNumber}: +${newCards.length} new cards (total: ${totalEmitted})`);

        workerCdpFailures.delete(browser.workerId);
        pageSuccess = true;

        // If Google has no "Next" link, this is the last page
        const hasNextPage: boolean = await page.evaluate(() =>
          !!document.querySelector('#pnnext'),
        );

        if (!hasNextPage) {
          console.log(`✅ Google Search stream: no #pnnext on page ${pageNumber} — last page`);
          onEvent({ type: 'done', total: totalEmitted, reachedEnd: true });
          return;
        }

        break; // success — proceed to next page

      } catch (e) {
        const msg = (e as Error).message;

        // Treat ALL transport/connection errors uniformly
        const isTransportError = [
          'CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket',
          'Connection closed', 'Detached Frame', 'Target closed', 'Session closed',
        ].some((k) => msg.includes(k));

        console.error(
          `❌ Google Search stream page ${pageNumber} failed via ${browser.workerId} (attempt ${attempt + 1}/${MAX_PAGE_ATTEMPTS}): ${msg}`,
        );

        if (isTransportError) {
          invalidateWorkerConnection(browser.workerId);
          page = null;

          const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
          workerCdpFailures.set(browser.workerId, cdpFails);

          if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
            console.warn(`🔥 Worker ${browser.workerId} hit ${cdpFails} consecutive transport failures — evicting.`);
            workerCdpFailures.delete(browser.workerId);
            browserPool.deregister(browser.workerId);
          }
        }

        browserPool.recordFailure();

        // Only surface error to API on the final attempt — not every retry
        if (attempt === MAX_PAGE_ATTEMPTS - 1) {
          onEvent({ type: 'error', message: `Page ${pageNumber}: all ${MAX_PAGE_ATTEMPTS} attempts failed — ${msg}` });
        }

        // Exponential backoff before next retry (1s, 2s, 4s, 8s, 15s max)
        const backoffMs = Math.min(1_000 * 2 ** attempt, 15_000);
        await new Promise((r) => setTimeout(r, backoffMs));

      } finally {
        if (conn && page) {
          await releasePage(conn, page, /* discard= */ true);
        }
      }
    }

    if (!pageSuccess) {
      console.error(`🚨 Google Search stream: all workers failed on page ${pageNumber}, aborting.`);
      if (browserPool.getActive().length === 0) {
        browserPool.restartWorkers();
      }
      break;
    }
  }

  onEvent({ type: 'done', total: totalEmitted, reachedEnd: false });
}

/**
 * Scrape full place details from a direct Google Maps place URL using the remote browser pool.
 * Performs NO simulated clicks or delayed tab navigation to ensure sub-second performance.
 */
export async function scrapePlaceDetailsViaPool(
  placeUrl: string,
): Promise<PlaceDetailResult | null> {
  const activeBrowsers = browserPool.getActive();
  const maxAttempts = Math.max(1, activeBrowsers.length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const browser = browserPool.getNext();
    if (!browser) break;

    let conn: WorkerConnection | null = null;
    let page: any = null;

    try {
      const acquired = await acquirePage(browser);
      conn = acquired.conn;
      page = acquired.page;

      await page.setUserAgent(USER_AGENT);

      // Fast domcontentloaded navigation
      await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // Check for Captcha / Consent / Block page
      const hasCaptcha: boolean = await page.evaluate(() => {
        const hasForm = !!document.querySelector('form[action*="/sorry/"], #captcha, .g-recaptcha');
        const bodyText = document.body?.innerText || '';
        const isBlocked = bodyText.includes('unusual traffic') || bodyText.includes('Before you continue to Google');
        return hasForm || isBlocked;
      });
      if (hasCaptcha) throw new Error('CAPTCHA_DETECTED');

      // Single, instant evaluate pass — NO simulated mouse clicks or tab delays
      const details = await page.evaluate(() => {
        function text(sel: string, root: Document | Element = document): string | null {
          const el = root.querySelector(sel);
          return el ? (el as HTMLElement).innerText?.trim() || null : null;
        }

        const name = text('h1.DUwDvf') || text('[data-attrid="title"] span') || text('h1');
        if (!name || name === 'Unknown') {
          return null; // Signals CAPTCHA or failure to load place panel
        }

        const ratingText = text('.F7nice span[aria-hidden="true"]') || text('.ceNzKf span[aria-hidden="true"]');
        const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

        const reviewText = text('.F7nice span[aria-label*="review"]') || text('[aria-label*="reviews"]') || text('.HHrUdb');
        const reviewMatch = reviewText?.replace(/,/g, '').match(/[\d.]+/);
        const reviewCount = reviewMatch ? parseInt(reviewMatch[0], 10) : null;

        const priceEl = document.querySelector('[aria-label*="Price: "], [aria-label*="price"]');
        const priceLabel = priceEl?.getAttribute('aria-label') || '';
        const priceMatch = priceLabel.match(/\$+/);
        const priceLevel = priceMatch ? priceMatch[0] : null;

        const category = text('.DkEaL') || text('button.DkEaL') || text('[jsaction*="category"] span') || null;
        const address = text('[data-item-id="address"] .Io6YTe') || text('button[data-item-id="address"] .fontBodyMedium') || text('.rogA2c .Io6YTe') || null;
        const websiteEl = document.querySelector<HTMLAnchorElement>('a[data-item-id="authority"]') || document.querySelector<HTMLAnchorElement>('[data-item-id="website"] a');
        const website = websiteEl?.href || null;
        const phone = text('[data-item-id^="phone:tel:"] .Io6YTe') || text('button[data-tooltip="Copy phone number"] .Io6YTe') || null;
        const plusCode = text('[data-item-id="oloc"] .Io6YTe') || text('button[data-item-id="oloc"]') || null;

        const openSpan = document.querySelector<HTMLElement>('.eXlsfd span, .o0Svhf span, .dHvSe span');
        const openText = openSpan?.innerText?.toLowerCase() || '';
        let openNow: boolean | null = null;
        if (openText.includes('open')) openNow = true;
        else if (openText.includes('closed')) openNow = false;

        const todaysHours = text('.t39EBf .G8aQO') || text('[data-item-id="oh"] .fontBodyMedium') || openSpan?.innerText || null;

        const weeklyHours: Record<string, string> = {};
        document.querySelectorAll('.t39EBf table tr, [jsaction*="hours"] tr').forEach((row) => {
          const day = (row.querySelector('td:first-child') as HTMLElement)?.innerText?.trim();
          const hrs = (row.querySelector('td:last-child') as HTMLElement)?.innerText?.trim();
          if (day && hrs) weeklyHours[day] = hrs;
        });

        const description = text('.PYvSYb') || text('[data-attrid="description"] .iKbnQ') || text('.xt2b0d .WeS02d') || null;

        const photoCountEl = document.querySelector('[aria-label*="photo"], [aria-label*="Photo"]');
        const photoMatch = photoCountEl?.getAttribute('aria-label')?.match(/[\d,]+/);
        const photosCount = photoMatch ? parseInt(photoMatch[0].replace(/,/g, ''), 10) : null;

        const attributes: string[] = [];
        document.querySelectorAll('[data-item-id] .Io6YTe, .E0DTEd .CK16pd, .LTs0Rc .CK16pd, [aria-label*="Identifies as"], [aria-label*="friendly"]').forEach((el) => {
          const t = (el as HTMLElement).innerText?.trim() || el.getAttribute('aria-label')?.trim();
          if (t && !attributes.includes(t) && t !== address && t !== phone && t !== plusCode) {
            attributes.push(t);
          }
        });

        const services: string[] = [];
        document.querySelectorAll('[data-item-id="service_list"] .Io6YTe, [jsaction*="service"] span').forEach((el) => {
          const t = (el as HTMLElement).innerText?.trim();
          if (t && !services.includes(t)) services.push(t);
        });

        const images: string[] = [];
        document.querySelectorAll('img[src*="ggpht"], img[src*="googleusercontent"], button img').forEach((img) => {
          const src = (img as HTMLImageElement).src;
          if (src && !images.includes(src) && !src.includes('avatar') && !src.includes('cleardot')) {
            images.push(src);
          }
        });

        const reviews: Array<{ authorName: string | null; authorAvatar: string | null; rating: number | null; relativeTime: string | null; text: string | null }> = [];
        document.querySelectorAll('.jJIDff, .MygVt, .W3df2, [data-review-id], .ah5Ghc, .Ahnjwc').forEach((el) => {
          const authorName = text('.d4rG5, .X43Evd', el) || text('.qBF1Pd', el);
          const authorAvatar = el.querySelector<HTMLImageElement>('img.N4f2pd, img')?.src || null;
          const reviewBody = text('.wiI7pd, .MygVt', el) || (el as HTMLElement).innerText?.trim();
          const ratingEl = el.querySelector('[aria-label*="star"], [aria-label*="stars"]');
          const rMatch = ratingEl?.getAttribute('aria-label')?.match(/[\d.]+/);
          const rRating = rMatch ? parseFloat(rMatch[0]) : null;
          const relativeTime = text('.rRecSc, .publish-date', el);

          if (reviewBody && (authorName || rRating)) {
            reviews.push({
              authorName,
              authorAvatar,
              rating: rRating,
              relativeTime,
              text: reviewBody,
            });
          }
        });

        const mapsUrl = window.location.href;
        const pidM = mapsUrl.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
        const placeId = pidM ? pidM[0] : null;
        const latM = mapsUrl.match(/!3d(-?\d+\.\d+)/);
        const lngM = mapsUrl.match(/!4d(-?\d+\.\d+)/);
        const lat = latM ? parseFloat(latM[1]) : null;
        const lng = lngM ? parseFloat(lngM[1]) : null;

        const hasPopularTimes = !!document.querySelector('.g2BVhd, [jsdata*="popular"], [aria-label*="Popular times"]');
        const isClaimed = !!document.querySelector('[aria-label*="Claimed"], [aria-label*="verified owner"]');

        const relatedPlaces: string[] = [];
        document.querySelectorAll('.Hk4XGb .qBF1Pd, .YhemCb .qBF1Pd').forEach((el) => {
          const t = (el as HTMLElement).innerText?.trim();
          if (t && !relatedPlaces.includes(t)) relatedPlaces.push(t);
        });

        return {
          name,
          address,
          phone,
          website,
          rating: isNaN(rating as number) ? null : rating,
          reviewCount: isNaN(reviewCount as number) ? null : reviewCount,
          priceLevel,
          category,
          openNow,
          todaysHours,
          openStatus: todaysHours,
          weeklyHours: Object.keys(weeklyHours).length ? weeklyHours : null,
          description,
          photosCount,
          mapsUrl,
          placeId,
          lat,
          lng,
          hasPopularTimes,
          isClaimed,
          amenities: attributes,
          relatedPlaces,
          firstReview: reviews[0]?.text || null,
          plusCode,
          attributes,
          services,
          images: images.slice(0, 20),
          reviews: reviews.slice(0, 15),
        };
      });

      if (!details) {
        throw new Error('CAPTCHA_DETECTED');
      }

      workerCdpFailures.delete(browser.workerId);
      return details;

    } catch (e) {
      const msg = (e as Error).message;
      console.error(
        `❌ Place detail scrape failed via ${browser.workerId} (attempt ${attempt + 1}/${maxAttempts}): ${msg}`,
      );
      browserPool.recordFailure();

      if (msg.includes('CAPTCHA_DETECTED')) {
        if (page) {
          try {
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.detach();
          } catch { /* ignore */ }
        }
        console.warn(`🔥 CAPTCHA / Bot block detected on ${browser.workerId} — killing action job run ${browser.runId || 'N/A'} & spawning replacement worker...`);
        browserPool.recordCaptcha(browser.workerId);
        page = null;
      } else if (['CDP_UNREACHABLE', 'NO_WS_URL', 'Protocol error', 'WebSocket'].some((k) => msg.includes(k))) {
        invalidateWorkerConnection(browser.workerId);
        page = null;
        const cdpFails = (workerCdpFailures.get(browser.workerId) ?? 0) + 1;
        workerCdpFailures.set(browser.workerId, cdpFails);
        if (cdpFails >= MAX_WORKER_CDP_FAILURES) {
          workerCdpFailures.delete(browser.workerId);
          browserPool.deregister(browser.workerId);
        }
      }
    } finally {
      if (conn && page) {
        await releasePage(conn, page, /* discard= */ true);
      }
    }
  }

  if (browserPool.getActive().length === 0) {
    console.error('🚨 All pool workers are dead or evicted. Triggering worker restart...');
    browserPool.restartWorkers();
  }

  return null;
}

