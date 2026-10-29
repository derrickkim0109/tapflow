import { useEffect, useRef, type RefObject } from 'react'

/**
 * Fades the device in when it changes panel — another frame arrives, from a fold asked for here or made
 * elsewhere (DeviceHub). The first frame drawn does not fade.
 *
 * A fold is not animated beyond this, by decision: a picture of the device cut at the hinge and turned in 3D
 * was built and measured as worse than none — no thickness, a box rather than the frame folding, an abrupt
 * swap to the real frame at the end, and it spilled over the UI around it. A convincing fold needs the
 * device's 3D model. Meanwhile the screen says what is happening (`IOSDeviceScreen`'s waiting overlay).
 */
export function usePanelFade(containerRef: RefObject<HTMLElement | null>, frame: string): void {
  const shownFrame = useRef(frame)
  useEffect(() => {
    if (shownFrame.current === frame) return
    shownFrame.current = frame
    const el = containerRef.current
    // `animate` is absent in jsdom; and nothing moves for a viewer who asked for less motion.
    if (typeof el?.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' })
  }, [frame, containerRef])
}
