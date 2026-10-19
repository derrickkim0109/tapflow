import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VideoStorageCard } from '@/components/settings/VideoStorageCard'
import type { WorkspaceSettings } from '@/lib/types'
import { withQuery } from './withQuery'


const GB = 1024 * 1024 * 1024
const settings: WorkspaceSettings = {
  team_name: 'Team', logo_url: null,
  video_pass_retention_days: 3, video_storage_cap_mb: 20480, video_usage_bytes: 5 * GB, video_effective_cap_bytes: 20 * GB,
}

describe('VideoStorageCard', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('measures what videos use against the limit in effect, and says when the disk is the limit', () => {
    const { rerender } = render(withQuery(<VideoStorageCard settings={settings} />))
    const bar = screen.getByRole('progressbar', { name: 'Storage used by videos' })
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(bar.getAttribute('aria-valuetext')).toBe('5.0 GB of 20 GB')
    expect(screen.getByText(/used/).textContent).toBe('5.0 GB of 20 GB used')
    rerender(withQuery(<VideoStorageCard settings={{ ...settings, video_effective_cap_bytes: 12 * GB }} />))
    expect(screen.getByText(/used/).textContent).toContain('of 12 GB used — the disk has less room than the limit below')
    rerender(withQuery(<VideoStorageCard settings={{ ...settings, video_usage_bytes: 4.5 * 1024 * 1024 }} />))
    expect(screen.getByText(/used/).textContent).toBe('5 MB of 20 GB used')
  })

  it('takes both values from sliders, named by their labels, and saves days and MB', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(withQuery(<VideoStorageCard settings={settings} />))
    const days = screen.getByRole('slider', { name: "Keep passed flows' videos for" })
    const cap = screen.getByRole('slider', { name: 'Storage for videos' })
    expect(days.getAttribute('aria-valuenow')).toBe('3')
    expect(cap.getAttribute('aria-valuenow')).toBe('20')
    fireEvent.keyDown(days, { key: 'ArrowRight' })
    fireEvent.keyDown(days, { key: 'ArrowRight' })
    fireEvent.keyDown(cap, { key: 'ArrowLeft' })
    expect(screen.getByText('5 days')).toBeTruthy()
    expect(screen.getByText('19 GB')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = fetchMock.mock.calls[0]![1]!.body as FormData
    expect(body.get('video_pass_retention_days')).toBe('5')
    expect(body.get('video_storage_cap_mb')).toBe(String(19 * 1024))
  })

  it('sends only what was moved, so a cap set in MB is not rounded by saving the days', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(withQuery(<VideoStorageCard settings={{ ...settings, video_storage_cap_mb: 1500 }} />))
    fireEvent.keyDown(screen.getByRole('slider', { name: "Keep passed flows' videos for" }), { key: 'ArrowRight' })
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = fetchMock.mock.calls[0]![1]!.body as FormData
    expect(body.get('video_pass_retention_days')).toBe('4')
    expect(body.has('video_storage_cap_mb')).toBe(false)
  })

  it('shows a cap set in MB as it is until the slider moves', () => {
    render(withQuery(<VideoStorageCard settings={{ ...settings, video_storage_cap_mb: 100 }} />))
    expect(screen.getByText('100 MB')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Storage for videos' }), { key: 'ArrowRight' })
    expect(screen.getByText('2 GB')).toBeTruthy()
  })

  it('does not send a saved field again when the other one is saved later', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(withQuery(<VideoStorageCard settings={settings} />))
    fireEvent.keyDown(screen.getByRole('slider', { name: "Keep passed flows' videos for" }), { key: 'ArrowRight' })
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Storage for videos' }), { key: 'ArrowLeft' })
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const second = fetchMock.mock.calls[1]![1]!.body as FormData
    expect(second.has('video_pass_retention_days')).toBe(false)
    expect(second.get('video_storage_cap_mb')).toBe(String(19 * 1024))
  })

  it('widens a slider to reach a value set beyond its usual range, rather than clamping it', () => {
    render(withQuery(<VideoStorageCard settings={{ ...settings, video_pass_retention_days: 90, video_storage_cap_mb: 500 * 1024 }} />))
    expect(screen.getByRole('slider', { name: "Keep passed flows' videos for" }).getAttribute('aria-valuemax')).toBe('90')
    expect(screen.getByRole('slider', { name: 'Storage for videos' }).getAttribute('aria-valuenow')).toBe('500')
  })

  it('draws nothing for a relay older than flow videos', () => {
    const { container } = render(withQuery(<VideoStorageCard settings={{ team_name: 'Team', logo_url: null }} />))
    expect(container.textContent).toBe('')
  })
})
