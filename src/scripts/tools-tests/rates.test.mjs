import { api, assert, test } from './lib.mjs';

test('rates: USD returns structured rates with a positive EUR rate', async () => {
  const r = await api.get('/rates?base=USD');
  assert.equal(r.base, 'USD');
  assert.equal(typeof r.source, 'string');
  assert.ok(!Number.isNaN(Date.parse(r.updatedAt)), 'updatedAt is an ISO date');
  assert.equal(r.rates.USD, 1);
  assert.ok(r.rates.EUR > 0 && r.rates.EUR < 10, `EUR rate ${r.rates.EUR}`);
  assert.ok(Object.keys(r.rates).length >= 25, 'has many currencies');
  for (const [k, v] of Object.entries(r.rates)) {
    assert.match(k, /^[A-Z]{3}$/);
    assert.ok(typeof v === 'number' && v > 0);
  }
  assert.equal(typeof r.names, 'object');
  assert.equal(r.names.EUR, 'Euro');
});

test('rates: second call is served from cache', async () => {
  await api.get('/rates?base=USD');
  const t0 = Date.now();
  const r = await api.get('/rates?base=USD');
  assert.equal(r.cached, true);
  assert.ok(Date.now() - t0 < 500, 'cached call is fast');
});

test('rates: base is case-insensitive and defaults to USD', async () => {
  const r = await api.get('/rates?base=eur');
  assert.equal(r.base, 'EUR');
  assert.equal(r.rates.EUR, 1);
  assert.ok(r.rates.USD > 0);
  const d = await api.get('/rates');
  assert.equal(d.base, 'USD');
});

test('rates: invalid base is rejected with 400', async () => {
  for (const bad of ['US', 'USDX', '12A', 'U$D', '../x']) {
    const res = await api.raw('/rates?base=' + encodeURIComponent(bad));
    assert.equal(res.status, 400, `base=${bad}`);
    const body = await res.json();
    assert.match(body.error, /3-letter/);
  }
});

test('rates: POST is not allowed', async () => {
  const res = await api.raw('/rates', { method: 'POST' });
  assert.equal(res.status, 405);
});
