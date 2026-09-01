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

async function testWorker(worker: any) {
  console.log(`\nTesting worker ${worker.workerId}...`);
  const { conn, page } = await acquirePage(worker, true);

  try {
    // 1. Clear cookies
    try {
      const client = await page.target().createCDPSession();
      await client.send('Network.clearBrowserCookies');
      await client.detach();
    } catch (e: any) {
      console.log('Error clearing cookies:', e.message);
    }

    // 2. Set User Agent & Evasion
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const targetUrl = 'https://www.google.com/search?q=dentist+in+london&hl=en&num=10';
    const t0 = Date.now();
    const resp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log(`[${worker.workerId}] page.goto status: ${resp?.status()} in ${Date.now() - t0} ms`);
    console.log(`[${worker.workerId}] page URL: ${page.url()}`);
    const html = await page.content();
    const hasCaptcha = html.includes('/sorry/') || html.includes('captcha') || html.includes('g-recaptcha');
    console.log(`[${worker.workerId}] Has CAPTCHA: ${hasCaptcha}`);
    const h3Count = await page.evaluate(() => document.querySelectorAll('h3').length);
    console.log(`[${worker.workerId}] h3 count: ${h3Count}`);

  } catch (err: any) {
    console.error(`[${worker.workerId}] Error:`, err.message);
  } finally {
    await releasePage(conn, page, true);
  }
}

async function main() {
  await syncRemotePool();
  const active = browserPool.getActive();
  console.log(`Active workers: ${active.length}`);
  for (const b of active.slice(0, 4)) {
    await testWorker(b);
  }
}

main();
