import { describe, expect, it } from 'vitest'

import { iosLaunchArgv, simctlChildEnv } from '../launchArgs.js'

describe('iosLaunchArgv', () => {
  // Measured on iOS 26.5: unquoted, `-offset -1` and `-paren (` read back as nil from UserDefaults; quoted, every one
  // of these reads back as the string it was.
  it('quotes every value as a plist string, escaping backslash and quote', () => {
    expect(iosLaunchArgv({ offset: -1, s: '-x', p: '(', q: 'a "q" b', bs: 'c:\\d', b: true, n: 3 })).toEqual([
      '-offset', '"-1"', '-s', '"-x"', '-p', '"("', '-q', '"a \\"q\\" b"', '-bs', '"c:\\\\d"', '-b', '"true"', '-n', '"3"',
    ])
  })

  // Measured on iOS 26.5: a raw newline, tab, Korean and emoji inside the quotes read back unchanged.
  it('passes newline, tab and non-ASCII through unescaped', () => {
    expect(iosLaunchArgv({ v: 'a\nb\tc 한글 😀' })).toEqual(['-v', '"a\nb\tc 한글 😀"'])
  })

  it('renders a list as a plist array of strings', () => {
    expect(iosLaunchArgv({ AppleLanguages: ['en', 'ko'] })).toEqual(['-AppleLanguages', '("en","ko")'])
  })

  it('renders nothing for no arguments', () => {
    expect(iosLaunchArgv(undefined)).toEqual([])
  })
})

describe('simctlChildEnv', () => {
  it('prefixes each name so simctl forwards it to the app', () => {
    expect(simctlChildEnv({ API_HOST: 'x', B: '' })).toEqual({ SIMCTL_CHILD_API_HOST: 'x', SIMCTL_CHILD_B: '' })
    expect(simctlChildEnv(undefined)).toEqual({})
  })
})
