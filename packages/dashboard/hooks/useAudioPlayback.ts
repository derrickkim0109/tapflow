import { useCallback, useEffect, useRef } from 'react'
import { pcmS16ToFloat32Planar } from '@/lib/audio/pcm'

// Fixed format: both agents send S16LE / 44100 / Stereo (the Android emulator's gRPC audio is natively
// that; the iOS helper resamples to it).
const SAMPLE_RATE = 44100
const CHANNELS = 2
// Small jitter buffer: schedule each chunk this far ahead so network jitter doesn't underrun.
const JITTER_LEAD = 0.06 // 60ms
// If the playhead falls behind or drifts too far ahead, resync (a brief glitch beats growing latency).
const RESYNC_GAP = 0.3 // 300ms

type AnyAudioContext = typeof AudioContext

export interface AudioPlayback {
  // Feed one raw-PCM payload (envelope already stripped). Stable identity — safe in deps.
  pushFrame: (pcm: ArrayBuffer) => void
}

// Always-on playback: we play whatever the emulator outputs and never mute on our side —
// muting is the emulator's job (its own volume keys). The audio is audible, so there's no
// on-screen indicator.
export function useAudioPlayback(): AudioPlayback {
  const ctxRef = useRef<AudioContext | null>(null)
  const nextStartRef = useRef(0)

  const ensureCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current
    const Ctor: AnyAudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AnyAudioContext }).webkitAudioContext
    if (!Ctor) return null
    // At the PCM's own rate, not the device's. Each chunk is its own buffer source, and at 48 kHz a 470-frame
    // chunk lasts 511.6 output frames: the starts drift off the sample grid and every few chunks a boundary
    // overlaps or gaps by a frame. Recorded from the output on a 1 kHz tone: 7.3 ticks a second at the
    // device's 48 kHz, none at 44.1 kHz. The browser then resamples the whole mix once, continuously.
    ctxRef.current = new Ctor({ sampleRate: SAMPLE_RATE })
    return ctxRef.current
  }, [])

  const pushFrame = useCallback((pcm: ArrayBuffer) => {
    const ctx = ensureCtx()
    if (!ctx) return
    // The user reached this view via a click (Start QA), so resume() is allowed if autoplay-suspended.
    if (ctx.state === 'suspended') void ctx.resume()

    const planar = pcmS16ToFloat32Planar(pcm, CHANNELS)
    const frameCount = planar[0]?.length ?? 0
    if (frameCount === 0) return

    const buffer = ctx.createBuffer(CHANNELS, frameCount, SAMPLE_RATE)
    for (let c = 0; c < CHANNELS; c++) buffer.getChannelData(c).set(planar[c])

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)

    const now = ctx.currentTime
    let start = nextStartRef.current
    // Resync if we've fallen behind (would start in the past) or drifted too far ahead.
    if (start < now + 0.005 || start > now + RESYNC_GAP + JITTER_LEAD) start = now + JITTER_LEAD
    src.start(start)
    nextStartRef.current = start + buffer.duration
  }, [ensureCtx])

  useEffect(() => {
    return () => {
      void ctxRef.current?.close()
      ctxRef.current = null
    }
  }, [])

  return { pushFrame }
}
