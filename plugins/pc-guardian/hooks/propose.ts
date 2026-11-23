import type { EngineInterface } from 'claude-code'
import { isCleanupAllowed, runSummary, sizeText, type CleanupItem } from './deps.js'
import { previewCleanup, runCleanup } from './cleanup.ts'
import { loadSettings, saveSettings } from './settings-store.ts'

// Claude's cleanup proposal (decisions #33, as extended for Drive Cleanup's
// one-confirm flow, plugins/drive-cleanup/PLAN.md §19). Claude names kinds;
// PC Guardian measures them afresh, asks the person ONE plain question in
// Claude Code's own dialog, and cleans only on their yes, through runCleanup,
// the same checked path the pane and the dashboard use. A dismissed dialog, or
// a `-p` run with no one to ask, cleans nothing. Startup apps are only ever
// the suggested ones, and only when Claude names them.

export const PROPOSE_TOOL = 'propose_cleanup'
const KINDS = ['temp', 'recycle_bin', 'browser_cache', 'startup'] as const
type Kind = (typeof KINDS)[number]
const DECLINE_COOLDOWN_MS = 5 * 60_000

export const PROPOSE_SPEC = {
  description:
    "Proposes a PC Guardian cleanup and asks the person ONCE, in Claude Code's own dialog, with the sizes measured now: Free N GB, or Not now. Nothing changes unless they answer yes; when cleanup is off, that yes also turns it on. kinds: temp (Temp files unchanged for 7 days), recycle_bin (empties it for good), browser_cache (closed browsers only), startup (turns off the startup apps PC Guardian suggests; they can be turned back on). Default: temp and browser_cache. Report the result exactly as returned; if the person declines, do not propose again unless they ask.",
  inputSchema: {
    type: 'object',
    properties: { kinds: { type: 'array', items: { type: 'string', enum: KINDS } } },
    additionalProperties: false,
  },
}

let declinedAt = Number.NEGATIVE_INFINITY

const LINE: Record<Kind, (items: readonly CleanupItem[], bytes: number) => string> = {
  temp: (_, bytes) => `• Delete ${sizeText(bytes)} of old temporary files. Apps rebuild these.`,
  recycle_bin: (items, bytes) =>
    `• Empty the Recycle Bin (${sizeText(bytes)}${items[0]?.target?.itemCount === undefined ? '' : `, ${String(items[0].target.itemCount)} items`}). Those files are gone for good.`,
  browser_cache: (items, bytes) =>
    `• Clear ${sizeText(bytes)} of browser caches (${items.map(i => i.label).join(', ')}). Sites load a little slower at first.`,
  startup: items =>
    `• Stop ${String(items.length)} apps starting with Windows (${items.map(i => i.label).join(', ')}). You can turn them back on.`,
}

function parseKinds(call: Readonly<Record<string, unknown>>): Kind[] | string {
  const v = call.kinds
  if (v === undefined) return ['temp', 'browser_cache']
  if (!Array.isArray(v) || v.length === 0 || !v.every(k => (KINDS as readonly unknown[]).includes(k))) {
    return `kinds must be a list of: ${KINDS.join(', ')}.`
  }
  return KINDS.filter(k => v.includes(k))
}

/** Answers propose_cleanup. Every answer is text. */
export async function proposeCleanup(
  $: EngineInterface,
  call: Readonly<Record<string, unknown>>,
): Promise<{ result: string }> {
  const kinds = parseKinds(call)
  if (typeof kinds === 'string') return { result: `Invalid input: ${kinds}` }
  if (Date.now() - declinedAt < DECLINE_COOLDOWN_MS) {
    return { result: 'The person declined a cleanup a few minutes ago. Do not propose again unless they ask.' }
  }
  const previewed = await previewCleanup($)
  if (previewed.status !== 'ok') return { result: previewed.message }
  const preview = previewed.preview
  const ready: CleanupItem[] = preview.items.filter(
    (i: CleanupItem) =>
      i.unavailable === null && (kinds as string[]).includes(i.kind) && (i.kind !== 'startup' || i.isSuggested),
  )
  if (ready.length === 0) {
    const why = preview.items
      .filter((i: CleanupItem) => (kinds as string[]).includes(i.kind) && i.unavailable !== null)
      .map((i: CleanupItem) => `${i.label}: ${i.unavailable}`)
    return { result: `Nothing of that can be cleaned right now.${why.length > 0 ? ` ${why.join('; ')}.` : ''}` }
  }
  const total = ready.reduce((sum, i) => sum + (i.bytes ?? 0), 0)
  const lines = [total > 0 ? `Free up about ${sizeText(total)}?` : 'Run this cleanup?']
  for (const kind of kinds) {
    const items = ready.filter(i => i.kind === kind)
    if (items.length > 0)
      lines.push(
        LINE[kind](
          items,
          items.reduce((s, i) => s + (i.bytes ?? 0), 0),
        ),
      )
  }
  const { settings } = await loadSettings($)
  const isOn = isCleanupAllowed(settings)
  if (!isOn) lines.push('Cleanup is turned off now; this answer also turns it on.')
  const yes = total > 0 ? `Free ${sizeText(total)}` : 'Clean up'
  let answer = ''
  try {
    answer = await $.ui.ask(lines.join('\n'), { header: 'PC Guardian', options: [yes, 'Not now'] })
  } catch {
    answer = ''
  }
  if (answer !== yes) {
    declinedAt = Date.now()
    return { result: 'The person did not approve. Nothing was changed.' }
  }
  if (!isOn) {
    const saved = await saveSettings($, { ...settings, allowCleanup: true })
    if (!saved.isSaved) return { result: `Nothing was changed: ${saved.detail}` }
  }
  // origin 'pane': approved in Claude Code's own dialog, as the pane's Clean up is.
  const outcome = await runCleanup($, { previewId: preview.id, itemIds: ready.map(i => i.id), origin: 'pane' })
  if (outcome.status !== 'ok') return { result: outcome.message }
  const turnedOff = ready.some(i => i.kind === 'startup')
  return {
    result: `Done: ${runSummary(outcome.run)}${turnedOff ? ' Startup apps turned off can be turned back on from the PC Guardian dashboard (Cleanup page).' : ''}`,
  }
}
