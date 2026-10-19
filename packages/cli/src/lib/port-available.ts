import net from 'net'

/**
 * Why the relay could not listen on `port` right now, or null when it could: probed with the bind
 * `RelayServer.start()` uses (dual-stack, or `host` for the tunnel listener), then released.
 *
 * The start commands bring a tunnel up before the relay, and rathole's `setupServer` restarts the
 * VPS-side server. Without this check, a second `tapflow relay start` that was always going to fail on
 * the port would first take down the tunnel of the instance already running. The gap between this check
 * and the relay's own listen is accepted.
 *
 * **Every bind error counts, not only `EADDRINUSE`.** This used to answer a bare "is it free?" and treat
 * anything else — `EACCES` on a port under 1024 — as free, so that the relay could report it in its own
 * words rather than as "already in use". That reasoning held while nothing happened between the probe
 * and the relay's listen. It does not now: the tunnel starts in between, so an `EACCES` left for the
 * relay to find costs a VPS-side restart to discover. The caller says which code it got instead.
 */
export function probeBind(port: number, host?: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err))
    const done = () => probe.close(() => resolve(null))
    // A specific host is probed as itself: the tunnel listener binds 127.0.0.1 alone, and a wildcard bind
    // is not guaranteed to collide with that on macOS.
    if (host === undefined) probe.listen({ port, host: '::', ipv6Only: false }, done)
    else probe.listen({ port, host }, done)
  })
}

/**
 * Refuses before anything else starts when a port cannot be taken.
 *
 * The two ports read differently to whoever is looking at the terminal: the relay port is the one they
 * chose or left at its default, while the tunnel port is usually one they never named, so its message
 * carries the setting that moves it.
 */
export async function refuseUnlessBindable(port: number, role: 'relay' | 'tunnel', host?: string): Promise<void> {
  const err = await probeBind(port, host)
  if (!err) return
  const name = role === 'relay' ? `Port ${port}` : `Tunnel port ${port}`
  if (err.code === 'EADDRINUSE') {
    throw new Error(role === 'relay'
      ? `${name} is already in use. Stop the existing process and try again.`
      : `${name} is already in use. Stop the process holding it, or set TAPFLOW_TUNNEL_PORT to a free port.`)
  }
  const hint = role === 'relay'
    ? 'Choose a port this user can bind, or run the relay with the privileges it needs.'
    : 'Set TAPFLOW_TUNNEL_PORT to a port this user can bind.'
  throw new Error(`${name} cannot be opened (${err.code ?? err.message}). ${hint}`)
}
