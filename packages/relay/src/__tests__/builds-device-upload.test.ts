import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'
import { buildTargetOf, machOSliceTargets } from '../api/builds'
import { makeAppZip, writeZipFixture, type ZipFixtureEntry } from './helpers/zipFixture'
import { assertArchiveTools } from './helpers/archivePrereqs'

// ── tiny Mach-O fixtures ───────────────────────────────────────────────────

const CPU_X86_64 = 0x01000007
const CPU_ARM64 = 0x0100000c
const PLATFORM_IOS = 2
const PLATFORM_IOSSIMULATOR = 7

type SliceSpec = { cputype: number; platform?: number; versionMinIos?: boolean }

/** A 64-bit thin Mach-O header with either an LC_BUILD_VERSION or an LC_VERSION_MIN_IPHONEOS command. */
function thinMachO(spec: SliceSpec): Buffer {
  const cmds: Buffer[] = []
  if (spec.platform !== undefined) {
    const c = Buffer.alloc(24)
    c.writeUInt32LE(0x32, 0) // LC_BUILD_VERSION
    c.writeUInt32LE(24, 4)
    c.writeUInt32LE(spec.platform, 8)
    cmds.push(c)
  }
  if (spec.versionMinIos) {
    const c = Buffer.alloc(16)
    c.writeUInt32LE(0x25, 0) // LC_VERSION_MIN_IPHONEOS
    c.writeUInt32LE(16, 4)
    cmds.push(c)
  }
  const body = Buffer.concat(cmds)
  const h = Buffer.alloc(32)
  h.writeUInt32LE(0xfeedfacf, 0)
  h.writeUInt32LE(spec.cputype, 4)
  h.writeUInt32LE(2, 12) // MH_EXECUTE
  h.writeUInt32LE(cmds.length, 16)
  h.writeUInt32LE(body.length, 20)
  return Buffer.concat([h, body])
}

/** A universal (fat) binary whose slices start on 64-byte boundaries. */
function fatMachO(specs: SliceSpec[]): Buffer {
  const slices = specs.map(thinMachO)
  const header = Buffer.alloc(8 + 20 * slices.length)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt32BE(slices.length, 4)
  const parts: Buffer[] = [header]
  let offset = header.length
  slices.forEach((s, i) => {
    const pad = (64 - (offset % 64)) % 64
    parts.push(Buffer.alloc(pad))
    offset += pad
    header.writeUInt32BE(specs[i].cputype, 8 + i * 20)
    header.writeUInt32BE(offset, 8 + i * 20 + 8)
    header.writeUInt32BE(s.length, 8 + i * 20 + 12)
    parts.push(s)
    offset += s.length
  })
  return Buffer.concat(parts)
}

const DEVICE_BIN = thinMachO({ cputype: CPU_ARM64, platform: PLATFORM_IOS })
const SIM_BIN = thinMachO({ cputype: CPU_ARM64, platform: PLATFORM_IOSSIMULATOR })

function plist(executable: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.device</string>
  <key>CFBundleShortVersionString</key><string>3.2.0</string>
  <key>CFBundleVersion</key><string>77</string>
  <key>CFBundleDisplayName</key><string>Device App</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
</dict></plist>`
}

/** An .ipa: `Payload/<bundle>.app/` holding Info.plist and the executable it names. */
function ipa(dir: string, bundle: string, executable: string, binary: Buffer): string {
  const entries: ZipFixtureEntry[] = [
    { name: 'Payload/' },
    { name: `Payload/${bundle}.app/` },
    { name: `Payload/${bundle}.app/Info.plist`, data: plist(executable) },
    { name: `Payload/${bundle}.app/${executable}`, data: binary },
  ]
  return writeZipFixture(path.join(dir, `${bundle}-${Date.now()}.ipa`), entries)
}

function appZip(dir: string, name: string, binary: Buffer): string {
  return writeZipFixture(path.join(dir, `${name}.app.zip`), [
    { name: `${name}.app/` },
    { name: `${name}.app/Info.plist`, data: plist(name) },
    { name: `${name}.app/${name}`, data: binary },
  ])
}

// ── HTTP plumbing (as in builds-tar-upload.test.ts) ────────────────────────

type BuildJson = {
  id?: number; error?: string; bundle_id?: string; version_name?: string; build_number?: string
  name?: string; platform?: string; target?: string | null; file_path?: string
}

function multipart(boundary: string, filename: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from('Content-Type: application/octet-stream\r\n\r\n'),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
}

function request(port: number, method: string, urlPath: string, cookie: string, body?: Buffer, boundary?: string): Promise<{ status: number; body: unknown }> {
  const headers: http.OutgoingHttpHeaders = { Cookie: cookie }
  if (body) {
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
    headers['Content-Length'] = body.length
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

// ── unit: slice classification ─────────────────────────────────────────────

describe('machOSliceTargets', () => {
  // Mutation: swap PLATFORM_IOS and PLATFORM_IOSSIMULATOR, and each expectation flips.
  it('reads the platform from LC_BUILD_VERSION, not the architecture', () => {
    expect(machOSliceTargets(DEVICE_BIN)).toEqual({ simulator: false, device: true })
    expect(machOSliceTargets(SIM_BIN)).toEqual({ simulator: true, device: false })
  })

  // Mutation: classify only the first fat slice, and the device half disappears.
  it('reports every slice of a universal binary', () => {
    const fat = fatMachO([
      { cputype: CPU_X86_64, platform: PLATFORM_IOSSIMULATOR },
      { cputype: CPU_ARM64, platform: PLATFORM_IOS },
    ])
    expect(machOSliceTargets(fat)).toEqual({ simulator: true, device: true })
  })

  // Mutation: check LC_VERSION_MIN_IPHONEOS before the CPU type, and the Intel simulator slice reads as a device.
  it('classifies pre-LC_BUILD_VERSION binaries by CPU type', () => {
    expect(machOSliceTargets(thinMachO({ cputype: CPU_X86_64, versionMinIos: true }))).toEqual({ simulator: true, device: false })
    expect(machOSliceTargets(thinMachO({ cputype: CPU_ARM64, versionMinIos: true }))).toEqual({ simulator: false, device: true })
  })

  // Mutation: return a default target for an unreadable binary, and the lipo fallback never runs.
  it('returns null for a header it cannot classify', () => {
    expect(machOSliceTargets(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBeNull()
    expect(machOSliceTargets(thinMachO({ cputype: CPU_ARM64 }))).toBeNull()
  })
})

describe('buildTargetOf', () => {
  // Mutation: derive the target from anything but the kind and the device marker.
  it('derives the target from the stored file name', () => {
    expect(buildTargetOf('/x/builds/1700000000000-abcdef12_App.ipa')).toBe('device')
    expect(buildTargetOf('/x/builds/1700000000000-abcdef12.device_App.app.zip')).toBe('device')
    expect(buildTargetOf('/x/builds/1700000000000-abcdef12_App.app.zip')).toBe('simulator')
    expect(buildTargetOf('/x/builds/1700000000000-abcdef12_App.tar.gz')).toBe('simulator')
    expect(buildTargetOf('/x/builds/1700000000000-abcdef12_app.apk')).toBeNull()
  })

  // Mutation: match the marker anywhere in the name, and an uploaded file that happens to contain it reads as a device build.
  it('only honours the marker in the position the relay writes it', () => {
    expect(buildTargetOf('/x/builds/1700000000000-abcdef12_.device_App.app.zip')).toBe('simulator')
  })
})

// ── upload ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/builds — device builds', () => {
  let server: RelayServer
  let port: number
  let dbDir: string
  let fixtureDir: string
  let uploadsDir: string
  let cookie: string

  beforeAll(() => {
    assertArchiveTools(['unzip'])
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-device-db-'))
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-device-fix-'))
    initDb(path.join(dbDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
  })

  // Guarded: assertArchiveTools above can throw before the dirs are assigned.
  afterAll(() => {
    closeDb()
    if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true })
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-device-up-'))
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(uploadsDir, { recursive: true, force: true })
  })

  const leftover = () => {
    const dir = path.join(uploadsDir, 'builds')
    return fs.existsSync(dir) ? fs.readdirSync(dir) : []
  }
  const upload = (filename: string, file: string) =>
    request(port, 'POST', '/api/v1/builds', cookie, multipart('D', filename, fs.readFileSync(file)), 'D')
      .then((r) => ({ status: r.status, body: r.body as BuildJson }))

  // Mutation: keep refusing kind === 'ipa', or read the plist from the zip root instead of Payload/.
  it('accepts an .ipa with a device slice, with its metadata and target', async () => {
    const r = await upload('Device.ipa', ipa(fixtureDir, 'Device', 'Device', DEVICE_BIN))
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({
      bundle_id: 'com.example.device', version_name: '3.2.0', build_number: '77',
      name: 'Device App', platform: 'ios', target: 'device',
    })
    expect(r.body.file_path).toBeUndefined()

    // Mutation: drop `target` from the GET or the list query.
    const one = await request(port, 'GET', `/api/v1/builds/${r.body.id}`, cookie)
    expect((one.body as BuildJson).target).toBe('device')
    const list = await request(port, 'GET', '/api/v1/builds', cookie)
    const items = (list.body as { items: BuildJson[] }).items
    expect(items.find((b) => b.id === r.body.id)?.target).toBe('device')
    expect(items.every((b) => b.file_path === undefined)).toBe(true)
  })

  // Mutation: read the executable by the bundle's name instead of CFBundleExecutable.
  it('finds the executable an .ipa names in CFBundleExecutable', async () => {
    const r = await upload('Spaced.ipa', ipa(fixtureDir, 'Device App', 'DeviceApp', DEVICE_BIN))
    expect(r.status).toBe(201)
    expect(r.body.target).toBe('device')
  })

  // Mutation: accept any classifiable slice for an .ipa (or skip the check), and a simulator-only .ipa is stored.
  it('rejects an .ipa that has only a simulator slice, leaving no file', async () => {
    const r = await upload('Sim.ipa', ipa(fixtureDir, 'Sim', 'Sim', SIM_BIN))
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/device \(iphoneos/)
    expect(leftover()).toEqual([])
  })

  // Mutation: let an unclassifiable executable through for an .ipa the way .app.zip falls back to lipo.
  it('rejects an .ipa whose executable cannot be classified', async () => {
    const r = await upload('Stub.ipa', ipa(fixtureDir, 'Stub', 'Stub', Buffer.from([0xcf, 0xfa, 0xed, 0xfe])))
    expect(r.status).toBe(400)
    expect(leftover()).toEqual([])
  })

  // Mutation: look for the .app at the zip root for an .ipa too.
  it('rejects an .ipa with no Payload/*.app', async () => {
    const r = await upload('Flat.ipa', makeAppZip(fixtureDir, 'Flat', plist('Flat')))
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Payload/)
    expect(leftover()).toEqual([])
  })

  // Mutation: keep rejecting a device-only .app.zip, or store it without the device marker.
  it('accepts a device-only .app.zip as a device build', async () => {
    const r = await upload('DevZip.app.zip', appZip(fixtureDir, 'DevZip', DEVICE_BIN))
    expect(r.status).toBe(201)
    expect(r.body.target).toBe('device')
    expect(leftover()).toHaveLength(1)
    expect(leftover()[0]).toMatch(/^\d+-[0-9a-f]{8}\.device_DevZip\.app\.zip$/)
  })

  // Mutation: prefer the device slice when both are present, or mark a simulator build.
  it('keeps a simulator .app.zip a simulator build', async () => {
    const universal = fatMachO([
      { cputype: CPU_ARM64, platform: PLATFORM_IOSSIMULATOR },
      { cputype: CPU_ARM64, platform: PLATFORM_IOS },
    ])
    const sim = await upload('SimZip.app.zip', appZip(fixtureDir, 'SimZip', SIM_BIN))
    const both = await upload('Both.app.zip', appZip(fixtureDir, 'Both', universal))
    expect(sim.status).toBe(201)
    expect(sim.body.target).toBe('simulator')
    expect(both.status).toBe(201)
    expect(both.body.target).toBe('simulator')
    expect(leftover().some((f) => f.includes('.device_'))).toBe(false)
  })

  // Mutation: reject an unclassifiable executable outright, and every existing fixture-sized upload breaks.
  it('still accepts a .app.zip whose executable cannot be classified, as a simulator build', async () => {
    const r = await upload('Stub.app.zip', makeAppZip(fixtureDir, 'StubZip', plist('StubZip')))
    expect(r.status).toBe(201)
    expect(r.body.target).toBe('simulator')
  })
})
