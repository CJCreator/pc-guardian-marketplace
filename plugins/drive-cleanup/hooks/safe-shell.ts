import type { EngineInterface } from 'claude-code'
import {
  ACTIONS,
  checkParams,
  normalizeScriptText,
  SCRIPTS,
  sha256Hex,
  type ActionId,
  type ScriptSpec,
} from './core/scripts.ts'
import {
  checkLaunch,
  encodeCommand,
  launcherScript,
  type ElevatedLaunch,
  type ElevatedTaskId,
} from './core/elevated.ts'
import type { NotChecked, RawElevated, ScriptRun, StepId } from './core/types.ts'
import { parseOutput, RawElevatedCheck, RawElevatedLaunchCheck } from './core/validate.ts'
import { dataFolder, readDataFile, writeDataFile } from './safe-writer.ts'
import { SCRIPT_HASHES } from './script-hashes.ts'

const utf8 = new TextEncoder()

const notChecked = (reason: NotChecked['reason'], detail: string): NotChecked => ({
  status: 'not_checked',
  reason,
  detail,
})

/**
 * Runs one read-only scan script by id. See runAllowlisted.
 */
export async function runScript(
  $: EngineInterface,
  id: StepId | 'verify',
  params: Readonly<Record<string, string>> = {},
): Promise<ScriptRun> {
  return await runAllowlisted($, SCRIPTS[id], params)
}

/**
 * Runs one action script (ps/actions/), the only scripts that change files.
 * Only hooks/cleanup.ts calls this, and only after the person approved in the
 * pane and confirmed in Claude Code's own dialog.
 */
export async function runAction(
  $: EngineInterface,
  id: ActionId,
  params: Readonly<Record<string, string>>,
): Promise<ScriptRun> {
  return await runAllowlisted($, ACTIONS[id], params)
}

export const ELEVATED_SCRIPT = 'actions/elevated.ps1'
/** DISM's component cleanup alone can take half an hour. */
const ELEVATED_TIMEOUT_MS = 45 * 60_000

export type ElevatedRun =
  | { status: 'ok'; result: Extract<RawElevated, { status: 'ok' }> }
  | { status: 'declined'; detail: string }
  | { status: 'failed'; detail: string }

/**
 * Runs the administrator tasks (PLAN.md §20). Only hooks/cleanup.ts calls
 * this, after the person answered yes to a cleanup that named these tasks;
 * Windows then asks them again (UAC). The command line is Windows PowerShell
 * from %SystemRoot% with an inline launcher built from fixed text, the task
 * ids, Drive Cleanup's own paths and the fingerprint compiled into the plugin
 * (core/elevated.ts). The elevated side checks elevated.ps1 against that
 * fingerprint itself and runs the checked text from memory.
 */
export async function runElevated(
  $: EngineInterface,
  tasks: readonly ElevatedTaskId[],
  runId: string,
): Promise<ElevatedRun> {
  const systemRoot = await $.env.get('SystemRoot')
  if (systemRoot === undefined) return { status: 'failed', detail: 'Windows was not detected (SystemRoot is not set).' }
  const expected = SCRIPT_HASHES[ELEVATED_SCRIPT]
  if (expected === undefined) return { status: 'failed', detail: 'elevated.ps1 has no recorded fingerprint.' }
  const scriptPath = `${$.plugin.root}\\ps\\actions\\elevated.ps1`
  // The same file the bootstrap will check, checked here too so a damaged install never reaches UAC.
  try {
    if ((await sha256Hex(normalizeScriptText(await $.fs.read(scriptPath)))) !== expected) {
      return {
        status: 'failed',
        detail: 'elevated.ps1 does not match its recorded fingerprint. Reinstall Drive Cleanup.',
      }
    }
  } catch {
    return { status: 'failed', detail: 'elevated.ps1 could not be read.' }
  }
  const folder = await dataFolder($)
  if (folder.status !== 'ok') return { status: 'failed', detail: folder.detail }
  // Creates the folder (checked for links by the safe writer) and records what was asked.
  const request = await writeDataFile($, `elevated/${runId}.request.json`, JSON.stringify({ runId, tasks }))
  if (request.status !== 'written') return { status: 'failed', detail: request.detail }

  const launch: ElevatedLaunch = {
    scriptPath,
    expectedSha256: expected,
    tasks,
    resultPath: `${folder.path}\\elevated\\${runId}.json`,
    powershellPath: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  }
  const refusal = checkLaunch(launch)
  if (refusal !== null) return { status: 'failed', detail: `Not started: ${refusal}.` }

  // process.run stops at ten minutes and DISM can take thirty: stream the
  // launcher instead, which ends when the elevated process does.
  const stdout = await runLong(
    $,
    [
      launch.powershellPath,
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodeCommand(launcherScript(launch)),
    ],
    ELEVATED_TIMEOUT_MS,
  )
  if (stdout === null) {
    return {
      status: 'failed',
      detail: `The administrator tasks did not finish within ${String(ELEVATED_TIMEOUT_MS / 60_000)} minutes. Windows may still be finishing them; scan again later to see the result.`,
    }
  }
  const ran = { stdout }
  const launched = parseOutput(RawElevatedLaunchCheck, ran.stdout, 'launcher')
  if (launched.status !== 'ok') return { status: 'failed', detail: `The launcher did not report: ${launched.detail}` }
  if (launched.data.status === 'declined')
    return { status: 'declined', detail: 'Windows did not get permission (the administrator prompt was declined).' }
  if (launched.data.status === 'failed')
    return { status: 'failed', detail: 'Windows could not start the administrator part.' }

  const text = await readDataFile($, `elevated/${runId}.json`)
  if (text === undefined) return { status: 'failed', detail: 'The administrator part ran but left no result.' }
  const parsed = parseOutput(RawElevatedCheck, text, 'elevated.ps1')
  if (parsed.status !== 'ok') return { status: 'failed', detail: parsed.detail }
  if (parsed.data.status === 'refused') return { status: 'failed', detail: parsed.data.detail }
  return { status: 'ok', result: parsed.data }
}

/** Runs `argv` to its end (up to `timeoutMs`) and returns its stdout, or null when it could not start or ran too long. */
async function runLong($: EngineInterface, argv: readonly string[], timeoutMs: number): Promise<string | null> {
  const child = $.process.spawn({ argv, env: {} })
  const stop = new AbortController()
  const collect = (async (): Promise<string | null> => {
    let out = ''
    try {
      for await (const piece of child) if (piece.stream === 'stdout') out += piece.text
    } catch {
      return null
    }
    return out
  })()
  const timeout = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(
    () => null,
    () => null,
  )
  const out = await Promise.race([collect, timeout])
  stop.abort()
  if (out === null) await child.return(undefined as never).catch(() => null)
  return out
}

/**
 * The only other place Drive Cleanup starts a process.
 *
 * It runs one allowlisted script from the plugin's `ps/` folder, and only after
 * the file's SHA-256 matches the hash recorded at build time. The command line
 * is fixed: Windows PowerShell from %SystemRoot%, no profile, no prompts, an
 * execution-policy bypass for this one call, `-File <script>`. It runs as the
 * current user, never elevated. Inputs are DC_* variables checked against the
 * script's own patterns.
 */
async function runAllowlisted(
  $: EngineInterface,
  spec: ScriptSpec,
  params: Readonly<Record<string, string>>,
): Promise<ScriptRun> {
  const checked = checkParams(spec, params)
  if (checked.status !== 'ok') return notChecked('failed', checked.detail)

  const systemRoot = await $.env.get('SystemRoot')
  if (systemRoot === undefined) {
    return notChecked('unsupported_platform', 'Windows was not detected (SystemRoot is not set).')
  }

  const scriptPath = `${$.plugin.root}\\ps\\${spec.file.replaceAll('/', '\\')}`
  const expected = SCRIPT_HASHES[spec.file]
  if (expected === undefined) {
    return notChecked('failed', `${spec.file} was not run: it has no recorded hash.`)
  }
  let text: string
  try {
    text = await $.fs.read(scriptPath)
  } catch {
    return notChecked('failed', `${spec.file} was not run: the file could not be read.`)
  }
  if ((await sha256Hex(normalizeScriptText(text))) !== expected) {
    return notChecked(
      'failed',
      `${spec.file} was not run: it does not match its recorded fingerprint (changed or damaged). Reinstall Drive Cleanup.`,
    )
  }

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
    ran = await $.process.run(argv, { timeoutMs: spec.timeoutMs, env: checked.env })
  } catch {
    return notChecked('timeout', `${spec.file} did not finish within ${String(spec.timeoutMs / 1000)} s.`)
  }
  if (ran.exitCode !== 0) {
    const reason =
      ran.stderr
        .split(/\r?\n/)
        .find(l => l.trim() !== '')
        ?.slice(0, 200) ?? ''
    return notChecked(
      'failed',
      `${spec.file} exited with code ${String(ran.exitCode)}${reason === '' ? '' : `: ${reason}`}.`,
    )
  }
  if (ran.isStdoutTruncated || utf8.encode(ran.stdout).length > spec.maxOutputBytes) {
    return notChecked(
      'failed',
      `${spec.file} returned more than ${String(Math.round(spec.maxOutputBytes / 1024))} KiB of output.`,
    )
  }
  return { status: 'ok', stdout: ran.stdout }
}
