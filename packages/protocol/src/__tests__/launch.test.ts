import { describe, expect, it } from 'vitest'

import { MAX_LAUNCH_KEYS, MAX_LAUNCH_TOTAL, appliedKeys, compactLaunchOptions, hasLaunchOptions, launchOptionsProblem } from '../launch/index.js'

const problem = (opts: { arguments?: unknown; env?: unknown }) => launchOptionsProblem(opts)

describe('launchOptionsProblem', () => {
  it('accepts every value type the platforms can both carry', () => {
    expect(problem({ arguments: { FIRDebugEnabled: true, apiHost: 's.example.com', n: -7, big: 3_000_000_000, AppleLanguages: ['en', 'ko'], 'com.apple.CoreData.SQLDebug': 1 } })).toBeNull()
    expect(problem({ env: { API_HOST: 'x', _PRIVATE: '' } })).toBeNull()
    expect(problem({})).toBeNull()
  })

  it('tells a key written with its iOS dash how to fix it', () => {
    expect(problem({ arguments: { '-FIRDebugEnabled': true } })).toMatch(/without the leading "-" \(FIRDebugEnabled\)/)
  })

  it('refuses keys an adb shell line or the other platform would read differently', () => {
    for (const key of ['', 'a b', 'a;rm', '_x', 'a$b', "a'b", 'é', 'x'.repeat(129)]) {
      expect(problem({ arguments: { [key]: 'v' } }), key).toMatch(/^arguments\./)
    }
    expect(problem({ arguments: { ['x'.repeat(128)]: 'v' } })).toBeNull()
  })

  // Android has no double extra on older images (`--ed` is an unknown option on API 28, measured) and float loses
  // precision, so a fraction is refused and the message says how to send it instead.
  it('refuses fractional and non-finite numbers, and says to quote them', () => {
    expect(problem({ arguments: { r: 1.5 } })).toMatch(/quote 1.5/)
    for (const n of [NaN, Infinity, 2 ** 53]) expect(problem({ arguments: { r: n } })).not.toBeNull()
  })

  it('refuses lists Android would split or retype', () => {
    expect(problem({ arguments: { l: [] } })).toMatch(/at least one/)
    expect(problem({ arguments: { l: ['a,b'] } })).toMatch(/","/)
    // Android reads `a\,b` as one item.
    expect(problem({ arguments: { l: ['a\\', 'b'] } })).toMatch(/cannot end with/)
    expect(problem({ arguments: { l: ['a\\b', 'c'] } })).toBeNull()
    expect(problem({ arguments: { l: [1] } })).toMatch(/strings/)
  })

  it('refuses nested maps and nulls', () => {
    expect(problem({ arguments: { a: { b: 1 } } })).toMatch(/a value is/)
    expect(problem({ arguments: { a: null } })).toMatch(/a value is/)
    expect(problem({ arguments: ['a'] })).toMatch(/a map/)
  })

  it('refuses control characters but keeps tab and newline', () => {
    expect(problem({ arguments: { a: 'x\u0000y' } })).toMatch(/control/)
    expect(problem({ env: { A: '\u001b[31m' } })).toMatch(/control/)
    expect(problem({ arguments: { l: ['ok', 'a\u0007'] } })).toMatch(/control/)
    expect(problem({ arguments: { a: 'line1\n\tline2' } })).toBeNull()
  })

  // The network hook reads two of these from the app's own environment; a per-launch value would win over the
  // simulator-wide one tapflow sets.
  it('refuses environment names tapflow or the simulator depends on', () => {
    for (const name of ['DYLD_INSERT_LIBRARIES', 'TAPFLOW_TARGET_BUNDLE', 'SIMULATOR_UDID', 'SIMCTL_CHILD_X', '__XPC_DYLD_X', 'HOME', 'TMPDIR', 'CFFIXED_USER_HOME']) {
      expect(problem({ env: { [name]: 'x' } }), name).toMatch(/reserved/)
    }
    expect(problem({ env: { HOMEPAGE: 'x', MY_TAPFLOW_FLAG: 'x' } })).toBeNull()
  })

  it('refuses malformed environment names and non-string values', () => {
    for (const name of ['1BAD', 'A-B', 'A.B', '']) expect(problem({ env: { [name]: 'x' } }), name).toMatch(/a name starts/)
    expect(problem({ env: { A: 1 } })).toMatch(/is a string/)
  })

  it('caps the count across arguments and env together', () => {
    const args = Object.fromEntries(Array.from({ length: MAX_LAUNCH_KEYS }, (_, i) => [`k${i}`, 'v']))
    expect(problem({ arguments: args })).toBeNull()
    expect(problem({ arguments: args, env: { ONE_MORE: 'v' } })).toMatch(new RegExp(`at most ${MAX_LAUNCH_KEYS}`))
  })

  // The bound exists for Android's single adb shell line; measured on the raw text so both platforms accept the same flow.
  it('caps the total size, counting list items', () => {
    expect(problem({ arguments: { a: 'x'.repeat(MAX_LAUNCH_TOTAL - 1) } })).toBeNull()
    expect(problem({ arguments: { a: 'x'.repeat(MAX_LAUNCH_TOTAL) } })).toMatch(/add up to/)
    expect(problem({ arguments: { l: Array.from({ length: 9 }, () => 'x'.repeat(1000)) } })).toMatch(/add up to/)
  })
})

describe('the helpers around it', () => {
  it('treats empty maps as nothing to apply', () => {
    expect(hasLaunchOptions(undefined)).toBe(false)
    expect(hasLaunchOptions({ arguments: {}, env: {} })).toBe(false)
    expect(compactLaunchOptions({ arguments: {}, env: {} })).toBeUndefined()
    expect(compactLaunchOptions({ arguments: { a: 1 }, env: {} })).toEqual({ arguments: { a: 1 } })
  })

  it('reports names, never values', () => {
    expect(appliedKeys({ arguments: { a: 1 }, env: { SECRET: 'hunter2' } })).toEqual({ arguments: ['a'], env: ['SECRET'] })
  })
})
