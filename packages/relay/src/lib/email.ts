/**
 * The form an email address is stored and compared in: surrounding spaces removed, ASCII letters
 * lowercased.
 *
 * **Deliberately the same function as SQLite's `lower(trim(x))`**, not JavaScript's `trim()` and
 * `toLowerCase()`. SQLite's `lower` folds ASCII only and its `trim` removes spaces only, and migration
 * 014 normalizes the rows already stored with those. Were this function wider, an address with a
 * non-ASCII capital or a tab would be rewritten one way by the migration and looked up another way
 * here, and could never sign in again. `EMAIL_KEY_SQL` is the column side of the same comparison.
 */
export function normalizeEmail(email: string): string {
  return email.replace(/^ +| +$/g, '').replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/** `users.email` / `invitations.email` in normalized form, for comparing with `normalizeEmail(input)`. */
export const EMAIL_KEY_SQL = 'lower(trim(email))'

/** The domain of the placeholder address a member invited without an email is given. Mail to it reaches nobody. */
export const SYNTHETIC_EMAIL_DOMAIN = '@tapflow.local'
