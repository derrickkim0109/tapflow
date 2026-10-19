// `docs-production` follows the newest stable release and nothing else. See `scripts/docs-production.mjs`.
//
// Each skip case is paired with a move case judged by the same function on the same tag list
// (`contributing/test-and-guard-coverage.md` rule 2): "does not move" is also what a function that
// never moves reports. The workflow wiring is checked too, because a correct decision that no step
// acts on — or that runs before publish — is the same silence.
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { docsProductionCommit, docsProductionDecision } from '../docs-production.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('docsProductionDecision', () => {
  const tags = ['v0.26.1', 'v0.27.0', 'v0.27.1', 'v0.28.0-next.0']

  it('moves for the newest stable tag, even with a newer-looking prerelease present', () => {
    expect(docsProductionDecision('v0.27.1', tags)).toEqual({ move: true })
  })

  it('skips a prerelease', () => {
    expect(docsProductionDecision('v0.28.0-next.0', tags).move).toBe(false)
  })

  it('skips a backport tagged after a newer release', () => {
    const withBackport = [...tags, 'v0.26.2']
    expect(docsProductionDecision('v0.26.2', withBackport)).toEqual({ move: false, reason: 'v0.27.0 is newer than v0.26.2' })
    expect(docsProductionDecision('v0.27.1', withBackport)).toEqual({ move: true })
  })

  it('compares numerically, not as strings', () => {
    const t = ['v0.9.0', 'v0.10.0']
    expect(docsProductionDecision('v0.10.0', t)).toEqual({ move: true })
    expect(docsProductionDecision('v0.9.0', t).move).toBe(false)
  })

  it('skips a tag that is not vX.Y.Z', () => {
    expect(docsProductionDecision('0.27.1', ['0.27.1']).move).toBe(false)
    expect(docsProductionDecision('v0.27', ['v0.27']).move).toBe(false)
  })
})

describe('docsProductionCommit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-production-test-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  // Every path in a commit, as a diff from the empty tree (`checksWalkDisk` forbids the listing commands).
  const files = (commit) => git('diff', '--name-only', git('hash-object', '-t', 'tree', '/dev/null'), commit).split('\n')

  git('init', '-q')
  write('docs/index.md', 'one')
  write('.github/workflows/release.yml', 'on: push')
  write('.github/pull_request_template.md', 'template')
  git('add', '.')
  git('commit', '-qm', 'one')
  git('tag', 'v0.1.0')
  write('docs/index.md', 'two')
  write('.github/workflows/release.yml', 'on: tag')
  git('commit', '-qam', 'two')
  git('tag', 'v0.2.0')

  it('carries the tag tree without the workflow files, and nothing else is dropped', () => {
    const first = docsProductionCommit({ tag: 'v0.1.0', cwd: dir })
    expect(files(first)).toEqual(['.github/pull_request_template.md', 'docs/index.md'])
    expect(git('show', `${first}:docs/index.md`)).toBe('one')
    expect(git('rev-list', '--parents', '-n1', first).split(' ')).toHaveLength(1)
  })

  it('stacks on the given parent, so the push is a fast-forward', () => {
    const first = docsProductionCommit({ tag: 'v0.1.0', cwd: dir })
    const second = docsProductionCommit({ tag: 'v0.2.0', parent: first, cwd: dir })
    expect(git('rev-parse', `${second}^`)).toBe(first)
    expect(git('show', `${second}:docs/index.md`)).toBe('two')
    expect(files(second)).not.toContain('.github/workflows/release.yml')
    // The positive half of the line above: the source tag does carry the file being dropped.
    expect(files('v0.2.0')).toContain('.github/workflows/release.yml')
  })

  it('leaves the checkout\'s index alone', () => {
    write('docs/staged.md', 'staged')
    git('add', 'docs/staged.md')
    docsProductionCommit({ tag: 'v0.1.0', cwd: dir })
    expect(git('diff', '--cached', '--name-only')).toBe('docs/staged.md')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})

describe('release.yml wiring', () => {
  const yml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  const publishAt = yml.indexOf('id: publish')
  const docsAt = yml.indexOf('node scripts/docs-production.mjs')

  it('asks the script, after the publish step, and only when publish succeeded', () => {
    expect(publishAt).toBeGreaterThan(-1)
    expect(docsAt).toBeGreaterThan(publishAt)
    // The whole expression: without `!cancelled()` the implicit `success()` skips this step whenever
    // the GitHub Release step fails, after the packages are already out.
    expect(yml).toContain("if: ${{ !cancelled() && steps.publish.outcome == 'success' }}")
  })

  it('refetches tags before deciding, and pushes the built commit without --force only on `move`', () => {
    const step = yml.slice(yml.lastIndexOf('- name:', docsAt))
    expect(step.indexOf('git fetch --tags --force origin')).toBeGreaterThan(-1)
    expect(step.indexOf('git fetch --tags --force origin')).toBeLessThan(step.indexOf('node scripts/docs-production.mjs'))
    expect(step).toMatch(/if \[ "\$decision" = move \]/)
    // The branch is read before the tags: the other order lets a newer run's push land in between
    // and be taken as this run's parent, which fast-forwards the site back.
    expect(step.indexOf('git fetch origin refs/heads/docs-production')).toBeGreaterThan(-1)
    expect(step.indexOf('git fetch origin refs/heads/docs-production')).toBeLessThan(step.indexOf('git fetch --tags --force origin'))
    expect(step).toContain('node scripts/docs-production.mjs --commit "$GITHUB_REF_NAME" $parent')
    expect(step).toContain('git push origin "$commit:refs/heads/docs-production"')
    expect(step).not.toMatch(/push[^\n]*--force|push[^\n]*\+\$/)
  })
})
