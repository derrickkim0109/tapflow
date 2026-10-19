import type { TapflowConfig } from './config.js'

// The addresses tapflow hands to someone else, decided here and nowhere else.
//
// **Never from the Host header.** `req.headers.host` and `x-forwarded-proto` are client-controlled, so a
// forged one would send a phishing link out as a normal invitation (#6). Everything below reads
// configuration, plus what an entry point observed when it started a tunnel.
//
// **Two settings, two meanings.** A tunnel's `publicUrl` is where a teammate's browser goes. `relay.url`
// is where agents and the CLI connect (docs/reference/configuration.md). A link can fall back from one
// to the other; an agent address must not take the tunnel, because an agent on the relay's own LAN would
// then stream through a VPS, and `downloadBuild` uses only the origin, so a tunnel URL with a path would
// fail every install.
//
// **What a tunnel did beats what config says.** Config names a tunnel; only the process that started it
// knows whether it came up and at which address (a Tailscale URL is detected, not configured — #794).
// That process passes a `TunnelRuntime`. With none, nothing here can tell, so config is trusted — the
// standalone relay starts no tunnel and its operator may run one separately.
//
// **The localhost fallback is for mail only.** An invitation has to carry some address; the dashboard
// does not, because the browser already knows one that works. So `buildInviteBaseUrl` falls back, and
// what the dashboard receives goes through `forTeammates` instead.

type PublicUrlConfig = Pick<TapflowConfig, 'tunnel' | 'relay' | 'local'>

/**
 * What the entry point that started a tunnel observed. `publicUrl: null` means it tried and has no
 * address to offer (missing token, failed start). An absent `TunnelRuntime` means no entry point manages
 * a tunnel, which is a different fact and makes config the only source.
 */
export interface TunnelRuntime {
  publicUrl: string | null
}

/**
 * Every public base this relay is known by, most preferred first: the tunnel (as started, or as configured
 * when no entry point reports one), then `relay.url`. CORS allowlists all of them. Each is an address the
 * operator gave this relay, and dropping `relay.url` whenever a tunnel came up would 403 the dashboard
 * behind a proxy that rewrites Host.
 */
export function resolvePublicBaseUrls(cfg: PublicUrlConfig, tunnel?: TunnelRuntime): string[] {
  const bases: string[] = []
  const tunnelUrl = tunnel ? tunnel.publicUrl : cfg.tunnel?.publicUrl
  if (tunnelUrl) bases.push(stripTrailingSlash(tunnelUrl))
  if (cfg.relay.url) {
    const http = cfg.relay.url.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://')
    bases.push(stripTrailingSlash(http))
  }
  return bases
}

/** The base a teammate's browser should use, or null when neither a tunnel nor `relay.url` gives one. */
export function resolvePublicBaseUrl(cfg: PublicUrlConfig, tunnel?: TunnelRuntime): string | null {
  return resolvePublicBaseUrls(cfg, tunnel)[0] ?? null
}

/** Base for links in outgoing mail. Called with one argument, the result is what it has always been. */
export function buildInviteBaseUrl(cfg: PublicUrlConfig, tunnel?: TunnelRuntime): string {
  return resolvePublicBaseUrl(cfg, tunnel) ?? `http://localhost:${cfg.local.port}`
}

/** Where an agent should connect, as ws/wss, from `relay.url` alone. */
export function resolveAgentRelayUrl(cfg: Pick<TapflowConfig, 'relay'>): string | null {
  if (!cfg.relay.url) return null
  const ws = cfg.relay.url.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://')
  return stripTrailingSlash(ws)
}

const UNOPENABLE_HOSTS = new Set(['localhost', '::1', '0.0.0.0', '::'])

/**
 * Null for an address a teammate cannot open: loopback in any spelling the URL parser leaves (`127.x`,
 * `::1`, `::ffff:7f00:1`, a trailing-dot `localhost.`), a bind-all address (`0.0.0.0`, `::`), or one that
 * does not parse. `relay.url` is legitimately `ws://localhost:4000` for a co-located CLI — the MCP docs
 * give that value for the same variable — and handing it to the dashboard would replace a working browser
 * origin with localhost. Applied only to what the dashboard receives; mail and CORS keep the unfiltered value.
 */
export function forTeammates(url: string | null): string | null {
  if (url === null) return null
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return null
  }
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (UNOPENABLE_HOSTS.has(host) || /^127\./.test(host) || /^::ffff:(127\.|7f[0-9a-f]{2}:)/i.test(host)) return null
  return url
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '')
}
