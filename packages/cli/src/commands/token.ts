import readline from 'readline'
import { password, isCancel } from '@clack/prompts'
import { config } from '@tapflowio/relay'
import {
  CredentialFileError, PAT_PATTERN, credentialsPath, listCredentials, originOf, readCredential, writeCredential,
} from '@tapflowio/flow-runner'
import { isInteractive } from '../lib/interactive.js'
import { DIM, GREEN, R, RED, YELLOW } from '../lib/print.js'

/**
 * `tapflow token set` / `tapflow token status` (T1 B): store the token the MCP server and `tapflow flow run` read from
 * the credentials file, and say which relays have one that still works.
 *
 * **The relay is the clients' own default, not `relay.url`.** The MCP server reads `TAPFLOW_RELAY_URL` and falls
 * back to ws://localhost:4000; `flow run` takes `--relay` and the same fallback. `relay.url` is the relay host's
 * public address for teammates — storing under it would succeed here and be found by neither client.
 */
export interface TokenDeps {
  fetch: typeof fetch
  env: NodeJS.ProcessEnv
  /** The first line on stdin, or null at end of input. */
  readStdinLine: () => Promise<string | null>
  stdinIsTTY: boolean
  interactive: boolean
  /** A hidden prompt; null when cancelled. */
  prompt: () => Promise<string | null>
  out: (line: string) => void
  err: (line: string) => void
  /** `relay.url`, for a hint when it is not where the token went. */
  configuredRelayUrl?: string
}

export function defaultTokenDeps(): TokenDeps {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    readStdinLine: () => new Promise((resolve) => {
      // The first line only: a pipe that never closes (docker -i, ssh) would otherwise hold the command forever.
      const rl = readline.createInterface({ input: process.stdin })
      let done = false
      // close() only pauses stdin; an open pipe would still hold the process after the token is stored.
      rl.once('line', (line) => { done = true; rl.close(); process.stdin.destroy(); resolve(line) })
      rl.once('close', () => { if (!done) resolve(null) })
    }),
    stdinIsTTY: process.stdin.isTTY === true,
    interactive: isInteractive(),
    prompt: async () => {
      const value = await password({ message: 'Personal access token (input is hidden)' })
      return isCancel(value) ? null : value
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    configuredRelayUrl: config.relay.url ?? undefined,
  }
}

export function tokenRelayUrl(opts: { relay?: string }, env: NodeJS.ProcessEnv): string {
  return opts.relay ?? (env['TAPFLOW_RELAY_URL'] || 'ws://localhost:4000')
}

/** What the relay says about a token, by one `view` call — the same check the MCP server makes at start. */
type Check =
  | { ok: true }
  | { ok: false; reason: string }

async function checkToken(fetchImpl: typeof fetch, origin: string, token: string): Promise<Check> {
  let res: Response
  try {
    // Not following redirects: a cross-origin one drops Authorization, and its 401 would blame the token.
    res = await fetchImpl(new URL('/api/v1/apps', origin).toString(), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause
    return { ok: false, reason: `could not reach the relay at ${origin} (${cause?.code ?? cause?.message ?? (e as Error).message})` }
  }
  await res.body?.cancel().catch(() => {})
  if (res.ok) return { ok: true }
  if (res.status === 401) return { ok: false, reason: `the relay at ${origin} did not accept it (unknown on this relay, revoked or expired)` }
  if (res.status === 403) return { ok: false, reason: 'it lacks the view scope, which screenshots and the UI tree need: create an API-type token' }
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location')
    return { ok: false, reason: `the relay at ${origin} answered with a redirect${to ? ` to ${to}` : ''}: pass the address it redirects to with --relay` }
  }
  return { ok: false, reason: `the relay at ${origin} answered ${res.status}` }
}

async function readToken(deps: TokenDeps): Promise<string | null> {
  if (!deps.stdinIsTTY) {
    deps.err(`${DIM}Reading the token from stdin…${R}`)
    return deps.readStdinLine()
  }
  if (!deps.interactive) {
    deps.err(`${RED}✗${R} No terminal to prompt in. Pipe the token on stdin: ${DIM}echo "$TOKEN" | tapflow token set${R}`)
    return null
  }
  return deps.prompt()
}

export async function cmdTokenSet(opts: { relay?: string }, deps: TokenDeps = defaultTokenDeps()): Promise<number> {
  const relayUrl = tokenRelayUrl(opts, deps.env)
  const origin = safeOrigin(relayUrl)
  if (!origin) {
    deps.err(`${RED}✗${R} ${opts.relay ? '--relay' : 'TAPFLOW_RELAY_URL'} is not a relay URL (${JSON.stringify(relayUrl)}) — use e.g. ws://localhost:4000`)
    return 1
  }
  const token = (await readToken(deps))?.trim() ?? ''
  if (!token) {
    deps.err(`${RED}✗${R} No token given; nothing stored.`)
    return 1
  }
  // Before the network: a pasted cookie or agent id would otherwise come back as "unknown on this relay".
  if (!PAT_PATTERN.test(token)) {
    deps.err(`${RED}✗${R} That is not a tapflow personal access token (they start with tflw_pat_). Nothing stored.`)
    return 1
  }
  const check = await checkToken(deps.fetch, origin, token)
  if (!check.ok) {
    deps.err(`${RED}✗${R} Not stored: ${check.reason}.`)
    return 1
  }
  const file = credentialsPath(deps.env)
  try {
    writeCredential(file, relayUrl, token)
  } catch (e) {
    if (e instanceof CredentialFileError) { deps.err(`${RED}✗${R} ${e.message}.`); return 1 }
    throw e
  }
  deps.out(`${GREEN}✓${R} Stored a token for ${origin} in ${file}.`)
  deps.out(`  The MCP server and \`tapflow flow run\` use it when their relay is ${origin} (the MCP server's TAPFLOW_RELAY_URL; flow run's --relay).`)
  deps.out(`  ${DIM}Checked for the view scope. Recording runs also needs builds:write, which is not checked here.${R}`)
  if (deps.env['TAPFLOW_TOKEN']) deps.out(`  ${YELLOW}TAPFLOW_TOKEN is set in this shell, and a client that has it uses it instead of this file.${R}`)
  const configured = safeOrigin(deps.configuredRelayUrl)
  if (configured && configured !== origin && !opts.relay) {
    deps.out(`  ${DIM}relay.url here is ${configured}; if your clients connect there, run this again with --relay ${configured}.${R}`)
  }
  return 0
}

export async function cmdTokenStatus(opts: { relay?: string }, deps: TokenDeps = defaultTokenDeps()): Promise<number> {
  const file = credentialsPath(deps.env)
  const current = safeOrigin(tokenRelayUrl(opts, deps.env))
  if (!current) deps.out(`${YELLOW}${opts.relay ? '--relay' : 'TAPFLOW_RELAY_URL'} is not a relay URL (${JSON.stringify(tokenRelayUrl(opts, deps.env))}), so no relay is marked current.${R}`)
  const origins = listCredentials(file)
  if (deps.env['TAPFLOW_TOKEN']) deps.out(`${YELLOW}TAPFLOW_TOKEN is set in this shell; a client that has it uses it instead of the file.${R}`)
  if (origins.length === 0) {
    deps.out(`No tokens stored in ${file}. Store one with \`tapflow token set\`.`)
    return 0
  }
  deps.out(`Tokens in ${file}:`)
  for (const origin of origins) {
    const token = readCredential(file, origin).token
    const mark = origin === current ? ' ← current' : ''
    // A hand-edited value is not sent: the relay's answer would blame the token's validity, not its shape.
    if (!PAT_PATTERN.test(token)) {
      deps.out(`  ${RED}✗${R} ${origin}${mark} — the stored value is not a tapflow personal access token`)
      continue
    }
    // Each token goes to its own relay only.
    const check = await checkToken(deps.fetch, origin, token)
    deps.out(check.ok ? `  ${GREEN}✓${R} ${origin}${mark}` : `  ${RED}✗${R} ${origin}${mark} — ${check.reason}`)
  }
  if (current && !origins.includes(current)) {
    deps.out(`No token stored for the current relay, ${current}. Store one with \`tapflow token set${opts.relay ? ` --relay ${current}` : ''}\`.`)
  }
  return 0
}

/**
 * The origin a relay URL keys the file by, or null when it is not a relay address. Stricter than `originOf`, which
 * reads `localhost:4000` as a URL with the scheme `localhost:` and returns `http://` — a key nothing would match.
 */
function safeOrigin(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol) || !u.hostname) return null
    return originOf(url)
  } catch {
    return null
  }
}
