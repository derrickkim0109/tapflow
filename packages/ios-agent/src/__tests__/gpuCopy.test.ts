import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The capture helper copies each frame on the GPU (`GPUSurfaceCopier`). It runs inside the helper against a live
// simulator, so it is tested the only way that exercises the shipped code: the marked section is cut out of the
// helper's source, compiled with a driver, and handed IOSurfaces whose bytes are known. Needs swiftc and Metal, so it
// runs on a Mac and is skipped elsewhere.
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'screencapture-helper.swift')
const canCompile = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0

const DRIVER = `
func surface(_ w: Int, _ h: Int, padding: Int, format: OSType, seed: Int) -> IOSurface {
  let props: [String: Any] = [
    kIOSurfaceWidth as String: w, kIOSurfaceHeight as String: h, kIOSurfaceBytesPerElement as String: 4,
    kIOSurfaceBytesPerRow as String: w * 4 + padding, kIOSurfacePixelFormat as String: format,
  ]
  let s = IOSurfaceCreate(props as CFDictionary)!
  IOSurfaceLock(s, [], nil)
  let base = IOSurfaceGetBaseAddress(s).assumingMemoryBound(to: UInt8.self), stride = IOSurfaceGetBytesPerRow(s)
  for y in 0..<h { for x in 0..<(w * 4) { base[y * stride + x] = UInt8((x &* 31 &+ y &* 7 &+ seed) & 0xff) } }
  IOSurfaceUnlock(s, [], nil)
  return s
}
func buffer(_ w: Int, _ h: Int) -> CVPixelBuffer {
  var pb: CVPixelBuffer?
  CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA,
                      [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
  return pb!
}
func same(_ s: IOSurface, _ b: CVPixelBuffer) -> Bool {
  IOSurfaceLock(s, .readOnly, nil); CVPixelBufferLockBaseAddress(b, .readOnly)
  defer { IOSurfaceUnlock(s, .readOnly, nil); CVPixelBufferUnlockBaseAddress(b, .readOnly) }
  let w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s)
  let sb = IOSurfaceGetBaseAddress(s), ss = IOSurfaceGetBytesPerRow(s)
  let bb = CVPixelBufferGetBaseAddress(b)!, bs = CVPixelBufferGetBytesPerRow(b)
  for y in 0..<h where memcmp(sb + y * ss, bb + y * bs, w * 4) != 0 { return false }
  return true
}
guard let copier = GPUSurfaceCopier() else { print("no-metal"); exit(0) }
let (w, h) = (100, 37)
let first = surface(w, h, padding: 64, format: kCVPixelFormatType_32BGRA, seed: 1)
let second = surface(w, h, padding: 64, format: kCVPixelFormatType_32BGRA, seed: 99)
let out = buffer(w, h)
print("first", copier.copy(first, into: out), same(first, out))
print("second", copier.copy(second, into: out), same(second, out))
print("rgba", copier.copy(surface(w, h, padding: 0, format: kCVPixelFormatType_32RGBA, seed: 5), into: out))
print("size", copier.copy(surface(w + 4, h, padding: 0, format: kCVPixelFormatType_32BGRA, seed: 5), into: out))
// 101 pixels unpadded: 404 bytes a row, which Metal aborts on rather than refusing.
let odd = surface(101, h, padding: 0, format: kCVPixelFormatType_32BGRA, seed: 5)
print("stride", IOSurfaceGetBytesPerRow(odd) % 16 == 0 ? "aligned-anyway" : String(copier.copy(odd, into: buffer(101, h))))
`

describe.skipIf(!canCompile)('GPUSurfaceCopier (the capture helper\'s GPU frame copy)', () => {
  const lines = (() => {
    let cached: Map<string, string> | undefined
    return () => {
      if (cached) return cached
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tapflow-gpucopy-'))
      try {
        const section = readFileSync(HELPER, 'utf8').match(/\/\/ BEGIN gpu-copy[\s\S]*?\/\/ END gpu-copy/)
        if (!section) throw new Error('gpu-copy markers not found in screencapture-helper.swift')
        writeFileSync(path.join(dir, 'main.swift'), `import Foundation\nimport IOSurface\nimport CoreVideo\nimport Metal\n${section[0]}\n${DRIVER}`)
        // Unoptimised on purpose: the helper ships with -O, and overflow or exclusivity traps fire in both builds.
        execFileSync('xcrun', ['swiftc', '-o', path.join(dir, 'drive'), path.join(dir, 'main.swift'),
          '-framework', 'Metal', '-framework', 'CoreVideo', '-framework', 'IOSurface'], { stdio: 'pipe' })
        const out = execFileSync(path.join(dir, 'drive'), { encoding: 'utf8' }).trim().split('\n')
        cached = new Map(out.map((l) => { const [k, ...v] = l.split(' '); return [k, v.join(' ')] }))
        return cached
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })()

  it('copies every byte of each row, past the source surface\'s row padding', (ctx) => {
    if (lines().has('no-metal')) ctx.skip() // no device: say so rather than pass
    expect(lines().get('first')).toBe('true true')
  }, 60_000)

  it('reads a new surface of the same size, not the texture it made for the last one', (ctx) => {
    if (lines().has('no-metal')) ctx.skip() // no device: say so rather than pass
    expect(lines().get('second')).toBe('true true')
  }, 60_000)

  it('refuses a surface that is not 32-bit BGRA or not the buffer\'s size, so the caller copies on the CPU', (ctx) => {
    if (lines().has('no-metal')) ctx.skip() // no device: say so rather than pass
    expect(lines().get('rgba')).toBe('false')
    expect(lines().get('size')).toBe('false')
  }, 60_000)

  it('refuses a row stride Metal cannot wrap, instead of letting Metal abort the helper', (ctx) => {
    if (lines().has('no-metal')) ctx.skip() // no device: say so rather than pass
    // IOSurface may pad the row itself; then there is nothing to refuse and the case is moot on this machine.
    expect(['false', 'aligned-anyway']).toContain(lines().get('stride'))
  }, 60_000)
})
