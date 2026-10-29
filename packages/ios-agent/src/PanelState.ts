import { execFile } from 'child_process'
import { readFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:panel-state')
const execFileAsync = promisify(execFile)

// One `devicectl device info displays` measured ~0.23 s on the Mac mini (Xcode 27.1).
const DEVICECTL_TIMEOUT_MS = 10_000
// A fold is not done when the sweep is: measured on Xcode 27.1, both panels go dark 1–2 s after the
// command and the new one lights 4–6 s after it, and devicectl's `active` flips within about a second
// of the framebuffer. A wait shorter than that reports a successful fold as a failed one.
export const FOLD_SETTLE_MS = 10_000
const AWAIT_INTERVAL_MS = 300
// How long a panel nobody asked for must stay lit before it is followed. Measured on Xcode 27.1: a Duo
// coming up from an erase lit its unfolded panel for at most 3.2 s, some 49 s into the boot, and went back
// to its cover — once in two erase boots, and on each of three session re-entries on a Duo DeviceHub was
// showing. Followed, the viewer swapped to a dark unfolded panel and back. A fold made in DeviceHub holds.
export const PANEL_HOLD_MS = 4_000

export type Rotation = 0 | 90 | 180 | 270

/** One integrated panel as devicectl reports it. `displayId` is the same number as `simctl io
 *  enumerate`'s Screen ID (1 = cover `primary`, 3 = unfolded `primary-1` on the Duo). `rotation` is null for
 *  a value devicectl gives that this agent does not know: which panel is lit still holds, and that is what
 *  input needs. */
export interface PanelInfo {
  displayId: number
  active: boolean
  rotation: Rotation | null
}

export interface PanelReading {
  /** The panel the device is showing, or null mid-fold, when neither is active. */
  lit: { displayId: number; rotation: Rotation | null } | null
  panels: PanelInfo[]
}

export interface PanelStateNative {
  /** The parsed `--json-output` document of `devicectl device info displays` for this device. */
  readDisplays(udid: string): Promise<unknown>
}

export const defaultPanelStateNative: PanelStateNative = {
  async readDisplays(udid) {
    // devicectl writes JSON only to a file. Read and removed asynchronously, like the call itself —
    // this runs on the loop that forwards frames (contributing/agent-event-loop-blocking.md).
    const out = join(tmpdir(), `tapflow-devicectl-${udid}-${randomUUID()}.json`)
    try {
      await execFileAsync('xcrun', ['devicectl', 'device', 'info', 'displays', '--device', udid, '--quiet', '--json-output', out],
        { timeout: DEVICECTL_TIMEOUT_MS })
      return JSON.parse(await readFile(out, 'utf8'))
    } finally {
      unlink(out).catch(() => { /* never written */ })
    }
  },
}

const ROTATIONS: Record<string, Rotation> = { rot0: 0, rot90: 90, rot180: 180, rot270: 270 }

/** The integrated panels in a devicectl displays document, or null if the document is not one. A rotation
 *  it does not know is null on that panel — not a guess, which would turn the picture, and not the whole
 *  reading, which would also lose which panel is lit and leave input waiting for it. A first version did
 *  the latter, and input never started on a Duo whose first readings after its boot carried one. */
export function parseDisplays(doc: unknown): PanelReading | null {
  const displays = (doc as { result?: { displays?: unknown } } | null)?.result?.displays
  if (!Array.isArray(displays)) return null
  const panels: PanelInfo[] = []
  for (const d of displays as Array<Record<string, unknown>>) {
    const type = d.type as Record<string, unknown> | undefined
    if (!type || !('integrated' in type)) continue
    if (typeof d.displayId !== 'number' || typeof d.active !== 'boolean') return null
    panels.push({ displayId: d.displayId, active: d.active, rotation: ROTATIONS[String(d.currentOrientation)] ?? null })
  }
  if (panels.length === 0) return null
  const lit = panels.find((p) => p.active)
  return { lit: lit ? { displayId: lit.displayId, rotation: lit.rotation } : null, panels }
}

interface Flight {
  current: Promise<PanelReading | null>
  next: Promise<PanelReading | null> | null
}

/**
 * Which panel a multi-panel device is showing, observed rather than inferred from the hinge angle: the
 * host cannot tell (both panels report Power On to `simctl io`) and the angle is the guest's to turn
 * into a panel, so devicectl's `active` is the answer SpringBoard itself gave.
 *
 * Keyed by udid and kept outside `DeviceState`, which every relay reconnect rebuilds.
 */
export class PanelState {
  private readonly flights = new Map<string, Flight>()
  private readonly known = new Map<string, PanelReading>()
  // A different panel read lit, not yet held for `holdMs`, and when it was first read so.
  private readonly candidates = new Map<string, { reading: PanelReading; since: number }>()
  // Bumped by `forget`: a reading started before it describes the device as it was, and is dropped.
  private readonly generations = new Map<string, number>()

  constructor(
    private readonly native: PanelStateNative = defaultPanelStateNative,
    readonly holdMs = PANEL_HOLD_MS,
  ) {}

  /**
   * A fresh reading. **A read that arrives while a call is in flight never joins it**: it gets exactly one
   * more call that starts after the current one ends, shared with any other reads that arrive meanwhile.
   * Joining would hand a caller who asked after a fold a reading taken before it — measured as the way a
   * poll turns a successful Unfold into a reported failure.
   *
   * Resolves null when the call fails; `last()` keeps the previous answer.
   */
  read(udid: string): Promise<PanelReading | null> {
    const flight = this.flights.get(udid)
    if (!flight) return this.startFlight(udid)
    if (!flight.next) {
      flight.next = flight.current.then(() => {
        const f = this.flights.get(udid)
        if (f) f.next = null
        return this.startFlight(udid)
      })
    }
    return flight.next
  }

  /**
   * The lit panel the device has settled on, or null before any reading named one. Synchronous, for the paths
   * that cannot await. **Not simply the last reading**: a change nobody asked for counts only once the new
   * panel has stayed lit for `holdMs` (see PANEL_HOLD_MS) — a fold this agent made and waited for with
   * `awaitLit` counts at once. Until then this keeps the panel before it.
   */
  last(udid: string): PanelReading | null {
    return this.known.get(udid) ?? null
  }

  /** Whether a different panel has been read lit and is still being held to `holdMs` — read again after it. */
  changing(udid: string): boolean {
    return this.candidates.has(udid)
  }

  forget(udid: string): void {
    this.known.delete(udid)
    this.candidates.delete(udid)
    this.generations.set(udid, (this.generations.get(udid) ?? 0) + 1)
  }

  /** Reads until `done` holds, or `timeoutMs` passes (then null). For a fold: the sweep finishing is not
   *  the panel changing — see FOLD_SETTLE_MS. */
  async awaitLit(udid: string, done: (r: PanelReading) => boolean, timeoutMs = FOLD_SETTLE_MS): Promise<PanelReading | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const reading = await this.read(udid)
      if (reading && done(reading)) {
        // Asked for and arrived: nothing to hold it to.
        if (reading.lit) this.settle(udid, reading)
        return reading
      }
      if (Date.now() + AWAIT_INTERVAL_MS > deadline) return null
      await new Promise((r) => setTimeout(r, AWAIT_INTERVAL_MS))
    }
  }

  private startFlight(udid: string): Promise<PanelReading | null> {
    const generation = this.generations.get(udid) ?? 0
    const current = this.native.readDisplays(udid).then(
      (doc) => {
        // Forgotten while it ran — the device shut down or was erased under it. Kept, it would put the panel
        // lit before the shutdown back as the one the next boot starts from.
        if ((this.generations.get(udid) ?? 0) !== generation) return null
        const reading = parseDisplays(doc)
        // What it said goes in the log: the one time this fired on a real Duo, nobody could see why.
        if (!reading) logger.warn(`devicectl gave ${udid} a displays document this agent does not recognise: ${JSON.stringify(doc).slice(0, 400)}`)
        // Only a reading that names a lit panel replaces the last one: mid-fold both are dark, and the
        // last panel is the better answer for anything that cannot wait.
        if (reading?.lit) this.observe(udid, { ...reading, lit: reading.lit })
        return reading
      },
      (e: unknown) => {
        logger.warn(`devicectl displays failed for ${udid}: ${e instanceof Error ? e.message : String(e)}`)
        return null
      },
    )
    const flight: Flight = { current, next: null }
    this.flights.set(udid, flight)
    void current.then(() => {
      if (this.flights.get(udid) === flight && !flight.next) this.flights.delete(udid)
    })
    return current
  }

  private observe(udid: string, reading: PanelReading & { lit: NonNullable<PanelReading['lit']> }): void {
    const known = this.known.get(udid)
    if (!known?.lit || known.lit.displayId === reading.lit.displayId) {
      const dropped = this.candidates.get(udid)?.reading.lit?.displayId
      if (dropped !== undefined) logger.info(`${udid} lit display ${dropped} only briefly — not followed`)
      this.settle(udid, reading)
      return
    }
    const candidate = this.candidates.get(udid)
    if (candidate?.reading.lit?.displayId !== reading.lit.displayId) {
      this.candidates.set(udid, { reading, since: Date.now() })
    } else if (Date.now() - candidate.since >= this.holdMs) {
      this.settle(udid, reading)
    } else {
      candidate.reading = reading
    }
  }

  private settle(udid: string, reading: PanelReading): void {
    const before = this.known.get(udid)?.lit?.displayId
    this.known.set(udid, reading)
    this.candidates.delete(udid)
    if (before !== undefined && before !== reading.lit?.displayId) logger.info(`${udid} now shows display ${reading.lit?.displayId}`)
  }
}
