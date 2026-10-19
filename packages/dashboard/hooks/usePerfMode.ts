import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

export function usePerfMode() {
  const [searchParams] = useSearchParams()
  const perfMode = searchParams.get('perf') === '1'
  // Only the shortcut's toggle is state; being in perf mode at all comes from the URL. Leaving perf mode
  // forgets the toggle, adjusted while rendering, so coming back shows the overlay again.
  const [hidden, setHidden] = useState(false)
  const [seenPerfMode, setSeenPerfMode] = useState(perfMode)
  if (seenPerfMode !== perfMode) {
    setSeenPerfMode(perfMode)
    if (!perfMode) setHidden(false)
  }

  useEffect(() => {
    if (!perfMode) return
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'P') setHidden(h => !h)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [perfMode])

  return { perfMode, visible: perfMode && !hidden }
}
