// SEO tools tests.
//
// Most tests run against a local fixture HTTP server started in this file (port TOOLS_SEO_FIXTURE_PORT, default 4116).
// The SEO fetcher refuses loopback/private targets (SSRF guard), so the tools server must be started with
// TOOLS_ALLOW_PRIVATE_TARGETS=1 for those tests:
//
//   TOOLS_ALLOW_PRIVATE_TARGETS=1 TOOLS_TEST_PORT=4106 node src/scripts/tools-tests/run-all.mjs seo
//
// The guard itself is unit-tested in a child process *without* the flag (see "SSRF guard" tests), and one test
// hits a real public site (https://example.com).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, assert, runJob, test } from './lib.mjs';

const FPORT = Number(process.env.TOOLS_SEO_FIXTURE_PORT || 4116);
const F = `http://127.0.0.1:${FPORT}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const privateAllowed = process.env.TOOLS_ALLOW_PRIVATE_TARGETS === '1';

// ── fixture site ─────────────────────────────────────────────────────────────

function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 2;
  return b;
}

const page = ({ head = '', body = '', lang = 'en' }) => `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const lorem = 'Search engine optimisation helps pages rank. Good content explains the topic clearly and answers questions. '.repeat(30);

const GOOD = page({
  head: `<title>Fixture good page about search engine optimisation</title>
<meta name="description" content="A carefully written fixture page used to test the SEO analyzer, with every important tag present and valid.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="${F}/good">
<link rel="icon" href="/favicon.svg">
<link rel="alternate" hreflang="en" href="${F}/good"><link rel="alternate" hreflang="de-DE" href="${F}/de/good"><link rel="alternate" hreflang="english" href="${F}/x">
<meta property="og:title" content="OG fixture title"><meta property="og:description" content="OG description">
<meta property="og:image" content="/og.png"><meta property="og:url" content="${F}/good"><meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","headline":"x"},{"@type":"BreadcrumbList"}]}</script>
<script type="application/ld+json">{"@type": "Broken",}</script>`,
  body: `<h1>Search engine optimisation</h1><h2>Why</h2><h4>Skipped</h4><p>${lorem}</p>
<img src="/a.png" alt="A" width="10" height="10"><img src="/b.webp"><img src="/c.jpg" alt="" loading="lazy">
<a href="/about">About us</a><a href="/good#top">Top</a><a href="https://other.test/x" rel="nofollow sponsored">Partner</a>
<a href="https://ugc.test/" rel="ugc">click here</a><a href="/empty"></a><a href="mailto:a@b.c">mail</a>`,
});

const routes = {
  '/robots.txt': () => [200, { 'Content-Type': 'text/plain' }, `# fixture
User-agent: *
Disallow: /private/
Allow: /private/public$
Disallow: /*.pdf$

User-agent: googlebot
Disallow: /no-google/
Disallow: /private/

Sitemap: ${F}/sitemap_index.xml
`],
  '/sitemap_index.xml': () => [200, { 'Content-Type': 'application/xml' }, `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${F}/sitemap-pages.xml.gz</loc></sitemap><sitemap><loc>${F}/sitemap-posts.xml</loc></sitemap></sitemapindex>`],
  '/sitemap-pages.xml.gz': () => [200, { 'Content-Type': 'application/x-gzip' }, gzipSync(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${F}/</loc></url><url><loc>${F}/good</loc></url><url><loc>${F}/about/</loc></url></urlset>`)],
  '/sitemap-posts.xml': () => [200, { 'Content-Type': 'application/xml' }, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${F}/post-1?a=1&amp;b=2</loc></url></urlset>`],
  '/': () => [200, { 'Content-Type': 'text/html; charset=utf-8', 'Last-Modified': 'Wed, 01 Jan 2025 10:00:00 GMT' }, page({
    head: '<title>Home</title>',
    body: `<h1>Home</h1><a href="/good">Good</a> <a href="/about">About</a> <a href="/noindex">No index</a> <a href="/redirect-1">Redirect</a>
<a href="/canon-other">Canon</a> <a href="/private/x">Private</a> <a href="/file.pdf">PDF</a> <a href="/img.png">img</a> <a href="https://elsewhere.test/">ext</a>
<a href="/nofollowed" rel="nofollow">nf</a> <a href="/good?utm=1#frag">q</a> <a href="/deep/1">deep</a>`,
  })],
  '/good': () => [200, { 'Content-Type': 'text/html; charset=utf-8' }, GOOD],
  '/about': () => [200, { 'Content-Type': 'text/html' }, page({ head: '<title>About</title>', body: '<h1>About</h1><a href="/">Home</a><a href="/good">Good</a>' })],
  '/deep/1': () => [200, { 'Content-Type': 'text/html' }, page({ head: '<title>D1</title>', body: '<a href="/deep/2">next</a>' })],
  '/deep/2': () => [200, { 'Content-Type': 'text/html' }, page({ head: '<title>D2</title>', body: '<a href="/deep/3">next</a>' })],
  '/deep/3': () => [200, { 'Content-Type': 'text/html' }, page({ head: '<title>D3</title>', body: 'end' })],
  '/noindex': () => [200, { 'Content-Type': 'text/html' }, page({ head: '<meta name="robots" content="noindex, follow"><title>NI</title>' })],
  '/xrobots': () => [200, { 'Content-Type': 'text/html', 'X-Robots-Tag': 'googlebot: noindex' }, page({ head: '<title>XR</title>' })],
  '/expired': () => [200, { 'Content-Type': 'text/html' }, page({ head: '<meta name="googlebot" content="unavailable_after: 2001-01-01"><title>Old</title>' })],
  '/redirect-1': () => [301, { Location: '/redirect-2' }, ''],
  '/redirect-2': () => [302, { Location: `${F}/good` }, ''],
  '/loop-a': () => [301, { Location: '/loop-b' }, ''],
  '/loop-b': () => [301, { Location: '/loop-a' }, ''],
  '/gone': () => [410, { 'Content-Type': 'text/html' }, 'gone'],
  '/canon-other': () => [200, { 'Content-Type': 'text/html' }, page({ head: `<title>C</title><link rel="canonical" href="/good">` })],
  '/canon-multi': () => [200, { 'Content-Type': 'text/html' }, page({ head: `<title>C</title><link rel="canonical" href="${F}/canon-multi"><link rel="canonical" href="${F}/good?utm_source=x">` })],
  '/canon-redirect': () => [200, { 'Content-Type': 'text/html' }, page({ head: `<title>C</title><link rel="canonical" href="${F}/redirect-1">` })],
  '/canon-header': () => [200, { 'Content-Type': 'text/html', Link: `<${F}/good>; rel="canonical"` }, page({ head: '<title>H</title>' })],
  '/latin1': () => [200, { 'Content-Type': 'text/html; charset=iso-8859-1' }, Buffer.from('<html><head><title>Caf\xe9 cr\xe8me</title></head><body><h1>Caf\xe9</h1></body></html>', 'latin1')],
  '/og.png': () => [200, { 'Content-Type': 'image/png' }, png(1200, 630)],
  '/a.png': () => [200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000' }, Buffer.concat([png(10, 10), Buffer.alloc(3000)])],
  '/big.jpg': () => [200, { 'Content-Type': 'image/jpeg' }, Buffer.alloc(300 * 1024, 1)],
  '/style.css': () => [200, { 'Content-Type': 'text/css' }, `@import url("/extra.css");
@font-face { font-family: X; src: url(/font.woff2) format("woff2"), url(/font.woff) format("woff"); }
body { color: red; } ${'/* padding */'.repeat(300)}`],
  '/extra.css': () => [200, { 'Content-Type': 'text/css' }, '@font-face{font-family:Y;src:url("/font2.ttf")}'],
  '/font.woff2': () => [200, { 'Content-Type': 'font/woff2' }, Buffer.alloc(20 * 1024)],
  '/font2.ttf': () => [200, { 'Content-Type': 'font/ttf' }, Buffer.alloc(10 * 1024)],
  '/app.js': () => [200, { 'Content-Type': 'application/javascript', 'Content-Encoding': 'gzip' }, gzipSync('console.log(1);'.repeat(2000))],
  '/weight': () => [200, { 'Content-Type': 'text/html' }, page({
    head: '<title>W</title><link rel="stylesheet" href="/style.css"><script src="/app.js"></script><script src="/defer.js" defer></script>',
    body: `<img src="/a.png" srcset="/a.png 100w, /big.jpg 1200w"><img src="/missing.png"><iframe src="https://www.youtube.com/embed/x"></iframe>`,
  })],
  '/defer.js': () => [200, { 'Content-Type': 'text/javascript' }, 'x'.repeat(500)],
  '/referrer': () => [200, { 'Content-Type': 'text/html' }, page({
    head: '<title>Referrer</title>',
    body: `<p>We recommend <a href="https://target.test/">Target Site</a> for great tools.</p>
<p>Also see <a href="https://blog.target.test/post" rel="sponsored nofollow">this post</a>.</p>
<nav><a href="https://www.target.test/pricing"><img src="/l.png" alt="Target logo"></a></nav><a href="https://unrelated.test/">no</a>`,
  })],
  '/referrer-noindex': () => [200, { 'Content-Type': 'text/html' }, page({ head: '<meta name="robots" content="noindex"><title>R2</title>', body: '<a href="https://target.test/">t</a>' })],
};

let server;
async function fixtures() {
  if (server) return;
  server = createServer((req, res) => {
    const path = new URL(req.url, F).pathname;
    const h = routes[path] || (path.startsWith('/no-google/') || path.startsWith('/private/') ? () => [200, { 'Content-Type': 'text/html' }, page({ head: '<title>P</title>' })] : null);
    const [status, headers, body] = h ? h() : [404, { 'Content-Type': 'text/html' }, 'not found'];
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, { 'Content-Length': buf.length, ...headers });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(FPORT, '127.0.0.1', ok); });
  server.unref();
}

/** Register a test that needs the fixture site (skipped with a clear failure if the flag is missing). */
function ftest(name, fn) {
  test(name, async () => {
    assert.ok(privateAllowed, 'start the runner with TOOLS_ALLOW_PRIVATE_TARGETS=1 for fixture tests');
    await fixtures();
    await fn();
  });
}

// ── input validation & guard ─────────────────────────────────────────────────

test('rejects missing / non-http URLs', async () => {
  await assert.rejects(api.post('/seo/analyze', {}), /400/);
  await assert.rejects(api.post('/seo/analyze', { url: 'ftp://example.com/' }), /400.*http/i);
  await assert.rejects(api.post('/seo/canonical', { url: 'http://user:pw@example.com/' }), /400/);
});

/** Run a snippet against the TS modules in a child process WITHOUT the private-targets flag. */
function runGuardScript(code) {
  return new Promise((ok, fail) => {
    const env = { ...process.env };
    delete env.TOOLS_ALLOW_PRIVATE_TARGETS;
    const p = spawn(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), '-e', `(async () => {${code}})().catch(e => { console.error(e); process.exit(1); });`], { cwd: root, env });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', c => (c === 0 ? ok(out) : fail(new Error(`exit ${c}: ${out}`))));
  });
}

test('SSRF guard blocks loopback/private/metadata targets and DNS answers (no override flag)', async () => {
  const out = await runGuardScript(`
    const f = require('./src/libs/tools/seo-fetch.ts');
    const results = {};
    for (const u of ['http://127.0.0.1/', 'http://localhost:8080/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://foo.internal/']) {
      try { f.checkTarget(u); results[u] = 'allowed'; } catch (e) { results[u] = e.message; }
    }
    let pub; try { f.checkTarget('https://example.com/'); pub = 'allowed'; } catch (e) { pub = e.message; }
    // A public hostname that resolves to 127.0.0.1 must be refused at connect time.
    let dnsRes; try { await f.rawRequest('http://localtest.me:${FPORT}/', { timeoutMs: 8000 }); dnsRes = 'fetched'; } catch (e) { dnsRes = e.message; }
    // A redirect hop to a private address must be refused too.
    let hop; try { f.checkTarget(new URL('http://127.0.0.1:1/x', 'https://example.com').href); hop = 'allowed'; } catch (e) { hop = e.message; }
    console.log(JSON.stringify({ results, pub, dnsRes, hop }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  for (const [u, v] of Object.entries(r.results)) assert.match(v, /Blocked/, `${u} should be blocked`);
  assert.equal(r.pub, 'allowed');
  assert.match(r.dnsRes, /Blocked|DNS lookup failed/, 'hostname resolving to loopback must not be fetched');
  assert.notEqual(r.dnsRes, 'fetched');
  assert.match(r.hop, /Blocked/);
});

// ── real site ────────────────────────────────────────────────────────────────

test('analyze a real public site (example.com)', async () => {
  const r = await api.post('/seo/analyze', { url: 'example.com' });
  assert.equal(r.status, 200);
  assert.match(r.finalUrl, /^https:\/\/example\.com\//);
  assert.equal(r.title.text, 'Example Domain');
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(r.checks.find(c => c.id === 'description' && c.status === 'fail'), 'example.com has no description');
  assert.ok(r.timing.ttfbMs > 0);
});

// ── analyze ──────────────────────────────────────────────────────────────────

ftest('analyze extracts meta, social, structure and scores a checklist', async () => {
  const r = await api.post('/seo/analyze', { url: `${F}/good`, userAgent: 'googlebot' });
  assert.equal(r.status, 200);
  assert.equal(r.title.text, 'Fixture good page about search engine optimisation');
  assert.ok(r.description.length > 70);
  assert.equal(r.canonical.selfReferential, true);
  assert.equal(r.lang, 'en');
  assert.equal(r.og['og:title'], 'OG fixture title');
  assert.equal(r.twitter['twitter:card'], 'summary_large_image');
  assert.equal(r.ogImages[0], `${F}/og.png`);
  assert.equal(r.ogImage.width, 1200);
  assert.equal(r.ogImage.height, 630);
  assert.deepEqual(r.structuredData.types.sort(), ['Article', 'BreadcrumbList']);
  assert.equal(r.structuredData.jsonLd.filter(j => j.error).length, 1);
  assert.deepEqual(r.headings.counts, [1, 1, 0, 1, 0, 0]);
  assert.equal(r.headings.skipped.length, 1);
  assert.equal(r.images.total, 3);
  assert.equal(r.images.missingAlt, 1);
  assert.equal(r.images.missingDimensions, 2);
  assert.equal(r.images.lazy, 1);
  assert.equal(r.links.internal, 3);
  assert.equal(r.links.external, 2);
  assert.equal(r.links.nofollow, 1);
  assert.equal(r.links.sponsored, 1);
  assert.equal(r.links.ugc, 1);
  assert.equal(r.links.empty, 1);
  assert.equal(r.links.generic, 1);
  assert.equal(r.hreflang.length, 3);
  assert.equal(r.hreflang.filter(h => !h.valid).length, 1);
  assert.ok(r.content.wordCount > 300);
  const ids = Object.fromEntries(r.checks.map(c => [c.id, c.status]));
  assert.equal(ids.title, 'pass');
  assert.equal(ids['jsonld-errors'], 'fail');
  assert.equal(ids.hreflang, 'warn');
  assert.equal(ids['heading-order'], 'warn');
  assert.equal(ids['og-image'], 'pass');
  assert.equal(ids.https, 'fail'); // fixture is plain http
  for (const c of r.checks) {
    assert.ok(['meta', 'content', 'links', 'images', 'technical', 'social'].includes(c.category));
    assert.ok(['pass', 'warn', 'fail', 'info'].includes(c.status));
    if (c.status === 'warn' || c.status === 'fail') assert.ok(c.advice, `${c.id} needs advice`);
  }
  assert.equal(r.categories.length, 6);
  assert.ok(r.score > 40 && r.score < 100, `score ${r.score}`);
});

ftest('analyze follows and records redirect chains; detects loops', async () => {
  const r = await api.post('/seo/analyze', { url: `${F}/redirect-1` });
  assert.equal(r.chain.length, 3);
  assert.deepEqual(r.chain.map(h => h.status), [301, 302, 200]);
  assert.equal(r.finalUrl, `${F}/good`);
  const loop = await api.post('/seo/analyze', { url: `${F}/loop-a` });
  assert.match(loop.redirectError, /loop/i);
  assert.equal(loop.checks.find(c => c.id === 'status').status, 'fail');
});

ftest('analyze decodes legacy charsets', async () => {
  const r = await api.post('/seo/analyze', { url: `${F}/latin1` });
  assert.equal(r.title.text, 'Café crème');
  assert.equal(r.charset.value, 'iso-8859-1');
  assert.equal(r.charset.source, 'header');
});

// ── indexability ─────────────────────────────────────────────────────────────

ftest('indexability: indexable page listed in a gzipped child sitemap', async () => {
  const r = await api.post('/seo/indexability', { url: `${F}/good`, userAgent: 'googlebot' });
  assert.equal(r.verdict.indexable, true, r.verdict.summary);
  assert.equal(r.robots.matchedAgent, 'googlebot');
  assert.equal(r.sitemaps.listed.match, 'exact');
  assert.match(r.sitemaps.listed.sitemap, /sitemap-pages\.xml\.gz$/);
  const child = r.sitemaps.sitemaps.find(s => s.url.endsWith('.gz'));
  assert.equal(child.urlCount, 3);
  assert.equal(child.source, 'index');
});

ftest('indexability: robots.txt groups, longest match and allow-wins', async () => {
  const blocked = await api.post('/seo/indexability', { url: `${F}/private/x`, userAgent: '*' });
  assert.equal(blocked.verdict.indexable, false);
  assert.equal(blocked.robots.matchedRule.path, '/private/');
  assert.match(blocked.verdict.summary, /robots\.txt/);
  const allowed = await api.post('/seo/indexability', { url: `${F}/private/public`, userAgent: '*' });
  assert.equal(allowed.robots.allowed, true);
  assert.equal(allowed.robots.matchedRule.type, 'allow');
  // googlebot has its own group, so the "*" Allow doesn't apply to it.
  const g = await api.post('/seo/indexability', { url: `${F}/no-google/a`, userAgent: 'googlebot' });
  assert.equal(g.robots.allowed, false);
  const b = await api.post('/seo/indexability', { url: `${F}/no-google/a`, userAgent: 'bingbot' });
  assert.equal(b.robots.allowed, true);
  assert.equal(b.robots.matchedAgent, '*');
  const pdf = await api.post('/seo/indexability', { url: `${F}/doc.pdf`, userAgent: 'bingbot' });
  assert.equal(pdf.robots.allowed, false);
  assert.equal(pdf.robots.matchedRule.path, '/*.pdf$');
});

ftest('indexability: meta robots, bot-specific X-Robots-Tag, unavailable_after, status', async () => {
  const ni = await api.post('/seo/indexability', { url: `${F}/noindex`, userAgent: 'googlebot' });
  assert.equal(ni.verdict.indexable, false);
  assert.match(ni.verdict.summary, /noindex/);
  const xg = await api.post('/seo/indexability', { url: `${F}/xrobots`, userAgent: 'googlebot' });
  assert.equal(xg.verdict.indexable, false);
  const xb = await api.post('/seo/indexability', { url: `${F}/xrobots`, userAgent: 'bingbot' });
  assert.equal(xb.verdict.indexable, true, xb.verdict.summary);
  const old = await api.post('/seo/indexability', { url: `${F}/expired`, userAgent: 'googlebot' });
  assert.equal(old.verdict.indexable, false);
  assert.match(old.verdict.summary, /unavailable_after/);
  const gone = await api.post('/seo/indexability', { url: `${F}/gone`, userAgent: 'googlebot' });
  assert.match(gone.verdict.summary, /410/);
  const canon = await api.post('/seo/indexability', { url: `${F}/canon-other`, userAgent: 'googlebot' });
  assert.equal(canon.verdict.status, 'warning');
  assert.match(canon.verdict.summary, /canonicalised/);
});

// ── canonical ────────────────────────────────────────────────────────────────

ftest('canonical: multiple tags, tracking params, header canonical', async () => {
  const m = await api.post('/seo/canonical', { url: `${F}/canon-multi` });
  const s = Object.fromEntries(m.items.map(i => [i.id, i.status]));
  assert.equal(s.multiple, 'fail');
  assert.equal(m.verdict.status, 'fail');
  const h = await api.post('/seo/canonical', { url: `${F}/canon-header` });
  assert.equal(h.header, `${F}/good`);
  assert.equal(h.canonical, `${F}/good`);
});

ftest('canonical: target that redirects is flagged; good target passes', async () => {
  const r = await api.post('/seo/canonical', { url: `${F}/canon-redirect` });
  assert.equal(r.items.find(i => i.id === 'target').status, 'fail');
  assert.match(r.items.find(i => i.id === 'target').message, /redirects/);
  const o = await api.post('/seo/canonical', { url: `${F}/canon-other` });
  assert.equal(o.items.find(i => i.id === 'target').status, 'pass');
  assert.equal(o.items.find(i => i.id === 'absolute').status, 'warn'); // relative href
  assert.equal(o.chain[0].url, `${F}/good`);
  assert.ok(o.variants.length >= 1);
});

// ── page weight ──────────────────────────────────────────────────────────────

ftest('page-weight: discovers css/js/img(srcset)/fonts, measures and estimates', async () => {
  const r = await api.post('/seo/page-weight', { url: `${F}/weight` });
  const urls = r.resources.map(x => x.url);
  for (const p of ['/style.css', '/extra.css', '/app.js', '/defer.js', '/big.jpg', '/font.woff2', '/font2.ttf']) assert.ok(urls.includes(F + p), `missing ${p}`);
  assert.ok(!urls.includes(`${F}/font.woff`), 'only the woff2 source of a @font-face is counted');
  assert.ok(!urls.includes(`${F}/a.png`), 'srcset largest replaces src');
  assert.equal(r.iframes[0], 'https://www.youtube.com/embed/x');
  const js = r.resources.find(x => x.url === `${F}/app.js`);
  assert.equal(js.encoding, 'gzip');
  assert.ok(js.bytes < 2000, 'transfer size is the compressed size');
  assert.equal(r.resources.find(x => x.url === `${F}/big.jpg`).bytes, 300 * 1024);
  assert.equal(r.totals.failed, 1); // /missing.png 404
  const rb = r.renderBlocking.map(x => x.url).sort();
  assert.deepEqual(rb, [`${F}/app.js`, `${F}/extra.css`, `${F}/style.css`]);
  assert.equal(r.estimates.length, 5);
  const [g2, , , , fibre] = r.estimates;
  assert.ok(g2.fullMs > fibre.fullMs && g2.renderMs <= g2.fullMs);
  assert.ok(r.byType.find(t => t.type === 'font').count === 2);
  assert.ok(r.suggestions.some(s => /large image/i.test(s.title)));
  assert.ok(r.largest[0].url.endsWith('/big.jpg'));
});

// ── backlinks ────────────────────────────────────────────────────────────────

ftest('backlinks: finds links to the target domain with rel, anchor and indexability', async () => {
  const r = await api.post('/seo/backlinks', { target: 'target.test', pages: [`${F}/referrer`, `${F}/referrer-noindex`, `${F}/good`, `${F}/gone`, 'not a url'] });
  assert.equal(r.mode, 'domain');
  const ref = r.results.find(x => x.url === `${F}/referrer`);
  assert.equal(ref.links.length, 3);
  const main = ref.links.find(l => l.href === 'https://target.test/');
  assert.equal(main.anchor, 'Target Site');
  assert.equal(main.nofollow, false);
  assert.match(main.context, /We recommend Target Site for great tools/);
  const sp = ref.links.find(l => l.href.includes('blog.'));
  assert.ok(sp.sponsored && sp.nofollow);
  const img = ref.links.find(l => l.image);
  assert.equal(img.anchor, '[image: Target logo]');
  assert.equal(img.placement, 'navigation');
  assert.equal(ref.indexable, true);
  const ni = r.results.find(x => x.url === `${F}/referrer-noindex`);
  assert.equal(ni.indexable, false);
  assert.equal(r.results.find(x => x.url === `${F}/good`).found, false);
  assert.equal(r.results.find(x => x.url === `${F}/gone`).status, 410);
  assert.ok(r.results.find(x => x.url === 'not a url').error);
  assert.equal(r.summary.pagesWithLinks, 2);
  assert.equal(ref.internal, false);
  // A referring page on the target's own site is flagged as internal.
  const own = await api.post('/seo/backlinks', { target: '127.0.0.1', pages: [`${F}/good`] });
  assert.equal(own.results[0].internal, true);
  assert.ok(own.results[0].links.length >= 2);
  // URL mode matches only that URL (ignoring trailing slash / www)
  const u = await api.post('/seo/backlinks', { target: 'https://www.target.test/pricing/', pages: [`${F}/referrer`] });
  assert.equal(u.mode, 'url');
  assert.equal(u.results[0].links.length, 1);
  await assert.rejects(api.post('/seo/backlinks', { target: 'x.test', pages: Array.from({ length: 51 }, (_, i) => `https://a.test/${i}`) }), /400/);
});

// ── keywords ─────────────────────────────────────────────────────────────────

test('keywords: text mode n-grams, stopwords and density', async () => {
  const text = 'Coffee beans are roasted. The best coffee beans come from Ethiopia! Roasted coffee beans smell great. Coffee, coffee, café — naïve straße.';
  const r = await api.post('/seo/keywords', { text, minLength: 3, stopwords: true, ngrams: 3 });
  const one = Object.fromEntries(r.grams[1].map(g => [g.term, g]));
  assert.equal(one.coffee.count, 5);
  assert.ok(!one.the && !one.are, 'stopwords removed');
  assert.ok(one['café'] && one['naïve'] && one['straße'], 'unicode tokens kept');
  assert.equal(one.coffee.density, Math.round((5 / r.stats.totalWords) * 10000) / 100);
  const two = Object.fromEntries(r.grams[2].map(g => [g.term, g]));
  assert.equal(two['coffee beans'].count, 3);
  assert.ok(!r.grams[2].some(g => g.term.startsWith('the ')), 'n-grams do not start with a stopword');
  assert.ok(!r.grams[2].some(g => g.term === 'beans come' && g.count > 1));
  const three = r.grams[3].map(g => g.term);
  assert.ok(!three.includes('roasted the best'), 'n-grams do not cross sentences');
  const all = await api.post('/seo/keywords', { text, stopwords: false, minLength: 1, ngrams: 1 });
  assert.ok(all.grams[1].some(g => g.term === 'the'));
  assert.equal(all.grams[2], undefined);
  await assert.rejects(api.post('/seo/keywords', {}), /400/);
});

ftest('keywords: URL mode reports prominence', async () => {
  const r = await api.post('/seo/keywords', { url: `${F}/good`, ngrams: 2 });
  const kw = r.grams[2].find(g => g.term === 'engine optimisation');
  assert.ok(kw, 'phrase found');
  assert.equal(kw.prominence.title, true);
  assert.equal(kw.prominence.h1, true);
  assert.equal(kw.prominence.description, false);
  assert.equal(r.source.title, 'Fixture good page about search engine optimisation');
  const good = r.grams[1].find(g => g.term === 'good');
  assert.equal(good?.prominence.url, true);
});

// ── sitemaps ─────────────────────────────────────────────────────────────────

test('sitemap-build: manual URLs → XML', async () => {
  const r = await api.post('/seo/sitemap-build', {
    urls: ['https://a.test/', 'https://a.test/x?y=1&z=2', 'https://a.test/', 'nope', 'ftp://a.test/f'], changefreq: 'weekly', priority: 0.8, lastmod: '2025-01-02',
  });
  assert.equal(r.count, 2);
  assert.equal(r.invalidCount, 2);
  assert.equal(r.duplicates, 1);
  assert.match(r.xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(r.xml, /<loc>https:\/\/a\.test\/x\?y=1&amp;z=2<\/loc>/);
  assert.match(r.xml, /<changefreq>weekly<\/changefreq>/);
  assert.match(r.xml, /<priority>0\.8<\/priority>/);
  assert.match(r.xml, /<lastmod>2025-01-02<\/lastmod>/);
  await assert.rejects(api.post('/seo/sitemap-build', { urls: [] }), /400/);
  await assert.rejects(api.post('/seo/sitemap-build', { urls: ['https://a.test/'], lastmod: 'yesterday' }), /400/);
});

test('sitemap-crawl converter is registered with options only', async () => {
  const caps = await api.get('/capabilities');
  const c = caps.converters.find(x => x.id === 'sitemap-crawl');
  assert.ok(c, 'registered');
  assert.equal(c.minFiles, 0);
  assert.equal(c.maxFiles, 0);
  assert.ok(c.options.some(o => o.key === 'startUrl'));
});

ftest('sitemap-crawl job: BFS crawl respects robots, noindex, canonicals, redirects and depth', async () => {
  const { job, outputs } = await runJob('sitemap-crawl', [], {
    startUrl: `${F}/`, maxPages: 50, maxDepth: 2, respectRobots: true, includeLastmod: true, priority: 'auto', changefreq: 'weekly',
  }, { timeoutMs: 120_000 });
  const names = job.outputs.map(o => o.filename);
  assert.deepEqual(names, ['sitemap.xml', 'urls.txt']);
  const xml = outputs[0].toString();
  const urls = outputs[1].toString().trim().split('\n');
  for (const p of ['/', '/good', '/about', '/deep/1', '/deep/2']) assert.ok(urls.includes(F + p), `expected ${p} in ${urls.join(', ')}`);
  for (const p of ['/noindex', '/redirect-1', '/canon-other', '/private/x', '/file.pdf', '/img.png', '/deep/3', '/nofollowed']) assert.ok(!urls.includes(F + p), `${p} must be excluded`);
  // /good?utm=1 is crawled (query kept) but excluded because its canonical is /good.
  assert.ok(job.meta.excluded.some(e => e.url === `${F}/good?utm=1` && e.reason === `canonical → ${F}/good`));
  assert.ok(!urls.some(u => u.includes('#')), 'fragments stripped');
  assert.ok(!urls.some(u => !u.startsWith(F)), 'stays on host');
  assert.match(xml, new RegExp(`<loc>${F}/</loc>\\s*<lastmod>2025-01-01T10:00:00\\+00:00</lastmod>\\s*<changefreq>weekly</changefreq>\\s*<priority>1.0</priority>`));
  assert.ok(job.meta.excluded.some(e => e.reason === 'noindex'));
  assert.ok(job.meta.excluded.some(e => /^robots\.txt/.test(e.reason)));
  assert.ok(job.meta.excluded.some(e => /^canonical/.test(e.reason)));
  assert.ok(job.meta.excluded.some(e => /^redirects to/.test(e.reason)));
  assert.ok(job.meta.durationMs > 0);
  assert.equal(job.meta.included, urls.length);
});

ftest('sitemap-crawl job: maxPages limit and failing start URL', async () => {
  const { job } = await runJob('sitemap-crawl', [], { startUrl: `${F}/`, maxPages: 3, maxDepth: 5, respectRobots: false }, { timeoutMs: 60_000 });
  assert.equal(job.meta.crawled, 3);
  assert.equal(job.meta.limitReached, true);
  await assert.rejects(runJob('sitemap-crawl', [], { startUrl: `${F}/gone` }, { timeoutMs: 60_000 }), /No indexable pages/);
});
