/**
 * Browser smoke test for the SEO Site Auditor panel.
 *
 * Serves a test build of the dashboard (dashboard/dist-e2e) with the real /api/site-audit proxy in
 * front of a running Go site-auditor, starts an audit from the form and another through the API,
 * then walks every report tab and the page drawer at desktop and phone widths, reporting crashes,
 * console errors and horizontal overflow.
 *
 *   cd src-go/site-auditor && go run .                                (or set SITE_AUDITOR_URL)
 *   cd dashboard && VITE_BASE_URL= BASE_URL= npx vite build --outDir dist-e2e
 *   node node_modules/tsx/dist/cli.mjs src/scripts/tools-tests/e2e-site-audit.ts [url]
 *
 * Env: E2E_PORT (4191), E2E_OUT (screenshot dir, default <tmp>/site-audit-e2e), E2E_PAGES (25), CHROME_PATH.
 */

import { createServer } from 'http';
import { existsSync, mkdirSync, promises as fs } from 'fs';
import { extname, join, resolve } from 'path';
import { tmpdir } from 'os';
import puppeteer, { type Page } from 'puppeteer-core';
import { handleSiteAuditRequest } from '../../libs/site-audit-proxy';

const root = resolve(__dirname, '../../..');
const dist = join(root, 'dashboard/dist-e2e');
const port = Number(process.env.E2E_PORT || 4191);
const outDir = process.env.E2E_OUT || join(tmpdir(), 'site-audit-e2e');
const target = process.argv[2] || 'talhacodes.site';
mkdirSync(outDir, { recursive: true });

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const CHROME = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .filter(Boolean).find(p => existsSync(p!));

const problems: string[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}`;

async function api(path: string, init?: RequestInit) {
  const r = await fetch(`${base}/api/site-audit${path}`, init);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

async function check(page: Page, label: string) {
  await sleep(500);
  const s = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    text: document.body.innerText,
  }));
  if (s.overflow > 2) problems.push(`${label}: horizontal overflow ${s.overflow}px`);
  if (/crashed|Something went wrong/i.test(s.text)) problems.push(`${label}: crashed`);
  await page.screenshot({ path: join(outDir, `${label}.png`) as `${string}.png`, fullPage: true });
}

async function clickText(page: Page, selector: string, text: string) {
  const ok = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find(e => e.innerText.trim().startsWith(t));
    el?.click();
    return !!el;
  }, selector, text);
  if (!ok) problems.push(`could not find ${selector} "${text}"`);
  return ok;
}

async function main() {
  if (!existsSync(join(dist, 'index.html'))) throw new Error('e2e build missing — see header comment');
  if (!CHROME) throw new Error('No Chrome/Edge found; set CHROME_PATH');

  const server = createServer(async (req, res) => {
    if (handleSiteAuditRequest(req, res)) return;
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (path.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || path === '/') file = join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await fs.readFile(file));
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));

  const health = await fetch(`${base}/api/site-audit/checks`);
  if (!health.ok) throw new Error(`site auditor not reachable through the proxy (HTTP ${health.status})`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', e => problems.push(`pageerror: ${(e as Error).message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_|favicon/i.test(m.text())) problems.push(`console: ${m.text().slice(0, 300)}`);
  });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('dashboard_token', 'e2e'); localStorage.setItem('theme', 'dark'); } catch { /* */ } });
  await page.setViewport({ width: 1366, height: 900 });

  // 1. Start a quick single-page audit from the form.
  await page.goto(`${base}/#/site-audit`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[placeholder="example.com"]');
  await check(page, '01-home');
  // Every settings section renders (Checks loads the catalog through the proxy).
  await clickText(page, 'button', 'Crawl settings');
  for (const [i, s] of ['Scope', 'Crawl', 'Access', 'Custom search', 'Checks', 'Verification'].entries()) {
    await clickText(page, 'button', s);
    if (s === 'Checks') await page.waitForFunction(() => document.body.innerText.includes('Enabled checks —'), { timeout: 15_000 }).catch(() => problems.push('checks catalog did not load'));
    await check(page, `01-settings-${i}-${s.replace(/\W+/g, '-').toLowerCase()}`);
  }
  await clickText(page, 'button', 'Scope');
  await clickText(page, 'button', 'Hide settings');
  await page.type('input[placeholder="example.com"]', target);
  await clickText(page, 'button', 'Quick (1 page)');
  await clickText(page, 'button', 'Start audit');
  await page.waitForFunction(() => location.hash.includes('id='), { timeout: 15_000 });
  await page.waitForFunction(() => document.body.innerText.includes('Site health'), { timeout: 120_000 });
  await check(page, '02-quick-report');

  // 2. A multi-page audit through the API (custom rules + third-party verification), watched live in
  //    the UI, after an identical baseline audit so the Changes tab has something to compare.
  const auditBody = {
    url: target, maxPages: Number(process.env.E2E_PAGES || 25), pageSpeed: false, ignoreParams: ['tracking'],
    customSearch: [{ name: 'Has script', pattern: '<script' }, { name: 'No noscript', pattern: '<noscript', absent: true }],
    extract: [{ name: 'Title tag', regex: '<title>([^<]+)</title>' }],
    verify: { w3c: true, w3cPages: 2, observatory: true, safeBrowsing: true, rdap: true, wayback: true, tranco: true, greenWeb: true },
  };
  const baseline = await api('/audits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...auditBody, verify: { w3c: false, observatory: false, safeBrowsing: false, rdap: false, wayback: false, tranco: false, greenWeb: false } }) });
  for (let i = 0; i < 240; i++) {
    const p = await api(`/audits/${baseline.id}/progress`);
    if (p.status !== 'running' && p.status !== 'queued') break;
    await sleep(1000);
  }
  const started = await api('/audits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(auditBody),
  });
  await page.goto(`${base}/#/site-audit?id=${started.id}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('Auditing') || document.body.innerText.includes('Site health'), { timeout: 20_000 });
  await check(page, '03-running');
  await page.waitForFunction(() => document.body.innerText.includes('Site health'), { timeout: 240_000 });

  const tabs = ['Overview', 'Issues', 'Pages', 'Links & assets', 'Content & duplicates', 'Performance', 'Security & site', 'Verification', 'Custom search', 'Changes'];
  for (const [i, t] of tabs.entries()) {
    await clickText(page, 'nav button', t);
    await check(page, `1${i}-${t.replace(/\W+/g, '-').toLowerCase()}`);
  }
  const rep = await api(`/audits/${started.id}`);
  const tp = rep.site?.thirdParty || {};
  for (const k of ['w3c', 'observatory', 'rdap', 'wayback', 'tranco', 'greenWeb']) {
    if (!tp[k]) problems.push(`verification ${k} missing`);
    else if (tp[k].status === 'error') console.warn(`  (third-party ${k} errored: ${tp[k].error})`);
  }
  if (rep.customSearch?.length !== 2) problems.push(`custom search results: ${rep.customSearch?.length}`);
  const cmp = await api(`/audits/${started.id}/compare?base=${baseline.id}`);
  if (cmp.base?.id !== baseline.id) problems.push('compare returned the wrong baseline');
  await clickText(page, 'nav button', 'Pages');
  await clickText(page, 'div.inline-flex button', 'Custom');
  await check(page, '19-pages-custom-columns');
  // Assets sub-view
  await clickText(page, 'nav button', 'Links & assets');
  await clickText(page, 'button', 'Assets & external URLs');
  await check(page, '20-assets');

  // Page drawer with every tab
  await clickText(page, 'nav button', 'Pages');
  await sleep(300);
  await page.click('tbody tr');
  await page.waitForSelector('aside');
  await page.waitForFunction(() => !document.querySelector('aside')?.textContent?.includes('Loading…'), { timeout: 15_000 });
  for (const t of ['Summary', 'Issues', 'Headings', 'Links', 'Images', 'Schema', 'Content', 'HTTP']) {
    await clickText(page, 'aside nav button', t);
    await check(page, `3-drawer-${t.toLowerCase()}`);
  }
  await page.keyboard.press('Escape');

  // Phone width
  await page.setViewport({ width: 390, height: 844 });
  for (const t of ['Overview', 'Issues', 'Pages', 'Security & site', 'Verification', 'Changes']) {
    await clickText(page, 'nav button', t);
    await check(page, `4-phone-${t.replace(/\W+/g, '-').toLowerCase()}`);
  }
  await page.goto(`${base}/#/site-audit`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('Audit history'), { timeout: 15_000 });
  await check(page, '5-phone-home');
  await clickText(page, 'button', 'Crawl settings');
  await clickText(page, 'button', 'Checks');
  await sleep(800);
  await check(page, '5-phone-settings-checks');

  // Export through the proxy
  const html = await fetch(`${base}/api/site-audit/audits/${started.id}/export?type=report&format=html`);
  const htmlText = await html.text();
  if (!html.ok || !htmlText.includes('SEO site audit')) problems.push(`html report: HTTP ${html.status}`);
  else await fs.writeFile(join(outDir, 'report.html'), htmlText);
  for (const type of ['pages', 'issues', 'links', 'resources', 'images', 'custom']) {
    const r = await fetch(`${base}/api/site-audit/audits/${started.id}/export?type=${type}&format=csv`);
    const text = await r.text();
    if (!r.ok || text.split('\n').length < 2) problems.push(`export ${type}: HTTP ${r.status}, ${text.length} bytes`);
  }

  await browser.close();
  server.close();
  const unique = [...new Set(problems)];
  console.log(unique.length ? `✗ ${unique.length} problems:\n  ${unique.join('\n  ')}` : '✓ site auditor UI OK');
  console.log(`screenshots in ${outDir}`);
  process.exitCode = unique.length ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
