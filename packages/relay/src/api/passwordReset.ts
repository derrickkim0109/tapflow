import http from 'http'
import crypto from 'crypto'
import { createLogger } from '@tapflowio/agent-core'
import { getDb } from '../db.js'
import { requireRole } from '../middleware/auth.js'
import { makePasswordHash } from './auth.js'
import { sendMail } from '../lib/mailer.js'
import { json, readJson } from '../router.js'
import type { AuthChange } from '../lib/connectionAuth.js'
import { config, type TapflowConfig } from '../lib/config.js'
import { buildInviteBaseUrl, forTeammates, resolvePublicBaseUrl, type TunnelRuntime } from '../lib/publicUrl.js'
import { SYNTHETIC_EMAIL_DOMAIN } from '../lib/email.js'

const logger = createLogger('relay:password-reset')
const INSECURE_RESET_LINK_WARNING =
  'Password-reset email uses insecure HTTP. Reset tokens may be exposed in transit; configure HTTPS with tunnel.publicUrl or relay.url.'
let warnedInsecureResetLink = false

export function buildPasswordResetUrl(
  token: string,
  cfg: Pick<TapflowConfig, 'tunnel' | 'relay' | 'local'>,
  tunnel?: TunnelRuntime,
): string {
  return `${buildInviteBaseUrl(cfg, tunnel)}/reset-password?token=${token}`
}

export function passwordResetLinkWarning(url: string): string | null {
  return /^https:\/\//i.test(url) ? null : INSECURE_RESET_LINK_WARNING
}

/**
 * Issues a reset link for a member and mails it when mail can reach them. Returns the token either way:
 * the Admin who asked also gets the link, as with an invitation, so an install without SMTP can still
 * reset a password.
 *
 * Only the newest link works. The earlier unused ones are spent here, so a link sent to the wrong place
 * is dead as soon as the Admin makes another.
 */
export async function issuePasswordReset(
  userId: number,
  tunnel?: TunnelRuntime,
): Promise<{ token: string; emailSent: boolean } | null> {
  const db = getDb()
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as { id: number; email: string } | undefined
  if (!user) return null

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

  db.transaction(() => {
    db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(userId)
    db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt)
  })()

  // A member invited without an email has a made-up `@tapflow.local` address. An SMTP server may well
  // accept mail for it, which would report "sent" for a message nobody can receive.
  if (user.email.endsWith(SYNTHETIC_EMAIL_DOMAIN)) return { token, emailSent: false }

  const link = buildPasswordResetUrl(token, config, tunnel)
  const warning = passwordResetLinkWarning(link)
  if (warning !== null && !warnedInsecureResetLink) {
    logger.warn(warning)
    warnedInsecureResetLink = true
  }
  const html = `<p>A password reset was requested for your tapflow account.</p>
<p><a href="${link}">Reset your password</a></p>
<p>This link expires in 2 hours. If you did not request this, ignore this email.</p>`

  return { token, emailSent: await sendMail(user.email, 'Reset your tapflow password', html) }
}

export function handleVerifyReset(req: http.IncomingMessage, res: http.ServerResponse): void {
  const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token')
  if (!token) return json(res, 400, { error: 'token required' })

  const db = getDb()
  const row = db.prepare(`
    SELECT id FROM password_reset_tokens
    WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
  `).get(token) as { id: number } | undefined

  if (!row) return json(res, 410, { error: 'Token expired or not found' })
  json(res, 200, { ok: true })
}

export async function handleDoReset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  onAuthChanged: (affected?: AuthChange) => void = () => {},
): Promise<void> {
  const body = await readJson<{ token: string; password: string }>(req)
  if (!body.token || !body.password) return json(res, 400, { error: 'token and password required' })
  if (body.password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' })

  const db = getDb()
  const row = db.prepare(`
    SELECT id, user_id FROM password_reset_tokens
    WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
  `).get(body.token) as { id: number; user_id: number } | undefined

  if (!row) return json(res, 410, { error: 'Token expired or not found' })

  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(makePasswordHash(body.password), row.user_id)
    // Every outstanding link for this user, not only the one used: the password they unlock is gone.
    db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(row.user_id)
    // A reset is how an account is recovered, and whoever held it may have minted tokens that a new
    // password alone would leave working. So a reset revokes all of them, CI and agent tokens included;
    // the owner issues new ones. A self-service change does not: it needs the current password, and
    // revoking there would break the owner's own CI without warning.
    db.prepare('DELETE FROM personal_access_tokens WHERE user_id = ?').run(row.user_id)
  })()
  // The new hash has already ended the user's sessions (`passwordVersion`) and the tokens are gone;
  // this closes their open sockets, token-authenticated agents included, now rather than on the next
  // heartbeat.
  onAuthChanged({ userId: row.user_id })

  json(res, 200, { ok: true })
}

export async function handleSendMemberReset(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  tunnel?: TunnelRuntime,
): Promise<void> {
  const auth = requireRole(req, res, ['Admin'])
  if (!auth) return

  const db = getDb()
  const member = db.prepare('SELECT id FROM users WHERE id = ?').get(params.id) as { id: number } | undefined
  if (!member) return json(res, 404, { error: 'Member not found' })

  const issued = await issuePasswordReset(member.id, tunnel)
  if (!issued) return json(res, 404, { error: 'Member not found' })

  // The same rule as an invitation's `inviteUrl` (#788): null when the only address is a loopback one,
  // and the dashboard builds the link from the browser's origin with `token` instead.
  const resetUrl = forTeammates(resolvePublicBaseUrl(config, tunnel)) === null
    ? null
    : buildPasswordResetUrl(issued.token, config, tunnel)
  json(res, 200, { ok: true, emailSent: issued.emailSent, token: issued.token, resetUrl })
}
