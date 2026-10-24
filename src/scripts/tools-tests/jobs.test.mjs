import { api, assert, test } from './lib.mjs';

test('capabilities lists binaries and converters', async () => {
  const caps = await api.get('/capabilities');
  assert.equal(typeof caps.binaries.python, 'boolean');
  assert.ok(Array.isArray(caps.converters));
});

test('unknown converter is rejected with 404', async () => {
  await assert.rejects(api.postForm('/jobs', { converter: 'nope' }, [{ name: 'a.txt', data: 'x' }]), /404/);
});

test('unknown tools route is 404', async () => {
  const res = await api.raw('/does-not-exist');
  assert.equal(res.status, 404);
});

test('missing job is 404', async () => {
  const res = await api.raw('/jobs/00000000-0000-0000-0000-000000000000');
  assert.equal(res.status, 404);
});
