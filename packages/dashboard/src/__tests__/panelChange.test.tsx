import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { useRef } from 'react'
import { foldDirection } from '@/hooks/usePostureControl'
import { usePanelFade } from '@/hooks/usePanelFade'

describe('foldDirection', () => {
  const postures = (currentId: string | null) => ({
    postures: [{ id: 'closed', label: 'Folded' }, { id: 'half', label: 'Half' }, { id: 'open', label: 'Unfolded' }], currentId,
  })
  // From the list's order (most closed first), never from the ids. Mutation: compare the other way.
  it('reads toward the start of the list as folding', () => {
    expect(foldDirection(postures('open'), 'closed')).toBe('fold')
    expect(foldDirection(postures('half'), 'open')).toBe('unfold')
  })

  // The toolbar offers the control with the current posture unknown, and folds to the first. Mutation:
  // answer null (a first version did, and the press played nothing).
  it('reads an unknown current posture the way the toolbar does', () => {
    expect(foldDirection(postures(null), 'closed')).toBe('fold')
    expect(foldDirection(postures(null), 'open')).toBe('unfold')
  })

  it('has no direction to the posture it is in, or to one not in the list', () => {
    expect(foldDirection(postures('open'), 'open')).toBeNull()
    expect(foldDirection(postures('open'), 'gone')).toBeNull()
  })
})

describe('usePanelFade', () => {
  afterEach(() => { delete (HTMLElement.prototype as { animate?: unknown }).animate })

  function setup() {
    const played: Keyframe[][] = []
    // jsdom has no Web Animations.
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true, value: vi.fn((keyframes: Keyframe[]) => { played.push(keyframes); return { cancel: vi.fn() } }),
    })
    function Device({ frame }: { frame: string }) {
      const ref = useRef<HTMLDivElement>(null)
      usePanelFade(ref, frame)
      return <div ref={ref} />
    }
    return { played, Device }
  }

  // Mutation: fade on every render.
  it('fades the device in when another panel\'s frame arrives, and not the first', () => {
    const { played, Device } = setup()
    const { rerender } = render(<Device frame="cover" />)
    rerender(<Device frame="cover" />)
    expect(played).toHaveLength(0)
    rerender(<Device frame="open" />)
    expect(played).toEqual([[{ opacity: 0 }, { opacity: 1 }]])
  })
})
