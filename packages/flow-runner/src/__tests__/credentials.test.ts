import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CredentialFileError, credentialsPath, fetchWithToken, listCredentials, originOf, readCredential, resolveToken, tokenRefusal, writeCredential } from '../credentials'

// Where a client's token comes from, and how a rotated one reaches a running process (T1). The case behind it: an
// MCP server registered with a token minted on another relay, and the only fix was to re-register it.

let dir: string
let file: string
const write = (relays: Record<string, string>, mode = 0o600) => {
  fs.writeFileSync(file, JSON.stringify({ version: 1, relays: Object.fromEntries(Object.entries(relays).map(([o, token]) => [o, { token }])) }))
  fs.chmodSync(file, mode)
}
const env = (extra: Record<string, string> = {}) => ({ TAPFLOW_TOKEN_FILE: file, ...extra })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-cred-'))
  file = path.join(dir, 'credentials.json')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('originOf', () => {
  it('keys the socket URL and the REST base alike, and folds loopback hosts on one port into one', () => {
    expect(originOf('ws://localhost:4000')).toBe('http://localhost:4000')
    expect(originOf('http://127.0.0.1:4000/')).toBe('http://localhost:4000')
    expect(originOf('ws://[::1]:4000')).toBe('http://localhost:4000')
    expect(originOf('wss://relay.example.ts.net/some/path')).toBe('https://relay.example.ts.net')
    expect(originOf('https://relay.example.test:443')).toBe('https://relay.example.test')
    expect(originOf('ws://relay.example.test:4001')).toBe('http://relay.example.test:4001')
    expect(originOf('ws://localhost:4001')).not.toBe(originOf('ws://localhost:4000'))
  })
})

describe('credentialsPath', () => {
  it('takes TAPFLOW_TOKEN_FILE, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(credentialsPath({ TAPFLOW_TOKEN_FILE: '/x/c.json', XDG_CONFIG_HOME: '/y' })).toBe('/x/c.json')
    expect(credentialsPath({ XDG_CONFIG_HOME: '/y' })).toBe(path.join('/y', 'tapflow', 'credentials.json'))
    expect(credentialsPath({})).toBe(path.join(os.homedir(), '.config', 'tapflow', 'credentials.json'))
  })
})

describe('resolveToken', () => {
  it('takes the flag, then a non-empty TAPFLOW_TOKEN, then the file for this relay', () => {
    write({ 'http://localhost:4000': 'tflw_pat_file' })
    const relayUrl = 'ws://localhost:4000'
    expect(resolveToken({ relayUrl, explicit: 'tflw_pat_flag', env: env({ TAPFLOW_TOKEN: 'tflw_pat_env' }) })).toMatchObject({ token: 'tflw_pat_flag', from: 'flag' })
    expect(resolveToken({ relayUrl, env: env({ TAPFLOW_TOKEN: 'tflw_pat_env' }) })).toMatchObject({ token: 'tflw_pat_env', from: 'env' })
    // An empty TAPFLOW_TOKEN in an MCP registration must not hide the file.
    expect(resolveToken({ relayUrl, env: env({ TAPFLOW_TOKEN: '' }) })).toMatchObject({ token: 'tflw_pat_file', from: 'file' })
    expect(resolveToken({ relayUrl: 'ws://other.example.test', env: env() })).toMatchObject({ token: '', from: 'none' })
  })

  it('finds a token stored under 127.0.0.1 when asked for localhost, and one written as a socket URL', () => {
    write({ 'ws://127.0.0.1:4000/': 'tflw_pat_a', 'wss://team.example.test': 'tflw_pat_b' })
    expect(resolveToken({ relayUrl: 'ws://localhost:4000', env: env() }).token).toBe('tflw_pat_a')
    expect(resolveToken({ relayUrl: 'https://team.example.test', env: env() }).token).toBe('tflw_pat_b')
  })

  it('re-reads the file on refresh, and never replaces an explicit token', () => {
    write({ 'http://localhost:4000': 'tflw_pat_old' })
    const fromFile = resolveToken({ relayUrl: 'ws://localhost:4000', env: env() })
    const fromEnv = resolveToken({ relayUrl: 'ws://localhost:4000', env: env({ TAPFLOW_TOKEN: 'tflw_pat_env' }) })
    write({ 'http://localhost:4000': 'tflw_pat_new' })
    fromFile.refresh()
    fromEnv.refresh()
    expect(fromFile.token).toBe('tflw_pat_new')
    expect(fromEnv.token).toBe('tflw_pat_env')
  })

  it('warns about a file others can read, and one that is not JSON, and reads no token from the latter', () => {
    const warn = vi.fn()
    write({ 'http://localhost:4000': 'tflw_pat_x' }, 0o644)
    expect(resolveToken({ relayUrl: 'ws://localhost:4000', env: env(), warn }).token).toBe('tflw_pat_x')
    if (process.platform !== 'win32') expect(warn.mock.calls[0]![0]).toContain('chmod 600')
    warn.mockClear()
    fs.writeFileSync(file, '{ not json')
    fs.chmodSync(file, 0o600)
    expect(resolveToken({ relayUrl: 'ws://localhost:4000', env: env(), warn }).token).toBe('')
    expect(warn.mock.calls.map(([l]) => l)).toEqual([expect.stringContaining('not valid JSON')])
  })
})

describe('fetchWithToken', () => {
  const answer = (status: number) => new Response('{}', { status })

  it('retries a 401 once with the token the file now holds', async () => {
    write({ 'http://localhost:4000': 'tflw_pat_old' })
    const source = resolveToken({ relayUrl: 'ws://localhost:4000', env: env() })
    const sent: string[] = []
    const fetchMock = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const auth = (init!.headers as Record<string, string>).Authorization!
      sent.push(auth)
      if (auth.endsWith('old')) { write({ 'http://localhost:4000': 'tflw_pat_new' }); return answer(401) }
      return answer(200)
    })
    const res = await fetchWithToken(source, 'http://localhost:4000/api/v1/apps', { headers: { 'X-A': '1' } }, fetchMock as typeof fetch)
    expect(res.status).toBe(200)
    expect(sent).toEqual(['Bearer tflw_pat_old', 'Bearer tflw_pat_new'])
    expect((fetchMock.mock.calls[1]![1]!.headers as Record<string, string>)['X-A']).toBe('1')
  })

  it('does not retry when the token has not changed, so a wrong token is one request', async () => {
    write({ 'http://localhost:4000': 'tflw_pat_wrong' })
    const source = resolveToken({ relayUrl: 'ws://localhost:4000', env: env() })
    const fetchMock = vi.fn(async () => answer(401))
    expect((await fetchWithToken(source, 'http://localhost:4000/x', {}, fetchMock as typeof fetch)).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries every request that went out on the old token, not only the first to notice', async () => {
    write({ 'http://localhost:4000': 'tflw_pat_old' })
    const source = resolveToken({ relayUrl: 'ws://localhost:4000', env: env() })
    let release: () => void = () => {}
    const bothSent = new Promise<void>((r) => { release = r })
    let inFlight = 0
    const fetchMock = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const auth = (init!.headers as Record<string, string>).Authorization!
      if (auth.endsWith('new')) return answer(200)
      if (++inFlight === 2) { write({ 'http://localhost:4000': 'tflw_pat_new' }); release() }
      await bothSent
      return answer(401)
    })
    const [a, b] = await Promise.all([
      fetchWithToken(source, 'http://localhost:4000/a', {}, fetchMock as typeof fetch),
      fetchWithToken(source, 'http://localhost:4000/b', {}, fetchMock as typeof fetch),
    ])
    expect([a.status, b.status]).toEqual([200, 200])
  })

  it('does not spend its retry on a file read mid-edit, which reads as no token', async () => {
    write({ 'http://localhost:4000': 'tflw_pat_old' })
    const source = resolveToken({ relayUrl: 'ws://localhost:4000', env: env() })
    fs.writeFileSync(file, '{"version": 1, "rel')
    const fetchMock = vi.fn(async () => answer(401))
    await fetchWithToken(source, 'http://localhost:4000/x', {}, fetchMock as typeof fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves a 403 alone: a scope is not a stale token', async () => {
    write({ 'http://localhost:4000': 'tflw_pat_old' })
    const source = resolveToken({ relayUrl: 'ws://localhost:4000', env: env() })
    write({ 'http://localhost:4000': 'tflw_pat_new' })
    const fetchMock = vi.fn(async () => answer(403))
    await fetchWithToken(source, 'http://localhost:4000/x', {}, fetchMock as typeof fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends no Authorization header without a token', async () => {
    const source = resolveToken({ relayUrl: 'ws://localhost:4000', env: env() })
    const fetchMock = vi.fn(async (_u: string | URL | Request, _init?: RequestInit) => answer(200))
    await fetchWithToken(source, 'http://localhost:4000/x', {}, fetchMock as typeof fetch)
    expect(fetchMock.mock.calls[0]![1]!.headers).toEqual({})
  })
})

describe('tokenRefusal', () => {
  it('names the relay, where the token came from, and the fix for that source', () => {
    const relayUrl = 'wss://team.example.test'
    expect(tokenRefusal(resolveToken({ relayUrl, explicit: 'x', env: env() })))
      .toMatch(/^the relay at https:\/\/team\.example\.test did not accept the token from --token .*remove --token and run `tapflow token set --relay https:\/\/team\.example\.test` \(or store one in .*credentials\.json under "https:\/\/team\.example\.test"\)/)
    expect(tokenRefusal(resolveToken({ relayUrl, env: env({ TAPFLOW_TOKEN: 'x' }) }))).toContain('from TAPFLOW_TOKEN')
    write({ 'https://team.example.test': 'tflw_pat_x' })
    expect(tokenRefusal(resolveToken({ relayUrl, env: env() }))).toContain('the token stored for it in')
  })

  it('without a token, lists the relays the file does have one for', () => {
    write({ 'http://localhost:4000': 'tflw_pat_x' })
    const message = tokenRefusal(resolveToken({ relayUrl: 'wss://team.example.test', env: env() }))
    expect(message).toMatch(/^no token for the relay at https:\/\/team\.example\.test: run `tapflow token set --relay https:\/\/team\.example\.test`, or store one in /)
    expect(message).toContain('(the file has tokens for http://localhost:4000)')
  })

  it('reads a missing file as no token', () => {
    expect(readCredential(path.join(dir, 'absent.json'), 'http://localhost:4000')).toEqual({ token: '', origins: [] })
  })
})

describe('writeCredential', () => {
  const T1 = `tflw_pat_${'a'.repeat(64)}`
  const T2 = `tflw_pat_${'b'.repeat(64)}`

  it('creates the file 0600 in a 0700 directory, keyed by origin, and reads back', () => {
    const nested = path.join(dir, 'cfg', 'tapflow', 'credentials.json')
    expect(writeCredential(nested, 'ws://localhost:4000', T1)).toEqual({ origin: 'http://localhost:4000' })
    expect(readCredential(nested, 'http://localhost:4000').token).toBe(T1)
    if (process.platform !== 'win32') {
      expect(fs.statSync(nested).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(nested)).mode & 0o777).toBe(0o700)
    }
    expect(fs.readdirSync(path.dirname(nested))).toEqual(['credentials.json'])
  })

  it('keeps other relays and unknown keys, and replaces every key for the same origin', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, note: 'mine', relays: { 'ws://127.0.0.1:4000/': { token: 'old' }, 'https://team.example.test': { token: T2 } } }), { mode: 0o600 })
    writeCredential(file, 'ws://localhost:4000', T1)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { note: string; relays: Record<string, unknown> }
    expect(saved.note).toBe('mine')
    expect(Object.keys(saved.relays)).toEqual(['https://team.example.test', 'http://localhost:4000'])
    expect(readCredential(file, 'http://localhost:4000').token).toBe(T1)
    expect(listCredentials(file)).toEqual(['https://team.example.test', 'http://localhost:4000'])
  })

  it('lists equivalent keys once', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, relays: { 'ws://127.0.0.1:4000': { token: T2 }, 'http://localhost:4000': { token: T1 } } }), { mode: 0o600 })
    expect(listCredentials(file)).toEqual(['http://localhost:4000'])
  })

  it('leaves no temp file behind, and the old file whole, when the write itself fails', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, relays: {} }), { mode: 0o600 })
    const failing = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) })
    try {
      expect(() => writeCredential(file, 'ws://localhost:4000', T1)).toThrow(/no space/)
    } finally {
      failing.mockRestore()
    }
    expect(fs.readdirSync(dir)).toEqual(['credentials.json'])
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, relays: {} })
  })

  it('refuses a file it cannot write safely, and leaves it as it was', () => {
    fs.writeFileSync(file, '{ not json')
    expect(() => writeCredential(file, 'ws://localhost:4000', T1)).toThrow(CredentialFileError)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json')
    fs.writeFileSync(file, JSON.stringify({ version: 2, relays: {} }))
    expect(() => writeCredential(file, 'ws://localhost:4000', T1)).toThrow(/not a version 1/)
    if (process.platform !== 'win32') {
      const real = path.join(dir, 'real.json')
      fs.writeFileSync(real, JSON.stringify({ version: 1, relays: {} }))
      fs.rmSync(file)
      fs.symlinkSync(real, file)
      expect(() => writeCredential(file, 'ws://localhost:4000', T1)).toThrow(/symlink/)
      expect(fs.readFileSync(real, 'utf8')).toBe(JSON.stringify({ version: 1, relays: {} }))
    }
  })
})
