// Run: node node_modules/tsx/dist/cli.mjs dashboard/src/components/devtools/lib/network.test.ts
import assert from 'node:assert/strict';
import {
  chunk, compressIPv6, countryFlag, expandIPv6, formatTtl, ipv4Info, ipv6Info, parseIPv4, parseIPv6, parsePortSpec,
  parseV4Input, parseV6Input, prefixForHosts, prefixForSubnetCount, prefixFromMask, rangeToCidrs, sparklinePoints,
  splitIPv4, splitIPv6, classifyIPv4, maskFromPrefix, formatIPv4,
} from './network';

let passed = 0;
function t(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

t('IPv4 parse / format / masks', () => {
  assert.equal(parseIPv4('192.168.1.10'), 0xc0a8010a);
  assert.equal(parseIPv4('256.1.1.1'), null);
  assert.equal(parseIPv4('1.2.3'), null);
  assert.equal(parseIPv4('01.2.3.4'), null);
  assert.equal(formatIPv4(0xffffffff), '255.255.255.255');
  assert.equal(formatIPv4(maskFromPrefix(20)), '255.255.240.0');
  assert.equal(maskFromPrefix(0), 0);
  assert.equal(prefixFromMask(parseIPv4('255.255.255.192')!), 26);
  assert.equal(prefixFromMask(parseIPv4('255.0.255.0')!), null);
});

t('parseV4Input accepts CIDR, netmask, wildcard and bare IPs', () => {
  assert.deepEqual(parseV4Input('10.0.0.5/24'), { ip: parseIPv4('10.0.0.5'), prefix: 24, prefixGiven: true });
  assert.equal((parseV4Input('10.0.0.5 255.255.0.0') as any).prefix, 16);
  assert.equal((parseV4Input('10.0.0.5/0.0.0.255') as any).prefix, 24);
  assert.equal((parseV4Input('172.20.1.1') as any).prefix, 16);
  assert.ok('error' in parseV4Input('10.0.0.5/33'));
  assert.ok('error' in parseV4Input('10.0.0.5/255.0.255.0'));
  assert.ok('error' in parseV4Input('hello'));
});

t('ipv4Info for /24, /31, /32, /0', () => {
  const i = ipv4Info(parseIPv4('192.168.1.130')!, 26);
  assert.equal(i.network, '192.168.1.128');
  assert.equal(i.broadcast, '192.168.1.191');
  assert.equal(i.firstHost, '192.168.1.129');
  assert.equal(i.lastHost, '192.168.1.190');
  assert.equal(i.usableHosts, 62);
  assert.equal(i.totalAddresses, 64);
  assert.equal(i.netmask, '255.255.255.192');
  assert.equal(i.wildcard, '0.0.0.63');
  assert.equal(i.cls, 'C');
  assert.equal(i.binary.netmask, '11111111.11111111.11111111.11000000');
  assert.equal(i.hex, '0xC0A80182');
  assert.equal(i.arpa, '1.168.192.in-addr.arpa');
  assert.equal(i.tags[0].label, 'Private (RFC 1918)');
  const p31 = ipv4Info(parseIPv4('10.0.0.0')!, 31);
  assert.equal(p31.usableHosts, 2);
  assert.equal(p31.firstHost, '10.0.0.0');
  assert.equal(p31.lastHost, '10.0.0.1');
  const p32 = ipv4Info(parseIPv4('8.8.8.8')!, 32);
  assert.equal(p32.usableHosts, 1);
  assert.equal(p32.tags[0].label, 'Public');
  const all = ipv4Info(parseIPv4('1.2.3.4')!, 0);
  assert.equal(all.totalAddresses, 4294967296);
  assert.equal(all.broadcast, '255.255.255.255');
});

t('classifyIPv4 special ranges', () => {
  const label = (s: string) => classifyIPv4(parseIPv4(s)!).map(x => x.label).join(',');
  assert.match(label('100.64.1.1'), /Carrier-grade/);
  assert.match(label('169.254.169.254'), /Link-local/);
  assert.match(label('127.0.0.1'), /Loopback/);
  assert.match(label('224.0.0.251'), /Multicast/);
  assert.match(label('203.0.113.9'), /Documentation/);
  assert.equal(label('192.0.32.59'), 'Public');
});

t('subnet splitting and sizing', () => {
  const s = splitIPv4(parseIPv4('10.0.0.0')!, 24, 26) as any;
  assert.equal(s.count, 4);
  assert.deepEqual(s.subnets.map((x: any) => x.network), ['10.0.0.0', '10.0.0.64', '10.0.0.128', '10.0.0.192']);
  assert.equal(s.subnets[3].lastHost, '10.0.0.254');
  assert.equal(s.subnets[0].hosts, 62);
  const big = splitIPv4(parseIPv4('10.0.0.0')!, 8, 24, 10) as any;
  assert.equal(big.count, 65536);
  assert.equal(big.subnets.length, 10);
  assert.ok('error' in splitIPv4(1, 24, 20));
  assert.equal(prefixForSubnetCount(24, 3), 26);
  assert.equal(prefixForSubnetCount(24, 4), 26);
  assert.equal(prefixForSubnetCount(24, 5), 27);
  assert.equal(prefixForHosts(62), 26);
  assert.equal(prefixForHosts(63), 25);
  assert.equal(prefixForHosts(254), 24);
  assert.equal(prefixForHosts(2), 31);
});

t('range to CIDR blocks', () => {
  assert.deepEqual(rangeToCidrs(parseIPv4('10.0.0.0')!, parseIPv4('10.0.0.255')!), ['10.0.0.0/24']);
  assert.deepEqual(rangeToCidrs(parseIPv4('10.0.0.1')!, parseIPv4('10.0.0.6')!), ['10.0.0.1/32', '10.0.0.2/31', '10.0.0.4/31', '10.0.0.6/32']);
  assert.deepEqual(rangeToCidrs(0, 0xffffffff), ['0.0.0.0/0']);
});

t('IPv6 parse / compress / expand', () => {
  const n = parseIPv6('2001:db8::1')!;
  assert.equal(expandIPv6(n), '2001:0db8:0000:0000:0000:0000:0000:0001');
  assert.equal(compressIPv6(n), '2001:db8::1');
  assert.equal(compressIPv6(parseIPv6('2001:0:0:1:0:0:0:1')!), '2001:0:0:1::1');
  assert.equal(compressIPv6(parseIPv6('::')!), '::');
  assert.equal(compressIPv6(parseIPv6('::ffff:192.0.2.1')!), '::ffff:c000:201');
  assert.equal(parseIPv6('1::2::3'), null);
  assert.equal(parseIPv6('12345::'), null);
  assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(compressIPv6(parseIPv6('[fe80::1%eth0]')!), 'fe80::1');
});

t('ipv6Info / split', () => {
  const p = parseV6Input('2001:db8:abcd:12::5/48') as any;
  const i = ipv6Info(p.ip, p.prefix);
  assert.equal(i.network, '2001:db8:abcd::');
  assert.equal(i.last, '2001:db8:abcd:ffff:ffff:ffff:ffff:ffff');
  assert.equal(i.addressesPow, '2^80');
  assert.equal(i.subnets64, '65,536');
  assert.equal(i.type, 'Documentation');
  assert.equal(i.arpa, 'd.c.b.a.8.b.d.0.1.0.0.2.ip6.arpa');
  assert.equal(ipv6Info(parseIPv6('fd00::1')!, 64).type, 'Unique local (ULA, private)');
  assert.equal(ipv6Info(parseIPv6('2606:4700::1111')!, 128).addresses, '1');
  const s = splitIPv6(p.ip, 48, 52) as any;
  assert.equal(s.count, 16n);
  assert.equal(s.subnets[1], '2001:db8:abcd:1000::/52');
  assert.ok('error' in parseV6Input('2001:db8::/129'));
});

t('port specs', () => {
  assert.deepEqual(parsePortSpec('22, 80 443,8000-8002'), [22, 80, 443, 8000, 8001, 8002]);
  assert.equal((parsePortSpec('top100') as number[]).length, 100);
  assert.ok('error' in (parsePortSpec('1-2000') as any));
  assert.ok('error' in (parsePortSpec('0') as any));
  assert.ok('error' in (parsePortSpec('http') as any));
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

t('misc formatting', () => {
  assert.equal(countryFlag('us'), '🇺🇸');
  assert.equal(countryFlag(''), '');
  assert.equal(formatTtl(30), '30s');
  assert.equal(formatTtl(3600), '1h');
  assert.equal(formatTtl(90061), '1d 1h');
  assert.equal(sparklinePoints([1, null, 3], 100, 20), '2.0,18.0 98.0,2.0');
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}`);
