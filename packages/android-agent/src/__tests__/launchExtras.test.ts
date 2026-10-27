import { describe, expect, it } from 'vitest'

import { androidLaunchExtras, shellQuote } from '../launchExtras.js'

describe('shellQuote', () => {
  it('leaves nothing the device shell would expand or split', () => {
    expect(shellQuote("a'b; echo PWNED $(id) `id`")).toBe("'a'\\''b; echo PWNED $(id) `id`'")
    expect(shellQuote('')).toBe("''")
    expect(shellQuote('-x')).toBe("'-x'")
  })
})

describe('androidLaunchExtras', () => {
  it('types each extra by its value', () => {
    expect(androidLaunchExtras({ b: false, i: -7, max: 2 ** 31 - 1, l: 2 ** 31, s: '8080', list: ['a', 'b'] })).toEqual([
      '--ez', "'b'", 'false', '--ei', "'i'", '-7', '--ei', "'max'", '2147483647', '--el', "'l'", '2147483648',
      '--es', "'s'", "'8080'", '--esa', "'list'", "'a,b'",
    ])
  })

  it('renders nothing for no arguments', () => {
    expect(androidLaunchExtras(undefined)).toEqual([])
  })
})
