import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAudioPlayback } from '@/hooks/useAudioPlayback'

// What the hook asks of the browser, recorded: the context's options and each scheduled chunk.
class FakeContext {
  static made: FakeContext[] = []
  readonly sampleRate: number
  state = 'running'
  currentTime = 0
  destination = {}
  starts: { at: number; rate: number; frames: number }[] = []
  constructor(readonly options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48_000
    FakeContext.made.push(this)
  }
  createBuffer(channels: number, frames: number, rate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames))
    return { duration: frames / rate, sampleRate: rate, length: frames, getChannelData: (c: number) => data[c] }
  }
  createBufferSource() {
    const src = {
      buffer: null as null | { sampleRate: number; length: number },
      connect: vi.fn(),
      start: (at: number) => this.starts.push({ at, rate: src.buffer!.sampleRate, frames: src.buffer!.length }),
    }
    return src
  }
  resume() { return Promise.resolve() }
  close() { return Promise.resolve() }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeContext.made = []
})

describe('useAudioPlayback', () => {
  it('runs the context at the PCM rate, so chunks are not each resampled onto the device rate', () => {
    // At the device's 48 kHz a 470-frame chunk lasts 511.6 output frames and the boundaries tick (7.3 a second,
    // recorded from the output on a 1 kHz tone); at 44.1 kHz they land on the sample grid.
    vi.stubGlobal('AudioContext', FakeContext)
    const { result } = renderHook(() => useAudioPlayback())
    result.current.pushFrame(new ArrayBuffer(470 * 4))
    result.current.pushFrame(new ArrayBuffer(471 * 4))

    expect(FakeContext.made).toHaveLength(1)
    const ctx = FakeContext.made[0]
    expect(ctx.options?.sampleRate).toBe(44_100)
    expect(ctx.starts.map((s) => s.rate)).toEqual([44_100, 44_100])
    // Back to back: the second chunk starts where the first one ends, a whole number of the context's frames on.
    const [a, b] = ctx.starts
    expect((b.at - a.at) * ctx.sampleRate).toBeCloseTo(a.frames, 6)
  })
})
