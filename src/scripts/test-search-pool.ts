import { browserPool, searchViaPool } from '../libs/browser-pool';

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
    const data = await res.json();
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

async function run10Tests() {
  await syncRemotePool();

  const activeCount = browserPool.getActive().length;
  console.log(`🏊 Active Browsers Pool Count: ${activeCount}`);
  if (activeCount === 0) {
    console.error('❌ No active browsers available in pool.');
    return;
  }

  const testQueries = [
    { query: 'dentist in london', category: 'all' },
    { query: 'tech news', category: 'news' },
    { query: 'best laptops 2026', category: 'all' },
    { query: 'weather in new york', category: 'all' },
    { query: 'python tutorial', category: 'all' },
    { query: 'health tech software', category: 'all' },
    { query: 'openai chatgpt', category: 'all' },
    { query: 'github actions tutorial', category: 'all' },
    { query: 'latest movies 2026', category: 'all' },
    { query: 'world news today', category: 'news' },
  ];

  console.log(`\n🚀 Starting 10 Sequential Search Tests...\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < testQueries.length; i++) {
    const { query, category } = testQueries[i];
    console.log(`--- Test ${i + 1}/10: "${query}" (category: ${category}) ---`);
    const t0 = Date.now();
    try {
      const res = await searchViaPool(query, 1, false, category);
      const elapsed = Date.now() - t0;

      if (!res) {
        failCount++;
        console.error(`❌ Test ${i + 1} FAILED (returned null, elapsed: ${elapsed}ms)\n`);
      } else {
        const resultsCount = category === 'news' ? (res.news?.length || 0) : (res.organic?.length || 0);
        if (resultsCount > 0) {
          successCount++;
          console.log(`✅ Test ${i + 1} SUCCESS: ${resultsCount} results found in ${elapsed}ms`);
          const firstItem = category === 'news' ? res.news?.[0]?.title : res.organic?.[0]?.title;
          console.log(`   Top Result: "${firstItem}"\n`);
        } else {
          failCount++;
          console.warn(`⚠️ Test ${i + 1} WARNING: 0 results found in ${elapsed}ms\n`);
        }
      }
    } catch (err: any) {
      failCount++;
      console.error(`❌ Test ${i + 1} ERROR: ${err.message}\n`);
    }

    // Brief 500ms delay between consecutive requests
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`========================================`);
  console.log(`🏁 10 TESTS SUMMARY:`);
  console.log(`   Success: ${successCount}/10`);
  console.log(`   Failed:  ${failCount}/10`);
  console.log(`========================================`);
}

run10Tests();
