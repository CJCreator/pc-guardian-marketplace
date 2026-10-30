import type { EngineInterface } from 'claude-code'
import { atom, read } from 'claude-code'
import {
  CLEANUP_LOG_FILE,
  CleanupStateSchema,
  DASHBOARD_PROTOCOL_VERSION,
  DASHBOARD_ROUTES,
  IDLE_CLEANUP,
  parseCleanupLog,
  redactDeep,
  startupTurnedOff,
  StoredScanSchema,
  type DashboardState,
  type Notice,
} from './deps.js'
import { loadHistoryIndex, loadStoredScan, readDataJson } from './history-store.ts'
import { loadSettings } from './settings-store.ts'

// The engine reads $.state keys statically, file by file: each file that
// reads or writes a value declares its atom itself. Every declaration of a
// key must match (a test checks): see ../types/index.d.ts for the contract.
const progressAtom = atom({ plugin: 'pc-guardian', key: 'progress' } as const, null, {
  shape: 'progress-3',
})
const latestScanAtom = atom({ plugin: 'pc-guardian', key: 'latestScan' } as const, null, {
  shape: 'scan-1',
})
const cleanupAtom = atom({ plugin: 'pc-guardian', key: 'cleanup' } as const, null, {
  shape: 'cleanup-2',
})

/**
 * The running browser dashboard server, as its ready line named it. Module
 * state on purpose: the server is this module's child and dies with it on a
 * reload, so the link must not outlive the module either.
 */
let link: { port: number; modToken: string } | null = null

export const setDashboardLink = (next: { port: number; modToken: string } | null): void => {
  link = next
}

export const isDashboardRunning = (): boolean => link !== null

async function post(
  $: EngineInterface,
  route: string,
  body: unknown,
): Promise<{ ok: boolean; text: string }> {
  const current = link
  if (current === null) return { ok: false, text: '' }
  try {
    const reply = await $.http.fetch(`http://127.0.0.1:${String(current.port)}${route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${current.modToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    return { ok: reply.ok, text: reply.text }
  } catch {
    return { ok: false, text: '' }
  }
}

/**
 * Sends the dashboard everything its pages draw. Personal paths are removed
 * when the person's settings say so (the default); history is always stored
 * without them anyway.
 */
export async function pushState($: EngineInterface): Promise<void> {
  if (link === null) return
  const { settings, problem } = await loadSettings($)
  const index = await loadHistoryIndex($)
  const inSession = StoredScanSchema.safeParse(await read($, latestScanAtom))
  const cleanup = CleanupStateSchema.safeParse(await read($, cleanupAtom))
  const log = parseCleanupLog(await readDataJson($, CLEANUP_LOG_FILE))
  const newest = index.entries[0]
  const latest = inSession.success
    ? inSession.data
    : newest === undefined
      ? undefined
      : await loadStoredScan($, newest)
  const state: DashboardState = {
    protocolVersion: DASHBOARD_PROTOCOL_VERSION,
    updatedAt: new Date().toISOString(),
    settings,
    settingsProblem: problem,
    latest:
      latest === undefined
        ? null
        : settings.redactPersonalPaths
          ? { ...redactDeep(latest), isRedacted: true }
          : latest,
    history: index.entries,
    progress: await read($, progressAtom),
    cleanup: {
      ...(cleanup.success ? cleanup.data : IDLE_CLEANUP),
      recentRuns: log.runs.slice(0, 20),
      turnedOff: startupTurnedOff(log.runs),
    },
  }
  await post($, DASHBOARD_ROUTES.internalState, state)
}

/** Sends the live scan progress, as the pane shows it. */
export async function pushProgress($: EngineInterface): Promise<void> {
  if (link === null) return
  await post($, DASHBOARD_ROUTES.internalProgress, await read($, progressAtom))
}

export async function pushNotice($: EngineInterface, notice: Notice): Promise<void> {
  await post($, DASHBOARD_ROUTES.internalNotice, notice)
}

/** A one-time link that lets a browser in (it works once, within five minutes). */
export async function requestLaunchUrl($: EngineInterface): Promise<string | undefined> {
  const reply = await post($, DASHBOARD_ROUTES.internalLaunch, {})
  if (!reply.ok) return undefined
  try {
    const { url } = JSON.parse(reply.text) as { url?: unknown }
    return typeof url === 'string' ? url : undefined
  } catch {
    return undefined
  }
}
