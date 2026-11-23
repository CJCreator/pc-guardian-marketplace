import type { EngineInterface } from 'claude-code'
import { parseSettings, SETTINGS_FILE, type Settings } from './deps.js'
import { readDataJson } from './history-store.ts'
import { writeDataFile } from './safe-writer.ts'

/**
 * The person's settings in %APPDATA%\pc-guardian-ai\settings\settings.json.
 * A missing or unreadable file means the defaults; it never blocks a scan.
 */
export async function loadSettings($: EngineInterface): Promise<{ settings: Settings; problem: string | null }> {
  return parseSettings(await readDataJson($, SETTINGS_FILE))
}

export async function saveSettings(
  $: EngineInterface,
  settings: Settings,
): Promise<{ isSaved: boolean; detail: string }> {
  const written = await writeDataFile($, SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`)
  return written.status === 'written'
    ? { isSaved: true, detail: 'Settings saved.' }
    : { isSaved: false, detail: `Settings could not be saved: ${written.detail}` }
}
