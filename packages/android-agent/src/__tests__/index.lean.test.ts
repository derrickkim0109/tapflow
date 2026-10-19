import { describe, expect, it, vi } from 'vitest'

// Stands in for the agent so the registration can be driven without a relay; what it records is
// the options the registered `connect` hands over.
const made = vi.hoisted(() => ({ opts: [] as unknown[] }))
vi.mock('../AndroidAgent', () => ({
  AndroidAgent: vi.fn(function (this: unknown, opts: unknown) {
    made.opts.push(opts)
    return { connect: vi.fn(async () => {}), disconnect: vi.fn() }
  }),
}))

import { AgentRegistry } from '@tapflowio/agent-core'
import '../index'

describe('the android registration', () => {
  it('hands agent.lean from the CLI to the agent it builds', async () => {
    await AgentRegistry.connect('android', 'ws://localhost:1', { lean: true })
    expect(made.opts.at(-1)).toMatchObject({ lean: true })
  })
})
