import { describe, it, expect } from 'vitest'
import path from 'path'
import { convertMaestroFlow, isMaestroFlowFile } from '../maestro.js'
import { flowToYaml } from '../flowYaml.js'
import { parseFlow } from '../schema.js'
import type { ImportedFlow } from '../importReport.js'

const ROOT = '/suite'

function convert(files: Record<string, string>, entry = 'flow.yaml', env?: Record<string, string>): ImportedFlow {
  const readFile = (f: string): string => {
    const rel = path.relative(ROOT, f)
    const text = files[rel]
    if (text === undefined) throw new Error(`ENOENT: ${rel}`)
    return text
  }
  return convertMaestroFlow(path.join(ROOT, entry), { readFile, ...(env ? { env } : {}) })
}

function converted(r: ImportedFlow) {
  if (r.status !== 'converted') throw new Error(`not converted: ${JSON.stringify(r.issues)}`)
  return r.flow
}

describe('convertMaestroFlow', () => {
  it('carries over the commands that have a tapflow step', () => {
    const flow = converted(convert({
      'flow.yaml': `appId: com.example.app
name: Login
tags:
  - smoke
---
- launchApp:
    clearState: true
- tapOn: "Email"
- inputText: "user@example.com"
- tapOn:
    id: "password"
- inputText: 1234
- pressKey: Enter
- assertVisible: "Welcome"
- assertNotVisible:
    text: "Error"
- scroll
- openLink: "myapp://orders/1"
- clearState
`,
    }))
    expect(flow).toEqual({
      name: 'Login',
      appId: 'com.example.app',
      tags: ['smoke'],
      steps: [
        { type: 'clearState' },
        { type: 'launchApp' },
        { type: 'tapOn', selector: { text: 'Email' } },
        { type: 'inputText', text: 'user@example.com' },
        { type: 'tapOn', selector: { id: 'password' } },
        { type: 'inputText', text: '1234' },
        { type: 'pressKey', code: 'Enter' },
        { type: 'assertVisible', selector: { text: 'Welcome' } },
        { type: 'assertNotVisible', selector: { text: 'Error' } },
        { type: 'scroll', direction: 'down' },
        { type: 'openUrl', url: 'myapp://orders/1' },
        { type: 'clearState' },
      ],
    })
  })

  it('names the flow after its file when the config has no name', () => {
    expect(converted(convert({ 'flow.yaml': 'appId: a\n---\n- launchApp\n' })).name).toBe('flow')
  })

  it('accepts a flow that is only a command list', () => {
    expect(converted(convert({ 'flow.yaml': '- launchApp\n' })).steps).toEqual([{ type: 'launchApp' }])
  })

  it('turns extendedWaitUntil into an assertion with the same timeout', () => {
    const flow = converted(convert({
      'flow.yaml': `appId: a
---
- extendedWaitUntil:
    visible: "Home"
    timeout: 15000
- extendedWaitUntil:
    notVisible:
      id: spinner
    timeout: 3000
`,
    }))
    expect(flow.steps).toEqual([
      { type: 'assertVisible', selector: { label: 'Home', timeoutMs: 15000 } },
      { type: 'assertNotVisible', selector: { id: 'spinner', timeoutMs: 3000 } },
    ])
  })

  it('erases text one Backspace per character, 50 by default as Maestro does', () => {
    const steps = converted(convert({ 'flow.yaml': '- eraseText: 3\n- eraseText\n' })).steps
    expect(steps).toHaveLength(53)
    expect(new Set(steps.map((s) => JSON.stringify(s)))).toEqual(new Set([JSON.stringify({ type: 'pressKey', code: 'Backspace' })]))
  })

  it('reports waitForAnimationToEnd as dropped and still converts the flow', () => {
    const r = convert({ 'flow.yaml': '- launchApp\n- waitForAnimationToEnd\n- tapOn: Go\n' })
    expect(converted(r).steps).toHaveLength(2)
    expect(r.issues).toEqual([expect.objectContaining({ command: 'waitForAnimationToEnd', kind: 'dropped', line: 2 })])
  })

  it('converts percentage and direction swipes, keeping Maestro\'s 400 ms default', () => {
    const flow = converted(convert({
      'flow.yaml': `- swipe:
    start: "90%, 50%"
    end: "10%, 50%"
    duration: 250
- swipe:
    direction: UP
`,
    }))
    expect(flow.steps).toEqual([
      { type: 'swipe', from: [0.9, 0.5], to: [0.1, 0.5], durationMs: 250 },
      { type: 'swipe', from: [0.5, 0.7], to: [0.5, 0.3], durationMs: 400 },
    ])
  })

  it('maps text with an index to a label with the same index', () => {
    const flow = converted(convert({ 'flow.yaml': '- tapOn:\n    text: Buy\n    index: 1\n' }))
    expect(flow.steps).toEqual([{ type: 'tapOn', selector: { label: 'Buy', index: 1 } }])
  })

  it('reads regex escapes of punctuation as the literal character', () => {
    const flow = converted(convert({ 'flow.yaml': '- tapOn: "Total \\\\(2\\\\)"\n- tapOn: "Mr. Kim"\n' }))
    expect(flow.steps).toEqual([
      { type: 'tapOn', selector: { text: 'Total (2)' } },
      { type: 'tapOn', selector: { text: 'Mr. Kim' } },
    ])
  })

  it('passes launch arguments through', () => {
    const flow = converted(convert({ 'flow.yaml': 'appId: a\n---\n- launchApp:\n    arguments:\n      onboarding: false\n' }))
    expect(flow.steps).toEqual([{ type: 'launchApp', options: { arguments: { onboarding: false } } }])
  })

  it('keeps the text of a number YAML would shorten, as Maestro reads it', () => {
    const flow = converted(convert({
      'flow.yaml': 'env:\n  PIN: 0000\n---\n- inputText: 01012345678\n- inputText: ${PIN}\n- assertVisible: 10.50\n- inputText: 1234\n',
    }))
    expect(flow.steps).toEqual([
      { type: 'inputText', text: '01012345678' },
      { type: 'inputText', text: '0000' },
      { type: 'assertVisible', selector: { text: '10.50' } },
      { type: 'inputText', text: '1234' },
    ])
  })

  it('does not convert an env default it would type literally, unless --env sets it', () => {
    const files = { 'flow.yaml': "env:\n  USER: ${USER || 'guest'}\n---\n- inputText: ${USER}\n" }
    const r = convert(files)
    expect(r.status).toBe('not-converted')
    expect(r.issues).toEqual([expect.objectContaining({ command: 'inputText', line: 4, reason: expect.stringContaining('--env USER=') })])
    expect(converted(convert(files, 'flow.yaml', { USER: 'kim' })).steps).toEqual([{ type: 'inputText', text: 'kim' }])
    // Only a variable the commands use is checked.
    expect(convert({ 'flow.yaml': "env:\n  A: kim\n  B: ${B || 'x'}\n---\n- inputText: ${A}\n" }).status).toBe('converted')
  })

  it('keeps launch arguments numbers, as Maestro passes them', () => {
    const flow = converted(convert({ 'flow.yaml': 'appId: a\n---\n- launchApp:\n    arguments:\n      ratio: 1.0\n' }))
    expect(flow.steps).toEqual([{ type: 'launchApp', options: { arguments: { ratio: 1 } } }])
  })

  it('refuses launch arguments the relay would refuse', () => {
    const r = convert({ 'flow.yaml': '- launchApp:\n    arguments:\n      config:\n        a: 1\n' })
    expect(r.status).toBe('not-converted')
    expect(r.issues[0].command).toBe('launchApp')
  })

  it('reports the tapOn retry options it drops', () => {
    const r = convert({ 'flow.yaml': '- tapOn:\n    text: Next\n    retryTapIfNoChange: true\n' })
    expect(converted(r).steps).toEqual([{ type: 'tapOn', selector: { text: 'Next' } }])
    expect(r.issues).toEqual([expect.objectContaining({ command: 'tapOn', kind: 'dropped', line: 1, reason: expect.stringContaining('retryTapIfNoChange') })])
  })

  it('types any scalar inputText as Maestro does, the empty string included', () => {
    expect(converted(convert({ 'flow.yaml': '- inputText: true\n- inputText: ""\n' })).steps).toEqual([
      { type: 'inputText', text: 'true' },
      { type: 'inputText', text: '' },
    ])
  })

  it('refuses an eraseText too long to be one key press per character', () => {
    expect(converted(convert({ 'flow.yaml': '- eraseText: 1000\n' })).steps).toHaveLength(1000)
    expect(convert({ 'flow.yaml': '- eraseText: 1001\n' }).issues[0].reason).toMatch(/over 1000/)
  })

  it('accepts launchApp with an appId in a flow that names none, in either form', () => {
    for (const text of ['- launchApp: com.a\n', '- launchApp:\n    appId: com.a\n']) {
      expect(converted(convert({ 'flow.yaml': text })).steps).toEqual([{ type: 'launchApp' }])
    }
  })

  describe('env', () => {
    it('substitutes ${NAME} from the flow env, with --env winning', () => {
      const files = { 'flow.yaml': 'appId: ${APP}\nenv:\n  APP: com.a\n  USER: kim\n---\n- inputText: ${USER}@example.com\n' }
      const a = converted(convert(files))
      expect(a.appId).toBe('com.a')
      expect(a.steps).toEqual([{ type: 'inputText', text: 'kim@example.com' }])
      expect(converted(convert(files, 'flow.yaml', { USER: 'lee' })).steps).toEqual([{ type: 'inputText', text: 'lee@example.com' }])
    })

    it('does not convert an unset variable or a JavaScript expression', () => {
      const r = convert({ 'flow.yaml': '- inputText: ${MISSING}\n- inputText: ${output.token}\n' })
      expect(r.status).toBe('not-converted')
      expect(r.issues.map((i) => [i.line, i.reason])).toEqual([
        [1, expect.stringContaining('MISSING} is not set')],
        [2, expect.stringContaining('JavaScript expression')],
      ])
    })
  })

  describe('runFlow', () => {
    it('inlines a subflow, relative to the file that runs it, with the env it passes', () => {
      const flow = converted(convert({
        'flow.yaml': 'appId: a\n---\n- launchApp\n- runFlow:\n    file: common/login.yaml\n    env:\n      USER: kim\n- assertVisible: Home\n',
        'common/login.yaml': 'appId: a\nenv:\n  USER: nobody\n---\n- tapOn: Email\n- inputText: ${USER}\n- runFlow: submit.yaml\n',
        'common/submit.yaml': '- tapOn: Sign in\n',
      }))
      expect(flow.steps).toEqual([
        { type: 'launchApp' },
        { type: 'tapOn', selector: { text: 'Email' } },
        { type: 'inputText', text: 'kim' },
        { type: 'tapOn', selector: { text: 'Sign in' } },
        { type: 'assertVisible', selector: { text: 'Home' } },
      ])
    })

    it('substitutes ${NAME} in the short runFlow form too', () => {
      const flow = converted(convert({
        'flow.yaml': 'env:\n  DIR: common\n---\n- runFlow: ${DIR}/a.yaml\n',
        'common/a.yaml': '- tapOn: A\n',
      }))
      expect(flow.steps).toEqual([{ type: 'tapOn', selector: { text: 'A' } }])
    })

    it('inlines commands given in place', () => {
      const flow = converted(convert({ 'flow.yaml': '- runFlow:\n    commands:\n      - tapOn: A\n      - tapOn: B\n' }))
      expect(flow.steps.map((s) => s.type)).toEqual(['tapOn', 'tapOn'])
    })

    it('reports an issue inside a subflow at the subflow\'s own file and line', () => {
      const r = convert({
        'flow.yaml': '- launchApp\n- runFlow: sub.yaml\n',
        'sub.yaml': '- tapOn: A\n- repeat:\n    times: 2\n    commands:\n      - tapOn: B\n',
      })
      expect(r.status).toBe('not-converted')
      expect(r.issues).toEqual([{ file: path.join(ROOT, 'sub.yaml'), line: 2, command: 'repeat', kind: 'unconverted', reason: 'Maestro command "repeat" has no tapflow step' }])
    })

    it('reads a subflow\'s config with the same rules: hooks and another app are refused', () => {
      const hooks = convert({
        'flow.yaml': 'appId: a\n---\n- runFlow: sub.yaml\n',
        'sub.yaml': 'appId: a\nonFlowComplete:\n  - assertVisible: Saved\n---\n- tapOn: Save\n',
      })
      expect(hooks.issues).toEqual([expect.objectContaining({ file: path.join(ROOT, 'sub.yaml'), line: 2, command: 'onFlowComplete' })])
      const settings = convert({
        'flow.yaml': 'appId: a\n---\n- runFlow: settings.yaml\n',
        'settings.yaml': 'appId: com.apple.Preferences\n---\n- launchApp\n',
      })
      expect(settings.issues[0]).toMatchObject({ command: 'appId', reason: expect.stringContaining('not a') })
    })

    it('refuses a conditional runFlow, a missing subflow and a cycle', () => {
      expect(convert({ 'flow.yaml': '- runFlow:\n    when:\n      visible: X\n    file: a.yaml\n' }).issues[0].reason).toMatch(/conditional/)
      expect(convert({ 'flow.yaml': '- runFlow: nope.yaml\n' }).issues[0].reason).toMatch(/subflow nope.yaml: cannot read/)
      const cycle = convert({ 'flow.yaml': '- runFlow: a.yaml\n', 'a.yaml': '- runFlow: flow.yaml\n' })
      expect(cycle.issues[0]).toMatchObject({ file: path.join(ROOT, 'a.yaml'), reason: expect.stringMatching(/runs itself/) })
    })
  })

  describe('what it does not convert', () => {
    it('reports every command without a step, by line, and writes no flow', () => {
      const r = convert({
        'flow.yaml': `appId: a
---
- launchApp
- takeScreenshot: home
- tapOn: Next
- evalScript: \${output.x = 1}
- back
`,
      })
      expect(r.status).toBe('not-converted')
      expect('flow' in r).toBe(false)
      expect(r.issues.map((i) => [i.command, i.line])).toEqual([['takeScreenshot', 4], ['evalScript', 6], ['back', 7]])
    })

    it.each([
      ['a regex text', '- tapOn: "Item .*"\n', /regular expression/],
      ['a relative selector', '- tapOn:\n    text: Buy\n    below: Price\n', /"below"/],
      ['an optional step', '- tapOn:\n    text: Allow\n    optional: true\n', /optional/],
      ['a point tap', '- tapOn:\n    point: "50%, 50%"\n', /"point"/],
      ['a state selector', '- assertVisible:\n    text: Save\n    enabled: true\n', /"enabled"/],
      ['the device Back key', '- pressKey: Back\n', /Back/],
      ['a pixel swipe', '- swipe:\n    start: 100, 200\n    end: 100, 600\n', /pixel/],
      ['another app', 'appId: a\n---\n- launchApp: com.other\n', /another app/],
      ['launch permissions', '- launchApp:\n    permissions:\n      all: deny\n', /permissions/],
      ['flow hooks', 'appId: a\nonFlowStart:\n  - tapOn: X\n---\n- launchApp\n', /onFlowStart/],
      ['clearState with no app', '- clearState\n', /needs an app id/],
    ])('%s', (_name, text, reason) => {
      const r = convert({ 'flow.yaml': text })
      expect(r.status).toBe('not-converted')
      expect(r.issues.some((i) => i.kind === 'unconverted' && reason.test(i.reason))).toBe(true)
    })

    it('reports a file that is not YAML', () => {
      expect(convert({ 'flow.yaml': '- tapOn: [\n' }).issues[0].reason).toMatch(/invalid YAML/)
    })

    it('reports a flow whose only commands were dropped', () => {
      expect(convert({ 'flow.yaml': '- waitForAnimationToEnd\n' }).status).toBe('not-converted')
    })
  })
})

describe('flowToYaml', () => {
  it('writes a flow parseFlow reads back to the same flow', () => {
    const flow = converted(convert({
      'flow.yaml': `appId: com.example.app
name: Round trip
tags: [smoke]
---
- launchApp:
    clearState: true
    arguments:
      onboarding: false
- tapOn: "123"
- tapOn:
    id: email
    index: 0
- inputText: "yes"
- pressKey: Backspace
- extendedWaitUntil:
    visible: Home
    timeout: 1500
- swipe:
    direction: LEFT
- openLink: myapp://x
- clearState: com.other
`,
    }))
    const yaml = flowToYaml(flow, 'Converted from flow.yaml')
    expect(yaml.startsWith('# Converted from flow.yaml\n')).toBe(true)
    const { file: _file, ...back } = parseFlow(yaml, 'out.yaml')
    expect(back).toEqual(flow)
  })
})

describe('isMaestroFlowFile', () => {
  it('takes YAML flows and leaves the workspace config out', () => {
    expect(['a.yaml', 'b.yml', 'config.yaml', 'config.yml', 'notes.md'].filter(isMaestroFlowFile)).toEqual(['a.yaml', 'b.yml'])
  })
})
