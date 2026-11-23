import type { EngineInterface } from 'claude-code'
import { atom, read } from 'claude-code'
import {
  areaView,
  AREA_TOOLS,
  auditView,
  compareScans,
  comparisonView,
  EFFECT_TEXT,
  generateReport,
  healthScoreView,
  historyView,
  isCleanupAllowed,
  parseEnvironment,
  parseToolInput,
  recommendationsView,
  sizeText,
  StoredScanSchema,
  toolErrorText,
  toolText,
  type HistoryIndex,
  type StoredScan,
  type ToolError,
  type ToolName,
} from './deps.js'
import { performAudit } from './audit.ts'
import { previewCleanup } from './cleanup.ts'
import { openBrowserDashboard, type BrowserDashboard } from './dashboard.ts'
import { loadHistoryIndex, loadStoredScan } from './history-store.ts'
import { runScript } from './safe-shell.ts'
import { writeDataFile } from './safe-writer.ts'
import { loadSettings } from './settings-store.ts'

// The engine reads $.state keys statically, file by file: each file that
// reads or writes a value declares its atom itself. Every declaration of a
// key must match (a test checks): see ../types/index.d.ts for the contract.
const latestScanAtom = atom({ plugin: 'pc-guardian', key: 'latestScan' } as const, null, {
  shape: 'scan-1',
})

export const PANE_ID = 'pc-guardian'

type Answer = { result: string }

const answer = (summary: string, data: unknown): Answer => ({ result: toolText(summary, data) })
const fail = (code: ToolError['code'], message: string, suggestedAction: string, recoverable = true): Answer => ({
  result: toolErrorText({ code, message, recoverable, suggestedAction }),
})
const NO_SCAN = (): Answer => fail('not_found', 'There is no scan yet.', 'Run run_full_audit first.')

/** The session's latest scan, else the newest one in history. */
async function latestScan($: EngineInterface): Promise<StoredScan | undefined> {
  const inSession = StoredScanSchema.safeParse(await read($, latestScanAtom))
  if (inSession.success) return inSession.data
  const index = await loadHistoryIndex($)
  const newest = index.entries[0]
  return newest === undefined ? undefined : loadStoredScan($, newest)
}

/** A scan by id: the session's latest if it matches, else from history. */
async function scanById($: EngineInterface, id: string, index: HistoryIndex): Promise<StoredScan | undefined> {
  const inSession = StoredScanSchema.safeParse(await read($, latestScanAtom))
  if (inSession.success && inSession.data.snapshot.id === id) return inSession.data
  const entry = index.entries.find(e => e.id === id)
  return entry === undefined ? undefined : loadStoredScan($, entry)
}

async function selfCheck($: EngineInterface): Promise<Answer> {
  const ran = await runScript($, 'environment')
  const machine = ran.status === 'ok' ? parseEnvironment(ran.stdout) : ran
  if (machine.status === 'not_checked') {
    return fail(
      'collector_failed',
      `PC Guardian could not read this machine. Not checked (${machine.reason}): ${machine.detail}`,
      'Check that this is Windows 10 or 11 and that the plugin is installed completely.',
    )
  }
  const m = machine.data
  return answer(
    [
      'PC Guardian can read this machine.',
      `${m.osCaption} (build ${String(m.osBuild)}, ${m.is64Bit ? '64-bit' : '32-bit'}), display language ${m.uiCulture}.`,
      `Windows PowerShell ${m.psVersion}.`,
      m.isElevated
        ? 'Running elevated: checks that need administrator rights can run.'
        : 'Running as a standard user: checks that need administrator rights will be reported as "Not checked".',
      'Nothing on the machine was changed.',
    ].join('\n'),
    { machine: m },
  )
}

async function fullAudit(
  $: EngineInterface,
  call: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<Answer> {
  const parsed = parseToolInput('run_full_audit', call)
  if (parsed.status !== 'ok') return fail('invalid_input', parsed.message, 'Check the tool arguments.')
  const outcome = await performAudit($, {}, signal)
  if (outcome.status !== 'ok') return { result: toolErrorText(outcome.error) }
  const view = auditView(outcome.scan, outcome.history)
  return answer(view.summary, view.data)
}

async function area(
  $: EngineInterface,
  name: keyof typeof AREA_TOOLS,
  call: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<Answer> {
  const parsed = parseToolInput(name, call)
  if (parsed.status !== 'ok') return fail('invalid_input', parsed.message, 'Check the tool arguments.')
  const category = AREA_TOOLS[name]
  if (parsed.input.refresh !== true) {
    const scan = await latestScan($)
    if (scan !== undefined) {
      const view = areaView(scan, category, false)
      return answer(view.summary, view.data)
    }
  }
  const outcome = await performAudit($, { onlyCategory: category }, signal)
  if (outcome.status !== 'ok') return { result: toolErrorText(outcome.error) }
  const view = areaView(outcome.scan, category, true)
  return answer(view.summary, view.data)
}

async function healthScore($: EngineInterface, call: Readonly<Record<string, unknown>>): Promise<Answer> {
  const parsed = parseToolInput('get_health_score', call)
  if (parsed.status !== 'ok') return fail('invalid_input', parsed.message, 'Check the tool arguments.')
  const scan = await latestScan($)
  if (scan === undefined) return NO_SCAN()
  const view = healthScoreView(scan)
  return answer(view.summary, view.data)
}

async function recommendations($: EngineInterface, call: Readonly<Record<string, unknown>>): Promise<Answer> {
  const parsed = parseToolInput('get_recommendations', call)
  if (parsed.status !== 'ok') return fail('invalid_input', parsed.message, 'Check the tool arguments.')
  const scan = await latestScan($)
  if (scan === undefined) return NO_SCAN()
  const view = recommendationsView(scan, parsed.input)
  return answer(view.summary, view.data)
}

async function report($: EngineInterface, call: Readonly<Record<string, unknown>>): Promise<Answer> {
  const parsed = parseToolInput('generate_report', call)
  if (parsed.status !== 'ok') return fail('invalid_input', parsed.message, 'Check the tool arguments.')
  const index = await loadHistoryIndex($)
  const scan = parsed.input.scanId === undefined ? await latestScan($) : await scanById($, parsed.input.scanId, index)
  if (scan === undefined) {
    return parsed.input.scanId === undefined
      ? NO_SCAN()
      : fail('not_found', `No saved scan has the id ${parsed.input.scanId}.`, 'Use get_scan_history to list scans.')
  }
  const redact = parsed.input.redactPersonalPaths ?? true
  const generated = generateReport(
    {
      snapshot: scan.snapshot,
      score: scan.score,
      recommendations: scan.recommendations,
      history: index.entries
        .filter(e => e.createdAt < scan.snapshot.createdAt)
        .toReversed()
        .map(e => ({ createdAt: e.createdAt, overall: e.overall })),
      generatedAt: new Date().toISOString(),
      redactPersonalPaths: redact,
    },
    parsed.input.format,
  )
  if (generated.status !== 'ok')
    return answer(`PC Guardian: ${generated.detail}`, { status: 'unavailable', format: 'pdf' })

  const stamp = scan.snapshot.createdAt.replaceAll(/[:.]/g, '-')
  const file = `reports/pc-guardian-${stamp}-${scan.snapshot.id.slice(0, 8)}.${generated.fileExtension}`
  const written = await writeDataFile($, file, generated.content)
  if (written.status !== 'written')
    return fail(
      'internal',
      `The report could not be saved: ${written.detail}`,
      'Check that %APPDATA% is a normal local folder.',
    )
  const notes = [
    `Report saved: ${written.path}`,
    !redact && scan.isRedacted
      ? 'Personal paths were already removed when this scan was saved to history, so they stay removed.'
      : '',
    redact ? 'Personal paths (user folders, account ids) were removed.' : '',
  ].filter(n => n !== '')
  return answer(notes.join('\n'), {
    path: written.path,
    format: generated.format,
    mediaType: generated.mediaType,
    bytes: generated.content.length,
  })
}

async function scanHistory($: EngineInterface, call: Readonly<Record<string, unknown>>): Promise<Answer> {
  const parsed = parseToolInput('get_scan_history', call)
  if (parsed.status !== 'ok') return fail('invalid_input', parsed.message, 'Check the tool arguments.')
  const view = historyView(await loadHistoryIndex($), parsed.input.offset, parsed.input.limit)
  return answer(view.summary, view.data)
}

async function compare($: EngineInterface, call: Readonly<Record<string, unknown>>): Promise<Answer> {
  const parsed = parseToolInput('compare_scans', call)
  if (parsed.status !== 'ok') return fail('invalid_input', parsed.message, 'Check the tool arguments.')
  const index = await loadHistoryIndex($)
  const toEntry =
    parsed.input.toScanId === undefined ? index.entries[0] : index.entries.find(e => e.id === parsed.input.toScanId)
  const toPosition = toEntry === undefined ? -1 : index.entries.indexOf(toEntry)
  const fromEntry =
    parsed.input.fromScanId === undefined
      ? index.entries[toPosition + 1]
      : index.entries.find(e => e.id === parsed.input.fromScanId)
  if (toEntry === undefined || fromEntry === undefined) {
    return fail('not_found', 'Comparing needs two saved scans.', 'Run run_full_audit again later, then compare.')
  }
  const [from, to] = await Promise.all([loadStoredScan($, fromEntry), loadStoredScan($, toEntry)])
  if (from === undefined || to === undefined) {
    return fail(
      'not_found',
      'One of the scans could not be read from history.',
      'Use get_scan_history to pick two scans.',
    )
  }
  const view = comparisonView(compareScans(from, to))
  return answer(view.summary, view.data)
}

async function openDashboard($: EngineInterface, call: Readonly<Record<string, unknown>>): Promise<Answer> {
  const parsed = parseToolInput('open_dashboard', call)
  if (parsed.status !== 'ok') return fail('invalid_input', parsed.message, 'Check the tool arguments.')
  const target = parsed.input.target ?? 'both'
  const lines: string[] = []
  const data: { pane?: { isPlaced: boolean }; browser?: BrowserDashboard } = {}

  if (target !== 'browser') {
    const opened = await $.ui.open({ id: PANE_ID, title: 'PC Guardian' })
    data.pane = { isPlaced: opened.isPlaced }
    lines.push(
      opened.isPlaced
        ? 'The PC Guardian dashboard is open beside the chat.'
        : 'The dashboard pane could not be shown here (the window may be too narrow). It opens when there is room.',
    )
  }
  if (target !== 'pane') {
    const browser = await openBrowserDashboard($)
    data.browser = browser
    lines.push(
      browser.status === 'ok'
        ? `Browser dashboard (this PC only; the link works once, within 5 minutes): ${browser.url}`
        : `Browser dashboard unavailable: ${browser.detail}`,
    )
  }
  return answer(lines.join('\n'), data)
}

/**
 * What cleanup could free now (decisions #33). Read-only; cleaning goes
 * through propose_cleanup (propose.ts), which asks the person.
 */
async function cleanupPreviewTool($: EngineInterface): Promise<Answer> {
  const { settings } = await loadSettings($)
  const outcome = await previewCleanup($)
  if (outcome.status !== 'ok') {
    return fail('collector_failed', outcome.message, 'Try again in a moment.')
  }
  const preview = outcome.preview
  const ready = preview.items.filter(i => i.unavailable === null)
  const freeable = ready.reduce((sum, i) => sum + (i.bytes ?? 0), 0)
  const isOn = isCleanupAllowed(settings)
  const lines = [
    `Cleanup could free about ${sizeText(freeable)} now, from ${String(ready.length)} item(s) that can be cleaned.`,
    ...preview.items.map(
      i =>
        `- ${i.label}: ${i.bytes === null ? '' : `${sizeText(i.bytes)}, `}${i.detail}. ${EFFECT_TEXT[i.effect]}.${i.unavailable === null ? '' : ` Not now: ${i.unavailable}`}`,
    ),
    ...preview.notes,
    isOn
      ? 'To clean, call propose_cleanup with the kinds you recommend: it asks the person once and cleans only on their yes. The person can also tick items on the dashboard (Cleanup page) or use Clean up in the pane.'
      : 'Cleanup is turned off. propose_cleanup asks the person, and their yes also turns it on; or they turn it on in the dashboard under Settings > Cleanup.',
    'Measuring changed nothing on the PC.',
  ]
  return answer(lines.join('\n'), { isCleanupOn: isOn, preview })
}

/** Answers one PC Guardian tool call. Every answer is text: a summary, then JSON. */
export async function answerTool(
  $: EngineInterface,
  name: ToolName,
  call: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<Answer> {
  switch (name) {
    case 'self_check':
      return await selfCheck($)
    case 'run_full_audit':
      return await fullAudit($, call, signal)
    case 'get_system_performance':
    case 'get_startup_apps':
    case 'get_storage_analysis':
    case 'get_browser_diagnostics':
    case 'get_security_status':
    case 'get_stability_status':
      return await area($, name, call, signal)
    case 'get_health_score':
      return await healthScore($, call)
    case 'get_recommendations':
      return await recommendations($, call)
    case 'generate_report':
      return await report($, call)
    case 'get_scan_history':
      return await scanHistory($, call)
    case 'compare_scans':
      return await compare($, call)
    case 'open_dashboard':
      return await openDashboard($, call)
    case 'get_cleanup_preview':
      return await cleanupPreviewTool($)
  }
}

/** What a tool call answers when its own handler failed unexpectedly. */
export const internalFailure = (): Answer =>
  fail(
    'internal',
    'PC Guardian failed unexpectedly. Nothing on the machine was changed.',
    'Try again; if it keeps failing, run Claude Code with --debug and report the log line.',
  )
