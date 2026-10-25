import { describe, it, expect } from 'vitest'
import { parseServiceTier, SERVICE_FEATURES } from '../serviceTier.js'

describe('parseServiceTier', () => {
  it('reads a name and a comma-separated feature list, deduplicated', () => {
    expect(parseServiceTier('slim', 'push, photos,push')).toEqual({ name: 'slim', keep: ['push', 'photos'] })
    expect(parseServiceTier('lean', undefined)).toEqual({ name: 'lean', keep: [] })
    expect(parseServiceTier('stock', '')).toEqual({ name: 'stock', keep: [] })
    expect(() => parseServiceTier('stock', 'push')).toThrow(/nothing to keep/)
  })

  it('refuses an unknown tier or feature rather than dropping it', () => {
    expect(() => parseServiceTier('turbo', undefined)).toThrow(/unknown service tier "turbo"/)
    expect(() => parseServiceTier('slim', 'push,pushh')).toThrow(/unknown feature "pushh"/)
  })

  it('knows every feature the protocol names', () => {
    expect(SERVICE_FEATURES).toHaveLength(24)
  })
})
