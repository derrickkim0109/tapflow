export interface TunnelPorts {
  /** Where the relay serves its LAN — loopback connections here are local and skip sign-in. */
  relayPort: number
  /** The relay's loopback-only listener for tunnel clients, where every connection is remote. */
  tunnelPort: number
}

export interface TunnelStartResult {
  publicUrl: string
  /** Things the operator should fix, printed as the tunnel comes up. */
  warnings?: string[]
}

export interface TunnelPlugin {
  name: string
  setupServer(): Promise<void>
  start(ports: TunnelPorts): Promise<TunnelStartResult>
  stop(): Promise<void>
}
