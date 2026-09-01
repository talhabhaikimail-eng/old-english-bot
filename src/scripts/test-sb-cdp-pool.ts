import { browserPool } from '../libs/browser-pool';

async function testPoolRegistration() {
  console.log('🧪 Testing SeleniumBase UC CDP registration in BrowserPool...');

  const workerId = 'test-worker-sb-cdp-01';
  const cdpUrl = 'https://puppeteer-tunnel.trycloudflare.com';
  const sbCdpUrl = 'https://seleniumbase-tunnel.trycloudflare.com';
  const apiUrl = 'https://api-tunnel.trycloudflare.com';
  const runId = 'test-run-12345';

  // 1. Register with sbCdpUrl
  browserPool.register(workerId, cdpUrl, runId, true, apiUrl, sbCdpUrl);

  const registered = browserPool.getAll().find(b => b.workerId === workerId);
  if (!registered) {
    throw new Error('Worker was not registered in BrowserPool');
  }

  console.log('✅ Registered worker found:', {
    workerId: registered.workerId,
    cdpUrl: registered.cdpUrl,
    sbCdpUrl: registered.sbCdpUrl,
    seleniumCdpUrl: registered.seleniumCdpUrl,
    apiUrl: registered.apiUrl,
    status: registered.status
  });

  if (registered.sbCdpUrl !== sbCdpUrl) {
    throw new Error(`Expected sbCdpUrl to be ${sbCdpUrl}, got ${registered.sbCdpUrl}`);
  }

  if (registered.seleniumCdpUrl !== sbCdpUrl) {
    throw new Error(`Expected seleniumCdpUrl to be ${sbCdpUrl}, got ${registered.seleniumCdpUrl}`);
  }

  // 2. Update registration with new URL
  const updatedSbUrl = 'https://updated-seleniumbase-tunnel.trycloudflare.com';
  browserPool.register(workerId, cdpUrl, runId, true, apiUrl, updatedSbUrl);

  const updated = browserPool.getAll().find(b => b.workerId === workerId);
  if (updated?.sbCdpUrl !== updatedSbUrl) {
    throw new Error(`Expected updated sbCdpUrl to be ${updatedSbUrl}, got ${updated?.sbCdpUrl}`);
  }

  console.log('✅ Updated registration verification passed:', updated?.sbCdpUrl);

  // 3. Clean up
  browserPool.deregister(workerId);
  const remaining = browserPool.getAll().find(b => b.workerId === workerId);
  if (remaining) {
    throw new Error('Worker was not deregistered from BrowserPool');
  }

  console.log('✅ Deregistration verified successfully.');
  console.log('🎉 ALL SeleniumBase CDP BrowserPool tests passed successfully!');
}

testPoolRegistration().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
