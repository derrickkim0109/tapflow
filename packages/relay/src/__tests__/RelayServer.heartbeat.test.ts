import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket, WebSocketServer } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { waitForMessage, waitForOpen } from '@tapflowio/test-utils'
import type { AgentsListed } from '@tapflowio/protocol'


// Minimal stand-in for a ws socket — only the surface runHeartbeat() touches.
type MockSocket = { readyState: number; ping: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
const makeSock = (readyState: number = WebSocket.OPEN): MockSocket => ({
  readyState,
  ping: vi.fn(),
  terminate: vi.fn(),
})

// Internal surface poked by these tests (mirrors the `as unknown as {...}` idiom in RelayServer.test.ts).
type HeartbeatInternals = {
  wss: WebSocketServer
  lastPongAt: WeakMap<object, number>
  heartbeatTimer: ReturnType<typeof setInterval> | null
  runHeartbeat: (clients?: Iterable<unknown>) => void
}
const internals = (server: RelayServer) => server as unknown as HeartbeatInternals

const sweep = (server: RelayServer, socks: MockSocket[]) => internals(server).runHeartbeat(socks)
/** Liveness is a pong timestamp now, not a swept flag — "dead" is "answered longer ago than the sweep
 *  tolerates". The flag it replaced read `false` for every live socket for the length of a ping round
 *  trip, which was harmless while it only decided termination and is not once occupancy reads it. */
const setAlive = (server: RelayServer, sock: MockSocket, alive: boolean) =>
  internals(server).lastPongAt.set(sock, alive ? Date.now() : Date.now() - 10 * 60_000)

describe('RelayServer — WebSocket heartbeat (#313)', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-relay-hb-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  describe('runHeartbeat sweep (mock sockets)', () => {
    let server: RelayServer

    beforeEach(async () => {
      server = new RelayServer({ port: 0 })
      await server.start()
    })

    afterEach(async () => {
      await server.stop()
    })

    it('terminates a socket that has not answered for longer than the sweep tolerates', () => {
      // **The clock is what decides now, not the number of sweeps.** The swept flag encoded "one interval
      // has passed" structurally, so two back-to-back sweeps were enough; a timestamp encodes it in wall
      // time, which is the whole point — the flag read every live socket as dead for a ping round trip,
      // and occupancy cannot be built on a signal like that.
      vi.useFakeTimers()
      try {
        const sock = makeSock()
        setAlive(server, sock, true)

        // Still inside the tolerance: probed, not terminated.
        vi.setSystemTime(Date.now() + 30_000)
        sweep(server, [sock])
        expect(sock.terminate).not.toHaveBeenCalled()
        expect(sock.ping).toHaveBeenCalledTimes(1)

        // Past 1.5 intervals with no pong: terminated, and not probed again.
        vi.setSystemTime(Date.now() + 30_000)
        sweep(server, [sock])
        expect(sock.terminate).toHaveBeenCalledTimes(1)
        expect(sock.ping).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a socket that ponged between sweeps', () => {
      const sock = makeSock()
      setAlive(server, sock, true)

      sweep(server, [sock]) // probe 1, marks dead
      setAlive(server, sock, true) // pong handler would do this
      sweep(server, [sock]) // alive again → survives, probe 2

      expect(sock.terminate).not.toHaveBeenCalled()
      expect(sock.ping).toHaveBeenCalledTimes(2)
    })

    it('probes every client regardless of role (agent/browser/stream all in wss.clients)', () => {
      const agent = makeSock()
      const browser = makeSock()
      const stream = makeSock()
      for (const s of [agent, browser, stream]) setAlive(server, s, true)

      sweep(server, [agent, browser, stream])

      for (const s of [agent, browser, stream]) {
        expect(s.terminate).not.toHaveBeenCalled()
        expect(s.ping).toHaveBeenCalledTimes(1)
      }
    })

    it('does not ping a non-OPEN socket (avoids ws throw)', () => {
      const connecting = makeSock(WebSocket.CONNECTING)
      const closing = makeSock(WebSocket.CLOSING)
      setAlive(server, connecting, true)
      setAlive(server, closing, true)

      sweep(server, [connecting, closing])

      expect(connecting.ping).not.toHaveBeenCalled()
      expect(closing.ping).not.toHaveBeenCalled()
    })

    it('does not terminate a freshly-connected socket on its first sweep (unseeded)', () => {
      const fresh = makeSock() // never marked alive (just connected, no entry yet)

      sweep(server, [fresh])

      expect(fresh.terminate).not.toHaveBeenCalled()
      expect(fresh.ping).toHaveBeenCalledTimes(1)
    })
  })

  describe('integration — real sockets', () => {
    let server: RelayServer
    let port: number

    beforeEach(async () => {
      server = new RelayServer({ port: 0 })
      await server.start()
      port = (server.address() as { port: number }).port
    })

    afterEach(async () => {
      await server.stop()
    })

    it('terminates a dead agent socket and evicts its sessions (terminate → existing close cleanup)', async () => {
      const agent = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agent)
      agent.send(JSON.stringify({ type: 'agent:register', platform: 'ios', agentName: 'DeadMac', devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(agent) // agent:registered

      const closed = new Promise<void>((resolve) => agent.on('close', () => resolve()))

      // Force the server-side socket to look dead, then run a real sweep.
      const serverWs = [...internals(server).wss.clients][0]
      internals(server).lastPongAt.set(serverWs, Date.now() - 10 * 60_000)
      internals(server).runHeartbeat()

      await closed // terminate() fired the close handler

      const observer = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(observer)
      await vi.waitFor(async () => {
        observer.send(JSON.stringify({ type: 'agents:list' }))
        const listed = await waitForMessage<AgentsListed>(observer)
        expect(listed.sessions).toHaveLength(0)
      }, { timeout: 2000 })
      observer.close()
    })

    it('keeps a live agent connected across heartbeats (real auto-pong)', async () => {
      const agent = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agent)
      agent.send(JSON.stringify({ type: 'agent:register', platform: 'ios', agentName: 'LiveMac', devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(agent)

      let closedUnexpectedly = false
      agent.on('close', () => { closedUnexpectedly = true })

      internals(server).runHeartbeat() // probe → marks dead, sends ping
      await new Promise<void>((r) => setTimeout(r, 50)) // client auto-pongs over loopback
      internals(server).runHeartbeat() // pong revived it → survives

      expect(closedUnexpectedly).toBe(false)
      expect(agent.readyState).toBe(WebSocket.OPEN)

      const observer = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(observer)
      observer.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForMessage<AgentsListed>(observer)
      expect(listed.sessions.filter((s) => s.agentName === 'LiveMac')).toHaveLength(1)

      agent.close()
      observer.close()
    })
  })

  describe('lifecycle', () => {
    it('stop() clears the heartbeat timer', async () => {
      const server = new RelayServer({ port: 0 })
      await server.start()
      expect(internals(server).heartbeatTimer).not.toBeNull() // started by start()
      await server.stop()
      expect(internals(server).heartbeatTimer).toBeNull()
    })
  })

  // A heartbeat termination used to leave no trace, so an agent drop could not be told apart from a network
  // loss afterwards. These pin what `tapflow logs` (the `pushLog` buffer) now records.
  describe('diagnostics', () => {
    let server: RelayServer
    type Diag = HeartbeatInternals & {
      logBuffer: string[]
      wsRoles: Map<object, 'agent' | 'browser' | 'stream'>
      agentNames: WeakMap<object, string>
      lastSweepAt: number
      noteLateSweep: (now?: number) => void
    }
    const diag = (s: RelayServer) => s as unknown as Diag

    beforeEach(async () => { server = new RelayServer({ port: 0 }); await server.start() })
    afterEach(async () => { await server.stop(); vi.useRealTimers() })

    it('logs an agent it terminates by name, with how long since its last pong', () => {
      const sock = makeSock()
      diag(server).wsRoles.set(sock, 'agent')
      diag(server).agentNames.set(sock, 'mac-mini')
      diag(server).lastPongAt.set(sock, Date.now() - 52_000)
      sweep(server, [sock])
      expect(sock.terminate).toHaveBeenCalledTimes(1)
      expect(diag(server).logBuffer.join('\n')).toMatch(/heartbeat terminated agent mac-mini — last pong 52s ago/)
    })

    // A relay waking from sleep finds every socket stale at once; one line per browser tab would push the
    // agent lines out of a 500-line buffer.
    it('sums browser and stream terminations into one line per sweep', () => {
      const socks = [makeSock(), makeSock(), makeSock()]
      diag(server).wsRoles.set(socks[0], 'browser')
      diag(server).wsRoles.set(socks[1], 'browser')
      diag(server).wsRoles.set(socks[2], 'stream')
      for (const s of socks) setAlive(server, s, false)
      sweep(server, socks)
      const lines = diag(server).logBuffer.filter((l) => l.includes('heartbeat terminated'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/heartbeat terminated 2 browser, 1 stream socket\(s\)/)
    })

    it('logs nothing for live sockets', () => {
      const sock = makeSock()
      diag(server).wsRoles.set(sock, 'agent')
      setAlive(server, sock, true)
      sweep(server, [sock])
      expect(diag(server).logBuffer.some((l) => l.includes('heartbeat'))).toBe(false)
    })

    // A sweep that runs late means the relay itself was held (or the machine slept), and the pongs it
    // judges were never read: its terminations say nothing about the clients.
    it('notes a sweep that ran more than half an interval late', () => {
      const base = diag(server).lastSweepAt
      diag(server).noteLateSweep(base + 30_000)
      expect(diag(server).logBuffer.some((l) => l.includes('sweep ran'))).toBe(false)
      diag(server).noteLateSweep(base + 30_000 + 50_000)
      expect(diag(server).logBuffer.join('\n')).toMatch(/heartbeat sweep ran 20s late — the relay was stalled or the system slept/)
    })

    const port = () => (server.address() as { port: number }).port
    const register = async (name: string) => {
      const ws = new WebSocket(`ws://localhost:${port()}`)
      await waitForOpen(ws)
      ws.send(JSON.stringify({ type: 'agent:register', platform: 'ios', agentName: name, devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(ws) // agent:registered
      return ws
    }

    it('records an agent connecting, so a close line is not the last word on it', async () => {
      const ws = await register('mac-mini')
      expect(diag(server).logBuffer.join('\n')).toMatch(/agent connected: mac-mini \(ios\)/)
      ws.close()
    })

    // A re-registration terminates the old socket; logged as a plain close it would read like a drop of an
    // agent that is in fact already back.
    it('says a socket was replaced when the same agent registered again', async () => {
      const first = await register('mac-mini')
      const firstClosed = new Promise<void>((r) => first.on('close', () => r()))
      const second = await register('mac-mini')
      await firstClosed
      await vi.waitFor(() => expect(diag(server).logBuffer.join('\n')).toMatch(/agent socket replaced: mac-mini/))
      expect(diag(server).logBuffer.some((l) => /agent socket closed: mac-mini/.test(l))).toBe(false)
      second.close()
    })

    it('does not log a second close line for an agent the sweep just terminated', async () => {
      const ws = await register('mac-mini')
      const closed = new Promise<void>((r) => ws.on('close', () => r()))
      const serverWs = [...diag(server).wss.clients][0]
      diag(server).lastPongAt.set(serverWs, Date.now() - 10 * 60_000)
      diag(server).runHeartbeat()
      await closed
      await new Promise((r) => setTimeout(r, 50))
      expect(diag(server).logBuffer.filter((l) => l.includes('mac-mini') && /terminated|closed/.test(l))).toHaveLength(1)
    })

    it('logs an agent socket closing, with its name and close code', async () => {
      const ws = new WebSocket(`ws://localhost:${(server.address() as { port: number }).port}`)
      await waitForOpen(ws)
      ws.send(JSON.stringify({ type: 'agent:register', platform: 'ios', agentName: 'mac-mini', devices: [{ id: 'devA', name: 'iPhone A', platform: 'ios', status: 'shutdown' }] }))
      await waitForMessage(ws) // agent:registered
      ws.close(1001, 'going away')
      await vi.waitFor(() => expect(diag(server).logBuffer.join('\n')).toMatch(/agent socket closed: mac-mini \(code 1001 going away, last pong \d+s ago\)/))
    })

    it('logs no agent closes when the relay itself is stopping', async () => {
      const ws = await register('mac-mini')
      const closed = new Promise<void>((r) => ws.on('close', () => r()))
      const buf = diag(server).logBuffer
      await server.stop()
      await closed
      expect(buf.some((l) => l.includes('agent socket closed'))).toBe(false)
      server = new RelayServer({ port: 0 }); await server.start()
    })
  })
})
