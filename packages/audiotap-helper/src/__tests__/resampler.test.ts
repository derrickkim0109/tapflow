import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The resampler runs inside the helper's Core Audio callback, so it is tested the only way that exercises the
// shipped code: the marked section is cut out of the helper's source, compiled with a driver, and fed a sine
// in callback-sized chunks. Needs swiftc, so it runs on a Mac and is skipped elsewhere.
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'audiotap-helper.swift')
const canCompile = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0

// One second of a 1 kHz stereo sine at 48 kHz, in chunks of the given sizes (cycled), through one state.
// Prints the frame count and the largest distance from the ideal 44.1 kHz sine, on a -1...1 scale.
const DRIVER = `
let srcRate = 48000.0, dstRate = 44100.0, hz = 1000.0
let chunks = CommandLine.arguments.dropFirst().map { Int($0)! }
var st = ResamplerState()
var out = [Int16]()
var sent = 0, k = 0
while sent < Int(srcRate) {
  let n = min(chunks[k % chunks.count], Int(srcRate) - sent); k += 1
  var buf = [Float](repeating: 0, count: n * 2)
  for i in 0..<n {
    let v = Float(0.5 * sin(2 * Double.pi * hz * Double(sent + i) / srcRate))
    buf[i * 2] = v; buf[i * 2 + 1] = v
  }
  buf.withUnsafeBufferPointer { out += resample($0.baseAddress!, n, 2, srcRate, dstRate, &st) }
  sent += n
}
let frames = out.count / 2
var worst = 0.0
for j in 0..<frames {
  let ideal = 0.5 * sin(2 * Double.pi * hz * Double(j) / dstRate)
  worst = max(worst, abs(Double(out[j * 2]) / 32767 - ideal), abs(Double(out[j * 2 + 1]) / 32767 - ideal))
}
print("\\(frames) \\(worst)")
`

describe.skipIf(!canCompile)('the helper resampler (48 kHz callbacks → 44.1 kHz)', () => {
  const run = (chunks: number[]): { frames: number; worst: number } => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tapflow-resampler-'))
    try {
      const source = readFileSync(HELPER, 'utf8')
      const section = source.match(/\/\/ BEGIN resampler[\s\S]*?\/\/ END resampler/)
      if (!section) throw new Error('resampler markers not found in audiotap-helper.swift')
      writeFileSync(path.join(dir, 'main.swift'), `import Foundation\n${section[0]}\n${DRIVER}`)
      // No -O: `ensureHelperApp` builds the shipped helper unoptimised, and a trap that only fires there must fail here.
      execFileSync('xcrun', ['swiftc', '-o', path.join(dir, 'drive'), path.join(dir, 'main.swift')], { stdio: 'pipe' })
      const [frames, worst] = execFileSync(path.join(dir, 'drive'), chunks.map(String), { encoding: 'utf8' }).trim().split(' ')
      return { frames: Number(frames), worst: Number(worst) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('makes 44,100 frames a second from 512-frame callbacks, not one fewer per callback', () => {
    // Restarting each callback made 470 of 470.4 frames: 44,062 a second, and the dashboard ran dry.
    expect(Math.abs(run([512]).frames - 44_100)).toBeLessThanOrEqual(1)
  }, 60_000)

  it('stays on the ideal waveform across callback boundaries, whatever size the callbacks are', () => {
    // Linear interpolation of a 1 kHz tone at 48 kHz is off by at most ~0.001 here; a restarted phase or an
    // uninterpolated boundary is off by an order of magnitude more within the first callback.
    const { frames, worst } = run([512, 300, 1, 471])
    expect(Math.abs(frames - 44_100)).toBeLessThanOrEqual(1)
    expect(worst).toBeLessThan(0.003)
  }, 60_000)
})
