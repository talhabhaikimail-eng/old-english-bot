import { createHash, createPrivateKey, createPublicKey, sign, verify, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, assert, test } from './lib.mjs';

// ── hashing ──────────────────────────────────────────────────────────────────

test('hash: known vectors for "abc"', async () => {
  const r = await api.post('/crypto/hash', {
    text: 'abc', algorithms: ['md5', 'sha1', 'sha256', 'sha512', 'sha3-256', 'ripemd160', 'blake2b512', 'crc32'],
  });
  assert.equal(r.bytes, 3);
  assert.equal(r.hashes.md5, '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(r.hashes.sha1, 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(r.hashes.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(r.hashes['sha3-256'], '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');
  assert.equal(r.hashes.ripemd160, '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc');
  assert.equal(r.hashes.crc32, '352441c2');
  assert.equal(r.hashes.blake2b512.length, 128);
});

test('hash: crc32 check value, HMAC, base64 output and expected-match', async () => {
  const crc = await api.post('/crypto/hash', { text: '123456789', algorithms: ['crc32'] });
  assert.equal(crc.hashes.crc32, 'cbf43926');
  const h = await api.post('/crypto/hash', {
    text: 'The quick brown fox jumps over the lazy dog', algorithms: ['sha256'], hmacKey: 'key',
  });
  assert.equal(h.hmac, true);
  assert.equal(h.hashes.sha256, 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  const b = await api.post('/crypto/hash', { text: 'abc', algorithms: ['sha256'], encoding: 'base64', expected: 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD' });
  assert.equal(b.hashes.sha256, 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  assert.equal(b.match, 'sha256');
  const none = await api.post('/crypto/hash', { text: 'abc', algorithms: ['sha256'], expected: 'deadbeef' });
  assert.equal(none.match, null);
  const hexIn = await api.post('/crypto/hash', { text: '61 62 63', inputEncoding: 'hex', algorithms: ['md5'] });
  assert.equal(hexIn.hashes.md5, '900150983cd24fb0d6963f7d28e17f72');
});

test('hash: unsupported algorithm is 400', async () => {
  await assert.rejects(api.post('/crypto/hash', { text: 'x', algorithms: ['md4x'] }), /400/);
});

test('hash-file: multiple files with verify', async () => {
  const a = Buffer.from('hello world\n');
  const b = Buffer.alloc(9 * 1024 * 1024, 7); // spans several internal chunks
  const sha = buf => createHash('sha256').update(buf).digest('hex');
  const r = await api.postForm('/crypto/hash-file', { algorithms: 'sha256,md5,crc32', expected: sha(b) }, [
    { name: 'a.txt', data: a }, { name: 'b.bin', data: b },
  ]);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0].name, 'a.txt');
  assert.equal(r.files[0].hashes.sha256, sha(a));
  assert.equal(r.files[0].hashes.md5, createHash('md5').update(a).digest('hex'));
  assert.equal(r.files[1].size, b.length);
  assert.equal(r.files[1].hashes.sha256, sha(b));
  assert.equal(r.files[0].match, null);
  assert.equal(r.files[1].match, 'sha256');
});

// ── bcrypt ───────────────────────────────────────────────────────────────────

test('bcrypt: hash then verify (and wrong password)', async () => {
  const h = await api.post('/crypto/bcrypt/hash', { password: 'correct horse battery staple', rounds: 6 });
  assert.match(h.hash, /^\$2[ab]\$06\$/);
  assert.equal(typeof h.ms, 'number');
  const ok = await api.post('/crypto/bcrypt/verify', { password: 'correct horse battery staple', hash: h.hash });
  assert.equal(ok.match, true);
  assert.equal(ok.info.cost, 6);
  const bad = await api.post('/crypto/bcrypt/verify', { password: 'nope', hash: h.hash });
  assert.equal(bad.match, false);
});

test('bcrypt: PHP $2y$ hashes, 72-byte warning and validation', async () => {
  // PHP's password_hash() emits $2y$ — same algorithm, different prefix.
  const b = await api.post('/crypto/bcrypt/hash', { password: 'password', rounds: 4 });
  const y = await api.post('/crypto/bcrypt/verify', { password: 'password', hash: b.hash.replace(/^\$2[ab]\$/, '$2y$') });
  assert.equal(y.match, true);
  assert.equal(y.info.version, '2y');
  const h = await api.post('/crypto/bcrypt/hash', { password: 'x'.repeat(80), rounds: 4 });
  assert.ok(h.warnings.some(w => /72 bytes/.test(w)));
  await assert.rejects(api.post('/crypto/bcrypt/hash', { password: 'x', rounds: 20 }), /400/);
  await assert.rejects(api.post('/crypto/bcrypt/verify', { password: 'x', hash: 'not-a-hash' }), /400/);
});

// ── key pairs ────────────────────────────────────────────────────────────────

function sshFingerprint(line) {
  const blob = Buffer.from(line.split(' ')[1], 'base64');
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

const sshKeygen = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' }).error ? null : 'ssh-keygen';

function checkWithSshKeygen(k) {
  if (!sshKeygen) return;
  const dir = mkdtempSync(join(tmpdir(), 'keytest-'));
  try {
    const pub = join(dir, 'k.pub');
    writeFileSync(pub, k.sshPublic + '\n');
    const fp = spawnSync(sshKeygen, ['-l', '-E', 'sha256', '-f', pub], { encoding: 'utf8' });
    assert.equal(fp.status, 0, fp.stderr);
    assert.ok(fp.stdout.includes(k.fingerprint), `ssh-keygen fingerprint ${fp.stdout} vs ${k.fingerprint}`);
    if (k.sshPrivate) {
      const priv = join(dir, 'k');
      writeFileSync(priv, k.sshPrivate, { mode: 0o600 });
      if (process.platform === 'win32') {
        // OpenSSH on Windows refuses keys readable by others; tighten the ACL to the current user.
        spawnSync('icacls', [priv, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`]);
      }
      const y = spawnSync(sshKeygen, ['-y', '-f', priv], { encoding: 'utf8' });
      assert.equal(y.status, 0, `ssh-keygen -y failed: ${y.stderr}`);
      assert.equal(y.stdout.trim().split(' ').slice(0, 2).join(' '), k.sshPublic.split(' ').slice(0, 2).join(' '));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, req, prefix] of [
  ['rsa 2048', { type: 'rsa', bits: 2048 }, 'ssh-rsa'],
  ['ec P-256', { type: 'ec', curve: 'P-256' }, 'ecdsa-sha2-nistp256'],
  ['ec P-384', { type: 'ec', curve: 'P-384' }, 'ecdsa-sha2-nistp384'],
  ['ec P-521', { type: 'ec', curve: 'P-521' }, 'ecdsa-sha2-nistp521'],
  ['ed25519', { type: 'ed25519' }, 'ssh-ed25519'],
]) {
  test(`keypair: ${label} → PEM, OpenSSH, fingerprint, JWK`, async () => {
    const k = await api.post('/crypto/keypair', { ...req, comment: 'me@test' });
    assert.ok(k.privatePem.includes('BEGIN PRIVATE KEY'));
    assert.ok(k.publicPem.includes('BEGIN PUBLIC KEY'));
    assert.ok(k.sshPublic.startsWith(prefix + ' '));
    assert.ok(k.sshPublic.endsWith(' me@test'));
    assert.equal(k.fingerprint, sshFingerprint(k.sshPublic));
    assert.ok(k.sshPrivate.includes('BEGIN OPENSSH PRIVATE KEY'));
    // Round-trip: sign with the private PEM, verify with the JWK.
    const priv = createPrivateKey(k.privatePem);
    const pub = createPublicKey({ key: k.jwk.public, format: 'jwk' });
    const alg = req.type === 'ed25519' ? null : 'sha256';
    const sig = sign(alg, Buffer.from('msg'), priv);
    assert.ok(verify(alg, Buffer.from('msg'), pub, sig));
    assert.ok(k.jwk.public.kid && !k.jwk.public.d);
    assert.ok(k.jwk.private.d);
    if (req.type === 'rsa') assert.ok(k.pkcs1Private.includes('BEGIN RSA PRIVATE KEY') && k.pkcs1Public.includes('BEGIN RSA PUBLIC KEY'));
    checkWithSshKeygen(k);
  });
}

test('keypair: passphrase encrypts the private key; bad params are 400', async () => {
  const k = await api.post('/crypto/keypair', { type: 'ec', curve: 'P-256', passphrase: 's3cret' });
  assert.ok(k.privatePem.includes('BEGIN ENCRYPTED PRIVATE KEY'));
  assert.equal(k.sshPrivate, null);
  assert.equal(k.jwk.private, null);
  assert.throws(() => createPrivateKey({ key: k.privatePem, passphrase: 'wrong' }));
  createPrivateKey({ key: k.privatePem, passphrase: 's3cret' });
  await assert.rejects(api.post('/crypto/keypair', { type: 'rsa', bits: 1024 }), /400/);
  await assert.rejects(api.post('/crypto/keypair', { type: 'dsa' }), /400/);
});

test('keypair: RSA 4096 completes', async () => {
  const k = await api.post('/crypto/keypair', { type: 'rsa', bits: 4096 });
  assert.equal(k.bits, 4096);
});

// ── JWT ──────────────────────────────────────────────────────────────────────

test('jwt: HS256 matches the jwt.io reference token', async () => {
  const r = await api.post('/crypto/jwt/sign', {
    alg: 'HS256',
    header: { alg: 'HS256', typ: 'JWT' },
    payload: { sub: '1234567890', name: 'John Doe', iat: 1516239022 },
    secret: 'your-256-bit-secret',
  });
  assert.equal(r.token, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
  const v = await api.post('/crypto/jwt/verify', { token: r.token, secret: 'your-256-bit-secret' });
  assert.equal(v.signatureValid, true);
  assert.equal(v.valid, true);
  const bad = await api.post('/crypto/jwt/verify', { token: r.token, secret: 'wrong' });
  assert.equal(bad.valid, false);
});

test('jwt: expiresIn sets exp; expired tokens fail verification', async () => {
  const r = await api.post('/crypto/jwt/sign', { alg: 'HS512', payload: { sub: 'u1' }, secret: 'x'.repeat(64), expiresIn: '1h' });
  assert.equal(r.payload.exp - r.payload.iat, 3600);
  const v = await api.post('/crypto/jwt/verify', { token: r.token, secret: 'x'.repeat(64) });
  assert.equal(v.valid, true);
  assert.equal(v.claims.exp.ok, true);
  const old = await api.post('/crypto/jwt/sign', { alg: 'HS256', payload: { exp: 1000 }, secret: 'k'.repeat(32) });
  const ve = await api.post('/crypto/jwt/verify', { token: old.token, secret: 'k'.repeat(32) });
  assert.equal(ve.signatureValid, true);
  assert.equal(ve.valid, false);
  assert.ok(ve.errors.some(e => /expired/.test(e)));
  const weak = await api.post('/crypto/jwt/sign', { alg: 'HS256', payload: {}, secret: 'short' });
  assert.ok(weak.warnings.length > 0);
});

for (const [alg, keyReq] of [
  ['RS256', { type: 'rsa', bits: 2048 }],
  ['PS384', { type: 'rsa', bits: 2048 }],
  ['ES256', { type: 'ec', curve: 'P-256' }],
  ['ES384', { type: 'ec', curve: 'P-384' }],
  ['ES512', { type: 'ec', curve: 'P-521' }],
  ['EdDSA', { type: 'ed25519' }],
]) {
  test(`jwt: ${alg} sign → verify (endpoint + independent check)`, async () => {
    const k = await api.post('/crypto/keypair', keyReq);
    const r = await api.post('/crypto/jwt/sign', { alg, payload: { sub: 'abc' }, privateKeyPem: k.privatePem, expiresIn: 600 });
    const [h, p, s] = r.token.split('.');
    const sig = Buffer.from(s, 'base64url');
    if (alg.startsWith('ES')) {
      // JOSE signatures are raw r||s, not DER.
      assert.equal(sig.length, { ES256: 64, ES384: 96, ES512: 132 }[alg]);
      assert.ok(verify(`sha${alg.slice(2)}`, Buffer.from(`${h}.${p}`), { key: createPublicKey(k.publicPem), dsaEncoding: 'ieee-p1363' }, sig));
    }
    const v = await api.post('/crypto/jwt/verify', { token: r.token, publicKeyPem: k.publicPem });
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    // tampered payload
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64url')}.${s}`;
    const vf = await api.post('/crypto/jwt/verify', { token: forged, publicKeyPem: k.publicPem });
    assert.equal(vf.valid, false);
    // JWK public key works too
    const vj = await api.post('/crypto/jwt/verify', { token: r.token, publicKeyPem: JSON.stringify(k.jwk.public) });
    assert.equal(vj.valid, true);
  });
}

test('jwt: wrong key type and alg "none" are rejected', async () => {
  const ec = await api.post('/crypto/keypair', { type: 'ec', curve: 'P-256' });
  await assert.rejects(api.post('/crypto/jwt/sign', { alg: 'RS256', payload: {}, privateKeyPem: ec.privatePem }), /400/);
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
  const v = await api.post('/crypto/jwt/verify', { token: none, secret: 'x' });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => /none/.test(e)));
  // HMAC verify of a token signed by node directly
  const input = `${Buffer.from('{"alg":"HS384","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"a":1}').toString('base64url')}`;
  const tok = `${input}.${createHmac('sha384', 'k'.repeat(48)).update(input).digest('base64url')}`;
  const v2 = await api.post('/crypto/jwt/verify', { token: tok, secret: 'k'.repeat(48) });
  assert.equal(v2.valid, true);
});
