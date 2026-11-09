import { BlockList, isIP } from 'node:net';

export function normalizeIP(value) {
  if (typeof value !== 'string' || value.includes('%')) return null;
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) return null;
  const ip = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = ip.match(/^::ffff:([\da-f]+):([\da-f]+)$/);
  if (!mapped) return ip;
  return mapped.slice(1).flatMap(part => {
    const number = parseInt(part, 16);
    return [number >> 8, number & 255];
  }).join('.');
}

export function makeTrustProxy(cidrs = '') {
  const ranges = new BlockList();
  for (const entry of cidrs.split(',').map(s => s.trim()).filter(Boolean)) {
    const [address, prefix, extra] = entry.split('/');
    const version = isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error(`Invalid TRUSTED_PROXIES entry: ${entry}`);
    }
    const family = version === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) ranges.addAddress(address, family);
    else ranges.addSubnet(address, Number(prefix), family);
  }
  return ip => ranges.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}

export function clientIP(req, isTrusted) {
  let ip = normalizeIP(req.socket.remoteAddress);
  if (!ip) throw new Error('Missing peer IP');
  // Walk from the socket toward the client, stopping at the first untrusted hop.
  // Forged headers on direct requests never replace the socket IP.
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',');
  for (const part of forwarded.reverse()) {
    if (!isTrusted(ip)) break;
    const next = normalizeIP(part.trim());
    if (!next) break;
    ip = next;
  }
  return ip;
}

export function rateLimitKey(ip) {
  if (isIP(ip) === 4) return ip;
  // Group IPv6 privacy addresses by /64, while retaining the full IP in signups.
  const [left, right = ''] = ip.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const groups = ip.includes('::')
    ? [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]
    : start;
  return `${groups.slice(0, 4).map(g => g.padStart(4, '0')).join(':')}::/64`;
}
