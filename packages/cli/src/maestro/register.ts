// `tapflow maestro <flow>`, registered from one line in `program.ts`.
import type { CAC } from 'cac'
import { cmdMaestro, type MaestroOptions } from './command.js'

/**
 * Every value given for `--<long>` (or `-<short>`) on the command line, as typed. cac's parser turns a value that
 * reads as a number into one before any option config applies — a PIN `012345` arrives as `12345`, a phone number
 * `010…` loses its zero — so the values the flow types are read from the raw arguments instead.
 */
export function rawValues(argv: string[], long: string, short?: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') break
    if (a === `--${long}` || (short && a === `-${short}`)) {
      if (i + 1 < argv.length) out.push(argv[++i])
    } else if (a.startsWith(`--${long}=`)) {
      out.push(a.slice(long.length + 3))
    }
  }
  return out
}

export function maestroOptions(argv: string[], parsed: { relay?: unknown; token?: unknown; record?: unknown }): MaestroOptions {
  const one = (long: string) => rawValues(argv, long).at(-1)
  const named: [keyof MaestroOptions, string][] = [
    ['device', 'device'], ['appId', 'app-id'], ['testPhone', 'test-phone'], ['testPin', 'test-pin'],
    ['outputDir', 'output-dir'], ['appleTeamId', 'apple-team-id'],
  ]
  const opts: MaestroOptions = { env: rawValues(argv, 'env', 'e'), record: parsed.record !== false }
  for (const [key, long] of named) {
    const v = one(long)
    if (v !== undefined) (opts as Record<string, unknown>)[key] = v
  }
  if (typeof parsed.relay === 'string') opts.relay = parsed.relay
  const token = one('token')
  if (token !== undefined) opts.token = token
  return opts
}

export function registerMaestroCommand(cli: CAC): void {
  cli
    .command('maestro [file]', 'Run a Maestro flow with the Maestro CLI itself on one physical phone, and record it')
    .option('--device <id>', 'the phone — an adb serial (or usb:<serial>) or an iPhone UDID. Required, never picked for you')
    .option('-e, --env <KEY=VALUE>', 'a value the flow reads as ${KEY} (repeatable)')
    .option('--app-id <id>', 'APP_ID, the app the flow drives')
    .option('--test-phone <phone>', 'TEST_PHONE, the account the flow signs in with (or TEST_PHONE in the environment)')
    .option('--test-pin <pin>', 'TEST_PIN (or TEST_PIN in the environment, which keeps it out of shell history)')
    .option('--output-dir <dir>', 'OUTPUT_DIR, where screenshots and the log go (default: ~/.tapflow/maestro-runs/<time>-<flow>-<platform>)')
    .option('--apple-team-id <id>', 'team that signs the iOS driver (or TAPFLOW_MAESTRO_APPLE_TEAM_ID)')
    .option('--relay <url>', 'Relay URL the run is recorded on (default: ws://localhost:4000)')
    .option('--token <token>', 'PAT for a remote relay (or TAPFLOW_TOKEN env, or ~/.config/tapflow/credentials.json)')
    .option('--no-record', 'Do not record this run on the relay')
    .action(async (file: string | undefined, parsed: { relay?: unknown; token?: unknown; record?: unknown }) => {
      process.exitCode = await cmdMaestro(file, maestroOptions(cli.rawArgs, parsed))
    })
}
