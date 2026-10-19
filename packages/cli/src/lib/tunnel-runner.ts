import type { TapflowConfig, TunnelRuntime } from '@tapflowio/relay'
import { RatholeTunnel } from './rathole-tunnel.js'
import { TailscaleTunnel } from './tailscale-tunnel.js'
import { step, warn } from './print.js'
import type { TunnelPlugin, TunnelPorts } from './tunnel.js'

export type TunnelConfig = NonNullable<TapflowConfig['tunnel']>

export interface StartedTunnel {
  tunnel: TunnelPlugin | null
  publicUrl: string | null
}

/**
 * Build the configured tunnel, start it, and return its public URL.
 * On startup failure the relay keeps running — returns nulls so callers fall back to local-only.
 */
export async function startConfiguredTunnel(tunnelCfg: TunnelConfig, ports: TunnelPorts): Promise<StartedTunnel> {
  let tunnel: TunnelPlugin
  if (tunnelCfg.provider === 'tailscale') {
    tunnel = new TailscaleTunnel({ publicUrl: tunnelCfg.publicUrl })
  } else {
    const token = process.env.TAPFLOW_TUNNEL_TOKEN ?? ''
    if (!token) {
      warn('TAPFLOW_TUNNEL_TOKEN env var is required for rathole tunnel — continuing without a public tunnel.')
      return { tunnel: null, publicUrl: null }
    }
    tunnel = new RatholeTunnel({ serverAddr: tunnelCfg.serverAddr, publicUrl: tunnelCfg.publicUrl, token, ssh: tunnelCfg.ssh ?? undefined })
  }

  try {
    await tunnel.setupServer()
    const { publicUrl, warnings } = await tunnel.start(ports)
    step(`Tunnel ready — Public URL: ${publicUrl}`)
    for (const message of warnings ?? []) warn(message)
    return { tunnel, publicUrl }
  } catch (err) {
    console.warn(`Tunnel failed to start: ${err instanceof Error ? err.message : String(err)}`)
    return { tunnel: null, publicUrl: null }
  }
}

/**
 * What the relay is told about the tunnel that was just started. A TLS relay answers only HTTPS on its
 * port, so any http:// tunnel URL is an address nothing answers — a detected Tailscale URL always is one,
 * and a configured URL may be. Passing it on would put it into mail, dashboard links and CORS, so the relay
 * behaves as if the tunnel offered no address. rathole forwards raw TCP to the relay port, so a configured
 * http:// URL in front of a TLS relay was already dead before this rule.
 */
export function tunnelRuntimeFor(publicUrl: string | null, relayUsesTls: boolean): TunnelRuntime {
  if (publicUrl && relayUsesTls && /^http:\/\//i.test(publicUrl)) return { publicUrl: null }
  return { publicUrl }
}
