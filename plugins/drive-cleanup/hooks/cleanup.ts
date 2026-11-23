import type { EngineInterface } from 'claude-code'
import { ELEVATED_TASKS, elevatedEstimate, elevatedSummary, type ElevatedTaskId } from './core/elevated.ts'
import { MAX_SCAN_AGE_HOURS, planCleanup, type Plan } from './core/plan.ts'
import {
  answers,
  freedEstimate,
  DECLINE_COOLDOWN_MS,
  proposalQuestion,
  selectForProposal,
  type ProposalInput,
} from './core/propose.ts'
import {
  emptyManifest,
  indexEntry,
  joinResults,
  manifestRows,
  parseIndex,
  runSummaryText,
  type RunIndexEntry,
} from './core/runs.ts'
import type { Finding, ItemResult, RawApply, RunRecord, Settings } from './core/types.ts'
import { parseOutput, RawApplyCheck, RawCacheCleanCheck, RawPurgeCheck } from './core/validate.ts'
import { runAction, runElevated } from './safe-shell.ts'
import { readDataFile, writeDataFile } from './safe-writer.ts'
import {
  invalidateScan,
  isScanRunning,
  loadLatestScan,
  markDone,
  PANE_ID,
  refreshSummary,
  type LoadedScan,
} from './scan.ts'
import { loadSettings, saveSettings } from './settings-store.ts'
import { readSelection, setActivity, setSelection, setView } from './ui-state.ts'

// Cleanup you approve (PLAN.md §7, §19): the only module that runs an action
// script. It acts on what the person selected in the pane, or on what Claude
// proposed (propose_cleanup), and in both cases only after Claude Code's own
// dialog asked the person and they answered yes. A dismissed dialog, or a
// `-p` session with no one to ask, changes nothing. Claude can propose and
// ask; it can never answer.

const INDEX_FILE = 'runs/index.json'
const MANIFEST_FILE = 'manifest/deletion_manifest.csv'
const MANIFEST_LIMIT = 3_500_000

let busy = false
export const isCleanupBusy = (): boolean => busy

async function confirm($: EngineInterface, question: string, yes: string): Promise<boolean> {
  try {
    const answer = await $.ui.ask(question, { header: 'Drive Cleanup', options: [yes, 'Not now'] })
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

export type CleanOutcome =
  | { status: 'done'; record: RunRecord; message: string }
  | { status: 'cancelled' | 'refused' | 'busy' | 'review'; message: string }

type OkPlan = Extract<Plan, { status: 'ok' }>

function planFor(scan: LoadedScan, ids: readonly string[], settings: Settings, runId: string): Plan {
  return planCleanup({
    runId,
    scanId: scan.meta.scanId,
    scanFinishedAt: scan.meta.finishedAt,
    findings: scan.classified.findings,
    selectedIds: ids,
    settings,
    volume: scan.volume,
    nowMs: Date.now(),
    isScanRunning: isScanRunning(),
  })
}

/** The planner's freshness rules, for a proposal with no files (administrator tasks only). */
function checkFreshness(scan: LoadedScan): string | null {
  if (isScanRunning()) return 'A scan is running. Wait for it to finish.'
  const ageHours = (Date.now() - Date.parse(scan.meta.finishedAt)) / 3_600_000
  if (!(ageHours >= 0 && ageHours <= MAX_SCAN_AGE_HOURS))
    return `The scan is more than ${String(MAX_SCAN_AGE_HOURS)} hours old. Run a new deep scan first.`
  return null
}

function emptyPlan(scan: LoadedScan, runId: string): OkPlan {
  return {
    status: 'ok',
    list: {
      runId,
      scanId: scan.meta.scanId,
      approvedAt: new Date().toISOString(),
      scanFinishedAt: scan.meta.finishedAt,
      quarantineRoot: '',
      items: [],
    },
    caches: [],
    deleteBytes: 0,
    quarantineBytes: 0,
    itemCount: 0,
    summary: '',
  }
}

async function exclusive($: EngineInterface, work: () => Promise<CleanOutcome>): Promise<CleanOutcome> {
  if (busy) return { status: 'busy', message: 'Another cleanup, restore or purge is running. Wait for it to finish.' }
  busy = true
  try {
    return await work()
  } catch {
    const message = 'The cleanup stopped unexpectedly. Check the Undo tab and the manifest.'
    await say($, message)
    return { status: 'refused', message }
  } finally {
    busy = false
  }
}

/** The pane's "Clean selected…": plan, confirm, act, record. */
export async function cleanSelected($: EngineInterface): Promise<void> {
  const outcome = await exclusive($, async () => {
    const scan = await loadLatestScan($)
    if (scan === undefined) return { status: 'refused', message: 'There is no scan. Run a deep scan first.' }
    const selection = await readSelection($)
    if (selection.scanId !== scan.meta.scanId)
      return { status: 'refused', message: 'The selection is from an older scan. Select again.' }
    const settings = await loadSettings($)
    const runId = crypto.randomUUID()
    const first = planFor(scan, selection.ids, settings, runId)
    if (first.status !== 'ok') return { status: 'refused', message: first.message }
    const plan = {
      deleteBytes: first.deleteBytes,
      quarantineBytes: first.quarantineBytes,
      quarantineRoot: first.list.quarantineRoot,
      systemDrive: scan.ctx.systemDrive,
    }
    const isYes = await confirm(
      $,
      proposalQuestion({ findings: scan.classified.findings, ids: selection.ids, plan, isCleanupOn: true }),
      answers(freedEstimate(plan, 0)).yes,
    )
    if (!isYes) return { status: 'cancelled', message: 'Nothing was changed.' }
    return await act($, scan, selection.ids, runId)
  })
  if (outcome.status !== 'done') await say($, outcome.message)
}

let declinedAt = Number.NEGATIVE_INFINITY

/**
 * Claude's proposal (propose_cleanup): checked by the same planner, then one
 * question to the person. Clean acts; Show the list puts the items in the
 * pane's Choose items tab for the person to change; Cancel, a dismissed dialog or no one
 * to ask changes nothing, and refuses new proposals for a while.
 */
export async function proposeCleanup($: EngineInterface, input: ProposalInput): Promise<CleanOutcome> {
  return await exclusive($, async () => {
    const scan = await loadLatestScan($)
    if (scan === undefined) return { status: 'refused', message: 'There is no deep scan yet. Run run_deep_scan first.' }
    const picked = selectForProposal(scan.classified.findings, input)
    if (picked.status !== 'ok') return picked
    if (Date.now() - declinedAt < DECLINE_COOLDOWN_MS) {
      return {
        status: 'refused',
        message: 'The person declined a cleanup a few minutes ago. Do not propose again unless they ask.',
      }
    }
    const settings = await loadSettings($)
    const runId = crypto.randomUUID()
    // Planned as if cleanup were on, so the person sees the real plan before deciding to turn it on.
    const plan = { deleteBytes: 0, quarantineBytes: 0, quarantineRoot: '', systemDrive: scan.ctx.systemDrive }
    if (picked.ids.length > 0) {
      const preview = planFor(scan, picked.ids, { ...settings, cleanupEnabled: true }, runId)
      if (preview.status !== 'ok') return { status: 'refused', message: preview.message }
      plan.deleteBytes = preview.deleteBytes
      plan.quarantineBytes = preview.quarantineBytes
      plan.quarantineRoot = preview.list.quarantineRoot
    } else {
      const fresh = checkFreshness(scan)
      if (fresh !== null) return { status: 'refused', message: fresh }
    }
    const elevatedBytes = elevatedEstimate(picked.elevated, scan.windows)
    const choice = answers(freedEstimate(plan, elevatedBytes))
    let answer = ''
    try {
      answer = await $.ui.ask(
        proposalQuestion({
          findings: scan.classified.findings,
          ids: picked.ids,
          plan,
          isCleanupOn: settings.cleanupEnabled,
          elevatedLine: elevatedSummary(picked.elevated, scan.windows),
          elevatedBytes,
        }),
        { header: 'Drive Cleanup', options: [choice.yes, choice.review, choice.cancel] },
      )
    } catch {
      answer = ''
    }
    if (answer === choice.review) {
      if (picked.ids.length === 0) {
        declinedAt = Date.now()
        return { status: 'cancelled', message: 'There is no file list for administrator tasks. Nothing was changed.' }
      }
      await setSelection($, () => ({ scanId: scan.meta.scanId, ids: picked.ids }))
      await setView($, { name: 'review', category: null, page: 0 })
      await $.ui.open({ id: PANE_ID, title: 'Drive Cleanup' })
      return {
        status: 'review',
        message: `The ${String(picked.ids.length)} proposed items are selected in the Drive Cleanup pane (Choose items tab). The person changes the selection and presses Clean selected there; nothing was changed yet.${picked.elevated.length > 0 ? ' The administrator tasks were not started; propose them again on their own if the person wants them.' : ''}`,
      }
    }
    if (answer !== choice.yes) {
      declinedAt = Date.now()
      return { status: 'cancelled', message: 'The person did not approve. Nothing was changed.' }
    }
    if (!settings.cleanupEnabled) await saveSettings($, s => ({ ...s, cleanupEnabled: true }))
    const outcome = await act($, scan, picked.ids, runId, picked.elevated)
    if (outcome.status === 'done' && picked.skipped.length > 0) {
      return {
        ...outcome,
        message: `${outcome.message} ${String(picked.skipped.length)} matching items were left for another proposal.`,
      }
    }
    return outcome
  })
}

/** Plans again at the moment of acting, so the approval the scripts check is fresh, then acts and records. */
async function act(
  $: EngineInterface,
  scan: LoadedScan,
  ids: readonly string[],
  runId: string,
  elevated: readonly ElevatedTaskId[] = [],
): Promise<CleanOutcome> {
  const settings = await loadSettings($)
  if (!settings.cleanupEnabled) return { status: 'refused', message: 'Cleanup is off.' }
  let approved: OkPlan
  if (ids.length > 0) {
    const fresh = planFor(scan, ids, settings, runId)
    if (fresh.status !== 'ok') return { status: 'refused', message: fresh.message }
    approved = fresh
  } else {
    const stale = checkFreshness(scan)
    if (stale !== null) return { status: 'refused', message: stale }
    approved = emptyPlan(scan, runId)
  }
  const startedAt = new Date().toISOString()
  await say($, `Cleaning ${String(approved.itemCount + elevated.length)} items…`, 'working')
  $.ui.status('Drive Cleanup: cleaning…')
  const findings = new Map<string, Finding>(scan.classified.findings.map(f => [f.id, f]))
  const results: ItemResult[] = []
  const messages: string[] = []
  const adminItems: RunRecord['items'] = []
  let deletedBytes = 0
  let quarantinedBytes = 0
  let quarantineDir: string | null = null
  try {
    if (approved.list.items.length > 0) {
      const written = await writeDataFile($, `runs/pending/${runId}.json`, JSON.stringify(approved.list))
      if (written.status !== 'written') return { status: 'refused', message: `Nothing was changed: ${written.detail}` }
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
    if (elevated.length > 0) {
      await say($, 'Windows is asking for administrator permission…', 'working')
      const admin = await runAdminTasks($, elevated, runId)
      adminItems.push(...admin.items)
      messages.push(...admin.messages)
      deletedBytes += admin.bytes
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
      done: results.filter(r => r.status !== 'skipped').length + adminItems.filter(i => i.status !== 'skipped').length,
      skipped:
        results.filter(r => r.status === 'skipped').length + adminItems.filter(i => i.status === 'skipped').length,
    },
    items: [...joinResults(results, findings), ...adminItems],
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
  const undo =
    record.quarantinedBytes > 0
      ? ' Changed your mind? /drive-cleanup:undo-cleanup, or the Undo tab in the pane, puts files back.'
      : ''
  const summary = `Done: ${runSummaryText(record)}${messages.length > 0 ? ` ${messages.join(' ')}` : ''}${undo}`
  await say($, summary)
  $.ui.toast(summary)
  return { status: 'done', record, message: summary }
}

/** Runs the administrator tasks and turns their results into run items for the manifest. */
async function runAdminTasks(
  $: EngineInterface,
  tasks: readonly ElevatedTaskId[],
  runId: string,
): Promise<{ items: RunRecord['items']; messages: string[]; bytes: number }> {
  const ran = await runElevated($, tasks, runId)
  if (ran.status !== 'ok')
    return { items: [], messages: [`${ran.detail} Administrator tasks were not done.`], bytes: 0 }
  let bytes = 0
  const items = ran.result.tasks.map(t => {
    const spec = (ELEVATED_TASKS as Partial<Record<string, (typeof ELEVATED_TASKS)[ElevatedTaskId]>>)[t.id]
    const isDone = t.status === 'done'
    if (isDone) bytes += t.removedBytes
    const notes = [
      t.status === 'missing' ? 'Nothing there.' : '',
      t.skippedCount > 0 ? `${String(t.skippedCount)} in use, kept.` : '',
      t.detail,
    ]
    return {
      id: `elevated:${t.id}`,
      status: isDone ? ('deleted' as const) : ('skipped' as const),
      detail: notes.filter(x => x !== '').join(' '),
      destination: null,
      sha256: null,
      bytes: t.removedBytes,
      path: spec?.label ?? t.id,
      category: 'windows_managed',
      reason: spec?.what ?? '',
      action: 'elevated',
    }
  })
  return { items, messages: [], bytes }
}

/** Says `message` in the pane and returns it, for Claude's answer. */
async function tell($: EngineInterface, message: string): Promise<string> {
  await say($, message)
  return message
}

/** Puts a quarantine run back, after its own confirmation. Returns what happened. */
export async function restoreRun($: EngineInterface, runId: string): Promise<string> {
  if (busy) return 'Another cleanup, restore or purge is running. Wait for it to finish.'
  busy = true
  try {
    const index = await readRunIndex($)
    const entry = index.find(e => e.runId === runId && e.kind === 'cleanup')
    if (entry === undefined || entry.quarantineRoot === null || entry.quarantineState !== 'active') {
      return await tell($, 'That quarantine run cannot be restored.')
    }
    const isYes = await confirm(
      $,
      `Put back the ${fmtBytes(entry.quarantinedBytes)} quarantined on ${entry.startedAt.slice(0, 16).replace('T', ' ')}? Anything whose original place is taken again stays in quarantine.`,
      'Restore',
    )
    if (!isYes) return await tell($, 'Nothing was changed.')
    await say($, 'Restoring…', 'working')
    const startedAt = new Date().toISOString()
    const ran = await runAction($, 'restore', {
      DC_RUN_ID: runId,
      DC_QUARANTINE_ROOT: entry.quarantineRoot,
      DC_LIST_ID: '',
    })
    const parsed = ran.status === 'ok' ? parseOutput(RawApplyCheck, ran.stdout, 'restore.ps1') : ran
    if (parsed.status !== 'ok') return await tell($, `Restore did not run: ${parsed.detail}`)
    if (parsed.data.status === 'refused') return await tell($, parsed.data.detail)
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
    return summary
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
export function start(work: () => Promise<unknown>): void {
  void work().catch(() => {})
}
