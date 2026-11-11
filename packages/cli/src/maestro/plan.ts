// `tapflow maestro` — the Maestro command line and the values
// a flow reads. Pure, so every rule below is a unit test rather than a run on a phone.
import type { MaestroDevice } from './device.js'

/**
 * The host port the iOS driver listens on and iproxy forwards. Fixed rather than Maestro's random pick: a physical
 * iPhone has no route to the Mac's loopback, so the port has to be known before Maestro starts to forward it.
 */
export const DEFAULT_DRIVER_HOST_PORT = 22087

/**
 * Test data a flow may type, passed always — empty when unset — because Maestro leaves an unknown `${KEY}` as the
 * text `undefined`, which a flow would then type into a field. Each is read from the environment of `tapflow` itself
 * when not given on its command line, so a PIN need not be typed where shell history keeps it.
 */
export const TEST_DATA_KEYS = ['TEST_PHONE', 'TEST_PIN'] as const

/** Keys whose values are credentials or personal data: hidden wherever the run is recorded. */
const SECRET_KEY = /(PIN|PW|PASSWORD|CVC|PHONE|ACCOUNT|TOKEN|SECRET)/i

/** What the person running the command chose; everything absent falls back to a default here. */
export interface FlowEnvInput {
  platform: MaestroDevice['platform']
  outputDir: string
  appId?: string
  testPhone?: string
  testPin?: string
  /** `-e KEY=VALUE`, as typed. */
  extra?: string[]
  /** `tapflow`'s own environment, where test data may be given instead of on the command line. */
  processEnv?: NodeJS.ProcessEnv
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Why an `-e` value was refused. */
export class BadEnvArg extends Error {}

/**
 * The values a flow reads as `${KEY}`. Test data first (from the environment, else empty), then `-e`, then the named
 * options, so an option typed on purpose is never undone by a generic `-e`.
 */
export function flowEnv(input: FlowEnvInput): Record<string, string> {
  const pe = input.processEnv ?? {}
  const env: Record<string, string> = {}
  for (const k of TEST_DATA_KEYS) env[k] = pe[k] ?? ''
  for (const kv of input.extra ?? []) {
    const eq = kv.indexOf('=')
    const key = eq > 0 ? kv.slice(0, eq) : ''
    if (!KEY.test(key)) throw new BadEnvArg(`-e ${JSON.stringify(kv)} is not KEY=VALUE`)
    env[key] = kv.slice(eq + 1)
  }
  if (input.appId) env.APP_ID = input.appId
  if (input.testPhone !== undefined) env.TEST_PHONE = input.testPhone
  if (input.testPin !== undefined) env.TEST_PIN = input.testPin
  // Where `takeScreenshot: ${OUTPUT_DIR}/…` lands. Always the run's own folder: the record collects from there.
  env.OUTPUT_DIR = input.outputDir
  return env
}

/** The values in `env` that must not reach the record: credentials and personal data, two characters or longer. */
export function secretValues(env: Record<string, string>): string[] {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(env)) if (SECRET_KEY.test(k) && v.length >= 2) out.add(v)
  return [...out]
}

/** Replaces every secret in a text with `***`, longest first so a value inside another is not half-hidden. */
export function redactor(secrets: string[]): (text: string) => string {
  const sorted = [...secrets].sort((a, b) => b.length - a.length)
  return (text) => sorted.reduce((t, s) => t.split(s).join('***'), text)
}

export interface MaestroArgvInput {
  device: MaestroDevice
  flowFile: string
  debugDir: string
  env: Record<string, string>
  appleTeamId?: string
  driverHostPort?: number
}

/**
 * `maestro --device <id> test …`. `--device` is a global option and goes before `test`; `--apple-team-id` (only
 * when given) and `--driver-host-port` (both hidden from Maestro's help) belong to `test`. The debug output is flattened into the
 * run's folder so its `commands-*.json` and failure screenshot can be read back without guessing a timestamp.
 */
export function maestroArgv(input: MaestroArgvInput): string[] {
  const id = input.device.platform === 'android' ? input.device.serial : input.device.udid
  const ios = input.device.platform === 'ios'
    ? [...(input.appleTeamId ? ['--apple-team-id', input.appleTeamId] : []), '--driver-host-port', String(input.driverHostPort ?? DEFAULT_DRIVER_HOST_PORT)]
    : []
  return [
    '--device', id,
    'test',
    ...ios,
    '--no-ansi',
    '--debug-output', input.debugDir,
    '--flatten-debug-output',
    ...Object.entries(input.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    input.flowFile,
  ]
}

/**
 * The process environment Maestro runs with. The JVM gets a heap cap (Maestro's launcher sets none, so it grows to a
 * quarter of the Mac's memory), and the driver five minutes to start: a physical iPhone's first start after a
 * reboot measured over two. Values the caller already set win.
 */
export function maestroProcessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    MAESTRO_OPTS: base.MAESTRO_OPTS ?? '-Xmx1g',
    MAESTRO_DRIVER_STARTUP_TIMEOUT: base.MAESTRO_DRIVER_STARTUP_TIMEOUT ?? '300000',
    // Maestro asks to send analytics on first run and waits for an answer nobody is there to give.
    MAESTRO_CLI_NO_ANALYTICS: base.MAESTRO_CLI_NO_ANALYTICS ?? '1',
  }
}

/** The flow's `name:` from its config section, or the file name without `.yaml`. */
export function flowName(yaml: string, file: string): string {
  const header = yaml.split(/^---\s*$/m)[0] ?? ''
  const m = header.match(/^name:\s*(.+?)\s*$/m)
  const fromFile = file.split('/').pop()?.replace(/\.ya?ml$/, '') ?? file
  return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : fromFile
}
