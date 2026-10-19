import { useEffect, useState } from 'react'

/**
 * True once `active` has held for `ms` — so a loading line or skeleton appears only for a load slow
 * enough to notice, not as a flash on one that takes a few milliseconds. Set from the timer's
 * callback, never synchronously in the effect.
 *
 * `load` names which load this is: switching what is loaded can keep `active` true throughout, so
 * without it the timer would never restart.
 */
export function useShownAfter(active: boolean, ms: number, load?: unknown): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => setElapsed(true), ms)
    // Reset on the way out, so the next load waits its own `ms`.
    return () => { clearTimeout(t); setElapsed(false) }
  }, [active, ms, load])
  return active && elapsed
}

/** How long a load runs before its skeleton is drawn. Shared so every page appears at the same beat. */
export const SKELETON_DELAY_MS = 250
