/**
 * The password rule, and the sentence that states it, for this package. Kept together so the hint shown
 * before a submit cannot drift from the schemas that refuse one — a hint that names the wrong length is
 * worse than none (#823). It **mirrors** the relay's rule rather than sharing it: the relay checks
 * `password.length < 8` itself (`packages/relay/src/lib/adminAccount.ts` and four endpoints), so a change
 * there has to be made here too.
 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_HINT = `Use at least ${PASSWORD_MIN_LENGTH} characters`
export const PASSWORD_TOO_SHORT = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`

/**
 * `aria-describedby` for a field whose hint the error **replaces**: one line under the field, grey until a
 * submit is refused and then the error in its place. Composing both read the rule twice and stacked two
 * lines saying the same thing, so the error carries the rule itself (`PASSWORD_TOO_SHORT`) and the hint
 * steps aside — the field renders `FieldHint` only while it has no error.
 */
export function describedBy(hintId: string, errorId: string, hasError: boolean): string {
  return hasError ? errorId : hintId
}
