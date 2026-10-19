import { execSync } from 'child_process'
import type { TunnelPlugin, TunnelPorts, TunnelStartResult } from './tunnel.js'

interface TailscaleStatus {
  BackendState?: string
  /** false when tailscaled runs with `--tun=userspace-networking`. */
  TUN?: boolean
  Self?: {
    DNSName?: string
    TailscaleIPs?: string[]
  }
}

export interface TailscaleTunnelOptions {
  publicUrl?: string
}

function readStatus(): TailscaleStatus {
  const raw = execSync('tailscale status --json', { stdio: 'pipe' }).toString()
  return JSON.parse(raw) as TailscaleStatus
}

/**
 * What would let a tailnet member reach the relay port from loopback, where the relay asks for nothing.
 *
 * Both are checks, not fixes: tapflow does not own the Tailscale configuration, and a userspace-networking
 * daemon delivers **every** tailnet port from loopback, so no listener can tell those visitors apart.
 */
function localhostExposureWarnings(status: TailscaleStatus | null, { relayPort, tunnelPort }: TunnelPorts): string[] {
  const warnings: string[] = []
  if (status?.TUN === false) {
    warnings.push(
      'Tailscale is running in userspace-networking mode, which delivers tailnet connections to this machine as ' +
      'localhost — the relay cannot ask them to sign in. Run tailscaled with a TUN device (the default) before ' +
      'sharing this relay over Tailscale.',
    )
  }

  // Matched as text rather than by field: the serve config nests handlers by host and port, and the only
  // fact needed is whether any of them forwards to the relay port on loopback.
  let serve: string
  try {
    serve = execSync('tailscale serve status --json', { stdio: 'pipe' }).toString()
  } catch {
    return warnings
  }
  if (new RegExp(`(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${relayPort}(?!\\d)`).test(serve)) {
    warnings.push(
      `tailscale serve forwards to the relay port ${relayPort}, where connections count as local and skip ` +
      `sign-in. Point it at the tunnel port instead: \`tailscale serve reset\` (clears every serve setting), ` +
      `then \`tailscale serve --bg ${tunnelPort}\`.`,
    )
  }
  return warnings
}

export class TailscaleTunnel implements TunnelPlugin {
  name = 'tailscale'

  constructor(private opts: TailscaleTunnelOptions) {}

  async setupServer(): Promise<void> {
    // no-op — Tailscale manages its own network layer
  }

  async start(ports: TunnelPorts): Promise<TunnelStartResult> {
    if (this.opts.publicUrl) {
      // No detection needed, and none required: a configured URL works without the CLI. The checks still
      // run, because a configured HTTPS URL is how the `tailscale serve` setup is written.
      let status: TailscaleStatus | null = null
      try { status = readStatus() } catch { /* not installed, or not reachable */ }
      return { publicUrl: this.opts.publicUrl, warnings: localhostExposureWarnings(status, ports) }
    }

    try {
      execSync('tailscale version', { stdio: 'pipe' })
    } catch {
      throw new Error(
        'Tailscale is not installed or not in PATH.\n' +
        'Install: brew install tailscale  (macOS) · https://tailscale.com/download\n' +
        'Then run: sudo tailscale up'
      )
    }

    let status: TailscaleStatus
    try {
      status = readStatus()
    } catch {
      throw new Error('Failed to query Tailscale status. Run: tailscale up')
    }

    if (status.BackendState !== 'Running') {
      throw new Error(
        `Tailscale is not connected (state: ${status.BackendState ?? 'unknown'}).\n` +
        'Run: tailscale up'
      )
    }

    const warnings = localhostExposureWarnings(status, ports)
    const dnsName = status.Self?.DNSName?.replace(/\.$/, '')
    if (dnsName) return { publicUrl: `http://${dnsName}:${ports.relayPort}`, warnings }

    const ips = status.Self?.TailscaleIPs ?? []
    const ip = ips.find(a => !a.includes(':')) ?? ips[0]
    if (ip) {
      const host = ip.includes(':') ? `[${ip}]` : ip
      return { publicUrl: `http://${host}:${ports.relayPort}`, warnings }
    }

    throw new Error('Could not determine Tailscale IP. Make sure Tailscale is connected: tailscale up')
  }

  async stop(): Promise<void> {
    // no-op — tapflow does not manage the Tailscale lifecycle
  }
}
