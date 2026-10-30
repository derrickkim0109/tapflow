import net from 'node:net'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger, PlatformError } from '@tapflowio/agent-core'
import { parseStreamFrames } from './ScreenCaptureStreamer.js'
import type { PanelSize, StreamFrame } from './ScreenCaptureStreamer.js'

const logger = createLogger('ios-agent:device-capture')

const HELPER_SRC = join(import.meta.dirname, '..', 'src', 'device-capture-helper.swift')
const HELPER_APP = join(import.meta.dirname, '..', 'bin', 'device-capture-helper.app')
const HELPER_BIN = join(HELPER_APP, 'Contents', 'MacOS', 'device-capture-helper')

// No entitlements file: the bundle is ad-hoc signed without the hardened runtime and is not sandboxed, and
// `com.apple.security.device.camera` is only consulted under one of those two.
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>device-capture-helper</string>
  <key>CFBundleIdentifier</key><string>io.tapflow.device-capture-helper</string>
  <key>CFBundleName</key><string>device-capture-helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSCameraUsageDescription</key><string>tapflow mirrors the screen of the iPhone connected to this Mac by USB to the browser.</string>
</dict></plist>
`

/** Helper exit codes, also sent as the status byte that opens the socket. 0 = capture running. */
export const DEVICE_CAPTURE_EXIT = {
  ok: 0,
  usage: 64,
  connect: 65,
  noDevice: 69,
  session: 70,
  permission: 77,
} as const

const CAMERA_HINT = 'allow Camera access for device-capture-helper in System Settings › Privacy & Security › Camera'
// The helper connects before it does anything slow, so a missing connection means the launch itself failed.
const CONNECT_TIMEOUT_MS = 15_000
// Covers the helper's own 10 s device wait, plus a first-run Camera prompt someone is answering.
const STATUS_TIMEOUT_MS = 60_000

/**
 * Build (mtime-gated) the device-capture helper as an ad-hoc-signed `.app` and return its path.
 *
 * A `.app` launched through LaunchServices for the same reason as audiotap-helper: capture needs the Camera
 * TCC grant, which a CLI child of the agent can never obtain — requestAccess answers false without
 * prompting. Unchanged source skips the rebuild, so the grant (keyed on the signature) survives restarts.
 */
export function ensureDeviceCaptureApp(): string {
  if (existsSync(HELPER_BIN)) {
    if (!existsSync(HELPER_SRC)) return HELPER_APP
    if (statSync(HELPER_BIN).mtimeMs >= statSync(HELPER_SRC).mtimeMs) return HELPER_APP
    logger.info('device-capture-helper source changed, rebuilding...')
  }
  if (!existsSync(HELPER_SRC)) {
    throw new PlatformError('device-capture-helper.app missing and source not found — reinstall @tapflowio/ios-agent')
  }
  logger.info('building device-capture-helper.app...')
  // A half-built or unsigned bundle would pass the mtime gate next time and then silently fail TCC.
  try {
    mkdirSync(join(HELPER_APP, 'Contents', 'MacOS'), { recursive: true })
    execFileSync('swiftc', [
      // -suppress-warnings: Swift 6 concurrency warnings on the top-level script globals would otherwise
      // print into the agent log on every rebuild.
      HELPER_SRC, '-O', '-suppress-warnings', '-o', HELPER_BIN,
      '-framework', 'AVFoundation', '-framework', 'CoreMediaIO', '-framework', 'CoreMedia',
      '-framework', 'CoreVideo', '-framework', 'VideoToolbox', '-framework', 'ImageIO',
    ], { stdio: ['ignore', 'ignore', 'inherit'] })
    writeFileSync(join(HELPER_APP, 'Contents', 'Info.plist'), INFO_PLIST)
    execFileSync('codesign', ['--force', '--sign', '-', HELPER_APP], { stdio: ['ignore', 'ignore', 'inherit'] })
  } catch (e) {
    rmSync(HELPER_APP, { recursive: true, force: true })
    throw e
  }
  logger.info('built device-capture-helper.app')
  return HELPER_APP
}

/**
 * Prime the Camera grant up front so the operator answers the prompt while present. `wait` blocks until
 * the helper exits (prompt answered); otherwise it is fire-and-forget and never throws.
 */
export function requestDeviceCapturePermission(wait = true): void {
  try {
    const app = ensureDeviceCaptureApp()
    const flags = wait ? ['-W', '-n'] : ['-g', '-n']
    execFileSync('open', [...flags, '-a', app, '--args', '--request-permission'], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch (e) {
    if (wait) throw e
    logger.warn(`camera permission priming skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** The socket surface the streamer uses; `net.Socket` satisfies it. */
export interface HelperSocket {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  write(data: Buffer): unknown
  destroy(): unknown
}

export interface HelperServer {
  port: number
  close(): void
}

export interface DeviceCaptureDeps {
  ensureApp(): string
  /** Opens a loopback server; every accepted connection goes to `onConnection`. */
  listen(onConnection: (sock: HelperSocket) => void): Promise<HelperServer>
  /** Launches the app with these arguments. Rejects only when the launch itself fails. */
  launch(appPath: string, args: string[]): Promise<void>
}

const defaultDeps: DeviceCaptureDeps = {
  ensureApp: ensureDeviceCaptureApp,
  listen: (onConnection) => new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.setNoDelay(true)
      onConnection(sock)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close() })
    })
  }),
  // -g: no focus steal. -n: a new instance per device, or a second iPhone would reuse the first's helper.
  launch: (appPath, args) => new Promise((resolve, reject) => {
    execFile('open', ['-g', '-n', '-a', appPath, '--args', ...args], (err) => err ? reject(err) : resolve())
  }),
}

function statusError(code: number, udid: string): PlatformError {
  switch (code) {
    case DEVICE_CAPTURE_EXIT.permission:
      return new PlatformError(`[DeviceCaptureStreamer] camera access denied — ${CAMERA_HINT}`)
    case DEVICE_CAPTURE_EXIT.noDevice:
      return new PlatformError(`[DeviceCaptureStreamer] ${udid}: no screen capture device — connect the iPhone by USB, trust this Mac and unlock it`)
    default:
      return new PlatformError(`[DeviceCaptureStreamer] ${udid}: device-capture-helper failed with code ${code}`)
  }
}

/**
 * Streams a USB-connected physical iPhone's screen, with the same shape as ScreenCaptureStreamer.
 *
 * The helper is a `.app` started through `open`, so it is not our child: there is no stdin/stdout and no
 * exit status. It connects back to a loopback port instead, sends one status byte (0 = capturing, else its
 * exit code), then the screencapture-helper framing; a 0x01 byte written back forces an IDR. Closing the
 * socket makes it exit.
 */
export class DeviceCaptureStreamer {
  private sock: HelperSocket | null = null
  private teardown: (() => void) | null = null

  constructor(
    private readonly udid: string,
    private readonly fps: number = 30,
    private readonly codec: 'jpeg' | 'h264' = 'h264',
    private readonly maxSize: number = 0,
    // The device name devicectl reports. The capture device's uniqueID is not the UDID, so the helper
    // matches on this name when there is more than one iPhone attached.
    private readonly deviceName: string | null = null,
    private readonly deps: DeviceCaptureDeps = defaultDeps,
  ) {}

  /** A physical device has a single panel. */
  selectPanel(_panel: PanelSize): void {}

  /** Forces an IDR on the next H.264 frame. No-op for JPEG or before the helper connects. */
  requestKeyframe(): void {
    if (this.codec !== 'h264') return
    this.sock?.write(Buffer.from([0x01]))
  }

  start(): ReadableStream<StreamFrame> {
    const appPath = this.deps.ensureApp()
    const h264 = this.codec === 'h264'
    const args = [this.udid, String(this.fps), this.codec, '--max-size', String(this.maxSize),
      ...(this.deviceName ? ['--name', this.deviceName] : [])]

    let done = false
    let server: HelperServer | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
    const release = () => {
      clearTimer()
      this.sock?.destroy()
      this.sock = null
      server?.close()
      server = null
    }

    return new ReadableStream<StreamFrame>({
      start: (controller) => {
        const fail = (e: Error) => {
          if (done) return
          done = true
          release()
          controller.error(e)
        }
        const end = () => {
          if (done) return
          done = true
          release()
          controller.close()
        }
        this.teardown = end

        const onConnection = (sock: HelperSocket) => {
          if (done || this.sock) { sock.destroy(); return }
          this.sock = sock
          clearTimer()
          timer = setTimeout(() => fail(new PlatformError(
            `[DeviceCaptureStreamer] ${this.udid}: capture did not start within ${STATUS_TIMEOUT_MS / 1000} s — unlock the iPhone, or ${CAMERA_HINT}`)),
          STATUS_TIMEOUT_MS)

          let started = false
          let buf: Buffer = Buffer.alloc(0)
          sock.on('data', (chunk) => {
            if (done) return
            if (!started) {
              const status = chunk[0]
              if (status !== DEVICE_CAPTURE_EXIT.ok) { fail(statusError(status, this.udid)); return }
              started = true
              clearTimer()
              chunk = chunk.subarray(1)
            }
            buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
            const { frames, rest } = parseStreamFrames(buf, h264)
            for (const f of frames) controller.enqueue(f)
            buf = rest
          })
          sock.on('close', () => {
            if (started) end()
            else fail(new PlatformError(`[DeviceCaptureStreamer] ${this.udid}: device-capture-helper exited before capture started`))
          })
          sock.on('error', () => { /* 'close' follows and decides */ })
        }

        this.deps.listen(onConnection).then((s) => {
          if (done) { s.close(); return }
          server = s
          timer = setTimeout(() => fail(new PlatformError(
            `[DeviceCaptureStreamer] ${this.udid}: device-capture-helper did not connect within ${CONNECT_TIMEOUT_MS / 1000} s`)),
          CONNECT_TIMEOUT_MS)
          return this.deps.launch(appPath, [String(s.port), ...args])
        }).catch((e: unknown) => fail(e instanceof Error ? e : new PlatformError(String(e))))
      },
      cancel: () => { done = true; release() },
    })
  }

  /** Ends the frame stream and closes the socket, which makes the helper exit, and the server. */
  stop(): void {
    this.teardown?.()
    this.teardown = null
  }
}
