import { describe, it, expect } from 'vitest'
import { toJUnitXml, toJUnitXmlSuites } from '../junit.js'
import type { FlowResult } from '../engine.js'

const passed: FlowResult = {
  name: 'login',
  file: '.tapflow/flows/login.yaml',
  status: 'passed',
  durationMs: 1234,
  steps: [
    { index: 0, name: 'launchApp', status: 'passed', durationMs: 1000 },
    { index: 1, name: 'tapOn("로그인")', status: 'passed', durationMs: 234 },
  ],
}

const failed: FlowResult = {
  name: 'checkout <fast> & "cheap"',
  file: '.tapflow/flows/checkout.yaml',
  status: 'failed',
  durationMs: 5000,
  failureMessage: 'tapOn("결제"): no element matched "결제" within 10s',
  steps: [
    { index: 0, name: 'launchApp', status: 'passed', durationMs: 1000 },
    { index: 1, name: 'tapOn("결제")', status: 'failed', durationMs: 4000, message: 'no element matched "결제" within 10s' },
    { index: 2, name: 'pressKey(Enter)', status: 'skipped', durationMs: 0 },
  ],
}

describe('toJUnitXml', () => {
  it('renders one testcase per flow with counts and times', () => {
    const xml = toJUnitXml([passed, failed])
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('tests="2"')
    expect(xml).toContain('failures="1"')
    expect(xml).toContain('name="login"')
    expect(xml).toContain('classname=".tapflow/flows/login.yaml"')
    expect(xml).toContain('time="1.234"')
  })

  it('embeds the failure message and step log, XML-escaped', () => {
    const xml = toJUnitXml([failed])
    expect(xml).toContain('name="checkout &lt;fast&gt; &amp; &quot;cheap&quot;"')
    expect(xml).toContain('<failure message="tapOn(&quot;결제&quot;): no element matched &quot;결제&quot; within 10s">')
    expect(xml).toContain('✗ tapOn(&quot;결제&quot;)')
    expect(xml).toContain('- pressKey(Enter) (skipped)')
  })

  it('produces no failure element for a passing flow', () => {
    const xml = toJUnitXml([passed])
    expect(xml).not.toContain('<failure')
  })

  it('lists a skipped flow as a skipped testcase and counts it', () => {
    const xml = toJUnitXml([passed], [{ name: 'other app', file: 'b.yaml', message: 'flow is for com.a, build 7 is com.b' }])
    expect(xml).toContain('<testsuites tests="2" failures="0" skipped="1"')
    expect(xml).toContain('<testsuite name="tapflow-flows" tests="2" failures="0" skipped="1"')
    expect(xml).toContain('<testcase name="other app" classname="b.yaml" time="0.000">\n      <skipped message="flow is for com.a, build 7 is com.b"/>')
  })

  it('says skipped="0" when nothing was skipped', () => {
    expect(toJUnitXml([passed])).toContain('tests="1" failures="0" skipped="0"')
  })

  it('strips XML-invalid control characters from messages', () => {
    const xml = toJUnitXml([{
      ...failed,
      failureMessage: 'boom\x07\x00 with bell',
    }])
    expect(xml).toContain('message="boom with bell"')
  })
})

describe('toJUnitXmlSuites', () => {
  it('writes a suite per device, totals across them, and the flows it skipped in a suite of their own', () => {
    const xml = toJUnitXmlSuites(
      [{ name: 'tapflow-flows (iPhone A)', results: [passed] }, { name: 'tapflow-flows (iPhone <B>)', results: [failed] }],
      [{ name: 'tagged out', message: 'not tagged smoke' }],
    )
    expect(xml).toContain('<testsuites tests="3" failures="1" errors="0" skipped="1" time="6.234">')
    expect(xml).toContain('<testsuite name="tapflow-flows (iPhone A)" tests="1" failures="0" skipped="0" time="1.234">')
    expect(xml).toContain('<testsuite name="tapflow-flows (iPhone &lt;B&gt;)" tests="1" failures="1" skipped="0" time="5.000">')
    expect(xml).toContain('<testsuite name="tapflow-flows (skipped)" tests="1" failures="0" skipped="1" time="0.000">')
    expect(xml.match(/<testsuite /g)).toHaveLength(3)
  })

  // As <skipped>, a run where no device got to a flow would read green in a CI report; an error does not.
  it('reports the flows no device ran as errors, apart from the ones it chose to skip', () => {
    const xml = toJUnitXmlSuites([], [{ name: 'tagged out', message: 'not tagged smoke' }], [{ name: 'login', file: 'login.yaml', message: 'not run: no device was left to run it' }])
    expect(xml).toContain('<testsuites tests="2" failures="0" errors="1" skipped="1"')
    expect(xml).toContain('<testsuite name="tapflow-flows (not run)" tests="1" failures="0" errors="1" skipped="0" time="0.000">')
    expect(xml).toContain('<testcase name="login" classname="login.yaml" time="0.000">\n      <error message="not run: no device was left to run it"/>')
  })

  it('adds no skipped or not-run suite when every flow ran', () => {
    const xml = toJUnitXmlSuites([{ name: 'tapflow-flows (iPhone A)', results: [passed] }])
    expect(xml).not.toContain('(not run)')
    expect(xml).not.toContain('(skipped)')
  })

  // The single-device report is what CI parsers already read; the shared renderer must not change a byte of it.
  it('leaves the single-suite report as it was', () => {
    expect(toJUnitXml([passed], [{ name: 'x', message: 'm' }])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<testsuites tests="2" failures="0" skipped="1" time="1.234">\n' +
      '  <testsuite name="tapflow-flows" tests="2" failures="0" skipped="1" time="1.234">\n' +
      '    <testcase name="login" classname=".tapflow/flows/login.yaml" time="1.234">\n' +
      '      <system-out>✓ launchApp (1000ms)\n✓ tapOn(&quot;로그인&quot;) (234ms)</system-out>\n' +
      '    </testcase>\n' +
      '    <testcase name="x" classname="x" time="0.000">\n' +
      '      <skipped message="m"/>\n' +
      '    </testcase>\n' +
      '  </testsuite>\n' +
      '</testsuites>\n',
    )
  })
})
