import type { FlowResult } from './engine.js'

function esc(s: string): string {
  return s
    // control characters (except \t \n \r) are illegal in XML 1.0 and break strict CI parsers
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stepLog(result: FlowResult): string {
  return result.steps
    .map((s) => {
      if (s.status === 'passed') return `✓ ${s.name} (${s.durationMs}ms)`
      if (s.status === 'failed') return `✗ ${s.name} (${s.durationMs}ms): ${s.message ?? ''}`
      return `- ${s.name} (skipped)`
    })
    .join('\n')
}

/** A flow the run chose not to replay (`isEligible`). Not a `FlowResult`: the engine never saw it. */
export interface SkippedFlow {
  name: string
  file?: string
  message: string
}

export function toJUnitXml(results: FlowResult[], skipped: SkippedFlow[] = []): string {
  return document([suite('tapflow-flows', results, skipped)])
}

/** One device's flows, for a run that shared its flows across several. */
export interface JUnitSuite {
  name: string
  results: FlowResult[]
}

/**
 * A `<testsuite>` per suite, for a run across several devices, so a CI page shows which device ran which flow. Flows
 * the run chose not to replay (`skipped`) ran on no device and get a suite of their own. Flows it meant to run that no
 * device got to (`notRun`) are `<error>` cases in another: as `<skipped>` a CI report would show a run that tested
 * nothing as green, and the exit code would be the only thing saying otherwise.
 */
export function toJUnitXmlSuites(suites: JUnitSuite[], skipped: SkippedFlow[] = [], notRun: SkippedFlow[] = []): string {
  return document([
    ...suites.map((s) => suite(s.name, s.results, [])),
    ...(skipped.length > 0 ? [suite('tapflow-flows (skipped)', [], skipped)] : []),
    ...(notRun.length > 0 ? [suite('tapflow-flows (not run)', [], [], notRun)] : []),
  ], true)
}

interface RenderedSuite { xml: string; tests: number; failures: number; errors: number; skipped: number; ms: number }

function suite(name: string, results: FlowResult[], skipped: SkippedFlow[], notRun: SkippedFlow[] = []): RenderedSuite {
  const failures = results.filter((r) => r.status === 'failed').length
  const tests = results.length + skipped.length + notRun.length
  const ms = results.reduce((acc, r) => acc + r.durationMs, 0)
  const totalSec = (ms / 1000).toFixed(3)

  const cases = results
    .map((r) => {
      const attrs = `name="${esc(r.name)}" classname="${esc(r.file ?? r.name)}" time="${(r.durationMs / 1000).toFixed(3)}"`
      if (r.status === 'passed') {
        return `    <testcase ${attrs}>\n      <system-out>${esc(stepLog(r))}</system-out>\n    </testcase>`
      }
      return (
        `    <testcase ${attrs}>\n` +
        `      <failure message="${esc(r.failureMessage ?? 'flow failed')}">${esc(stepLog(r))}</failure>\n` +
        `    </testcase>`
      )
    })
    .concat(skipped.map((f) =>
      `    <testcase name="${esc(f.name)}" classname="${esc(f.file ?? f.name)}" time="0.000">\n` +
      `      <skipped message="${esc(f.message)}"/>\n` +
      `    </testcase>`))
    .concat(notRun.map((f) =>
      `    <testcase name="${esc(f.name)}" classname="${esc(f.file ?? f.name)}" time="0.000">\n` +
      `      <error message="${esc(f.message)}"/>\n` +
      `    </testcase>`))
    .join('\n')

  // `errors` only where a suite can have any, so the single-device report keeps the attributes it always had.
  const errors = notRun.length > 0 ? ` errors="${notRun.length}"` : ''
  return {
    xml: `  <testsuite name="${esc(name)}" tests="${tests}" failures="${failures}"${errors} skipped="${skipped.length}" time="${totalSec}">\n` +
      `${cases}\n` +
      '  </testsuite>\n',
    tests, failures, errors: notRun.length, skipped: skipped.length, ms,
  }
}

function document(suites: RenderedSuite[], withErrors = false): string {
  const sum = (k: 'tests' | 'failures' | 'errors' | 'skipped' | 'ms') => suites.reduce((acc, s) => acc + s[k], 0)
  const errors = withErrors ? ` errors="${sum('errors')}"` : ''
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites tests="${sum('tests')}" failures="${sum('failures')}"${errors} skipped="${sum('skipped')}" time="${(sum('ms') / 1000).toFixed(3)}">\n` +
    suites.map((s) => s.xml).join('') +
    '</testsuites>\n'
  )
}
