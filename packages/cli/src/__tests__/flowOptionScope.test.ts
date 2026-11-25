import { describe, it, expect } from 'vitest'
import { createCli, misplaced, RUN_ONLY_OPTIONS, IMPORT_ONLY_OPTIONS } from '../program.js'

// What cac hands the `flow` action for an argv, without running it.
function optionsOf(argv: string[]): Record<string, unknown> {
  const cli = createCli()
  return cli.parse(['node', 'tapflow', ...argv], { run: false }).options
}

describe('flow option scope', () => {
  it('sees no misplaced option in a plain run or import', () => {
    expect(misplaced(optionsOf(['flow', 'run', 'a.yaml']), IMPORT_ONLY_OPTIONS)).toEqual([])
    expect(misplaced(optionsOf(['flow', 'run', 'a.yaml']), RUN_ONLY_OPTIONS)).toEqual([])
    expect(misplaced(optionsOf(['flow', 'import', '--from', 'maestro', 'm']), RUN_ONLY_OPTIONS)).toEqual([])
  })

  it('names a run option given to import, the negated ones included', () => {
    expect(misplaced(optionsOf(['flow', 'import', '--from', 'maestro', '--junit', 'x.xml', '--no-record', 'm']), RUN_ONLY_OPTIONS))
      .toEqual(['--junit', '--no-record'])
  })

  it('names an import option given to run', () => {
    expect(misplaced(optionsOf(['flow', 'run', '--env', 'A=1', '--overwrite', 'a.yaml']), IMPORT_ONLY_OPTIONS)).toEqual(['--env', '--overwrite'])
  })

  it('lists every option the flow command registers under exactly one subcommand', () => {
    const flow = createCli().commands.find((c) => c.name === 'flow')!
    const keys = flow.options.map((o) => o.names[0]).filter((n) => n !== 'help')
    const scoped = new Set([...Object.keys(RUN_ONLY_OPTIONS), ...Object.keys(IMPORT_ONLY_OPTIONS)])
    expect(keys.filter((k) => !scoped.has(k))).toEqual([])
  })
})
