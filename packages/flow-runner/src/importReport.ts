import type { Flow } from './schema.js'

/**
 * What a converter from another tool's format reports, independent of that tool (#1094). Maestro is the first
 * source; a suite written for another tool reports through the same shapes, so whoever reads the report — a
 * person, CI, or later an agent filling the gaps — reads one format.
 */

/** One command a converter could not carry over, or carried over as nothing. */
export interface ImportIssue {
  /** The source file the command is in. For an inlined subflow this is the subflow, not the flow that ran it. */
  file: string
  /** 1-based line of the command, when the source has lines. */
  line?: number
  /** The command as the source tool names it. */
  command: string
  /**
   * `unconverted` blocks the whole flow: no flow is written for it.
   * `dropped` is a command, or an option of one, left out because tapflow already does it or fails louder without it
   * (a wait, a tap retry), so the flow still converts.
   */
  kind: 'unconverted' | 'dropped'
  reason: string
}

export type ImportedFlow =
  | { source: string; status: 'converted'; flow: Flow; issues: ImportIssue[] }
  | { source: string; status: 'not-converted'; issues: ImportIssue[] }

/** The JSON a `flow import` writes with `--report`. */
export interface ImportReport {
  format: 'tapflow-import-report'
  version: 1
  /** The source tool, e.g. `maestro`. */
  from: string
  flows: Array<{
    source: string
    status: ImportedFlow['status']
    /** Where the converted flow was written. Absent for a flow that was not converted. */
    output?: string
    /** A file an earlier import wrote for this flow, left in place although this import did not convert it. */
    staleOutput?: string
    issues: ImportIssue[]
  }>
}
