import type { EngineInterface } from 'claude-code'
import { DEFAULT_SETTINGS, type Settings } from './core/types.ts'
import { readDataFile, writeDataFile } from './safe-writer.ts'

// Settings live in the data folder (settings.json). Only the pane's buttons,
// which only the person can press, change them; no tool does.

const FILE = 'settings.json'

const int = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback

export function parseSettings(text: string | undefined): Settings {
  if (text === undefined) return DEFAULT_SETTINGS
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return DEFAULT_SETTINGS
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS
  const r = raw as Record<string, unknown>
  return {
    cleanupEnabled: r.cleanupEnabled === true,
    duplicatesEnabled: r.duplicatesEnabled === true,
    quarantineDrive:
      typeof r.quarantineDrive === 'string' && /^(auto|[A-Z]:)$/.test(r.quarantineDrive) ? r.quarantineDrive : 'auto',
    minDuplicateBytes: int(r.minDuplicateBytes, 1024, 1024 ** 3, DEFAULT_SETTINGS.minDuplicateBytes),
    maxHashBytes: int(r.maxHashBytes, 1024 ** 2, 64 * 1024 ** 3, DEFAULT_SETTINGS.maxHashBytes),
  }
}

export async function loadSettings($: EngineInterface): Promise<Settings> {
  return parseSettings(await readDataFile($, FILE))
}

export async function saveSettings($: EngineInterface, change: (s: Settings) => Settings): Promise<Settings> {
  const next = change(await loadSettings($))
  await writeDataFile($, FILE, JSON.stringify(next))
  return next
}
