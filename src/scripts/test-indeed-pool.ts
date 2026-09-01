import { browserPool, searchIndeedViaPool, searchViaPool } from '../libs/browser-pool';

async function syncRemotePool() {
  const poolUrl = `${process.env.DASHBOARD_URL || 'http://localhost:3000'}/api/browsers/pool`;
  const headers: Record<string, string> = {
    'accept': '*/*',
  };
  if (process.env.DASHBOARD_AUTH) {
    headers['authorization'] = process.env.DASHBOARD_AUTH;
  }

  try {
    console.log(`🌐 Syncing remote browsers from ${poolUrl}...`);
    const res = await fetch(poolUrl, { headers });
    if (!res.ok) {
      console.warn(`⚠️ Remote pool fetch returned status ${res.status}`);
      return;
    }
    const data = await res.json() as any;
    if (data.browsers && Array.isArray(data.browsers)) {
      let registered = 0;
      for (const b of data.browsers) {
        if (b.cdpUrl && b.status === 'active') {
          browserPool.register(b.workerId, b.cdpUrl, b.runId, true, b.apiUrl);
          registered++;
        }
      }
      console.log(`✅ Synced ${registered} active remote browsers into local BrowserPool.\n`);
    }
  } catch (err: any) {
    console.error('❌ Remote pool sync error:', err.message);
  }
}

async function runTest() {
  await syncRemotePool();

  const activeCount = browserPool.getActive().length;
  console.log(`🏊 Active Browsers Pool Count: ${activeCount}`);

  console.log(`\n🔍 Testing Indeed Search via Browser Pool...`);
  const t0 = Date.now();
  try {
    const indeedRes = await searchIndeedViaPool('software engineer', 'remote', 1);
    const elapsed = Date.now() - t0;
    if (indeedRes && indeedRes.jobs) {
      console.log(`✅ Indeed Search Success: Found ${indeedRes.jobs.length} jobs in ${elapsed}ms`);
      if (indeedRes.jobs.length > 0) {
        console.log(`   Sample Job: ${indeedRes.jobs[0].title} @ ${indeedRes.jobs[0].company} (${indeedRes.jobs[0].location})`);
        console.log(`   URL: ${indeedRes.jobs[0].url}`);
      }
    } else {
      console.warn(`⚠️ Indeed Search returned null or 0 jobs (elapsed: ${elapsed}ms)`);
    }
  } catch (e: any) {
    console.error(`❌ Indeed Search error:`, e.message);
  }

  console.log(`\n🔍 Testing Google Search via Browser Pool...`);
  const t1 = Date.now();
  try {
    const googleRes = await searchViaPool('dentist in london', 1, false, 'all');
    const elapsed = Date.now() - t1;
    if (googleRes && googleRes.organic) {
      console.log(`✅ Google Search Success: Found ${googleRes.organic.length} organic results in ${elapsed}ms`);
      if (googleRes.organic.length > 0) {
        console.log(`   Top Result: ${googleRes.organic[0].title} - ${googleRes.organic[0].link}`);
      }
    } else {
      console.warn(`⚠️ Google Search returned null (elapsed: ${elapsed}ms)`);
    }
  } catch (e: any) {
    console.error(`❌ Google Search error:`, e.message);
  }
}

runTest();
