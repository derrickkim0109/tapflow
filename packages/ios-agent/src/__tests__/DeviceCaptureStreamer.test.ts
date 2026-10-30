import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { DeviceCaptureStreamer, DEVICE_CAPTURE_EXIT } from '../DeviceCaptureStreamer'
import type { DeviceCaptureDeps, HelperSocket } from '../DeviceCaptureStreamer'

// The system boundaries are the LaunchServices launch and the loopback socket; both are doubled here.
class FakeSocket extends EventEmitter implements HelperSocket {
  write = vi.fn()
  destroyed = false
  destroy = vi.fn(() => {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  })
}

function harness(launchResult: Promise<void> = Promise.resolve()) {
  let accept: ((sock: HelperSocket) => void) | null = null
  const server = { port: 54321, close: vi.fn() }
  const deps: DeviceCaptureDeps = {
    ensureApp: () => '/apps/device-capture-helper.app',
    listen: (onConnection) => { accept = onConnection; return Promise.resolve(server) },
    launch: vi.fn(() => launchResult),
  }
  const connect = () => {
    const sock = new FakeSocket()
    if (!accept) throw new Error('listen was never called')
    accept(sock)
    return sock
  }
  return { deps, server, connect }
}

const h264Frame = (flags: number, payload: number[]) => {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(payload.length + 1, 0)
  head[4] = flags
  return Buffer.concat([head, Buffer.from(payload)])
}

describe('DeviceCaptureStreamer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // Mutations: pass the port anywhere but first (the helper parses `<port> <udid> <fps> <codec>`); swap
  // udid and fps; drop `--name` (two attached iPhones would then be ambiguous to the helper).
  it('launches the app with the loopback port first, then the helper arguments', async () => {
    const { deps } = harness()
    new DeviceCaptureStreamer('00008140-0000000000000001', 30, 'h264', 1280, 'Test Phone', deps).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.launch).toHaveBeenCalledWith('/apps/device-capture-helper.app',
      ['54321', '00008140-0000000000000001', '30', 'h264', '--max-size', '1280', '--name', 'Test Phone'])
  })

  // Mutations: parse from the first byte instead of skipping the status byte (every length is then off by
  // one byte); drop the keyframe flag; lose a frame split across two chunks.
  it('forwards frames after the status byte, including one split across chunks', async () => {
    const { deps, connect } = harness()
    const reader = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, deps).start().getReader()
    await vi.advanceTimersByTimeAsync(0)
    const sock = connect()
    const second = h264Frame(0x00, [9, 8, 7, 6])
    sock.emit('data', Buffer.concat([Buffer.from([0x00]), h264Frame(0x01, [0, 0, 0, 1, 0x67]), second.subarray(0, 3)]))
    sock.emit('data', second.subarray(3))

    const a = await reader.read()
    const b = await reader.read()
    expect(a.value).toEqual({ payload: Buffer.from([0, 0, 0, 1, 0x67]), keyframe: true })
    expect(b.value).toEqual({ payload: Buffer.from([9, 8, 7, 6]), keyframe: false })
  })

  // Mutations: write anything but the single byte 0x01 (the helper reads it as the IDR command); write it
  // for JPEG, which has no keyframes.
  it('requests a keyframe by writing 0x01 to the helper, for H.264 only', async () => {
    const h = harness()
    const s = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, h.deps)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    const sock = h.connect()
    s.requestKeyframe()
    expect(sock.write.mock.calls).toEqual([[Buffer.from([0x01])]])

    const j = harness()
    const sj = new DeviceCaptureStreamer('udid', 30, 'jpeg', 0, null, j.deps)
    sj.start()
    await vi.advanceTimersByTimeAsync(0)
    const sockJ = j.connect()
    sj.requestKeyframe()
    expect(sockJ.write).not.toHaveBeenCalled()
  })

  // Mutation: no connect timeout — a helper that never launched (bundle moved, LaunchServices refused)
  // would leave the session waiting forever with no message.
  it('errors when the helper never connects', async () => {
    const { deps, server } = harness()
    const reader = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, deps).start().getReader()
    const read = reader.read()
    const rejected = expect(read).rejects.toThrow(/did not connect/)
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(server.close).toHaveBeenCalled()
  })

  // Mutations: ignore the status byte (the denial would surface as a silent empty stream); map it to a
  // message that does not say where to grant Camera access.
  it('reports a Camera denial with where to grant it', async () => {
    const { deps, connect } = harness()
    const reader = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, deps).start().getReader()
    await vi.advanceTimersByTimeAsync(0)
    const sock = connect()
    sock.emit('data', Buffer.from([DEVICE_CAPTURE_EXIT.permission]))
    await expect(reader.read()).rejects.toThrow(/Privacy & Security › Camera/)
    expect(sock.destroy).toHaveBeenCalled()
  })

  // Mutation: treat a close before the status byte as a normal end — a helper that crashed on startup
  // would look like a stream that simply had no frames.
  it('errors when the helper closes before reporting a status', async () => {
    const { deps, connect } = harness()
    const reader = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, deps).start().getReader()
    await vi.advanceTimersByTimeAsync(0)
    connect().emit('close')
    await expect(reader.read()).rejects.toThrow(/exited before capture started/)
  })

  // Mutation: drop the launch error — `open` failing would be indistinguishable from a slow helper.
  it('errors when the launch itself fails', async () => {
    const { deps } = harness(Promise.reject(new Error('LSOpenURLsWithRole() failed')))
    const reader = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, deps).start().getReader()
    await expect(reader.read()).rejects.toThrow(/LSOpenURLsWithRole/)
  })

  // Mutations: cancel without destroying the socket (the helper exits only when it closes, so it would keep
  // capturing the phone); leave the server listening.
  it('closes the socket and the server on cancel', async () => {
    const { deps, server, connect } = harness()
    const stream = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, deps).start()
    await vi.advanceTimersByTimeAsync(0)
    const sock = connect()
    sock.emit('data', Buffer.from([0x00]))
    await stream.cancel()
    expect(sock.destroy).toHaveBeenCalled()
    expect(server.close).toHaveBeenCalled()
  })

  // Mutation: stop() that releases the socket but leaves the stream open — the reader pumping it would
  // block forever.
  it('stop() ends the stream and releases the helper', async () => {
    const { deps, connect } = harness()
    const s = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, deps)
    const reader = s.start().getReader()
    await vi.advanceTimersByTimeAsync(0)
    const sock = connect()
    sock.emit('data', Buffer.from([0x00]))
    s.stop()
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(sock.destroy).toHaveBeenCalled()

    // Before the helper connects there is no socket whose close would end the stream on its own.
    const early = harness()
    const s2 = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, early.deps)
    const reader2 = s2.start().getReader()
    await vi.advanceTimersByTimeAsync(0)
    s2.stop()
    expect(await reader2.read()).toEqual({ done: true, value: undefined })
    expect(early.server.close).toHaveBeenCalled()
  })

  // Mutation: no status timeout — a phone that stays locked, or a Camera prompt nobody answers, would hang
  // the session silently after the helper connected.
  it('errors when the helper connects but capture never starts', async () => {
    const { deps, connect } = harness()
    const reader = new DeviceCaptureStreamer('udid', 30, 'h264', 0, null, deps).start().getReader()
    await vi.advanceTimersByTimeAsync(0)
    connect()
    const rejected = expect(reader.read()).rejects.toThrow(/capture did not start/)
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
  })
})
