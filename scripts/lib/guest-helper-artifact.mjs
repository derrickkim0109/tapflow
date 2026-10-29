import fs from 'node:fs'
import path from 'node:path'
import { hashFiles, walk } from './artifact-hash.mjs'

/**
 * What ties the committed `bin/guest-helper` to the source it was built from.
 *
 * The same guard as `nethook-artifact.mjs`, for the same reason: the helper is a committed prebuilt, every
 * test that exercises the Duo input path talks to a fake, and so editing `guest-helper.m` without rebuilding
 * would ship the old binary behind a green suite. Read that file for why the artifact's hash is recorded
 * alongside the sources' and what the record does not claim — all of it applies unchanged.
 *
 * A contributor can fix a failure here with Xcode's command-line tools alone:
 * `pnpm --filter @tapflowio/ios-agent build:guest-helper`.
 */
export const AGENT_DIR = 'packages/ios-agent'
export const SHIPPED_HELPER = `${AGENT_DIR}/bin/guest-helper`
export const RECORD = `${AGENT_DIR}/guest-helper-shipped.json`

/** `build-guest-helper.sh` is an input: its flags change the binary without touching the source. */
const SOURCE_FILES = ['src/guest-helper.m', 'build-guest-helper.sh']

/** A declared input that is missing is an error, and so is a local header the source includes but this
 *  list does not name — the two halves of the rule `nethook-artifact.mjs` explains. */
export function collectSources(repo) {
  const base = path.join(repo, AGENT_DIR)
  const declared = SOURCE_FILES.map((f) => {
    const p = path.join(base, f)
    if (!fs.existsSync(p)) throw new Error(`guest-helper guard: declared source file is missing: ${AGENT_DIR}/${f}`)
    return p
  })
  for (const file of declared) {
    const dir = path.dirname(file)
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^\s*#\s*(?:import|include)\s+"([^"]+)"/gm)) {
      const target = path.resolve(dir, m[1])
      if (!fs.existsSync(target) || declared.includes(target)) continue
      throw new Error(
        `guest-helper guard: ${path.relative(base, file)} includes ${m[1]}, which is not in SOURCE_FILES.\n`
        + '  It is compiled into the helper, so its changes must move the source hash. Add it.',
      )
    }
  }
  return declared
}

export function collectArtifactFiles(repo) {
  const p = path.join(repo, SHIPPED_HELPER)
  if (!fs.existsSync(p)) return []
  return fs.statSync(p).isDirectory() ? walk(p).sort() : [p]
}

export function computeRecord(repo) {
  const sources = collectSources(repo)
  const artifact = collectArtifactFiles(repo)
  return {
    sources: hashFiles(path.join(repo, AGENT_DIR), sources),
    sourceFileCount: sources.length,
    helper: hashFiles(path.join(repo, AGENT_DIR), artifact),
    helperBytes: artifact.reduce((n, f) => n + fs.statSync(f).size, 0),
  }
}

export function readRecord(repo) {
  const p = path.join(repo, RECORD)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}
