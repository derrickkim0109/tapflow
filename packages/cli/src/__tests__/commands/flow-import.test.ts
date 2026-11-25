import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseFlow, type ImportReport } from '@tapflowio/flow-runner'
import { cmdFlowImport } from '../../commands/flow-import.js'

let dir: string
let cwd: string

function write(rel: string, text: string): void {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-import-'))
  cwd = process.cwd()
  process.chdir(dir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  process.chdir(cwd)
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('cmdFlowImport', () => {
  it('converts a directory into .tapflow/flows, leaving config.yaml and subflow folders as inputs only', async () => {
    write('.maestro/config.yaml', 'flows:\n  - "*"\n')
    write('.maestro/login.yaml', 'appId: com.a\n---\n- launchApp\n- runFlow: common/fill.yaml\n- assertVisible: Home\n')
    write('.maestro/common/fill.yaml', '- tapOn: Email\n- inputText: ${USER}\n')

    expect(await cmdFlowImport(['.maestro'], { from: 'maestro', env: 'USER=kim' })).toBe(0)

    expect(fs.readdirSync(path.join(dir, '.tapflow/flows'))).toEqual(['login.yaml'])
    const text = fs.readFileSync(path.join(dir, '.tapflow/flows/login.yaml'), 'utf-8')
    expect(text.startsWith('# Converted from .maestro/login.yaml by `tapflow flow import --from maestro`.\n')).toBe(true)
    expect(parseFlow(text, 'login.yaml').steps).toEqual([
      { type: 'launchApp' },
      { type: 'tapOn', selector: { text: 'Email' } },
      { type: 'inputText', text: 'kim' },
      { type: 'assertVisible', selector: { text: 'Home' } },
    ])
  })

  it('writes no file for a flow it cannot convert, exits 1, and says why in the report', async () => {
    write('m/ok.yaml', '- launchApp\n')
    write('m/bad.yaml', '- launchApp\n- takeScreenshot: x\n')

    expect(await cmdFlowImport(['m'], { from: 'maestro', out: 'out', report: 'report.json' })).toBe(1)

    expect(fs.readdirSync(path.join(dir, 'out'))).toEqual(['ok.yaml'])
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf-8')) as ImportReport
    expect(report).toEqual({
      format: 'tapflow-import-report',
      version: 1,
      from: 'maestro',
      flows: [
        { source: 'm/bad.yaml', status: 'not-converted', issues: [{ file: 'm/bad.yaml', line: 2, command: 'takeScreenshot', kind: 'unconverted', reason: 'Maestro command "takeScreenshot" has no tapflow step' }] },
        { source: 'm/ok.yaml', status: 'converted', output: 'out/ok.yaml', issues: [] },
      ],
    })
  })

  it('keeps each flow\'s path relative to the inputs\' common directory', async () => {
    write('suite/a/one.yaml', '- launchApp\n')
    write('suite/b/one.yaml', '- launchApp\n')
    expect(await cmdFlowImport(['suite/a/one.yaml', 'suite/b'], { from: 'maestro', out: 'out' })).toBe(0)
    expect(fs.existsSync(path.join(dir, 'out/a/one.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'out/b/one.yaml'))).toBe(true)
  })

  it('refuses to replace an existing flow without --overwrite, and writes nothing', async () => {
    write('m/a.yaml', '- launchApp\n')
    write('m/b.yaml', '- launchApp\n')
    write('out/a.yaml', 'edited by hand\n')

    expect(await cmdFlowImport(['m'], { from: 'maestro', out: 'out' })).toBe(2)
    expect(fs.readFileSync(path.join(dir, 'out/a.yaml'), 'utf-8')).toBe('edited by hand\n')
    expect(fs.existsSync(path.join(dir, 'out/b.yaml'))).toBe(false)

    expect(await cmdFlowImport(['m'], { from: 'maestro', out: 'out', overwrite: true })).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'out/a.yaml'), 'utf-8')).toMatch(/^# Converted from/)
  })

  it('names a file an earlier import left for a flow that no longer converts, and leaves it in place', async () => {
    write('m/a.yaml', '- launchApp\n- takeScreenshot: x\n')
    write('out/a.yaml', 'from last week\n')
    expect(await cmdFlowImport(['m'], { from: 'maestro', out: 'out', report: 'r.json' })).toBe(1)
    expect(fs.readFileSync(path.join(dir, 'out/a.yaml'), 'utf-8')).toBe('from last week\n')
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf-8')) as ImportReport
    expect(report.flows[0]).toMatchObject({ status: 'not-converted', staleOutput: 'out/a.yaml' })
  })

  it('refuses an --out that would replace the Maestro flows themselves, even with --overwrite', async () => {
    write('m/a.yaml', '- launchApp\n')
    expect(await cmdFlowImport(['m'], { from: 'maestro', out: 'm', overwrite: true })).toBe(2)
    expect(fs.readFileSync(path.join(dir, 'm/a.yaml'), 'utf-8')).toBe('- launchApp\n')
  })

  it.each([
    ['no --from', ['m'], {}],
    ['an unknown format', ['m'], { from: 'appium' }],
    ['no inputs', [], { from: 'maestro' }],
    ['a missing input', ['nope.yaml'], { from: 'maestro' }],
    ['a malformed --env', ['m'], { from: 'maestro', env: 'NOEQUALS' }],
    ['a directory with no flows', ['empty'], { from: 'maestro' }],
  ])('exits 2 on %s', async (_name, inputs, opts) => {
    write('m/a.yaml', '- launchApp\n')
    fs.mkdirSync(path.join(dir, 'empty'))
    expect(await cmdFlowImport(inputs, opts)).toBe(2)
  })
})
