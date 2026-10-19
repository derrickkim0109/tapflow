import { describe, it, expect } from 'vitest'
import { KNOWN_AGENT_CAPABILITIES, hasCapability, isAgentCapability } from '../types'

describe('agent capabilities (#700)', () => {
  it('knows the vocabulary and nothing outside it', () => {
    for (const cap of KNOWN_AGENT_CAPABILITIES) expect(isAgentCapability(cap)).toBe(true)
    expect(isAgentCapability('network-contro')).toBe(false)
    expect(isAgentCapability('')).toBe(false)
  })

  it('finds a capability in an announced list', () => {
    expect(hasCapability(['clipboard', 'network-control'], 'network-control')).toBe(true)
    expect(hasCapability(['clipboard'], 'network-control')).toBe(false)
  })

  // An agent that predates capabilities announces none, and a session can carry no list at all.
  it('treats a missing list as announcing nothing', () => {
    expect(hasCapability(undefined, 'clipboard')).toBe(false)
  })

  // The list is `string[]` on purpose: an unknown entry is a newer agent, not a broken one.
  it('ignores entries it does not know rather than rejecting the list', () => {
    expect(hasCapability(['future-capability', 'full-reset'], 'full-reset')).toBe(true)
  })
})
