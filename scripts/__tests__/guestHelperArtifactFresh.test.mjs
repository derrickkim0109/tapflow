import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { computeRecord, readRecord, collectSources, collectArtifactFiles } from '../lib/guest-helper-artifact.mjs'

/**
 * `bin/guest-helper` is committed as a prebuilt and every test of the Duo input path uses a fake, so nothing
 * else in the suite reads the real binary. The same guard as `nethookArtifactFresh.test.mjs`, which explains
 * each assertion's reason. A failure here needs only Xcode's command-line tools:
 *
 *     pnpm --filter @tapflowio/ios-agent build:guest-helper
 */
const REPO = path.resolve(import.meta.dirname, '../..')

// Measured floor: a list that lost an entry hashes to something stable, and the checks below would then
// watch less than they say.
const SOURCE_FILES = 2

describe('the shipped guest-helper matches what it was recorded against', () => {
  it('has a record at all', () => {
    expect(readRecord(REPO), 'packages/ios-agent/guest-helper-shipped.json is missing — run build-guest-helper.sh').not.toBeNull()
  })

  it('sees every declared source, and the artifact', () => {
    expect(collectSources(REPO).length, 'the source list shrank').toBe(SOURCE_FILES)
    expect(collectArtifactFiles(REPO).length, 'the helper is missing').toBe(1)
  })

  it('still matches the source it was built from', () => {
    expect(
      computeRecord(REPO).sources,
      'guest-helper.m changed since the shipped binary was built.\n'
      + '  Rebuild it: pnpm --filter @tapflowio/ios-agent build:guest-helper (rebuilds and re-records).',
    ).toBe(readRecord(REPO).sources)
  })

  it('checks the fields it records, so none of them is decoration', () => {
    const now = computeRecord(REPO)
    const recorded = readRecord(REPO)
    expect(now.helperBytes).toBe(recorded.helperBytes)
    expect(now.sourceFileCount).toBe(recorded.sourceFileCount)
  })

  it('is the same binary that was recorded', () => {
    expect(computeRecord(REPO).helper, 'the committed helper is not the one in the record — rebuild it').toBe(readRecord(REPO).helper)
  })
})
