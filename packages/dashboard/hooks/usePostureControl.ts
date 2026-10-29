import type { BrowserToRelay } from '@tapflowio/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { remaining } from '@/lib/coordinate-transform'
import type { PosturesPayload } from '@/lib/types'

/**
 * The fold control's half that sends and waits — shared by both viewers, because a foldable is one
 * idea on both platforms (`PosturableCapability`) and the hold below took two fixes to get right.
 *
 * A fold takes a moment — the device changes panel and the stream follows — and without a sign of it
 * the button reads as not having registered the press.
 */
export function usePostureControl(
  send: (msg: BrowserToRelay) => void,
  sessionId: string,
  postures: PosturesPayload | undefined,
): { pending: boolean; folding: FoldDirection | null; select: (postureId: string) => void } {
  // The posture we asked for, or null when nothing is in flight. Holding the *target* rather than
  // a boolean is what lets the release wait for the device to actually arrive there — a plain flag
  // could only be released on a timer, and a timer that starts at the request expires long before
  // the fold finishes.
  const [pendingPosture, setPendingPosture] = useState<string | null>(null)
  // The stop's deadline, fixed when the press happens. **A report that does not match cannot be
  // allowed to move it**: `postures` is a fresh object per message, so re-running this effect
  // re-armed a whole new 8s from whenever the report arrived — and the agent sends one on the
  // failure path precisely so a change that did not happen ends. That made it end later.
  const postureDeadline = useRef(0)
  // Which way the change in flight goes, fixed at the press like the deadline.
  const [folding, setFolding] = useState<FoldDirection | null>(null)
  const select = useCallback((postureId: string) => {
    postureDeadline.current = Date.now() + 8_000
    setPendingPosture(postureId)
    setFolding(foldDirection(postures, postureId))
    send({ type: 'input:posture', sessionId, payload: { postureId } })
  }, [send, sessionId, postures])
  // **Released a beat after the device answers, not the instant it does.** `device:postures` and
  // `session:chrome` are separate messages on separate paths, and the posture one usually wins —
  // so releasing on it alone brings the picture back while the viewer still holds the previous
  // screen's dimensions, which is the flash again. The beat lets the chrome land.
  //
  // The timer also runs when no answer arrives, so a posture change that fails silently ends with
  // a visible screen rather than a permanent placeholder.
  useEffect(() => {
    if (pendingPosture === null) return
    // Released as soon as the device reports the posture that was asked for, with a long stop for a
    // change that never lands.
    const arrived = postures?.currentId === pendingPosture
    const t = setTimeout(
      () => setPendingPosture(null),
      arrived ? 0 : remaining(postureDeadline.current, Date.now()),
    )
    return () => clearTimeout(t)
  }, [pendingPosture, postures])
  return { pending: pendingPosture !== null, folding: pendingPosture === null ? null : folding, select }
}

export type FoldDirection = 'fold' | 'unfold'

/**
 * Whether moving to `target` closes the device or opens it — from the list's order, which the protocol fixes
 * as most closed first, so the ids themselves stay opaque. Null when the target is not in the list, or is
 * where the device already is.
 *
 * **A current posture nobody has reported reads the way the toolbar reads it**: moving to the most closed
 * posture folds, anything else unfolds. The toolbar offers the control then too, and a first version that
 * answered null here played nothing for a press the toolbar had taken.
 */
export function foldDirection(postures: PosturesPayload | undefined, target: string): FoldDirection | null {
  const ids = postures?.postures.map((p) => p.id) ?? []
  const from = postures?.currentId ? ids.indexOf(postures.currentId) : -1
  const to = ids.indexOf(target)
  if (to < 0 || from === to) return null
  if (from < 0) return to === 0 ? 'fold' : 'unfold'
  return to < from ? 'fold' : 'unfold'
}
