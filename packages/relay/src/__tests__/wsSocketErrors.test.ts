import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'

// An error on one client's WebSocket ends that socket and nothing else. The relay's connections had no
// `'error'` listener, and an EventEmitter with none throws.

/** Completes a WebSocket handshake by hand, then writes `frame` raw — something no well-behaved client sends. */
function sendRawFrame(port: number, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let upgraded = false
    sock.on('data', (chunk) => {
      if (!upgraded && chunk.toString().startsWith('HTTP/1.1 101')) {
        upgraded = true
        sock.write(frame)
      }
    })
    sock.on('close', () => resolve())
    sock.on('error', () => resolve())
    setTimeout(() => { sock.destroy(); if (upgraded) resolve(); else reject(new Error('no upgrade')) }, 2000)
  })
}

function connects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => { ws.close(); resolve(true) })
    ws.on('error', () => resolve(false))
  })
}

describe('RelayServer — an error on one WebSocket', () => {
  let tmpDir: string
  let server: RelayServer | null = null
  const uncaught: unknown[] = []
  const onUncaught = (err: unknown) => { uncaught.push(err) }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-ws-errors-'))
    initDb(path.join(tmpDir, 'test.db'))
    process.on('uncaughtException', onUncaught)
  })
  afterAll(() => {
    process.off('uncaughtException', onUncaught)
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })
  afterEach(async () => { await server?.stop(); server = null; uncaught.length = 0 })

  // A masked text frame with RSV1 set, which no extension was negotiated for.
  const RSV1_FRAME = Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00])
  // A masked text frame whose payload is not UTF-8.
  const BAD_UTF8_FRAME = Buffer.from([0x81, 0x81, 0x00, 0x00, 0x00, 0x00, 0xff])

  it.each([['an invalid frame header', RSV1_FRAME], ['a text frame that is not UTF-8', BAD_UTF8_FRAME]])(
    'survives %s, and keeps serving',
    async (_name, frame) => {
      server = new RelayServer({ port: 0 })
      await server.start()
      const port = (server.address() as { port: number }).port
      await sendRawFrame(port, frame)
      await new Promise((r) => setTimeout(r, 50))
      expect(uncaught, 'the error escaped the socket').toEqual([])
      expect(await connects(port), 'the relay stopped serving').toBe(true)
    },
  )
})
