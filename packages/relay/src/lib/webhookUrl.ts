import net from 'net'

// Loopback, unspecified, link-local (which holds the 169.254.169.254 metadata service) and AWS's IPv6
// metadata address. Private LAN ranges (10/172.16/192.168, fc00::/7) are intentionally absent:
// self-hosted CI usually lives there, and webhooks reaching it is the feature.
const blocked = new net.BlockList()

// BlockList matches the IPv4-mapped form (::ffff:127.0.0.1, ::ffff:7f00:1) of an IPv4 subnet by itself,
// but no other IPv6 spelling that carries an IPv4 address. Those are added as subnets of their own:
// IPv4-compatible ::a.b.c.d, IPv4-translated ::ffff:0:a.b.c.d (RFC 6052), the NAT64 well-known
// prefix 64:ff9b::/96, and 6to4 2002:aabb:ccdd::/48 — a NAT64 or 6to4 gateway on the relay's network
// hands such an address to the embedded IPv4 host. Not covered: the local-use NAT64 prefix
// 64:ff9b:1::/48 (RFC 8215) and any prefix an operator picks. Only a gateway that operator configured
// translates those, and an operator's own prefix cannot be known from here.
function blockIPv4Subnet(address: string, prefix: number): void {
  blocked.addSubnet(address, prefix, 'ipv4')
  const [a, b, c, d] = address.split('.').map(Number)
  const hi = ((a << 8) | b).toString(16)
  const lo = ((c << 8) | d).toString(16)
  blocked.addSubnet(`::${hi}:${lo}`, 96 + prefix, 'ipv6')
  blocked.addSubnet(`::ffff:0:${hi}:${lo}`, 96 + prefix, 'ipv6')
  blocked.addSubnet(`64:ff9b::${hi}:${lo}`, 96 + prefix, 'ipv6')
  blocked.addSubnet(`2002:${hi}:${lo}::`, 16 + prefix, 'ipv6')
}
blockIPv4Subnet('127.0.0.0', 8)
blockIPv4Subnet('0.0.0.0', 8)
blockIPv4Subnet('169.254.0.0', 16)
blocked.addAddress('::1', 'ipv6')
blocked.addAddress('::', 'ipv6')
blocked.addSubnet('fe80::', 10, 'ipv6')
blocked.addAddress('fd00:ec2::254', 'ipv6')

/** True when an IP address is one a webhook must never be delivered to. */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 0) return false
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Validate a webhook destination URL. Returns an error string, or null when allowed.
 * Blocks loopback and cloud-metadata addresses; private LAN ranges (10/172.16/192.168)
 * are intentionally allowed because self-hosted CI often lives there.
 *
 * This is the registration-time check and sees only the URL, so a hostname is judged by its name.
 * The address it resolves to is judged at delivery, by webhookTransport.ts — DNS can point a
 * harmless-looking name at loopback, and can change after registration.
 *
 * Lives in its own module so both webhooks.ts (delivery) and config.ts (config-file
 * endpoints) can validate without a circular import — webhooks.ts imports config.ts,
 * so config.ts can't import back into webhooks.ts.
 */
export function validateWebhookUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'Invalid URL'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'URL must use http or https'
  }
  // fetch refused these outright; node's http client would turn them into an Authorization header.
  if (u.username || u.password) {
    return 'URL must not contain credentials'
  }
  // WHATWG URL has already canonicalized numeric IPv4 spellings (2130706433, 0x7f.1 → 127.0.0.1).
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '') // strip IPv6 brackets
    .replace(/\.$/, '') // a trailing dot names the same host
  // RFC 6761 reserves localhost and every name under it for loopback, with no DNS involved.
  if (host === 'localhost' || host.endsWith('.localhost') || isBlockedAddress(host)) {
    return 'URL host is not allowed (loopback or metadata address)'
  }
  return null
}
