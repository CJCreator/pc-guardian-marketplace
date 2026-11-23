// PC Guardian's session state: what the dashboard pane draws from.
// Mirrors PaneSummary and ScanProgress in packages/core/src/tools/views.ts;
// the mod's typecheck fails if the two drift apart.

export type GuardianCategory = 'performance' | 'startup' | 'storage' | 'browser' | 'security' | 'stability'
export type GuardianBand = 'excellent' | 'good' | 'needs_attention' | 'critical'
export type GuardianPriority = 'critical' | 'recommended' | 'optional'

export type GuardianSummary = {
  scanId: string
  createdAt: string
  durationSeconds: number
  overall: number | null
  band: GuardianBand | null
  bandLabel: string | null
  isPartial: boolean
  capNote: string | null
  categories: {
    category: GuardianCategory
    label: string
    score: number | null
    note: string | null
  }[]
  quickWins: { title: string; priority: GuardianPriority }[]
  counts: { critical: number; recommended: number; optional: number }
  trend: (number | null)[]
  rechecks: string[]
}

export type GuardianNotCheckedReason =
  'needs_elevation' | 'unavailable' | 'timeout' | 'failed' | 'disabled_by_user' | 'unsupported_platform' | 'privacy'

export type GuardianProgress = {
  kind: 'full' | 'retry'
  state: 'running' | 'done' | 'cancelled' | 'failed'
  startedAt: number
  finishedAt: number | null
  steps: {
    id: GuardianCategory | 'score'
    label: string
    state: 'pending' | 'running' | 'ok' | 'not_checked'
    durationMs: number | null
    notChecked: { reason: GuardianNotCheckedReason; detail: string } | null
  }[]
  message: string
  log: { at: number; text: string }[]
  result: { scanId: string; overall: number | null; previousOverall: number | null } | null
}

/** The latest scan, unredacted, for this session only (never written to disk); validated on read. */
export type GuardianScanJson = Readonly<Record<string, unknown>>

/** Cleanup's session state (status, current preview, last run): CleanupState in core, validated on read. */
export type GuardianCleanupJson = Readonly<Record<string, unknown>>

declare module 'claude-code' {
  interface PluginState {
    'pc-guardian': {
      summary: Shaped<GuardianSummary | null>
      progress: Shaped<GuardianProgress | null>
      latestScan: Shaped<GuardianScanJson | null>
      cleanup: Shaped<GuardianCleanupJson | null>
    }
  }
}
