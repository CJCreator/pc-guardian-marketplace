import type { EngineInterface } from 'claude-code'
import { loadSettings, saveSettings } from './settings-store.ts'

// The questions that turn a setting on. Only the person answers them, in
// Claude Code's own dialog: a dismissed dialog, or a `-p` session with no one
// to ask, leaves the setting off.

const DUPLICATES_QUESTION =
  'Turn on duplicate search? It READS THE CONTENTS of files in your profile to compare them (SHA-256), only on this PC; nothing is sent anywhere. It adds up to 10 minutes to a scan.'

const CLEANUP_QUESTION =
  'Turn on cleanup? Drive Cleanup will then be able to move the items you select to a restorable quarantine, and delete the re-creatable caches and temporary files you select. Nothing happens until you select items and confirm.'

async function askOn($: EngineInterface, question: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, { header: 'Drive Cleanup', options: ['Turn on', 'Cancel'] })) === 'Turn on'
  } catch {
    return false
  }
}

/** Duplicate search on: already on, or the person just said yes. */
export async function ensureDuplicatesOn($: EngineInterface): Promise<boolean> {
  if ((await loadSettings($)).duplicatesEnabled) return true
  if (!(await askOn($, DUPLICATES_QUESTION))) return false
  await saveSettings($, s => ({ ...s, duplicatesEnabled: true }))
  return true
}

/** Cleanup on: already on, or the person just said yes. */
export async function ensureCleanupOn($: EngineInterface): Promise<boolean> {
  if ((await loadSettings($)).cleanupEnabled) return true
  if (!(await askOn($, CLEANUP_QUESTION))) return false
  await saveSettings($, s => ({ ...s, cleanupEnabled: true }))
  return true
}
