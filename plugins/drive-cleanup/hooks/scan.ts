import type { EngineInterface } from 'claude-code'
import { atom, update } from 'claude-code'
import type { DcProgress, DcStep, DcSummary } from '../types'
import { CATEGORY_LABEL, CLASS_LABEL, classifyScan, type Classified } from './core/classify.ts'
import { windowsRecommendations } from './core/recommend.ts'
import { STEP_LABEL, STEP_ORDER } from './core/scripts.ts'
import type {
  ClassifyContext,
  NotChecked,
  RawVolume,
  RawWalk,
  RawWindows,
  Recommendation,
  ScanMeta,
  StepId,
  StepStatus,
} from './core/types.ts'
import {
  parseOutput,
  RawVolumeCheck,
  RawWalkCheck,
  RawWindowsCheck,
  type Check,
} from './core/validate.ts'
import { runScript } from './safe-shell.ts'
import { dataFolder, readDataFile, writeDataFile } from './safe-writer.ts'

// The deep scan (PLAN.md §4): three read-only steps, one after another, with
// progress in the pane. Each step's raw output is validated, then stored as
// printed under scans/latest/; findings are computed from it when asked.

const progressAtom = atom({ plugin: 'drive-cleanup', key: 'progress' } as const, null, {
  shape: 'progress-1',
})
const summaryAtom = atom({ plugin: 'drive-cleanup', key: 'summary' } as const, null, {
  shape: 'summary-1',
})

const RAW_FILE: Record<StepId, string> = {
  volume: 'scans/latest/volume.json',
  walk: 'scans/latest/walk.json',
  windows: 'scans/latest/windows.json',
}
const META_FILE = 'scans/latest/meta.json'
const HISTORY_FILE = 'scans/history.json'

export type LoadedScan = {
  meta: ScanMeta
  volume: RawVolume | null
  walk: RawWalk | null
  windows: RawWindows | null
  ctx: ClassifyContext
  classified: Classified
  recommendations: Recommendation[]
}

// ---------------------------------------------------------------- running

let running: Promise<ScanOutcome> | undefined
let isCancelRequested = false

export const isScanRunning = (): boolean => running !== undefined

export function requestCancel(): boolean {
  if (running === undefined) return false
  isCancelRequested = true
  return true
}

export type ScanOutcome =
  | { status: 'ok'; scan: LoadedScan }
  | { status: 'refused'; message: string }

const toDcStep = (s: StepStatus): DcStep => ({
  id: s.id,
  label: s.label,
  state: s.state,
  durationMs: s.durationMs,
  detail: s.notChecked?.detail ?? null,
  isRetryable:
    s.notChecked !== null &&
    (s.notChecked.reason === 'timeout' || s.notChecked.reason === 'failed' || s.notChecked.reason === 'cancelled'),
  isTruncated: s.isTruncated,
})

async function setProgress($: EngineInterface, p: DcProgress | null): Promise<void> {
  await update($, progressAtom, () => p)
}

const checks: { [K in StepId]: Check<unknown> } = {
  volume: RawVolumeCheck,
  walk: RawWalkCheck,
  windows: RawWindowsCheck,
}

/** Runs the deep scan, or only `only` (a retry), merging into the latest scan. */
export function startScan($: EngineInterface, only?: StepId): Promise<ScanOutcome> {
  if (running !== undefined) {
    return Promise.resolve({ status: 'refused', message: 'A deep scan is already running.' })
  }
  isCancelRequested = false
  running = performScan($, only).finally(() => {
    running = undefined
    isCancelRequested = false
  })
  return running
}

async function performScan($: EngineInterface, only: StepId | undefined): Promise<ScanOutcome> {
  const folder = await dataFolder($)
  if (folder.status !== 'ok') return { status: 'refused', message: folder.detail }

  const previous = only === undefined ? undefined : await loadLatestScan($)
  if (only !== undefined && previous === undefined) {
    return { status: 'refused', message: 'There is no scan to retry a step of. Run a deep scan.' }
  }
  const scanId = previous?.meta.scanId ?? crypto.randomUUID()
  const createdAt = previous?.meta.createdAt ?? new Date().toISOString()
  const startedAt = Date.now()
  const steps: StepStatus[] = STEP_ORDER.map(id => {
    const kept = previous?.meta.steps.find(s => s.id === id)
    if (only !== undefined && id !== only && kept !== undefined) return kept
    return { id, label: STEP_LABEL[id], state: 'pending', durationMs: null, notChecked: null, isTruncated: false }
  })
  const publish = async (state: DcProgress['state'], message: string): Promise<void> => {
    await setProgress($, {
      scanId,
      state,
      startedAt,
      finishedAt: state === 'running' ? null : Date.now(),
      steps: steps.map(toDcStep),
      message,
    })
  }

  await publish('running', 'Starting… The walk of the drive takes a few minutes.')
  $.ui.status('Drive Cleanup: scanning C: (read-only)…')
  void $.ui.open({ id: PANE_ID, title: 'Drive Cleanup' }).catch(() => undefined)

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      if (step === undefined || (only !== undefined && step.id !== only)) continue
      if (isCancelRequested) {
        step.state = 'not_checked'
        step.notChecked = { status: 'not_checked', reason: 'cancelled', detail: 'Cancelled before it started.' }
        continue
      }
      step.state = 'running'
      await publish('running', `${step.label}…`)
      const t0 = Date.now()
      const ran = await runScript($, step.id)
      const parsed = ran.status === 'ok' ? parseOutput(checks[step.id], ran.stdout, `${step.id}.ps1`) : ran
      step.durationMs = Date.now() - t0
      if (parsed.status === 'ok' && ran.status === 'ok') {
        const written = await writeDataFile($, RAW_FILE[step.id], ran.stdout)
        if (written.status !== 'written') {
          step.state = 'not_checked'
          step.notChecked = { status: 'not_checked', reason: 'failed', detail: `Measured but not saved: ${written.detail}` }
        } else {
          step.state = 'ok'
          step.notChecked = null
          const data = parsed.data as { isTruncated?: unknown; items?: unknown }
          step.isTruncated =
            data.isTruncated === true ||
            (Array.isArray(data.items) && data.items.some(it => (it as { isTruncated?: unknown }).isTruncated === true))
        }
      } else {
        step.state = 'not_checked'
        step.notChecked = parsed as NotChecked
      }
    }
  } finally {
    $.ui.status(undefined)
  }

  const isPcGuardianInstalled = await detectPcGuardian($)
  const meta: ScanMeta = {
    scanId,
    createdAt,
    finishedAt: new Date().toISOString(),
    steps,
    isPcGuardianInstalled,
    dataFolder: folder.path,
  }
  await writeDataFile($, META_FILE, JSON.stringify(meta))
  cached = undefined

  const scan = await loadLatestScan($)
  const cancelled = isCancelRequested
  if (scan === undefined) {
    await publish('failed', 'The scan could not be saved or read back.')
    return { status: 'refused', message: 'The scan could not be saved or read back.' }
  }
  await recordHistory($, scan)
  await update($, summaryAtom, current => summaryOf(scan, current?.lastAuditFolder ?? null))
  const ok = steps.filter(s => s.state === 'ok').length
  await publish(
    cancelled ? 'cancelled' : ok === 0 ? 'failed' : 'done',
    cancelled
      ? 'Cancelled. What finished is kept.'
      : `Done in ${String(Math.round((Date.now() - startedAt) / 1000))} s: ${String(ok)} of ${String(steps.length)} steps measured.`,
  )
  return { status: 'ok', scan }
}

export const PANE_ID = 'drive-cleanup'

async function detectPcGuardian($: EngineInterface): Promise<boolean> {
  const home = await $.env.get('USERPROFILE')
  if (home === undefined) return false
  try {
    return await $.fs.exists(`${home}\\.claude\\plugins\\cache\\techgramam\\pc-guardian`)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- reading

let cached: LoadedScan | undefined

async function readRaw<T>($: EngineInterface, step: StepId, meta: ScanMeta): Promise<T | null> {
  if (meta.steps.find(s => s.id === step)?.state !== 'ok') return null
  const text = await readDataFile($, RAW_FILE[step])
  if (text === undefined) return null
  const parsed = parseOutput(checks[step], text, `${step}.ps1`)
  return parsed.status === 'ok' ? (parsed.data as T) : null
}

function isMeta(value: unknown): value is ScanMeta {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.scanId === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.dataFolder === 'string' &&
    typeof v.isPcGuardianInstalled === 'boolean' &&
    Array.isArray(v.steps)
  )
}

export async function loadLatestScan($: EngineInterface): Promise<LoadedScan | undefined> {
  const text = await readDataFile($, META_FILE)
  if (text === undefined) return undefined
  let meta: unknown
  try {
    meta = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isMeta(meta)) return undefined
  if (cached !== undefined && cached.meta.scanId === meta.scanId && cached.meta.finishedAt === meta.finishedAt) {
    return cached
  }
  const volume = await readRaw<RawVolume>($, 'volume', meta)
  const walk = await readRaw<RawWalk>($, 'walk', meta)
  const windows = await readRaw<RawWindows>($, 'windows', meta)
  const ctx = contextOf(meta, volume)
  const scan: LoadedScan = {
    meta,
    volume,
    walk,
    windows,
    ctx,
    classified: classifyScan(walk, windows, ctx),
    recommendations: windowsRecommendations(volume, windows),
  }
  cached = scan
  return scan
}

function contextOf(meta: ScanMeta, volume: RawVolume | null): ClassifyContext {
  const drive = volume?.systemDrive ?? 'C:'
  const profile = volume?.userProfile ?? `${drive}\\Users\\unknown`
  return {
    nowMs: Date.parse(meta.finishedAt) || Date.now(),
    systemDrive: drive,
    systemRoot: volume?.systemRoot ?? `${drive}\\Windows`,
    userProfile: profile,
    profilesRoot: volume?.profilesRoot ?? `${drive}\\Users`,
    appData: volume?.appData ?? `${profile}\\AppData\\Roaming`,
    localAppData: volume?.localAppData ?? `${profile}\\AppData\\Local`,
    temp: volume?.temp ?? `${profile}\\AppData\\Local\\Temp`,
    downloads: volume?.downloads ?? `${profile}\\Downloads`,
    dataFolder: meta.dataFolder,
    isPcGuardianInstalled: meta.isPcGuardianInstalled,
    lastAccessTrusted: volume?.lastAccess.isUpdated === true,
  }
}

export function summaryOf(scan: LoadedScan, lastAuditFolder: string | null): DcSummary {
  const system = scan.volume?.drives.find(d => d.isSystem)
  return {
    scanId: scan.meta.scanId,
    createdAt: scan.meta.createdAt,
    drive: system === undefined ? null : { letter: system.letter, totalBytes: system.totalBytes, freeBytes: system.freeBytes },
    recoverable: scan.classified.recoverable,
    top: scan.classified.totals
      .filter(t => t.class !== 'protected')
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 4)
      .map(t => ({ label: CATEGORY_LABEL[t.category], className: CLASS_LABEL[t.class], bytes: t.bytes, count: t.count })),
    isPartial: scan.meta.steps.some(s => s.state !== 'ok' || s.isTruncated),
    lastAuditFolder,
  }
}

export async function setLastAuditFolder($: EngineInterface, folder: string): Promise<void> {
  await update($, summaryAtom, current => (current === null ? null : { ...current, lastAuditFolder: folder }))
}

type HistoryEntry = {
  scanId: string
  createdAt: string
  freeBytes: number | null
  safeBytes: number
  reviewBytes: number
}

async function recordHistory($: EngineInterface, scan: LoadedScan): Promise<void> {
  let list: HistoryEntry[] = []
  const text = await readDataFile($, HISTORY_FILE)
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) list = parsed as HistoryEntry[]
    } catch {
      list = []
    }
  }
  const entry: HistoryEntry = {
    scanId: scan.meta.scanId,
    createdAt: scan.meta.createdAt,
    freeBytes: scan.volume?.drives.find(d => d.isSystem)?.freeBytes ?? null,
    safeBytes: scan.classified.recoverable.safeBytes,
    reviewBytes: scan.classified.recoverable.reviewBytes,
  }
  list = [entry, ...list.filter(e => e.scanId !== entry.scanId)].slice(0, 20)
  await writeDataFile($, HISTORY_FILE, JSON.stringify(list))
}
