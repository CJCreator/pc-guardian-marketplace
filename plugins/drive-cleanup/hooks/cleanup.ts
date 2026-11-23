import type { EngineInterface } from 'claude-code'
import { planCleanup } from './core/plan.ts'
import {
  emptyManifest,
  indexEntry,
  joinResults,
  manifestRows,
  parseIndex,
  runSummaryText,
  type RunIndexEntry,
} from './core/runs.ts'
import type { Finding, ItemResult, RawApply, RunRecord } from './core/types.ts'
import { parseOutput, RawApplyCheck, RawCacheCleanCheck, RawPurgeCheck } from './core/validate.ts'
import { runAction } from './safe-shell.ts'
import { readDataFile, writeDataFile } from './safe-writer.ts'
import { invalidateScan, isScanRunning, loadLatestScan, markDone, refreshSummary } from './scan.ts'
import { loadSettings } from './settings-store.ts'
import { readSelection, setActivity, setSelection } from './ui-state.ts'

// Cleanup you approve (PLAN.md §7): the only module that runs an action
// script. It acts only on what the person selected in the pane, after Claude
// Code's own dialog asked them to confirm, with cleanup turned on in Settings.
// Claude's tools never reach here. A dismissed dialog, or a `-p` session with
// no one to ask, changes nothing.

const INDEX_FILE = 'runs/index.json'
const MANIFEST_FILE = 'manifest/deletion_manifest.csv'
const MANIFEST_LIMIT = 3_500_000

let busy = false
export const isCleanupBusy = (): boolean => busy

async function confirm($: EngineInterface, question: string, yes: string): Promise<boolean> {
  try {
    const answer = await $.ui.ask(question, { header: 'Drive Cleanup', options: [yes, 'Cancel'] })
    return answer === yes
  } catch {
    return false
  }
}

export async function readRunIndex($: EngineInterface): Promise<RunIndexEntry[]> {
  return parseIndex(await readDataFile($, INDEX_FILE))
}

async function saveRun(
  $: EngineInterface,
  record: RunRecord,
  change: (index: RunIndexEntry[]) => RunIndexEntry[],
): Promise<void> {
  await writeDataFile($, `runs/${record.runId}.json`, JSON.stringify(record))
  const index = change(await readRunIndex($)).slice(0, 200)
  await writeDataFile($, INDEX_FILE, JSON.stringify(index))
  // The manifest grows by appending; past its size limit a new one is started.
  let manifest = (await readDataFile($, MANIFEST_FILE)) ?? emptyManifest()
  if (manifest.length > MANIFEST_LIMIT) {
    await writeDataFile(
      $,
      `manifest/deletion_manifest-${record.startedAt.replaceAll(/[-:.]/g, '').slice(0, 15)}.csv`,
      manifest,
    )
    manifest = emptyManifest()
  }
  await writeDataFile($, MANIFEST_FILE, manifest + manifestRows(record))
}

export async function readManifest($: EngineInterface): Promise<string> {
  return (await readDataFile($, MANIFEST_FILE)) ?? emptyManifest()
}

export async function readRunRecord($: EngineInterface, runId: string): Promise<RunRecord | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(runId)) return undefined
  const text = await readDataFile($, `runs/${runId}.json`)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as RunRecord
  } catch {
    return undefined
  }
}

async function say($: EngineInterface, message: string, state: 'idle' | 'working' = 'idle'): Promise<void> {
  await setActivity($, { state, message })
}

/** The pane's "Clean selected…": plan, confirm, act, record. */
export async function cleanSelected($: EngineInterface): Promise<void> {
  if (busy) return
  busy = true
  try {
    await cleanSelectedInner($)
  } catch {
    await say($, 'The cleanup stopped unexpectedly. Check the manifest and the Quarantine view.')
  } finally {
    busy = false
  }
}

async function cleanSelectedInner($: EngineInterface): Promise<void> {
  const scan = await loadLatestScan($)
  if (scan === undefined) return say($, 'There is no scan. Run a deep scan first.')
  const selection = await readSelection($)
  if (selection.scanId !== scan.meta.scanId) return say($, 'The selection is from an older scan. Select again.')
  const settings = await loadSettings($)
  const plan = (nowMs: number) =>
    planCleanup({
      runId,
      scanId: scan.meta.scanId,
      scanFinishedAt: scan.meta.finishedAt,
      findings: scan.classified.findings,
      selectedIds: selection.ids,
      settings,
      volume: scan.volume,
      nowMs,
      isScanRunning: isScanRunning(),
    })
  const runId = crypto.randomUUID()
  const first = plan(Date.now())
  if (first.status !== 'ok') return say($, first.message)

  const isYes = await confirm(
    $,
    `Clean ${String(first.itemCount)} selected items? ${first.summary} Items moved to quarantine can be restored; deleted caches and temporary files cannot.`,
    'Clean',
  )
  if (!isYes) return say($, 'Nothing was changed.')

  // Planned again at the moment of acting, so the approval the scripts check is fresh.
  const approved = plan(Date.now())
  if (approved.status !== 'ok') return say($, approved.message)

  const startedAt = new Date().toISOString()
  await say($, `Cleaning ${String(approved.itemCount)} items…`, 'working')
  $.ui.status('Drive Cleanup: cleaning…')
  const findings = new Map<string, Finding>(scan.classified.findings.map(f => [f.id, f]))
  const results: ItemResult[] = []
  const messages: string[] = []
  let deletedBytes = 0
  let quarantinedBytes = 0
  let quarantineDir: string | null = null
  try {
    if (approved.list.items.length > 0) {
      const written = await writeDataFile($, `runs/pending/${runId}.json`, JSON.stringify(approved.list))
      if (written.status !== 'written') return say($, `Nothing was changed: ${written.detail}`)
      const ran = await runAction($, 'apply', { DC_RUN_ID: runId })
      const parsed = ran.status === 'ok' ? parseOutput(RawApplyCheck, ran.stdout, 'apply.ps1') : ran
      if (parsed.status !== 'ok') {
        messages.push(`The file cleanup did not run or did not report: ${parsed.detail}`)
      } else if (parsed.data.status === 'refused') {
        messages.push(parsed.data.detail)
      } else {
        const data = parsed.data as Extract<RawApply, { status: 'ok' }>
        results.push(...data.items)
        deletedBytes += data.deletedBytes
        quarantinedBytes += data.quarantinedBytes
        quarantineDir = data.quarantineDir
        if (data.isTruncated) messages.push('The time limit was reached; run the cleanup again for the rest.')
      }
    }
    for (const job of approved.caches) {
      await say($, `Cleaning ${job.label}…`, 'working')
      const ran = await runAction($, 'cleanCache', {
        DC_CACHE_ID: job.cacheId,
        DC_APPROVED_AT: approved.list.approvedAt,
      })
      const parsed = ran.status === 'ok' ? parseOutput(RawCacheCleanCheck, ran.stdout, 'clean-cache.ps1') : ran
      if (parsed.status !== 'ok') {
        results.push({
          id: job.findingId,
          status: 'skipped',
          detail: parsed.detail,
          destination: null,
          sha256: null,
          bytes: 0,
        })
      } else if (parsed.data.status === 'refused') {
        results.push({
          id: job.findingId,
          status: 'skipped',
          detail: parsed.data.detail,
          destination: null,
          sha256: null,
          bytes: 0,
        })
      } else {
        deletedBytes += parsed.data.removedBytes
        results.push({
          id: job.findingId,
          status: 'deleted',
          detail:
            parsed.data.skippedCount > 0 ? `${String(parsed.data.skippedCount)} files in use or newer were kept.` : '',
          destination: null,
          sha256: null,
          bytes: parsed.data.removedBytes,
        })
      }
    }
  } finally {
    $.ui.status(undefined)
  }

  const record: RunRecord = {
    runId,
    kind: 'cleanup',
    scanId: scan.meta.scanId,
    startedAt,
    finishedAt: new Date().toISOString(),
    quarantineRoot: approved.list.quarantineRoot === '' ? null : approved.list.quarantineRoot,
    quarantineDir,
    deletedBytes,
    quarantinedBytes,
    restoredBytes: 0,
    purgedBytes: 0,
    counts: {
      done: results.filter(r => r.status !== 'skipped').length,
      skipped: results.filter(r => r.status === 'skipped').length,
    },
    items: joinResults(results, findings),
    messages,
  }
  await saveRun($, record, index => [indexEntry(record), ...index])
  await markDone(
    $,
    results.filter(r => r.status !== 'skipped').map(r => r.id),
  )
  await setSelection($, () => ({ scanId: scan.meta.scanId, ids: [] }))
  invalidateScan()
  const after = await loadLatestScan($)
  if (after !== undefined) await refreshSummary($, after)
  const summary = `Cleanup: ${runSummaryText(record)}${messages.length > 0 ? ` ${messages.join(' ')}` : ''} Use Verify to check the result.`
  await say($, summary)
  $.ui.toast(summary)
}

/** Puts a quarantine run back. */
export async function restoreRun($: EngineInterface, runId: string): Promise<void> {
  if (busy) return
  busy = true
  try {
    const index = await readRunIndex($)
    const entry = index.find(e => e.runId === runId && e.kind === 'cleanup')
    if (entry === undefined || entry.quarantineRoot === null || entry.quarantineState !== 'active') {
      return await say($, 'That quarantine run cannot be restored.')
    }
    const isYes = await confirm(
      $,
      `Put back the ${fmtBytes(entry.quarantinedBytes)} quarantined on ${entry.startedAt.slice(0, 16).replace('T', ' ')}? Anything whose original place is taken again stays in quarantine.`,
      'Restore',
    )
    if (!isYes) return await say($, 'Nothing was changed.')
    await say($, 'Restoring…', 'working')
    const startedAt = new Date().toISOString()
    const ran = await runAction($, 'restore', {
      DC_RUN_ID: runId,
      DC_QUARANTINE_ROOT: entry.quarantineRoot,
      DC_LIST_ID: '',
    })
    const parsed = ran.status === 'ok' ? parseOutput(RawApplyCheck, ran.stdout, 'restore.ps1') : ran
    if (parsed.status !== 'ok') return await say($, `Restore did not run: ${parsed.detail}`)
    if (parsed.data.status === 'refused') return await say($, parsed.data.detail)
    const data = parsed.data as Extract<RawApply, { status: 'ok' }>
    const original = await readRunRecord($, runId)
    const known = new Map<string, Finding>()
    for (const item of original?.items ?? []) {
      known.set(item.id, {
        path: item.path,
        category: item.category,
        reason: item.reason,
        action: item.action,
      } as unknown as Finding)
    }
    const record: RunRecord = {
      runId: crypto.randomUUID(),
      kind: 'restore',
      scanId: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      quarantineRoot: entry.quarantineRoot,
      quarantineDir: entry.quarantineDir,
      deletedBytes: 0,
      quarantinedBytes: 0,
      restoredBytes: data.restoredBytes,
      purgedBytes: 0,
      counts: {
        done: data.items.filter(i => i.status === 'restored').length,
        skipped: data.items.filter(i => i.status === 'skipped').length,
      },
      items: joinResults(data.items, known),
      messages: [],
    }
    const fullyRestored = record.counts.skipped === 0
    await saveRun($, record, list => [
      indexEntry(record, runId),
      ...list.map(e =>
        e.runId === runId ? { ...e, quarantineState: fullyRestored ? ('restored' as const) : e.quarantineState } : e,
      ),
    ])
    const summary = `Restore: ${runSummaryText(record)}`
    await say($, summary)
    $.ui.toast(summary)
  } finally {
    busy = false
  }
}

/** Deletes one quarantine run for good, after its own confirmation. */
export async function purgeRun($: EngineInterface, runId: string): Promise<void> {
  if (busy) return
  busy = true
  try {
    const index = await readRunIndex($)
    const entry = index.find(e => e.runId === runId && e.kind === 'cleanup')
    if (entry === undefined || entry.quarantineRoot === null || entry.quarantineState === 'purged') {
      return await say($, 'That quarantine run cannot be deleted.')
    }
    const isYes = await confirm(
      $,
      `Delete the quarantine of ${entry.startedAt.slice(0, 16).replace('T', ' ')} (${fmtBytes(entry.quarantinedBytes)}) for good? This cannot be undone.`,
      'Delete for good',
    )
    if (!isYes) return await say($, 'Nothing was deleted.')
    await say($, 'Deleting the quarantine run…', 'working')
    const startedAt = new Date().toISOString()
    const ran = await runAction($, 'purge', { DC_RUN_ID: runId, DC_QUARANTINE_ROOT: entry.quarantineRoot })
    const parsed = ran.status === 'ok' ? parseOutput(RawPurgeCheck, ran.stdout, 'purge.ps1') : ran
    if (parsed.status !== 'ok') return await say($, `It did not run: ${parsed.detail}`)
    if (parsed.data.status === 'refused') return await say($, parsed.data.detail)
    const record: RunRecord = {
      runId: crypto.randomUUID(),
      kind: 'purge',
      scanId: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      quarantineRoot: entry.quarantineRoot,
      quarantineDir: entry.quarantineDir,
      deletedBytes: 0,
      quarantinedBytes: 0,
      restoredBytes: 0,
      purgedBytes: parsed.data.removedBytes,
      counts: { done: parsed.data.removedCount, skipped: parsed.data.failedCount },
      items: [],
      messages: [],
    }
    await saveRun($, record, list => [
      indexEntry(record, runId),
      ...list.map(e => (e.runId === runId ? { ...e, quarantineState: 'purged' as const } : e)),
    ])
    const summary = `Quarantine deleted: ${runSummaryText(record)}`
    await say($, summary)
    $.ui.toast(summary)
  } finally {
    busy = false
  }
}

function fmtBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

/** Starts a pane action and returns at once (a press hook's budget). */
export function start(work: () => Promise<void>): void {
  void work().catch(() => {})
}
