/**
 * End-to-end smoke test for the AI web extractor, through the real /api/extract endpoints:
 * setup (venv + pip + server) → model download + load → extraction from HTML and from a URL.
 * Downloads ~1.2 GB (PyTorch CPU + NuExtract-1.5-tiny), so it is meant for CI runners.
 *
 *   node node_modules/tsx/dist/cli.mjs src/scripts/tools-tests/extractor-smoke.ts
 */

import { createServer } from 'http';
import { handleExtractorRequest } from '../../libs/extractor';

const PORT = 4192;
const base = `http://127.0.0.1:${PORT}/api/extract`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const HTML = `<!doctype html><html><head><title>Acme Trail Runner 2 – Acme Shoes</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Trail Runner 2","brand":"Acme"}</script>
<meta property="og:title" content="Acme Trail Runner 2"></head><body>
<nav><a href="/">Home</a> <a href="/men">Men</a> <a href="/women">Women</a> <a href="/sale">Sale</a></nav>
<main><article><h1>Acme Trail Runner 2</h1>
<p>The Acme Trail Runner 2 is a lightweight trail running shoe made by Acme. It costs $129.99 and is currently in stock.</p>
<p>Key features include a Vibram outsole, a waterproof membrane and a rock plate for rough terrain. Customers rate it 4.6 out of 5 across 312 reviews.</p>
<p>It weighs 280 grams per shoe and comes in three colours: black, blue and orange. Free shipping on orders over $50.</p>
</article></main><footer>© 2026 Acme Shoes · Privacy · Terms</footer></body></html>`;

async function j(path: string, init?: RequestInit) {
  const r = await fetch(base + path, init);
  const body = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const server = createServer(async (req, res) => {
    if (!(await handleExtractorRequest(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server.listen(PORT, '127.0.0.1', r));

  const t0 = Date.now();
  await j('/setup', { method: 'POST' });
  let last = '';
  for (;;) {
    const s = await j('/status');
    const line = `${s.phase} ${s.step} ${s.model ? `${s.model.status} ${Math.round(s.model.downloaded_bytes / 1e6)}/${Math.round(s.model.total_bytes / 1e6)} MB` : ''}`;
    if (line !== last) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${line}`); last = line; }
    if (s.phase === 'error' || s.model?.status === 'error') throw new Error(`setup failed: ${s.error || s.model?.error}\n${s.log.join('\n')}`);
    if (s.model?.status === 'ready') break;
    if (Date.now() - t0 > 25 * 60_000) throw new Error('setup timed out');
    await sleep(3000);
  }
  console.log(`setup done in ${Math.round((Date.now() - t0) / 1000)}s`);

  const template = { name: '', brand: '', price: '', availability: '', features: [], rating: '', review_count: '', colors: [] };
  const run = async (label: string, body: object) => {
    const t = Date.now();
    const r = await j('/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    console.log(`\n── ${label} (${Date.now() - t} ms) ──`);
    console.log('timings', r.timings, 'stats', r.stats);
    console.log('structured keys', Object.keys(r.structured));
    console.log('model', JSON.stringify(r.model, null, 1));
    return r;
  };

  const a = await run('fixture HTML', { html: HTML, url: 'https://shop.example/acme', template });
  const out = a.model?.output;
  const problems: string[] = [];
  if (!a.structured['json-ld']?.length) problems.push('JSON-LD not extracted');
  if (!a.model?.valid) problems.push(`model output invalid: ${a.model?.errors}`);
  if (!/Trail Runner/i.test(out?.name || '')) problems.push(`name = ${out?.name}`);
  if (!/129\.99/.test(out?.price || '')) problems.push(`price = ${out?.price}`);
  if (/Privacy/.test(a.text)) problems.push('footer boilerplate not removed by trafilatura');

  const b = await run('structured only, no model', { html: HTML, template, useModel: false });
  if (b.model !== null) problems.push('useModel=false still ran the model');

  await run('live URL', { url: 'https://www.python.org/', template: { title: '', latest_release: '', upcoming_events: [] } })
    .catch(e => console.log('live URL run failed (network):', (e as Error).message));

  await j('/stop', { method: 'POST' });
  server.close();
  console.log(problems.length ? `\n✗ ${problems.join('\n✗ ')}` : '\n✓ extractor smoke test passed');
  process.exit(problems.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
