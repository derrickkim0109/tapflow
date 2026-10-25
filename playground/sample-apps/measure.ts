// Measures what the UI tree reports for a sample app against its expected list (`expected/*.json`):
// recall (B1 — is each element in the tree) and tap round trip (B2 — does a tap on the element the tree
// reported actually land). The app proves a landed tap itself: it sets its `status` label to
// `tapped:<key>`, and this script reads the tree again to see it.
//
//   pnpm --filter @tapflowio/playground measure-tree \
//     --expected sample-apps/expected/ios-uikit.json --zip test-builds/sample-uikit.app.zip \
//     [--device <name|id>] [--relay ws://localhost:4000]
//   Android: --expected sample-apps/expected/android-compose.json --zip test-builds/sample-compose.apk
//
// `--zip` uploads the build to App Center first; `--build <id>` measures one already there. Either way
// install and launch go the way a tester's do. The token comes from `--token`, `TAPFLOW_TOKEN`, or
// `sample-apps/.env` (gitignored — copy `.env.example`), and needs `builds:write` for `--zip`. Groups are scored apart: `hard` and `web` are there to fail, and folding them into `basic`
// would make every number meaningless.
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { RelayClient, TransientQueryError, authHeader, resolveToken } from '@tapflowio/flow-runner'
import type { UIElement } from '@tapflowio/protocol'

interface Expected {
  key: string
  identifier: string | null
  label?: string | null
  labelAny?: string[]
  role: string
  tap: boolean
  /** How the element is used. A slider is dragged, and a tap on it decides nothing about the tree. */
  gesture?: 'tap' | 'swipe' | 'hold'
  note?: string
}
interface Screen { screen: string; group: string; navigate?: string; elements: Expected[] }
interface ExpectedFile { app: string; screens: Screen[] }

interface Row {
  screen: string
  group: string
  key: string
  found: boolean
  roleGot?: string
  roleExpected: string
  tap?: 'landed' | 'missed' | 'skipped'
  status?: string
}

// Read before the token is resolved. A missing file is the normal case for anyone passing --token.
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '.env'))
} catch { /* no .env */ }

// `pnpm <script> -- …` hands the `--` through as an argument.
const argv = process.argv.slice(2)
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    expected: { type: 'string' },
    build: { type: 'string' },
    zip: { type: 'string' },
    device: { type: 'string' },
    relay: { type: 'string', default: 'ws://localhost:4000' },
    token: { type: 'string' },
    out: { type: 'string' },
    // Print each screen's tree as read, to tell a miss in the tree from a miss in this script's matching.
    dump: { type: 'boolean', default: false },
  },
})
if (!values.expected || (!values.build === !values.zip)) {
  console.error('usage: measure.ts --expected <file> (--zip <app.zip|apk> | --build <id>) [--device <name|id>] [--relay <url>] [--token <pat>] [--out <file>]')
  process.exit(2)
}

const spec = JSON.parse(readFileSync(values.expected, 'utf8')) as ExpectedFile
const relayUrl = values.relay!
const tokens = resolveToken({ relayUrl, ...(values.token ? { explicit: values.token } : {}), warn: (l) => console.error(l) })
const client = new RelayClient(relayUrl, tokens)

/** Uploads the build the way CI does (`POST /api/v1/builds`) and returns its id. */
async function upload(file: string): Promise<number> {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(file)]), basename(file))
  form.append('label', `measure ${basename(file)}`)
  const res = await fetch(`${relayUrl.replace(/^ws/, 'http')}/api/v1/builds`, { method: 'POST', headers: authHeader(tokens), body: form })
  const body = (await res.json().catch(() => ({}))) as { id?: number | string; error?: string }
  if (!res.ok || body.id === undefined) throw new Error(`upload of ${file} failed: ${res.status} ${body.error ?? ''}`)
  return Number(body.id)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function matches(el: UIElement, e: Expected): boolean {
  if (e.identifier) return el.identifier === e.identifier
  const labels = e.labelAny ?? (e.label ? [e.label] : [])
  // A field with no label is found by its placeholder, as a bare-text selector finds it.
  return labels.includes(el.label) || (el.placeholder !== undefined && labels.includes(el.placeholder))
}

/** One tree read, retried when the failure is one the runner itself calls transient. A permanent one
 *  still ends the measurement: it says the device or the runner is gone, not that a number is low. */
async function readTree(sessionId: string): Promise<UIElement[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.queryUITree(sessionId)
    } catch (e) {
      if (!(e instanceof TransientQueryError) || attempt >= 3) throw e
      await sleep(500)
    }
  }
}

/** The tree right now, read until two reads agree on its shape and positions. Positions too: a keyboard that
 *  resizes the window (Android `adjustResize`) moves every element without changing what the tree holds, and a
 *  tap aimed at a frame read mid-move lands beside it. */
async function settledTree(sessionId: string): Promise<UIElement[]> {
  let prev = ''
  for (let i = 0; i < 10; i++) {
    const tree = await readTree(sessionId)
    const shape = tree.map((e) => `${e.role}|${e.label}|${e.identifier ?? ''}|${e.frame.x.toFixed(2)},${e.frame.y.toFixed(2)}`).join('\n')
    if (shape === prev) return tree
    prev = shape
    await sleep(300)
  }
  // Something on screen kept moving. The tree is used anyway, and said so: a tap aimed at it may miss.
  console.warn('  (tree did not settle after 10 reads — the next result may be a miss caused by movement)')
  return readTree(sessionId)
}

function statusOf(tree: UIElement[]): string | undefined {
  return tree.find((e) => e.identifier === 'status')?.label
}

async function tapCentre(sessionId: string, el: UIElement): Promise<void> {
  await client.tap(sessionId, el.frame.x + el.frame.width / 2, el.frame.y + el.frame.height / 2)
}

/** Drags from the element's centre to three quarters across it — how a slider is used. */
async function swipeAcross(sessionId: string, el: UIElement): Promise<void> {
  const y = el.frame.y + el.frame.height / 2
  await client.swipe(sessionId, [el.frame.x + el.frame.width / 2, y], [el.frame.x + el.frame.width * 0.75, y], 300)
}

/** A tap held for 150ms: a press that does not move, for controls that ignore a zero-length touch. */
async function holdCentre(sessionId: string, el: UIElement): Promise<void> {
  const c: [number, number] = [el.frame.x + el.frame.width / 2, el.frame.y + el.frame.height / 2]
  await client.swipe(sessionId, c, c, 150)
}

/** Uses the element and waits for the app to say which element it saw used. */
async function tapRoundTrip(sessionId: string, el: UIElement, key: string, gesture: 'tap' | 'swipe' | 'hold'): Promise<{ landed: boolean; status?: string }> {
  await (gesture === 'swipe' ? swipeAcross(sessionId, el) : gesture === 'hold' ? holdCentre(sessionId, el) : tapCentre(sessionId, el))
  // Long enough for several reads on Android, where one tree read takes over a second.
  const deadline = Date.now() + 6000
  let status: string | undefined
  while (Date.now() < deadline) {
    status = statusOf(await readTree(sessionId))
    if (status === `tapped:${key}`) return { landed: true, status }
    await sleep(250)
  }
  return { landed: false, status }
}

async function main(): Promise<void> {
  const buildId = values.zip ? await upload(values.zip) : Number(values.build)
  if (!Number.isInteger(buildId)) throw new Error(`--build must be a build id, got "${values.build}"`)
  if (values.zip) console.log(`uploaded ${values.zip} as build ${buildId}`)
  await client.connect()
  const devices = (await client.listDevices()).flatMap((s) => s.devices)
  // A name repeats once per installed runtime, so `--device` also takes the device id (an iOS UDID).
  const candidates = values.device
    ? devices.filter((d) => d.id === values.device || d.id.endsWith(`:${values.device}`) || d.name === values.device)
    : devices.filter((d) => d.status === 'booted')
  if (candidates.length !== 1) {
    const listed = candidates.length > 1 ? candidates : devices.filter((d) => d.status === 'booted')
    throw new Error(`need exactly one device (${values.device ? `matching "${values.device}"` : 'booted'}); found ${candidates.length}. ${candidates.length > 1 ? 'Matches' : 'Booted'}: ${listed.map((d) => `${d.name} ${d.id}`).join(', ') || 'none'}`)
  }
  const device = candidates[0]
  const sessionId = device.sessionId
  await client.joinSession(sessionId)
  // Always, as `tapflow flow run` does: on a booted device it is what waits for the input channel to be
  // ready, and a tap sent before that is refused.
  await client.bootDevice(sessionId, device.id)
  await client.installApp(sessionId, buildId)
  await client.launchApp(sessionId, buildId)
  await sleep(1500)

  const elementOf = (tree: UIElement[], key: string): UIElement | undefined => {
    for (const s of spec.screens) {
      const e = s.elements.find((x) => x.key === key)
      if (e) return tree.find((el) => matches(el, e))
    }
    return undefined
  }

  const rows: Row[] = []
  // The tab whose screen is showing. Navigating to it again is skipped: a selected element's label is
  // read as empty today (`, Selected` defeats the label match), so a tab found by label cannot be found
  // once it is selected. That is a finding, recorded by the `tabs` rows, not something to fail on here.
  let currentTab: string | undefined
  for (const screen of spec.screens) {
    if (screen.navigate && screen.navigate !== currentTab) {
      const tab = elementOf(await settledTree(sessionId), screen.navigate)
      if (!tab) throw new Error(`cannot reach screen "${screen.screen}": tab ${screen.navigate} is not in the tree`)
      // Checked like any other tap: a keyboard left over the tab bar takes the tap, and every element of the
      // next screen would then be scored missing for a navigation that never happened.
      const r = await tapRoundTrip(sessionId, tab, screen.navigate, 'tap')
      if (!r.landed) throw new Error(`navigation to ${screen.navigate} did not land (status ${r.status ?? '?'})`)
      currentTab = screen.navigate
    }
    if (values.dump) {
      console.log(`\n--- ${screen.screen}`)
      for (const el of await settledTree(sessionId)) {
        const f = el.frame
        console.log(`  ${el.role.padEnd(8)} ${JSON.stringify(el.label).padEnd(28)} id=${el.identifier ?? '-'} raw=${el.rawRole ?? '-'} [${f.x.toFixed(2)},${f.y.toFixed(2)} ${f.width.toFixed(2)}x${f.height.toFixed(2)}]`)
      }
    }
    for (const e of screen.elements) {
      const tree = await settledTree(sessionId)
      const el = tree.find((x) => matches(x, e))
      const row: Row = { screen: screen.screen, group: screen.group, key: e.key, found: !!el, roleExpected: e.role, ...(el ? { roleGot: el.role } : {}) }
      if (e.tap) {
        if (el) {
          const r = await tapRoundTrip(sessionId, el, e.key, e.gesture ?? 'tap')
          row.tap = r.landed ? 'landed' : 'missed'
          if (r.status !== undefined) row.status = r.status
        } else {
          row.tap = 'skipped'
        }
      }
      rows.push(row)
      if (e.key.startsWith('tab.') && row.tap === 'landed') currentTab = e.key
      const mark = row.found ? 'found' : 'MISSING'
      const tapMark = row.tap ? ` tap:${row.tap}${row.tap === 'missed' ? ` (status ${row.status ?? '?'})` : ''}` : ''
      const roleMark = row.found && row.roleGot !== e.role ? ` role:${row.roleGot}≠${e.role}` : ''
      console.log(`  ${screen.screen.padEnd(15)} ${e.key.padEnd(15)} ${mark}${tapMark}${roleMark}`)
    }
  }

  console.log('\nby group (recall = found / expected; round trip = landed / tapped among found)')
  const groups = [...new Set(rows.map((r) => r.group))]
  const summary = groups.map((g) => {
    const rs = rows.filter((r) => r.group === g)
    const found = rs.filter((r) => r.found).length
    const tapped = rs.filter((r) => r.tap === 'landed' || r.tap === 'missed')
    const landed = tapped.filter((r) => r.tap === 'landed').length
    console.log(`  ${g.padEnd(10)} recall ${found}/${rs.length}   round trip ${landed}/${tapped.length}`)
    return { group: g, expected: rs.length, found, tapped: tapped.length, landed }
  })

  if (values.out) {
    writeFileSync(values.out, JSON.stringify({ app: spec.app, device: device.name, platform: device.platform, at: new Date().toISOString(), summary, rows }, null, 2) + '\n')
    console.log(`\nwrote ${values.out}`)
  }
  client.leaveSession(sessionId)
  client.disconnect()
}

main().catch((e: unknown) => {
  console.error(`✗ ${(e as Error).message}`)
  client.disconnect()
  process.exit(1)
})
