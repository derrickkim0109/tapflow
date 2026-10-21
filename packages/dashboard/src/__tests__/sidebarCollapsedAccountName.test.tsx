import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppSidebar } from '@/components/AppSidebar'
import { SidebarProvider } from '@/components/ui/sidebar'
import { withQuery } from './withQuery'

// Collapsed to its icon rail, the sidebar's account button shows only the avatar. Its name and email used to be
// `display: none` there, which also takes them out of the accessibility tree, so a lettered avatar left the
// button named "A". They are visually hidden instead, and the button keeps the person's name.
//
// jsdom applies no CSS, so the button's name reads the same either way here; what this holds is the class that
// decides it. Measured in Chromium: `hidden` gives the block `display: none`, `sr-only` keeps it rendered at 1px,
// and the avatar's place in the 23px button does not move.

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 1, email: 'ann@test.local', displayName: 'Ann', avatarUrl: null, role: 'Admin' }, loading: false }),
}))
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))

describe('the collapsed sidebar account button', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the name and email for assistive technology, hidden only visually', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
    render(withQuery(
      <MemoryRouter>
        <SidebarProvider defaultOpen={false}>
          <AppSidebar />
        </SidebarProvider>
      </MemoryRouter>,
    ))
    const button = screen.getByRole('button', { name: /Ann/ })
    expect(button.closest('[data-collapsible]')?.getAttribute('data-collapsible')).toBe('icon')
    const block = screen.getByText('ann@test.local').parentElement!
    expect(button).toContainElement(block)
    expect(block.className).toContain('group-data-[collapsible=icon]:sr-only')
    expect(block.className).not.toContain('group-data-[collapsible=icon]:hidden')
  })
})
