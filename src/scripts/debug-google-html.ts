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

  const res = await fetch(poolUrl, { headers });
  const data = await res.json();
  if (data.browsers && Array.isArray(data.browsers)) {
    for (const b of data.browsers) {
      if (b.cdpUrl && b.status === 'active') {
        browserPool.register(b.workerId, b.cdpUrl, b.runId, true, b.apiUrl);
      }
    }
  }
}

async function testNoGbvWithInterception() {
  const browser = browserPool.getNext();
  if (!browser) return;
  console.log(`\n--- Testing ${browser.workerId} without &gbv=2 with asset blocking ---`);
  const { conn, page } = await acquirePage(browser, true);

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    page.removeAllListeners('request');
    await page.setRequestInterception(true);
    page.on('request', async (req: any) => {
      try {
        if (req.isInterceptResolutionHandled()) return;
        const type = req.resourceType();
        const url = req.url();
        if (type === 'document') {
          await req.continue();
          return;
        }
        if (['font', 'stylesheet', 'media', 'websocket', 'manifest'].includes(type)) {
          await req.abort();
          return;
        }
        if (url.includes('google-analytics') || url.includes('gen_204') || url.includes('/log?')) {
          await req.abort();
          return;
        }
        await req.continue();
      } catch {}
    });

    const url = 'https://www.google.com/search?q=dentist+in+london&hl=en&num=10';
    console.log(`Navigating to ${url}...`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log(`Response status: ${resp?.status()}`);
    console.log(`Page URL: ${page.url()}`);
    const html = await page.content();
    const hasCaptcha = html.includes('/sorry/') || html.includes('captcha') || html.includes('g-recaptcha');
    console.log(`Contains CAPTCHA: ${hasCaptcha}`);
    const h3Count = await page.evaluate(() => document.querySelectorAll('h3').length);
    console.log(`h3 count: ${h3Count}`);

    const organic = await page.evaluate(() => {
      const results: any[] = [];
      document.querySelectorAll('h3').forEach((h3) => {
        const a = h3.closest('a');
        if (a) {
          results.push({
            title: h3.innerText?.trim(),
            link: a.getAttribute('href'),
          });
        }
      });
      return results;
    });

    console.log('Organic results extracted:', organic.length);
    if (organic.length > 0) {
      console.log('First 2 items:', organic.slice(0, 2));
    }

  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await releasePage(conn, page, true);
  }
}

async function main() {
  await syncRemotePool();
  await testNoGbvWithInterception();
}

main();
