import { describe, it, expect } from 'vitest'
import { roundedClipMask } from '@/lib/roundedClipMask'

// The reporter's browser on #908, verbatim.
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0'
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0'

describe('roundedClipMask', () => {
  it('masks on Firefox for macOS, where the rounded clip is dropped', () => {
    expect(roundedClipMask(FIREFOX_MAC)).toBe('linear-gradient(#fff,#fff)')
  })

  it.each([
    ['Chrome on macOS', CHROME_MAC],
    ['Safari on macOS', SAFARI_MAC],
    ['Firefox on Windows', FIREFOX_WIN],
  ])('leaves %s alone, keeping its GPU layer', (_, ua) => {
    expect(roundedClipMask(ua)).toBeUndefined()
  })
})
