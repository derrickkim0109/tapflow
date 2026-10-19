import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cmdTokenSet, cmdTokenStatus, tokenRelayUrl, type TokenDeps } from '../../commands/token.js'

// `tapflow token set` / `status` (T1 B). What these must never do: store a token the relay refuses, store it where
// the clients will not look, or print it.

const TOKEN = `tflw_pat_${'a'.repeat(64)}`
const OTHER = `tflw_pat_${'b'.repeat(64)}`

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-token-cmd-'))
  file = path.join(dir, 'credentials.json')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function deps(over: Partial<TokenDeps> & { answer?: (url: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  const lines: string[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    (over.answer ?? (() => Response.json({ items: [] })))(String(url), init))
  const d: TokenDeps = {
    fetch: fetchMock as typeof fetch,
    env: { TAPFLOW_TOKEN_FILE: file },
    readStdinLine: async () => TOKEN,
    stdinIsTTY: false,
    interactive: false,
    prompt: vi.fn(async () => TOKEN),
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    ...over,
  }
  return { d, lines, fetchMock, text: () => lines.join('\n') }
}

describe('tapflow token set', () => {
  it('reads the token from stdin, checks it with the relay, and stores it for that relay', async () => {
    const { d, fetchMock, text } = deps()
    expect(await cmdTokenSet({}, d)).toBe(0)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:4000/api/v1/apps')
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    // A followed cross-origin redirect drops Authorization, and its 401 would blame the token.
    expect(fetchMock.mock.calls[0]![1]!.redirect).toBe('manual')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, relays: { 'http://localhost:4000': { token: TOKEN } } })
    expect(text()).toContain('Stored a token for http://localhost:4000')
    expect(text()).toContain('builds:write, which is not checked')
    expect(text()).not.toContain(TOKEN)
  })

  it('stores for the relay the clients use: --relay, else TAPFLOW_RELAY_URL, else ws://localhost:4000 — never relay.url', async () => {
    expect(tokenRelayUrl({ relay: 'wss://a.example.test' }, { TAPFLOW_RELAY_URL: 'wss://b.example.test' })).toBe('wss://a.example.test')
    expect(tokenRelayUrl({}, { TAPFLOW_RELAY_URL: 'wss://b.example.test' })).toBe('wss://b.example.test')
    expect(tokenRelayUrl({}, {})).toBe('ws://localhost:4000')
    const { d, text } = deps({ configuredRelayUrl: 'wss://team.example.test' })
    await cmdTokenSet({}, d)
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).relays)).toEqual(['http://localhost:4000'])
    expect(text()).toContain('relay.url here is https://team.example.test; if your clients connect there, run this again with --relay https://team.example.test')
  })

  it('prompts, hidden, only with a terminal on both ends', async () => {
    const tty = deps({ stdinIsTTY: true, interactive: true })
    expect(await cmdTokenSet({}, tty.d)).toBe(0)
    expect(tty.d.prompt).toHaveBeenCalled()
    const redirected = deps({ stdinIsTTY: true, interactive: false })
    expect(await cmdTokenSet({}, redirected.d)).toBe(1)
    expect(redirected.d.prompt).not.toHaveBeenCalled()
    expect(redirected.text()).toContain('Pipe the token on stdin')
  })

  it.each([
    ['nothing', null, 'No token given'],
    ['an empty line', '   ', 'No token given'],
    ['something that is not a PAT', 'eyJhbGciOiJIUzI1NiJ9.cookie', 'not a tapflow personal access token'],
  ])('refuses %s before asking the relay', async (_name, input, says) => {
    const { d, fetchMock, text } = deps({ readStdinLine: async () => input })
    expect(await cmdTokenSet({}, d)).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(text()).toContain(says)
    expect(fs.existsSync(file)).toBe(false)
  })

  it.each([
    ['a token the relay does not know', () => new Response('{}', { status: 401 }), 'did not accept it'],
    ['a token without the view scope', () => new Response('{}', { status: 403 }), 'lacks the view scope'],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/' } }), 'redirect to https://elsewhere.example.test/'],
    ['an unreachable relay', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, 'could not reach the relay at http://localhost:4000 (ECONNREFUSED)'],
  ])('stores nothing for %s, and says why', async (_name, answer, says) => {
    const { d, text } = deps({ answer })
    expect(await cmdTokenSet({}, d)).toBe(1)
    expect(text()).toContain(says)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('keeps the file as it was when it cannot be written safely', async () => {
    fs.writeFileSync(file, '{ broken')
    const { d, text } = deps()
    expect(await cmdTokenSet({}, d)).toBe(1)
    expect(text()).toContain('is not valid JSON')
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken')
  })

  it('names TAPFLOW_RELAY_URL, not --relay, when that is the bad address', async () => {
    const { d, text } = deps({ env: { TAPFLOW_TOKEN_FILE: file, TAPFLOW_RELAY_URL: 'localhost:4000' } })
    expect(await cmdTokenSet({}, d)).toBe(1)
    expect(text()).toContain('TAPFLOW_RELAY_URL is not a relay URL')
  })

  it('takes only the first line of stdin, trimmed', async () => {
    const { d } = deps({ readStdinLine: async () => `${TOKEN}\r` })
    expect(await cmdTokenSet({}, d)).toBe(0)
  })
})

describe('tapflow token status', () => {
  it('checks each stored token against its own relay, marks the current one, and never prints a token', async () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, relays: { 'http://localhost:4000': { token: TOKEN }, 'https://team.example.test': { token: OTHER } } }))
    const { d, fetchMock, text } = deps({
      env: { TAPFLOW_TOKEN_FILE: file, TAPFLOW_TOKEN: 'x' },
      answer: (url) => (url.startsWith('https://team') ? new Response('{}', { status: 401 }) : Response.json({})),
    })
    expect(await cmdTokenStatus({}, d)).toBe(0)
    const sent = fetchMock.mock.calls.map(([u, init]) => [new URL(String(u)).origin, (init!.headers as Record<string, string>).Authorization])
    expect(sent).toEqual([['http://localhost:4000', `Bearer ${TOKEN}`], ['https://team.example.test', `Bearer ${OTHER}`]])
    expect(text()).toMatch(/✓.*http:\/\/localhost:4000 ← current/)
    expect(text()).toMatch(/✗.*https:\/\/team\.example\.test — the relay at https:\/\/team\.example\.test did not accept it/)
    expect(text()).toContain('TAPFLOW_TOKEN is set in this shell')
    expect(text()).not.toContain(TOKEN)
    expect(text()).not.toContain(OTHER)
  })

  it('does not send a stored value that is not a token, and says what is wrong with it', async () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, relays: { 'http://localhost:4000': { token: 'hand-edited' } } }))
    const { d, fetchMock, text } = deps()
    await cmdTokenStatus({}, d)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(text()).toContain('the stored value is not a tapflow personal access token')
  })

  it('says when the current relay address is not one', async () => {
    const { d, text } = deps({ env: { TAPFLOW_TOKEN_FILE: file, TAPFLOW_RELAY_URL: 'localhost:4000' } })
    await cmdTokenStatus({}, d)
    expect(text()).toContain('TAPFLOW_RELAY_URL is not a relay URL')
  })

  it('says when there is no file, and when the current relay has no token', async () => {
    const none = deps()
    await cmdTokenStatus({}, none.d)
    expect(none.text()).toContain('No tokens stored')
    fs.writeFileSync(file, JSON.stringify({ version: 1, relays: { 'https://team.example.test': { token: OTHER } } }))
    const other = deps()
    await cmdTokenStatus({}, other.d)
    expect(other.text()).toContain('No token stored for the current relay, http://localhost:4000')
  })
})
