import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
  },
}))

// Per-app launch defaults (#1047, PR 2): the `launch` section of tapflow.config.json.
describe('parseLaunchDefaults', () => {
  const parse = async (raw: unknown, env: NodeJS.ProcessEnv = {}, reserved?: Set<string>) =>
    (await import('../lib/config.js')).parseLaunchDefaults(raw, env, reserved)

  it('reads arguments and env, and envFrom from the environment', async () => {
    const { defaults, problems } = await parse(
      { 'com.example.app': { arguments: { flag: true, port: 8080 }, env: { LOG_LEVEL: 'debug' }, envFrom: { API_TOKEN: 'STAGING_API_TOKEN' } } },
      { STAGING_API_TOKEN: 'sekrit' },
    )
    expect(problems).toEqual([])
    expect(defaults.get('com.example.app')).toEqual({ arguments: { flag: true, port: 8080 }, env: { LOG_LEVEL: 'debug', API_TOKEN: 'sekrit' } })
  })

  it('takes no section as no defaults', async () => {
    expect(await parse(undefined)).toEqual({ defaults: new Map(), problems: [] })
  })

  // A default that silently drops out leaves a flow passing without the flag it was written for, so every one of
  // these refuses the relay's start. The messages reach a log, so none may carry a value.
  it.each([
    ['a section that is not a map', ['x'], /launch: a map/],
    ['a key that is not a bundle id', { 'com example': {} }, /not a bundle id/],
    ['an entry that is not a map', { 'com.example.app': 'x' }, /a map with arguments/],
    ['a misspelled field', { 'com.example.app': { argument: {} } }, /unknown argument/],
    ['a name in both env and envFrom', { 'com.example.app': { env: { A: '1' }, envFrom: { A: 'SRC' } } }, /A is in both/],
    ['envFrom naming a variable that is not set', { 'com.example.app': { envFrom: { A: 'MISSING' } } }, /MISSING is not set/],
    ['envFrom naming the relay\'s JWT secret', { 'com.example.app': { envFrom: { A: 'JWT_SECRET' } } }, /relay's own secrets/],
    ['envFrom naming an SMTP credential', { 'com.example.app': { envFrom: { A: 'SMTP_PASS' } } }, /relay's own secrets/],
    ['envFrom naming a TAPFLOW_ variable', { 'com.example.app': { envFrom: { A: 'TAPFLOW_CLOUDFLARE_TOKEN' } } }, /relay's own secrets/],
    ['an argument the shared check refuses', { 'com.example.app': { arguments: { '-x': 1 } } }, /leading "-"/],
    ['a reserved env name', { 'com.example.app': { env: { DYLD_INSERT_LIBRARIES: 'x' } } }, /reserved/],
    ['an env that is not a map', { 'com.example.app': { env: 'x' } }, /env: a map/],
  ])('refuses %s', async (_, raw, message) => {
    const env = { SRC: 'value-src-91', JWT_SECRET: 'value-jwt-'.repeat(4), SMTP_PASS: 'value-smtp-92', TAPFLOW_CLOUDFLARE_TOKEN: 'value-cf-93' }
    const { defaults, problems } = await parse(raw, env)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(message)
    expect(defaults.size).toBe(0)
    for (const secret of Object.values(env)) expect(problems[0]).not.toContain(secret)
  })

  it('refuses envFrom naming a webhook signing secret', async () => {
    const { problems } = await parse({ 'com.example.app': { envFrom: { A: 'HOOK_SECRET' } } }, { HOOK_SECRET: 'h' }, new Set(['HOOK_SECRET']))
    expect(problems[0]).toMatch(/relay's own secrets/)
  })

  it('reports every bad entry, and keeps the good ones out of nothing', async () => {
    const { defaults, problems } = await parse({ 'a.b': { arguments: { '-x': 1 } }, 'c.d': { envFrom: { A: 'MISSING' } }, 'e.f': { arguments: { ok: 1 } } })
    expect(problems).toHaveLength(2)
    expect([...defaults.keys()]).toEqual(['e.f'])
  })

  // JSON.parse makes `__proto__` an own key, so a plain object here would be prototype pollution.
  it('keeps a key named like an object property as data', async () => {
    const raw = JSON.parse('{"__proto__": {"arguments": {"a": 1}}, "constructor": {"arguments": {"b": 2}}}') as unknown
    const { defaults } = await parse(raw)
    expect(defaults.get('constructor')).toEqual({ arguments: { b: 2 } })
    expect(defaults.has('toString')).toBe(false)
  })

  it('keeps an envFrom variable named __proto__ instead of dropping it', async () => {
    const raw = JSON.parse('{"com.example.app": {"envFrom": {"__proto__": "SRC"}}}') as unknown
    const { defaults, problems } = await parse(raw, { SRC: 'v' })
    expect(problems).toEqual([])
    expect(Object.keys(defaults.get('com.example.app')!.env!)).toEqual(['__proto__'])
  })
})

// The section is resolved only by what starts a relay. Every CLI command imports the config module, and an agent-only
// Mac with the relay's file has no variable for its envFrom.
describe('launch defaults at load', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.resetModules()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fs = (await import('fs')).default
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ launch: { 'com.example.app': { envFrom: { API_TOKEN: 'NOT_ON_THIS_MAC' } } } }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not fail importing the config over an unresolvable default', async () => {
    await import('../lib/config.js')
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('fails starting a relay over it', async () => {
    const { loadLaunchDefaults } = await import('../lib/config.js')
    expect(() => loadLaunchDefaults()).toThrow('process.exit')
  })
})
