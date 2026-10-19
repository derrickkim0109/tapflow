import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'

/**
 * Wraps a page in a query client of its own, as `App` does. One per render so no test's cache answers
 * another's query; `retry: 0` matches `lib/queryClient.ts`, and `gcTime: 0` leaves nothing behind.
 * Pages moved from effects to TanStack Query (#845) need it, and wrapping one that does not read from
 * it costs nothing — which is what lets a test pin the behaviour on both sides of the move.
 */
export function withQuery(ui: ReactElement, { gcTime = 0 }: { gcTime?: number } = {}): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime }, mutations: { retry: 0 } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}
