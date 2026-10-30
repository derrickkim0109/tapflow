import type { PanelSize, StreamFrame } from './ScreenCaptureStreamer.js'

/** A device's screen stream, whichever helper produces it. `ScreenCaptureStreamer` is the simulator's. */
export interface CaptureStreamer {
  start(): ReadableStream<StreamFrame>
  requestKeyframe(): void
  selectPanel(panel: PanelSize): void
}

/** Builds the stream for a USB-connected iPhone or iPad, known by its hardware UDID. */
export type PhysicalCaptureFactory = (udid: string, fps: number, codec: 'jpeg' | 'h264', maxSize: number) => CaptureStreamer
