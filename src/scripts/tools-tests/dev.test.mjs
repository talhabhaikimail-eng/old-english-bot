import { api, assert, test } from './lib.mjs';

const html = (h, options = {}) => api.post('/dev/minify-html', { html: h, options });

// ── JS ───────────────────────────────────────────────────────────────────────
test('minify-js: compresses, mangles, reports sizes', async () => {
  const code = `/*! MIT license */\n// regular comment\nfunction add(first, second) {\n  console.log('adding');\n  return first + second;\n}\nexport const total = add(1, 2);\n`;
  const r = await api.post('/dev/minify-js', { code, options: { module: true, dropConsole: true, comments: 'license' } });
  assert.ok(r.code.includes('/*! MIT license */'), r.code);
  assert.ok(!r.code.includes('regular comment'));
  assert.ok(!r.code.includes('console.log'), r.code);
  assert.ok(!r.code.includes('first'), 'mangled');
  assert.ok(r.sizes.minified < r.sizes.original);
  assert.ok(r.sizes.gzipOriginal > 0 && r.sizes.gzipMinified > 0);
  assert.equal(typeof r.ms, 'number');
});

test('minify-js: options are honoured (no mangle, keep comments, source map)', async () => {
  const code = 'function longName(argument){ /* hi */ return argument * 2 }\nlongName(3);';
  const r = await api.post('/dev/minify-js', { code, options: { mangle: false, compress: false, comments: 'all', sourceMap: true } });
  assert.ok(r.code.includes('argument'));
  assert.ok(r.code.includes('/* hi */'));
  const map = JSON.parse(r.map);
  assert.equal(map.version, 3);
  assert.ok(map.sourcesContent[0].includes('longName'));
  assert.ok(r.code.includes('sourceMappingURL=script.min.js.map'));
});

test('minify-js: ES5 target keeps keep_fnames', async () => {
  const r = await api.post('/dev/minify-js', { code: 'var x = function named(a){ return a }; x(1);', options: { keepFnames: true, ecma: 5 } });
  assert.ok(r.code.includes('named'), r.code);
});

test('minify-js: syntax error → 400 with line/col', async () => {
  const res = await api.raw('/dev/minify-js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'let a = 1;\nfunction (' }) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.line, 2);
  assert.ok(body.col > 0);
  assert.match(body.error, /line 2/);
});

test('minify-js: missing / oversized code rejected', async () => {
  await assert.rejects(api.post('/dev/minify-js', {}), /400/);
  await assert.rejects(api.post('/dev/minify-js', { code: 'x'.repeat(5 * 1024 * 1024 + 10) }), /too long|413/);
});

// ── HTML ─────────────────────────────────────────────────────────────────────
test('minify-html: comments, whitespace between blocks, inline spacing kept', async () => {
  const r = await html(`<!DOCTYPE html>
<html>
  <head>
    <!-- remove me -->
    <title>  My   page  </title>
  </head>
  <body>
    <p>Hello   <b>bold</b>   <i>world</i> !</p>
    <ul>
      <li> one </li>
      <li>two</li>
    </ul>
  </body>
</html>`);
  assert.equal(r.html, '<!DOCTYPE html><html><head><title>My page</title></head><body><p>Hello <b>bold</b> <i>world</i> !</p><ul><li>one</li><li>two</li></ul></body></html>');
  assert.ok(r.sizes.minified < r.sizes.original);
  assert.ok(r.sizes.gzipMinified > 0);
});

test('minify-html: <pre> and <textarea> whitespace preserved', async () => {
  const src = '<div>\n  <pre>  line 1\n    <b>line  2</b>\n</pre>\n  <textarea>  a\n\n  b </textarea>\n  <p>  x  </p>\n</div>';
  const r = await html(src);
  assert.equal(r.html, '<div><pre>  line 1\n    <b>line  2</b>\n</pre><textarea>  a\n\n  b </textarea><p>x</p></div>');
});

test('minify-html: script containing "</div>" strings and non-JS script types', async () => {
  const src = `<div>
  <script>
    // comment
    const markup = "</div><p>not html</p>";
    function   greet( name ) { return "hi " + name; }
    document.body.insertAdjacentHTML('beforeend', markup + greet('x'));
  </script>
  <script type="text/template"><div>  {{ keep   me }}  </div></script>
  <script type="application/ld+json">
    { "@context": "https://schema.org", "name": "</script-ish>" }
  </script>
</div>`;
  const r = await html(src);
  assert.ok(r.html.includes('"</div><p>not html</p>"') || r.html.includes('"<\\/div><p>not html</p>"'), r.html);
  assert.ok(!r.html.includes('// comment'));
  assert.ok(r.html.includes('<script type="text/template"><div>  {{ keep   me }}  </div></script>'), r.html);
  assert.ok(r.html.includes('{"@context":"https://schema.org","name":"<\\/script-ish>"}'), r.html);
  assert.ok(r.html.startsWith('<div><script>') && r.html.endsWith('</script></div>'), r.html);
  assert.deepEqual(r.warnings, []);
});

test('minify-html: invalid inline JS is kept and reported', async () => {
  const r = await html('<script>function ( {</script><p>ok</p>');
  assert.ok(r.html.includes('function ( {'));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /left unminified/);
});

test('minify-html: attributes with > in quotes, booleans, empty attrs, optional quotes', async () => {
  const src = `<input type="checkbox" checked="checked" disabled="" data-x="a > b" class="  a   b  " id="" title='say "hi"' onclick="">
<a href="/path" data-y=unquoted>link</a>
<img src="a.png" alt="" />`;
  const r = await html(src, { removeOptionalQuotes: true });
  assert.ok(r.html.includes('<input type=checkbox checked disabled data-x="a > b" class="a b" title=\'say "hi"\'>'), r.html);
  assert.ok(r.html.includes('<a href=/path data-y=unquoted>link</a>'), r.html);
  assert.ok(r.html.includes('<img src=a.png alt=""/>'), r.html);
  // self-closing: last unquoted value must not swallow the slash
  const r2 = await html('<svg><path d="M0 0" fill="red"/><use href="a/"/></svg>', { removeOptionalQuotes: true });
  assert.ok(r2.html.includes('<path d="M0 0" fill=red/>') && r2.html.includes('<use href="a/"/>'), r2.html);
});

test('minify-html: IE conditional comments and /*! comments survive', async () => {
  const src = '<head><!--[if lt IE 9]><script src="html5shiv.js"></script><![endif]--><!-- gone --><!--! keep --></head>';
  const r = await html(src);
  assert.equal(r.html, '<head><!--[if lt IE 9]><script src="html5shiv.js"></script><![endif]--><!--! keep --></head>');
});

test('minify-html: inline CSS (style tag + attribute) minified safely', async () => {
  const src = `<style>
  /* c */
  .a  >  .b { content: "  x ; y  "; width: calc( 100% - 10px ); background: url( "a b.png" ); }
  @media (max-width: 600px) { .c { margin: 0.5em auto } }
</style>
<div style="color : red ;  margin : 0 auto ;">x</div>
<style type="text/x-less">.a { .b; }</style>`;
  const r = await html(src);
  assert.ok(r.html.includes('<style>.a>.b{content:"  x ; y  ";width:calc(100% - 10px);background:url("a b.png")}@media (max-width:600px){.c{margin:.5em auto}}</style>'), r.html);
  assert.ok(r.html.includes('<div style="color:red;margin:0 auto">x</div>'), r.html);
  assert.ok(r.html.includes('<style type="text/x-less">.a { .b; }</style>'), r.html);
});

test('minify-html: all options off is a no-op except tag re-serialisation', async () => {
  const src = '<div>\n  <!-- c -->\n  <p class="a">x</p>\n</div>';
  const r = await html(src, { removeComments: false, collapseWhitespace: false, minifyJs: false, minifyCss: false, removeEmptyAttributes: false, collapseBooleanAttributes: false });
  assert.equal(r.html, src);
});

test('minify-html: conservative collapse keeps one space', async () => {
  const r = await html('<div>\n  <span>a</span>\n  <span>b</span>\n</div>', { conservativeCollapse: true });
  assert.equal(r.html, '<div> <span>a</span> <span>b</span> </div>');
});

test('minify-html: removes comments that split text, keeps text spacing', async () => {
  const r = await html('<p>a <!-- x --> b</p>');
  assert.equal(r.html, '<p>a b</p>');
});

test('minify-html: stray < and unclosed tags do not crash', async () => {
  const r = await html('<p>1 < 2 and 3 <= 4</p><div><span>open');
  assert.equal(r.html, '<p>1 < 2 and 3 <= 4</p><div><span>open');
});

// ── CSS ──────────────────────────────────────────────────────────────────────
test('minify-css: works and reports errors with line', async () => {
  const r = await api.post('/dev/minify-css', { css: '/*! l */ a :hover , b > c { color : red ; }' });
  assert.equal(r.css, '/*! l */a :hover,b>c{color:red}');
  const res = await api.raw('/dev/minify-css', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ css: 'a {\n color: red;\n' }) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Unclosed/);
  assert.equal(body.line, 1);
});
