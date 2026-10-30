import http from 'http'
import fs from 'fs'
import zlib from 'zlib'
import path from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import busboy from 'busboy'
import { getDb } from '../db.js'
import { assertCanWrite, requireAuth, requireBuildAuth } from '../middleware/auth.js'
import { json, readJson } from '../router.js'
import { pipeUpload, unlinkSafe } from '../lib/uploads.js'
import { deliverWebhooks } from '../lib/webhooks.js'
import { deleteBuildsWithDependents, type BuildFileDirs } from '../lib/buildDeletion.js'

// ── archive kind ───────────────────────────────────────────────────────────

// path.extname('app.tar.gz') === '.gz', so compound extensions can't be detected
// with extname alone. Match the full suffix, longest first.
export type BuildFileKind = 'ios-zip' | 'ios-tar' | 'android' | 'ipa' | 'aab' | 'unknown'

export function buildFileKind(filename: string): BuildFileKind {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'ios-tar'
  if (lower.endsWith('.zip')) return 'ios-zip'
  if (lower.endsWith('.apk')) return 'android'
  if (lower.endsWith('.ipa')) return 'ipa'
  if (lower.endsWith('.aab')) return 'aab'
  return 'unknown'
}

/** 알려진 아카이브 확장자를 벗긴 베이스 이름(메타 부재 시 앱 이름 폴백용). */
function stripArchiveExt(filename: string): string {
  const base = path.basename(filename)
  const lower = base.toLowerCase()
  for (const ext of ['.tar.gz', '.tgz', '.app.zip', '.zip', '.apk', '.ipa', '.aab']) {
    if (lower.endsWith(ext)) return base.slice(0, base.length - ext.length)
  }
  return base.replace(/\.[^.]+$/, '')
}

// ── zip / plist helpers ────────────────────────────────────────────────────

function parseXmlPlist(xml: string): Record<string, string> {
  const result: Record<string, string> = {}
  const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) result[m[1]] = m[2]
  return result
}

type AppInfo = {
  bundleId: string | null
  versionName: string | null
  buildNumber: string | null
  appName: string | null
  /** CFBundleExecutable — the main binary's file name inside the .app. */
  executable: string | null
}

/** Info.plist Buffer(xml 또는 bplist)에서 CFBundle* 를 파싱한다. 아카이브 종류와 무관. */
function parseInfoPlist(plistBuf: Buffer): AppInfo {
  let parsed: Record<string, string>

  if (plistBuf.subarray(0, 6).toString() === 'bplist') {
    // binary plist — plutil 시도 (macOS only; 없으면 빈 결과)
    const plutil = spawnSync('plutil', ['-convert', 'xml1', '-o', '-', '-'], {
      input: plistBuf,
      encoding: 'utf8',
    })
    if (plutil.status !== 0) return { bundleId: null, versionName: null, buildNumber: null, appName: null, executable: null }
    parsed = parseXmlPlist(plutil.stdout as string)
  } else {
    parsed = parseXmlPlist(plistBuf.toString('utf8'))
  }

  return {
    bundleId: parsed['CFBundleIdentifier'] ?? null,
    versionName: parsed['CFBundleShortVersionString'] ?? null,
    buildNumber: parsed['CFBundleVersion'] ?? null,
    appName: parsed['CFBundleDisplayName'] ?? parsed['CFBundleName'] ?? null,
    executable: parsed['CFBundleExecutable'] ?? null,
  }
}

// 아카이브 리스트/엔트리 읽기의 stdout 상한. 기본 maxBuffer(1MB)는 파일 많은 큰 .app
// 리스트나 큰 실행 바이너리에서 넘쳐(ENOBUFS, status=null) 검증을 스킵/오탐시킬 수 있어
// 넉넉히 잡는다. 초과 시엔 각 호출부가 fail-closed(거절)로 처리한다.
const ARCHIVE_READ_MAXBUFFER = 256 * 1024 * 1024 // 256 MB

/** zip 내 루트 수준 *.app 디렉토리 이름을 찾는다. 없으면 null. */
function findAppDirInZip(zipPath: string): string | null {
  const list = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8', maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (list.status !== 0) return null
  // "  12345  2024-01-01 00:00:00  MyApp.app/"  형태를 매칭 (앱 이름에 공백 포함 가능)
  // HH:MM 시간 컬럼을 기준점으로 삼아 filename 컬럼만 캡처
  const re = /\d{2}:\d{2}\s+(\S[^/\n]*\.app)\/\s*$/m
  const m = re.exec(list.stdout as string)
  if (!m) return null
  // 루트 레벨만 (슬래시 미포함)
  const candidate = m[1]
  return candidate.includes('/') ? null : candidate
}

/** .app.zip에서 앱 메타데이터를 추출한다. 구조 오류 시 null. */
export function extractAppZipInfo(zipPath: string): AppInfo | null {
  const appDir = findAppDirInZip(zipPath)
  if (!appDir) return null

  const extract = spawnSync('unzip', ['-p', zipPath, `${appDir}/Info.plist`], { maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (extract.status !== 0 || !extract.stdout) return null

  return parseInfoPlist(extract.stdout as Buffer)
}

// ── .ipa helpers (device builds) ────────────────────────────────────────────

/** The `Payload/<Name>.app` directory of an .ipa, or null when there is none. */
function findAppDirInIpa(ipaPath: string): string | null {
  const list = spawnSync('unzip', ['-l', ipaPath], { encoding: 'utf8', maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (list.status !== 0) return null
  // Matches any entry under the bundle, so an .ipa zipped without explicit directory entries still resolves.
  const m = /\d{2}:\d{2}\s+Payload\/([^/\n]+\.app)\//m.exec(list.stdout as string)
  return m ? `Payload/${m[1]}` : null
}

/** App metadata from an .ipa's `Payload/*.app/Info.plist`. Null on a structural error. */
export function extractIpaInfo(ipaPath: string): AppInfo | null {
  const appDir = findAppDirInIpa(ipaPath)
  if (!appDir) return null
  const extract = spawnSync('unzip', ['-p', ipaPath, `${appDir}/Info.plist`], { maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (extract.status !== 0 || !extract.stdout?.length) return null
  return parseInfoPlist(extract.stdout as Buffer)
}

// ── tar.gz helpers (EAS 시뮬레이터 산출물) ──────────────────────────────────
// tar 는 순차 스캔이라 zip 처럼 랜덤액세스가 어렵다. tar 바이너리가 이름을 해석하게
// 두어(-tzf/-xzOf) PAX/GNU long-name 도 안전하게 처리한다 (손으로 파싱하지 않음).

/** tar.gz 내 루트 수준 *.app 디렉토리 이름을 찾는다. 없으면 null. */
function findAppDirInTar(tarPath: string): string | null {
  const list = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8', maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (list.status !== 0) return null
  // 최상위 "Foo.app/..." 만 — 프레임워크 내부 중첩 .app/Info.plist 오탐 방지.
  const re = /^(?:\.\/)?([^/]+\.app)\//m
  const m = re.exec(list.stdout as string)
  return m ? m[1] : null
}

/** tar.gz 안 특정 엔트리를 stdout Buffer 로 읽는다. 실패 시 null. */
function readTarEntry(tarPath: string, entry: string): Buffer | null {
  // 아카이브가 "./Foo.app/..." 형태일 수 있어 두 후보를 시도한다.
  for (const name of [entry, `./${entry}`]) {
    const r = spawnSync('tar', ['-xzOf', tarPath, name], { maxBuffer: ARCHIVE_READ_MAXBUFFER })
    if (r.status === 0 && r.stdout && (r.stdout as Buffer).length) return r.stdout as Buffer
  }
  return null
}

/** .tar.gz 안 *.app/Info.plist 에서 앱 메타데이터를 추출한다. 구조 오류 시 null. */
export function extractAppTarInfo(tarPath: string): AppInfo | null {
  const appDir = findAppDirInTar(tarPath)
  if (!appDir) return null

  const buf = readTarEntry(tarPath, `${appDir}/Info.plist`)
  if (!buf) return null

  return parseInfoPlist(buf)
}

// ── archive-agnostic dispatch ───────────────────────────────────────────────

function findAppDir(filePath: string): string | null {
  const kind = buildFileKind(filePath)
  if (kind === 'ios-tar') return findAppDirInTar(filePath)
  if (kind === 'ipa') return findAppDirInIpa(filePath)
  return findAppDirInZip(filePath)
}

export function extractAppInfo(filePath: string): AppInfo | null {
  const kind = buildFileKind(filePath)
  if (kind === 'ios-tar') return extractAppTarInfo(filePath)
  if (kind === 'ipa') return extractIpaInfo(filePath)
  return extractAppZipInfo(filePath)
}

/** Resolve aapt from the SDK build-tools (any version). Candidate list mirrors `tapflow doctor` so the two agree; falls back to PATH. */
export function findAapt(): string | null {
  const candidates = [
    process.env['ANDROID_HOME'],
    process.env['ANDROID_SDK_ROOT'],
    `${process.env['HOME']}/Library/Android/sdk`, // macOS
    `${process.env['HOME']}/Android/Sdk`,          // Linux
  ].filter(Boolean) as string[]

  for (const androidHome of candidates) {
    const buildToolsDir = path.join(androidHome, 'build-tools')
    if (!fs.existsSync(buildToolsDir)) continue
    const versions = fs.readdirSync(buildToolsDir)
      .filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const p = (s: string) => s.split('.').map(Number)
        const [am, ai, ap] = p(a); const [bm, bi, bp] = p(b)
        return bm - am || bi - ai || bp - ap
      })
    for (const v of versions) {
      const aapt = path.join(buildToolsDir, v, 'aapt')
      if (fs.existsSync(aapt)) return aapt
    }
  }

  // PATH fallback — relay 프로세스가 ANDROID_HOME을 상속받지 못한 경우
  const which = spawnSync('which', ['aapt'], { encoding: 'utf8' })
  if (which.status === 0) return (which.stdout as string).trim()

  return null
}

/** Extract APK metadata via `aapt dump badging`. aaptFound=false means build-tools (aapt) is missing — extraction is impossible. */
export function extractApkInfo(apkPath: string): {
  bundleId: string | null; versionName: string | null
  buildNumber: string | null; appName: string | null
  aaptFound: boolean
} {
  const aapt = findAapt()
  const empty = { bundleId: null, versionName: null, buildNumber: null, appName: null, aaptFound: aapt !== null }
  if (!aapt) return empty
  const r = spawnSync(aapt, ['dump', 'badging', apkPath], { encoding: 'utf8' })
  if (r.status !== 0) return empty
  const out = r.stdout as string
  return {
    bundleId:    out.match(/package: name='([^']+)'/)?.[1] ?? null,
    versionName: out.match(/versionName='([^']+)'/)?.[1] ?? null,
    buildNumber: out.match(/versionCode='([^']+)'/)?.[1] ?? null,
    appName:     out.match(/application-label(?:-\w+)?:'([^']+)'/)?.[1] ?? null,
    aaptFound: true,
  }
}

export type UploadRoute =
  | { kind: 'ok'; appId: number }
  | { kind: 'app-not-found' }
  | { kind: 'reject-null-bundle' }

/**
 * Decide which app row a build belongs to.
 * An unidentifiable build (no bundleId — e.g. aapt missing / corrupt archive) is never used
 * as evidence of app identity: it must not be absorbed into a caller-named app nor promote it
 * to platform 'both'. With app_id → reject; without → isolate under `__unknown__`.
 * The reject keys off `isAndroidArtifact` (derived from the uploaded file, not the caller-supplied
 * `platform` field) so an APK sent with `platform=ios` can't bypass the guard. iOS degrades
 * gracefully instead, mirroring the lipo/findAapt Linux-relay precedent.
 */
export function routeUploadToApp(
  db: ReturnType<typeof getDb>,
  opts: { appId: number | null; bundleId: string | null; appName: string; platform: string; isAndroidArtifact: boolean },
): UploadRoute {
  const { appId, bundleId, appName, platform, isAndroidArtifact } = opts

  if (appId != null) {
    const app = db.prepare('SELECT id, bundle_id_key, platform FROM apps WHERE id = ?')
      .get(appId) as { id: number; bundle_id_key: string | null; platform: string } | undefined
    if (!app) return { kind: 'app-not-found' }
    if (bundleId === null && isAndroidArtifact) return { kind: 'reject-null-bundle' }
    // A bundle_id that differs from the named app routes to (or creates) the app for that bundle_id.
    if (bundleId !== null && app.bundle_id_key && app.bundle_id_key !== bundleId) {
      return { kind: 'ok', appId: upsertApp(appName, bundleId, platform) }
    }
    if (app.platform !== 'both' && app.platform !== platform) {
      db.prepare('UPDATE apps SET platform = ? WHERE id = ?').run('both', appId)
    }
    // Sets the key without asking whether another row holds it, so it relies on there being no row with
    // an empty key to reach: POST /apps requires one and upsertApp always supplies one. A way to create an
    // app without a bundle ID would reopen a second row per key here (see POST /apps' 409 in apps.ts).
    if (!app.bundle_id_key && bundleId !== null) {
      db.prepare('UPDATE apps SET bundle_id_key = ? WHERE id = ?').run(bundleId, appId)
    }
    return { kind: 'ok', appId }
  }

  return { kind: 'ok', appId: upsertApp(appName, bundleId ?? '__unknown__', platform) }
}

/** Rejection message for an app_id-targeted APK upload whose metadata (bundleId) couldn't be read. Calls out a missing build-tools install specifically. */
function nullBundleMessage(aaptFound: boolean): string {
  if (!aaptFound) {
    return 'Android build-tools (aapt) not found on the relay host, so the APK package name could not be read. Install build-tools (run `tapflow setup android`) and retry, or upload without app_id to file it under a separate app.'
  }
  return 'Could not read the package name from the APK — it may be corrupt or not a valid APK.'
}

/**
 * Mach-O 바이너리 Buffer에 lipo -info 를 돌려 시뮬레이터 슬라이스 존재를 확인한다.
 * lipo 미설치(Linux relay) 시 null 반환 → 검증 skip.
 */
function lipoHasSimSlice(binaryBuf: Buffer): boolean | null {
  const tmpBin = path.join(tmpdir(), `tapflow-lipo-${randomUUID()}`)
  fs.writeFileSync(tmpBin, binaryBuf)
  try {
    const lipo = spawnSync('lipo', ['-info', tmpBin], { encoding: 'utf8' })
    if (lipo.status !== 0) return null // lipo 없음 → skip
    const out = (lipo.stdout as string).toLowerCase()
    // x86_64 = Intel 시뮬레이터, arm64 = Apple Silicon 시뮬레이터 또는 device
    // arm64만 있는 경우는 구분 불가 → 통과 허용 (install 단계에서 실패 시 명확한 에러)
    return out.includes('x86_64') || out.includes('arm64')
  } finally {
    try { fs.unlinkSync(tmpBin) } catch { /* ignore */ }
  }
}

// ── Mach-O slice targets ───────────────────────────────────────────────────
// `lipo -info` names architectures only, and arm64 is both an Apple Silicon simulator slice and a device slice.
// The platform a slice was linked for is in its load commands, so read those directly. Pure JS, so it also runs
// on a Linux relay where lipo does not exist.

export type BuildTarget = 'simulator' | 'device'
export type SliceTargets = { simulator: boolean; device: boolean }

const MH_MAGIC = 0xfeedface
const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const CPU_TYPE_X86 = 7
const CPU_TYPE_X86_64 = 0x01000007
const LC_VERSION_MIN_IPHONEOS = 0x25
const LC_BUILD_VERSION = 0x32
const PLATFORM_IOS = 2
const PLATFORM_IOSSIMULATOR = 7
// Java class files share FAT_MAGIC; a real universal binary carries a handful of slices.
const MAX_FAT_ARCHS = 32

function thinSliceTarget(buf: Buffer, offset: number): BuildTarget | null {
  if (offset < 0 || offset + 28 > buf.length) return null
  const magic = buf.readUInt32LE(offset)
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) return null
  const cputype = buf.readUInt32LE(offset + 4)
  const ncmds = buf.readUInt32LE(offset + 16)
  let p = offset + (magic === MH_MAGIC_64 ? 32 : 28)
  let versionMinIos = false
  for (let i = 0; i < ncmds && p + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(p)
    const size = buf.readUInt32LE(p + 4)
    if (cmd === LC_BUILD_VERSION && p + 12 <= buf.length) {
      const platform = buf.readUInt32LE(p + 8)
      if (platform === PLATFORM_IOS) return 'device'
      if (platform === PLATFORM_IOSSIMULATOR) return 'simulator'
      return null
    }
    if (cmd === LC_VERSION_MIN_IPHONEOS) versionMinIos = true
    if (size < 8) break
    p += size
  }
  // Binaries linked before LC_BUILD_VERSION say only "iOS"; an Intel slice of one can only be a simulator's.
  if (cputype === CPU_TYPE_X86 || cputype === CPU_TYPE_X86_64) return 'simulator'
  return versionMinIos ? 'device' : null
}

/** Which targets a Mach-O (thin or universal) has slices for. Null when no slice could be classified. */
export function machOSliceTargets(buf: Buffer): SliceTargets | null {
  if (buf.length < 8) return null
  const fatMagic = buf.readUInt32BE(0)
  const targets: (BuildTarget | null)[] = []
  if (fatMagic === FAT_MAGIC || fatMagic === FAT_MAGIC_64) {
    const nfat = buf.readUInt32BE(4)
    if (nfat === 0 || nfat > MAX_FAT_ARCHS) return null
    const archSize = fatMagic === FAT_MAGIC_64 ? 32 : 20
    for (let i = 0; i < nfat; i++) {
      const a = 8 + i * archSize
      if (a + archSize > buf.length) break
      const off = fatMagic === FAT_MAGIC_64 ? Number(buf.readBigUInt64BE(a + 8)) : buf.readUInt32BE(a + 8)
      targets.push(thinSliceTarget(buf, off))
    }
  } else {
    targets.push(thinSliceTarget(buf, 0))
  }
  const simulator = targets.includes('simulator')
  const device = targets.includes('device')
  return simulator || device ? { simulator, device } : null
}

/** The .app's main executable, named by CFBundleExecutable and else by the bundle's own name. */
function readAppExecutable(filePath: string, appDir: string, executable: string | null): Buffer | null {
  const entry = `${appDir}/${executable ?? path.basename(appDir, '.app')}`
  if (buildFileKind(filePath) === 'ios-tar') return readTarEntry(filePath, entry)
  const extract = spawnSync('unzip', ['-p', filePath, entry], { maxBuffer: ARCHIVE_READ_MAXBUFFER })
  return extract.status === 0 && extract.stdout?.length ? (extract.stdout as Buffer) : null
}

/**
 * Decide whether an iOS archive is a simulator or a device build. `reject` carries the 400 message.
 * An .ipa must carry a device slice. A .app.zip / .tar.gz is a simulator build when it has a simulator slice and a
 * device build when it has only a device slice; when its slices cannot be classified it falls back to the lipo
 * check, which accepts it as a simulator build as before.
 */
function classifyIosBuild(
  filePath: string,
  appDir: string,
  executable: string | null,
): { target: BuildTarget } | { reject: string } {
  const binary = readAppExecutable(filePath, appDir, executable)
  const slices = binary?.length ? machOSliceTargets(binary) : null
  if (buildFileKind(filePath) === 'ipa') {
    return slices?.device
      ? { target: 'device' }
      : { reject: 'This .ipa has no iOS device (iphoneos, arm64) slice in its main executable. Build it for a generic iOS device, or upload a simulator build as .app.zip / .tar.gz.' }
  }
  if (slices) return { target: slices.simulator ? 'simulator' : 'device' }
  // lipo 슬라이스 검증 (macOS only; Linux에서는 null → skip)
  if (binary?.length && lipoHasSimSlice(binary) === false) {
    return { reject: 'This build has no arm64 or x86_64 slice. Build it for iphonesimulator or for a generic iOS device.' }
  }
  return { target: 'simulator' }
}

// The target is read back from the stored file rather than a column: an .ipa is always a device build, and a
// device-only .app.zip / .tar.gz is stored under this marker. Older rows predate device builds and are simulator.
const DEVICE_FILE_MARKER = '.device_'

/** `simulator` / `device` for an iOS build's stored file, null for Android. */
export function buildTargetOf(filePath: string): BuildTarget | null {
  const kind = buildFileKind(filePath)
  if (kind === 'ipa') return 'device'
  if (kind !== 'ios-zip' && kind !== 'ios-tar') return null
  const name = path.basename(filePath).replace(/^\d+-[0-9a-f]{8}/, '')
  return name.startsWith(DEVICE_FILE_MARKER) ? 'device' : 'simulator'
}

/** Replaces a build row's `file_path` with the `target` derived from it, so the path never reaches a client. */
function withTarget<T extends { file_path: string }>(row: T): Omit<T, 'file_path'> & { target: BuildTarget | null } {
  const { file_path: filePath, ...rest } = row
  return { ...rest, target: buildTargetOf(filePath) }
}

// ── app 자동 생성 / 조회 ──────────────────────────────────────────────────

export function upsertApp(name: string, bundleIdKey: string, platform: string): number {
  const db = getDb()
  const existing = db.prepare(
    'SELECT id, platform FROM apps WHERE bundle_id_key = ? LIMIT 1'
  ).get(bundleIdKey) as { id: number; platform: string } | undefined

  if (existing) {
    // 다른 플랫폼 빌드가 올라오면 both로 업그레이드
    if (existing.platform !== 'both' && existing.platform !== platform) {
      db.prepare('UPDATE apps SET platform = ? WHERE id = ?').run('both', existing.id)
    }
    return existing.id
  }

  const result = db.prepare(
    'INSERT INTO apps (name, bundle_id_key, platform) VALUES (?, ?, ?)'
  ).run(name, bundleIdKey, platform)
  return result.lastInsertRowid as number
}

// ── handlers ──────────────────────────────────────────────────────────────

export function handleListBuilds(req: http.IncomingMessage, res: http.ServerResponse): void {
  const auth = requireBuildAuth(req, res)
  if (!auth) return

  const u = new URL(req.url ?? '/', 'http://x')
  const page    = Math.max(0, Number(u.searchParams.get('page') ?? 0))
  const limit   = Math.min(100, Math.max(1, Number(u.searchParams.get('limit') ?? 20)))
  const q       = u.searchParams.get('q') ?? ''
  const platform = u.searchParams.get('platform') ?? ''
  const status  = u.searchParams.get('status') ?? ''
  const appId   = u.searchParams.get('app_id') ?? ''
  const sortKey = ['uploaded_at', 'version_name', 'status_label'].includes(u.searchParams.get('sort') ?? '')
    ? u.searchParams.get('sort')! : 'uploaded_at'
  const sortDir = u.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC'

  const db = getDb()
  const conds: string[] = []
  const params: unknown[] = []

  // A substring search: `%`, `_` and the escape character itself are text to find, not wildcards.
  if (q)        { conds.push(`b.version_name LIKE ? ESCAPE '\\'`); params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`) }
  if (platform) { conds.push('ap.platform = ?'); params.push(platform) }
  if (status)   { conds.push('b.status_label = ?'); params.push(status) }
  if (appId)    { conds.push('b.app_id = ?'); params.push(Number(appId)) }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const baseFrom = `
    FROM builds b
    LEFT JOIN apps ap ON ap.id = b.app_id
    LEFT JOIN users u  ON u.id  = b.uploader_id
  `

  const total = (db.prepare(
    `SELECT COUNT(*) as n ${baseFrom} ${where}`
  ).get(...params) as { n: number }).n

  const items = db.prepare(`
    SELECT b.id, b.app_id, ap.name, b.version_name, b.build_number,
           b.version_label, b.status_label, b.platform,
           b.bundle_id, b.uploaded_at, b.completed_at, b.delete_after, b.file_path,
           COALESCE(u.display_name, substr(u.email, 1, instr(u.email, '@') - 1)) as uploader
    ${baseFrom}
    ${where}
    ORDER BY b.${sortKey} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, limit, page * limit) as { file_path: string }[]

  json(res, 200, { items: items.map(withTarget), total })
}

export function handleGetBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  if (!requireBuildAuth(req, res)) return

  const build = getDb().prepare(`
    SELECT b.id, b.app_id, ap.name, b.version_name, b.build_number,
           b.version_label, b.status_label, b.platform, b.bundle_id, b.uploaded_at, b.completed_at, b.delete_after,
           b.file_path
    FROM builds b
    LEFT JOIN apps ap ON ap.id = b.app_id
    WHERE b.id = ?
  `).get(params.id) as { file_path: string } | undefined

  if (!build) return json(res, 404, { error: 'Build not found' })
  json(res, 200, withTarget(build))
}

export async function handleUpdateBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = requireAuth(req, res)
  if (!auth || !assertCanWrite(res, auth.userId)) return

  // Parse the body before reading current state, so the SELECT and UPDATE below run
  // with no await between them. Closes a TOCTOU window where two concurrent PATCHes
  // could both observe the old status_label and both fire the webhook.
  const body = await readJson<{ status_label?: string | null; version_label?: string | null }>(req)

  const db = getDb()
  const existing = db.prepare('SELECT status_label FROM builds WHERE id = ?').get(params.id) as
    | { status_label: string | null }
    | undefined
  if (!existing) return json(res, 404, { error: 'Build not found' })

  const VALID_STATUS = ['Backlog', 'In Progress', 'Done', 'Rejected']
  const updates: string[] = []
  const values: unknown[] = []

  if ('status_label' in body) {
    if (body.status_label !== null && !VALID_STATUS.includes(body.status_label ?? '')) {
      return json(res, 400, { error: 'Invalid status_label' })
    }
    updates.push('status_label = ?')
    values.push(body.status_label ?? null)
    if (body.status_label === 'Done' && existing.status_label !== 'Done') {
      updates.push("completed_at = datetime('now')")
    } else if (body.status_label !== 'Done' && existing.status_label === 'Done') {
      updates.push('completed_at = NULL')
    }
  }
  if ('version_label' in body) {
    updates.push('version_label = ?')
    values.push(body.version_label ?? null)
  }

  if (updates.length === 0) return json(res, 400, { error: 'Nothing to update' })

  const result = db.prepare(`UPDATE builds SET ${updates.join(', ')} WHERE id = ?`).run(...values, params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Build not found' })
  json(res, 200, { ok: true })

  // Fire webhooks on a review-status transition into Done/Rejected. Fire-and-forget and
  // best-effort: neither the synchronous lookup nor delivery may reject the handler
  // after the response above has already been sent.
  const next = body.status_label
  if ('status_label' in body && (next === 'Done' || next === 'Rejected') && existing.status_label !== next) {
    try {
      const info = db
        .prepare('SELECT b.version_name, a.platform FROM builds b JOIN apps a ON a.id = b.app_id WHERE b.id = ?')
        .get(params.id) as { version_name: string | null; platform: string | null } | undefined
      void deliverWebhooks({
        event: 'build.status_changed',
        build: {
          id: String(params.id),
          platform: info?.platform ?? null,
          appVersion: info?.version_name ?? null,
          status: next,
        },
        changedAt: new Date().toISOString(),
      }).catch(() => {})
    } catch {
      // best-effort: never let webhook wiring reject the already-sent response
    }
  }
}

// Schedule deletion: an explicit, manual action that puts the build on the purge
// clock (delete_after = now + TTL). Orthogonal to status_label (issue #258).
export function handleScheduleBuildDeletion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  const auth = requireAuth(req, res)
  if (!auth || !assertCanWrite(res, auth.userId)) return
  const db = getDb()
  const result = db
    .prepare(`UPDATE builds SET delete_after = datetime('now', '+' || ? || ' days') WHERE id = ?`)
    .run(BUILD_TTL_DAYS, params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Build not found' })
  // Return the authoritative timestamp so the client doesn't re-derive the TTL.
  const row = db.prepare('SELECT delete_after FROM builds WHERE id = ?').get(params.id) as { delete_after: string }
  json(res, 200, { ok: true, delete_after: row.delete_after })
}

// Cancel a scheduled deletion: take the build back off the purge clock.
export function handleCancelBuildDeletion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
): void {
  const auth = requireAuth(req, res)
  if (!auth || !assertCanWrite(res, auth.userId)) return
  const result = getDb().prepare('UPDATE builds SET delete_after = NULL WHERE id = ?').run(params.id)
  if (result.changes === 0) return json(res, 404, { error: 'Build not found' })
  json(res, 200, { ok: true })
}

// 업로드 크기 상한(바이트). 기본 500 MB, TAPFLOW_MAX_BUILD_BYTES로 조정 가능.
function maxBuildUploadBytes(): number {
  const v = Number(process.env.TAPFLOW_MAX_BUILD_BYTES)
  return Number.isFinite(v) && v > 0 ? v : 500 * 1024 * 1024
}

// 해제 후 크기 상한(gzip bomb 방어). 압축 전 상한과 별개. 기본 업로드 상한×4.
function maxUnpackedBytes(): number {
  const v = Number(process.env.TAPFLOW_MAX_UNPACKED_BYTES)
  return Number.isFinite(v) && v > 0 ? v : maxBuildUploadBytes() * 4
}

/**
 * 업로드된 .tar.gz 를 설치 전에 검증한다 (R7). tar 바이너리가 이름을 해석하므로
 * PAX/GNU long-name 우회가 없다. 문제 시 에러 문구, 정상 시 null.
 * - 손상/비-gzip: tar -tzf 실패
 * - path traversal: 절대경로 또는 `..` 세그먼트
 * - symlink/hardlink 탈출: -tzvf 의 타입 문자(l/h)
 * - gzip bomb: 해제 스트림 바이트가 상한 초과 (전체 버퍼링 없이 조기 중단)
 */
export async function validateTarGz(tarPath: string): Promise<string | null> {
  // fail-closed: 버퍼 초과(ENOBUFS, status=null)나 tar 부재(ENOENT)면 stdout이 잘려
  // 검증이 우회될 수 있으므로 거절한다. maxBuffer 를 넉넉히 잡아 정상 아카이브는 통과.
  const list = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8', maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (list.error || list.status !== 0) return 'Corrupt or invalid .tar.gz archive.'

  const names = (list.stdout as string).split('\n').filter(Boolean)
  for (const raw of names) {
    const name = raw.replace(/^\.\//, '')
    if (name.startsWith('/') || name.split('/').some((seg) => seg === '..')) {
      return 'Archive contains an unsafe path (absolute or ".." escape) and was rejected.'
    }
  }

  // 엔트리 타입 검사: ls -l 스타일 첫 문자 l(symlink)/h(hardlink) 거부.
  // 목록을 못 얻으면(에러/잘림) symlink 검사를 건너뛰지 말고 fail-closed 로 거절한다.
  const verbose = spawnSync('tar', ['-tzvf', tarPath], { encoding: 'utf8', maxBuffer: ARCHIVE_READ_MAXBUFFER })
  if (verbose.error || verbose.status !== 0) return 'Corrupt or invalid .tar.gz archive.'
  for (const line of (verbose.stdout as string).split('\n')) {
    const c = line[0]
    if (c === 'l' || c === 'h') {
      return 'Archive contains a symbolic or hard link and was rejected.'
    }
  }

  // gzip bomb: 스트리밍 해제 바이트를 세며 상한 초과 시 즉시 중단 (t3.small 메모리 보호).
  const cap = maxUnpackedBytes()
  return await new Promise<string | null>((resolve) => {
    let total = 0
    let done = false
    const input = fs.createReadStream(tarPath)
    const gunzip = zlib.createGunzip()
    const finish = (r: string | null) => {
      if (done) return
      done = true
      input.destroy()
      gunzip.destroy()
      resolve(r)
    }
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > cap) finish('Archive exceeds the maximum unpacked size limit.')
    })
    gunzip.on('end', () => finish(null))
    gunzip.on('error', () => finish('Corrupt or invalid .tar.gz archive.'))
    input.on('error', () => finish('Corrupt or invalid .tar.gz archive.'))
    input.pipe(gunzip)
  })
}

export function handleUploadBuild(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uploadsDir: string
): void {
  const auth = requireBuildAuth(req, res)
  if (!auth || !assertCanWrite(res, auth.userId)) return

  const bb = busboy({ headers: req.headers, limits: { fileSize: maxBuildUploadBytes() } })
  const fields: Record<string, string> = {}
  let savedPath = ''
  let originalName = ''
  let fileError = ''
  let writePromise: Promise<void> = Promise.resolve()

  bb.on('field', (name, val) => { fields[name] = val })

  bb.on('file', (_field, stream, info) => {
    // busboy destroys a file's stream with an error when the body ends inside it, and a stream with no
    // `'error'` listener throws. The response is `bb`'s own `'error'` handler's job.
    stream.on('error', () => {})
    // No filename when busboy took the part for a file only by its `application/octet-stream` type. An empty
    // name is an unknown kind, so it is refused below like any other unsupported file.
    originalName = info.filename ?? ''
    const kind = buildFileKind(originalName)

    if (kind === 'aab') {
      fileError = 'Android emulator installs require an .apk. Build an .apk (not .aab) and upload it.'
      stream.resume()
      return
    }
    if (kind === 'unknown') {
      fileError = 'Only .app.zip / .tar.gz / .ipa (iOS) or .apk (Android) files allowed'
      stream.resume()
      return
    }

    // 충돌 방지: 같은 ms + 같은 파일명 동시 업로드(특히 CI 자동화) 시 file_path 공유를 막는다.
    const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}_${path.basename(originalName)}`
    savedPath = path.join(uploadsDir, 'builds', fileName)
    fs.mkdirSync(path.dirname(savedPath), { recursive: true })
    // 크기 상한 초과 시 busboy가 스트림을 잘라('limit') 보내므로, 잘린 파일을 유효 빌드로 저장하면 안 된다.
    stream.on('limit', () => { fileError = 'File exceeds the upload size limit' })
    writePromise = pipeUpload(stream, savedPath, 'failed build upload')
  })

  bb.on('finish', async () => {
    // A failed write rejects this, and an uncaught rejection in this async listener would end the relay.
    // `pipeUpload` has already removed the file.
    try {
      await writePromise
    } catch {
      return json(res, 500, { error: 'Upload failed' })
    }
    if (fileError) {
      if (savedPath) unlinkSafe(savedPath, 'rejected upload')
      return json(res, 400, { error: fileError })
    }
    if (!savedPath) return json(res, 400, { error: 'File required' })

    const kind = buildFileKind(originalName)
    const isIos = kind === 'ios-zip' || kind === 'ios-tar' || kind === 'ipa'
    const platform = fields.platform ?? (isIos ? 'ios' : 'android')
    const status = ['Backlog', 'In Progress', 'Done', 'Rejected'].includes(fields.status)
      ? fields.status : null

    let bundleId: string | null = null
    let versionName: string | null = null
    let buildNumber: string | null = null
    let resolvedAppName: string | null = null
    let aaptFound = true // only updated in the android branch — ios doesn't use aapt

    if (isIos) {
      // .tar.gz 는 설치 전에 traversal/symlink/bomb/손상을 걸러낸다 (R7).
      if (kind === 'ios-tar') {
        const tarError = await validateTarGz(savedPath)
        if (tarError) {
          unlinkSafe(savedPath, 'rejected upload')
          return json(res, 400, { error: tarError })
        }
      }

      const info = extractAppInfo(savedPath)
      if (info === null) {
        fs.unlinkSync(savedPath)
        return json(res, 400, {
          error: kind === 'ipa'
            ? 'No Payload/*.app directory found in the .ipa.'
            : 'No .app directory found in the archive. Upload a .app.zip or .tar.gz that contains a .app directory.',
        })
      }

      const appDir = findAppDir(savedPath)
      if (appDir) {
        const verdict = classifyIosBuild(savedPath, appDir, info.executable)
        if ('reject' in verdict) {
          fs.unlinkSync(savedPath)
          return json(res, 400, { error: verdict.reject })
        }
        if (verdict.target === 'device' && kind !== 'ipa') {
          // The first `_` is the separator after `<ms>-<uuid8>`, which holds none.
          const marked = path.join(path.dirname(savedPath), path.basename(savedPath).replace('_', DEVICE_FILE_MARKER))
          fs.renameSync(savedPath, marked)
          savedPath = marked
        }
      }

      bundleId     = info.bundleId
      versionName  = info.versionName
      buildNumber  = info.buildNumber
      resolvedAppName = info.appName
    } else {
      const info = extractApkInfo(savedPath)
      bundleId        = info.bundleId
      versionName     = info.versionName
      buildNumber     = info.buildNumber
      resolvedAppName = info.appName
      aaptFound       = info.aaptFound
    }

    const appName = resolvedAppName ?? fields.label ?? stripArchiveExt(originalName)

    const db = getDb()
    const route = routeUploadToApp(db, {
      appId: fields.app_id ? Number(fields.app_id) : null,
      bundleId, appName, platform,
      isAndroidArtifact: !isIos, // from the uploaded file kind, not the caller-supplied platform field
    })
    if (route.kind === 'app-not-found') {
      unlinkSafe(savedPath, 'app not found')
      return json(res, 404, { error: 'App not found' })
    }
    if (route.kind === 'reject-null-bundle') {
      unlinkSafe(savedPath, 'rejected upload')
      return json(res, 400, { error: nullBundleMessage(aaptFound) })
    }
    const appId = route.appId

    const result = db.prepare(`
      INSERT INTO builds (app_id, version_name, build_number, bundle_id, status_label, file_path, label, version_label, uploader_id, platform)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(appId, versionName, buildNumber, bundleId, status, savedPath, fields.label ?? null, fields.label ?? null, auth.userId, platform)

    const build = db.prepare(`
      SELECT b.id, b.app_id, ap.name, b.version_name, b.build_number,
             b.bundle_id, b.status_label, b.platform, b.uploaded_at, b.file_path
      FROM builds b LEFT JOIN apps ap ON ap.id = b.app_id
      WHERE b.id = ?
    `).get(result.lastInsertRowid) as { file_path: string }

    json(res, 201, withTarget(build))
  })

  bb.on('error', () => json(res, 500, { error: 'Upload failed' }))
  req.pipe(bb)
}

// Fall back to 7 when the env var is missing or malformed; a NaN here would make
// SQLite store delete_after as NULL and silently skip scheduling.
const ttlEnv = Number(process.env['TAPFLOW_BUILD_TTL_DAYS'])
const BUILD_TTL_DAYS = Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : 7

// `uploadsDir` is this install's, because the stored `file_path` names wherever the data directory
// was at upload time — see `resolveBuildFile`. Without it a moved install's expired builds kept
// their files for good, and the purge deleted only the rows.
export function purgeExpiredBuilds(dirs: BuildFileDirs): void {
  const expired = getDb().prepare(
    `SELECT id FROM builds WHERE delete_after IS NOT NULL AND delete_after < datetime('now')`
  ).all() as { id: number }[]
  if (expired.length === 0) return
  deleteBuildsWithDependents(expired.map((r) => r.id), dirs)
}
