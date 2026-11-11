// `tapflow maestro` — device choice, the Maestro command line, the values a flow reads,
// and reading Maestro's command log back as steps.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceNotFound, parseAdbDevices, parseDevicectlDevices, pickDevice, type IosCandidate } from '../../maestro/device'
import { BadEnvArg, flowEnv, flowName, maestroArgv, maestroProcessEnv, redactor, secretValues, TEST_DATA_KEYS } from '../../maestro/plan'
import { artifactName, collectArtifacts, findMaestro, pruneRunFolders } from '../../maestro/run'
import { describeCommand, failureKindOf, failureSummary, stepsFromCommands } from '../../maestro/steps'
import { createCli } from '../../program'
import { maestroOptions, rawValues } from '../../maestro/register'

const devicectlDoc = {
  result: {
    devices: [
      { identifier: 'AAAAAAAA-1111-4111-8111-111111111111', hardwareProperties: { udid: '00008140-0001111111111111', deviceType: 'iPhone', reality: 'physical' }, deviceProperties: { name: 'Test iPhone', developerModeStatus: 'enabled' }, connectionProperties: { transportType: 'wired', tunnelState: 'connected', pairingState: 'paired' } },
      // Paired but over the network only: iproxy cannot reach its driver port.
      { identifier: 'BBBBBBBB-2222-4222-8222-222222222222', hardwareProperties: { udid: '00008110-0003333333333333', deviceType: 'iPhone', reality: 'physical' }, deviceProperties: { name: 'Wireless' }, connectionProperties: { transportType: 'localNetwork', tunnelState: 'connected' } },
      { identifier: 'A1B2C3D4-0000-4000-8000-00000000DEV0', hardwareProperties: { udid: '00008120-0005555555555555', deviceType: 'iPhone', reality: 'physical' }, deviceProperties: { name: 'No Dev Mode', developerModeStatus: 'disabled' }, connectionProperties: { transportType: 'wired', tunnelState: 'connected', pairingState: 'paired' } },
      { identifier: 'CCCCCCCC-3333-4333-8333-333333333333', hardwareProperties: { udid: '00008301-0004444444444444', deviceType: 'appleWatch', reality: 'physical' }, deviceProperties: { name: 'Watch' }, connectionProperties: { transportType: 'wired', tunnelState: 'connected' } },
    ],
  },
}

describe('device', () => {
  it('reads only usable adb devices', () => {
    expect(parseAdbDevices('List of devices attached\nSERIAL0001\tdevice\nX1\tunauthorized\nemulator-5554\toffline\n\n')).toEqual(['SERIAL0001'])
  })

  it('reads iPhones, ready only when wired with the tunnel up', () => {
    const ios = parseDevicectlDevices(devicectlDoc)
    expect(ios.map((d) => [d.name, d.ready])).toEqual([['Test iPhone', true], ['Wireless', false], ['No Dev Mode', false]])
  })

  const ios: IosCandidate[] = parseDevicectlDevices(devicectlDoc)

  it('takes an adb serial or tapflow\'s usb: id', () => {
    expect(pickDevice('SERIAL0001', ['SERIAL0001'], ios)).toEqual({ platform: 'android', serial: 'SERIAL0001', tapflowId: 'usb:SERIAL0001', name: 'SERIAL0001' })
    expect(pickDevice('usb:SERIAL0001', ['SERIAL0001'], ios)).toMatchObject({ platform: 'android', serial: 'SERIAL0001' })
  })

  it('passes the hardware UDID on, even when given the CoreDevice id — Maestro fails on the latter', () => {
    expect(pickDevice('00008140-0001111111111111', [], ios)).toMatchObject({ platform: 'ios', udid: '00008140-0001111111111111' })
    expect(pickDevice('aaaaaaaa-1111-4111-8111-111111111111', [], ios)).toMatchObject({ platform: 'ios', udid: '00008140-0001111111111111' })
  })

  it('never falls back to another device', () => {
    // The phone that is plugged in is not the one asked for: refused, with the ready ones listed.
    expect(() => pickDevice('00008110-0002222222222222', ['SERIAL0001'], ios)).toThrow(DeviceNotFound)
    expect(() => pickDevice('00008110-0002222222222222', ['SERIAL0001'], ios)).toThrow(/SERIAL0001[\s\S]*00008140-0001111111111111/)
    expect(() => pickDevice('00008110-0003333333333333', [], ios)).toThrow(/not plugged in over USB/)
    expect(() => pickDevice('00008120-0005555555555555', [], ios)).toThrow(/Developer Mode/)
  })

  it('refuses an emulator, and does not list one as ready', () => {
    expect(() => pickDevice('emulator-5554', ['emulator-5554'], ios)).toThrow(/emulator/)
    expect(() => pickDevice('nope', ['emulator-5554', 'SERIAL0001'], [])).toThrow(/^(?![\s\S]*emulator-5554)[\s\S]*SERIAL0001/)
  })
})

describe('plan', () => {
  it('sets no app unless told, and always passes the test-data keys, empty when unset', () => {
    const env = flowEnv({ platform: 'ios', outputDir: '/o' })
    expect(env).toMatchObject({ OUTPUT_DIR: '/o' })
    expect(env.APP_ID).toBeUndefined()
    for (const k of TEST_DATA_KEYS) expect(env[k], k).toBe('')
    expect(flowEnv({ platform: 'android', outputDir: '/o', appId: 'com.example.app' }).APP_ID).toBe('com.example.app')
  })

  it('reads test data from the environment, options winning, and nothing else from it', () => {
    const env = flowEnv({ platform: 'ios', outputDir: '/o', processEnv: { TEST_PIN: '111111', TEST_PHONE: '0100', PATH: '/x' } })
    expect(env).toMatchObject({ TEST_PIN: '111111', TEST_PHONE: '0100' })
    expect(env.PATH).toBeUndefined()
    expect(flowEnv({ platform: 'ios', outputDir: '/o', testPin: '222222', processEnv: { TEST_PIN: '111111' } }).TEST_PIN).toBe('222222')
  })

  it('hides credentials and personal data, longest first, and nothing else', () => {
    const secrets = secretValues({ TEST_PIN: '012345', TEST_PHONE: '01012345678', TEST_CARD_CVC: '9', LANG_CODE: 'ko', COUNTRY: 'Vietnam' })
    expect(secrets.sort()).toEqual(['01012345678', '012345'])
    const r = redactor(secrets)
    expect(r('inputText "012345" then "01012345678" in Vietnam ko')).toBe('inputText "***" then "***" in Vietnam ko')
  })

  it('lets -e override defaults, named options override -e, and OUTPUT_DIR is the run\'s own', () => {
    const env = flowEnv({ platform: 'android', outputDir: '/o', appId: 'com.example.app', testPin: '012345', extra: ['APP_ID=other', 'COUNTRY=Vietnam', 'A=b=c', 'OUTPUT_DIR=/elsewhere'] })
    expect(env).toMatchObject({ APP_ID: 'com.example.app', TEST_PIN: '012345', COUNTRY: 'Vietnam', A: 'b=c', OUTPUT_DIR: '/o' })
  })

  it('refuses an -e that is not KEY=VALUE', () => {
    expect(() => flowEnv({ platform: 'ios', outputDir: '/o', extra: ['=x'] })).toThrow(BadEnvArg)
    expect(() => flowEnv({ platform: 'ios', outputDir: '/o', extra: ['NOEQUALS'] })).toThrow(BadEnvArg)
    expect(() => flowEnv({ platform: 'ios', outputDir: '/o', extra: ['1A=x'] })).toThrow(BadEnvArg)
  })

  it('puts --device before test, and the iOS driver options after it', () => {
    const android = maestroArgv({ device: { platform: 'android', serial: 'S1', tapflowId: 'usb:S1', name: 'S1' }, flowFile: '/f.yaml', debugDir: '/d', env: { A: '1' } })
    expect(android).toEqual(['--device', 'S1', 'test', '--no-ansi', '--debug-output', '/d', '--flatten-debug-output', '-e', 'A=1', '/f.yaml'])
    const ios = maestroArgv({ device: { platform: 'ios', udid: 'U1', tapflowId: 'U1', name: 'P' }, flowFile: '/f.yaml', debugDir: '/d', env: {} })
    expect(ios.slice(0, 5)).toEqual(['--device', 'U1', 'test', '--driver-host-port', '22087'])
    const signed = maestroArgv({ device: { platform: 'ios', udid: 'U1', tapflowId: 'U1', name: 'P' }, flowFile: '/f.yaml', debugDir: '/d', env: {}, appleTeamId: 'TEAM123' })
    expect(signed.slice(0, 7)).toEqual(['--device', 'U1', 'test', '--apple-team-id', 'TEAM123', '--driver-host-port', '22087'])
  })

  it('caps the JVM and waits five minutes for the driver unless told otherwise', () => {
    expect(maestroProcessEnv({})).toMatchObject({ MAESTRO_OPTS: '-Xmx1g', MAESTRO_DRIVER_STARTUP_TIMEOUT: '300000' })
    expect(maestroProcessEnv({ MAESTRO_OPTS: '-Xmx2g' }).MAESTRO_OPTS).toBe('-Xmx2g')
  })

  it('names the flow by its config name, else its file', () => {
    expect(flowName('appId: x\nname: c1 smoke\n---\n- tapOn: a\n', '/a/c1.yaml')).toBe('c1 smoke')
    expect(flowName('appId: x\n---\n- runFlow:\n    name: inner\n', '/a/c1.yaml')).toBe('c1')
  })
})

describe('steps', () => {
  const doc = [
    { command: { runScriptCommand: { script: '', sourceDescription: '../../common/setup.js' } }, metadata: { status: 'COMPLETED', duration: 812 } },
    { command: { tapOnElement: { selector: { textRegex: '${output.t.send}' } } }, metadata: { status: 'COMPLETED', duration: 10.4, evaluatedCommand: { tapOnElement: { selector: { textRegex: 'Send' } } } } },
    { command: { runFlowCommand: { commands: [], condition: { visible: { textRegex: 'Close' } } } }, metadata: { status: 'SKIPPED' } },
    { command: { extendedWaitUntilCommand: { visible: { textRegex: 'Deadline' }, optional: true } }, metadata: { status: 'WARNED', duration: 5000 } },
    { command: { assertConditionCommand: { condition: { visible: { textRegex: 'Deadline' } } } }, metadata: { status: 'FAILED', duration: 8459, error: { message: 'Assertion is false: "Deadline" is visible' } } },
  ]

  it('reads each command\'s outcome, evaluated text first', () => {
    const steps = stepsFromCommands(doc)
    expect(steps.map((s) => [s.name, s.status])).toEqual([
      ['runScript "../../common/setup.js"', 'passed'],
      ['tapOnElement "Send"', 'passed'],
      ['runFlow "Close"', 'skipped'],
      ['extendedWaitUntil "Deadline"', 'passed'],
      ['assertCondition "Deadline"', 'failed'],
    ])
    expect(steps[1].durationMs).toBe(10)
    expect(steps[4].message).toBe('Assertion is false: "Deadline" is visible')
    expect(steps[3].message).toMatch(/optional/)
  })

  it('hides a typed PIN in the step name and message', () => {
    const typed = [{ command: { inputTextCommand: { text: '${TEST_PIN}' } }, metadata: { status: 'FAILED', evaluatedCommand: { inputTextCommand: { text: '012345' } }, error: { message: 'could not type 012345' } } }]
    const [step] = stepsFromCommands(typed, redactor(['012345']))
    expect(step.name).toBe('inputText "***"')
    expect(step.message).toBe('could not type ***')
    expect(failureSummary('a\nPIN 012345 failed', 1500, redactor(['012345']))).toBe('a\nPIN *** failed')
  })

  it('blames the environment when no step ran, the phone was lost, or the flow file was refused; else the app', () => {
    expect(failureKindOf('anything', 0)).toBe('environment')
    expect(failureKindOf('Tap on "Send"... FAILED\nRequested driver host port 22087 is not available', 4)).toBe('environment')
    expect(failureKindOf('iOS driver not ready in time', 3)).toBe('environment')
    expect(failureKindOf('Parsing Failed\n> line 4', 2)).toBe('environment')
    expect(failureKindOf('Assertion is false: "Deadline" is visible', 7)).toBe('product')
  })

  it('reads nothing from a missing or malformed log', () => {
    expect(stepsFromCommands(null)).toEqual([])
    expect(stepsFromCommands({})).toEqual([])
    expect(describeCommand('x')).toBe('command')
  })
})

describe('artifacts', () => {
  it('folds Maestro\'s names into ones the relay accepts, without collisions', () => {
    const taken = new Set<string>()
    expect(artifactName('/d/screenshot-❌-1794362277657-(c1.yaml).png', taken)).toBe('maestro-failure-1794362277657-_c1.yaml_.png')
    expect(artifactName('/o/c1-01-calculator.png', taken)).toBe('c1-01-calculator.png')
    expect(artifactName('/x/c1-01-calculator.png', taken)).toBe('c1-01-calculator-2.png')
    expect(artifactName('/o/.hidden.png', taken)).toMatch(/^[A-Za-z0-9]/)
  })

  it('collects screenshots oldest first, the failure screen, and the log; the last screen is where it failed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-'))
    const debug = path.join(dir, 'maestro-debug')
    fs.mkdirSync(debug)
    const write = (f: string, t: number) => { fs.writeFileSync(f, 'x'); fs.utimesSync(f, t, t) }
    write(path.join(dir, 'b.png'), 2000)
    write(path.join(dir, 'a.png'), 1000)
    write(path.join(debug, 'screenshot-❌-1-(c1.yaml).png'), 3000)
    write(path.join(debug, 'commands-(c1.yaml).json'), 3000)
    write(path.join(dir, 'maestro.log'), 3000)
    write(path.join(dir, 'old-run.png'), 500)
    // The log and the failure screen first, so a run that hits the relay's file cap still keeps them; only files
    // written since this run started (an earlier run's `old-run.png` in a reused folder is left out).
    const { artifacts, lastScreen } = collectArtifacts(dir, debug, path.join(dir, 'maestro.log'), 900_000)
    expect(artifacts.map((a) => a.name)).toEqual(['maestro.log', 'maestro-failure-1-_c1.yaml_.png', 'a.png', 'b.png'])
    expect(lastScreen).toBe(path.join(debug, 'screenshot-❌-1-(c1.yaml).png'))
    fs.rmSync(dir, { recursive: true })
  })

  it('prunes only its own run folders older than a week', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-prune-'))
    const now = Date.now()
    const mk = (n: string, ageDays: number) => { const d = path.join(root, n); fs.mkdirSync(d); const t = (now - ageDays * 86_400_000) / 1000; fs.utimesSync(d, t, t); return d }
    const old = mk('20261101-101010-c1-ios', 10)
    const fresh = mk('20261110-101010-c1-android', 1)
    const other = mk('keep-me', 30)
    pruneRunFolders(root, 7, now)
    expect([fs.existsSync(old), fs.existsSync(fresh), fs.existsSync(other)]).toEqual([false, true, true])
    fs.rmSync(root, { recursive: true })
  })

  it('finds maestro on PATH, then in ~/.maestro/bin', () => {
    expect(findMaestro({ PATH: '/a:/b', HOME: '/h' }, (p) => p === '/b/maestro')).toBe('/b/maestro')
    expect(findMaestro({ PATH: '/a', HOME: '/h' }, (p) => p === '/h/.maestro/bin/maestro')).toBe('/h/.maestro/bin/maestro')
    expect(findMaestro({ PATH: '/a', HOME: '/h', TAPFLOW_MAESTRO_BIN: '/m' }, () => false)).toBe('/m')
    expect(findMaestro({ PATH: '/a', HOME: '/h' }, () => false)).toBeNull()
  })
})

describe('command line', () => {
  it('keeps a PIN\'s and a phone number\'s leading zero, and every -e', () => {
    // cac turns numeric-looking values into numbers before any option config applies; the values are read raw.
    const argv = ['node', 'tapflow', 'maestro', 'f.yaml', '--device', 'S1', '--test-pin', '012345', '--test-phone=01012345678', '-e', 'A=1', '--env', 'B=2', '--no-record']
    const cli = createCli()
    const parsed = cli.parse(argv, { run: false })
    expect(parsed.args).toEqual(['f.yaml'])
    expect(maestroOptions(cli.rawArgs, parsed.options)).toEqual({
      device: 'S1', testPin: '012345', testPhone: '01012345678', env: ['A=1', 'B=2'], record: false,
    })
  })

  it('passes no -e when none is given', () => {
    expect(maestroOptions(['maestro', 'f.yaml', '--device', 'S1'], {}).env).toEqual([])
    expect(rawValues(['--lang', 'en', '--', '--lang', 'vi'], 'lang')).toEqual(['en'])
  })
})
