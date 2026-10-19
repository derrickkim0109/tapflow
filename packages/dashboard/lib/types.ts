// Wire payload types come from `@tapflowio/protocol`, which owns them — this file used to declare
// its own copies and they drifted (`session:chrome` here lacked three fields `DeviceViewer` reads).
// `AgentDevice` and `DeviceInfo` were this package's names for shapes protocol calls `DeviceSummary`
// and `DeviceDetails`; the old `DeviceInfo` also collided with the relay's own `DeviceInfo`, which is
// the *other* shape. Re-exported so this module stays the one import site for view code.
import type { VideoSummary } from './runVideo'
import type {
  AgentResources, AndroidButton, ChromeButton, ChromeData, ChromeRect,
  AndroidChrome, BrowserInbound, ChromePayload, DeviceDetails, DevicePosture, DeviceSummary,
  PosturesPayload, SessionInfo,
} from '@tapflowio/protocol'

export type {
  AgentResources, AndroidButton, ChromeButton, ChromeData, ChromeRect,
  AndroidChrome, BrowserInbound, ChromePayload, DeviceDetails, DeviceSummary, SessionInfo,
  DevicePosture, PosturesPayload,
}

export interface Comment {
  id: number
  author: string
  authorAvatarUrl: string | null
  body: string
  created_at: string
  attachments: CommentAttachment[]
}

export interface CommentAttachment {
  id: number
  file_path: string
  mime: string
}

export interface Recording {
  id: number
  url: string
  sessionId: string | null
  fileSize: number
  mime: string
  createdAt: string
  expiresAt: string
}

export interface App {
  id: number
  name: string
  bundle_id_key: string
  platform: 'ios' | 'android' | 'both'
  latest_build_id: number | null
  version_name: string | null
  build_number: string | null
  status_label: string | null
  latest_uploaded_at: string | null
}

export interface Build {
  id: number
  app_id: number
  name: string
  version_name: string | null
  build_number: string | null
  version_label: string | null
  status_label: 'Backlog' | 'In Progress' | 'Done' | 'Rejected' | null
  platform: 'ios' | 'android'
  bundle_id: string | null
  uploaded_at: string
  completed_at: string | null
  delete_after: string | null
  uploader: string | null
}

export interface ReleaseGroup {
  versionName: string
  builds: Build[]
}


/** A row of `GET /api/v1/tokens`. */
export interface ApiToken {
  id: number
  name: string
  scope: string
  last_used_at: string | null
  expires_at: string | null
  created_at: string
}

/** A row of `GET /api/v1/team/members`. */
export interface TeamMember {
  id: number
  email: string
  display_name: string
  role: string
  joined_at: string
}

/** `GET /api/v1/settings`: the workspace the sidebar and settings both show. */
export interface WorkspaceSettings {
  team_name: string
  logo_url: string | null
  /** Flow run videos (A4). Absent from a relay older than them. */
  video_pass_retention_days?: number
  video_storage_cap_mb?: number
  video_usage_bytes?: number
  /** The smaller of the cap and what the disk can give while keeping its floor free. */
  video_effective_cap_bytes?: number
}

/** A row of `GET /api/v1/agents/:name/resources`. */
export interface ResourcePoint {
  cpu_percent: number
  mem_percent: number
  recorded_at: string
}

/** What `tapflow flow run` recorded about one run (`/api/v1/runs`). */
export type RunStatus = 'running' | 'passed' | 'failed' | 'aborted'

export interface RunBuild {
  id: number
  appName: string | null
  versionName: string | null
  buildNumber: string | null
  platform: string | null
}

export interface RunSummary {
  id: string
  status: RunStatus
  /** `relay` when the relay closed it because the runner went away without finishing. */
  finishedBy: 'client' | 'relay' | null
  failureKind: string | null
  errorMessage: string | null
  exitCode: number | null
  isCi: boolean
  ci: { provider: string | null; branch: string | null; commit: string | null; jobUrl: string | null } | null
  build: RunBuild | null
  createdBy: string | null
  flowsTotal: number
  createdAt: string
  finishedAt: string | null
}

/** A row of `GET /api/v1/runs`. */
export interface RunListItem extends RunSummary {
  flowsPassed: number
  flowsFailed: number
}

export interface RunStep {
  index: number
  name: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  message?: string
  /** A failed `tapOn`'s lines to try instead, each tapping one element on the screen it failed on (B2). */
  suggestions?: { yaml: string; element: { role: string; label: string; identifier?: string } }[]
}

/** A flow of a run: reported, or still to come (`running` / `pending`), or never reached (`not-run`). */
export type RunFlow =
  | { idx: number; name: string; file: string | null; status: 'running' | 'pending' | 'not-run'; video?: VideoSummary | null }
  | {
      idx: number
      name: string
      file: string | null
      status: 'passed' | 'failed'
      device: { id: string; name: string | null; platform: string | null } | null
      failureKind: string | null
      failureMessage: string | null
      durationMs: number
      steps: RunStep[]
      hasScreenshot: boolean
      /** Absent from a relay older than flow videos; null when this flow has none. */
      video?: VideoSummary | null
    }

/** `GET /api/v1/runs/:id`. `watchSessionId` is the session the runner holds now, while it runs. */
export interface RunDetail extends RunSummary {
  flows: RunFlow[]
  watchSessionId: string | null
}
