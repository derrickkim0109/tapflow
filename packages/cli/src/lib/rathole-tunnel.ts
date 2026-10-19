import { execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { sshExec, scpUpload, type SshConfig } from './ssh.js'
import { downloadBinary } from './download-binary.js'
import type { TunnelPlugin, TunnelPorts, TunnelStartResult } from './tunnel.js'

const REMOTE_DIR = '/tmp/tapflow'
const REMOTE_BINARY = `${REMOTE_DIR}/rathole`
const REMOTE_SERVER_TOML = `${REMOTE_DIR}/rathole-server.toml`
const REMOTE_PID_FILE = '/tmp/tapflow-rathole.pid'

function serverToml(serverAddr: string, token: string): string {
  return [
    '[server]',
    `bind_addr = "${serverAddr}"`,
    '',
    '[server.services.tapflow-relay]',
    `token = "${token}"`,
    `bind_addr = "0.0.0.0:4000"`,
  ].join('\n')
}

// The tunnel port, never the relay port: the relay counts a loopback connection on its own port as local
// and asks it for nothing, and every visitor of the public URL arrives here from loopback.
function clientToml(serverAddr: string, token: string, tunnelPort: number): string {
  return [
    '[client]',
    `remote_addr = "${serverAddr}"`,
    '',
    '[client.services.tapflow-relay]',
    `token = "${token}"`,
    `local_addr = "127.0.0.1:${tunnelPort}"`,
  ].join('\n')
}

const CLIENT_CONFIG_PREFIX = 'tapflow-rathole-client-'

/**
 * Stops rathole clients whose tapflow process is gone.
 *
 * The client is spawned attached, and only SIGINT stops it with its parent — a `kill <pid>` or a crash
 * leaves it running and reconnecting to the VPS, where it takes turns with the new client for the same
 * service. One left by a version before the tunnel port forwards to the relay port, where its visitors
 * count as local, so leaving it is leaving that hole open.
 *
 * **The process listing is the liveness check, not `kill(pid, 0)`.** The owner's pid is in the config
 * file name, and a bare liveness probe says yes for a pid the OS has handed to something else — on a Mac
 * with a long uptime that is how the orphan above survives every later start. So an owner counts as alive
 * only while a process with that pid still names **both** a node binary and tapflow, which is what every
 * launch of this CLI looks like: an interpreter path plus `bin/tapflow.js` or the checkout it runs from.
 *
 * Measured on one Mac, 896 processes: 8 rows (0.9%) name node *or* tapflow, 1 row (0.1%) names both. The
 * two errors are not symmetric — a client wrongly kept alive keeps forwarding to the relay port and says
 * nothing, while one wrongly killed drops a tunnel loudly and the operator restarts it — so the stricter
 * match is the right side to err on.
 */
function stopOrphanedClients(): void {
  let listing: string
  try {
    listing = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf-8' })
  } catch {
    return
  }
  const commands = new Map<number, string>()
  const clients: Array<{ pid: number; owner: number }> = []
  const clientPattern = new RegExp(`^\\S*rathole\\S*\\s+--client\\s+\\S*${CLIENT_CONFIG_PREFIX}(\\d+)\\.toml$`)
  for (const line of listing.split('\n')) {
    const row = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line)
    if (!row) continue
    const pid = Number(row[1])
    const command = row[2]
    commands.set(pid, command)
    const client = clientPattern.exec(command)
    if (client) clients.push({ pid, owner: Number(client[1]) })
  }
  for (const { pid, owner } of clients) {
    const ownerCommand = commands.get(owner)
    if (ownerCommand !== undefined && /node/i.test(ownerCommand) && /tapflow/i.test(ownerCommand)) continue
    try { process.kill(pid) } catch { /* already gone, or another account's */ }
  }
}

export interface RatholeTunnelOptions {
  serverAddr: string
  publicUrl: string
  token: string
  ssh?: SshConfig
}

export class RatholeTunnel implements TunnelPlugin {
  name = 'rathole'
  private proc: ChildProcess | null = null
  private clientConfigPath: string | null = null
  private serverConfigPath: string | null = null
  private sshCfg: SshConfig | null = null

  constructor(private opts: RatholeTunnelOptions) {
    this.sshCfg = opts.ssh ?? null
  }

  async setupServer(): Promise<void> {
    // Also here, not only in `start()`: `startConfiguredTunnel` calls this first, and either half can
    // fail on a binary download — leaving the runner to fall back to local-only with the orphan running.
    stopOrphanedClients()
    if (!this.sshCfg) return

    const ssh = this.sshCfg

    // 원격 디렉토리 생성
    await sshExec(ssh, `mkdir -p ${REMOTE_DIR}`)

    // 기존 server 프로세스 먼저 정리 (binary 파일 잠금 해제)
    await sshExec(ssh, `kill $(cat ${REMOTE_PID_FILE} 2>/dev/null) 2>/dev/null; true`)

    // rathole binary 확인 — PATH 또는 REMOTE_BINARY 경로
    const hasRathole = await sshExec(ssh, `which rathole 2>/dev/null || ls ${REMOTE_BINARY} 2>/dev/null || echo ""`).then(
      (out) => out.length > 0,
      () => false
    )
    if (!hasRathole) {
      const vpsArch = await sshExec(ssh, 'uname -m').catch(() => 'x86_64')
      const linuxBinary = await downloadBinary('linux', vpsArch.trim())
      await scpUpload(ssh, linuxBinary, REMOTE_BINARY)
      await sshExec(ssh, `chmod +x ${REMOTE_BINARY}`)
    }

    const remoteRathole = hasRathole
      ? (await sshExec(ssh, `which rathole 2>/dev/null || echo "${REMOTE_BINARY}"`).catch(() => REMOTE_BINARY)).trim()
      : REMOTE_BINARY

    // server.toml 생성 → 업로드
    const toml = serverToml(this.opts.serverAddr, this.opts.token)
    this.serverConfigPath = path.join(os.tmpdir(), `tapflow-rathole-server-${process.pid}.toml`)
    fs.writeFileSync(this.serverConfigPath, toml, 'utf-8')
    await scpUpload(ssh, this.serverConfigPath, REMOTE_SERVER_TOML)
    await sshExec(
      ssh,
      `nohup ${remoteRathole} --server ${REMOTE_SERVER_TOML} > /tmp/tapflow-rathole.log 2>&1 & echo $! > ${REMOTE_PID_FILE}`
    )
  }

  async start({ tunnelPort }: TunnelPorts): Promise<TunnelStartResult> {
    if (!this.opts.token) throw new Error('TAPFLOW_TUNNEL_TOKEN is required for tunnel mode')
    if (!this.opts.serverAddr) throw new Error('tunnel.serverAddr is required in tapflow.config.json')

    const darwinBinary = await downloadBinary('darwin', process.arch)

    stopOrphanedClients()
    const toml = clientToml(this.opts.serverAddr, this.opts.token, tunnelPort)
    this.clientConfigPath = path.join(os.tmpdir(), `${CLIENT_CONFIG_PREFIX}${process.pid}.toml`)
    fs.mkdirSync(path.dirname(this.clientConfigPath), { recursive: true })
    fs.writeFileSync(this.clientConfigPath, toml, 'utf-8')

    return new Promise((resolve, reject) => {
      this.proc = spawn(darwinBinary, ['--client', this.clientConfigPath!], { stdio: ['ignore', 'ignore', 'pipe'] })
      let resolved = false

      this.proc.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString()
        if (!resolved && (line.includes('established') || line.includes('Tunnel') || line.includes('Connected') || line.includes('INFO'))) {
          resolved = true
          resolve({ publicUrl: this.opts.publicUrl })
        }
      })

      // stderr에 아무것도 안 나와도 프로세스가 살아있으면 연결된 것으로 간주
      setTimeout(() => {
        if (!resolved && this.proc && !this.proc.killed) {
          resolved = true
          resolve({ publicUrl: this.opts.publicUrl })
        }
      }, 3000)

      this.proc.on('exit', (code) => {
        if (!resolved) reject(new Error(`rathole process exited with code ${code}`))
      })
    })
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    if (this.clientConfigPath) {
      try { fs.unlinkSync(this.clientConfigPath) } catch { /* already gone */ }
      this.clientConfigPath = null
    }
    if (this.serverConfigPath) {
      try { fs.unlinkSync(this.serverConfigPath) } catch { /* already gone */ }
      this.serverConfigPath = null
    }
    if (this.sshCfg) {
      await sshExec(this.sshCfg, `kill $(cat ${REMOTE_PID_FILE} 2>/dev/null) 2>/dev/null; rm -f ${REMOTE_PID_FILE}; true`).catch(() => {})
    }
  }
}
