import { BAND_LABEL, bandFor } from './deps.js'

// Pure helpers for the dashboard pane. Every status the pane colors also
// carries a word or a mark, so nothing depends on color alone.

export type ThemeColor = 'success' | 'warning' | 'error'

export const scoreColor = (score: number | null): ThemeColor | undefined =>
  score === null ? undefined : score >= 70 ? 'success' : score >= 50 ? 'warning' : 'error'

/** The band's name for a score, so a category reads "88 Good", not only green. */
export const scoreWord = (score: number | null): string => (score === null ? 'not checked' : BAND_LABEL[bandFor(score)])

export const bar = (score: number | null, width: number): string => {
  if (score === null) return '·'.repeat(width)
  const filled = Math.round((Math.min(100, Math.max(0, score)) / 100) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

export const STEP_MARK = { pending: '·', running: '…', ok: '✓', not_checked: '!' } as const
export const STEP_WORD = {
  pending: 'waiting',
  running: 'checking',
  ok: 'done',
  not_checked: 'not checked',
} as const

/** A step worth retrying: it timed out or failed. Admin rights, settings or privacy will not change on a retry. */
export const isRetryable = (reason: string | undefined): boolean => reason === 'timeout' || reason === 'failed'

export const trendText = (trend: readonly (number | null)[]): string =>
  trend.map(n => (n === null ? '—' : String(n))).join(' → ')

export const timeText = (iso: string): string => `${iso.replace('T', ' ').slice(0, 16)} UTC`

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`
