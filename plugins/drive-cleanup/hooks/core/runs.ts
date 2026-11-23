// Run records and the deletion manifest (PLAN.md §7.4). Pure.

import { csv, csvCell } from './reports.ts'
import type { Finding, ItemResult, RunRecord } from './types.ts'

export type RunIndexEntry = {
  runId: string
  kind: RunRecord['kind']
  startedAt: string
  quarantineRoot: string | null
  quarantineDir: string | null
  quarantinedBytes: number
  deletedBytes: number
  restoredBytes: number
  purgedBytes: number
  done: number
  skipped: number
  /** Cleanup runs with a quarantine: what is left there. */
  quarantineState: 'none' | 'active' | 'restored' | 'purged'
  /** The cleanup run a restore or purge acted on. */
  ofRunId: string | null
}

export function indexEntry(r: RunRecord, ofRunId: string | null = null): RunIndexEntry {
  return {
    runId: r.runId,
    kind: r.kind,
    startedAt: r.startedAt,
    quarantineRoot: r.quarantineRoot,
    quarantineDir: r.quarantineDir,
    quarantinedBytes: r.quarantinedBytes,
    deletedBytes: r.deletedBytes,
    restoredBytes: r.restoredBytes,
    purgedBytes: r.purgedBytes,
    done: r.counts.done,
    skipped: r.counts.skipped,
    quarantineState: r.kind === 'cleanup' && r.quarantinedBytes > 0 ? 'active' : 'none',
    ofRunId,
  }
}

export function parseIndex(text: string | undefined): RunIndexEntry[] {
  if (text === undefined) return []
  try {
    const list: unknown = JSON.parse(text)
    if (!Array.isArray(list)) return []
    return list.filter(
      (e): e is RunIndexEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as RunIndexEntry).runId === 'string' &&
        typeof (e as RunIndexEntry).kind === 'string',
    )
  } catch {
    return []
  }
}

/** Joins what the actions reported with what the scan knew about each item. */
export function joinResults(
  results: readonly ItemResult[],
  findings: ReadonlyMap<string, Finding>,
): RunRecord['items'] {
  return results.map(r => {
    const f = findings.get(r.id)
    return {
      ...r,
      path: f?.path ?? r.destination ?? '',
      category: f?.category ?? '',
      reason: f?.reason ?? '',
      action: f?.action ?? '',
    }
  })
}

export const MANIFEST_HEADER = [
  'timestamp_utc',
  'run_id',
  'kind',
  'original_path',
  'size_bytes',
  'sha256',
  'category',
  'reason',
  'action',
  'destination',
  'detail',
] as const

/** Manifest rows for one run (no header, no BOM), CRLF-terminated. */
export function manifestRows(r: RunRecord): string {
  return r.items
    .map(i =>
      [
        r.finishedAt,
        r.runId,
        r.kind,
        i.path,
        i.bytes,
        i.sha256,
        i.category,
        i.reason,
        i.status,
        i.destination,
        i.detail,
      ]
        .map(csvCell)
        .join(','),
    )
    .map(line => `${line}\r\n`)
    .join('')
}

export const emptyManifest = (): string => csv(MANIFEST_HEADER, [])

export function runSummaryText(r: RunRecord): string {
  const parts: string[] = []
  if (r.quarantinedBytes > 0) parts.push(`moved ${fmt(r.quarantinedBytes)} to quarantine`)
  if (r.deletedBytes > 0) parts.push(`deleted ${fmt(r.deletedBytes)}`)
  if (r.restoredBytes > 0) parts.push(`restored ${fmt(r.restoredBytes)}`)
  if (r.purgedBytes > 0) parts.push(`deleted ${fmt(r.purgedBytes)} from quarantine for good`)
  if (parts.length === 0) parts.push('nothing changed')
  const skipped = r.counts.skipped > 0 ? `; ${String(r.counts.skipped)} skipped (see the manifest for why)` : ''
  return `${parts.join(', ')}${skipped}.`
}

function fmt(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}
