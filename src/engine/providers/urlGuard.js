// SSRF protection for user-supplied provider base URLs.
//
// The worker makes HTTP requests to whatever base URL a user saved. Without a
// check, a user could point it at http://169.254.169.254/ (cloud metadata) or
// an internal admin service and read the response back as "model output".
//
// Known limitation: the hostname is resolved here and then again by fetch(),
// so a DNS-rebinding attacker could return a public IP first and a private IP
// second. Fully closing that gap requires pinning the resolved IP for the
// connection, which is documented as future work.
import dns from 'node:dns/promises';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
]) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');

export function isPrivateAddress(address) {
  const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be checked as IPv4.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, family);
}

export class UnsafeUrlError extends Error {}

export async function assertSafeProviderUrl(rawUrl, { allowPrivate }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('Base URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeUrlError('Base URL must use http or https');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('Base URL must not contain credentials');
  }
  if (allowPrivate) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true }).catch(() => {
        throw new UnsafeUrlError(`Could not resolve host "${hostname}"`);
      });
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new UnsafeUrlError('Base URL resolves to a private or loopback address');
  }
  return url;
}
