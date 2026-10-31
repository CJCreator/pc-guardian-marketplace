// Drive Cleanup's session state: what the pane draws from.

export type DcStepState = 'pending' | 'running' | 'ok' | 'not_checked'

export type DcStep = {
  id: 'volume' | 'walk' | 'windows'
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
  recoverable: { safeBytes: number; reviewBytes: number; manualBytes: number }
  top: { label: string; className: string; bytes: number; count: number }[]
  isPartial: boolean
  lastAuditFolder: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'drive-cleanup': {
      progress: Shaped<DcProgress | null>
      summary: Shaped<DcSummary | null>
    }
  }
}
