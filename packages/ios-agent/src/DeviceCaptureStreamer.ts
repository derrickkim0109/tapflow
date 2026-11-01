import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile, rm, rename, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger, PlatformError } from '@tapflowio/agent-core'
import { parseStreamFrames } from './ScreenCaptureStreamer.js'
import type { PanelSize, StreamFrame } from './ScreenCaptureStreamer.js'

const logger = createLogger('ios-agent:device-capture')
const execFileAsync = promisify(execFile)

/** Where the helper is built from and into, and how its tools run. Injectable so a test builds nothing. */
export interface HelperBuild {
  src: string
  cacheDir: string
  /** Runs a tool; rejects with its stderr on failure. */
  exec(cmd: string, args: string[], timeoutMs: number): Promise<unknown>
}

const defaultBuild: HelperBuild = {
  src: join(import.meta.dirname, '..', 'src', 'device-capture-helper.swift'),
  // Built into the user's cache, not beside the package: a global install is often not writable by the user running
  // the agent, and the bundle is this Mac's build (ad-hoc signed here), not something the package carries.
  cacheDir: join(homedir(), 'Library', 'Caches', 'tapflow'),
  exec: (cmd, args, timeout) => execFileAsync(cmd, args, { timeout }),
}

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
  /** More than one attached iPhone has the name this one was asked for, and there is no telling which. */
  ambiguous: 71,
  permission: 77,
} as const

// The helper opens with this launch's nonce (hex) before anything else. The port is loopback, but any local process can
// connect to it, and the first connection used to be taken for the helper: frames from anyone would have gone to the
// tester. A connection that does not open with the nonce is closed and the wait goes on. The nonce does not travel in
// the helper's argv, which every local user can read (`ps`) in time to connect first: it is written to a 0600 file in
// this user's cache (`writeNonceFile`), whose path is passed instead, and the helper deletes the file once read.
const NONCE_BYTES = 16
const NONCE_LEN = NONCE_BYTES * 2
// After a failure status the helper writes why, then exits; this bounds what is kept of it and how long it is waited for.
const DIAGNOSTIC_MAX = 2048
const DIAGNOSTIC_WAIT_MS = 2_000
// A frame header announcing more than this is not the helper's (a 4K JPEG is a few MB).
const MAX_FRAME_BYTES = 64 * 1024 * 1024

const CAMERA_HINT = 'allow Camera access for device-capture-helper in System Settings › Privacy & Security › Camera'
// The helper connects before it does anything slow, so a missing connection means the launch itself failed.
const CONNECT_TIMEOUT_MS = 15_000
// Covers the helper's own 10 s device wait, plus a first-run Camera prompt someone is answering.
const STATUS_TIMEOUT_MS = 60_000

const building = new Map<string, Promise<string>>()

/** A capture failure a restart would only repeat, so the stream is not restarted: only a person can fix it. */
export class PermanentCaptureError extends PlatformError {}

/** Camera access was refused. Only granting it in System Settings helps. */
export class CameraAccessDeniedError extends PermanentCaptureError {}

// The swiftc and codesign arguments, but for the paths: part of the build stamp, so a change to how the helper is
// built rebuilds it as a change to its source does.
const SWIFTC_FLAGS = ['-O', '-suppress-warnings',
  '-framework', 'AVFoundation', '-framework', 'CoreMediaIO', '-framework', 'CoreMedia',
  '-framework', 'CoreVideo', '-framework', 'VideoToolbox', '-framework', 'ImageIO']
const CODESIGN_FLAGS = ['--force', '--sign', '-']

/** Writes `nonce` to a new file only this user can read, in `dir`, and returns its path. */
export async function writeNonceFile(
  nonce: string, dir: string = defaultBuild.cacheDir, name = `device-capture-nonce-${randomBytes(8).toString('hex')}`,
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, name)
  // `wx`: never through a file (or link) someone put there first.
  await writeFile(path, nonce, { mode: 0o600, flag: 'wx' })
  return path
}

/** `text` with this user's home directory written as `~`, for a message that leaves the Mac. */
export function tildePath(text: string, home: string = homedir()): string {
  return home ? text.split(home).join('~') : text
}

/**
 * Build (hash-gated) the device-capture helper as an ad-hoc-signed `.app` in the user's cache and return its path.
 *
 * A `.app` launched through LaunchServices for the same reason as audiotap-helper: capture needs the Camera
 * TCC grant, which a CLI child of the agent can never obtain — requestAccess answers false without
 * prompting. Unchanged source skips the rebuild, so the grant (keyed on the signature) survives restarts.
 *
 * Async: the first build is a few seconds of swiftc (3.6 s measured), and run on the event loop it froze every
 * simulator's stream and input for that long. Concurrent callers share one build.
 */
export function ensureDeviceCaptureApp(build: HelperBuild = defaultBuild): Promise<string> {
  let pending = building.get(build.cacheDir)
  if (!pending) {
    pending = buildDeviceCaptureApp(build).finally(() => building.delete(build.cacheDir))
    building.set(build.cacheDir, pending)
  }
  return pending
}

async function buildDeviceCaptureApp({ src, cacheDir, exec }: HelperBuild): Promise<string> {
  const app = join(cacheDir, 'device-capture-helper.app')
  const bin = join(app, 'Contents', 'MacOS', 'device-capture-helper')
  // What the bundle was built from. A hash, not an mtime: npm stamps every file it unpacks with one fixed date, so
  // after an upgrade the source would never look newer than the bundle built from the old one.
  const stampFile = join(cacheDir, 'device-capture-helper.stamp')
  if (!existsSync(src)) {
    if (existsSync(bin)) return app
    throw new PermanentCaptureError('device-capture-helper.app missing and source not found — reinstall @tapflowio/ios-agent')
  }
  const stamp = createHash('sha256').update(readFileSync(src)).update(INFO_PLIST)
    .update(JSON.stringify([SWIFTC_FLAGS, CODESIGN_FLAGS])).digest('hex')
  if (existsSync(bin) && (await readFile(stampFile, 'utf8').catch(() => '')).trim() === stamp) return app
  logger.info('building device-capture-helper.app...')
  // Built aside and moved into place, with the stamp written last: a half-built or unsigned bundle at the real path
  // would pass the gate next time and then silently fail TCC.
  // Unique per build: two agents on this Mac (or two installs) may build at once, and must not share one.
  const staging = `${app}.building-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(join(staging, 'Contents', 'MacOS'), { recursive: true })
    // -suppress-warnings (in SWIFTC_FLAGS): Swift 6 concurrency warnings on the top-level script globals would
    // otherwise print into the agent log on every rebuild.
    await exec('swiftc', [src, ...SWIFTC_FLAGS, '-o', join(staging, 'Contents', 'MacOS', 'device-capture-helper')], 300_000)
    await writeFile(join(staging, 'Contents', 'Info.plist'), INFO_PLIST)
    await exec('codesign', [...CODESIGN_FLAGS, staging], 60_000)
    await rm(app, { recursive: true, force: true })
    try {
      await rename(staging, app)
    } catch (e) {
      // Another process put its build in place between the remove and the rename. Built from the same source on the
      // same Mac, it is as good as this one; keep it.
      const code = (e as { code?: string }).code
      if ((code !== 'ENOTEMPTY' && code !== 'EEXIST') || !existsSync(bin)) throw e
      await rm(staging, { recursive: true, force: true })
      logger.info('another process installed device-capture-helper.app first; using it')
    }
    await writeFile(stampFile, stamp)
  } catch (e) {
    await rm(staging, { recursive: true, force: true })
    const stderr = typeof (e as { stderr?: unknown }).stderr === 'string' ? (e as { stderr: string }).stderr.trim() : ''
    // Reaches the dashboard, so the home directory (a user name) is written as `~`. Permanent: a restart would run
    // swiftc again every few seconds and fail the same way, so the stream stops until the phone is opened again.
    throw new PermanentCaptureError(`could not build device-capture-helper.app in ${tildePath(cacheDir)}: ${tildePath(stderr.split('\n').slice(-3).join(' ') || (e as Error).message)}`)
  }
  logger.info(`built ${app}`)
  return app
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
  ensureApp(): Promise<string>
  /** Opens a loopback server; every accepted connection goes to `onConnection`. */
  listen(onConnection: (sock: HelperSocket) => void): Promise<HelperServer>
  /** Launches the app with these arguments. Rejects only when the launch itself fails. */
  launch(appPath: string, args: string[]): Promise<void>
  /** Puts this launch's nonce where only the helper (this user) can read it, and returns the path to pass it. */
  writeNonce(nonce: string): Promise<string>
}

const defaultDeps: DeviceCaptureDeps = {
  ensureApp: () => ensureDeviceCaptureApp(),
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
  writeNonce: (nonce) => writeNonceFile(nonce),
}

/** The error for a helper's failure status, with what it wrote about it (`detail`, empty when it said nothing). */
function statusError(code: number, udid: string, detail: string): PlatformError {
  const said = detail ? ` (${detail})` : ''
  switch (code) {
    case DEVICE_CAPTURE_EXIT.permission:
      return new CameraAccessDeniedError(`[DeviceCaptureStreamer] camera access denied — ${CAMERA_HINT}`)
    case DEVICE_CAPTURE_EXIT.noDevice:
      return new PlatformError(`[DeviceCaptureStreamer] ${udid}: no screen capture device — connect the iPhone by USB, trust this Mac and unlock it${said}`)
    case DEVICE_CAPTURE_EXIT.ambiguous:
      return new PermanentCaptureError(`[DeviceCaptureStreamer] ${udid}: ${detail || 'another iPhone attached has the same name'} — give each iPhone its own name in Settings › General › About › Name`)
    default:
      return new PlatformError(`[DeviceCaptureStreamer] ${udid}: device-capture-helper failed with code ${code}${said}`)
  }
}

/**
 * Streams a USB-connected physical iPhone's screen, with the same shape as ScreenCaptureStreamer.
 *
 * The helper is a `.app` started through `open`, so it is not our child: there is no stdin/stdout and no
 * exit status. It connects back to a loopback port instead, sends this launch's nonce, one status byte (0 =
 * capturing, else its exit code) and then either the screencapture-helper framing or, after a failure, why it
 * failed as text before it exits; a 0x01 byte written back forces an IDR. Closing the socket makes it exit.
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
    // matches on this name, and refuses when two attached iPhones have it (see the helper's header).
    private readonly deviceName: string | null = null,
    private readonly deps: DeviceCaptureDeps = defaultDeps,
    // The agent lists this phone and no other, so the only iOS capture device is it even if its name does not match.
    private readonly sole: boolean = false,
  ) {}

  /** A physical device has a single panel. */
  selectPanel(_panel: PanelSize): void {}

  /** Forces an IDR on the next H.264 frame. No-op for JPEG or before the helper connects. */
  requestKeyframe(): void {
    if (this.codec !== 'h264') return
    this.sock?.write(Buffer.from([0x01]))
  }

  start(): ReadableStream<StreamFrame> {
    const h264 = this.codec === 'h264'
    const nonce = randomBytes(NONCE_BYTES).toString('hex')
    const args = (nonceFile: string) => [this.udid, String(this.fps), this.codec, '--max-size', String(this.maxSize),
      '--nonce-file', nonceFile, ...(this.deviceName ? ['--name', this.deviceName] : []), ...(this.sole ? ['--sole'] : [])]
    // The helper deletes it once read; this is for a helper that never ran.
    let nonceFile: string | null = null

    let done = false
    let server: HelperServer | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    // Connections that have not yet sent the nonce: closed with the server, or one could hold the port's queue open.
    const unproven = new Set<HelperSocket>()
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
    const release = () => {
      clearTimer()
      this.sock?.destroy()
      this.sock = null
      for (const sock of unproven) sock.destroy()
      unproven.clear()
      server?.close()
      server = null
      if (nonceFile) void unlink(nonceFile).catch(() => { /* the helper already deleted it */ })
      nonceFile = null
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

        // The helper's, once it has proven it is: everything after the nonce.
        const attach = (sock: HelperSocket, first: Buffer) => {
          this.sock = sock
          clearTimer()
          timer = setTimeout(() => fail(new PlatformError(
            `[DeviceCaptureStreamer] ${this.udid}: capture did not start within ${STATUS_TIMEOUT_MS / 1000} s — unlock the iPhone, or ${CAMERA_HINT}`)),
          STATUS_TIMEOUT_MS)

          let status: number | null = null
          let buf: Buffer = Buffer.alloc(0)
          let diagnostic: Buffer = Buffer.alloc(0)
          const failWithStatus = () => fail(statusError(status!, this.udid, diagnostic.toString('utf8').trim().slice(0, DIAGNOSTIC_MAX)))
          const onData = (chunk: Buffer) => {
            if (done || chunk.length === 0) return
            if (status === null) {
              status = chunk[0]!
              chunk = chunk.subarray(1)
              if (status !== DEVICE_CAPTURE_EXIT.ok) {
                // Why it failed follows, then the helper exits; wait for the close, but not forever.
                clearTimer()
                timer = setTimeout(failWithStatus, DIAGNOSTIC_WAIT_MS)
              } else {
                clearTimer()
              }
            }
            if (status !== DEVICE_CAPTURE_EXIT.ok) {
              if (diagnostic.length < DIAGNOSTIC_MAX) diagnostic = Buffer.concat([diagnostic, chunk]).subarray(0, DIAGNOSTIC_MAX)
              return
            }
            buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
            // Every header in reach, not just the first: an H.264 length of 0 has no flags byte, and parsing it would
            // take the next frame's first byte for one and lose the framing for good.
            for (let off = 0; off + 4 <= buf.length; off += 4 + buf.readUInt32BE(off)) {
              const len = buf.readUInt32BE(off)
              if (len > MAX_FRAME_BYTES || (h264 && len < 1)) {
                fail(new PlatformError(`[DeviceCaptureStreamer] ${this.udid}: the helper announced a ${len}-byte frame — not a stream this agent reads`))
                return
              }
            }
            const { frames, rest } = parseStreamFrames(buf, h264)
            // An empty frame carries no picture: forwarded, it would count as the frame that shows the stream works.
            for (const f of frames) if (f.payload.length > 0) controller.enqueue(f)
            buf = rest
          }
          sock.on('data', onData)
          sock.on('close', () => {
            if (status === DEVICE_CAPTURE_EXIT.ok) end()
            else if (status !== null) failWithStatus()
            else fail(new PlatformError(`[DeviceCaptureStreamer] ${this.udid}: device-capture-helper exited before capture started`))
          })
          onData(first)
        }

        const onConnection = (sock: HelperSocket) => {
          if (done || this.sock) { sock.destroy(); return }
          unproven.add(sock)
          let head: Buffer = Buffer.alloc(0)
          sock.on('error', () => { /* 'close' follows and decides */ })
          sock.on('data', (chunk) => {
            if (!unproven.has(sock)) return
            head = Buffer.concat([head, chunk])
            if (head.length < NONCE_LEN) return
            unproven.delete(sock)
            const proven = timingSafeEqual(head.subarray(0, NONCE_LEN), Buffer.from(nonce, 'latin1'))
            if (!proven || done || this.sock) {
              if (!proven) logger.warn(`${this.udid}: a connection to the capture port did not open with this launch's nonce — closed`)
              sock.destroy()
              return
            }
            attach(sock, head.subarray(NONCE_LEN))
          })
          sock.on('close', () => { unproven.delete(sock) })
        }

        this.deps.ensureApp().then((appPath) => {
          if (done) return
          return this.deps.listen(onConnection).then(async (s) => {
            if (done) { s.close(); return }
            server = s
            const file = await this.deps.writeNonce(nonce)
            if (done) { void unlink(file).catch(() => {}); return }
            nonceFile = file
            timer = setTimeout(() => fail(new PlatformError(
              `[DeviceCaptureStreamer] ${this.udid}: device-capture-helper did not connect within ${CONNECT_TIMEOUT_MS / 1000} s`)),
            CONNECT_TIMEOUT_MS)
            return this.deps.launch(appPath, [String(s.port), ...args(file)])
          })
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
