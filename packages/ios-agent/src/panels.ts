// What a simulator's integrated panels are — the facts a multi-panel device (iPhone Duo) needs that a
// single-panel one never asked for. Pure parsers; SimctlWrapper runs the commands.

/** One integrated panel of a booted device, from `simctl io <udid> enumerate`'s Connected Screens. */
export interface IntegratedScreen {
  /** The same number devicectl calls `displayId` (1 = the cover `primary` on the Duo, 3 = `primary-1`). */
  screenId: number
  /** The display's Unique ID. **It changes on every boot**, so it is read per boot and never stored. */
  uuid: string
  /** `primary`, `primary-1` — the stable name, from the device type's capabilities. */
  deviceName: string
  /** The panel's framebuffer in pixels. The capture helper picks a panel by this (`--panel <w>x<h>`). */
  width: number
  height: number
  /** Its points-per-pixel (`Preferred UI Scale`); 1 when the output does not say. */
  scale: number
  /** DeviceKit's frame for this panel (`com.apple.dt.devicekit.chrome.phone15`), or null for `(none)`. On the
   *  Duo each panel has its own (cover `phone15`, unfolded `phone14`); the device type's model has one. */
  chromeId: string | null
}

/**
 * The integrated panels in `simctl io enumerate` output. Everything else it lists — TVOut, CarPlay, the
 * Resizable scene — is not a panel of the device and is left out: sending touches for a screen nobody
 * registered a digitizer for is how a guest's backboardd gets killed.
 */
export function parseIntegratedScreens(text: string): IntegratedScreen[] {
  const screens: IntegratedScreen[] = []
  // Each connected screen is a block that opens with `(<id>) <Name>:` and lists `Key: value` lines.
  for (const block of text.split(/\n(?=\s*\(\d+\)\s[^\n]*:\s*\n)/)) {
    const field = (key: string) => block.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'))?.[1]
    if (field('Screen Type') !== 'Integrated') continue
    const screenId = Number(field('Screen ID'))
    const uuid = field('Unique ID')
    const deviceName = field('Device Name')
    const size = field('Pixel Size')?.match(/^\{(\d+),\s*(\d+)\}$/)
    if (!Number.isInteger(screenId) || !uuid || !deviceName || !size) continue
    const chrome = field('Chrome ID')
    const scale = Number(field('Preferred UI Scale'))
    screens.push({
      screenId, uuid, deviceName, width: Number(size[1]), height: Number(size[2]),
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      chromeId: chrome && chrome !== '(none)' ? chrome : null,
    })
  }
  return screens.sort((a, b) => a.screenId - b.screenId)
}

/**
 * How many integrated panels a device type has, from its `capabilities.plist` as JSON. Xcode 27 lists a
 * device's displays there (the profile keys Xcode 26 used are gone — see `screenSizeFromDeviceType`);
 * Xcode 26 has no `displays` at all, which reads as 1: every device type before the Duo had one panel.
 */
export function countIntegratedPanels(capabilities: unknown): number {
  const displays = (capabilities as { capabilities?: { displays?: unknown } } | null)?.capabilities?.displays
  if (!Array.isArray(displays)) return 1
  const n = displays.filter((d) => (d as { displayType?: unknown } | null)?.displayType === 'integrated').length
  return Math.max(n, 1)
}

/** One integrated panel of a device type, from its `capabilities.plist` — known without booting the device. */
export interface TypePanel {
  /** `primary`, `primary-1` — the same name `IntegratedScreen.deviceName` carries once the device is up. */
  deviceName: string
  /** DeviceKit's frame for this panel, or null when the type names none. */
  chromeId: string | null
  /** The framebuffer in pixels, and its points-per-pixel. */
  width: number
  height: number
  scale: number
  /**
   * How far the panel is drawn turned. A panel drawn natively turned has its framebuffer and its frame turned
   * with it: the Duo's unfolded panel (`primary-1`) is 270, so a device held upright shows that panel turned
   * 90 (measured). A panel with no stated quarter turn is 0, which is every panel before the Duo.
   */
  nativeOrientation: 0 | 90 | 180 | 270
}

/**
 * The integrated panels of a device type, from its `capabilities.plist` as JSON. Empty on Xcode 26, whose
 * plist lists no displays; a display missing its size is left out rather than guessed.
 */
export function typePanels(capabilities: unknown): TypePanel[] {
  const displays = (capabilities as { capabilities?: { displays?: unknown } } | null)?.capabilities?.displays
  if (!Array.isArray(displays)) return []
  const panels: TypePanel[] = []
  for (const d of displays as Array<Record<string, unknown>>) {
    if (d?.displayType !== 'integrated' || typeof d.deviceName !== 'string') continue
    if (typeof d.width !== 'number' || typeof d.height !== 'number') continue
    const turn = d.nativeOrientation
    panels.push({
      deviceName: d.deviceName,
      chromeId: typeof d.chromeIdentifier === 'string' ? d.chromeIdentifier : null,
      width: d.width, height: d.height,
      scale: typeof d.scale === 'number' && d.scale > 0 ? d.scale : 1,
      nativeOrientation: turn === 90 || turn === 180 || turn === 270 ? turn : 0,
    })
  }
  return panels
}
