import { stringify } from 'yaml'
import type { Flow, Selector, Step } from './schema.js'

/**
 * A `Flow` written back as the YAML `parseFlow` reads. Every form written here is one `parseFlow` accepts, and
 * `flow import` reads each file it writes back through `parseFlow` before keeping it.
 */
export function flowToYaml(flow: Flow, header?: string): string {
  const doc: Record<string, unknown> = { name: flow.name }
  if (flow.appId !== undefined) doc.appId = flow.appId
  if (flow.tags !== undefined && flow.tags.length > 0) doc.tags = flow.tags
  doc.steps = flow.steps.map(stepToYaml)
  const body = stringify(doc, { lineWidth: 0 })
  return header === undefined ? body : `${header.split('\n').map((l) => `# ${l}`.trimEnd()).join('\n')}\n${body}`
}

function selectorToYaml(sel: Selector): unknown {
  if (sel.text !== undefined) return sel.text
  const out: Record<string, unknown> = {}
  if (sel.id !== undefined) out.id = sel.id
  if (sel.label !== undefined) out.label = sel.label
  if (sel.role !== undefined) out.role = sel.role
  if (sel.index !== undefined) out.index = sel.index
  if (sel.timeoutMs !== undefined) out.timeout = sel.timeoutMs / 1000
  return out
}

function stepToYaml(step: Step): unknown {
  switch (step.type) {
    case 'clearState': return step.appId === undefined ? 'clearState' : { clearState: step.appId }
    case 'launchApp': return step.options === undefined ? 'launchApp' : { launchApp: step.options }
    case 'tapOn': return { tapOn: selectorToYaml(step.selector) }
    case 'inputText': return { inputText: step.text }
    case 'pressKey': return { pressKey: step.code }
    case 'swipe': return { swipe: { from: step.from, to: step.to, durationMs: step.durationMs } }
    case 'scroll': return { scroll: step.direction }
    case 'openUrl': return { openUrl: step.url }
    case 'assertVisible': return { assertVisible: selectorToYaml(step.selector) }
    case 'assertNotVisible': return { assertNotVisible: selectorToYaml(step.selector) }
  }
}
