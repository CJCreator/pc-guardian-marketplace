// Elevated cleanup (PLAN.md §20): the fixed tasks that need administrator
// rights, what the scan knows of their size, the line the person reads before
// answering, and the two PowerShell texts that start them. Pure, so every
// rule here is unit-tested.
//
// The chain: the person answers yes in Claude Code's dialog → hooks/elevate.ts
// runs Windows PowerShell with `launcherScript` (as the user) → it starts a
// second PowerShell with Start-Process -Verb RunAs, so WINDOWS asks the person
// (UAC) → that one runs `bootstrapScript` (elevated), which reads
// ps/actions/elevated.ps1, checks its SHA-256 against the value compiled into
// the plugin, and runs the checked text from memory. Neither text comes from a
// file a user-level program could swap, and nothing in them comes from Claude:
// only task ids from this list, paths from Drive Cleanup's own folders, and a
// run id.

import { sizeText } from './format.ts'
import type { RawWindows, WindowsItemId } from './types.ts'

export const ELEVATED_TASK_IDS = [
  'windows_temp',
  'memory_dumps',
  'windows_update_cache',
  'delivery_optimization',
  'component_store',
  'hibernation_reduce',
] as const

export type ElevatedTaskId = (typeof ELEVATED_TASK_IDS)[number]

export type ElevatedTaskSpec = {
  id: ElevatedTaskId
  label: string
  what: string
  /** Scan items whose bytes estimate what this frees; empty when the scan cannot tell. */
  measuredBy: readonly WindowsItemId[]
  /** True when it changes a Windows setting rather than deleting files. */
  isSetting: boolean
  undo: string
}

export const ELEVATED_TASKS: Record<ElevatedTaskId, ElevatedTaskSpec> = {
  windows_temp: {
    id: 'windows_temp',
    label: 'Windows Temp folder',
    what: 'Deletes files in C:\\Windows\\Temp not changed for 7 days; files in use are kept.',
    measuredBy: ['windows_temp'],
    isSetting: false,
    undo: 'Not needed: programs re-create what they need.',
  },
  memory_dumps: {
    id: 'memory_dumps',
    label: 'System memory dumps',
    what: 'Deletes MEMORY.DMP, Minidump and LiveKernelReports dump files.',
    measuredBy: ['memory_dmp', 'minidump', 'live_kernel_reports'],
    isSetting: false,
    undo: 'Cannot be undone; they only help diagnose a past crash.',
  },
  windows_update_cache: {
    id: 'windows_update_cache',
    label: 'Windows Update download cache',
    what: 'Pauses the Windows Update service, deletes SoftwareDistribution\\Download, starts the service again. Skipped while updates are installing.',
    measuredBy: ['update_cache'],
    isSetting: false,
    undo: 'Not needed: Windows downloads again what it still needs.',
  },
  delivery_optimization: {
    id: 'delivery_optimization',
    label: 'Delivery Optimization cache',
    what: "Runs Windows' own Delete-DeliveryOptimizationCache.",
    measuredBy: [],
    isSetting: false,
    undo: 'Not needed: Windows re-downloads when required.',
  },
  component_store: {
    id: 'component_store',
    label: 'Superseded Windows components',
    what: 'Runs DISM /Online /Cleanup-Image /StartComponentCleanup (no /ResetBase, so installed updates can still be uninstalled). Can take 10-30 minutes.',
    measuredBy: [],
    isSetting: false,
    undo: 'Not needed; superseded versions are not used.',
  },
  hibernation_reduce: {
    id: 'hibernation_reduce',
    label: 'Smaller hibernation file',
    what: 'Runs powercfg /hibernate /type reduced: Fast Startup keeps working; full hibernation is turned off.',
    measuredBy: ['hiberfil'],
    isSetting: true,
    undo: 'powercfg /hibernate /type full, in an administrator terminal.',
  },
}

/** Rough share of hiberfil.sys a reduced file frees (reduced is about 20 % of RAM, full about 40 %). */
const HIBERNATION_SHARE = 0.5

/** What the scan says a task would free, or null when it cannot tell. */
export function estimateBytes(task: ElevatedTaskId, windows: RawWindows | null): number | null {
  const spec = ELEVATED_TASKS[task]
  if (spec.measuredBy.length === 0 || windows === null) return null
  const items = spec.measuredBy.map(id => windows.items.find(i => i.id === id))
  if (items.every(i => i === undefined || i.status !== 'ok')) return null
  const bytes = items.reduce((s, i) => s + (i?.status === 'ok' ? i.bytes : 0), 0)
  return task === 'hibernation_reduce' ? Math.round(bytes * HIBERNATION_SHARE) : bytes
}

/** Validates task ids: known, no repeats, in the fixed order. */
export function checkTasks(
  ids: readonly string[],
): { status: 'ok'; tasks: ElevatedTaskId[] } | { status: 'refused'; message: string } {
  const unknown = ids.find(id => !(ELEVATED_TASK_IDS as readonly string[]).includes(id))
  if (unknown !== undefined)
    return { status: 'refused', message: `${unknown} is not an administrator task Drive Cleanup knows.` }
  return { status: 'ok', tasks: ELEVATED_TASK_IDS.filter(id => ids.includes(id)) }
}

/** The dialog's line for the administrator part of a proposal. */
export function elevatedSummary(tasks: readonly ElevatedTaskId[], windows: RawWindows | null): string {
  if (tasks.length === 0) return ''
  const parts = tasks.map(t => {
    const bytes = estimateBytes(t, windows)
    return `${ELEVATED_TASKS[t].label} (${bytes === null ? 'size known after' : `about ${sizeText(bytes)}`})${ELEVATED_TASKS[t].isSetting ? ', a setting' : ''}`
  })
  return `Needs administrator, so Windows will ask you once more: ${parts.join('; ')}.`
}

// ---------------------------------------------------------------- PowerShell

/** A path Drive Cleanup built itself: a drive, then no quote, control or wildcard characters. */
const SAFE_PATH = /^[A-Za-z]:\\[^'"`$\r\n\0*?<>|]+$/
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

export type ElevatedLaunch = {
  scriptPath: string
  expectedSha256: string
  tasks: readonly ElevatedTaskId[]
  resultPath: string
  powershellPath: string
}

const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`

/** Refuses anything that is not exactly what Drive Cleanup builds. */
export function checkLaunch(l: ElevatedLaunch): string | null {
  if (!SAFE_PATH.test(l.scriptPath) || !l.scriptPath.toLowerCase().endsWith('\\ps\\actions\\elevated.ps1'))
    return 'the elevated script path is not one Drive Cleanup builds'
  if (!SAFE_PATH.test(l.resultPath)) return 'the result path is not one Drive Cleanup builds'
  const name = l.resultPath.split('\\').at(-1) ?? ''
  if (!name.endsWith('.json') || !RUN_ID.test(name.slice(0, -5))) return 'the result file is not named by a run id'
  if (
    !SAFE_PATH.test(l.powershellPath) ||
    !l.powershellPath.toLowerCase().endsWith('\\windowspowershell\\v1.0\\powershell.exe')
  )
    return 'PowerShell is not the one in System32'
  if (!SHA256.test(l.expectedSha256)) return 'the fingerprint is not a SHA-256'
  const checked = checkTasks(l.tasks)
  if (checked.status !== 'ok' || l.tasks.length === 0) return 'no valid task'
  return null
}

/** Runs elevated: checks elevated.ps1 against its fingerprint, runs it from memory, writes the result file. */
export function bootstrapScript(l: ElevatedLaunch): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$scriptPath = ${quote(l.scriptPath)}`,
    `$expected = ${quote(l.expectedSha256)}`,
    `$tasks = @(${l.tasks.map(quote).join(', ')})`,
    `$resultPath = ${quote(l.resultPath)}`,
    '$utf8 = [Text.UTF8Encoding]::new($false)',
    'function Write-Result([string]$json) {',
    '  $d = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($resultPath))',
    '  while ($null -ne $d) {',
    "    if (($d.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A folder of the result path is a link.' }",
    '    $d = $d.Parent',
    '  }',
    '  $fs = [IO.File]::Open($resultPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)',
    '  try { $b = $utf8.GetBytes($json); $fs.Write($b, 0, $b.Length) } finally { $fs.Dispose() }',
    '}',
    'try {',
    '  $text = $utf8.GetString([IO.File]::ReadAllBytes($scriptPath))',
    '  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }',
    '  $text = $text.Replace("`r`n", "`n")',
    '  $sha = [Security.Cryptography.SHA256]::Create()',
    "  $hash = -join ($sha.ComputeHash($utf8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') })",
    '  if ($hash -ne $expected) {',
    `    Write-Result '{"status":"refused","reason":"fingerprint","detail":"elevated.ps1 does not match its recorded fingerprint. Reinstall Drive Cleanup."}'`,
    '    exit 0',
    '  }',
    '  $out = & ([ScriptBlock]::Create($text)) -Tasks $tasks',
    '  Write-Result ([string]$out)',
    '} catch {',
    "  $m = ([string]$_.Exception.Message).Replace('\\', '/').Replace('\"', \"'\").Replace(\"`r\", ' ').Replace(\"`n\", ' ')",
    '  try { Write-Result (\'{"status":"refused","reason":"failed","detail":"\' + $m.Substring(0, [Math]::Min(200, $m.Length)) + \'"}\') } catch { }',
    '}',
  ].join('\n')
}

/** PowerShell's -EncodedCommand form: base64 of UTF-16LE. */
export function encodeCommand(script: string): string {
  const bytes = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- -EncodedCommand is UTF-16LE: code units, not code points
    const c = script.charCodeAt(i)
    bytes[i * 2] = c & 0xff
    bytes[i * 2 + 1] = c >> 8
  }
  let binary = ''
  for (const b of bytes) binary += String.fromCodePoint(b)
  return btoa(binary)
}

/** Runs as the user: asks Windows to start the bootstrap elevated (UAC), waits, prints one JSON line. */
export function launcherScript(l: ElevatedLaunch): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    'try {',
    `  $p = Start-Process -FilePath ${quote(l.powershellPath)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${encodeCommand(bootstrapScript(l))}')`,
    '  \'{"status":"ran","exitCode":\' + [int]$p.ExitCode + \'}\'',
    '} catch {',
    '  $e = $_.Exception',
    '  while ($null -ne $e.InnerException -and -not ($e -is [ComponentModel.Win32Exception])) { $e = $e.InnerException }',
    '  if ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { \'{"status":"declined"}\' }',
    '  else { \'{"status":"failed"}\' }',
    '}',
  ].join('\n')
}
