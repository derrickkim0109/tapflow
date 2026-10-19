import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { probeBind, refuseUnlessBindable } from '../../lib/port-available.js'

// Same bind as RelayServer.start(): a probe on a different address could call a port free that the
// relay then fails to take.
function listen(port = 0, host = '::'): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(host === '::' ? { port, host, ipv6Only: false } : { port, host }, () => resolve(server))
  })
}

const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()))

/** The refusal a call produced, so its sentence can be read rather than only matched. */
async function refusal(call: Promise<void>): Promise<Error> {
  try {
    await call
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a refusal, got none')
}

describe('probeBind', () => {
  it('names EADDRINUSE for a port something is listening on', async () => {
    const server = await listen()
    const { port } = server.address() as net.AddressInfo
    try {
      expect((await probeBind(port))?.code).toBe('EADDRINUSE')
    } finally {
      await close(server)
    }
  })

  it('answers null for a released port, and does not keep holding it', async () => {
    const first = await listen()
    const { port } = first.address() as net.AddressInfo
    await close(first)

    expect(await probeBind(port)).toBeNull()
    // Rejects with EADDRINUSE if the probe left its socket open.
    const again = await listen(port)
    await close(again)
  })

  // The tunnel listener binds 127.0.0.1 alone, and a wildcard probe is not guaranteed to collide with
  // that on macOS, so the probe has to ask about the same address.
  it('probes the address it is given', async () => {
    const server = await listen(0, '127.0.0.1')
    const { port } = server.address() as net.AddressInfo
    try {
      expect((await probeBind(port, '127.0.0.1'))?.code).toBe('EADDRINUSE')
    } finally {
      await close(server)
    }
    expect(await probeBind(port, '127.0.0.1')).toBeNull()
  })

  // The case the lenient version called "free": a bind that fails for a reason of its own. An address
  // this host does not have stands in for EACCES on a privileged port, which needs no root to produce.
  it('names a bind error that is not EADDRINUSE', async () => {
    const err = await probeBind(0, '203.0.113.7')
    expect(err).not.toBeNull()
    expect(err?.code).not.toBe('EADDRINUSE')
  })
})

describe('refuseUnlessBindable', () => {
  it('passes silently when the port is free', async () => {
    await expect(refuseUnlessBindable(0, 'relay')).resolves.toBeUndefined()
    await expect(refuseUnlessBindable(0, 'tunnel', '127.0.0.1')).resolves.toBeUndefined()
  })

  it('says how to free the relay port, and which setting moves the tunnel port', async () => {
    const server = await listen()
    const { port } = server.address() as net.AddressInfo
    try {
      await expect(refuseUnlessBindable(port, 'relay')).rejects.toThrow(/already in use. Stop the existing process/)
      await expect(refuseUnlessBindable(port, 'tunnel')).rejects.toThrow(/TAPFLOW_TUNNEL_PORT/)
    } finally {
      await close(server)
    }
  })

  // Before this, such a port answered "free", the tunnel started — restarting the VPS-side rathole
  // server on its way — and only the relay's own listen reported the problem.
  it('refuses a port that cannot be bound for another reason, naming the code and the way out', async () => {
    const tunnel = await refusal(refuseUnlessBindable(0, 'tunnel', '203.0.113.7'))
    expect(tunnel.message).toMatch(/cannot be opened \(EADDRNOTAVAIL\)/)
    expect(tunnel.message).toContain('TAPFLOW_TUNNEL_PORT')

    const relay = await refusal(refuseUnlessBindable(0, 'relay', '203.0.113.7'))
    expect(relay.message).toMatch(/cannot be opened \(EADDRNOTAVAIL\)/)
    expect(relay.message).toMatch(/privileges it needs/)
    expect(relay.message).not.toContain('TAPFLOW_TUNNEL_PORT')
  })
})
