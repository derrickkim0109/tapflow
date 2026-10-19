import { cn } from '@/lib/utils'

/**
 * A field's validation message, in a slot that is always mounted and takes no space until it has
 * something to say.
 *
 * **Always mounted, because an announcement needs a region that was already being watched.** A live
 * region created together with its text is the case assistive technology supports worst, and for the
 * form-level message there is no second channel: no field owns `errors.root` and focus never moves
 * to it, so a missed announcement is a sign-in that failed for no stated reason.
 *
 * **Out of flow while empty, so the form at rest looks as it did before any of this.** A reserved
 * line under every field reads as a gap somebody forgot to close. `absolute` rather than `hidden`:
 * `display: none` takes the element out of the accessibility tree too, which would undo the reason
 * it is mounted early.
 *
 * **A description per field, an alert for the form.** A field's message is its input's
 * `aria-describedby` target and nothing more — read when focus reaches the field, which `FormErrorCount`
 * moves to the first invalid one on submit, after the render that describes it (react-hook-form's own
 * focus arrives before the error does, which is why every form here turns it off). It used to be a polite live region as well, and that read the
 * focused field's message twice (#824). What the live region covered is now `FormErrorCount`'s: it
 * announces how many fields need attention, led by the message of a field that already had focus (Enter
 * pressed in it), since no focus event will read that one. `assertive` belongs only to `errors.root`: no field owns it and focus never moves to it, so the
 * alert is its only channel.
 *
 * **Callers gate on `?.message`, never on the error object.** An error with no message would
 * otherwise leave `aria-invalid="true"` pointing at an empty slot. Nothing produces one today —
 * every `setError` call in this package passes a message and every zod rule has a default — which is
 * why this is a sentence rather than a guard.
 */
export function FieldError({
  id,
  message,
  className,
  assertive,
}: {
  id: string
  message?: string
  className?: string
  assertive?: boolean
}) {
  return (
    <p
      id={id}
      {...(assertive ? { role: 'alert' as const } : {})}
      className={cn('text-sm text-destructive', !message && 'absolute', className)}
    >
      {message ?? ''}
    </p>
  )
}
