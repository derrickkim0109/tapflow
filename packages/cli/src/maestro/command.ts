// `tapflow maestro <flow> --device <id>`.
//
// Runs a Maestro flow with the Maestro CLI itself on one phone, and records it on the runs page beside
// `tapflow flow run`'s runs. Not a translation into tapflow's flow vocabulary: the flows this exists for use
// `runScript`, `${output.…}` and `when: platform`, which only Maestro runs (the converter of MR !8 was reverted
// for that reason).
//
// Exit codes follow `tapflow flow run`: 0 the flow passed · 1 it failed · 2 it could not be run (no such device,
// no maestro, a busy device, a bad option, anything unexpected) · 130 interrupted (Ctrl-C, SIGTERM).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fetchWithToken, RelayClient, resolveToken, tokenRefusal, type DeviceInfo, type TokenSource } from '@tapflowio/flow-runner'
import { RunRecorder, type FlowReport } from '../lib/runRecorder.js'
import { ciContext } from '../lib/ci.js'
import { DeviceNotFound, parseAdbDevices, parseDevicectlDevices, pickDevice, type IosCandidate, type MaestroDevice } from './device.js'
import { BadEnvArg, flowEnv, flowName, maestroArgv, maestroProcessEnv, redactor, secretValues } from './plan.js'
import {
  collectArtifacts, DeviceUnavailable, findMaestro, onPath, prepareDevice, pruneRunFolders, readCommandsLog, realDeps,
  runMaestroProcess, type Artifact, type RunDeps,
} from './run.js'
import { failureKindOf, failureSummary, stepsFromCommands } from './steps.js'

export interface MaestroOptions {
  device?: string
  env?: string[]
  appId?: string
  testPhone?: string
  testPin?: string
  outputDir?: string
  appleTeamId?: string
  relay?: string
  token?: string
  record?: boolean
}

/** What the command reads from the machine, injectable so the whole run can be tested without a phone. */
export interface CommandDeps extends RunDeps {
  readyDevices: () => { adb: string[]; ios: IosCandidate[] }
  findMaestro: () => string | null
  /** Whether a helper program is on PATH (iproxy). */
  hasProgram: (name: string) => boolean
  processEnv: NodeJS.ProcessEnv
  /** Where default output folders go. */
  homeDir: string
  /** The process signals that end a run; returns how to stop listening. */
  onSignal: (handler: () => void) => () => void
}

class EnvironmentFailure extends Error {}
const envFail = (message: string): never => { throw new EnvironmentFailure(message) }

/** Cap on how long the end of a run waits for the relay, so a gone relay never holds the exit. */
const DRAIN_CAP_MS = 20_000
/** All attachments together: an unresponsive relay costs at most this, not 30 s per file. */
const UPLOAD_CAP_MS = 60_000
const ARTIFACT_TIMEOUT_MS = 30_000

function httpBaseOf(relayUrl: string): string {
  return relayUrl.replace(/^wss?/, (p) => (p === 'wss' ? 'https' : 'http'))
}

/** The ready phones, read the way the agents read them. A host without adb or Xcode simply has none of that kind. */
function readyDevices(): { adb: string[]; ios: IosCandidate[] } {
  let adb: string[] = []
  try {
    adb = parseAdbDevices(execFileSync('adb', ['devices'], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }))
  } catch { /* no adb */ }
  let ios: IosCandidate[] = []
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-devicectl-')), 'devices.json')
  try {
    execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], { stdio: 'pipe', timeout: 30_000 })
    ios = parseDevicectlDevices(JSON.parse(fs.readFileSync(out, 'utf8')))
  } catch { /* no Xcode */ } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true })
  }
  return { adb, ios }
}

export const realCommandDeps: CommandDeps = {
  ...realDeps,
  readyDevices,
  findMaestro: () => findMaestro(),
  hasProgram: (name) => onPath(name) !== null,
  processEnv: process.env,
  homeDir: os.homedir(),
  onSignal: (handler) => {
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
    return () => { process.removeListener('SIGINT', handler); process.removeListener('SIGTERM', handler) }
  },
}

function defaultOutputRoot(home: string): string {
  return path.join(home, '.tapflow', 'maestro-runs')
}

function defaultOutputDir(home: string, flowFile: string, device: MaestroDevice): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const base = path.basename(flowFile).replace(/\.ya?ml$/, '')
  return path.join(defaultOutputRoot(home), `${stamp}-${base}-${device.platform}`)
}

/** The relay's view of `device`: refused when someone holds it, since two drivers on one phone fight over it. */
function relayDevice(sessions: { devices: DeviceInfo[] }[], device: MaestroDevice): DeviceInfo | undefined {
  const found = sessions.flatMap((s) => s.devices).find((d) => d.id === device.tapflowId)
  if (found?.busy) envFail(`${device.name} is in use in tapflow (session ${found.sessionId}) — end that session first`)
  return found
}

/**
 * Attach the run's files, most important first. Stops at the first network failure (the relay is gone or not
 * answering: the rest would only wait out their timeouts) and when `UPLOAD_CAP_MS` is spent. A log is attached
 * redacted: it holds the values the flow typed.
 */
async function uploadArtifacts(
  httpBase: string, tokens: TokenSource, runId: string, artifacts: Artifact[], redact: (t: string) => string, warn: (l: string) => void,
): Promise<number> {
  const deadline = Date.now() + UPLOAD_CAP_MS
  let sent = 0
  for (const a of artifacts) {
    const left = deadline - Date.now()
    if (left <= 0) { warn(`stopped attaching after ${UPLOAD_CAP_MS / 1000}s — ${artifacts.length - sent} files not attached`); break }
    const raw = fs.readFileSync(a.file)
    const body = /\.(log|txt)$/i.test(a.name) ? Buffer.from(redact(raw.toString('utf8'))) : raw
    try {
      const res = await fetchWithToken(tokens, new URL(`/api/v1/maestro/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(a.name)}`, httpBase).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(Math.min(ARTIFACT_TIMEOUT_MS, left)),
      })
      if (!res.ok) {
        const detail = await res.json().then((b: { error?: unknown }) => (typeof b.error === 'string' ? ` (${b.error})` : ''), () => '')
        warn(`${a.name} not attached: the relay answered ${res.status}${detail}`)
        // A relay without the route answers every one the same way; a full run takes no more either.
        if ((res.status === 404 && !detail.includes('Run')) || res.status === 409) return sent
        continue
      }
      sent++
    } catch (e) {
      warn(`${a.name} not attached: ${(e as Error).message} — not attaching the rest`)
      return sent
    }
  }
  return sent
}

export async function cmdMaestro(flowArg: string | undefined, opts: MaestroOptions, deps: CommandDeps = realCommandDeps): Promise<number> {
  const warn = (line: string) => deps.say(line)
  let client: RelayClient | undefined
  let recorder: RunRecorder | undefined
  // Listening from the start, so Ctrl-C or SIGTERM while the app launches still ends the run cleanly.
  const abort = new AbortController()
  const stopListening = deps.onSignal(() => abort.abort())
  try {
    if (!flowArg) envFail('which flow? tapflow maestro <flow.yaml> --device <id>')
    const flowFile = path.resolve(flowArg as string)
    let yaml = ''
    try { yaml = fs.readFileSync(flowFile, 'utf8') } catch (e) { envFail(`cannot read ${flowFile}: ${(e as Error).message}`) }
    if (!opts.device) envFail('--device <id> is required: an adb serial (or usb:<serial>) or an iPhone\'s UDID. It is never picked for you')

    const ready = deps.readyDevices()
    let device: MaestroDevice
    try {
      device = pickDevice(String(opts.device), ready.adb, ready.ios)
    } catch (e) {
      if (e instanceof DeviceNotFound) envFail(e.message)
      throw e
    }
    const maestroBin = deps.findMaestro() ?? envFail('maestro not found — install it (curl -Ls https://get.maestro.mobile.dev | bash) or set TAPFLOW_MAESTRO_BIN')
    if (device.platform === 'ios' && !deps.hasProgram('iproxy')) envFail('iproxy not found — brew install libimobiledevice (it forwards the iPhone driver\'s port)')

    if (!opts.outputDir) pruneRunFolders(defaultOutputRoot(deps.homeDir))
    const outputDir = path.resolve(opts.outputDir ?? defaultOutputDir(deps.homeDir, flowFile, device))
    const debugDir = path.join(outputDir, 'maestro-debug')
    // A reused folder still has an earlier run's command log; Maestro's debug output is this run's only.
    fs.rmSync(debugDir, { recursive: true, force: true })
    fs.mkdirSync(debugDir, { recursive: true })
    let env: Record<string, string>
    try {
      env = flowEnv({
        platform: device.platform, outputDir, extra: opts.env ?? [], processEnv: deps.processEnv,
        ...(opts.appId ? { appId: opts.appId } : {}),
        ...(opts.testPhone !== undefined ? { testPhone: opts.testPhone } : {}),
        ...(opts.testPin !== undefined ? { testPin: opts.testPin } : {}),
      })
    } catch (e) {
      if (e instanceof BadEnvArg) envFail(e.message)
      throw e
    }
    const redact = redactor(secretValues(env))
    const teamId = opts.appleTeamId ?? deps.processEnv.TAPFLOW_MAESTRO_APPLE_TEAM_ID

    // The relay is asked whether someone holds the phone even when the run is not recorded: a session there would
    // have the phone taken from under it. A relay that cannot be reached costs the check and the record, never the run.
    const name = flowName(yaml, flowFile)
    let relayDev: DeviceInfo | undefined
    const relayUrl = opts.relay ?? 'ws://localhost:4000'
    const httpBase = httpBaseOf(relayUrl)
    const tokens = resolveToken({ relayUrl, ...(opts.token ? { explicit: opts.token } : {}), warn })
    client = new RelayClient(relayUrl, tokens)
    try {
      await client.connect()
      relayDev = relayDevice(await client.listDevices(), device)
    } catch (e) {
      if (e instanceof EnvironmentFailure) throw e
      warn(`${opts.record === false ? 'not checked whether tapflow holds the phone' : 'run not recorded'}: cannot reach the relay at ${relayUrl} (${(e as Error).message})`)
      client.disconnect()
      client = undefined
    }
    if (opts.record !== false && client) {
      if (!tokens.token) {
        warn(`run not recorded: ${tokenRefusal(tokens)}, or pass --token`)
      } else {
        recorder = new RunRecorder(httpBase, tokens, { fetch: globalThis.fetch, warn })
        recorder.create({ client: client.clientId, flows: [{ name, file: flowFile }], ci: ciContext(), resetRequested: false })
        if (relayDev) recorder.reportFlowStart(0, { sessionId: relayDev.sessionId, id: device.tapflowId, name: relayDev.name })
      }
    }

    deps.say(`▶ ${name} on ${device.name} (${device.platform}) → ${outputDir}`)
    const startedAt = Date.now()
    try {
      await prepareDevice(device, env.APP_ID, deps, undefined, abort.signal)
    } catch (e) {
      if (e instanceof DeviceUnavailable) envFail(e.message)
      throw e
    }
    const result = await runMaestroProcess({
      maestroBin,
      argv: maestroArgv({ device, flowFile, debugDir, env, ...(teamId ? { appleTeamId: teamId } : {}) }),
      env: maestroProcessEnv(process.env),
      cwd: outputDir,
      logFile: path.join(outputDir, 'maestro.log'),
      device,
      signal: abort.signal,
    }, deps)

    const passed = result.exitCode === 0 && !result.interrupted
    const steps = stepsFromCommands(readCommandsLog(debugDir), redact)
    // Files from before this run (a reused --output-dir) are left out; a second of slack covers coarse mtimes.
    const { artifacts, lastScreen } = collectArtifacts(outputDir, debugDir, path.join(outputDir, 'maestro.log'), startedAt - 1000)

    if (recorder) {
      // An interrupted flow is not a verdict on the app: only the run's ending says it was stopped.
      if (!result.interrupted) {
        const report: FlowReport = {
          status: passed ? 'passed' : 'failed',
          durationMs: result.durationMs,
          ...(passed ? {} : { failureKind: failureKindOf(result.log, steps.length), failureMessage: failureSummary(result.log, 1500, redact) }),
          steps,
          device: { id: device.tapflowId, name: relayDev?.name ?? device.name, platform: device.platform },
        }
        recorder.reportFlow(0, report, lastScreen ? fs.readFileSync(lastScreen) : undefined)
      }
      // Attached before the finish: a finished run takes no more writes.
      const runId = await recorder.created
      if (runId) {
        const sent = await uploadArtifacts(httpBase, tokens, runId, artifacts, redact, warn)
        deps.say(`attached ${sent}/${artifacts.length} files to run ${runId}`)
      }
      recorder.finish(result.interrupted
        ? { status: 'aborted', exitCode: 130, errorMessage: 'interrupted' }
        : { status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1 })
      const drained = await recorder.drain(DRAIN_CAP_MS)
      if (drained.runId) deps.say(`run: ${httpBase}/automation/runs/${drained.runId}`)
    }
    if (result.interrupted) {
      deps.say('■ interrupted')
      return 130
    }
    deps.say(passed ? `✓ passed (${Math.round(result.durationMs / 1000)}s)` : `✗ failed — maestro exited ${result.exitCode}; output in ${outputDir}`)
    return passed ? 0 : 1
  } catch (e) {
    // Anything that stops the run before Maestro's verdict — a refusal above, or an error nobody planned for — ends
    // as "could not be run" (2), never as a flow failure (1), and closes the record rather than leaving it to expire.
    const message = e instanceof EnvironmentFailure ? e.message : `unexpected: ${(e as Error)?.stack ?? String(e)}`
    deps.say(`error: ${message}`)
    if (recorder) {
      recorder.finish({ status: 'failed', exitCode: 2, failureKind: 'environment', errorMessage: message.slice(0, 2000) })
      await recorder.drain(DRAIN_CAP_MS)
    }
    return 2
  } finally {
    stopListening()
    client?.disconnect()
  }
}
