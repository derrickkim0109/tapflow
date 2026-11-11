// `tapflow maestro` — running the Maestro CLI itself on one
// phone. Each wait and port below was measured on physical phones.
import { spawn as nodeSpawn, execFile as nodeExecFile, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MaestroDevice } from './device.js'
import { DEFAULT_DRIVER_HOST_PORT } from './plan.js'

export interface RunDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** Resolves with stdout; rejects on a non-zero exit or a timeout. */
  exec: (cmd: string, args: string[], timeoutMs: number) => Promise<string>
  sleep: (ms: number) => Promise<void>
  /** Progress lines for the person running the command. */
  say: (line: string) => void
  /** Maestro's own output, as it arrives. */
  out: (chunk: Buffer) => void
  /** Ends a process by id (the port's previous holder). */
  kill: (pid: number) => void
}

export const realDeps: RunDeps = {
  spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
  exec: (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
    nodeExecFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  say: (line) => console.error(line),
  out: (chunk) => process.stdout.write(chunk),
  kill: (pid) => { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } },
}

/** `name` in a PATH directory, or null. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && exists(path.join(dir, name))) return path.join(dir, name)
  }
  return null
}

/** `maestro` on PATH, then the installer's `~/.maestro/bin`. `TAPFLOW_MAESTRO_BIN` wins over both. */
export function findMaestro(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (env.TAPFLOW_MAESTRO_BIN) return env.TAPFLOW_MAESTRO_BIN
  const installed = path.join(env.HOME ?? os.homedir(), '.maestro', 'bin', 'maestro')
  return onPath('maestro', env, exists) ?? (exists(installed) ? installed : null)
}

/** Why a run could not start on this phone, in words for the person running the command. */
export class DeviceUnavailable extends Error {}

/**
 * Who holds the iOS driver port, and whether it may be freed. Only an `iproxy` left by an earlier run *for this same
 * phone* is ended. An iproxy for another phone means another iPhone run is going on: ending it would point that run's
 * port at this phone, and its commands would land here — so this run is refused instead. Any other program on the
 * port is never touched.
 */
export function portHolderVerdict(args: string, port: number, udid: string): 'ours' | 'other-phone' | 'foreign' {
  const words = args.trim().split(/\s+/)
  if (!words[0] || path.basename(words[0]) !== 'iproxy' || !words.includes(String(port))) return 'foreign'
  const u = words.indexOf('-u')
  const forUdid = u >= 0 ? words[u + 1] : undefined
  return forUdid?.toUpperCase() === udid.toUpperCase() ? 'ours' : 'other-phone'
}

/**
 * Before Maestro starts. Android: wake the screen — a phone that dimmed between runs gives black screenshots and taps
 * that land on the lock screen. iOS: the driver port must be free (see `portHolderVerdict`), and the app is started
 * with devicectl, since Maestro cannot launch an app on a physical iPhone. A failed wake or launch does not stop the
 * run — Maestro's own first step then says what is wrong, in its words. A port it may not free does.
 */
export async function prepareDevice(
  device: MaestroDevice, appId: string, deps: RunDeps, driverHostPort = DEFAULT_DRIVER_HOST_PORT, signal?: AbortSignal,
): Promise<void> {
  if (device.platform === 'android') {
    await deps.exec('adb', ['-s', device.serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], 10_000)
      .catch((e: Error) => deps.say(`could not wake ${device.serial}: ${e.message}`))
    return
  }
  const holders = await deps.exec('lsof', ['-nP', `-iTCP:${driverHostPort}`, '-sTCP:LISTEN', '-t'], 5_000).catch(() => '')
  for (const pid of holders.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const args = await deps.exec('ps', ['-o', 'args=', '-p', pid], 5_000).catch(() => '')
    const verdict = portHolderVerdict(args, driverHostPort, device.udid)
    if (verdict === 'other-phone') {
      throw new DeviceUnavailable(`port ${driverHostPort} is forwarded to another iPhone (pid ${pid}: ${args.trim()}) — another iPhone run is going on; wait for it to end`)
    }
    if (verdict === 'foreign') {
      throw new DeviceUnavailable(`port ${driverHostPort} is held by another program (pid ${pid}: ${args.trim() || 'unknown'}) — the iOS driver needs it`)
    }
    deps.say(`freeing port ${driverHostPort} (pid ${pid}, an iproxy left for this phone by an earlier run)`)
    deps.kill(Number(pid))
  }
  if (signal?.aborted) return
  deps.say(`launching ${appId} on ${device.name}`)
  await deps.exec('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.udid, '--terminate-existing', appId], 60_000)
    .catch(() => deps.say('could not launch the app — is the phone unlocked and the app installed?'))
  // The app's first screen, before the driver starts looking at it (measured).
  if (!signal?.aborted) await deps.sleep(5_000)
}

export interface MaestroProcessResult {
  exitCode: number
  durationMs: number
  /** Everything Maestro printed, also written to `maestro.log` in the run's folder. */
  log: string
  /** Ended by a signal this process forwarded (Ctrl-C, SIGTERM), not by Maestro on its own. */
  interrupted: boolean
}

/**
 * Run Maestro to its end. On iOS, iproxy is started `iproxyDelayMs` after Maestro: Maestro refuses a driver port
 * that is already bound when it starts, and gives up on a driver it cannot reach a while later, so the forward has to
 * land in between (12 s, measured). Both children are ended however this ends — Maestro's own exit, the
 * signal, an error, or this process exiting — so neither is left holding the phone or the port.
 */
export async function runMaestroProcess(opts: {
  maestroBin: string
  argv: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  logFile: string
  device: MaestroDevice
  driverHostPort?: number
  iproxyDelayMs?: number
  signal?: AbortSignal
}, deps: RunDeps): Promise<MaestroProcessResult> {
  const started = Date.now()
  if (opts.signal?.aborted) return { exitCode: 130, durationMs: 0, log: '', interrupted: true }
  const chunks: Buffer[] = []
  const logStream = fs.createWriteStream(opts.logFile)
  // A full disk must not crash the process and orphan Maestro: the log in memory still reaches the record.
  let logOk = true
  logStream.on('error', (e) => { logOk = false; deps.say(`maestro.log not written: ${e.message}`) })
  const child = deps.spawn(opts.maestroBin, opts.argv, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const onData = (c: Buffer) => { chunks.push(c); if (logOk) logStream.write(c); deps.out(c) }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  let iproxy: ChildProcess | undefined
  let iproxyTimer: NodeJS.Timeout | undefined
  let ended = false
  if (opts.device.platform === 'ios') {
    const port = String(opts.driverHostPort ?? DEFAULT_DRIVER_HOST_PORT)
    const udid = opts.device.udid
    iproxyTimer = setTimeout(() => {
      if (ended) return
      deps.say(`forwarding 127.0.0.1:${port} → ${udid}:${port} (iproxy)`)
      iproxy = deps.spawn('iproxy', [port, port, '-u', udid], { stdio: 'ignore' })
      iproxy.on('error', (e) => deps.say(`iproxy failed: ${e.message} — brew install libimobiledevice`))
    }, opts.iproxyDelayMs ?? 12_000)
  }
  // Last resort: this process exiting for any reason takes both children with it.
  const killAll = () => {
    if (iproxyTimer) clearTimeout(iproxyTimer)
    iproxy?.kill()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  process.once('exit', killAll)

  let interrupted = false
  const onAbort = () => { interrupted = true; child.kill('SIGINT') }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const exitCode = await new Promise<number>((resolve) => {
      child.on('error', (e) => { onData(Buffer.from(`could not start maestro: ${e.message}\n`)); resolve(127) })
      child.on('close', (code, sig) => resolve(code ?? (sig ? 130 : 1)))
    })
    return { exitCode, durationMs: Date.now() - started, log: Buffer.concat(chunks).toString('utf8'), interrupted }
  } finally {
    ended = true
    opts.signal?.removeEventListener('abort', onAbort)
    process.removeListener('exit', killAll)
    if (iproxyTimer) clearTimeout(iproxyTimer)
    iproxy?.kill()
    await new Promise<void>((r) => (logOk ? logStream.end(r) : r()))
  }
}

/** An image or log the run leaves in its folder, as the record will name it. */
export interface Artifact { name: string; file: string }

const IMAGE = /\.(png|jpe?g)$/i

/**
 * The names the relay accepts: letters, digits, `.`, `_`, `-`. Maestro's failure screenshot is
 * `screenshot-❌-<ms>-(c1.yaml).png`, so names are folded rather than refused, and a collision gets a number.
 */
export function artifactName(file: string, taken: Set<string>): string {
  const ext = path.extname(file).toLowerCase()
  const raw = path.basename(file, path.extname(file))
  const failure = /^screenshot-❌-/.test(raw)
  const folded = (failure ? raw.slice('screenshot-❌-'.length) : raw).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 100)
  const base = failure ? `maestro-failure-${folded}` : folded || 'file'
  let name = `${base}${ext}`
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}${ext}`
  taken.add(name)
  return name
}

/**
 * What to attach, most important first so a run that reaches the relay's file cap still keeps them: Maestro's log,
 * its failure screenshot, then the flow's screenshots (`takeScreenshot: ${OUTPUT_DIR}/…`) in the order taken. Only
 * files written since `sinceMs` count — a reused `--output-dir` still holds an earlier run's.
 */
export function collectArtifacts(outputDir: string, debugDir: string, logFile: string, sinceMs = 0): { artifacts: Artifact[]; lastScreen?: string } {
  const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }
  const images = (dir: string) => {
    try {
      return fs.readdirSync(dir).filter((f) => IMAGE.test(f)).map((f) => path.join(dir, f)).filter((f) => mtime(f) >= sinceMs)
    } catch { return [] }
  }
  const shots = images(outputDir).sort((a, b) => mtime(a) - mtime(b))
  const failure = images(debugDir).filter((f) => f.includes('❌'))
  const taken = new Set<string>()
  const files = [...(fs.existsSync(logFile) ? [logFile] : []), ...failure, ...shots]
  const artifacts: Artifact[] = files.map((file) => ({ name: artifactName(file, taken), file }))
  // The screen the flow ended on: where it failed, or the last one it took.
  const lastScreen = failure.at(-1) ?? shots.at(-1)
  return { artifacts, ...(lastScreen ? { lastScreen } : {}) }
}

/** The `commands-*.json` Maestro wrote into the flattened debug folder, parsed, or null when there is none. */
export function readCommandsLog(debugDir: string): unknown {
  try {
    const file = fs.readdirSync(debugDir).find((f) => f.startsWith('commands-') && f.endsWith('.json'))
    return file ? JSON.parse(fs.readFileSync(path.join(debugDir, file), 'utf8')) : null
  } catch { return null }
}

/** How long a run's own folder under the default `~/.tapflow/maestro-runs/` is kept. */
export const KEEP_RUN_FOLDERS_DAYS = 7

/**
 * Removes run folders under `root` older than `days` — the default output folders build up on the build machine
 * Only folders named the way this command names them are touched.
 */
export function pruneRunFolders(root: string, days = KEEP_RUN_FOLDERS_DAYS, now = Date.now()): void {
  let names: string[]
  try { names = fs.readdirSync(root) } catch { return }
  for (const n of names) {
    if (!/^\d{8}-\d{6}-.+-(android|ios)$/.test(n)) continue
    const dir = path.join(root, n)
    try {
      if (now - fs.statSync(dir).mtimeMs > days * 86_400_000) fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* gone meanwhile */ }
  }
}
