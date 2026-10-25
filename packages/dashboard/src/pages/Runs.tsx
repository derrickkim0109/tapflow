import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/ui/search-input'
import { TechLabel } from '@/components/ui/tech-label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ListStateRow } from '@/components/ListStateRow'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import { useFocusAfterSwap } from '@/hooks/useFocusAfterSwap'
import { listView } from '@/lib/list-view'
import { getRuns, queryKeys, type RunCursor, type RunFilters } from '@/lib/queries'
import {
  RUN_STATUS_LABEL, failureBadge, formatAgo, pollWhileRunning, runBuildLabel, runDuration, runSourceLabel,
} from '@/lib/runs'
import type { RunListItem, RunStatus } from '@/lib/types'

const FLOW_SEARCH_DEBOUNCE_MS = 300

type Source = 'ci' | 'local' | 'all'
const STATUSES: RunStatus[] = ['running', 'passed', 'failed', 'aborted']
/** Newer's target on a page that came back empty or failed: the newest page, which needs no cursor. */
const NEWEST = 'newest'

/**
 * **What `tapflow flow run` did, for the whole team.** CI runs by default: those are the tests the team handed to
 * automation, while a local run is someone making a test and is one click away. The filters live in the URL, so a
 * filtered list is a link to send — a run's page links here with `?build=` for the same build's other runs.
 */
export function Runs() {
  const [params, setParams] = useSearchParams()
  const source = (['ci', 'local', 'all'] as const).find((s) => s === params.get('source')) ?? 'ci'
  const status = STATUSES.find((s) => s === params.get('status'))
  const buildParam = Number(params.get('build'))
  const build = Number.isInteger(buildParam) && buildParam > 0 ? buildParam : undefined
  const flow = params.get('flow') ?? ''
  // The page, as a cursor in the URL: a page is a link, and back returns to the page before.
  const cursor: RunCursor = params.get('after') ? { after: params.get('after')! }
    : params.get('before') ? { before: params.get('before')! } : {}

  const { setNode: setBreadcrumb } = useBreadcrumb()
  useEffect(() => {
    setBreadcrumb(<span className="text-sm font-medium">Flow Runs</span>)
    return () => setBreadcrumb(null)
  }, [setBreadcrumb])

  // Functional, so it reads the URL at the time it runs rather than the render that made it — the flow search
  // calls it from a timer.
  function setParam(key: string, value: string | null) {
    setParams((prev) => withParam(prev, key, value), { replace: true })
  }

  // The box follows what is typed at once; the URL, and so the query, after a pause.
  const [flowInput, setFlowInput] = useState(flow)
  // **And the box follows the URL when something else changes it** — the sidebar's Runs link, back and
  // forward. Without this the box kept the old text and the effect below wrote it back 300 ms later, so
  // clearing the filters cleared every one but the flow. Compared trimmed, or the URL the debounce just
  // wrote ("log") would eat the space someone is typing ("log ").
  const [seenFlow, setSeenFlow] = useState(flow)
  if (flow !== seenFlow) {
    setSeenFlow(flow)
    if (flow !== flowInput.trim()) setFlowInput(flow)
  }
  useEffect(() => {
    const wanted = flowInput.trim()
    if (wanted === flow) return
    const t = setTimeout(() => setParams((prev) => withParam(prev, 'flow', wanted || null), { replace: true }), FLOW_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [flowInput, flow, setParams])

  const filters: RunFilters = {
    ...(source === 'all' ? {} : { ci: source === 'ci' }),
    ...(status ? { status } : {}),
    ...(flow ? { flow } : {}),
    ...(build !== undefined ? { build } : {}),
  }
  // **One page at a time, `RUNS_PAGE_SIZE` runs, Newer and Older by cursor** — not an infinite list. Holding one page is what lets
  // the page keep following a run in progress (refetching an infinite query fetches every page it holds), and it
  // keeps the table a size a keyboard can get past.
  const runsQuery = useQuery({
    queryKey: queryKeys.runs({ ...filters, ...cursor }),
    queryFn: ({ signal }) => getRuns(filters, cursor, signal),
    // A filter or page change keeps the old rows up until the new ones arrive, rather than flashing the skeleton.
    placeholderData: keepPreviousData,
    refetchInterval: (query) => pollWhileRunning(query.state.data?.items.map((r) => r.status)),
  })
  const runs = runsQuery.data?.items
  const onAPage = Boolean(cursor.before || cursor.after)
  // **A failed filter being fetched again is still the failure**, as App Center holds it (see there): a retry puts
  // the key back to pending, `keepPreviousData` fills it with the previous filter's rows, and the view would turn
  // into a list of runs that do not match the filters on screen — with focus moved into them. `isFetchedAfterMount`
  // keeps it to the failure that was on screen.
  const refetchingAFailure = runsQuery.isFetchedAfterMount && (runsQuery.isPlaceholderData || runsQuery.isLoading)
  // `isLoadingError`, not `isError`: a failed poll keeps the rows already on screen, where `isError` turned the whole
  // list into the failure and moved focus to its button.
  const view = refetchingAFailure ? 'error' : listView({ data: runs, isError: runsQuery.isLoadingError })
  const sourceTabsRef = useRef<HTMLButtonElement>(null)
  const listRegion = useFocusAfterSwap<HTMLTableSectionElement>(view, sourceTabsRef)

  // A page change is pushed, unlike a filter change, so back returns to the page before.
  function goToPage(next: RunCursor) {
    setParams((prev) => withParam(withParam(prev, 'before', next.before ?? null), 'after', next.after ?? null))
  }

  // Named from a row when one is on screen; the id alone when the filter matches nothing.
  const buildOnScreen = build === undefined ? undefined : runs?.find((r) => r.build?.id === build)?.build
  const buildName = build === undefined ? null : buildOnScreen ? runBuildLabel(buildOnScreen) : `build ${build}`

  return (
    <div className="flex flex-col gap-5 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Flow Runs</h1>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={source} onValueChange={(v) => setParam('source', v === 'ci' ? null : v)}>
          <TabsList aria-label="Where the run came from">
            {/* Broadest first, as filters read; the page still opens on CI (see `source`). Focus falls back to the
                first tab when a swap removes the focused row. */}
            <TabsTrigger ref={sourceTabsRef} value="all">All</TabsTrigger>
            <TabsTrigger value="ci">CI</TabsTrigger>
            <TabsTrigger value="local">Local</TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={status ?? 'any'} onValueChange={(v) => setParam('status', v === 'any' ? null : v)}>
          <SelectTrigger className="h-8 w-36" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any status</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{RUN_STATUS_LABEL[s]}</SelectItem>)}
          </SelectContent>
        </Select>
        <SearchInput value={flowInput} onChange={setFlowInput} placeholder="Flow name" aria-label="Flow name" />
        {buildName && (
          <Badge variant="outline" className="gap-1 pr-1 text-xs font-normal">
            {buildName}
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-5 w-5"
              aria-label={`Show runs of every build, not only ${buildName}`}
              onClick={() => setParam('build', null)}
            >
              <X className="h-3 w-3" aria-hidden />
            </Button>
          </Badge>
        )}
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Build</TableHead>
              <TableHead>Flows passed</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
            </TableRow>
          </TableHeader>
          {/* Busy while the rows are the previous filter's, held until this one's arrive. */}
          <TableBody {...listRegion} aria-busy={runsQuery.isPlaceholderData}>
            <ListStateRow
              view={view}
              colSpan={6}
              // A run's row is its 22px status badge plus the cell padding.
              rowHeight={54}
              noun="flow runs"
              emptyText={onAPage ? 'No runs on this page any more. Newer goes back to the newest runs.' : emptyText(source, Boolean(status || flow || build !== undefined))}
              onRetry={() => void runsQuery.refetch()}
            />
            {view === 'list' && runs?.map((run) => <RunRow key={run.id} run={run} />)}
          </TableBody>
        </Table>
      </div>

      {/* **Kept while the URL names a page**, even one that came back empty or failed: the button just pressed
          would otherwise leave the DOM with focus on it, and a page emptied by expiry (or a stale shared link) would
          have no way back. There, Newer goes to the newest page. While the next page loads the buttons still hold
          this page's cursors, so they wait — a second click would push the same page twice. */}
      {(onAPage || runsQuery.data?.prevCursor || runsQuery.data?.nextCursor) && (
        <nav aria-label="Pages of flow runs" className="flex items-center justify-end gap-2">
          <PageButton
            cursor={runsQuery.isPlaceholderData ? null : runsQuery.data?.prevCursor ?? (onAPage && !runs?.length ? NEWEST : null)}
            onGo={(c) => goToPage(c === NEWEST ? {} : { after: c })}
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" aria-hidden />Newer
          </PageButton>
          <PageButton
            cursor={runsQuery.isPlaceholderData ? null : runsQuery.data?.nextCursor ?? null}
            onGo={(c) => goToPage({ before: c })}
          >
            Older<ChevronRight className="ml-1 h-3.5 w-3.5" aria-hidden />
          </PageButton>
        </nav>
      )}
    </div>
  )
}

/** A filter change starts from the newest page: the cursor belonged to the old filters' list. */
function withParam(prev: URLSearchParams, key: string, value: string | null): URLSearchParams {
  const next = new URLSearchParams(prev)
  if (key !== 'before' && key !== 'after') { next.delete('before'); next.delete('after') }
  if (value === null) next.delete(key)
  else next.set(key, value)
  return next
}

/**
 * Newer or Older. **`aria-disabled`, not `disabled`, at either end**: paging onto the last page disables the button
 * that was just pressed, and a disabled button drops the focus it holds to `body`.
 */
function PageButton({ cursor, onGo, children }: { cursor: string | null; onGo: (cursor: string) => void; children: ReactNode }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="aria-disabled:opacity-50"
      aria-disabled={cursor === null}
      onClick={() => { if (cursor !== null) onGo(cursor) }}
    >
      {children}
    </Button>
  )
}

function emptyText(source: Source, filtered: boolean): string {
  if (filtered) return 'No runs match these filters.'
  if (source === 'ci') return 'No CI runs yet. A run is recorded when tapflow flow run has a token.'
  if (source === 'local') return 'No local runs yet.'
  return 'No runs yet. A run is recorded when tapflow flow run has a token.'
}

function RunRow({ run }: { run: RunListItem }) {
  const navigate = useNavigate()
  const href = `/automation/runs/${run.id}`
  const build = runBuildLabel(run.build)
  const badge = failureBadge(run.status, run.failureKind)
  return (
    // **The whole row opens the run**, as a CI run list does, and the build name is the one link in it: a mouse
    // gets the row, a keyboard or a screen reader gets one stop per row with a name that says which run. A click
    // that lands on the link is the link's own; the row only handles the rest, with Cmd/Ctrl for a new tab as a
    // link would.
    <TableRow
      className="cursor-pointer"
      onClick={(e) => {
        // A control's own click is its own, and so is a drag that selected text to copy (a branch, a source).
        if ((e.target as HTMLElement).closest('a, button, input, [role="button"]')) return
        if (window.getSelection()?.toString()) return
        if (e.metaKey || e.ctrlKey) window.open(href, '_blank', 'noopener')
        else void navigate(href)
      }}
    >
      <TableCell>
        <Badge tone={badge.tone} className="text-xs">{badge.label}</Badge>
      </TableCell>
      <TableCell className="text-sm">
        {/* The visible name first, so voice control can say what it reads. */}
        <Link
          to={href}
          className="rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${build}, ${badge.label}, ${formatAgo(run.createdAt)}`}
        >
          {build}
        </Link>
      </TableCell>
      {/* Passed of planned: the status column already says how the run ended. Skipped flows are named, or a run that
          skipped two of three would read as one that lost them. */}
      <TableCell>
        <TechLabel>{run.flowsPassed}/{run.flowsTotal}</TechLabel>
        {run.flowsSkipped > 0 && <span className="ml-1 text-xs text-muted-foreground">({run.flowsSkipped} skipped)</span>}
        {/* A parallel run: its time is not one device's, so say how many shared it. */}
        {(run.deviceReset?.devices?.length ?? 0) > 1 && (
          <span className="ml-1 text-xs text-muted-foreground">on {run.deviceReset!.devices!.length} devices</span>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{runSourceLabel(run)}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{formatAgo(run.createdAt)}</TableCell>
      <TableCell><TechLabel>{runDuration(run)}</TechLabel></TableCell>
    </TableRow>
  )
}
