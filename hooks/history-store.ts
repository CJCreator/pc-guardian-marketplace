import type { EngineInterface } from 'claude-code'
import {
  CLEARED_SLOT,
  HISTORY_INDEX_FILE,
  parseHistoryIndex,
  historySlotFile,
  planHistoryReplace,
  planHistoryWrite,
  resolveDataPath,
  StoredScanSchema,
  type HistoryEntry,
  type HistoryIndex,
  type StoredScan,
} from './deps.js'
import { writeDataFile } from './safe-writer.ts'

/**
 * Scan history on disk, in %APPDATA%\pc-guardian-ai\history. Reads go
 * through resolveDataPath and are validated with zod; writes go through the
 * safe writer. The retention rules are planHistoryWrite's, in core.
 */

/** A JSON file in the data folder, or undefined when it is missing or unreadable. */
export async function readDataJson($: EngineInterface, relative: string): Promise<unknown> {
  const appData = await $.env.get('APPDATA')
  if (appData === undefined) return undefined
  const target = resolveDataPath(appData, relative)
  if (target.status !== 'ok') return undefined
  if (!(await $.fs.exists(target.path))) return undefined
  try {
    return JSON.parse(await $.fs.read(target.path)) as unknown
  } catch {
    return undefined
  }
}

/** The history index, or an empty one when there is none or it cannot be read. */
export async function loadHistoryIndex($: EngineInterface): Promise<HistoryIndex> {
  return parseHistoryIndex(await readDataJson($, HISTORY_INDEX_FILE))
}

export async function loadStoredScan(
  $: EngineInterface,
  entry: HistoryEntry,
): Promise<StoredScan | undefined> {
  const parsed = StoredScanSchema.safeParse(await readDataJson($, historySlotFile(entry.slot)))
  return parsed.success && parsed.data.snapshot.id === entry.id ? parsed.data : undefined
}

export type SaveResult = { isSaved: boolean; detail: string; index: HistoryIndex }

/**
 * Updates a saved scan in place (a re-checked area merged in): its own slot,
 * then the index. Undefined when the scan is not in history.
 */
export async function replaceScanInHistory(
  $: EngineInterface,
  scan: StoredScan,
): Promise<SaveResult | undefined> {
  const current = await loadHistoryIndex($)
  const plan = planHistoryReplace(current, scan)
  if (plan === undefined) return undefined
  const written = await writeDataFile($, historySlotFile(plan.slot), JSON.stringify(scan))
  if (written.status !== 'written')
    return { isSaved: false, detail: written.detail, index: current }
  const indexed = await writeDataFile($, HISTORY_INDEX_FILE, JSON.stringify(plan.index))
  if (indexed.status !== 'written')
    return { isSaved: false, detail: indexed.detail, index: current }
  return { isSaved: true, detail: written.path, index: plan.index }
}

/**
 * Saves a scan: its slot file first, then any slots that fell out of
 * retention are cleared, then the index, so the index only ever names
 * complete files.
 */
export async function saveScanToHistory(
  $: EngineInterface,
  scan: StoredScan,
  retention?: number,
): Promise<SaveResult> {
  const current = await loadHistoryIndex($)
  const plan = planHistoryWrite(current, scan, retention)

  const written = await writeDataFile($, historySlotFile(plan.slot), JSON.stringify(scan))
  if (written.status !== 'written')
    return { isSaved: false, detail: written.detail, index: current }

  for (const slot of plan.slotsToClear) {
    await writeDataFile($, historySlotFile(slot), JSON.stringify(CLEARED_SLOT))
  }
  const indexed = await writeDataFile($, HISTORY_INDEX_FILE, JSON.stringify(plan.index))
  if (indexed.status !== 'written')
    return { isSaved: false, detail: indexed.detail, index: current }
  return { isSaved: true, detail: written.path, index: plan.index }
}
