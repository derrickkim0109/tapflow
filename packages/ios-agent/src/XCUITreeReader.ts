import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { createHash, randomUUID } from 'crypto'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import type { UIElement } from '@tapflowio/agent-core'
import { createLogger, PlatformError } from '@tapflowio/agent-core'
import { parseTreeText } from './xcuiTree.js'

const logger = createLogger('ios-agent:xcui-tree')
const execFileAsync = promisify(execFile)

const RUNNER_DIR = join(import.meta.dirname, '..', 'xctest-runner')
const PROJECT = join(RUNNER_DIR, 'TapflowTreeRunner.xcodeproj')
const BUILD_DIR = join(RUNNER_DIR, 'build')
// A device build signs with a team and links against iphoneos; sharing the simulator's products dir would make each
// platform's build overwrite the other's .xctestrun and stamp.
const DEVICE_BUILD_DIR = join(RUNNER_DIR, 'build-iphoneos')
const productsDir = (buildDir: string): string => join(buildDir, 'Build', 'Products')
const stampFile = (buildDir: string): string => join(buildDir, 'tapflow-runner.stamp')
const SCHEME = 'TreeRunner'
// The in-simulator process the UI-test session runs as. Killing xcodebuild already ends it (measured); this covers
// an xcodebuild that dies by SIGKILL without taking it along. `dev.tapflow.treerunner.host` was named here before,
// and is never installed: `test-without-building` installs only the runner.
const RUNNER_BUNDLE = 'dev.tapflow.treerunner.uitests.xctrunner'
const READY_DEADLINE_MS = 90_000
const READY_LINE = /TAPFLOW_TREE_READY port=(\d+)/
const TEAM_ENV = 'TAPFLOW_IOS_TEAM_ID'
const BUNDLE_PREFIX_ENV = 'TAPFLOW_IOS_BUNDLE_PREFIX'
// How long a failed device build is not tried again for the same phone, team and prefix. Every write to a phone whose
// runner is down asks for a start, and a device build runs xcodebuild with -allowProvisioningUpdates for up to 300 s.
export const DEVICE_REBUILD_BACKOFF_MS = 60_000

/** Where a runner runs. A simulator shares the Mac's loopback; a physical device is reached over its CoreDevice tunnel. */
export type RunnerPlatform = 'simulator' | 'physical'

/** The header every request to a runner carries, a simulator's /health and /tree included (see TreeServer.swift). */
export const TOKEN_HEADER = 'X-Tapflow-Token'

interface RunnerHandle {
  proc: ChildProcess
  udid: string
  token: string
  // The URL host the runner answers on: `localhost` for a simulator, the bracketed tunnel address for a device.
  host: string
  platform: RunnerPlatform
  // Set once the runner has announced its port and answered /health with `token`. Until then the handle only
  // marks the device as starting, so a stop can still find and kill the process.
  port?: number
  // The end of xcodebuild's output, which names why a runner that exits early did.
  tail: string
}

type ReadyRunner = RunnerHandle & { port: number }

// Native-tooling boundary (xcodebuild/xcrun). Injectable so tests can mock the
// native calls without exercising the runner lifecycle / signal handling.
export interface RunnerNative {
  // What the runner would be built from now: its sources, the checked-in project and the Xcode that builds them.
  sourceStamp(): Promise<string>
  // The stamp recorded beside the built products, or undefined when there is no usable build. `platform` is passed
  // only for a physical device, so the simulator calls stay what they always were.
  builtStamp(platform?: 'physical'): string | undefined
  // Builds, then records `stamp` — only on success, so a half build is never trusted. A device build signs with `team`.
  build(destination: string, stamp: string, device?: { team: string; bundlePrefix?: string }): Promise<void>
  // Starts the runner on a port of the kernel's choosing. Its stdout must stay readable: the port arrives there.
  spawn(destination: string, token: string, platform?: 'physical'): ChildProcess
  terminateRunner(udid: string): void
  // The device's CoreDevice tunnel address — where a runner bound beyond loopback is reached from the Mac.
  tunnelAddress(udid: string): Promise<string>
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The tunnel address in `devicectl device info details -j`: `result.connectionProperties.tunnelIPAddress`, an IPv6
 * ULA the Mac routes over a utun interface (measured on an iPhone 16 Pro Max, iOS 26, Xcode 26: lockdownd's 62078
 * accepts there and a closed port answers RST, so nothing filters it). Undefined while the tunnel is not up.
 */
export function parseTunnelAddress(doc: unknown): string | undefined {
  const result = isObj(doc) ? doc.result : undefined
  const conn = isObj(result) && isObj(result.connectionProperties) ? result.connectionProperties : undefined
  if (!conn || conn.tunnelState !== 'connected') return undefined
  return typeof conn.tunnelIPAddress === 'string' && conn.tunnelIPAddress ? conn.tunnelIPAddress : undefined
}

/** A URL host for an address: IPv6 literals go in brackets. */
export function urlHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

/** A device build's stamp: what it was built from, then the devices it was built for. */
export function formatDeviceStamp(base: string, devices: readonly string[]): string {
  return `${base}|${[...new Set(devices)].join(',')}`
}

/** The stamp `formatDeviceStamp` wrote, or undefined for none (or one from before the devices were recorded). */
export function parseDeviceStamp(stamp: string | undefined): { base: string; devices: string[] } | undefined {
  if (!stamp) return undefined
  const bar = stamp.lastIndexOf('|')
  if (bar < 0) return undefined
  return { base: stamp.slice(0, bar), devices: stamp.slice(bar + 1).split(',').filter(Boolean) }
}

/** The xcodebuild arguments that differ per platform: destination, products dir and, for a device, signing. */
export function xcodebuildArgs(
  action: 'build-for-testing' | 'test-without-building',
  destination: string,
  device?: { team?: string; bundlePrefix?: string },
): string[] {
  const base = ['-project', PROJECT, '-scheme', SCHEME, '-destination', destination, '-derivedDataPath', device ? DEVICE_BUILD_DIR : BUILD_DIR]
  if (!device) return action === 'build-for-testing' ? ['build-for-testing', ...base, '-quiet'] : ['test-without-building', ...base]
  const signing = [
    '-allowProvisioningUpdates',
    ...(device.team ? [`DEVELOPMENT_TEAM=${device.team}`, 'CODE_SIGN_STYLE=Automatic'] : []),
    // App IDs are unique across every Apple team: one that cannot register `dev.tapflow.treerunner.*` signs under its own.
    ...(device.bundlePrefix ? [`TAPFLOW_RUNNER_BUNDLE_PREFIX=${device.bundlePrefix}.treerunner`] : []),
  ]
  return action === 'build-for-testing' ? ['build-for-testing', ...base, ...signing, '-quiet'] : ['test-without-building', ...base, ...signing]
}

// Everything `build-for-testing` reads from this package: the runner and host sources, the checked-in project and
// its shared scheme (xcodegen does not run at build time, so `project.yml` alone changes nothing that is built). The toolchain is part
// of it, so an Xcode upgrade rebuilds too.
export function computeRunnerStamp(runnerDir: string, toolchain: string): string {
  const hash = createHash('sha256').update(toolchain)
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (e.isFile()) files.push(path)
    }
  }
  walk(join(runnerDir, 'TreeRunner'))
  walk(join(runnerDir, 'TreeHost'))
  files.push(join(runnerDir, 'TapflowTreeRunner.xcodeproj', 'project.pbxproj'))
  files.push(join(runnerDir, 'TapflowTreeRunner.xcodeproj', 'xcshareddata', 'xcschemes', 'TreeRunner.xcscheme'))
  for (const f of files.map((f) => relative(runnerDir, f)).sort()) {
    hash.update(`\0${f}\0`).update(readFileSync(join(runnerDir, f)))
  }
  return hash.digest('hex')
}

const defaultNative: RunnerNative = {
  async sourceStamp() {
    const { stdout } = await execFileAsync('xcodebuild', ['-version'], { timeout: 30_000 })
    return computeRunnerStamp(RUNNER_DIR, stdout)
  },
  builtStamp(platform) {
    const buildDir = platform === 'physical' ? DEVICE_BUILD_DIR : BUILD_DIR
    // test-without-building needs the .xctestrun, not just the .app — gate on it.
    try {
      if (!readdirSync(productsDir(buildDir)).some((f) => f.endsWith('.xctestrun'))) return undefined
      return readFileSync(stampFile(buildDir), 'utf8').trim()
    } catch {
      return undefined
    }
  },
  async build(destination, stamp, device) {
    await execFileAsync('xcodebuild', xcodebuildArgs('build-for-testing', destination, device), {
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    writeFileSync(stampFile(device ? DEVICE_BUILD_DIR : BUILD_DIR), stamp)
  },
  spawn(destination, token, platform) {
    // No `-quiet`: it also silences the test's own output, and the READY line is how the port arrives. The
    // `TEST_RUNNER_` prefix is what makes xcodebuild hand a variable to the runner (it strips the prefix); without
    // it nothing arrives.
    const device = platform === 'physical'
    return spawn(
      'xcodebuild',
      xcodebuildArgs('test-without-building', destination, device ? {} : undefined),
      {
        env: {
          ...process.env,
          TEST_RUNNER_TAPFLOW_TREE_PORT: '0',
          TEST_RUNNER_TAPFLOW_TREE_TOKEN: token,
          ...(device ? { TEST_RUNNER_TAPFLOW_TREE_BIND_ANY: '1' } : {}),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      },
    )
  },
  terminateRunner(udid) {
    execFile('xcrun', ['simctl', 'terminate', udid, RUNNER_BUNDLE], () => { /* best-effort */ })
  },
  async tunnelAddress(udid) {
    const { stdout } = await execFileAsync('xcrun', ['devicectl', 'device', 'info', 'details', '--device', udid, '-j', '-', '-q'], {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const address = parseTunnelAddress(JSON.parse(stdout))
    if (!address) throw new Error('its CoreDevice tunnel is not connected — plug it in over USB and unlock it')
    return address
  },
}

const TAIL_CHARS = 4096

/** Why a runner that exited before it was ready did, as far as xcodebuild's last lines say, with what to check. */
function exitedMessage(handle: RunnerHandle): string {
  const check = handle.platform === 'physical'
    ? 'check that the device is unlocked, trusts this Mac, and that the runner build is signed for it'
    : 'check Xcode/simulator state'
  const lines = handle.tail.split('\n').map((l) => l.trim()).filter(Boolean)
  const said = lines.filter((l) => /error|fail/i.test(l)).slice(-2).join(' ').slice(0, 300)
  return `tree runner exited before becoming ready — ${check}${said ? `: ${said}` : ''}`
}

function refused(e: unknown): boolean {
  return (e as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED'
}

function tokenHeader(token: string): Record<string, string> {
  return { [TOKEN_HEADER]: token }
}

async function answers(host: string, port: number, token: string): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}/health`, { headers: tokenHeader(token), signal: AbortSignal.timeout(1000) })
    return r.ok && (await r.text()).trim() === token
  } catch {
    return false
  }
}

export interface XCUITreeReaderOptions {
  /** Which devices are physical. Default: none — every device is a simulator. */
  platformOf?: (udid: string) => RunnerPlatform
  /** The Apple development team a device build signs with. Default: `TAPFLOW_IOS_TEAM_ID`. */
  team?: () => string | undefined
  /** A reverse-DNS prefix for the device runner's bundle IDs, for a team that cannot register `dev.tapflow.*`.
   *  Default: `TAPFLOW_IOS_BUNDLE_PREFIX`; unset keeps `dev.tapflow`. */
  bundlePrefix?: () => string | undefined
}

/** What an input path needs from the runner of one device (see `XCUITestInput`). */
export interface RunnerInputClient {
  /** Starts the device's runner ahead of the first input. */
  warm(): void
  /** `ready` once a runner answers; `unavailable` after its last start failed, until a new one is tried. */
  state(): 'ready' | 'starting' | 'unavailable'
  /** Sends one input request; rejects with the runner's own error text when it answers `ok: false`. */
  request(path: string, body?: string): Promise<void>
  /** Why its last start failed, until a start succeeds (a retry under way included); null otherwise. Optional for a
   *  scripted runner. */
  lastError?(): string | null
}

// Drives the resident XCUITest runners, one per device: builds the runner once per platform (simulator, or iphoneos
// signed by a team), launches it per device (staying resident), and talks to it over HTTP — GET /tree for the UI
// tree, and on a USB-connected device /tap /drag /type /key for input too. A simulator's runner is on the loopback it
// shares with the Mac; a device's binds `::` and is reached over its CoreDevice tunnel, every route behind a
// per-launch token. Replaces the AXUIElement path (UITreeReader), which required a Simulator.app window.
export class XCUITreeReader {
  private readonly runners = new Map<string, RunnerHandle>()
  private readonly starting = new Map<string, Promise<ReadyRunner>>()
  private readonly building = new Map<RunnerPlatform, Promise<void>>()
  // Devices whose last runner start failed, with why — the reason a write is refused until a new start is tried.
  private readonly failed = new Map<string, string>()
  private stamp?: Promise<string>
  // The last failed device build, for `DEVICE_REBUILD_BACKOFF_MS`: what it was for (phone, team, prefix), when, and why.
  private deviceBuildFailure: { key: string; at: number; message: string } | null = null
  // A launch compares the generation it began with before it spawns, because `test-without-building` boots a
  // shut-down simulator and would power a device back up right after someone shut it down. A device's count is
  // never deleted: a count that restarted at 0 would match a launch that began before it was cleared. `epoch` is
  // stop()'s share, so stopping everything also cancels a device that is only building and holds no handle yet.
  private readonly generations = new Map<string, number>()
  private epoch = 0

  private readonly platformOf: (udid: string) => RunnerPlatform
  private readonly team: () => string | undefined
  private readonly bundlePrefix: () => string | undefined

  constructor(private readonly native: RunnerNative = defaultNative, options: XCUITreeReaderOptions = {}) {
    this.platformOf = options.platformOf ?? (() => 'simulator')
    this.team = options.team ?? (() => process.env[TEAM_ENV]?.trim() || undefined)
    this.bundlePrefix = options.bundlePrefix ?? (() => process.env[BUNDLE_PREFIX_ENV]?.trim() || undefined)
  }

  private destination(udid: string): string {
    if (this.platformOf(udid) === 'physical') return `platform=iOS,id=${udid}`
    // No arch — xcodebuild resolves it (arm64 on Apple Silicon, x86_64 on Intel).
    return `platform=iOS Simulator,id=${udid}`
  }

  private generation(udid: string): string {
    return `${this.epoch}/${this.generations.get(udid) ?? 0}`
  }

  private bumpGeneration(udid: string): void {
    this.generations.set(udid, (this.generations.get(udid) ?? 0) + 1)
  }

  private async ensureBuilt(udid: string): Promise<void> {
    const platform = this.platformOf(udid)
    // Checked before anything is built: without a team xcodebuild fails minutes later with a signing log.
    const team = platform === 'physical' ? this.team() : undefined
    if (platform === 'physical' && !team) {
      throw new PlatformError(
        `a physical iPhone needs the UI-test runner signed by your Apple development team — set ${TEAM_ENV} to its team ID (Membership details at developer.apple.com/account, or the OU= of \`security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject\`)`,
      )
    }
    // A device build that just failed is not run again for every write that finds the runner down: each would be
    // another xcodebuild with -allowProvisioningUpdates. The same failure is answered until the backoff is over, or
    // until what the build is for (phone, team, prefix) changes.
    const failureKey = platform === 'physical' ? `${udid}|${team}|${this.bundlePrefix() ?? ''}` : ''
    const recent = this.deviceBuildFailure
    if (recent && recent.key === failureKey && Date.now() - recent.at < DEVICE_REBUILD_BACKOFF_MS) {
      throw new PlatformError(`${recent.message} (not built again for ${DEVICE_REBUILD_BACKOFF_MS / 1000} s after a failed build)`)
    }
    // Once per process: a stamp that changed while runners serve (a source edited under a running agent) must not
    // rebuild the products they are executing.
    const stamping = (this.stamp ??= this.native.sourceStamp())
    // Every caller goes through the catch below, the ones that joined a build another device started included:
    // with a runner per device, two first reads at once are the normal case, and the raw xcodebuild error is
    // its whole log.
    let building = this.building.get(platform)
    // A device that joins another device's build is not in that build's profile; it checks again once it is done.
    const joined = building !== undefined
    if (!building) {
      building = (async () => {
        const sources = await stamping
        if (platform === 'physical') {
          // The team signs the products and the prefix names them, so a change to either is a different build. The
          // devices are part of it too: the build registers the device it targets and signs with a profile that names
          // the devices registered then, and `test-without-building` does not re-sign — so a phone the products were
          // never built for cannot install them.
          const bundlePrefix = this.bundlePrefix()
          const base = bundlePrefix ? `${sources}:${team}:${bundlePrefix}` : `${sources}:${team}`
          const built = parseDeviceStamp(this.native.builtStamp('physical'))
          if (built?.base === base && built.devices.includes(udid)) return
          const devices = built?.base === base ? [...built.devices, udid] : [udid]
          logger.info('building tree runner for a physical device (first run, a device it was not built for, or its sources, Xcode, team or bundle prefix changed)...')
          await this.native.build(this.destination(udid), formatDeviceStamp(base, devices), bundlePrefix ? { team: team!, bundlePrefix } : { team: team! })
        } else {
          if (this.native.builtStamp() === sources) return
          logger.info('building tree runner (first run, or its sources or Xcode changed — cached afterwards)...')
          await this.native.build(this.destination(udid), sources)
        }
        logger.info('tree runner built')
      })()
      this.building.set(platform, building)
    }
    try {
      await building
    } catch (e) {
      if (this.stamp === stamping) this.stamp = undefined
      const hint = platform === 'physical'
        ? `check that team ${team} can sign for the device and that it is unlocked and trusts this Mac`
        : 'ensure Xcode and an iOS simulator runtime are installed (xcode-select -p)'
      const message = `failed to build the UI-tree runner — ${hint}: ${(e as Error).message.slice(0, 300)}`
      if (platform === 'physical') this.deviceBuildFailure = { key: failureKey, at: Date.now(), message }
      throw new PlatformError(message)
    } finally {
      if (this.building.get(platform) === building) this.building.delete(platform)
    }
    if (joined && platform === 'physical') await this.ensureBuilt(udid)
  }

  private runnerAlive(h: RunnerHandle | undefined): h is RunnerHandle {
    // `signalCode` too: a runner killed from outside (by signal) keeps `exitCode` null and `killed` false, and
    // without it every read went on asking a dead port for as long as the agent ran.
    return !!h && h.proc.exitCode === null && h.proc.signalCode === null && !h.proc.killed
  }

  private ready(h: RunnerHandle | undefined): h is ReadyRunner {
    return this.runnerAlive(h) && h.port !== undefined
  }

  private async ensureRunner(udid: string): Promise<ReadyRunner> {
    // Serialize concurrent callers for one device so we never double-spawn or hand back an un-ready runner.
    // A loop, not one wait: two callers that both waited out a failed launch would otherwise both start their own.
    // Other devices are never touched.
    for (;;) {
      const held = this.runners.get(udid)
      if (this.ready(held)) return held
      const pending = this.starting.get(udid)
      if (!pending) break
      const h = await pending.catch(() => undefined)
      if (h && this.ready(h) && this.runners.get(udid) === h) return h
    }
    const starting = this.launchRunner(udid)
    this.starting.set(udid, starting)
    try {
      const ready = await starting
      // Kept through a retry, so an input refused while the next start is under way can still say why the last failed.
      this.failed.delete(udid)
      return ready
    } catch (e) {
      if (this.starting.get(udid) === starting) this.failed.set(udid, e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      if (this.starting.get(udid) === starting) this.starting.delete(udid)
    }
  }

  /**
   * Start the runner before anything asks for a tree, for a device an automation client just booted. A cold
   * start is about 3 s on a running simulator and 8–9 s right after a boot (iOS 26.5), and on the first query
   * that time is spent inside the step's selector timeout (10 s by default). Manual sessions are not warmed:
   * they never read the tree, and a runner costs about 650 MB per device.
   *
   * Each device has its own runner, so warming one never touches another's. A read during the warm-up waits on
   * the same launch.
   */
  warm(udid: string): void {
    if (this.starting.has(udid)) return
    const held = this.runners.get(udid)
    let generation = this.generation(udid)
    // A runner already serving this device may have died with a simulator shut down outside tapflow, while its
    // xcodebuild lingers for up to a minute and still looks alive: ask it before keeping it. Dropping it here is
    // this warm-up's own doing, so it moves the generation this warm-up compares against.
    const check = this.ready(held)
      ? answers(held.host, held.port, held.token).then((ok) => {
        // Only a drop of its own moves the generation it compares against. A probe that failed because the
        // device was shut down (or the agent stopped) meanwhile must leave that stop standing.
        if (!ok && this.runners.get(udid) === held) {
          this.dropRunner(udid, held)
          generation = this.generation(udid)
        }
      })
      : Promise.resolve()
    check.then(() => {
      // The device may have been shut down while the probe was out.
      if (this.generation(udid) !== generation) return
      return this.ensureRunner(udid)
    }).catch((e: Error) => {
      // Stopped on purpose (the device was shut down mid-start) is not a fault worth sending anyone to Xcode for.
      if (this.generation(udid) !== generation) logger.debug(`tree runner warm-up for ${udid} cancelled: ${e.message}`)
      else logger.warn(`tree runner warm-up for ${udid} failed; the first query will try again: ${e.message}`)
    })
  }

  private async launchRunner(udid: string): Promise<ReadyRunner> {
    const stale = this.runners.get(udid)
    if (stale) this.dropRunner(udid, stale)
    const generation = this.generation(udid)
    await this.ensureBuilt(udid)
    const platform = this.platformOf(udid)
    let host = 'localhost'
    if (platform === 'physical') {
      try {
        host = urlHost(await this.native.tunnelAddress(udid))
      } catch (e) {
        throw new PlatformError(`cannot reach ${udid}: ${(e as Error).message}`)
      }
    }
    if (this.generation(udid) !== generation) throw new PlatformError('tree runner start cancelled — the runner was stopped while it was being built')
    // No await between the check above and registering the handle, so a stop always finds what it must kill.
    const token = randomUUID()
    const proc = platform === 'physical'
      ? this.native.spawn(this.destination(udid), token, 'physical')
      : this.native.spawn(this.destination(udid), token)
    proc.on('error', (e) => logger.error('tree runner process error:', e.message))
    const handle: RunnerHandle = { proc, udid, token, host, platform, tail: '' }
    this.runners.set(udid, handle)
    const port = await this.waitReady(handle)
    // Stopped while it was coming up: its xcodebuild takes seconds to exit, and until then the runner still answers.
    if (this.runners.get(udid) !== handle) throw new PlatformError('tree runner start cancelled — the runner was stopped while it was starting')
    handle.port = port
    return handle as ReadyRunner
  }

  // The runner announces its port on stdout once it is listening. Resolves with it, or rejects when the process
  // exits first or the deadline passes. The listener stays for the life of the process: an undrained pipe would
  // block the runner once its buffer filled.
  private readPort(handle: RunnerHandle, deadline: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let pending = ''
      let settled = false
      const settle = (err: Error | undefined, port?: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        handle.proc.off('exit', onExit)
        if (err) reject(err)
        else resolve(port as number)
      }
      const onExit = (): void => settle(new PlatformError(exitedMessage(handle)))
      const timer = setTimeout(() => settle(new PlatformError('tree runner did not become ready in time')), Math.max(0, deadline - Date.now()))
      handle.proc.stdout?.on('data', (chunk: Buffer | string) => {
        handle.tail = (handle.tail + chunk.toString()).slice(-TAIL_CHARS)
        if (settled) return
        // A chunk boundary can split the line, so keep the unfinished tail.
        pending += chunk.toString()
        const m = READY_LINE.exec(pending)
        if (m) settle(undefined, Number(m[1]))
        else pending = pending.slice(pending.lastIndexOf('\n') + 1)
      })
      handle.proc.once('exit', onExit)
      if (!this.runnerAlive(handle)) onExit()
    })
  }

  private async waitReady(handle: RunnerHandle): Promise<number> {
    const deadline = Date.now() + READY_DEADLINE_MS
    try {
      const port = await this.readPort(handle, deadline)
      // A runner built before the port was chosen this way prints the port it was given, which is now 0.
      if (port === 0) throw new PlatformError('tree runner is out of date (announced port 0) — remove xctest-runner/build to rebuild it')
      // A clock, not an iteration count: a refused connection fails at once, so the count would set the cap
      // through the sleep below.
      while (Date.now() < deadline) {
        if (!this.runnerAlive(handle)) throw new PlatformError(exitedMessage(handle))
        try {
          const r = await fetch(`http://${handle.host}:${port}/health`, { headers: tokenHeader(handle.token), signal: AbortSignal.timeout(1000) })
          if (r.ok) {
            // Anything else answering is not the runner we started, and its tree would be another simulator's.
            if ((await r.text()).trim() === handle.token) return port
            throw new PlatformError(`port ${port} is answered by another tree runner — not reading from it`)
          }
        } catch (e) {
          if (e instanceof PlatformError) throw e
          /* not listening yet */
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      throw new PlatformError('tree runner did not become ready in time')
    } catch (e) {
      this.dropRunner(handle.udid, handle)
      throw e
    }
  }

  async read(udid: string, bundleId: string): Promise<UIElement[]> {
    if (!bundleId) throw new PlatformError('UI tree query needs a foreground app — launch an app first')
    const handle = await this.ensureRunner(udid)
    let text: string
    try {
      const r = await fetch(`http://${handle.host}:${handle.port}/tree?bundleId=${encodeURIComponent(bundleId)}`, {
        headers: tokenHeader(handle.token),
        signal: AbortSignal.timeout(10_000),
      })
      if (!r.ok) throw new PlatformError(`tree runner returned HTTP ${r.status} for ${bundleId}`)
      text = await r.text()
    } catch (e) {
      if (e instanceof PlatformError) throw e
      // Nothing listening: the runner died (with its simulator, shut down outside tapflow) while xcodebuild lingers,
      // so `runnerAlive` still says yes. Drop it, or every read until xcodebuild exits fails the same way. A timeout
      // is not this: a runner on a screen that never goes idle is slow, not gone.
      if (refused(e)) this.dropRunner(udid, handle)
      throw new PlatformError(`UI tree query failed: ${(e as Error).message}`)
    }
    // Guard against a garbage / wrong-bundleId body silently parsing to an empty
    // tree — consumers must see an error, never a false "screen has no elements".
    // Load-bearing for launch readiness too: while a launched app is still starting the runner answers a "not found"
    // query chain, and this error is what tells flow-runner's `launchApp` the screen is not up yet (see agent-core's
    // `DeviceAgent.launchApp`). Turning it into an empty tree would make every launch read as ready at once.
    if (!text.includes('Element subtree:') && !text.includes('Application,')) {
      throw new PlatformError(`tree runner returned an unexpected response for ${bundleId} — is the app running in the foreground?`)
    }
    return parseTreeText(text)
  }

  /**
   * Sends one input request (`/tap`, `/drag`, `/type`, `/key` — see TreeServer.swift) to the device's runner,
   * starting it if needed. Rejects with a PlatformError carrying the runner's own message when it refuses.
   */
  async input(udid: string, path: string, body?: string): Promise<void> {
    const handle = await this.ensureRunner(udid)
    let r: Response
    try {
      r = await fetch(`http://${handle.host}:${handle.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...tokenHeader(handle.token), ...(body === undefined ? {} : { 'Content-Type': 'text/plain; charset=utf-8' }) },
        ...(body === undefined ? {} : { body }),
        // A long press or a slow drag is played out before the runner answers.
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      // The same reasoning as `read`: refused means gone, a timeout means slow.
      if (refused(e)) this.dropRunner(udid, handle)
      throw new PlatformError(`input to the UI-test runner failed: ${(e as Error).message}`)
    }
    const text = await r.text()
    let answer: { ok?: unknown; error?: unknown } = {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (isObj(parsed)) answer = parsed
    } catch {
      /* not JSON: a runner built before the input routes answers 404 in plain text */
    }
    if (r.ok && answer.ok === true) return
    const reason = typeof answer.error === 'string' ? answer.error : `HTTP ${r.status}${r.status === 404 ? ' — the runner predates input; remove xctest-runner/build* to rebuild it' : ''}`
    throw new PlatformError(`UI-test runner refused ${path.split('?')[0]}: ${reason}`)
  }

  /** The input seam for one device, for `XCUITestInput`. */
  inputClient(udid: string): RunnerInputClient {
    return {
      warm: () => this.warm(udid),
      state: () => {
        if (this.ready(this.runners.get(udid))) return 'ready'
        return this.failed.has(udid) && !this.starting.has(udid) ? 'unavailable' : 'starting'
      },
      request: (path, body) => this.input(udid, path, body),
      lastError: () => this.failed.get(udid) ?? null,
    }
  }

  // Drop one device's runner, if `handle` is still the one it holds. Every fault path goes through here rather than
  // stop(): one device's dead runner must not take the others down with it.
  private dropRunner(udid: string, handle: RunnerHandle): void {
    if (this.runners.get(udid) !== handle) return
    this.runners.delete(udid)
    this.bumpGeneration(udid)
    this.killHandle(handle)
  }

  // Stop every device's runner, including launches still building (agent shutdown).
  stop(): void {
    this.epoch++
    for (const handle of this.runners.values()) this.killHandle(handle)
    this.runners.clear()
  }

  // Stop this device's runner, or the launch starting one for it — on device shutdown and before an erase.
  stopIfDevice(udid: string): void {
    this.bumpGeneration(udid)
    const handle = this.runners.get(udid)
    if (!handle) return
    this.runners.delete(udid)
    this.killHandle(handle)
  }

  private killHandle(handle: RunnerHandle): void {
    const { proc, udid } = handle
    const pid = proc.pid
    // detached spawn → the child leads its own group; kill the whole group.
    try {
      if (pid) process.kill(-pid, 'SIGTERM')
      else proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    // The in-simulator runner is not in that group; ending xcodebuild normally ends it, and this covers the case
    // where it does not. On a device, xcodebuild's exit ends the test session; simctl has nothing to terminate there.
    if (handle.platform === 'simulator') this.native.terminateRunner(udid)
    // SIGKILL fallback if SIGTERM did not take.
    const timer = setTimeout(() => {
      try {
        if (pid) process.kill(-pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }, 3000)
    timer.unref?.()
  }
}
