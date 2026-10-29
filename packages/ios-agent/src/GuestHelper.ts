import { execFile, spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:guest-helper')
const execFileAsync = promisify(execFile)

// `bin/guest-helper` runs INSIDE the simulator (an iphonesimulator executable), so it is started through
// `simctl spawn`, never directly. See `src/guest-helper.m` for its protocol and why it exists.
export const GUEST_HELPER_BINARY = join(import.meta.dirname, '..', 'bin', 'guest-helper')

// The same rolling window as TouchHelper, for the same reason it gives.
const RESPAWN_LIMIT = 3
const RESPAWN_WINDOW_MS = 30_000

// `ready` comes after `simctl spawn` has started the guest process, the helper has registered its
// services, and a 300 ms settle (a tap within 50 ms of registering is dropped, measured on Xcode 27.1).
// The spawn alone measured ~0.6–0.9 s. **The bound is for a wedge, not a slow Mac**: on an 8 GB Mac mini
// swapping 1.8 GB with a Duo up, the agent's own loop stalled 3.2 s, and an 8 s bound replaced three
// healthy-but-slow helpers in a row.
const READY_DEADLINE_MS = 15_000

// A command the helper answers with `done`: the fold sweep plays inside the helper (0.8 s), a key is held
// for its own duration. Past this margin on top of that, the helper is treated as wedged and replaced —
// generous for the reason READY_DEADLINE_MS gives: a 5 s margin replaced a helper mid-stall.
const COMMAND_MARGIN_MS = 10_000
// A fold's margin, longer: the sweep can sit blocked while the device changes panel. Measured on that Mac
// mini with a session streaming: a sweep went unanswered past 10.8 s although its panel lit at 10.6 s, so
// the helper was replaced just after it had folded the device — and the next press, landing while the new
// helper started, was refused. A late answer to a fold is harmless; it is what was asked for.
const HINGE_MARGIN_MS = 30_000

const STOP_SIGKILL_AFTER_MS = 1_000

export type TouchPhase = 'd' | 'm' | 'u'
/** DeviceHub's own orientation labels. On the unfolded panel `landscape-left` shows the UI upright and
 *  `pud` shows it landscape with its bottom at the buffer's left edge (measured) — they are not the
 *  public names' meaning, which is why nothing outside the agent should pick one. */
export type GuestOrientation = 'portrait' | 'pud' | 'landscape-left' | 'landscape-right'

/** The process-level operations, injectable for tests — the same seam `XCUITreeReader` uses. */
export interface GuestHelperNative {
  spawn(udid: string, args: string[]): ChildProcess
  /** Guest helpers for this udid still running from an earlier agent or an earlier spawn. */
  findOrphans(udid: string): Promise<number[]>
  killPid(pid: number, signal: NodeJS.Signals): void
  /**
   * Why a multi-panel device cannot be used on this Mac before anything is booted, or null if it can: the
   * helper binary is missing, or there is no devicectl to say which panel is lit. Asked at connect, so such a
   * device is left out of the list rather than offered and refused after a 3 GB boot.
   */
  unavailableReason(): Promise<string | null>
}

export const defaultGuestHelperNative: GuestHelperNative = {
  spawn(udid, args) {
    // Detached so a terminal's Ctrl-C, which signals the whole process group, cannot take `simctl spawn`
    // down before the agent's own cleanup runs — the guest would then be orphaned with nobody left to
    // know its pid.
    return spawn('xcrun', ['simctl', 'spawn', udid, GUEST_HELPER_BINARY, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
  },
  async findOrphans(udid) {
    // **Found by search, not by memory.** An agent killed with -9 restarts knowing no pids, and a
    // `simctl spawn` that died alone leaves the guest running (measured) — a respawn would then register
    // a second set of services on the same displays. The udid in argv is what makes the match ours.
    const marker = `--udid ${udid}`
    let out: string
    try {
      out = (await execFileAsync('/usr/bin/pgrep', ['-f', `guest-helper ${marker}`], { timeout: 5_000 })).stdout
    } catch {
      return [] // pgrep exits 1 when nothing matches
    }
    const pids: number[] = []
    for (const pid of out.split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid)) {
      try {
        const cmd = (await execFileAsync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5_000 })).stdout
        if (cmd.includes(GUEST_HELPER_BINARY) && cmd.includes(marker)) pids.push(pid)
      } catch { /* gone between the two calls */ }
    }
    return pids
  },
  killPid(pid, signal) {
    try { process.kill(pid, signal) } catch { /* already gone, or not ours */ }
  },
  async unavailableReason() {
    if (!existsSync(GUEST_HELPER_BINARY)) return `${GUEST_HELPER_BINARY} is missing — reinstall @tapflowio/ios-agent`
    try {
      await execFileAsync('xcrun', ['--find', 'devicectl'], { timeout: 10_000 })
    } catch {
      return 'devicectl was not found — install Xcode and select it with xcode-select'
    }
    return null
  },
}

interface Pending {
  resolve: (ok: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export interface GuestHelperOptions {
  /** Called when the helper stops serving this device: for good (the runtime refused it — `fatal` — or it
   *  could not be exec'd), or until the respawn window clears. The owner hides posture. */
  onUnavailable?: (reason: string) => void
  /** Called when a helper is ready again after `onUnavailable` — the owner shows posture again. */
  onAvailable?: () => void
}

/**
 * The host side of `guest-helper`: one per multi-panel device, resident for the device's life.
 *
 * Its lifecycle follows TouchHelper's rules — readiness gates writes, a gesture belongs to the process
 * that took its opening frame, deaths are replaced eagerly within a rolling budget — with three
 * differences the guest process forces:
 *  - the process the agent spawns is `simctl spawn`, not the helper; the helper's own pid arrives on
 *    stdout and is killed separately, because the two do not die together;
 *  - earlier helpers for the same device are found with `pgrep` and killed before every spawn;
 *  - `fatal` is final: it means the runtime refused the private API, and spawning again would only
 *    hear the same answer.
 *
 * **Running out of the respawn budget is not final**, which is TouchHelper's rule too ("it self-clears,
 * so a session that briefly could not start a helper is not left without input until the device is
 * rebooted"). A first version made it final, and a Mac short of memory turned one slow minute into a
 * device with no input for the rest of its boot. The helper waits for the window to clear and launches
 * again, answering `starting` meanwhile.
 */
export class GuestHelper {
  private proc: ChildProcess | null = null
  private guestPid: number | null = null
  private gestureProc: ChildProcess | null = null
  private ready = false
  private stopped = false
  private unavailable: string | null = null
  private fatalReason: string | null = null
  private spawns: number[] = []
  private pending: Pending[] = []
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private readyWaiters: Array<(ok: boolean) => void> = []
  private generation = 0
  // Set while waiting out the respawn window after the budget ran out; cleared by the launch it schedules.
  private cooldown: ReturnType<typeof setTimeout> | null = null
  // The reason the helper last went out of service, until a ready says it is back.
  private outage: string | null = null
  // Between `start()` (or a respawn) and the spawn: sweeping orphans and reading the panels. Input sent
  // then is told to wait, not that the channel is gone.
  private launching = false

  /**
   * `touchscreens` is asked on every launch, not once: display UUIDs change on every boot, and a respawn
   * after the device rebooted under the agent must register the new ones.
   */
  constructor(
    private readonly udid: string,
    private readonly touchscreens: () => Promise<string[]>,
    private readonly native: GuestHelperNative = defaultGuestHelperNative,
    private readonly options: GuestHelperOptions = {},
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    await this.launch()
  }

  stop(): void {
    this.stopped = true
    this.launching = false
    if (this.cooldown) { clearTimeout(this.cooldown); this.cooldown = null }
    this.generation++
    this.clearReadyDeadline()
    this.failPending()
    const proc = this.proc
    const guestPid = this.guestPid
    this.proc = null
    this.guestPid = null
    this.gestureProc = null
    this.ready = false
    this.settleReadyWaiters(false)
    // EOF is the first line of defence (the helper exits on it, measured); the signals cover a helper
    // that is wedged and a `simctl spawn` that outlives its child.
    proc?.stdin?.end()
    if (proc) this.signalProcess(proc, 'SIGTERM')
    if (guestPid) this.native.killPid(guestPid, 'SIGTERM')
    const timer = setTimeout(() => {
      if (proc) this.signalProcess(proc, 'SIGKILL')
      if (guestPid) this.native.killPid(guestPid, 'SIGKILL')
    }, STOP_SIGKILL_AFTER_MS)
    timer.unref?.()
  }

  inputState(): 'ready' | 'starting' | 'unavailable' {
    if (this.proc && this.ready) return 'ready'
    if ((this.proc || this.launching || this.cooldown) && !this.unavailable) return 'starting'
    return 'unavailable'
  }

  /** Resolves true once the helper is ready, false if it becomes unavailable or is stopped first. */
  whenReady(): Promise<boolean> {
    if (this.inputState() === 'ready') return Promise.resolve(true)
    if (this.unavailable || this.stopped) return Promise.resolve(false)
    return new Promise((resolve) => this.readyWaiters.push(resolve))
  }

  /** Why the helper cannot serve — for good, or for now — or null. */
  unavailableReason(): string | null {
    return this.unavailable ?? this.outage
  }

  ownsGesture(): boolean {
    return this.proc !== null && this.proc === this.gestureProc
  }

  /** One finger on the panel whose display UUID is `screen`. Acked on the write, like Indigo: the helper
   *  answers a touch only when it fails, and a drag is too many lines a second to wait on. */
  touch(screen: string, phase: TouchPhase, x: number, y: number, edge: boolean): boolean {
    return this.gestureFrame(phase, `touch ${screen} ${phase} ${x} ${y} ${edge ? 1 : 0}`)
  }

  pinch(screen: string, phase: TouchPhase, x1: number, y1: number, x2: number, y2: number): boolean {
    return this.gestureFrame(phase, `pinch ${screen} ${phase} ${x1} ${y1} ${x2} ${y2}`)
  }

  hinge(fromDeg: number, toDeg: number, durationMs: number): Promise<boolean> {
    return this.command(`hinge ${fromDeg} ${toDeg} ${durationMs}`, durationMs, HINGE_MARGIN_MS)
  }

  orient(value: GuestOrientation): Promise<boolean> {
    return this.command(`orient ${value}`, 0)
  }

  key(usagePage: number, usage: number, holdMs: number, modifiers: Array<[number, number]> = []): Promise<boolean> {
    const mods = modifiers.map(([p, u]) => ` ${p} ${u}`).join('')
    return this.command(`key ${usagePage} ${usage} ${holdMs}${mods}`, holdMs)
  }

  /** Half of a held press — a long-press lasts as long as the tester holds it, like TouchHelper's
   *  `pressButtonDown`/`Up`. */
  keyDown(usagePage: number, usage: number): Promise<boolean> {
    return this.command(`keydown ${usagePage} ${usage}`, 0)
  }

  keyUp(usagePage: number, usage: number): Promise<boolean> {
    return this.command(`keyup ${usagePage} ${usage}`, 0)
  }

  private gestureFrame(phase: TouchPhase, line: string): boolean {
    if (phase === 'd') {
      const sent = this.write(line)
      // Only a delivered down owns the gesture — TouchHelper's `openGesture` explains why recording it
      // unconditionally lets a fresh process receive an up for a touch it never saw.
      this.gestureProc = sent ? this.proc : null
      return sent
    }
    if (!this.ownsGesture()) return false
    return this.write(line)
  }

  private command(line: string, playMs: number, marginMs = COMMAND_MARGIN_MS): Promise<boolean> {
    const proc = this.proc
    if (!proc || !this.write(line)) return Promise.resolve(false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = this.pending.findIndex((p) => p.timer === timer)
        if (at !== -1) this.pending.splice(at, 1)
        resolve(false)
        if (this.proc !== proc) return
        logger.error(`no answer to "${line}" within ${playMs + marginMs}ms — replacing the helper`)
        // The guest would still act on a queued command after we gave up on it, so it goes, not only
        // the simctl process that carries its pipe.
        if (this.guestPid) this.native.killPid(this.guestPid, 'SIGKILL')
        this.signalProcess(proc, 'SIGKILL')
      }, playMs + marginMs)
      timer.unref?.()
      this.pending.push({ resolve, timer })
    })
  }

  private write(line: string): boolean {
    if (this.inputState() !== 'ready') return false
    this.proc?.stdin?.write(`${line}\n`)
    return true
  }

  private async launch(): Promise<void> {
    const generation = ++this.generation
    this.launching = true
    let screens: string[]
    try {
      for (const pid of await this.native.findOrphans(this.udid)) {
        logger.warn(`killing a leftover guest-helper (pid ${pid}) for ${this.udid}`)
        this.native.killPid(pid, 'SIGKILL')
      }
      screens = await this.touchscreens()
    } catch (e) {
      if (generation === this.generation) this.launching = false
      if (!this.stopped && generation === this.generation) {
        // Not final: `simctl io enumerate` can fail while a busy Mac is still bringing the device up.
        this.spawns.push(Date.now())
        this.retryLater(`could not read the device's panels: ${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    if (generation !== this.generation) return
    this.launching = false
    if (this.stopped) return

    this.spawns.push(Date.now())
    this.ready = false
    this.guestPid = null
    const proc = this.native.spawn(this.udid, [
      '--udid', this.udid, ...screens.flatMap((uuid) => ['--touchscreen', uuid]),
    ])
    // A pid is the only synchronous sign the exec happened — TouchHelper's `spawnHelper` has the measurement.
    if (proc.pid === undefined) {
      proc.on('error', (e) => logger.error(`spawn error: ${e.message}`))
      this.proc = null
      this.becomeUnavailable('could not start guest-helper through simctl spawn')
      return
    }
    this.proc = proc
    this.armReadyDeadline(proc)

    let partial = ''
    proc.stdout?.on('data', (d: Buffer) => {
      const lines = (partial + d.toString()).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) this.onLine(proc, line.trim())
    })
    proc.stderr?.on('data', (d: Buffer) => logger.error(d.toString().trim()))
    proc.on('exit', (code) => {
      logger.warn(`guest-helper for ${this.udid} exited with code ${code ?? 'null'}`)
      this.handleDeath(proc)
    })
    proc.on('error', (e) => {
      logger.error(`spawn error: ${e.message}`)
      this.handleDeath(proc)
    })
  }

  private onLine(proc: ChildProcess, line: string): void {
    if (this.proc !== proc || !line) return
    const [word, ...rest] = line.split(' ')
    if (word === 'pid') {
      const pid = Number(rest[0])
      if (Number.isInteger(pid) && pid > 0) this.guestPid = pid
    } else if (word === 'ready') {
      this.ready = true
      this.clearReadyDeadline()
      this.settleReadyWaiters(true)
      if (this.outage) {
        logger.info(`guest-helper back in service for ${this.udid}`)
        this.outage = null
        this.options.onAvailable?.()
      }
    } else if (word === 'done') {
      this.pending.shift()?.resolve(rest[0] === '0')
    } else if (word === 'err') {
      // A touch frame the guest refused. Touches are acked on the write, so this only gets logged.
      logger.warn(`guest-helper refused: ${rest.slice(1).join(' ')} (status ${rest[0]})`)
    } else if (word === 'fatal') {
      this.fatalReason = rest.join(' ') || 'guest-helper could not start'
      this.becomeUnavailable(this.fatalReason)
    }
  }

  private handleDeath(proc: ChildProcess): void {
    if (this.proc !== proc) return
    this.clearReadyDeadline()
    this.failPending()
    this.proc = null
    this.guestPid = null
    this.ready = false
    if (this.stopped || this.fatalReason) return
    const now = Date.now()
    this.spawns = this.spawns.filter((t) => now - t < RESPAWN_WINDOW_MS)
    if (this.spawns.length >= RESPAWN_LIMIT) {
      this.retryLater(`guest-helper died ${RESPAWN_LIMIT} times in ${RESPAWN_WINDOW_MS / 1000}s`)
      return
    }
    void this.launch()
  }

  /** Out of service until the respawn window has room again, then launch. */
  private retryLater(reason: string): void {
    if (this.cooldown || this.stopped) return
    const now = Date.now()
    this.spawns = this.spawns.filter((t) => now - t < RESPAWN_WINDOW_MS)
    const wait = this.spawns.length >= RESPAWN_LIMIT ? RESPAWN_WINDOW_MS - (now - this.spawns[0]) + 50 : 0
    logger.warn(`guest-helper out of service for ${this.udid}: ${reason} — trying again in ${Math.round(wait / 1000)}s`)
    this.noteOutage(reason)
    const timer = setTimeout(() => {
      if (this.cooldown !== timer) return
      this.cooldown = null
      if (!this.stopped) void this.launch()
    }, wait)
    timer.unref?.()
    this.cooldown = timer
  }

  private noteOutage(reason: string): void {
    if (this.outage) return
    this.outage = reason
    this.options.onUnavailable?.(reason)
  }

  /** For good: the runtime refused the helper, or it could not be exec'd at all. */
  private becomeUnavailable(reason: string): void {
    if (this.unavailable) return
    this.unavailable = reason
    this.ready = false
    this.settleReadyWaiters(false)
    logger.error(`guest-helper unavailable for ${this.udid}: ${reason}`)
    this.outage = null
    this.noteOutage(reason)
  }

  private armReadyDeadline(proc: ChildProcess): void {
    this.clearReadyDeadline()
    const timer = setTimeout(() => {
      if (this.proc !== proc || this.ready) return
      logger.error(`no ready from guest-helper within ${READY_DEADLINE_MS}ms — replacing it`)
      if (this.guestPid) this.native.killPid(this.guestPid, 'SIGKILL')
      this.signalProcess(proc, 'SIGKILL')
    }, READY_DEADLINE_MS)
    timer.unref?.()
    this.readyTimer = timer
  }

  private clearReadyDeadline(): void {
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null }
  }

  private failPending(): void {
    for (const p of this.pending.splice(0)) { clearTimeout(p.timer); p.resolve(false) }
  }

  private settleReadyWaiters(ok: boolean): void {
    for (const resolve of this.readyWaiters.splice(0)) resolve(ok)
  }

  /** `simctl spawn` was started detached, so it leads its own process group. */
  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.pid) this.native.killPid(-proc.pid, signal)
    proc.kill(signal)
  }
}
