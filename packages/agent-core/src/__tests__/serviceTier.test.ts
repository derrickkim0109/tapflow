import { describe, it, expect } from 'vitest'
import { sameServiceTier } from '../utils/serviceTier.js'

describe('sameServiceTier', () => {
  it('compares the name, and the features as a set', () => {
    expect(sameServiceTier({ name: 'slim', keep: ['push', 'photos'] }, { name: 'slim', keep: ['photos', 'push'] })).toBe(true)
    expect(sameServiceTier({ name: 'slim', keep: ['push'] }, { name: 'lean', keep: ['push'] })).toBe(false)
    expect(sameServiceTier({ name: 'slim', keep: ['push'] }, { name: 'slim', keep: [] })).toBe(false)
  })

  it('does not count a repeated feature as a different one', () => {
    expect(sameServiceTier({ name: 'slim', keep: ['push', 'push'] }, { name: 'slim', keep: ['push', 'photos'] })).toBe(false)
    expect(sameServiceTier({ name: 'slim', keep: ['push', 'push'] }, { name: 'slim', keep: ['push'] })).toBe(true)
  })

  it('treats stock as stock whatever it allows, since it switches nothing off and records no marker', () => {
    expect(sameServiceTier({ name: 'stock', keep: ['push'] }, { name: 'stock', keep: [] })).toBe(true)
  })
})
