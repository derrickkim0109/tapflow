import type { RunBuild, RunFlow, RunStatus, RunSummary } from '@/lib/types'

/** The badge tone for a run's or a flow's status. */
export const RUN_STATUS_TONE = {
  running: 'progress',
  passed: 'done',
  failed: 'rejected',
  aborted: 'backlog',
} as const satisfies Record<RunStatus, 'backlog' | 'progress' | 'done' | 'rejected'>

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  aborted: 'Cancelled',
}

/**
 * The badge for how a run or a flow ended. **A failure that was only ever the environment is not red**: red is a
 * regression in the app, the thing a list of runs is scanned for, and a device or relay problem is not one.
 */
export function failureBadge(status: RunStatus, failureKind: string | null): { label: string; tone: (typeof RUN_STATUS_TONE)[RunStatus] } {
  if (status === 'failed' && failureKind === 'environment') return { label: 'Environment problem', tone: 'backlog' }
  return { label: RUN_STATUS_LABEL[status], tone: RUN_STATUS_TONE[status] }
}

/** SQLite's `datetime('now')` is naive UTC ("YYYY-MM-DD HH:MM:SS"); read without a zone it would be local time. */
export function parseRelayTime(value: string): Date {
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
  return new Date(hasTz ? value : `${value.replace(' ', 'T')}Z`)
}

/** "2m 05s", "41s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** How long a run took, or has been going. */
export function runDuration(run: Pick<RunSummary, 'createdAt' | 'finishedAt'>, now = Date.now()): string {
  const start = parseRelayTime(run.createdAt).getTime()
  const end = run.finishedAt ? parseRelayTime(run.finishedAt).getTime() : now
  return formatDuration(end - start)
}

/** "3 min ago", "yesterday"-free on purpose: a relative time a table can sort by eye. */
export function formatAgo(value: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - parseRelayTime(value).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

export function runBuildLabel(build: RunBuild | null): string {
  if (!build) return 'No build'
  const version = [build.versionName, build.buildNumber && `build ${build.buildNumber}`].filter(Boolean).join(' · ')
  return [build.appName, version].filter(Boolean).join(' ') || `Build ${build.id}`
}

/** Where a run came from, in a few words: "GitHub · main" or "Local · jo". */
export function runSourceLabel(run: Pick<RunSummary, 'isCi' | 'ci' | 'createdBy'>): string {
  if (!run.isCi) return run.createdBy ? `Local · ${run.createdBy}` : 'Local'
  const provider = CI_PROVIDER_LABEL[run.ci?.provider ?? ''] ?? 'CI'
  return run.ci?.branch ? `${provider} · ${run.ci.branch}` : provider
}

const CI_PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub Actions',
  gitlab: 'GitLab CI',
  circleci: 'CircleCI',
  buildkite: 'Buildkite',
  jenkins: 'Jenkins',
  azure: 'Azure Pipelines',
  ci: 'CI',
}

/**
 * Why a run did not pass, in the page's words. **Kept apart on purpose**: a product failure is a regression to
 * look at, an environment failure is the device or the relay, and a cancelled run is neither — the three are what
 * the page exists to tell apart.
 */
export function runOutcomeText(run: RunSummary): string | null {
  if (run.status === 'aborted') {
    if (run.finishedBy === 'relay') return 'The flow runner disconnected before the run finished.'
    const signal = run.errorMessage?.match(/SIG[A-Z]+/)?.[0]
    return signal ? `Cancelled (${signal}).` : 'Cancelled.'
  }
  if (run.status !== 'failed') return null
  if (run.failureKind === 'environment') {
    return run.errorMessage ? `Environment problem: ${run.errorMessage}` : 'Every failure was an environment problem (device, agent or relay), not the app.'
  }
  return run.errorMessage ?? 'At least one flow failed on the app.'
}

/** The words for a flow that has no result of its own. */
export const UNREPORTED_FLOW_LABEL: Record<Extract<RunFlow['status'], 'running' | 'pending' | 'not-run'>, string> = {
  running: 'Running',
  pending: 'Waiting',
  'not-run': 'Not run',
}

/** Seven characters, as every git UI shortens a commit. */
export function shortCommit(sha: string): string {
  return sha.slice(0, 7)
}

/** How often a runs page refreshes while a run it shows is in progress. */
export const RUNS_POLL_MS = 3_000

/**
 * The refresh interval for what is on screen: every few seconds while anything shown is running, **never
 * otherwise** — a page left open on finished runs must not keep asking the relay.
 */
export function pollWhileRunning(statuses: readonly RunStatus[] | undefined): number | false {
  return statuses?.some((s) => s === 'running') ? RUNS_POLL_MS : false
}

