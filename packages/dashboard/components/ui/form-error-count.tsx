import { useEffect, useRef, useState } from 'react'

/** How many fields a refused submit left invalid. `root` is the relay's refusal, not a field. */
export function invalidFieldCount(errors: object): number {
  return Object.entries(errors).filter(([key, error]) =>
    key !== 'root' && typeof (error as { message?: unknown } | undefined)?.message === 'string').length
}

const sentence = (count: number) => (count === 1 ? '1 field needs attention' : `${count} fields need attention`)

/** Long enough that the emptied region is a change of its own before the count arrives (W3C ARIA19). */
const REFILL_DELAY_MS = 100

/**
 * Moves focus to the first invalid field, now that it is described, and returns what still has to be
 * said. When that field already has focus — Enter pressed in it — focusing it again fires nothing, so its
 * error is returned for the live region to say instead. **Not blur-then-focus**: a screen reader may see
 * no change when focus ends where it started, and on a phone the blur drops the on-screen keyboard, which
 * a programmatic focus outside a gesture does not bring back.
 */
function focusFirstInvalid(inside: HTMLElement | null): string {
  const target = inside?.closest('form')?.querySelector<HTMLElement>('[aria-invalid="true"]')
  if (!target) return ''
  if (target !== document.activeElement) {
    target.focus()
    return ''
  }
  const id = target.getAttribute('aria-describedby')?.split(' ')[0]
  return (id && document.getElementById(id)?.textContent?.trim()) || ''
}

/** The error the focus could not read, then the count, as one announcement. */
function announcement(unread: string, count: number): string {
  if (!unread) return sentence(count)
  return `${/[.!?]$/.test(unread) ? unread : `${unread}.`} ${sentence(count)}`
}

/**
 * What a screen reader hears when a submit is refused for invalid fields, and where focus goes (#824).
 *
 * **Every form that renders one sets `shouldFocusError: false`.** react-hook-form focuses the first invalid
 * field *before* it publishes the errors, so focus arrived at an input with no description yet, and its
 * retry re-focuses an element that already has focus, which fires nothing. While each field's error was a
 * live region that did not matter; as a description only it read the error zero times. So focus is moved
 * here, after the render that describes the field, and the error is read once — by the focus.
 *
 * **The count is the only live part, and it says how many, not which** — saying the messages here too
 * would read the focused one twice. It covers the fields focus never reaches. The one exception is the
 * field that already had focus, whose error no focus event will read: that message leads the count. Emptied on each refusal and
 * refilled a moment later, so a second refusal with the same count is still a change to announce.
 *
 * **`aria-live`, not `role="status"`**: Team and Tokens already put a `role="status"` region in their
 * dialogs, and a second one would make `getByRole('status')` ambiguous there.
 *
 * **Visible to nobody else**: the fields show their errors already, so `sr-only` changes nothing on
 * screen. Set per submit rather than following `errors` as fields are fixed, so it does not count down
 * over someone typing — but emptied once nothing is invalid, because a form that calls `reset()` on
 * success takes the submit count back to the value it had at the refusal.
 */
export function FormErrorCount({ errors, submitCount }: { errors: object; submitCount: number }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const count = invalidFieldCount(errors)
  const [seen, setSeen] = useState(submitCount)
  const [text, setText] = useState('')
  // The count a refusal is still to announce, keyed by the submit it belongs to.
  const [pending, setPending] = useState<{ submit: number; count: number } | null>(null)

  if (seen !== submitCount) {
    setSeen(submitCount)
    setText('')
    setPending(count > 0 ? { submit: submitCount, count } : null)
  } else if (count === 0 && (text !== '' || pending !== null)) {
    setText('')
    setPending(null)
  }

  useEffect(() => {
    if (pending === null) return
    const unread = focusFirstInvalid(ref.current)
    const timer = setTimeout(() => {
      setText(announcement(unread, pending.count))
      setPending(null)
    }, REFILL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pending])

  return <p ref={ref} aria-live="polite" className="sr-only">{text}</p>
}
