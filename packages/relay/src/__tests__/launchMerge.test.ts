import { describe, it, expect } from 'vitest'
import { mergeLaunch, unmatchedLaunchKeys } from '../lib/launchDefaults.js'

const ALL = { options: true, env: true }

describe('mergeLaunch', () => {
  it('passes the caller through when there are no defaults', () => {
    expect(mergeLaunch(undefined, { arguments: { a: 1 } }, ALL)).toEqual({ options: { arguments: { a: 1 } }, defaultsOnly: false })
    expect(mergeLaunch(undefined, undefined, ALL)).toEqual({ options: undefined, defaultsOnly: false })
  })

  it('lets the caller win per key, in arguments and env alike', () => {
    const merged = mergeLaunch({ arguments: { a: 1, b: 2 }, env: { X: 'd', Y: 'd' } }, { arguments: { b: 3 }, env: { Y: 'c' } }, ALL)
    expect(merged).toEqual({ options: { arguments: { a: 1, b: 3 }, env: { X: 'd', Y: 'c' } }, defaultsOnly: false })
  })

  it('replaces a list whole rather than joining it', () => {
    expect(mergeLaunch({ arguments: { langs: ['en', 'ko'] } }, { arguments: { langs: ['ja'] } }, ALL).options).toEqual({ arguments: { langs: ['ja'] } })
  })

  it('marks a launch carrying only defaults', () => {
    expect(mergeLaunch({ arguments: { a: 1 } }, undefined, ALL)).toEqual({ options: { arguments: { a: 1 } }, defaultsOnly: true })
  })

  it('leaves env defaults out for a target without env, and keeps the caller\'s env for the agent to refuse', () => {
    expect(mergeLaunch({ arguments: { a: 1 }, env: { X: 'd' } }, undefined, { options: true, env: false }))
      .toEqual({ options: { arguments: { a: 1 } }, defaultsOnly: true, dropped: 'env' })
    expect(mergeLaunch({ env: { X: 'd' } }, { env: { Y: 'c' } }, { options: true, env: false }))
      .toEqual({ options: { env: { Y: 'c' } }, defaultsOnly: false, dropped: 'env' })
    expect(mergeLaunch({ env: { X: 'd' } }, undefined, { options: true, env: false }))
      .toEqual({ options: undefined, defaultsOnly: false, dropped: 'env' })
  })

  it('leaves every default out for a target without options', () => {
    expect(mergeLaunch({ arguments: { a: 1 } }, undefined, { options: false, env: false }))
      .toEqual({ options: undefined, defaultsOnly: false, dropped: 'all' })
  })
})

describe('unmatchedLaunchKeys', () => {
  it('names configured bundle ids no build was uploaded with, hinting at a case-only difference', () => {
    expect(unmatchedLaunchKeys(['com.example.app', 'com.Example.other', 'com.missing'], ['com.example.app', 'com.example.other'])).toEqual([
      'launch.com.Example.other in tapflow.config.json matches no build; did you mean com.example.other? Bundle ids are compared exactly',
      'launch.com.missing in tapflow.config.json matches no uploaded build yet',
    ])
  })
})
