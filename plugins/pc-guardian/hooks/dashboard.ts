import type { EngineInterface } from 'claude-code'
import {
  DASHBOARD_PROTOCOL_VERSION,
  DEFAULT_DASHBOARD_PORT,
  lineSplitter,
  parseServerLine,
  type DashboardRequest,
} from './deps.js'
import { cancelActiveAudit, performAudit, recheckArea } from './audit.ts'
import { previewCleanup, restoreStartup, runCleanup, startCleanupRequest } from './cleanup.ts'
import { isDashboardRunning, pushNotice, pushState, requestLaunchUrl, setDashboardLink } from './dashboard-link.ts'
import { startDashboardServer, type DashboardProcess } from './safe-shell.ts'
import { saveSettings } from './settings-store.ts'

export type BrowserDashboard = { status: 'ok'; url: string } | { status: 'unavailable'; detail: string }

/** How long a starting server may take to say it is ready (well within a hook's budget). */
const READY_TIMEOUT_MS = 8_000

/** A start in progress, so two quick calls share one server. */
let starting: Promise<BrowserDashboard | undefined> | undefined

/**
 * Starts the browser dashboard's server if it is not running, and returns a
 * one-time link to it. The server is this module's child: it stops when the
 * session ends or the mod reloads.
 */
export async function openBrowserDashboard($: EngineInterface): Promise<BrowserDashboard> {
  if (!isDashboardRunning()) {
    starting ??= startServer($).finally(() => {
      starting = undefined
    })
    const failed = await starting
    if (failed !== undefined) return failed
  }
  const url = await requestLaunchUrl($)
  return url === undefined
    ? { status: 'unavailable', detail: 'The dashboard server did not answer. Try again.' }
    : { status: 'ok', url }
}

const noop = (): void => {}

/** Starts the server; undefined once it is ready, else why it is not. */
async function startServer($: EngineInterface): Promise<BrowserDashboard | undefined> {
  const appData = await $.env.get('APPDATA')
  if (appData === undefined) {
    return { status: 'unavailable', detail: 'APPDATA is not set, so there is no data folder.' }
  }
  const started = await startDashboardServer($, {
    protocolVersion: DASHBOARD_PROTOCOL_VERSION,
    appDir: `${$.plugin.root}\\dashboard\\app`,
    dataDir: `${appData}\\pc-guardian-ai`,
    preferredPort: DEFAULT_DASHBOARD_PORT,
  })
  if (started.status !== 'ok') return started

  let markReady: (isReady: boolean) => void = noop
  const ready = new Promise<boolean>(resolve => {
    markReady = resolve
  })
  const stderr = { text: '' }
  void listen($, started.process, markReady, stderr)

  const isReady = await Promise.race([ready, $.clock.sleep(READY_TIMEOUT_MS).then(() => false)])
  if (!isReady) {
    const why = stderr.text.trim().split(/\r?\n/).at(-1) ?? ''
    return {
      status: 'unavailable',
      detail: `The dashboard server did not start${why === '' ? '.' : `: ${why}`}`,
    }
  }
  await pushState($)
  return undefined
}

/**
 * Reads the server's stdout for the life of the server: its ready line, then
 * the browser's requests. Runs on after the hook that started it returns.
 */
async function listen(
  $: EngineInterface,
  child: DashboardProcess,
  markReady: (isReady: boolean) => void,
  stderr: { text: string },
): Promise<void> {
  const split = lineSplitter()
  try {
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        stderr.text = (stderr.text + text).slice(-2_000)
        continue
      }
      for (const line of split(text)) {
        const message = parseServerLine(line)
        if (message?.type === 'ready') {
          setDashboardLink({ port: message.port, modToken: message.modToken })
          markReady(true)
        } else if (message?.type === 'request') {
          void handleRequest($, message.request)
        }
      }
    }
  } catch {
    // The server could not start or its pipe broke; it is gone either way.
  } finally {
    setDashboardLink(null)
    markReady(false)
  }
}

/** Acts on what the browser asked for; every answer goes back as state or a notice. */
async function handleRequest($: EngineInterface, request: DashboardRequest): Promise<void> {
  switch (request.kind) {
    case 'scan': {
      const outcome = await performAudit($, {})
      if (outcome.status !== 'ok') {
        await pushNotice($, {
          level: outcome.error.code === 'cancelled' ? 'info' : 'warning',
          message: `${outcome.error.message} ${outcome.error.suggestedAction}`,
        })
      }
      return
    }
    case 'retry': {
      const outcome = await recheckArea($, request.category)
      if (outcome.status !== 'ok') {
        await pushNotice($, {
          level: outcome.error.code === 'cancelled' ? 'info' : 'warning',
          message: `${outcome.error.message} ${outcome.error.suggestedAction}`,
        })
      }
      return
    }
    case 'cancel':
      await pushNotice(
        $,
        cancelActiveAudit()
          ? { level: 'info', message: 'Cancelling: the scan stops before its next check.' }
          : { level: 'info', message: 'No scan is running.' },
      )
      return
    case 'settings': {
      const saved = await saveSettings($, request.settings)
      await pushState($)
      await pushNotice($, { level: saved.isSaved ? 'info' : 'error', message: saved.detail })
      return
    }
    // Cleanup (decisions #33). A clean comes from the person's click in the
    // dashboard (its session cookie, its own origin); runCleanup checks the rest.
    case 'cleanup_preview':
      startCleanupRequest($, () => previewCleanup($))
      return
    case 'cleanup': {
      const { previewId, itemIds } = request
      startCleanupRequest($, () => runCleanup($, { previewId, itemIds, origin: 'dashboard' }))
      return
    }
    case 'cleanup_restore': {
      const { startup } = request
      startCleanupRequest($, () => restoreStartup($, startup, 'dashboard'))
      break
    }
  }
}
