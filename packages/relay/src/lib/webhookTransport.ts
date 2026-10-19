import dns from 'dns'
import http from 'http'
import https from 'https'
import net from 'net'
import { isBlockedAddress } from './webhookUrl.js'

// Minimal fetch shape so tests can inject a fake without pulling in DOM lib types.
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>

const systemLookup: LookupFn = (hostname) => dns.promises.lookup(hostname, { all: true })

// Only drained, never read for meaning, so a receiver can't make the relay buffer a large reply.
const MAX_RESPONSE_BYTES = 64 * 1024

export class BlockedDestinationError extends Error {
  constructor(host: string, address: string) {
    super(`${host} resolves to ${address}, a loopback or metadata address`)
    this.name = 'BlockedDestinationError'
  }
}

type LookupCallback = (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void

/**
 * Webhook delivery transport. Unlike global fetch it judges the addresses a hostname resolves to, and
 * the socket connects only to addresses that passed: the check runs inside the connection's own
 * `lookup`, so there is no second resolution for DNS rebinding to answer differently. It never
 * follows redirects — node's http client doesn't — so a 3xx comes back as a non-ok response instead of
 * a hop to wherever the receiver points.
 */
export function createSafeFetch(
  opts: { lookup?: LookupFn; isBlocked?: (ip: string) => boolean } = {}
): FetchLike {
  const resolve = opts.lookup ?? systemLookup
  const isBlocked = opts.isBlocked ?? isBlockedAddress

  const gatedLookup = (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    resolve(hostname).then(
      (answers) => {
        if (answers.length === 0) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '')
        // Blocked answers are dropped rather than failing the name: macOS answers a LAN host's `.local`
        // name with its fe80:: address next to its 192.168.x one, and that host is a webhook receiver this
        // feature exists for. Dropping is safe because only what survives is handed to the socket.
        const permitted = answers.filter((a) => !isBlocked(a.address))
        if (permitted.length === 0) return callback(new BlockedDestinationError(hostname, answers[0].address), '')
        const wanted = options.family === 4 || options.family === 6 ? permitted.filter((a) => a.family === options.family) : permitted
        if (wanted.length === 0) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '')
        if (options.all) return callback(null, wanted)
        callback(null, wanted[0].address, wanted[0].family)
      },
      (err: Error) => callback(err, '')
    )
  }

  return (url, init) =>
    new Promise((resolvePromise, reject) => {
      const u = new URL(url)
      const host = u.hostname.replace(/^\[|\]$/g, '')
      // net.connect skips `lookup` for an IP literal, so a literal is judged here.
      if (net.isIP(host) && isBlocked(host)) return reject(new BlockedDestinationError(host, host))
      // A row written before registration refused these must not leak them as an Authorization header.
      if (u.username || u.password) return reject(new Error('webhook URL must not contain credentials'))

      const client = u.protocol === 'https:' ? https : http
      const req = client.request(
        u,
        {
          method: init.method,
          // fetch sent a User-Agent and Accept on its own, and edge WAFs commonly refuse a request with no
          // User-Agent at all.
          headers: {
            'User-Agent': 'tapflow-webhook',
            Accept: '*/*',
            ...init.headers,
            'Content-Length': String(Buffer.byteLength(init.body)),
          },
          lookup: gatedLookup as unknown as net.LookupFunction,
          signal: init.signal,
          // A pooled socket would skip the lookup; every delivery resolves and is judged afresh.
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (c: Buffer) => {
            if (size < MAX_RESPONSE_BYTES) chunks.push(c)
            size += c.length
          })
          res.on('error', reject)
          res.on('end', () => {
            const status = res.statusCode ?? 0
            const body = Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString()
            resolvePromise({ ok: status >= 200 && status < 300, status, text: async () => body })
          })
        }
      )
      req.on('error', reject)
      req.end(init.body)
    })
}
