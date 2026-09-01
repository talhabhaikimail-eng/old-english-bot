import { browserPool } from '../libs/browser-pool';
import { acquirePage, releasePage } from '../libs/page-pool';

async function syncRemotePool() {
  const poolUrl = `${process.env.DASHBOARD_URL || 'http://localhost:3000'}/api/browsers/pool`;
  const headers: Record<string, string> = {
    'accept': '*/*',
  };
  if (process.env.DASHBOARD_AUTH) {
    headers['authorization'] = process.env.DASHBOARD_AUTH;
  }

  try {
    console.log('Fetching remote pool from', poolUrl);
    const res = await fetch(poolUrl, { headers });
    console.log('Fetch status:', res.status, res.statusText);
    const text = await res.text();
    console.log('Raw response:', text);
    const data = JSON.parse(text);
    if (data.browsers && Array.isArray(data.browsers)) {
      for (const b of data.browsers) {
        console.log(`Browser ${b.workerId} status=${b.status} cdpUrl=${b.cdpUrl}`);
        if (b.cdpUrl) {
          browserPool.register(b.workerId, b.cdpUrl, undefined, true, b.apiUrl);
        }
      }
    }
  } catch (err: any) {
    console.error('Remote pool sync error:', err.message);
  }
}

async function testPlaceDetails() {
  await syncRemotePool();

  const activeBrowsers = browserPool.getActive();
  console.log(`Active pool browsers count: ${activeBrowsers.length}`);
  if (activeBrowsers.length === 0) {
    console.error('No active browsers available');
    return;
  }

  const browser = browserPool.getNext();
  if (!browser) return;

  console.log(`Connecting to worker ${browser.workerId} at ${browser.cdpUrl}...`);
  let conn: any = null;
  let page: any = null;

  try {
    const acquired = await acquirePage(browser);
    conn = acquired.conn;
    page = acquired.page;

    const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
    await page.setUserAgent(USER_AGENT);

    const targetUrl = 'https://www.google.com/maps/place/ODL+Dental+Clinic+-+Affordable+Braces+London/data=!4m7!3m6!1s0x48761cbaf2267779:0xf3670fc33b4b3fc8!8m2!3d51.5179802!4d-0.0877295!16s%2Fg%2F1tzgj3f4!19sChIJeXcm8rocdkgRyD9LO8MPZ_M?authuser=0&hl=en&rclk=1';

    const t0 = Date.now();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const tNav = Date.now() - t0;
    console.log(`⚡ Page navigation completed in ${tNav} ms`);

    const tEval0 = Date.now();
    const result = await page.evaluate(() => {
      function text(sel: string, root: Document | Element = document): string | null {
        const el = root.querySelector(sel);
        return el ? (el as HTMLElement).innerText?.trim() || null : null;
      }

      const name = text('h1.DUwDvf') || text('h1') || 'Unknown';
      const ratingText = text('.F7nice span[aria-hidden="true"]') || text('.ceNzKf span[aria-hidden="true"]');
      const rating = ratingText ? parseFloat(ratingText.replace(',', '.')) : null;

      const reviewText = text('.F7nice span[aria-label*="review"]') || text('[aria-label*="reviews"]') || text('.HHrUdb');
      const reviewMatch = reviewText?.replace(/,/g, '').match(/[\d.]+/);
      const reviewCount = reviewMatch ? parseInt(reviewMatch[0], 10) : null;

      const category = text('.DkEaL') || text('button.DkEaL') || null;
      const address = text('[data-item-id="address"] .Io6YTe') || text('.rogA2c .Io6YTe') || null;
      const websiteEl = document.querySelector<HTMLAnchorElement>('a[data-item-id="authority"]') || document.querySelector<HTMLAnchorElement>('[data-item-id="website"] a');
      const website = websiteEl?.href || null;
      const phone = text('[data-item-id^="phone:tel:"] .Io6YTe') || text('button[data-tooltip="Copy phone number"] .Io6YTe') || null;
      const plusCode = text('[data-item-id="oloc"] .Io6YTe') || text('button[data-item-id="oloc"]') || null;

      const openSpan = document.querySelector<HTMLElement>('.eXlsfd span, .o0Svhf span, .dHvSe span');
      const todaysHours = text('.t39EBf .G8aQO') || text('[data-item-id="oh"]') || openSpan?.innerText || null;

      const attributes: string[] = [];
      document.querySelectorAll('[data-item-id] .Io6YTe, .E0DTEd .CK16pd, .LTs0Rc .CK16pd, [aria-label*="Identifies as"], [aria-label*="friendly"]').forEach((el) => {
        const t = (el as HTMLElement).innerText?.trim() || el.getAttribute('aria-label')?.trim();
        if (t && !attributes.includes(t) && t !== address && t !== phone && t !== plusCode) {
          attributes.push(t);
        }
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

      return {
        name,
        rating,
        reviewCount,
        category,
        address,
        website,
        phone,
        plusCode,
        todaysHours,
        attributes,
        images: images.slice(0, 15),
        reviews: reviews.slice(0, 10),
        placeId,
        lat: latM ? parseFloat(latM[1]) : null,
        lng: lngM ? parseFloat(lngM[1]) : null,
      };
    });

    const tEval = Date.now() - tEval0;
    console.log(`⚡ Extraction completed in ${tEval} ms!`);
    console.log('Result:', JSON.stringify(result, null, 2));

  } catch (err: any) {
    console.error('Error during scraping:', err.message);
  } finally {
    if (conn && page) {
      await releasePage(conn, page, true);
    }
  }
}

testPlaceDetails();
