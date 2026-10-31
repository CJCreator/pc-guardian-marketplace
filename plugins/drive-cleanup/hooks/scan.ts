import type { EngineInterface } from 'claude-code'
import { atom, update } from 'claude-code'
import type { DcProgress, DcStep, DcSummary } from '../types'
import { CATEGORY_LABEL, CLASS_LABEL, classifyScan, type Classified } from './core/classify.ts'
import { mergeHash } from './core/duplicates.ts'
import { windowsRecommendations } from './core/recommend.ts'
import { STEP_LABEL, STEP_ORDER } from './core/scripts.ts'
import type {
  ClassifyContext,
  NotChecked,
  RawDevCaches,
  RawHash,
  RawLeftovers,
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
  RawDevCachesCheck,
  RawHashCheck,
  RawLeftoversCheck,
  RawVolumeCheck,
  RawWalkCheck,
  RawWindowsCheck,
  type Check,
} from './core/validate.ts'
import { runScript } from './safe-shell.ts'
import { dataFolder, readDataFile, writeDataFile } from './safe-writer.ts'
import { loadSettings } from './settings-store.ts'

// The deep scan (PLAN.md §4): read-only steps, one after another, with
// progress in the pane. Each step's raw output is validated, then stored under
// scans/latest/; findings are computed from it when asked.

const progressAtom = atom({ plugin: 'drive-cleanup', key: 'progress' } as const, null, {
  shape: 'progress-1',
})
const summaryAtom = atom({ plugin: 'drive-cleanup', key: 'summary' } as const, null, {
  shape: 'summary-1',
})

export const PANE_ID = 'drive-cleanup'

const RAW_FILE: Record<StepId, string> = {
  volume: 'scans/latest/volume.json',
  walk: 'scans/latest/walk.json',
  devcaches: 'scans/latest/devcaches.json',
  leftovers: 'scans/latest/leftovers.json',
  windows: 'scans/latest/windows.json',
  hash: 'scans/latest/hash.json',
}
const META_FILE = 'scans/latest/meta.json'
const DONE_FILE = 'scans/latest/done.json'
const HISTORY_FILE = 'scans/history.json'

const checks: { [K in StepId]: Check<unknown> } = {
  volume: RawVolumeCheck,
  walk: RawWalkCheck,
  devcaches: RawDevCachesCheck,
  leftovers: RawLeftoversCheck,
  windows: RawWindowsCheck,
  hash: RawHashCheck,
}

export type LoadedScan = {
  meta: ScanMeta
  volume: RawVolume | null
  walk: RawWalk | null
  devcaches: RawDevCaches | null
  leftovers: RawLeftovers | null
  windows: RawWindows | null
  hash: RawHash | null
  done: Set<string>
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

export type ScanOutcome = { status: 'ok'; scan: LoadedScan } | { status: 'refused'; message: string }

const isRetryable = (n: NotChecked | null): boolean =>
  n !== null && (n.reason === 'timeout' || n.reason === 'failed' || n.reason === 'cancelled')

const toDcStep = (s: StepStatus): DcStep => ({
  id: s.id,
  label: s.label,
  state: s.state,
  durationMs: s.durationMs,
  detail: s.notChecked?.detail ?? null,
  isRetryable: isRetryable(s.notChecked) || (s.id === 'hash' && s.isTruncated),
  isTruncated: s.isTruncated,
})

/** Runs the deep scan, or only `only` (a retry, or continuing the duplicate search), merging into the latest scan. */
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
  const settings = await loadSettings($)

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
    await update($, progressAtom, () => ({
      scanId,
      state,
      startedAt,
      finishedAt: state === 'running' ? null : Date.now(),
      steps: steps.map(toDcStep),
      message,
    }))
  }

  if (only === undefined) await writeDataFile($, DONE_FILE, '[]')
  await publish('running', 'Starting… The walk of the drive takes a few minutes.')
  $.ui.status('Drive Cleanup: scanning (read-only)…')
  void $.ui.open({ id: PANE_ID, title: 'Drive Cleanup' }).catch(() => undefined)

  try {
    for (const step of steps) {
      if (only !== undefined && step.id !== only) continue
      if (isCancelRequested) {
        step.state = 'not_checked'
        step.notChecked = { status: 'not_checked', reason: 'cancelled', detail: 'Cancelled before it started.' }
        continue
      }
      let params: Record<string, string> = {}
      let previousHash: RawHash | null = null
      if (step.id === 'hash') {
        if (!settings.duplicatesEnabled) {
          step.state = 'not_checked'
          step.notChecked = {
            status: 'not_checked',
            reason: 'disabled',
            detail: 'Off. It reads file contents, so only you can turn it on (pane: Settings).',
          }
          continue
        }
        previousHash = only === 'hash' && previous?.hash?.isTruncated === true ? previous.hash : null
        params = {
          DC_MIN_BYTES: String(settings.minDuplicateBytes),
          DC_MAX_BYTES: String(settings.maxHashBytes),
          DC_RESUME_BELOW: String(Math.floor(previousHash?.resumeBelowBytes ?? 0)),
        }
      }
      step.state = 'running'
      await publish('running', `${step.label}…`)
      const t0 = Date.now()
      const ran = await runScript($, step.id, params)
      const parsed = ran.status === 'ok' ? parseOutput(checks[step.id], ran.stdout, `${step.id}.ps1`) : ran
      step.durationMs = Date.now() - t0
      if (parsed.status === 'ok') {
        let data = parsed.data
        let text = ran.status === 'ok' ? ran.stdout : ''
        if (step.id === 'hash' && previousHash !== null) {
          data = mergeHash(previousHash, data as RawHash)
          text = JSON.stringify(data)
        }
        const written = await writeDataFile($, RAW_FILE[step.id], text)
        if (written.status !== 'written') {
          step.state = 'not_checked'
          step.notChecked = { status: 'not_checked', reason: 'failed', detail: `Measured but not saved: ${written.detail}` }
        } else {
          step.state = 'ok'
          step.notChecked = null
          step.isTruncated = isTruncatedOutput(data)
        }
      } else {
        step.state = 'not_checked'
        step.notChecked = parsed
      }
    }
  } finally {
    $.ui.status(undefined)
  }

  const meta: ScanMeta = {
    scanId,
    createdAt,
    finishedAt: new Date().toISOString(),
    steps,
    isPcGuardianInstalled: await detectPcGuardian($),
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
  await refreshSummary($, scan)
  const ok = steps.filter(s => s.state === 'ok').length
  await publish(
    cancelled ? 'cancelled' : ok === 0 ? 'failed' : 'done',
    cancelled
      ? 'Cancelled. What finished is kept.'
      : `Done in ${String(Math.round((Date.now() - startedAt) / 1000))} s: ${String(ok)} of ${String(steps.length)} steps measured.`,
  )
  return { status: 'ok', scan }
}

function isTruncatedOutput(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const d = data as { isTruncated?: unknown; items?: unknown; caches?: unknown; folders?: unknown }
  if (d.isTruncated === true) return true
  for (const list of [d.items, d.caches, d.folders]) {
    if (Array.isArray(list) && list.some(it => (it as { isTruncated?: unknown }).isTruncated === true)) return true
  }
  return false
}

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

/** Forgets the cached scan, so the next read sees new files (after a cleanup). */
export function invalidateScan(): void {
  cached = undefined
}

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
    typeof v.finishedAt === 'string' &&
    typeof v.dataFolder === 'string' &&
    typeof v.isPcGuardianInstalled === 'boolean' &&
    Array.isArray(v.steps)
  )
}

async function readDone($: EngineInterface): Promise<Set<string>> {
  const text = await readDataFile($, DONE_FILE)
  if (text === undefined) return new Set()
  try {
    const list: unknown = JSON.parse(text)
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Records finding ids that a cleanup handled, so they leave the lists. */
export async function markDone($: EngineInterface, ids: readonly string[]): Promise<void> {
  const done = await readDone($)
  for (const id of ids) done.add(id)
  await writeDataFile($, DONE_FILE, JSON.stringify([...done]))
  cached = undefined
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
  const devcaches = await readRaw<RawDevCaches>($, 'devcaches', meta)
  const leftovers = await readRaw<RawLeftovers>($, 'leftovers', meta)
  const windows = await readRaw<RawWindows>($, 'windows', meta)
  const hash = await readRaw<RawHash>($, 'hash', meta)
  const done = await readDone($)
  const ctx = contextOf(meta, volume)
  const scan: LoadedScan = {
    meta,
    volume,
    walk,
    devcaches,
    leftovers,
    windows,
    hash,
    done,
    ctx,
    classified: classifyScan({ walk, windows, devcaches, leftovers, hash, done }, ctx),
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
    isPartial: scan.meta.steps.some(s => (s.state !== 'ok' && s.notChecked?.reason !== 'disabled') || s.isTruncated),
    lastAuditFolder,
  }
}

export async function refreshSummary($: EngineInterface, scan: LoadedScan, lastAuditFolder?: string): Promise<void> {
  await update($, summaryAtom, current => summaryOf(scan, lastAuditFolder ?? current?.lastAuditFolder ?? null))
}

export async function setLastAuditFolder($: EngineInterface, folder: string): Promise<void> {
  await update($, summaryAtom, current => (current === null ? null : { ...current, lastAuditFolder: folder }))
}

type HistoryEntry = { scanId: string; createdAt: string; freeBytes: number | null; safeBytes: number; reviewBytes: number }

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
