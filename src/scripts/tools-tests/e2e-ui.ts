/**
 * Browser smoke test for every Dev Tools panel tool.
 *
 * Serves a test build of the dashboard (dashboard/dist-e2e) with the real /api/tools backend mounted, opens
 * each tool in headless Chrome at desktop and phone widths, and reports tools that crash, are
 * unimplemented, never finish loading, log errors, or overflow horizontally.
 *
 *   cd dashboard && VITE_BASE_URL= BASE_URL= npx vite build --outDir dist-e2e   (no prod API base baked in)
 *   node node_modules/tsx/dist/cli.mjs src/scripts/tools-tests/e2e-ui.ts [toolId...]
 *
 * Env: E2E_PORT (4190), E2E_OUT (screenshot dir, default <tmp>/devtools-e2e), CHROME_PATH.
 */

import 'dotenv/config';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, promises as fs } from 'fs';
import { extname, join, resolve } from 'path';
import { tmpdir } from 'os';
import puppeteer from 'puppeteer-core';
import { handleToolsRequest } from '../../libs/tools';

const root = resolve(__dirname, '../../..');
const dist = join(root, process.env.E2E_DIST || 'dashboard/dist-e2e');
const port = Number(process.env.E2E_PORT || 4190);
const outDir = process.env.E2E_OUT || join(tmpdir(), 'devtools-e2e');
mkdirSync(outDir, { recursive: true });

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome',
].filter(Boolean) as string[];

function toolIds(): string[] {
  const src = readFileSync(join(root, 'dashboard/src/components/devtools/registry.ts'), 'utf-8');
  return [...src.matchAll(/^\s*t\('([a-z0-9-]+)'/gm)].map(m => m[1]);
}

interface Result {
  id: string;
  ok: boolean;
  problems: string[];
  ms: number;
}

async function main() {
  if (!existsSync(join(dist, 'index.html'))) throw new Error('e2e build missing — see header comment');

  const server = createServer(async (req, res) => {
    if (await handleToolsRequest(req, res)) return;
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (path.startsWith('/api/')) {
      // The rest of the dashboard API isn't under test; answer with an empty payload.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || path === '/') file = join(dist, 'index.html');
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));

  const executablePath = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });

  const only = process.argv.slice(2);
  const ids = toolIds().filter(id => !only.length || only.includes(id));
  const results: Result[] = [];

  for (const id of ids) {
    const problems: string[] = [];
    const t0 = Date.now();
    const page = await browser.newPage();
    page.on('pageerror', e => problems.push(`pageerror: ${(e as Error).message}`));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const text = m.text();
      // Network failures of third-party resources (fonts, external APIs) aren't UI bugs.
      if (/Failed to load resource|net::ERR_|favicon/i.test(text)) return;
      problems.push(`console: ${text.slice(0, 300)}`);
    });
    await page.evaluateOnNewDocument(() => {
      // Also runs inside sandboxed preview iframes, where localStorage throws.
      try {
        localStorage.setItem('dashboard_token', 'e2e');
        localStorage.setItem('theme', 'dark');
      } catch { /* sandboxed frame */ }
    });

    for (const [label, width, height] of [['desktop', 1366, 900], ['phone', 390, 844]] as const) {
      await page.setViewport({ width, height });
      try {
        await page.goto(`http://127.0.0.1:${port}/#/dev-tools?tool=${id}`, { waitUntil: 'networkidle2', timeout: 30_000 });
        await page.waitForFunction(
          () => !document.body.innerText.includes('Loading tool…') && !document.body.innerText.includes('Loading panel…'),
          { timeout: 20_000 },
        );
        // Give effects (live previews, initial fetches) a moment to settle; tools that fetch live
        // data on mount (e.g. exchange rates) may need longer before they render content.
        await new Promise(r => setTimeout(r, 600));
        await page.waitForFunction(
          () => ((document.querySelector('[data-slot="card-content"]') as HTMLElement | null)?.innerText.length ?? 0) >= 20,
          { timeout: 15_000 },
        ).catch(() => {});
      } catch (e) {
        problems.push(`${label}: did not finish loading (${(e as Error).message.split('\n')[0]})`);
      }
      const state = await page.evaluate(() => {
        const text = document.body.innerText;
        const main = document.querySelector('main');
        return {
          crashed: text.includes('This tool crashed'),
          stub: /is not implemented yet/.test(text),
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
          textLength: (document.querySelector('[data-slot="card-content"]') as HTMLElement | null)?.innerText.length ?? 0,
        };
      });
      if (state.crashed) problems.push(`${label}: tool crashed`);
      if (state.stub) problems.push(`${label}: still a stub`);
      if (state.docOverflow > 2 || state.mainOverflow > 2) problems.push(`${label}: horizontal overflow ${Math.max(state.docOverflow, state.mainOverflow)}px`);
      if (state.textLength < 20) problems.push(`${label}: tool rendered almost nothing`);
      await page.screenshot({ path: join(outDir, `${id}-${label}.png`) as `${string}.png`, fullPage: label === 'desktop' });
    }
    await page.close();
    const unique = [...new Set(problems)];
    results.push({ id, ok: unique.length === 0, problems: unique, ms: Date.now() - t0 });
    console.log(`${unique.length ? '✗' : '✓'} ${id}${unique.length ? '\n    ' + unique.join('\n    ') : ''}`);
  }

  await browser.close();
  server.close();
  const failed = results.filter(r => !r.ok);
  await fs.writeFile(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} tools OK · screenshots in ${outDir}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
