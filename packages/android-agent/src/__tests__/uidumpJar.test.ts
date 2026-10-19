import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'

// The tree dump jar is committed prebuilt (installing the agent needs no Android build tools), so nothing rebuilds it
// when its Java source changes. The build script records what it was built from; this fails when that went stale.
describe('bin/tapflow-uidump.jar', () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const javaFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name)
      return statSync(p).isDirectory() ? javaFiles(p) : name.endsWith('.java') ? [p] : []
    })

  it('was built from the source as it is now (run scripts/build-uidump.sh)', () => {
    const files = javaFiles(path.join(root, 'uidump/src')).map((p) => path.relative(root, p)).sort()
    const source = createHash('sha256').update(files.map((f) => readFileSync(path.join(root, f), 'utf8')).join('')).digest('hex')
    expect(readFileSync(path.join(root, 'bin/tapflow-uidump.source-sha256'), 'utf8').trim()).toBe(source)
    expect(statSync(path.join(root, 'bin/tapflow-uidump.jar')).size).toBeGreaterThan(0)
  })
})
