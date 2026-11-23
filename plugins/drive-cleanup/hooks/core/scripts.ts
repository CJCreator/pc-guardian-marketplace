// The allowlist: the only scripts Drive Cleanup runs, each by id, each checked
// against the SHA-256 recorded in script-hashes.ts before it runs. Scan
// scripts only read. Action scripts (ps/actions/) are the only ones that change
// files; only hooks/cleanup.ts runs them, and only after the person approved.
//
// Inputs reach a script only as DC_* environment variables, each checked here
// against a strict pattern; no caller text reaches a command line.

import type { StepId } from './types.ts'

export type ParamRule = RegExp

export type ScriptSpec = {
  /** Path under the plugin's `ps/` folder, with forward slashes. */
  file: string
  timeoutMs: number
  maxOutputBytes: number
  params: Readonly<Record<string, ParamRule>>
}

const KiB = 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INT = /^\d{1,15}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$/
const QUARANTINE_ROOT = /^[A-Z]:\\Drive Cleanup Quarantine$/

export const SCRIPTS: Record<StepId | 'verify', ScriptSpec> = {
  volume: { file: 'scan/volume.ps1', timeoutMs: 60_000, maxOutputBytes: 256 * KiB, params: {} },
  // The walk stops itself after 240 s; the extra time is for its JSON output.
  walk: { file: 'scan/walk.ps1', timeoutMs: 360_000, maxOutputBytes: 4_000_000, params: {} },
  devcaches: { file: 'scan/dev-caches.ps1', timeoutMs: 420_000, maxOutputBytes: 256 * KiB, params: {} },
  leftovers: { file: 'scan/leftovers.ps1', timeoutMs: 300_000, maxOutputBytes: 512 * KiB, params: {} },
  windows: { file: 'scan/windows.ps1', timeoutMs: 240_000, maxOutputBytes: 64 * KiB, params: {} },
  hash: {
    file: 'scan/hash.ps1',
    timeoutMs: 590_000,
    maxOutputBytes: 4_000_000,
    params: { DC_MIN_BYTES: INT, DC_MAX_BYTES: INT, DC_RESUME_BELOW: INT },
  },
  verify: { file: 'scan/verify.ps1', timeoutMs: 590_000, maxOutputBytes: 512 * KiB, params: { DC_LIST_ID: UUID } },
}

export type ActionId = 'apply' | 'cleanCache' | 'restore' | 'purge'

export const ACTIONS: Record<ActionId, ScriptSpec> = {
  apply: { file: 'actions/apply.ps1', timeoutMs: 600_000, maxOutputBytes: 4_000_000, params: { DC_RUN_ID: UUID } },
  cleanCache: {
    file: 'actions/clean-cache.ps1',
    timeoutMs: 300_000,
    maxOutputBytes: 4 * KiB,
    params: { DC_CACHE_ID: /^[a-z_]{3,40}$/, DC_APPROVED_AT: ISO },
  },
  restore: {
    file: 'actions/restore.ps1',
    timeoutMs: 600_000,
    maxOutputBytes: 4_000_000,
    params: { DC_RUN_ID: UUID, DC_QUARANTINE_ROOT: QUARANTINE_ROOT, DC_LIST_ID: /^$|^[0-9a-f-]{36}$/ },
  },
  purge: {
    file: 'actions/purge.ps1',
    timeoutMs: 600_000,
    maxOutputBytes: 4 * KiB,
    params: { DC_RUN_ID: UUID, DC_QUARANTINE_ROOT: QUARANTINE_ROOT },
  },
}

/** Checks inputs against a spec: every declared one present and matching, nothing else. */
export function checkParams(
  spec: ScriptSpec,
  params: Readonly<Record<string, string>>,
): { status: 'ok'; env: Record<string, string> } | { status: 'refused'; detail: string } {
  for (const key of Object.keys(params)) {
    if (!(key in spec.params)) return { status: 'refused', detail: `${spec.file} takes no input ${key}.` }
  }
  const env: Record<string, string> = {}
  for (const [key, rule] of Object.entries(spec.params)) {
    const value = params[key]
    if (value === undefined || !rule.test(value)) {
      return { status: 'refused', detail: `${spec.file} was not run: input ${key} is missing or not valid.` }
    }
    env[key] = value
  }
  return { status: 'ok', env }
}

export const STEP_ORDER: readonly StepId[] = ['volume', 'walk', 'devcaches', 'leftovers', 'windows', 'hash']

export const STEP_LABEL: Record<StepId, string> = {
  volume: 'Drives and settings',
  walk: 'Walk of the drive',
  devcaches: 'Developer caches',
  leftovers: 'App leftovers',
  windows: 'Windows-managed space',
  hash: 'Duplicates (content)',
}

const BYTE_ORDER_MARK = '﻿'

/** The text a script's hash is taken over: no BOM, LF line ends. */
export function normalizeScriptText(text: string): string {
  return (text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text).replaceAll('\r\n', '\n')
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
