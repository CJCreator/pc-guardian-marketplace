import type { EngineInterface } from 'claude-code'
import {
  ACTIONS,
  buildScriptEnv,
  judgeRuntime,
  normalizeScriptText,
  SCRIPT_HASHES,
  SCRIPTS,
  type ActionId,
  type CancelSignal,
  type ScriptId,
  type ScriptParams,
  type ScriptRun,
  type ScriptSpec,
  type ServerConfig,
} from './deps.js'
import { DASHBOARD_SERVER_SHA256, NODE_RUNTIME_SHA256 } from './dashboard-hash.ts'

export type RunScriptOptions = {
  params?: ScriptParams
  signal?: CancelSignal
}

const utf8 = new TextEncoder()

const notChecked = (reason: 'failed' | 'timeout' | 'unsupported_platform', detail: string): ScriptRun => ({
  status: 'not_checked',
  reason,
  detail,
})

/**
 * The only place PC Guardian starts a process.
 *
 * It runs one allowlisted script from the plugin's `ps/` folder, by id, and
 * only after the file's SHA-256 matches the hash recorded at build time. The
 * command line is fixed: Windows PowerShell from %SystemRoot%, no profile, no
 * prompts, an execution-policy bypass for this one call, `-File <script>`.
 * It runs as the current user, never elevated. The script's only inputs are
 * the `PCG_*` environment variables its schema allows; no caller text ever
 * reaches the command line.
 */
export async function runScript($: EngineInterface, id: ScriptId, options: RunScriptOptions = {}): Promise<ScriptRun> {
  return await runAllowlisted($, SCRIPTS[id], options)
}

/**
 * A cleanup action (decisions #33): one script from `ps/actions/`, the only
 * scripts that change the machine, run exactly like runScript (hash-checked,
 * fixed command line, inputs only as checked `PCG_*` variables). Only the
 * mod's cleanup module may call this (ESLint), and only for items the person
 * ticked and confirmed.
 */
export async function runAction($: EngineInterface, id: ActionId, params: ScriptParams): Promise<ScriptRun> {
  return await runAllowlisted($, ACTIONS[id], { params })
}

async function runAllowlisted($: EngineInterface, spec: ScriptSpec, options: RunScriptOptions): Promise<ScriptRun> {
  if (options.signal?.aborted === true) {
    return notChecked('failed', `${spec.file} was not run: the audit was cancelled.`)
  }

  const env = buildScriptEnv(spec, options.params)
  if (env.status !== 'ok') return env

  const systemRoot = await $.env.get('SystemRoot')
  if (systemRoot === undefined) {
    return notChecked('unsupported_platform', 'Windows was not detected (SystemRoot is not set).')
  }

  const scriptPath = `${$.plugin.root}\\ps\\${spec.file.replaceAll('/', '\\')}`
  const integrity = await verifyScript($, scriptPath, spec.file)
  if (integrity !== undefined) return integrity

  const argv = [
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ] as const

  let ran: Awaited<ReturnType<EngineInterface['process']['run']>>
  try {
    ran = await $.process.run(argv, { timeoutMs: spec.timeoutMs, env: env.env })
  } catch {
    return notChecked('timeout', `${spec.file} did not finish within ${String(spec.timeoutMs / 1000)} s.`)
  }

  if (ran.exitCode !== 0) {
    return notChecked('failed', `${spec.file} exited with code ${String(ran.exitCode)}.`)
  }
  if (ran.isStdoutTruncated || utf8.encode(ran.stdout).length > spec.maxOutputBytes) {
    return notChecked('failed', `${spec.file} returned more than ${String(spec.maxOutputBytes / 1024)} KiB of output.`)
  }
  return { status: 'ok', stdout: ran.stdout }
}

export type DashboardProcess = ReturnType<EngineInterface['process']['spawn']>

export type DashboardStart = { status: 'ok'; process: DashboardProcess } | { status: 'unavailable'; detail: string }

const MIN_NODE_MAJOR = 22

/**
 * The other process PC Guardian starts: the browser dashboard's server,
 * `<node> <plugin>\dashboard\server.mjs`, only after the file's SHA-256 matches
 * the build's, run by the bundled Node.js runtime once its hash matches too
 * (dashboardRuntime). Its configuration goes in on stdin. It binds 127.0.0.1
 * only, never writes a file and never runs anything (apps/dashboard-server,
 * and its tests). It ends when this session's mod unloads.
 */
export async function startDashboardServer($: EngineInterface, config: ServerConfig): Promise<DashboardStart> {
  if (DASHBOARD_SERVER_SHA256 === null) {
    return { status: 'unavailable', detail: 'This build of PC Guardian has no browser dashboard.' }
  }
  const serverPath = `${$.plugin.root}\\dashboard\\server.mjs`
  let text: string
  try {
    text = await $.fs.read(serverPath)
  } catch {
    return {
      status: 'unavailable',
      detail: 'The dashboard server file is missing. Reinstall the plugin.',
    }
  }
  if ((await sha256Hex(text)) !== DASHBOARD_SERVER_SHA256) {
    return {
      status: 'unavailable',
      detail:
        'The dashboard server does not match the version shipped with PC Guardian (integrity check failed). Reinstall the plugin.',
    }
  }

  const node = await dashboardRuntime($)
  if (node.status !== 'ok') return node

  return {
    status: 'ok',
    process: $.process.spawn({ argv: [node.path, serverPath], input: JSON.stringify(config) }),
  }
}

/**
 * The Node.js that runs the dashboard server (decisions #30): the one shipped
 * in the plugin's `runtime\` folder, once runtime.ps1 shows its SHA-256 is the
 * build's (the engine reads no file over 4 MiB, so the script hashes it); a
 * runtime that does not match is never run. Only a build or install without a
 * runtime falls back to Node.js 22+ from PATH.
 */
async function dashboardRuntime(
  $: EngineInterface,
): Promise<{ status: 'ok'; path: string } | { status: 'unavailable'; detail: string }> {
  if (NODE_RUNTIME_SHA256 !== null) {
    const check = await runScript($, 'runtime')
    if (check.status !== 'ok') {
      return {
        status: 'unavailable',
        detail: `The bundled Node.js runtime could not be checked: ${check.detail}`,
      }
    }
    const verdict = judgeRuntime(check.stdout, NODE_RUNTIME_SHA256)
    if (verdict.kind === 'verified') {
      return { status: 'ok', path: `${$.plugin.root}\\runtime\\node.exe` }
    }
    if (verdict.kind === 'refused') return { status: 'unavailable', detail: verdict.detail }
  }

  let version: Awaited<ReturnType<EngineInterface['process']['run']>>
  try {
    version = await $.process.run(['node', '--version'], { timeoutMs: 10_000 })
  } catch {
    return {
      status: 'unavailable',
      detail: `Node.js was not found. The browser dashboard needs Node.js ${String(MIN_NODE_MAJOR)} or later; the pane beside the chat works without it.`,
    }
  }
  const major = Number(/^v(\d+)\./.exec(version.stdout.trim())?.[1] ?? 0)
  if (version.exitCode !== 0 || major < MIN_NODE_MAJOR) {
    return {
      status: 'unavailable',
      detail: `The browser dashboard needs Node.js ${String(MIN_NODE_MAJOR)} or later (found ${version.stdout.trim() || 'none'}).`,
    }
  }
  return { status: 'ok', path: 'node' }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(text))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Refuses to run a script whose contents differ from what was built and reviewed. */
async function verifyScript($: EngineInterface, scriptPath: string, file: string): Promise<ScriptRun | undefined> {
  const expected = SCRIPT_HASHES[file]
  if (expected === undefined) {
    return notChecked('failed', `${file} was not run: it has no recorded hash.`)
  }

  let text: string
  try {
    text = await $.fs.read(scriptPath)
  } catch {
    return notChecked('failed', `${file} was not run: the script file is missing or unreadable.`)
  }

  if ((await sha256Hex(normalizeScriptText(text))) !== expected) {
    return notChecked(
      'failed',
      `${file} was not run: it does not match the version shipped with PC Guardian (integrity check failed). Reinstall the plugin.`,
    )
  }
  return undefined
}
