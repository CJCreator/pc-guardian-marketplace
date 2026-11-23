import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'
import {
  applyProgress,
  AuditCancelledError,
  BAND_LABEL,
  buildRecommendations,
  CATEGORY_LABEL,
  computeHealthScore,
  createRealCollectors,
  finishProgress,
  paneSummary,
  readRealMachine,
  recheckedSnapshot,
  runAudit,
  singleAreaCollectors,
  startProgress,
  startRetryProgress,
  startScoring,
  StoredScanSchema,
  toStoredScan,
  type AuditSnapshot,
  type Category,
  type HealthScore,
  type ScanProgress,
  type StoredScan,
  type ToolError,
  withScanScope,
} from './deps.js'
import { pushProgress, pushState } from './dashboard-link.ts'
import { loadHistoryIndex, loadStoredScan, replaceScanInHistory, saveScanToHistory } from './history-store.ts'
import { loadSettings } from './settings-store.ts'
import { runScript } from './safe-shell.ts'

// The engine reads $.state keys statically, file by file: each file that
// reads or writes a value declares its atom itself. Every declaration of a
// key must match (a test checks): see ../types/index.d.ts for the contract.
const summaryAtom = atom({ plugin: 'pc-guardian', key: 'summary' } as const, null, {
  shape: 'summary-3',
})
const progressAtom = atom({ plugin: 'pc-guardian', key: 'progress' } as const, null, {
  shape: 'progress-3',
})
const latestScanAtom = atom({ plugin: 'pc-guardian', key: 'latestScan' } as const, null, {
  shape: 'scan-1',
})

export type AuditRequest = {
  /** Measure this one area only: no progress, not saved, not the latest scan. */
  onlyCategory?: Category
}

export type AuditOutcome =
  | { status: 'ok'; scan: StoredScan; history: { isSaved: boolean; detail: string } }
  | { status: 'error'; error: ToolError }

/** A "running" flag older than this was left by a reload or crash, not a live scan. */
const STALE_RUN_MS = 5 * 60 * 1000

/** The scan in progress, so Cancel can stop it. Lost on reload, which is fine. */
let activeAudit: AbortController | undefined

/**
 * Starts a full audit and returns at once. A button's press hook has a 10 s
 * budget of its own time and an audit's parsing and scoring alone can exceed
 * it, so the audit runs on after the hook returns and reports through the
 * progress state, which the pane and the browser dashboard both show.
 */
export function startAudit($: EngineInterface, request: AuditRequest): void {
  void performAudit($, request).catch(() => undefined)
}

/** The same for re-checking one area of the latest scan (a step's Retry). */
export function startRecheck($: EngineInterface, category: Category): void {
  void recheckArea($, category).catch(() => undefined)
}

/** Whether a scan or a step's re-check is running now (cleanup waits for it). */
export const isAuditRunning = (): boolean => activeAudit !== undefined

/** Stops the running scan before its next script. True when one was running. */
export const cancelActiveAudit = (): boolean => {
  if (activeAudit === undefined) return false
  activeAudit.abort()
  return true
}

const errorOf = (code: ToolError['code'], message: string, suggestedAction: string): AuditOutcome => ({
  status: 'error',
  error: { code, message, recoverable: true, suggestedAction },
})

const BUSY = errorOf('busy', 'A scan is already running.', 'Wait for it to finish; the dashboard shows its progress.')

/**
 * Takes the progress state for a new scan, unless one is running. `update`
 * may run the change again on a write conflict; the last run decides.
 */
async function claimProgress($: EngineInterface, start: ScanProgress): Promise<boolean> {
  const claim = { isClaimed: false }
  await update($, progressAtom, current => {
    const isLive = current?.state === 'running' && start.startedAt - current.startedAt < STALE_RUN_MS
    claim.isClaimed = !isLive
    return isLive ? current : start
  })
  if (claim.isClaimed) void pushProgress($)
  return claim.isClaimed
}

async function setProgress($: EngineInterface, change: (p: ScanProgress) => ScanProgress): Promise<void> {
  await update($, progressAtom, p => (p === null ? p : change(p)))
  await pushProgress($)
}

const doneMessage = (score: HealthScore): string =>
  score.overall === null || score.band === null
    ? 'Done: no area could be checked.'
    : `Done: ${String(score.overall)}/100 (${BAND_LABEL[score.band]}).`

/**
 * Runs an audit through the same pipeline every caller uses: the allowlisted
 * scripts via SafeShell, runAudit, scoring and
 * recommendations. A full audit is exclusive, reports live progress to the
 * pane, the status line and the browser dashboard, is saved to history
 * (personal paths removed) and becomes the session's latest scan (kept
 * unredacted in memory only).
 */
export async function performAudit(
  $: EngineInterface,
  request: AuditRequest,
  signal?: AbortSignal,
): Promise<AuditOutcome> {
  const isFull = request.onlyCategory === undefined
  const controller = new AbortController()
  const forwardAbort = (): void => {
    controller.abort()
  }
  signal?.addEventListener('abort', forwardAbort)

  if (isFull) {
    if (!(await claimProgress($, startProgress(Date.now())))) {
      signal?.removeEventListener('abort', forwardAbort)
      return BUSY
    }
    activeAudit = controller
    $.ui.status('PC Guardian: scanning…')
  }

  try {
    // A full audit follows the person's settings: the areas they keep on, how many scans to keep.
    const { settings } = await loadSettings($)
    const source = createRealCollectors()
    const snapshot = await runAudit({
      collectors:
        request.onlyCategory === undefined
          ? withScanScope(source, settings.scanScope)
          : singleAreaCollectors(request.onlyCategory, source),
      readMachine: readRealMachine,
      context: {
        run: (id, params) => runScript($, id, { params, signal: controller.signal }),
        signal: controller.signal,
      },
      dataSource: 'real',
      id: crypto.randomUUID(),
      now: () => Date.now(),
      onProgress: event => {
        if (!isFull) return
        void setProgress($, p => applyProgress(p, event, Date.now())).catch(() => undefined)
        if (event.type === 'step_started') $.ui.status(`PC Guardian: checking ${event.category}…`)
      },
    })

    if (snapshot.machine.status === 'not_checked' && snapshot.machine.reason === 'unsupported_platform') {
      if (isFull) {
        await setProgress($, p => finishProgress(p, { state: 'failed', message: 'This is not Windows.' }, Date.now()))
      }
      return errorOf(
        'unsupported_platform',
        'PC Guardian audits Windows 10 and 11, and this is not Windows.',
        'Run it on Windows 10 or 11.',
      )
    }

    if (isFull) await setProgress($, p => startScoring(p, Date.now()))
    const score = computeHealthScore(snapshot)
    const recommendations = buildRecommendations(snapshot, score)
    const scan = toStoredScan(snapshot, score, recommendations, { redactPersonalPaths: false })
    if (!isFull) {
      return {
        status: 'ok',
        scan,
        history: { isSaved: false, detail: 'Single-area checks are not saved.' },
      }
    }

    const saved = await saveScanToHistory(
      $,
      toStoredScan(snapshot, score, recommendations, { redactPersonalPaths: true }),
      settings.historyRetention,
    )
    await update($, latestScanAtom, () => scan)
    await update($, summaryAtom, () => paneSummary(scan, saved.index))
    const previous = saved.index.entries.find(e => e.id !== snapshot.id)
    await setProgress($, p =>
      finishProgress(
        p,
        {
          state: 'done',
          message: doneMessage(score),
          result: {
            scanId: snapshot.id,
            overall: score.overall,
            previousOverall: previous?.overall ?? null,
          },
        },
        Date.now(),
      ),
    )
    return { status: 'ok', scan, history: { isSaved: saved.isSaved, detail: saved.detail } }
  } catch (error) {
    if (isFull) await finishWithError($, error)
    return outcomeOfError(error)
  } finally {
    signal?.removeEventListener('abort', forwardAbort)
    if (isFull) {
      if (activeAudit === controller) activeAudit = undefined
      $.ui.status(undefined)
      void pushState($).catch(() => undefined)
    }
  }
}

/**
 * A step's Retry (decision #28): measures one area again and merges it into
 * the latest scan, which is re-scored, saved in its own history slot and
 * marked "<area> re-checked at <time>". The other areas keep their results.
 */
export async function recheckArea($: EngineInterface, category: Category, signal?: AbortSignal): Promise<AuditOutcome> {
  const base = await latestScan($)
  if (base === undefined) {
    return errorOf('not_found', 'There is no scan to re-check.', 'Run a full scan first.')
  }
  if (!(await claimProgress($, startRetryProgress(category, Date.now())))) return BUSY

  const controller = new AbortController()
  const forwardAbort = (): void => {
    controller.abort()
  }
  signal?.addEventListener('abort', forwardAbort)
  activeAudit = controller
  $.ui.status(`PC Guardian: checking ${CATEGORY_LABEL[category]} again…`)

  try {
    const fresh = await runAudit({
      collectors: singleAreaCollectors(category, createRealCollectors()),
      readMachine: () => Promise.resolve(base.snapshot.machine),
      context: {
        run: (id, params) => runScript($, id, { params, signal: controller.signal }),
        signal: controller.signal,
      },
      dataSource: base.snapshot.dataSource,
      id: base.snapshot.id,
      now: () => Date.now(),
      onProgress: event => {
        void setProgress($, p => applyProgress(p, event, Date.now())).catch(() => undefined)
      },
    })

    await setProgress($, p => startScoring(p, Date.now()))
    const snapshot: AuditSnapshot = recheckedSnapshot(
      base.snapshot,
      category,
      fresh.categories[category],
      new Date().toISOString(),
    )
    const score = computeHealthScore(snapshot)
    const recommendations = buildRecommendations(snapshot, score)
    const scan = toStoredScan(snapshot, score, recommendations, { redactPersonalPaths: false })
    const { settings } = await loadSettings($)
    const forHistory = toStoredScan(snapshot, score, recommendations, { redactPersonalPaths: true })
    const saved =
      (await replaceScanInHistory($, forHistory)) ?? (await saveScanToHistory($, forHistory, settings.historyRetention))
    await update($, latestScanAtom, () => scan)
    await update($, summaryAtom, () => paneSummary(scan, saved.index))
    await setProgress($, p =>
      finishProgress(
        p,
        {
          state: 'done',
          message: `${CATEGORY_LABEL[category]} re-checked. ${doneMessage(score)}`,
          result: {
            scanId: snapshot.id,
            overall: score.overall,
            previousOverall: base.score.overall,
          },
        },
        Date.now(),
      ),
    )
    return { status: 'ok', scan, history: { isSaved: saved.isSaved, detail: saved.detail } }
  } catch (error) {
    await finishWithError($, error)
    return outcomeOfError(error)
  } finally {
    signal?.removeEventListener('abort', forwardAbort)
    if (activeAudit === controller) activeAudit = undefined
    $.ui.status(undefined)
    void pushState($).catch(() => undefined)
  }
}

/** The session's latest scan, else the newest in history. */
async function latestScan($: EngineInterface): Promise<StoredScan | undefined> {
  const inSession = StoredScanSchema.safeParse(await read($, latestScanAtom))
  if (inSession.success) return inSession.data
  const newest = (await loadHistoryIndex($)).entries[0]
  return newest === undefined ? undefined : loadStoredScan($, newest)
}

async function finishWithError($: EngineInterface, error: unknown): Promise<void> {
  const isCancelled = error instanceof AuditCancelledError
  await setProgress($, p =>
    finishProgress(
      p,
      isCancelled
        ? { state: 'cancelled', message: 'Cancelled. Nothing was changed.' }
        : {
            state: 'failed',
            message: `The scan stopped with an error: ${error instanceof Error ? error.message : String(error)}`,
          },
      Date.now(),
    ),
  ).catch(() => undefined)
}

const outcomeOfError = (error: unknown): AuditOutcome =>
  error instanceof AuditCancelledError
    ? errorOf('cancelled', 'The audit was cancelled before it finished.', 'Run it again when you are ready.')
    : errorOf(
        'internal',
        `The audit stopped with an error: ${error instanceof Error ? error.message : String(error)}`,
        'Run it again; if it keeps failing, run self_check.',
      )
