import { browserPool } from '../libs/browser-pool';

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

async function testWorkerApi() {
  await syncRemotePool();
  const active = browserPool.getActive();
  console.log(`Active workers: ${active.length}`);

  for (const b of active) {
    if (!b.apiUrl) {
      console.log(`Worker ${b.workerId} has no apiUrl, skipping...`);
      continue;
    }

    console.log(`\nTesting UC Mode on Worker: ${b.workerId} via apiUrl: ${b.apiUrl}...`);
    try {
      const targetUrl = 'https://www.google.com/search?q=dentist+in+london&hl=en';
      const t0 = Date.now();
      const res = await fetch(`${b.apiUrl}/get_html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      console.log(`Response Status: ${res.status} in ${Date.now() - t0} ms`);
      if (res.ok) {
        const json = await res.json();
        const html = json.html || '';
        const hasCaptcha = html.includes('/sorry/') || html.includes('captcha') || html.includes('g-recaptcha');
        console.log(`Contains CAPTCHA: ${hasCaptcha}`);
        
        // Count h3 tags in returned HTML
        const h3Match = html.match(/<h3/g);
        console.log(`h3 matches count: ${h3Match ? h3Match.length : 0}`);
        if (!hasCaptcha && h3Match && h3Match.length > 0) {
          console.log(`✅ SUCCESS on worker ${b.workerId}!`);
          break;
        }
      } else {
        const errText = await res.text();
        console.error(`API Error: ${errText}`);
      }
    } catch (err: any) {
      console.error(`Fetch error for ${b.workerId}:`, err.message);
    }
  }
}

testWorkerApi();
