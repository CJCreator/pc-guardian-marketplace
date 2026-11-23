// Drive Cleanup's session state: what the pane draws from.

export type DcStepState = 'pending' | 'running' | 'ok' | 'not_checked'

export type DcStep = {
  id: 'volume' | 'walk' | 'devcaches' | 'leftovers' | 'windows' | 'hash'
  label: string
  state: DcStepState
  durationMs: number | null
  detail: string | null
  isRetryable: boolean
  isTruncated: boolean
}

export type DcProgress = {
  scanId: string
  state: 'running' | 'done' | 'cancelled' | 'failed'
  startedAt: number
  finishedAt: number | null
  steps: DcStep[]
  message: string
}

export type DcSummary = {
  scanId: string
  createdAt: string
  drive: { letter: string; totalBytes: number; freeBytes: number } | null
  recoverable: { safeBytes: number; binBytes: number; reviewBytes: number; manualBytes: number; devManualBytes: number }
  top: { label: string; className: string; bytes: number; count: number }[]
  isPartial: boolean
  lastAuditFolder: string | null
}

export type DcView = {
  name: 'overview' | 'review' | 'quarantine' | 'settings'
  category: string | null
  page: number
}

export type DcSelection = { scanId: string; ids: string[] }

export type DcActivity = {
  state: 'idle' | 'working'
  message: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'drive-cleanup': {
      progress: Shaped<DcProgress | null>
      summary: Shaped<DcSummary | null>
      view: Shaped<DcView>
      selection: Shaped<DcSelection>
      activity: Shaped<DcActivity>
    }
  }
}
