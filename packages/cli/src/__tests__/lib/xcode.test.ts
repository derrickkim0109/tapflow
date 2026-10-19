import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:fs')

import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { findXcodeApp, selectedXcodeApp } from '../../lib/xcode.js'

const mockExecSync = vi.mocked(execSync)
const mockExistsSync = vi.mocked(existsSync)
const mockReaddirSync = vi.mocked(readdirSync)

function selecting(dir: string): void {
  mockExecSync.mockImplementation((cmd) => {
    if (cmd === 'xcode-select -p') return `${dir}\n`
    throw new Error(`unexpected command: ${String(cmd)}`)
  })
}

// Each app is installed as a bundle with a Contents/Developer inside, as an Xcode is.
function installed(...apps: string[]): void {
  mockExistsSync.mockImplementation((p) => apps.some((a) => p === a || p === `${a}/Contents/Developer`))
  mockReaddirSync.mockReturnValue(apps.map((a) => a.replace('/Applications/', '')) as never)
}

describe('findXcodeApp', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns a selected bundle that is not named Xcode.app', () => {
    selecting('/Applications/Xcode-27.0.0.app/Contents/Developer')
    installed('/Applications/Xcode-27.0.0.app')
    expect(findXcodeApp()).toBe('/Applications/Xcode-27.0.0.app')
  })

  it('prefers the selected bundle over /Applications/Xcode.app', () => {
    selecting('/Applications/Xcode-27.0.0.app/Contents/Developer')
    installed('/Applications/Xcode.app', '/Applications/Xcode-27.0.0.app')
    expect(findXcodeApp()).toBe('/Applications/Xcode-27.0.0.app')
  })

  it('falls back to /Applications/Xcode.app when the Command Line Tools are selected', () => {
    selecting('/Library/Developer/CommandLineTools')
    installed('/Applications/Xcode-26.4.app', '/Applications/Xcode.app')
    expect(findXcodeApp()).toBe('/Applications/Xcode.app')
  })

  it('scans /Applications for a versioned bundle, first by name', () => {
    selecting('/Library/Developer/CommandLineTools')
    installed('/Applications/Xcode-27.0.0.app', '/Applications/Xcode-26.4.app')
    expect(findXcodeApp()).toBe('/Applications/Xcode-26.4.app')
  })

  it('skips a selected bundle that no longer exists', () => {
    selecting('/Applications/Xcode-26.4.app/Contents/Developer')
    installed('/Applications/Xcode-27.0.0.app')
    expect(findXcodeApp()).toBe('/Applications/Xcode-27.0.0.app')
  })

  it('skips a selected bundle with no Contents/Developer', () => {
    selecting('/Applications/Xcode-26.4.app/Contents/Developer')
    mockExistsSync.mockImplementation((p) => p === '/Applications/Xcode-26.4.app' || p === '/Applications/Xcode-27.0.0.app/Contents/Developer')
    mockReaddirSync.mockReturnValue(['Xcode-26.4.app', 'Xcode-27.0.0.app'] as never)
    expect(findXcodeApp()).toBe('/Applications/Xcode-27.0.0.app')
  })

  it('skips /Applications/Xcode.app when it has no Contents/Developer', () => {
    selecting('/Library/Developer/CommandLineTools')
    mockExistsSync.mockImplementation((p) => p === '/Applications/Xcode.app' || p === '/Applications/Xcode-27.0.0.app/Contents/Developer')
    mockReaddirSync.mockReturnValue(['Xcode-27.0.0.app', 'Xcode.app'] as never)
    expect(findXcodeApp()).toBe('/Applications/Xcode-27.0.0.app')
  })

  it('ignores apps that are not Xcode', () => {
    selecting('/Library/Developer/CommandLineTools')
    installed('/Applications/Safari.app')
    expect(findXcodeApp()).toBeNull()
  })

  // Alone, because `Xcodes.app` sorts after every `Xcode-*.app` and `Xcode.app`: next to a real
  // Xcode it is never reached, so only this case can tell whether the guard is there.
  it('does not take the xcodes GUI, whose name matches, for an Xcode', () => {
    selecting('/Library/Developer/CommandLineTools')
    mockExistsSync.mockImplementation((p) => p === '/Applications/Xcodes.app')
    mockReaddirSync.mockReturnValue(['Xcodes.app'] as never)
    expect(findXcodeApp()).toBeNull()
  })

  it('returns null when xcode-select fails and nothing is installed', () => {
    mockExecSync.mockImplementation(() => { throw new Error('xcode-select: error') })
    mockExistsSync.mockReturnValue(false)
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(findXcodeApp()).toBeNull()
  })
})

describe('selectedXcodeApp', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('is null when the Command Line Tools are selected, even with Xcode installed', () => {
    selecting('/Library/Developer/CommandLineTools')
    installed('/Applications/Xcode.app')
    expect(selectedXcodeApp()).toBeNull()
  })
})
