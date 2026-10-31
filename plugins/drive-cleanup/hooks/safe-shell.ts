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
import type { NotChecked, ScriptRun, StepId } from './core/types.ts'
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
  return runAllowlisted($, SCRIPTS[id], params)
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
  return runAllowlisted($, ACTIONS[id], params)
}

/**
 * The only place Drive Cleanup starts a process.
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
    const reason = ran.stderr.split(/\r?\n/).find(l => l.trim() !== '')?.slice(0, 200) ?? ''
    return notChecked('failed', `${spec.file} exited with code ${String(ran.exitCode)}${reason === '' ? '' : `: ${reason}`}.`)
  }
  if (ran.isStdoutTruncated || utf8.encode(ran.stdout).length > spec.maxOutputBytes) {
    return notChecked(
      'failed',
      `${spec.file} returned more than ${String(Math.round(spec.maxOutputBytes / 1024))} KiB of output.`,
    )
  }
  return { status: 'ok', stdout: ran.stdout }
}
