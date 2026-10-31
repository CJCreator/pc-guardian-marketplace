// The allowlist: the only scripts Drive Cleanup runs, each by id, each checked
// against the SHA-256 recorded in script-hashes.ts before it runs. M1 has
// read-only scan scripts only; there is no action script yet.

import type { StepId } from './types.ts'

export type ScriptSpec = {
  /** Path under the plugin's `ps/` folder, with forward slashes. */
  file: string
  timeoutMs: number
  maxOutputBytes: number
}

const KiB = 1024

export const SCRIPTS: Record<StepId, ScriptSpec> = {
  volume: { file: 'scan/volume.ps1', timeoutMs: 60_000, maxOutputBytes: 256 * KiB },
  // The walk stops itself after 240 s; the extra time is for its JSON output.
  walk: { file: 'scan/walk.ps1', timeoutMs: 360_000, maxOutputBytes: 4_000_000 },
  windows: { file: 'scan/windows.ps1', timeoutMs: 240_000, maxOutputBytes: 64 * KiB },
}

export const STEP_ORDER: readonly StepId[] = ['volume', 'walk', 'windows']

export const STEP_LABEL: Record<StepId, string> = {
  volume: 'Drives and settings',
  walk: 'Walk of the drive',
  windows: 'Windows-managed space',
}

const BYTE_ORDER_MARK = '﻿'

/** The text a script's hash is taken over: no BOM, LF line ends. */
export function normalizeScriptText(text: string): string {
  return (text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text).replace(/\r\n/g, '\n')
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
