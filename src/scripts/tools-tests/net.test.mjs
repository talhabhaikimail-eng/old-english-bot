import { tsImport } from 'tsx/esm/api';
import { api, assert, test } from './lib.mjs';

// Pure helpers are imported straight from the TypeScript module for unit tests.
const lib = await tsImport('../../libs/tools/net.ts', import.meta.url);

const refused = p => assert.rejects(p, /HTTP 403/);

// ── guard ────────────────────────────────────────────────────────────────────

test('guard: private / loopback / metadata / internal targets are refused everywhere', async () => {
  for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '192.168.1.1', '169.254.169.254', '[::1]', 'foo.internal', '0.0.0.0', '100.64.0.1']) {
    await refused(api.post('/net/ssl', { host }));
    await refused(api.post('/net/ports', { host, ports: '80' }));
    await refused(api.post('/net/ping', { host, mode: 'tcp', count: 1 }));
  }
  await refused(api.post('/net/http', { url: 'http://169.254.169.254/latest/meta-data/' }));
  await refused(api.post('/net/http', { url: 'http://localhost:8080/' }));
  await refused(api.post('/net/http', { url: 'http://[::ffff:127.0.0.1]/' }));
  await refused(api.post('/net/dns', { name: 'localhost' }));
  await refused(api.post('/net/whois', { query: '192.168.0.1' }));
  await refused(api.post('/net/traceroute', { host: '10.0.0.1' }));
  await refused(api.get('/net/ip?q=127.0.0.1'));
  // A public name that resolves to loopback (DNS-based SSRF).
  await refused(api.post('/net/ports', { host: 'localtest.me', ports: '80' }));
});

test('guard: malformed hosts and single-label names are 400', async () => {
  for (const host of ['exa mple.com', 'intranet', 'a..b', '-bad-.com', 'x'.repeat(300) + '.com', 'http://']) {
    await assert.rejects(api.post('/net/ssl', { host }), /HTTP 400/, host);
  }
  await assert.rejects(api.post('/net/http', { url: 'file:///etc/passwd' }), /HTTP 400/);
  await assert.rejects(api.post('/net/http', { url: 'ftp://example.com/' }), /HTTP 400/);
});

// ── IP ───────────────────────────────────────────────────────────────────────

test('ip: server IP, caller IP and geolocation for 1.1.1.1', async () => {
  const r = await api.get('/net/ip?q=1.1.1.1');
  assert.match(r.server.ip, /^[\d.:a-f]+$/i);
  assert.ok(r.client.ip);
  assert.equal(r.lookup.ip, '1.1.1.1');
  assert.match(String(r.lookup.asn), /13335/);
  assert.ok(r.lookup.ptr.includes('one.one.one.one'));
});

test('ip: hostname query resolves first', async () => {
  const r = await api.get('/net/ip?q=dns.google');
  assert.equal(r.host, 'dns.google');
  assert.ok(['8.8.8.8', '8.8.4.4'].includes(r.lookup.ip));
  assert.match(String(r.lookup.asn), /15169/);
});

// ── DNS ──────────────────────────────────────────────────────────────────────

test('dns: all record types for google.com via Cloudflare', async () => {
  const r = await api.post('/net/dns', { name: 'google.com', types: ['ANY'], resolver: 'cloudflare' });
  const by = Object.fromEntries(r.results.map(x => [x.type, x]));
  assert.ok(by.A.records.length > 0 && by.A.records[0].ttl >= 0);
  assert.ok(by.MX.records.some(m => /smtp\.google\.com/.test(m.value)));
  assert.ok(by.NS.records.some(n => /ns\d\.google\.com/.test(n.value)));
  assert.ok(by.TXT.records.some(t => /v=spf1/.test(t.value)));
  assert.ok(by.SOA.records[0].serial > 0);
  assert.ok(by.CAA.records.some(c => c.tag === 'issue'));
  assert.equal(by.CNAME.code, 'ENODATA');
  assert.deepEqual(r.resolver.servers.slice(0, 1), ['1.1.1.1']);
  assert.equal(by.A.via, 'DoH');
  assert.ok(by.MX.records[0].ttl >= 0, 'DoH gives TTLs for every type');
});

test('dns: resolvers, SRV, PTR and NXDOMAIN', async () => {
  for (const resolver of ['google', 'quad9', 'system']) {
    const r = await api.post('/net/dns', { name: 'example.com', types: ['A', 'AAAA'], resolver });
    assert.ok(r.results[0].records.length > 0, resolver);
  }
  const srv = await api.post('/net/dns', { name: '_xmpp-server._tcp.jabber.org', types: ['SRV'] });
  assert.ok(srv.results[0].records.length === 0 || srv.results[0].records[0].port > 0);
  const ptr = await api.post('/net/dns', { name: '1.1.1.1' });
  assert.equal(ptr.results[0].type, 'PTR');
  assert.equal(ptr.results[0].records[0].value, 'one.one.one.one');
  const ptr6 = await api.post('/net/dns', { name: '2606:4700:4700::1111', resolver: 'quad9' });
  assert.equal(ptr6.results[0].records[0].value, 'one.one.one.one');
  const nx = await api.post('/net/dns', { name: 'this-does-not-exist-4b9e1c.com', types: ['A', 'MX'] });
  assert.equal(nx.nxdomain, true);
  assert.equal(nx.results[0].code, 'ENOTFOUND');
  await assert.rejects(api.post('/net/dns', { name: 'example.com', types: ['BOGUS'] }), /HTTP 400/);
  await assert.rejects(api.post('/net/dns', { name: 'example.com', resolver: 'evil' }), /HTTP 400/);
});

// ── TLS ──────────────────────────────────────────────────────────────────────

test('ssl: cloudflare.com chain, validity and protocol', async () => {
  const r = await api.post('/net/ssl', { host: 'https://cloudflare.com/some/path' });
  assert.equal(r.host, 'cloudflare.com');
  assert.equal(r.authorized, true);
  assert.equal(r.hostnameMatch, true);
  assert.ok(r.chain.length >= 2);
  assert.ok(r.leaf.daysRemaining > 0);
  assert.ok(r.leaf.sans.some(s => /cloudflare\.com/.test(s)));
  assert.match(r.leaf.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.ok(r.leaf.signatureAlgorithm);
  assert.match(r.protocol, /TLSv1\.[23]/);
  const p13 = r.protocols.find(p => p.version === 'TLSv1.3');
  assert.equal(p13.supported, true);
});

test('ssl: hostname mismatch and expired certs are reported (badssl.com)', async () => {
  try {
    const wrong = await api.post('/net/ssl', { host: 'wrong.host.badssl.com', protocols: false });
    assert.equal(wrong.hostnameMatch, false);
    const exp = await api.post('/net/ssl', { host: 'expired.badssl.com', protocols: false });
    assert.equal(exp.authorized, false);
    assert.ok(exp.leaf.daysRemaining < 0);
  } catch (e) {
    if (/HTTP 502/.test(e.message)) { console.log('      (badssl.com unreachable — skipped)'); return; }
    throw e;
  }
});

// ── WHOIS ────────────────────────────────────────────────────────────────────

test('whois: google.com via RDAP + raw WHOIS referral chain', async () => {
  const r = await api.post('/net/whois', { query: 'www.google.com' });
  assert.equal(r.type, 'domain');
  assert.ok(r.rdap, r.rdapError);
  assert.equal(r.rdap.domain, 'google.com');
  assert.match(r.rdap.data.registrar.name, /MarkMonitor/i);
  assert.ok(r.rdap.data.nameservers.includes('ns1.google.com'));
  assert.ok(new Date(r.rdap.data.expires) > new Date());
  assert.ok(new Date(r.rdap.data.created).getUTCFullYear() === 1997);
  assert.equal(r.raw[0].server, 'whois.iana.org');
  assert.ok(r.raw.length >= 2, JSON.stringify(r.raw.map(h => [h.server, h.error])));
  assert.match(r.raw[1].text, /google/i);
});

test('whois: IP network (8.8.8.8)', async () => {
  const r = await api.post('/net/whois', { query: '8.8.8.8' });
  assert.equal(r.type, 'ip');
  assert.ok(r.rdap, r.rdapError);
  assert.ok(r.rdap.data.cidrs.length > 0 || r.rdap.data.startAddress);
  assert.ok(JSON.stringify(r.rdap.data).match(/google/i));
});

// ── ports ────────────────────────────────────────────────────────────────────

test('ports: 1.1.1.1 has 53/80/443 open; banner on 80', async () => {
  const r = await api.post('/net/ports', { host: '1.1.1.1', ports: '53,80,443,4', timeoutMs: 1500, banner: true });
  const by = Object.fromEntries(r.results.map(x => [x.port, x]));
  assert.equal(by[443].status, 'open');
  assert.equal(by[80].status, 'open');
  assert.equal(by[443].service, 'https');
  assert.match(by[80].banner || '', /HTTP\/1\.[01]/);
  // Port 4 is normally closed/filtered, but some networks run transparent proxies that accept everything.
  if (by[4].status === 'open') console.log('      (port 4 reported open — transparent proxy on this network?)');
  assert.equal(r.summary.scanned, 4);
});

test('ports: presets, ranges and limits', async () => {
  const r = await api.post('/net/ports', { host: 'example.com', ports: 'web', timeoutMs: 800 });
  assert.ok(r.results.find(x => x.port === 443).status === 'open');
  const range = await api.post('/net/ports', { host: 'example.com', ports: '440-445', timeoutMs: 300 });
  assert.deepEqual(range.results.map(x => x.port), [440, 441, 442, 443, 444, 445]);
  await assert.rejects(api.post('/net/ports', { host: 'example.com', ports: '1-2000' }), /HTTP 400/);
  await assert.rejects(api.post('/net/ports', { host: 'example.com', ports: '0,70000' }), /HTTP 400/);
  await assert.rejects(api.post('/net/ports', { host: 'example.com', ports: '80', timeoutMs: 50 }), /HTTP 400/);
});

// ── ping / traceroute ───────────────────────────────────────────────────────

test('ping: TCP mode statistics', async () => {
  const r = await api.post('/net/ping', { host: 'one.one.one.one', mode: 'tcp', port: 443, count: 3 });
  assert.equal(r.samples.length, 3);
  assert.equal(r.stats.received, 3);
  assert.equal(r.stats.loss, 0);
  assert.ok(r.stats.min <= r.stats.avg && r.stats.avg <= r.stats.max);
  await assert.rejects(api.post('/net/ping', { host: '1.1.1.1', count: 50 }), /HTTP 400/);
});

test('ping: ICMP mode works or reports that it is unavailable', async () => {
  try {
    const r = await api.post('/net/ping', { host: '1.1.1.1', mode: 'icmp', count: 2 });
    assert.equal(r.samples.length, 2);
    // Some networks drop ICMP entirely; then every sample is a timeout and loss is 100%.
    assert.ok(r.stats.received >= 1 || (r.stats.loss === 100 && /timed out|100% packet loss|100% loss/i.test(r.raw)), r.raw);
  } catch (e) {
    assert.match(e.message, /HTTP 501/);
  }
});

test('traceroute: hops to 1.1.1.1 (or a clear "not available")', async () => {
  try {
    const r = await api.post('/net/traceroute', { host: '1.1.1.1', maxHops: 12 });
    assert.ok(r.hops.length > 0, r.raw);
    assert.equal(r.hops[0].hop, 1);
  } catch (e) {
    assert.match(e.message, /HTTP 501.*not available/);
  }
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

test('http: redirect chain http://google.com → http://www.google.com, http://github.com → https', async () => {
  const g = await api.post('/net/http', { url: 'http://google.com' });
  assert.equal(g.hops[0].status, 301);
  assert.match(g.finalUrl, /^https?:\/\/www\.google\.com\//);
  const r = await api.post('/net/http', { url: 'http://github.com' });
  assert.ok(r.redirects >= 1);
  assert.equal(r.hops[0].status, 301);
  assert.match(r.finalUrl, /^https:\/\/github\.com\//);
  assert.equal(r.upgradedToHttps, true);
  const last = r.hops[r.hops.length - 1];
  assert.equal(last.status, 200);
  assert.ok(last.timings.ttfb > 0 && last.timings.total >= last.timings.ttfb);
  assert.ok(last.timings.tls > 0);
  assert.ok(last.tls.authorized);
  assert.ok(last.bodyBytes > 0);
  assert.match(r.security.grade, /^(A\+|A|B|C|D|E|F)$/);
  assert.ok(r.security.checks.find(c => c.id === 'hsts'));
});

test('http: HEAD without following redirects; headers preserved', async () => {
  const r = await api.post('/net/http', { url: 'http://github.com', method: 'HEAD', followRedirects: false });
  assert.equal(r.hops.length, 1);
  assert.equal(r.hops[0].status, 301);
  assert.ok(r.hops[0].headers.some(([k]) => k === 'location'));
  const gh = await api.post('/net/http', { url: 'https://github.com' });
  assert.ok(['A', 'A+', 'B'].includes(gh.security.grade), gh.security.grade);
  assert.ok(gh.hops[0].decodedBytes >= gh.hops[0].bodyBytes);
});

test('http: redirects into private space are not followed', async () => {
  // httpbin redirects wherever it's told — the hop to 127.0.0.1 must be refused.
  try {
    const r = await api.post('/net/http', { url: 'https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%2Fadmin&status_code=302' });
    if (r.hops[0].status >= 500) { console.log('      (httpbin.org unavailable — skipped)'); return; }
    assert.equal(r.hops.length, 1);
    assert.match(r.error, /not followed.*Refused/);
  } catch (e) {
    if (/HTTP 5\d\d/.test(e.message)) { console.log('      (httpbin.org unreachable — skipped)'); return; }
    throw e;
  }
});

// ── pure helpers ─────────────────────────────────────────────────────────────

test('unit: ping output parsers (Windows, iputils, busybox, loss)', () => {
  const win = 'Pinging 1.1.1.1 with 32 bytes of data:\r\nReply from 1.1.1.1: bytes=32 time=12ms TTL=57\r\nRequest timed out.\r\nReply from 1.1.1.1: bytes=32 time<1ms TTL=57\r\n';
  const w = lib.parsePingOutput(win, 3);
  assert.equal(w.ttl, 57);
  assert.deepEqual(w.rtts, [12, null, 0.5]);
  const iputils = 'PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.\n64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=11.2 ms\n64 bytes from 1.1.1.1: icmp_seq=3 ttl=57 time=10.9 ms\n';
  assert.deepEqual(lib.parsePingOutput(iputils, 3).rtts, [11.2, null, 10.9]);
  const busybox = 'PING 1.1.1.1 (1.1.1.1): 56 data bytes\n64 bytes from 1.1.1.1: seq=0 ttl=57 time=9.812 ms\n64 bytes from 1.1.1.1: seq=1 ttl=57 time=10.100 ms\n';
  assert.deepEqual(lib.parsePingOutput(busybox, 2).rtts, [9.812, 10.1]);
  const s = lib.latencyStats([10, null, 20, 30]);
  assert.equal(s.loss, 25);
  assert.equal(s.avg, 20);
  assert.equal(s.min, 10);
  assert.equal(s.max, 30);
  assert.equal(s.stddev, 8.16);
});

test('unit: traceroute parsers (tracert, traceroute -n, tracepath)', () => {
  const tracert = `Tracing route to 1.1.1.1 over a maximum of 30 hops\r\n\r\n  1    <1 ms    <1 ms    <1 ms  192.168.43.1\r\n  2     *        *        *     Request timed out.\r\n  3    15 ms    14 ms    16 ms  1.1.1.1\r\n\r\nTrace complete.`;
  const t = lib.parseTraceOutput(tracert);
  assert.deepEqual(t.map(h => h.ip), ['192.168.43.1', null, '1.1.1.1']);
  assert.equal(t[0].private, true);
  assert.deepEqual(t[2].rtts, [15, 14, 16]);
  const linux = 'traceroute to 1.1.1.1 (1.1.1.1), 30 hops max, 60 byte packets\n 1  172.17.0.1  0.071 ms  0.020 ms\n 2  * *\n 3  1.1.1.1  9.120 ms  9.002 ms\n';
  const l = lib.parseTraceOutput(linux);
  assert.equal(l.length, 3);
  assert.deepEqual(l[1].rtts, [null, null]);
  assert.equal(l[2].ip, '1.1.1.1');
  const tp = ' 1?: [LOCALHOST]                      pmtu 1500\n 1:  172.17.0.1                                            0.082ms \n 2:  no reply\n 3:  1.1.1.1                                               9.5ms reached\n';
  const p = lib.parseTraceOutput(tp);
  assert.deepEqual(p.map(h => h.ip), ['172.17.0.1', null, '1.1.1.1']);
  assert.deepEqual(p[2].rtts, [9.5]);
});

test('unit: port specs, host normalisation and header grading', () => {
  assert.deepEqual(lib.parsePorts('22, 80,443 8000-8002'), [22, 80, 443, 8000, 8001, 8002]);
  assert.equal(lib.parsePorts('top100').length, 100);
  assert.throws(() => lib.parsePorts('1-1025'));
  assert.equal(lib.normalizeHost('https://Example.COM:8443/x?y'), 'example.com');
  assert.equal(lib.normalizeHost('[2606:4700::1111]:443'), '2606:4700::1111');
  assert.equal(lib.normalizeHost('bücher.de'), 'xn--bcher-kva.de');
  const good = lib.securityHeaderReport([
    ['strict-transport-security', 'max-age=31536000; includeSubDomains; preload'],
    ['content-security-policy', "default-src 'self'; frame-ancestors 'none'"],
    ['x-frame-options', 'DENY'], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer'],
    ['permissions-policy', 'camera=()'], ['cross-origin-opener-policy', 'same-origin'],
    ['set-cookie', 'sid=1; Secure; HttpOnly; SameSite=Lax'],
  ], true);
  assert.equal(good.grade, 'A+');
  const bad = lib.securityHeaderReport([['server', 'Apache/2.4.1'], ['x-powered-by', 'PHP/5.6'], ['set-cookie', 'sid=1']], false);
  assert.equal(bad.grade, 'F');
  assert.deepEqual(bad.cookies[0].issues, ['no HttpOnly', 'no SameSite']);
});
