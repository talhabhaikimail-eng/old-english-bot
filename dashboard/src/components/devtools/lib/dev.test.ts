// Run: node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/dev.test.ts
import assert from 'node:assert/strict';
import * as D from './dev';

let passed = 0;
const failed: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed.push(name); console.log(`  ✗ ${name}\n      ${String((e as Error).stack).split('\n').slice(0, 5).join('\n      ')}`); }
}

// ── XML ──────────────────────────────────────────────────────────────────────
test('xml: pretty print with nested + text-only + empty', () => {
  const out = D.formatXml('<?xml version="1.0"?><a x="1"><b>hi</b><c/><d></d><!-- note --></a>', { indent: '  ', collapseEmpty: true });
  assert.equal(out, '<?xml version="1.0"?>\n<a x="1">\n  <b>hi</b>\n  <c/>\n  <d/>\n  <!-- note -->\n</a>');
});
test('xml: attrs per line', () => {
  const out = D.formatXml('<a x="1" y=\'2\'><b/></a>', { indent: '  ', attrsPerLine: true });
  assert.equal(out, "<a\n  x=\"1\"\n  y='2'>\n  <b/>\n</a>");
});
test('xml: mixed content kept inline, xml:space preserved', () => {
  const out = D.formatXml('<r><p>Hello <b>world</b>!</p><q xml:space="preserve">  a  <i>b</i> </q></r>', { indent: '  ' });
  assert.equal(out, '<r>\n  <p>Hello <b>world</b>!</p>\n  <q xml:space="preserve">  a  <i>b</i> </q>\n</r>');
});
test('xml: cdata and doctype pass through', () => {
  const out = D.formatXml('<!DOCTYPE note [<!ENTITY a "b">]><n><![CDATA[<x> & y]]></n>', { indent: '\t' });
  assert.equal(out, '<!DOCTYPE note [<!ENTITY a "b">]>\n<n><![CDATA[<x> & y]]></n>');
});
test('xml: errors report line/col', () => {
  assert.throws(() => D.parseXml('<a>\n  <b></c>\n</a>'), (e: D.SourceError) => e.line === 2 && /does not match <b>/.test(e.message));
  assert.throws(() => D.parseXml('<a><b></a>'), /does not match/);
  assert.throws(() => D.parseXml('<a x=1/>'), /must be quoted/);
  assert.throws(() => D.parseXml('<a x="1" x="2"/>'), /Duplicate/);
  assert.throws(() => D.parseXml('<a/><b/>'), /one root/);
  assert.throws(() => D.parseXml('<a>'), /Unclosed element <a>/);
  assert.throws(() => D.parseXml('<a> 1 < 2 </a>'), /Invalid tag name/);
});
test('xml: minify', () => {
  assert.equal(D.minifyXml('<a>\n  <b> x  y </b>\n  <!-- c -->\n  <c></c>\n</a>'), '<a><b> x y </b><c/></a>');
});

// ── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `/*! keep me */
@import url("a.css");
@charset "utf-8";
/* drop */
.a  >  .b ,  .c:hover  { color : red ;  margin : 0.50px  auto ; }
div :is(.x, .y) { width: calc( 100% - (2 * 10px) ); background: url( data:image/png;base64,AAA= ) no-repeat; }
@media (min-width: 600px) and (max-width : 900px) { .d { content: "a  ;  {b}"; font: 12px/1.5 "Open Sans", sans-serif !important; } }
.empty {}
.n { &:hover { color: blue } .m & { top: -0.5em } }
`;
test('css: minify is string/url/calc safe', () => {
  const min = D.minifyCss(CSS);
  assert.ok(min.startsWith('/*! keep me */@import url("a.css");@charset "utf-8";'));
  assert.ok(!min.includes('drop'));
  assert.ok(min.includes('.a>.b,.c:hover{color:red;margin:.5px auto}'), min);
  assert.ok(min.includes('div :is(.x,.y){width:calc(100% - (2 * 10px));background:url(data:image/png;base64,AAA=) no-repeat}'), min);
  assert.ok(min.includes('@media (min-width:600px) and (max-width:900px){.d{content:"a  ;  {b}";font:12px/1.5 "Open Sans",sans-serif!important}}'), min);
  assert.ok(!min.includes('.empty'));
  assert.ok(min.includes('.n{&:hover{color:blue}.m &{top:-.5em}}'), min);
});
test('css: beautify + sort', () => {
  const out = D.beautifyCss('b{z-index:1;-webkit-transition:a;transition:a;--x:1;color:red}a,b>c{color:blue}', { indent: '  ', sortProperties: true });
  assert.equal(out, 'b {\n  --x: 1;\n  color: red;\n  -webkit-transition: a;\n  transition: a;\n  z-index: 1;\n}\n\na,\nb > c {\n  color: blue;\n}');
});
test('css: beautify keeps nth-child and nested at-rules', () => {
  const out = D.beautifyCss('@media screen{li:nth-child(2n+1){color:red}}', { indent: '  ' });
  assert.equal(out, '@media screen {\n  li:nth-child(2n+1) {\n    color: red;\n  }\n}');
});
test('css: errors', () => {
  assert.throws(() => D.parseCss('a { color: red;'), /Unclosed/);
  assert.throws(() => D.parseCss('a { color: red; }}'), /Unexpected "}"/);
  assert.throws(() => D.parseCss('a { content: "x }'), /Unterminated string/);
  assert.throws(() => D.parseCss('a { color red }'), /Expected "property: value"/);
});
test('css: stats', () => {
  const s = D.cssStats(CSS);
  assert.equal(s.rules, 7);
  assert.equal(s.media, 1);
  assert.equal(s.important, 1);
});

// ── entities ─────────────────────────────────────────────────────────────────
test('entities: encode modes', () => {
  const s = `<a href="x">Café © 2024 — 😀 & 'q'</a>`;
  assert.equal(D.encodeEntities(s, 'minimal'), '&lt;a href=&quot;x&quot;&gt;Café © 2024 — 😀 &amp; &#39;q&#39;&lt;/a&gt;');
  assert.equal(D.encodeEntities('Café © — 😀', 'named'), 'Caf&eacute; &copy; &mdash; &#x1F600;');
  assert.equal(D.encodeEntities('é😀', 'numeric', { hex: false }), '&#233;&#128512;');
});
test('entities: decode basic', () => {
  assert.equal(D.decodeEntitiesBasic('&lt;b&gt; &amp;amp; &eacute; &#x1F600; &#169; &bogus;'), '<b> &amp; é 😀 © &bogus;');
});

// ── YAML ─────────────────────────────────────────────────────────────────────
test('yaml: round trip + multi-doc + error position', () => {
  const y = D.jsonToYaml('{"a":1,"b":[true,null,"yes"],"c":{"d":"x: y"}}');
  assert.equal(y.output, "a: 1\nb:\n  - true\n  - null\n  - 'yes'\nc:\n  d: 'x: y'\n");
  const back = D.yamlToJson(y.output);
  assert.deepEqual(JSON.parse(back.output), { a: 1, b: [true, null, 'yes'], c: { d: 'x: y' } });
  const multi = D.yamlToJson('a: 1\n---\nb: 2\n');
  assert.equal(multi.docs, 2);
  assert.deepEqual(JSON.parse(multi.output), [{ a: 1 }, { b: 2 }]);
  const bad = D.yamlToJson('a: 1\n b: [');
  assert.ok(bad.error && bad.line === 2, JSON.stringify(bad));
  const badJson = D.jsonToYaml('{\n "a": 1,\n}');
  assert.ok(badJson.error && badJson.line === 3, JSON.stringify(badJson));
  assert.equal(D.jsonToYaml('[{"a":1},{"b":2}]', { multiDoc: true }).output, '---\na: 1\n---\nb: 2\n');
});

// ── SQL ──────────────────────────────────────────────────────────────────────
test('sql: strip comments keeps strings intact', () => {
  const sql = "SELECT '-- not a comment', \"col\" /* c */ FROM t -- trailing\nWHERE x = 'it''s'";
  assert.equal(D.sanitizeSql(sql, { stripComments: true, collapseWhitespace: true }), `SELECT '-- not a comment', "col" FROM t WHERE x = 'it''s'`);
});
test('sql: collapse keeps line comment terminated', () => {
  assert.equal(D.sanitizeSql('select 1 -- c\nfrom   t', { collapseWhitespace: true }), 'select 1 -- c\nfrom t');
});
test('sql: identifier quotes + smart quotes', () => {
  assert.equal(D.sanitizeSql('SELECT `a`, [b c], "d" FROM t', { identifierQuotes: 'ansi' }), 'SELECT "a", "b c", "d" FROM t');
  assert.equal(D.sanitizeSql('SELECT "a" FROM t', { identifierQuotes: 'mysql' }), 'SELECT `a` FROM t');
  assert.equal(D.sanitizeSql('WHERE name = ‘bob’', { smartQuotes: true }), "WHERE name = 'bob'");
});
test('sql: parameterize', () => {
  const r = D.parameterizeSql("SELECT * FROM t1 WHERE a = 'x''y' AND b IN (1, 2.5, -3) AND c::int > 0x1F LIMIT 10", '$n');
  assert.equal(r.sql, 'SELECT * FROM t1 WHERE a = $1 AND b IN ($2, $3, $4) AND c::int > $5 LIMIT $6');
  assert.deepEqual(r.params, ["x'y", 1, 2.5, -3, 31, 10]);
  const q = D.parameterizeSql('UPDATE t SET a = a - 1 WHERE id = ?', '?');
  assert.equal(q.sql, 'UPDATE t SET a = a - ? WHERE id = ?');
  assert.deepEqual(q.params, [1]);
});

// ── cURL ─────────────────────────────────────────────────────────────────────
test('shellSplit: quoting styles', () => {
  assert.deepEqual(D.shellSplit(`curl 'a b' "c \\"d\\" $x" e\\ f $'g\\nh'`), ['curl', 'a b', 'c "d" $x', 'e f', 'g\nh']);
  assert.deepEqual(D.shellSplit('curl \\\n  -H "x: y" \\\r\n  u'), ['curl', '-H', 'x: y', 'u']);
  assert.deepEqual(D.shellSplit('curl ^"https://a.com/?q=1^&r=2^" ^\n  -H ^"accept: */*^"'), ['curl', 'https://a.com/?q=1&r=2', '-H', 'accept: */*']);
});
test('parseCurl: JSON POST with headers, auth, flags', () => {
  const { model } = D.parseCurl(`curl -sSL -X POST 'https://api.example.com/v1/items?limit=10&q=a%20b' \\
    -H 'Content-Type: application/json' -H "Authorization: Bearer tok123" \\
    --data-raw '{"name":"x","n":1}' --compressed -k -m 30 -A 'my-agent' -b 'sid=1'`);
  assert.equal(model.method, 'POST');
  assert.equal(model.url, 'https://api.example.com/v1/items');
  assert.deepEqual(model.query.map(q => [q.key, q.value]), [['limit', '10'], ['q', 'a b']]);
  assert.equal(model.bodyType, 'json');
  assert.equal(model.body, '{\n  "name": "x",\n  "n": 1\n}');
  assert.equal(model.auth.type, 'bearer');
  assert.equal(model.auth.token, 'tok123');
  assert.ok(model.flags.location && model.flags.silent && model.flags.compressed && model.flags.insecure);
  assert.equal(model.timeout, 30);
  assert.deepEqual(model.headers.map(h => h.key), ['User-Agent', 'Cookie']);
});
test('parseCurl: form, urlencode, multipart, basic, -G, -XPUT', () => {
  let r = D.parseCurl("curl -d 'a=1&b=two%20x' https://x.io/form");
  assert.equal(r.model.method, 'POST');
  assert.equal(r.model.bodyType, 'form');
  assert.deepEqual(r.model.form.map(f => [f.key, f.value]), [['a', '1'], ['b', 'two x']]);
  r = D.parseCurl("curl --data-urlencode 'msg=hello world&more' https://x.io");
  assert.deepEqual(r.model.form.map(f => [f.key, f.value]), [['msg', 'hello world&more']]);
  r = D.parseCurl("curl -F 'file=@/tmp/a.png;type=image/png' -F name=bob -u user:p@ss https://x.io/up");
  assert.equal(r.model.bodyType, 'multipart');
  assert.deepEqual(r.model.multipart.map(f => [f.key, f.value, !!f.isFile]), [['file', '/tmp/a.png', true], ['name', 'bob', false]]);
  assert.deepEqual([r.model.auth.type, r.model.auth.user, r.model.auth.pass], ['basic', 'user', 'p@ss']);
  r = D.parseCurl('curl -G -d q=1 -d r=2 example.com/s');
  assert.equal(r.model.method, 'GET');
  assert.equal(r.model.url, 'http://example.com/s');
  assert.deepEqual(r.model.query.map(q => q.key), ['q', 'r']);
  r = D.parseCurl("curl -XPUT https://x.io -H 'Authorization: Basic dXNlcjpwYXNz' --data 'raw text'");
  assert.equal(r.model.method, 'PUT');
  assert.equal(r.model.bodyType, 'raw');
  assert.deepEqual([r.model.auth.user, r.model.auth.pass], ['user', 'pass']);
  r = D.parseCurl('curl -I https://x.io -e https://ref.io');
  assert.equal(r.model.method, 'HEAD');
  assert.equal(r.model.headers[0].key, 'Referer');
  assert.throws(() => D.parseCurl('wget x'), /must start with "curl"/);
  assert.throws(() => D.parseCurl('curl -H "x: y"'), /No URL/);
});
test('toCurl → parseCurl round trip', () => {
  const m = D.emptyRequest();
  m.method = 'PATCH'; m.url = 'https://api.x.io/u/1'; m.query = [{ key: 'v', value: '2 3' }];
  m.headers = [{ key: 'X-Test', value: "it's" }];
  m.bodyType = 'json'; m.body = '{"a":"b c"}';
  m.auth = { ...m.auth, type: 'basic', user: 'u', pass: 'p' };
  m.flags.location = true; m.timeout = 5;
  const c = D.toCurl(m, 'bash');
  assert.ok(c.includes("-H 'X-Test: it'\\''s'"), c);
  const back = D.parseCurl(c).model;
  assert.equal(back.method, 'PATCH');
  assert.deepEqual(back.query.map(q => q.value), ['2 3']);
  assert.equal(JSON.parse(back.body).a, 'b c');
  assert.equal(back.auth.user, 'u');
  assert.equal(back.timeout, 5);
  const ps = D.toCurl(m, 'powershell');
  assert.ok(ps.startsWith('curl.exe') && ps.includes("'X-Test: it''s'") && ps.includes(' `\n  '), ps);
  const cmd = D.toCurl(m, 'cmd');
  assert.ok(cmd.includes('"{\\"a\\":\\"b c\\"}"') && cmd.includes(' ^\n  '), cmd);
});
test('code generators produce sane output', () => {
  const m = D.emptyRequest();
  m.method = 'POST'; m.url = 'https://x.io/a'; m.bodyType = 'json'; m.body = '{"ok":true,"n":null}';
  m.auth = { ...m.auth, type: 'bearer', token: 't' };
  assert.ok(D.toFetch(m).includes(`Authorization: 'Bearer t'`));
  assert.ok(D.toFetch(m).includes('JSON.stringify({'));
  const py = D.toPython(m);
  assert.ok(py.includes('"ok": True') && py.includes('"n": None') && py.includes('json=payload'), py);
  assert.ok(D.toAxios(m).includes(`method: 'post'`));
  assert.ok(D.toHttpie(m).includes('--auth-type=bearer'));
  const go = D.toGo(m);
  assert.ok(go.includes('"strings"') && go.includes('http.NewRequest("POST"'), go);
  m.bodyType = 'form'; m.form = [{ key: 'a', value: '1' }];
  assert.ok(D.toGo(m).includes('form.Set("a", "1")'));
  assert.ok(D.toCurl(m).includes("--data-urlencode a=1"));
});

// ── robots ───────────────────────────────────────────────────────────────────
const ROBOTS = `User-agent: *
Disallow: /admin/
Allow: /admin/public/
Disallow: /*.pdf$
Disallow: /search

User-agent: Googlebot
User-agent: Bingbot
Disallow: /nogoogle
Crawl-delay: 5

User-agent: GPTBot
Disallow: /

Sitemap: https://x.io/sitemap.xml`;
test('robots: parse/generate round trip', () => {
  const m = D.parseRobots(ROBOTS);
  assert.equal(m.groups.length, 3);
  assert.deepEqual(m.groups[1].agents, ['Googlebot', 'Bingbot']);
  assert.equal(m.groups[1].crawlDelay, 5);
  assert.deepEqual(m.sitemaps, ['https://x.io/sitemap.xml']);
  const again = D.parseRobots(D.generateRobots(m));
  assert.deepEqual(again.groups.map(g => g.disallow), m.groups.map(g => g.disallow));
});
test('robots: longest match, allow wins ties, wildcards, UA selection', () => {
  const t = (ua: string, p: string) => D.robotsAllows(ROBOTS, ua, p).allowed;
  assert.equal(t('*', '/admin/x'), false);
  assert.equal(t('*', '/admin/public/a'), true);
  assert.equal(t('*', '/files/a.pdf'), false);
  assert.equal(t('*', '/files/a.pdf?x=1'), true);
  assert.equal(t('*', '/searching'), false);
  assert.equal(t('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', '/admin/x'), true); // own group, no /admin rule
  assert.equal(t('googlebot', '/nogoogle/x'), false);
  assert.equal(t('GPTBot/1.0', '/'), false);
  assert.equal(t('GPTBot', '/robots.txt'), true);
  assert.equal(D.robotsAllows('User-agent: *\nDisallow: /a\nAllow: /a', 'x', '/a').allowed, true);
  assert.equal(D.robotsAllows('User-agent: *\nDisallow: /', 'x', 'https://x.io/page').allowed, false);
  assert.equal(D.robotsAllows('User-agent: *\nDisallow:', 'x', '/page').allowed, true);
});

// ── htaccess / meta ──────────────────────────────────────────────────────────
test('htaccess: generates sections', () => {
  const h = D.generateHtaccess({
    forceHttps: true, www: 'non-www', trailingSlash: 'none', redirects: [{ from: '/old-page.html', to: '/new', code: '301' }],
    errorPages: [{ code: '404', path: '/404.html' }], compression: true, caching: true,
    cache: { html: '0 seconds', css: '1 year', js: '1 year', images: '1 year', fonts: '1 year', media: '' },
    hsts: true, hstsPreload: false, nosniff: true, frameOptions: 'SAMEORIGIN', referrerPolicy: 'strict-origin-when-cross-origin',
    permissionsPolicy: false, csp: '', noIndexes: true, blockIps: ['1.2.3.4'], hotlink: true, hotlinkDomain: 'https://www.example.com/', hotlinkExts: 'png jpg',
    spaFallback: true, protectDotfiles: true, noSignature: false, charset: false,
  });
  assert.ok(h.includes('RewriteRule ^old-page\\.html/?$ /new [L,R=301]'));
  assert.ok(h.includes('example\\.com/ [NC]'));
  assert.ok(h.includes('Require not ip 1.2.3.4'));
  assert.ok(h.includes('ErrorDocument 404 /404.html'));
  assert.ok(h.includes('RewriteRule ^ index.html [L]'));
  assert.ok(h.includes('RewriteRule \\.(png|jpg)$ - [F,NC,L]'));
});
test('meta: escapes and includes OG/twitter', () => {
  const out = D.generateMetaTags({
    title: 'A "quoted" <title>', description: 'Desc & more', keywords: '', author: '', canonical: 'https://x.io/', robotsIndex: true, robotsFollow: false,
    viewport: true, charset: true, themeColor: '#000000', lang: 'en', ogType: 'website', ogImage: 'https://x.io/og.png', ogImageAlt: 'alt',
    siteName: 'X', locale: 'en_US', url: '', twitterCard: 'summary_large_image', twitterSite: 'xio', twitterCreator: '', favicon: '/favicon.svg', appleTouchIcon: '', manifest: '',
  });
  assert.ok(out.includes('<title>A "quoted" &lt;title&gt;</title>'));
  assert.ok(out.includes('<meta property="og:title" content="A &quot;quoted&quot; &lt;title&gt;">'));
  assert.ok(out.includes('content="index, nofollow"'));
  assert.ok(out.includes('<meta name="twitter:site" content="@xio">'));
  assert.ok(out.includes('<meta property="og:url" content="https://x.io/">'));
  assert.ok(out.includes('type="image/svg+xml"'));
});

// ── compose ──────────────────────────────────────────────────────────────────
test('compose: to YAML collects volumes/networks, long depends_on', () => {
  const db = D.COMPOSE_TEMPLATES.postgres.make();
  const app = D.COMPOSE_TEMPLATES.node.make();
  app.dependsOn = [{ name: 'db', condition: 'service_healthy' }];
  app.networks = ['backend'];
  db.networks = ['backend'];
  app.cpus = '0.5'; app.memory = '512M';
  const y = D.composeToYaml({ name: 'demo', services: [app, db] });
  assert.ok(y.includes('volumes:\n  pgdata:\n'), y);
  assert.ok(y.includes('networks:\n  backend:\n'), y);
  assert.ok(y.includes('depends_on:\n      db:\n        condition: service_healthy'), y);
  assert.ok(y.includes("test:\n        - CMD-SHELL\n        - pg_isready -U app -d app"), y);
  assert.ok(y.includes("limits:\n          cpus: '0.5'\n          memory: 512M"), y);
  assert.ok(y.includes('build: .\n'), y);
  const back = D.composeFromYaml(y);
  assert.equal(back.services.length, 2);
  assert.equal(back.services[0].dependsOn[0].condition, 'service_healthy');
  assert.equal(back.services[1].healthcheck?.test, 'pg_isready -U app -d app');
  assert.equal(back.services[1].volumes[0].source, 'pgdata');
  assert.equal(back.services[0].memory, '512M');
});
test('compose: import list env, long ports/volumes, windows paths', () => {
  const m = D.composeFromYaml(`services:
  web:
    image: nginx
    environment: ["A=1", "B=x=y"]
    ports: [{target: 80, published: 8080}]
    volumes: ["C:\\\\data:/data:ro", {type: bind, source: ./x, target: /x}]
    depends_on: [api]
    command: ["npm", "run", "start dev"]
`);
  const s = m.services[0];
  assert.deepEqual(s.env.map(e => [e.key, e.value]), [['A', '1'], ['B', 'x=y']]);
  assert.deepEqual(s.ports, ['8080:80']);
  assert.deepEqual(s.volumes, [{ source: 'C:\\data', target: '/data', readOnly: true }, { source: './x', target: '/x', readOnly: false }]);
  assert.equal(s.command, 'npm run "start dev"');
  assert.throws(() => D.composeFromYaml('foo: 1'), /services/);
});

// ── SVG → JSX ────────────────────────────────────────────────────────────────
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="24" height="24" class="icon" onload="alert(1)">
  <!-- comment -->
  <style>.a{fill:red}</style>
  <path fill-rule="evenodd" stroke-width="2" fill="#333" style="stop-color: red; -ms-transform: none; --x: 1" d="M0 0h24"/>
  <use xlink:href="#a" xml:space="preserve"/>
  <text font-size="12">a {b}</text>
  <script>alert(1)</script>
</svg>`;
test('svg→jsx: attribute conversion and options', () => {
  const out = D.svgToJsx(SVG, { name: 'my-icon.svg', typescript: true, memo: true, forwardRef: true, spreadProps: true, removeDimensions: true, removeXmlns: true, currentColor: true, removeEditorData: true, exportDefault: true });
  assert.ok(out.includes("import { forwardRef, memo } from 'react';"), out);
  assert.ok(out.includes("import type { SVGProps } from 'react';"));
  assert.ok(out.includes('const MyIconBase = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>((props, ref) => ('), out);
  assert.ok(out.includes('const MyIcon = memo(MyIconBase);'));
  assert.ok(out.includes('export default MyIcon;'));
  assert.ok(out.includes('className="icon"'));
  assert.ok(out.includes('viewBox="0 0 24 24"'), out);
  assert.ok(!out.includes('width="24"') && !out.includes('xmlns') && !out.includes('onload') && !out.includes('alert'), out);
  assert.ok(out.includes('fillRule="evenodd"') && out.includes('strokeWidth="2"') && out.includes('fill="currentColor"'));
  assert.ok(out.includes("style={{ stopColor: 'red', msTransform: 'none', '--x': 1 }}"), out);
  assert.ok(out.includes('xlinkHref="#a"') && out.includes('xmlSpace="preserve"'));
  assert.ok(out.includes("{'a {b}'}"), out);
  assert.ok(out.includes('<style>{`.a{fill:red}`}</style>'), out);
  assert.ok(out.includes('ref={ref}') && out.includes('{...props}'));
});
test('svg→jsx: plain JS named export', () => {
  const out = D.svgToJsx('<svg viewBox="0 0 1 1"><circle cx="1"/></svg>', { name: 'Dot', typescript: false, memo: false, forwardRef: false, spreadProps: true, removeDimensions: false, removeXmlns: true, currentColor: false, removeEditorData: true, exportDefault: false });
  assert.ok(out.includes('export const Dot = (props) => ('), out);
  assert.ok(out.includes('<circle cx="1" />'), out);
  assert.throws(() => D.svgToJsx('<div/>', { name: 'X' } as D.SvgJsxOptions), /root element must be <svg>/);
});

// ── QR payloads / misc ───────────────────────────────────────────────────────
test('qr payloads', () => {
  assert.equal(D.wifiPayload('My;Net', 'p:a"ss', 'WPA', true), 'WIFI:T:WPA;S:My\\;Net;P:p\\:a\\"ss;H:true;;');
  assert.equal(D.wifiPayload('Open', '', 'nopass', false), 'WIFI:T:nopass;S:Open;;');
  assert.equal(D.mailtoPayload('a@b.c', 'Hi there', 'x&y'), 'mailto:a@b.c?subject=Hi%20there&body=x%26y');
  assert.equal(D.smsPayload('+1 (555) 123', 'hey'), 'SMSTO:+1555123:hey');
  const v = D.vcardPayload({ first: 'Jane', last: 'Doe', org: 'A, Inc', title: '', phone: '', mobile: '+1', email: 'j@d.io', url: '', street: '', city: 'X', zip: '', country: '', note: '' });
  assert.ok(v.includes('N:Doe;Jane;;;') && v.includes('ORG:A\\, Inc') && v.includes('ADR;TYPE=WORK:;;;X;;;'));
});
test('css generators', () => {
  assert.equal(D.shadowCss([{ x: 0, y: 4, blur: 6, spread: -1, color: '#000000', alpha: 0.1, inset: false }, { x: 1, y: 1, blur: 0, spread: 0, color: '#ff0000', alpha: 1, inset: true }]),
    '0px 4px 6px -1px rgb(0 0 0 / 0.1), inset 1px 1px 0px 0px rgb(255 0 0)');
  assert.equal(D.tailwindArbitrary('shadow', '0px 4px 6px rgb(0 0 0 / 0.1), 0 1px 2px red'), 'shadow-[0px_4px_6px_rgb(0_0_0_/_0.1),0_1px_2px_red]');
  assert.equal(D.radiusCss({ tl: 8, tr: 8, br: 8, bl: 8, unit: 'px' }), '8px');
  assert.equal(D.radiusCss({ tl: 8, tr: 0, br: 8, bl: 0, unit: 'px' }), '8px 0');
  assert.equal(D.radiusCss({ tl: 1, tr: 2, br: 3, bl: 2, unit: 'rem' }), '1rem 2rem 3rem');
  assert.equal(D.blobRadiusCss([30, 70, 70, 30], [30, 30, 70, 70]), '30% 70% 70% 30% / 30% 30% 70% 70%');
  assert.equal(D.shade('#808080', 1), '#ffffff');
  assert.equal(D.shade('#808080', -1), '#000000');
  assert.ok(D.neumorphismCss({ color: '#e0e0e0', distance: 10, intensity: 0.15, blur: 20, radius: 30, shape: 'pressed' }).includes('inset 10px 10px 20px'));
});
test('cubic-bezier parse/eval', () => {
  assert.deepEqual(D.parseBezier('cubic-bezier(0.68, -0.6, 0.32, 1.6)'), [0.68, -0.6, 0.32, 1.6]);
  assert.deepEqual(D.parseBezier('.25,.1,.25,1'), [0.25, 0.1, 0.25, 1]);
  assert.deepEqual(D.parseBezier('ease-in-out'), [0.42, 0, 0.58, 1]);
  assert.deepEqual(D.parseBezier('transition-timing-function: cubic-bezier(0 0 1 1);'), [0, 0, 1, 1]);
  assert.equal(D.parseBezier('cubic-bezier(2, 0, 1, 1)'), null);
  assert.ok(Math.abs(D.bezierY([0, 0, 1, 1], 0.3) - 0.3) < 1e-4);
  assert.ok(Math.abs(D.bezierY(D.BEZIER_PRESETS.ease, 0.5) - 0.8024) < 1e-3);
  assert.equal(D.bezierCss([0.1234, 0, 1, 1]), 'cubic-bezier(0.123, 0, 1, 1)');
});
test('ws close codes', () => {
  assert.match(D.describeCloseCode(1006), /Abnormal/);
  assert.match(D.describeCloseCode(4001), /Application/);
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.map(f => '  - ' + f).join('\n')); process.exitCode = 1; }
