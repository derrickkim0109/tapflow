import type { ChromePanel, DeviceChromeLoader } from './DeviceChromeLoader.js'
import type { TypePanel } from './panels.js'
import type { Rotation } from './PanelState.js'
import type { SimctlWrapper } from './SimctlWrapper.js'

/** The frame `DeviceChromeLoader` draws for a panel: its chrome, at its size in points. Undefined with no chrome. */
export function panelFrame(panel: Pick<TypePanel, 'chromeId' | 'width' | 'height' | 'scale'>): ChromePanel | undefined {
  if (!panel.chromeId) return undefined
  return { chromeId: panel.chromeId, width: Math.round(panel.width / panel.scale), height: Math.round(panel.height / panel.scale) }
}

/**
 * What a multi-panel device type's panels are, and what follows from them, kept per device type: the facts
 * are the type's, read from its `capabilities.plist`, so they are known before a device boots and the same for
 * every device of the type.
 *
 * - `nativeOrientation` — how far a panel's frame is drawn turned (`ChromeData.streamRotation` adds it).
 * - `scaleBasis` — `ChromeData.scaleBasis`, from every panel's frame. Known before the first frame is sent,
 *   so a viewer sizes the device once rather than once by its cover and again by the whole device.
 *
 * A failed read is not kept, so the next asks again.
 */
export class TypePanels {
  private readonly panels = new Map<string, Promise<TypePanel[]>>()
  private readonly resolved = new Map<string, TypePanel[]>()
  private readonly bases = new Map<string, Promise<number | undefined>>()

  constructor(
    private readonly simctl: Pick<SimctlWrapper, 'typePanels'>,
    private readonly chromeLoader: Pick<DeviceChromeLoader, 'load'>,
  ) {}

  /** The type's panels; empty when they cannot be read. */
  load(typeId: string): Promise<TypePanel[]> {
    let panels = this.panels.get(typeId)
    if (!panels) {
      panels = Promise.resolve()
        .then(() => this.simctl.typePanels(typeId))
        .then((p) => { this.resolved.set(typeId, p); return p })
        .catch(() => { this.panels.delete(typeId); return [] })
      this.panels.set(typeId, panels)
    }
    return panels
  }

  /** A panel's native turn — 0 until the type's panels have loaded, which is every panel before the Duo. */
  nativeOrientation(typeId: string, deviceName: string): Rotation {
    return this.resolved.get(typeId)?.find((p) => p.deviceName === deviceName)?.nativeOrientation ?? 0
  }

  /** The longest side, in 2× px, of the largest panel's frame; undefined if any frame does not load. */
  scaleBasis(typeId: string): Promise<number | undefined> {
    let basis = this.bases.get(typeId)
    if (!basis) {
      basis = this.computeBasis(typeId).then((b) => {
        if (b === undefined) this.bases.delete(typeId)
        return b
      })
      this.bases.set(typeId, basis)
    }
    return basis
  }

  private async computeBasis(typeId: string): Promise<number | undefined> {
    const frames = (await this.load(typeId)).map(panelFrame)
    if (frames.length < 2 || frames.some((f) => !f)) return undefined
    const chromes = await Promise.all(frames.map((f) => this.chromeLoader.load(typeId, f)))
    if (chromes.some((c) => !c)) return undefined
    const basis = Math.max(...chromes.map((c) => Math.max(c!.compositeWidth, c!.compositeHeight)))
    return Number.isFinite(basis) && basis > 0 ? basis : undefined
  }
}
