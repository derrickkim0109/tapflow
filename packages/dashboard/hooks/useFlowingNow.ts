import { useEffect, useState } from 'react'

/** `Date.now()`, re-read every `intervalMs` while `active`.
 *
 *  Re-read immediately whenever it resumes or the interval changes, rather than on the next tick: a tab
 *  brought back after an hour, or a switch from 7d to 1h, should show the window as it is now and not as it
 *  was up to a minute ago. */
export function useFlowingNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    // Synchronising with the clock, which is what an effect is for, and it cannot move to render: reading
    // `Date.now()` there is impure. For the triggers that matter — a tab brought back, a range picked —
    // React flushes this effect before paint, so the old window is never drawn. A 0 ms timer would quiet
    // the rule and draw one frame of it: the thing #751 fixed.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a timer sync; see above
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, active])
  return now
}
