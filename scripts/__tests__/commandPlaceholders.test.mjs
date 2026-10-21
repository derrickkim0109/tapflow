// No `.claude/commands/*.md` body holds a dollar sign followed by a digit.
//
// Claude Code reads such a pair in a command as a positional argument and replaces it before the
// session sees the text: `$0` is the first argument, `$1` the second. `/release 0.28.1` turned the
// changelog sweep's `awk '$0 ~ …'` into `awk '0.28.1 ~ …'`, and the sweep read nothing. Write awk's
// whole line as `$(0)`, the same to awk. A braced shell positional came through untouched in the same
// run (`${1:-…}`, observed), so that is the form for sh.
//
// The absence assertion is paired (`contributing/test-and-guard-coverage.md` rule 2): the finder
// must report a planted `$0` and `$1`, and the walk is anchored on `release.md` by name, so a walk
// that found no commands cannot pass. The walk recurses, since a command in a subfolder is a
// namespaced command and is substituted the same way.
//
// Mutation run by hand on 2026-10-21: `$(0)` in `release.md` put back to `$0` — red, naming line 101.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const COMMANDS = join(import.meta.dirname, '..', '..', '.claude', 'commands')

/** `line: text` for each line of `text` holding a dollar sign followed by a digit. */
function positionals(text) {
  return text.split('\n').flatMap((line, i) => (/\$\d/.test(line) ? [`${i + 1}: ${line.trim()}`] : []))
}

describe('command bodies', () => {
  it('finds a planted positional', () => {
    expect(positionals("ok\nawk '$0 ~ x'\necho ${1:-a} $(0)\nshift; echo $1")).toEqual([
      "2: awk '$0 ~ x'",
      '4: shift; echo $1',
    ])
  })

  it('hold no dollar-digit pair, which Claude Code would replace with an argument', () => {
    const files = readdirSync(COMMANDS, { recursive: true }).filter((f) => f.endsWith('.md'))
    expect(files).toContain('release.md')
    const found = files.flatMap((f) => positionals(readFileSync(join(COMMANDS, f), 'utf8')).map((l) => `${f}:${l}`))
    expect(found).toEqual([])
  })
})
