// Pure helpers for the Network dev tools (no React, no `@/` imports — unit-tested with tsx).

// ── IPv4 ─────────────────────────────────────────────────────────────────────

export function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some(p => p > 255)) return null;
  if (m.slice(1).some(p => p.length > 1 && p.startsWith('0'))) return null; // ambiguous octal-looking
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function formatIPv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function maskFromPrefix(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** Contiguous netmask → prefix length, or null for masks like 255.0.255.0. */
export function prefixFromMask(mask: number): number | null {
  const inv = ~mask >>> 0;
  if ((inv & (inv + 1)) !== 0) return null;
  let p = 0;
  for (let b = 31; b >= 0 && (mask >>> b) & 1; b--) p++;
  return p;
}

export function toBinary4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].map(o => o.toString(2).padStart(8, '0')).join('.');
}

export interface V4Input { ip: number; prefix: number; prefixGiven: boolean }

/**
 * Accepts "10.0.0.5/24", "10.0.0.5 255.255.255.0", "10.0.0.5/255.255.255.0" or a bare IP
 * (which gets its classful default prefix).
 */
export function parseV4Input(input: string): V4Input | { error: string } {
  const s = input.trim();
  if (!s) return { error: 'Enter an IPv4 address with a prefix, e.g. 192.168.1.10/24' };
  const [ipPart, rest] = s.split(/\s*\/\s*|\s+/);
  const ip = parseIPv4(ipPart);
  if (ip === null) return { error: `"${ipPart}" is not a valid IPv4 address` };
  if (rest === undefined || rest === '') {
    const first = ip >>> 24;
    return { ip, prefix: first < 128 ? 8 : first < 192 ? 16 : first < 224 ? 24 : 32, prefixGiven: false };
  }
  if (/^\d{1,2}$/.test(rest)) {
    const p = Number(rest);
    if (p > 32) return { error: 'Prefix length must be 0–32' };
    return { ip, prefix: p, prefixGiven: true };
  }
  const mask = parseIPv4(rest);
  if (mask === null) return { error: `"${rest}" is not a prefix length or netmask` };
  const p = prefixFromMask(mask);
  if (p === null) {
    // Accept wildcard masks (0.0.0.255) too.
    const pw = prefixFromMask(~mask >>> 0);
    if (pw !== null) return { ip, prefix: pw, prefixGiven: true };
    return { error: `${rest} is not a contiguous netmask` };
  }
  return { ip, prefix: p, prefixGiven: true };
}

const inRange = (ip: number, base: string, prefix: number) => {
  const b = parseIPv4(base)!;
  const m = maskFromPrefix(prefix);
  return ((ip & m) >>> 0) === ((b & m) >>> 0);
};

export function classifyIPv4(ip: number): { label: string; scope: 'public' | 'private' | 'special' }[] {
  const tags: { label: string; scope: 'public' | 'private' | 'special' }[] = [];
  const t = (label: string, scope: 'public' | 'private' | 'special') => tags.push({ label, scope });
  if (inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16)) t('Private (RFC 1918)', 'private');
  if (inRange(ip, '127.0.0.0', 8)) t('Loopback', 'special');
  if (inRange(ip, '169.254.0.0', 16)) t('Link-local (APIPA)', 'special');
  if (inRange(ip, '100.64.0.0', 10)) t('Carrier-grade NAT (RFC 6598)', 'private');
  if (inRange(ip, '224.0.0.0', 4)) t('Multicast', 'special');
  if (inRange(ip, '240.0.0.0', 4)) t(ip === 0xffffffff ? 'Limited broadcast' : 'Reserved (class E)', 'special');
  if (inRange(ip, '0.0.0.0', 8)) t('"This network"', 'special');
  if (inRange(ip, '192.0.2.0', 24) || inRange(ip, '198.51.100.0', 24) || inRange(ip, '203.0.113.0', 24)) t('Documentation (TEST-NET)', 'special');
  if (inRange(ip, '198.18.0.0', 15)) t('Benchmarking (RFC 2544)', 'special');
  if (inRange(ip, '192.0.0.0', 24)) t('IETF protocol assignments', 'special');
  if (!tags.length) t('Public', 'public');
  return tags;
}

export function ipv4Class(ip: number): string {
  const a = ip >>> 24;
  return a < 128 ? 'A' : a < 192 ? 'B' : a < 224 ? 'C' : a < 240 ? 'D (multicast)' : 'E (reserved)';
}

export interface V4Info {
  ip: string;
  prefix: number;
  netmask: string;
  wildcard: string;
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  totalAddresses: number;
  usableHosts: number;
  cls: string;
  tags: ReturnType<typeof classifyIPv4>;
  binary: { ip: string; netmask: string; network: string; broadcast: string };
  hex: string;
  integer: number;
  arpa: string;
  networkInt: number;
  broadcastInt: number;
}

export function ipv4Info(ip: number, prefix: number): V4Info {
  const mask = maskFromPrefix(prefix);
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = 2 ** (32 - prefix);
  let first = network + 1;
  let last = broadcast - 1;
  let usable = total - 2;
  if (prefix === 32) { first = network; last = network; usable = 1; }
  if (prefix === 31) { first = network; last = broadcast; usable = 2; } // RFC 3021 point-to-point
  const octets = formatIPv4(ip).split('.');
  const zoneOctets = Math.max(1, Math.floor(prefix / 8));
  return {
    ip: formatIPv4(ip),
    prefix,
    netmask: formatIPv4(mask),
    wildcard: formatIPv4(~mask >>> 0),
    network: formatIPv4(network),
    broadcast: formatIPv4(broadcast),
    firstHost: formatIPv4(first >>> 0),
    lastHost: formatIPv4(last >>> 0),
    totalAddresses: total,
    usableHosts: usable,
    cls: ipv4Class(ip),
    tags: classifyIPv4(ip),
    binary: { ip: toBinary4(ip), netmask: toBinary4(mask), network: toBinary4(network), broadcast: toBinary4(broadcast) },
    hex: '0x' + ip.toString(16).padStart(8, '0').toUpperCase(),
    integer: ip,
    arpa: octets.slice(0, zoneOctets).reverse().join('.') + '.in-addr.arpa',
    networkInt: network,
    broadcastInt: broadcast,
  };
}

export interface Subnet { network: string; prefix: number; firstHost: string; lastHost: string; broadcast: string; hosts: number }

/** Split network/prefix into /newPrefix subnets (first `limit` returned; `count` is the full number). */
export function splitIPv4(ip: number, prefix: number, newPrefix: number, limit = 256): { count: number; subnets: Subnet[] } | { error: string } {
  if (newPrefix < prefix) return { error: `New prefix /${newPrefix} is larger than the network /${prefix}` };
  if (newPrefix > 32) return { error: 'Prefix cannot exceed /32' };
  const base = (ip & maskFromPrefix(prefix)) >>> 0;
  const count = 2 ** (newPrefix - prefix);
  const size = 2 ** (32 - newPrefix);
  const subnets: Subnet[] = [];
  for (let i = 0; i < Math.min(count, limit); i++) {
    const info = ipv4Info(base + i * size, newPrefix);
    subnets.push({ network: info.network, prefix: newPrefix, firstHost: info.firstHost, lastHost: info.lastHost, broadcast: info.broadcast, hosts: info.usableHosts });
  }
  return { count, subnets };
}

/** Smallest prefix ≥ `prefix` giving at least `n` subnets. */
export function prefixForSubnetCount(prefix: number, n: number): number {
  return prefix + Math.ceil(Math.log2(Math.max(1, n)));
}

/** Longest prefix whose subnets still have ≥ `hosts` usable addresses. */
export function prefixForHosts(hosts: number): number {
  if (hosts <= 1) return 32;
  if (hosts === 2) return 31;
  return 32 - Math.ceil(Math.log2(hosts + 2));
}

/** Minimal list of CIDR blocks covering an inclusive IPv4 range. */
export function rangeToCidrs(start: number, end: number): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end && out.length < 64) {
    let size = 32;
    while (size > 0) {
      const mask = maskFromPrefix(size - 1);
      const block = 2 ** (32 - (size - 1));
      if (((cur & mask) >>> 0) !== cur || cur + block - 1 > end) break;
      size--;
    }
    out.push(`${formatIPv4(cur)}/${size}`);
    cur += 2 ** (32 - size);
    if (cur > 0xffffffff) break;
  }
  return out;
}

// ── IPv6 ─────────────────────────────────────────────────────────────────────

export function parseIPv6(input: string): bigint | null {
  let s = input.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!s || !/^[0-9a-f:.]+$/.test(s)) return null;
  // Embedded IPv4 (::ffff:1.2.3.4)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = parseIPv4(v4[1]);
    if (n === null) return null;
    s = s.slice(0, -v4[1].length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16));
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
  let groups: string[];
  if (dbl.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else groups = head;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

export function expandIPv6(n: bigint): string {
  const g: string[] = [];
  for (let i = 7; i >= 0; i--) g.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16).padStart(4, '0'));
  return g.join(':');
}

/** RFC 5952 canonical (compressed, lowercase) form. */
export function compressIPv6(n: bigint): string {
  const g = expandIPv6(n).split(':').map(x => parseInt(x, 16).toString(16));
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return g.join(':');
  return `${g.slice(0, best).join(':')}::${g.slice(best + bestLen).join(':')}`;
}

const V6_ALL = (1n << 128n) - 1n;

export function maskV6(prefix: number): bigint {
  return prefix === 0 ? 0n : (V6_ALL << BigInt(128 - prefix)) & V6_ALL;
}

function inV6(n: bigint, base: string, prefix: number) {
  const b = parseIPv6(base)!;
  const m = maskV6(prefix);
  return (n & m) === (b & m);
}

export function classifyIPv6(n: bigint): string {
  if (n === 0n) return 'Unspecified (::)';
  if (n === 1n) return 'Loopback (::1)';
  if (inV6(n, '::ffff:0:0', 96)) return 'IPv4-mapped';
  if (inV6(n, '64:ff9b::', 96)) return 'NAT64 (well-known prefix)';
  if (inV6(n, 'fe80::', 10)) return 'Link-local';
  if (inV6(n, 'fc00::', 7)) return 'Unique local (ULA, private)';
  if (inV6(n, 'ff00::', 8)) return 'Multicast';
  if (inV6(n, '2001:db8::', 32)) return 'Documentation';
  if (inV6(n, '2002::', 16)) return '6to4';
  if (inV6(n, '2001::', 32)) return 'Teredo';
  if (inV6(n, '2000::', 3)) return 'Global unicast';
  return 'Reserved';
}

export function formatBig(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface V6Info {
  input: string;
  prefix: number;
  compressed: string;
  expanded: string;
  network: string;
  networkExpanded: string;
  last: string;
  lastExpanded: string;
  addresses: string;
  addressesPow: string;
  subnets64: string | null;
  type: string;
  arpa: string;
}

export function parseV6Input(input: string): { ip: bigint; prefix: number } | { error: string } {
  const [a, p] = input.trim().split('/');
  const ip = parseIPv6(a || '');
  if (ip === null) return { error: `"${a}" is not a valid IPv6 address` };
  const prefix = p === undefined || p === '' ? 64 : Number(p);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return { error: 'Prefix length must be 0–128' };
  return { ip, prefix };
}

export function ipv6Info(ip: bigint, prefix: number): V6Info {
  const m = maskV6(prefix);
  const net = ip & m;
  const last = net | (~m & V6_ALL);
  const count = 1n << BigInt(128 - prefix);
  const nibbles = Math.ceil(prefix / 4) || 1;
  const hex = expandIPv6(ip).replace(/:/g, '');
  return {
    input: compressIPv6(ip),
    prefix,
    compressed: compressIPv6(ip),
    expanded: expandIPv6(ip),
    network: compressIPv6(net),
    networkExpanded: expandIPv6(net),
    last: compressIPv6(last),
    lastExpanded: expandIPv6(last),
    addresses: formatBig(count),
    addressesPow: `2^${128 - prefix}`,
    subnets64: prefix <= 64 ? formatBig(1n << BigInt(64 - prefix)) : null,
    type: classifyIPv6(ip),
    arpa: hex.slice(0, nibbles).split('').reverse().join('.') + '.ip6.arpa',
  };
}

export function splitIPv6(ip: bigint, prefix: number, newPrefix: number, limit = 64): { count: bigint; subnets: string[] } | { error: string } {
  if (newPrefix < prefix) return { error: `New prefix /${newPrefix} is larger than the network /${prefix}` };
  if (newPrefix > 128) return { error: 'Prefix cannot exceed /128' };
  const base = ip & maskV6(prefix);
  const count = 1n << BigInt(newPrefix - prefix);
  const size = 1n << BigInt(128 - newPrefix);
  const subnets: string[] = [];
  for (let i = 0n; i < count && i < BigInt(limit); i++) subnets.push(`${compressIPv6(base + i * size)}/${newPrefix}`);
  return { count, subnets };
}

// ── Ports ────────────────────────────────────────────────────────────────────

export const PORT_PRESETS: Record<string, { label: string; ports: number[] }> = {
  common: { label: 'Common (19)', ports: [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 587, 993, 995, 3306, 3389, 5432, 6379, 8080, 8443] },
  web: { label: 'Web (13)', ports: [80, 81, 443, 3000, 4443, 5000, 8000, 8008, 8080, 8081, 8443, 8888, 9000] },
  databases: { label: 'Databases (15)', ports: [1433, 1521, 2181, 3306, 5432, 5984, 6379, 7474, 8086, 9042, 9092, 9200, 11211, 27017, 27018] },
  mail: { label: 'Mail (7)', ports: [25, 110, 143, 465, 587, 993, 995] },
  top100: {
    label: 'Top 100',
    ports: [7, 9, 13, 21, 22, 23, 25, 26, 37, 53, 79, 80, 81, 88, 106, 110, 111, 113, 119, 135, 139, 143, 144, 179, 199, 389,
      427, 443, 444, 445, 465, 513, 514, 515, 543, 544, 548, 554, 587, 631, 646, 873, 990, 993, 995, 1025, 1026, 1027, 1028,
      1029, 1110, 1433, 1720, 1723, 1755, 1900, 2000, 2001, 2049, 2121, 2717, 3000, 3128, 3306, 3389, 3986, 4899, 5000, 5009,
      5051, 5060, 5101, 5190, 5357, 5432, 5631, 5666, 5800, 5900, 6000, 6001, 6646, 7070, 8000, 8008, 8009, 8080, 8081, 8443,
      8888, 9100, 9999, 10000, 32768, 49152, 49153, 49154, 49155, 49156, 49157],
  },
};

export const MAX_SCAN_PORTS = 1024;

export function parsePortSpec(spec: string): number[] | { error: string } {
  const preset = PORT_PRESETS[spec.trim().toLowerCase()];
  if (preset) return [...preset.ports];
  const out = new Set<number>();
  for (const raw of spec.split(/[\s,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(part);
    if (!m) return { error: `"${part}" is not a port or range` };
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b) return { error: `Invalid range "${part}" (ports are 1–65535)` };
    if (out.size + (b - a + 1) > MAX_SCAN_PORTS * 4) return { error: 'Too many ports' };
    for (let p = a; p <= b; p++) out.add(p);
  }
  if (!out.size) return { error: 'Enter at least one port' };
  if (out.size > MAX_SCAN_PORTS) return { error: `At most ${MAX_SCAN_PORTS} ports per scan (got ${out.size})` };
  return [...out].sort((x, y) => x - y);
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── misc ─────────────────────────────────────────────────────────────────────

/** SVG polyline points for a sparkline; nulls (lost packets) are skipped. */
export function sparklinePoints(values: (number | null)[], width: number, height: number, pad = 2): string {
  const ok = values.filter((v): v is number => typeof v === 'number');
  if (!ok.length) return '';
  const min = Math.min(...ok);
  const max = Math.max(...ok);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values
    .map((v, i) => (v === null ? null : `${(pad + i * step).toFixed(1)},${(height - pad - ((v - min) / span) * (height - pad * 2)).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
}

export function countryFlag(cc?: string): string {
  if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...cc.toUpperCase().split('').map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatTtl(s: number | undefined): string {
  if (s === undefined) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${s % 3600 >= 60 ? ` ${Math.floor((s % 3600) / 60)}m` : ''}`;
  return `${Math.floor(s / 86400)}d${s % 86400 >= 3600 ? ` ${Math.floor((s % 86400) / 3600)}h` : ''}`;
}
