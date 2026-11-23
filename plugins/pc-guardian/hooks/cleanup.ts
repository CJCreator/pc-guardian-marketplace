import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'
import {
  appendCleanupRun,
  checkCleanRequest,
  CLEANUP_LOG_FILE,
  CleanupStateSchema,
  createRealCollectors,
  IDLE_CLEANUP,
  isCleanupAllowed,
  paneCleanupGroups,
  parseCleanupLog,
  parseScriptOutput,
  RawCleanupPreviewSchema,
  RawRemovalSchema,
  RawStartupChangeSchema,
  removalResult,
  runSummary,
  startupResult,
  startupTurnedOff,
  toCleanupPreview,
  type CleanupItem,
  type CleanupLog,
  type CleanupPreview,
  type CleanupResult,
  type CleanupRun,
  type CleanupState,
  type RawStartupChange,
  type ScriptRun,
  type StartupRef,
} from './deps.js'
import { isAuditRunning } from './audit.ts'
import { pushNotice, pushState } from './dashboard-link.ts'
import { readDataJson } from './history-store.ts'
import { runAction, runScript } from './safe-shell.ts'
import { writeDataFile } from './safe-writer.ts'
import { loadSettings } from './settings-store.ts'

// Cleanup you choose (decisions #33): the only module that runs a cleanup
// action, and only for items the person ticked in a fresh preview and
// confirmed, with cleanup turned on. Claude's tool can only preview.

const cleanupAtom = atom({ plugin: 'pc-guardian', key: 'cleanup' } as const, null, {
  shape: 'cleanup-2',
})

async function readCleanup($: EngineInterface): Promise<CleanupState> {
  const parsed = CleanupStateSchema.safeParse(await read($, cleanupAtom))
  return parsed.success ? parsed.data : IDLE_CLEANUP
}

async function setCleanup($: EngineInterface, change: (state: CleanupState) => CleanupState): Promise<void> {
  await update($, cleanupAtom, current => {
    const parsed = CleanupStateSchema.safeParse(current)
    return change(parsed.success ? parsed.data : IDLE_CLEANUP)
  })
  await pushState($)
}

async function readLog($: EngineInterface): Promise<CleanupLog> {
  return parseCleanupLog(await readDataJson($, CLEANUP_LOG_FILE))
}

export type PreviewOutcome = { status: 'ok'; preview: CleanupPreview } | { status: 'error'; message: string }

/**
 * Measures what cleanup could free now (read-only), and keeps it as the
 * current preview: the dashboard shows it, and a clean may only use it.
 */
export async function previewCleanup($: EngineInterface): Promise<PreviewOutcome> {
  const state = await readCleanup($)
  if (state.status !== 'idle') {
    return { status: 'error', message: 'PC Guardian is already checking or cleaning.' }
  }
  await setCleanup($, s => ({ ...s, status: 'checking', message: null }))
  let outcome: PreviewOutcome
  try {
    const meta = { id: crypto.randomUUID(), now: Date.now() }
    const ran = await runScript($, 'cleanupPreview')
    const raw =
      ran.status === 'ok' ? parseScriptOutput(RawCleanupPreviewSchema, ran.stdout, 'cleanup-preview.ps1') : ran
    if (raw.status !== 'ok') {
      outcome = {
        status: 'error',
        message: `What cleanup could free was not measured: ${raw.detail}`,
      }
    } else {
      const startup = await createRealCollectors().startup.collect({
        run: (id, params) => runScript($, id, { params }),
      })
      outcome = { status: 'ok', preview: toCleanupPreview(raw.data, startup, meta) }
    }
  } catch {
    outcome = { status: 'error', message: 'What cleanup could free was not measured.' }
  }
  const result = outcome
  await setCleanup($, s => ({
    ...s,
    status: 'idle',
    preview: result.status === 'ok' ? result.preview : s.preview,
    message: result.status === 'ok' ? null : result.message,
  }))
  return result
}

const failed = (item: CleanupItem, detail: string): CleanupResult => ({
  itemId: item.id,
  kind: item.kind,
  label: item.label,
  effect: item.effect === 'turn_off' ? 'turn_off' : 'delete',
  status: 'failed',
  freedBytes: null,
  removedCount: null,
  skippedCount: null,
  detail,
  startup: item.target.kind === 'startup' ? item.target.startup : null,
})

const asRemoval = (item: CleanupItem, ran: ScriptRun): CleanupResult => {
  if (ran.status !== 'ok') return failed(item, ran.detail)
  const parsed = parseScriptOutput(RawRemovalSchema, ran.stdout, 'the cleanup action')
  return parsed.status === 'ok' ? removalResult(item, parsed.data) : failed(item, parsed.detail)
}

async function setStartupApp(
  $: EngineInterface,
  ref: StartupRef,
  state: 'off' | 'on',
): Promise<{ status: 'ok'; raw: RawStartupChange } | { status: 'failed'; detail: string }> {
  const ran = await runAction($, 'setStartup', {
    PCG_STARTUP_SCOPE: ref.scope,
    PCG_STARTUP_NAME: ref.valueName,
    PCG_STARTUP_STATE: state,
  })
  if (ran.status !== 'ok') return { status: 'failed', detail: ran.detail }
  const parsed = parseScriptOutput(RawStartupChangeSchema, ran.stdout, 'set-startup.ps1')
  return parsed.status === 'ok' ? { status: 'ok', raw: parsed.data } : { status: 'failed', detail: parsed.detail }
}

/** One ticked item, by its own action. */
async function cleanOne($: EngineInterface, item: CleanupItem, preview: CleanupPreview): Promise<CleanupResult> {
  const target = item.target
  if (target.kind === 'startup') {
    const changed = await setStartupApp($, target.startup, 'off')
    return changed.status === 'ok'
      ? startupResult(item.label, item.id, target.startup, changed.raw, 'off')
      : failed(item, changed.detail)
  }
  switch (target.kind) {
    case 'temp':
      return asRemoval(item, await runAction($, 'cleanTemp', { PCG_PREVIEWED_AT: preview.createdAt }))
    case 'browser_cache':
      return asRemoval(
        item,
        await runAction($, 'cleanBrowserCache', {
          PCG_BROWSER: target.browser,
          PCG_PREVIEWED_AT: preview.createdAt,
        }),
      )
    case 'recycle_bin':
      return asRemoval(item, await runAction($, 'emptyRecycleBin', { PCG_EXPECTED_COUNT: String(target.itemCount) }))
  }
}

async function logRun($: EngineInterface, run: CleanupRun): Promise<void> {
  const written = await writeDataFile($, CLEANUP_LOG_FILE, JSON.stringify(appendCleanupRun(await readLog($), run)))
  if (written.status !== 'written') {
    await pushNotice($, {
      level: 'warning',
      message: `The cleanup was done but not logged: ${written.detail}`,
    })
  }
}

export type CleanOutcome = { status: 'ok'; run: CleanupRun } | { status: 'refused'; message: string }

/**
 * Cleans the items the person ticked in the current preview and confirmed.
 * Refused, with nothing changed, unless cleanup is on, the preview is the
 * current one and under 10 minutes old, every item is in it and can be done
 * now, and no scan is running. The preview is used up either way it ends.
 */
export async function runCleanup(
  $: EngineInterface,
  request: { previewId: string; itemIds: readonly string[]; origin: 'dashboard' | 'pane' },
): Promise<CleanOutcome> {
  const state = await readCleanup($)
  if (state.status !== 'idle') {
    return { status: 'refused', message: 'PC Guardian is already checking or cleaning.' }
  }
  const { settings } = await loadSettings($)
  const check = checkCleanRequest({
    preview: state.preview,
    previewId: request.previewId,
    itemIds: request.itemIds,
    now: Date.now(),
    isCleanupEnabled: isCleanupAllowed(settings),
    isScanRunning: isAuditRunning(),
  })
  const preview = state.preview
  if (check.status !== 'ok' || preview === null) {
    const message = check.status === 'ok' ? 'There is no current list.' : check.message
    await setCleanup($, s => ({ ...s, message }))
    return { status: 'refused', message }
  }

  await setCleanup($, s => ({ ...s, status: 'cleaning', message: 'Cleaning…' }))
  $.ui.status('PC Guardian: cleaning up…')
  const startedAt = new Date().toISOString()
  const results: CleanupResult[] = []
  try {
    for (const item of check.items) {
      try {
        results.push(await cleanOne($, item, preview))
      } catch {
        results.push(failed(item, 'It stopped unexpectedly; nothing more was done for it.'))
      }
      const done = results.length
      await setCleanup($, s => ({
        ...s,
        message: `Cleaning… ${String(done)} of ${String(check.items.length)} done.`,
      }))
    }
  } finally {
    $.ui.status(undefined)
  }
  const run: CleanupRun = {
    id: crypto.randomUUID(),
    previewId: preview.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    origin: request.origin,
    results,
  }
  await logRun($, run)
  // What the preview listed has changed, so it cannot be used again.
  await setCleanup($, () => ({
    status: 'idle',
    preview: null,
    lastRun: run,
    message: runSummary(run),
  }))
  await pushNotice($, {
    level: 'info',
    message: `Cleanup: ${runSummary(run)} Run a scan to see the difference.`,
  })
  return { status: 'ok', run }
}

/**
 * Turns a startup app back on, but only one PC Guardian turned off (by its
 * log): this never becomes a way to change any other startup entry.
 */
export async function restoreStartup(
  $: EngineInterface,
  ref: StartupRef,
  origin: 'dashboard' | 'pane',
): Promise<CleanOutcome> {
  const entry = startupTurnedOff((await readLog($)).runs).find(
    off => off.ref.scope === ref.scope && off.ref.valueName.toLowerCase() === ref.valueName.toLowerCase(),
  )
  if (entry === undefined) {
    return {
      status: 'refused',
      message: 'PC Guardian did not turn that app off, so it does not turn it on.',
    }
  }
  const startedAt = new Date().toISOString()
  const changed = await setStartupApp($, entry.ref, 'on')
  const itemId = `startup:${entry.ref.scope}:${entry.ref.valueName}`
  const result: CleanupResult =
    changed.status === 'ok'
      ? startupResult(entry.label, itemId, entry.ref, changed.raw, 'on')
      : {
          itemId,
          kind: 'startup',
          label: entry.label,
          effect: 'turn_on',
          status: 'failed',
          freedBytes: null,
          removedCount: null,
          skippedCount: null,
          detail: changed.detail,
          startup: entry.ref,
        }
  const run: CleanupRun = {
    id: crypto.randomUUID(),
    previewId: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    origin,
    results: [result],
  }
  await logRun($, run)
  await setCleanup($, s => ({ ...s, lastRun: run, message: `${entry.label}: ${result.detail}` }))
  await pushNotice($, {
    level: result.status === 'done' ? 'info' : 'warning',
    message: `${entry.label}: ${result.detail}`,
  })
  return { status: 'ok', run }
}

/** Starts a dashboard request and returns, as scans do (a hook's 10 s budget). */
export function startCleanupRequest(
  $: EngineInterface,
  work: () => Promise<{ status: string; message?: string }>,
): void {
  void work()
    .then(async outcome => {
      if (outcome.status !== 'ok' && outcome.message !== undefined) {
        await pushNotice($, { level: 'warning', message: outcome.message })
      }
    })
    .catch(() => undefined)
}

/**
 * The pane's Clean up: preview, then Claude Code's own question dialog with
 * the four groups to tick, then Clean or Cancel. Only the person answers that
 * dialog; it is refused with no one to ask (a `-p` run), and a dismissed or
 * unexpected answer cleans nothing.
 */
export async function cleanupFromPane($: EngineInterface): Promise<void> {
  const { settings } = await loadSettings($)
  if (!isCleanupAllowed(settings)) {
    $.ui.toast('Cleanup is off. Turn it on in the browser dashboard: Settings > Cleanup.')
    return
  }
  const previewed = await previewCleanup($)
  if (previewed.status !== 'ok') {
    $.ui.toast(previewed.message)
    return
  }
  const preview = previewed.preview
  const groups = paneCleanupGroups(preview)
  if (groups.length === 0) {
    $.ui.toast('Nothing can be cleaned right now. The dashboard says why for each item.')
    return
  }
  let chosen = groups
  try {
    if (groups.length > 1) {
      const answer = await $.ui.ask('Which should PC Guardian clean? Deleted files cannot be restored.', {
        header: 'Clean up',
        multiSelect: true,
        options: groups.map(g => g.label),
      })
      const picked = answer.split(',').map(part => part.trim())
      chosen = groups.filter(g => picked.includes(g.label))
      // Anything typed under "Other", or nothing ticked, cleans nothing.
      if (chosen.length === 0 || picked.some(p => !groups.some(g => g.label === p))) {
        $.ui.toast('Nothing was cleaned.')
        return
      }
    }
    const confirm = await $.ui.ask(
      `Clean now? ${chosen.map(g => g.label).join('; ')}. This cannot be undone for deleted files.`,
      { header: 'Confirm', options: ['Clean', 'Cancel'] },
    )
    if (confirm !== 'Clean') {
      $.ui.toast('Nothing was cleaned.')
      return
    }
  } catch {
    $.ui.toast('Nothing was cleaned.')
    return
  }
  const outcome = await runCleanup($, {
    previewId: preview.id,
    itemIds: chosen.flatMap(g => g.itemIds),
    origin: 'pane',
  })
  $.ui.toast(outcome.status === 'ok' ? runSummary(outcome.run) : outcome.message)
}

/** The pane's button: starts the flow and returns at once (a press hook's budget). */
export function startCleanupFromPane($: EngineInterface): void {
  void cleanupFromPane($).catch(() => undefined)
}
