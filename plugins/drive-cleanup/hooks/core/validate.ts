// Strict validation of what each scan script prints. A script's output is
// trusted only after it passes: unknown keys, wrong types, negative sizes or
// oversized lists fail the whole step, which is then "Not checked".

import type {
  CandidateKind,
  ItemResult,
  RawApply,
  RawCacheClean,
  RawDevCaches,
  RawHash,
  RawLeftovers,
  RawPurge,
  RawVerify,
  Parsed,
  RawCandidate,
  RawDrive,
  RawFile,
  RawVolume,
  RawWalk,
  RawWindows,
  RawWindowsItem,
  WindowsItemId,
  RawElevated,
  RawElevatedLaunch,
} from './types.ts'
import { CANDIDATE_KINDS } from './types.ts'

export class ValidationError extends Error {}

export type Check<T> = (value: unknown, at: string) => T

const fail = (at: string, what: string): never => {
  throw new ValidationError(`${at}: ${what}`)
}

export const str: Check<string> = (v, at) =>
  typeof v === 'string' && v.length <= 32_767 ? v : fail(at, 'expected a string')

export const num: Check<number> = (v, at) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail(at, 'expected a number ≥ 0')

export const int: Check<number> = (v, at) =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail(at, 'expected an integer ≥ 0')

export const bool: Check<boolean> = (v, at) => (typeof v === 'boolean' ? v : fail(at, 'expected true or false'))

export const isoTime: Check<string> = (v, at) => {
  const text = str(v, at)
  return Number.isNaN(Date.parse(text)) ? fail(at, 'expected a time') : text
}

export const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (v, at) =>
    v === null || v === undefined ? null : check(v, at)

export const oneOf =
  <T extends string>(values: readonly T[]): Check<T> =>
  (v, at) =>
    typeof v === 'string' && (values as readonly string[]).includes(v)
      ? (v as T)
      : fail(at, `expected one of ${values.join(', ')}`)

/** PowerShell 5.1 prints a one-item array as the item itself, and none as null. */
export const list =
  <T>(check: Check<T>, max: number): Check<T[]> =>
  (v, at) => {
    const items = v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]
    if (items.length > max) fail(at, `more than ${String(max)} items`)
    return items.map((item, i) => check(item, `${at}[${String(i)}]`))
  }

type Shape = Record<string, Check<unknown>>
type Out<S extends Shape> = { [K in keyof S]: S[K] extends Check<infer T> ? T : never }

export const obj =
  <S extends Shape>(shape: S): Check<Out<S>> =>
  (v, at) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(at, 'expected an object')
    const record = v as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!(key in shape)) fail(at, `unexpected key "${key}"`)
    }
    const out: Record<string, unknown> = {}
    for (const [key, check] of Object.entries(shape)) out[key] = check(record[key], `${at}.${key}`)
    return out as Out<S>
  }

/** Parses a script's stdout with a check; a failure says which script and where. */
export function parseOutput<T>(check: Check<T>, stdout: string, file: string): Parsed<T> {
  let json: unknown
  try {
    json = JSON.parse(stdout.replace(/^﻿/, '').trim())
  } catch {
    return { status: 'not_checked', reason: 'failed', detail: `${file} did not print JSON.` }
  }
  try {
    return { status: 'ok', data: check(json, file) }
  } catch (error) {
    const detail = error instanceof ValidationError ? error.message : 'unexpected output'
    return {
      status: 'not_checked',
      reason: 'failed',
      detail: `${file} printed output Drive Cleanup does not accept (${detail}).`,
    }
  }
}

// ------------------------------------------------------------------ schemas

const drive: Check<RawDrive> = obj({
  letter: str,
  label: (v, at) => nullable(str)(v, at) ?? '',
  fileSystem: (v, at) => nullable(str)(v, at) ?? '',
  totalBytes: num,
  freeBytes: num,
  isSystem: bool,
  mediaType: nullable(int),
  isExternal: nullable(bool),
  healthStatus: nullable(str),
})

export const RawVolumeCheck: Check<RawVolume> = obj({
  isElevated: bool,
  windowsVersion: str,
  systemDrive: str,
  systemRoot: str,
  userProfile: str,
  profilesRoot: str,
  appData: str,
  localAppData: str,
  temp: str,
  downloads: str,
  drives: list(drive, 64),
  storageSense: obj({ isEnabled: nullable(bool), cadenceDays: nullable(int) }),
  lastAccess: obj({ isUpdated: nullable(bool), rawValue: nullable(num) }),
})

const countBytes = obj({ count: int, bytes: num })

const file: Check<RawFile> = obj({
  path: str,
  bytes: num,
  modifiedUtc: isoTime,
  accessedUtc: isoTime,
  createdUtc: isoTime,
  inProject: bool,
})

const candidateKind: Check<CandidateKind> = oneOf(CANDIDATE_KINDS)

const candidate: Check<RawCandidate> = obj({
  kind: candidateKind,
  path: str,
  bytes: num,
  fileCount: int,
  isFolder: bool,
  modifiedUtc: isoTime,
  accessedUtc: isoTime,
  createdUtc: isoTime,
  inProject: bool,
  extractedFolder: nullable(str),
})

/** Caps: what the script itself keeps, with room to spare. */
export const WALK_LIMITS = {
  largest: 100,
  candidatesPerKind: 1000,
  folders: 1500,
  extensions: 40,
  samples: 200,
  protectedRoots: 64,
} as const

export const RawWalkCheck: Check<RawWalk> = obj({
  root: str,
  elapsedMs: num,
  isTruncated: bool,
  entryCount: int,
  deniedFolders: int,
  deniedSample: list(str, WALK_LIMITS.samples),
  nodeModules: list(obj({ path: str, bytes: num, fileCount: int, modifiedUtc: isoTime }), 200),
  longPathFolders: int,
  longPathSample: list(str, WALK_LIMITS.samples),
  linkedFolders: int,
  linkedSample: list(str, WALK_LIMITS.samples),
  totals: obj({ fileCount: int, folderCount: int, bytes: num }),
  protectedRoots: list(obj({ path: str, bytes: num, fileCount: int }), WALK_LIMITS.protectedRoots),
  ages: obj({ modifiedOver12m: countBytes, accessedOver6m: countBytes }),
  extensions: list(obj({ extension: str, fileCount: int, bytes: num }), WALK_LIMITS.extensions),
  folders: list(obj({ path: str, depth: int, bytes: num, fileCount: int }), WALK_LIMITS.folders),
  largest: list(file, WALK_LIMITS.largest),
  candidates: list(candidate, WALK_LIMITS.candidatesPerKind * CANDIDATE_KINDS.length),
  candidateTotals: list(obj({ kind: candidateKind, count: int, bytes: num, isCapped: bool }), CANDIDATE_KINDS.length),
  userTemp: obj({ fileCount: int, bytes: num, oldCount: int, oldBytes: num }),
  projectRootCount: int,
  projectRootSample: list(str, WALK_LIMITS.samples),
})

const WINDOWS_ITEM_IDS: readonly WindowsItemId[] = [
  'update_cache',
  'windows_old',
  'windows_temp',
  'minidump',
  'memory_dmp',
  'live_kernel_reports',
  'hiberfil',
  'pagefile',
  'swapfile',
  'recycle_bin',
]

const windowsItem: Check<RawWindowsItem> = obj({
  id: oneOf(WINDOWS_ITEM_IDS),
  path: str,
  status: oneOf(['ok', 'missing', 'denied'] as const),
  bytes: num,
  fileCount: int,
  isTruncated: bool,
})

export const RawWindowsCheck: Check<RawWindows> = obj({
  isElevated: bool,
  items: list(windowsItem, 32),
  hibernation: obj({ isEnabled: nullable(bool) }),
  shadowStorage: obj({
    status: oneOf(['ok', 'not_checked'] as const),
    usedBytes: num,
    maxBytes: num,
    detail: str,
  }),
})

// ------------------------------------------------------------ M2–M5 output

export const RawDevCachesCheck: Check<RawDevCaches> = obj({
  caches: list(
    obj({
      id: str,
      isPresent: bool,
      bytes: num,
      fileCount: int,
      lastWriteUtc: nullable(isoTime),
      isRunning: bool,
      isTruncated: bool,
      roots: list(
        obj({ path: str, status: oneOf(['ok', 'missing', 'denied'] as const), bytes: num, fileCount: int }),
        // A browser has three cache folders per profile, and people have many profiles.
        192,
      ),
    }),
    64,
  ),
})

export const RawLeftoversCheck: Check<RawLeftovers> = obj({
  installedCount: int,
  folders: list(obj({ path: str, bytes: num, fileCount: int, lastWriteUtc: isoTime, isTruncated: bool }), 300),
})

const sha256: Check<string> = (v, at) => {
  const text = str(v, at)
  return /^[0-9a-f]{64}$/.test(text) ? text : fail(at, 'expected a SHA-256')
}

export const RawHashCheck: Check<RawHash> = obj({
  elapsedMs: num,
  isTruncated: bool,
  resumeBelowBytes: nullable(num),
  filesConsidered: int,
  filesHashed: int,
  bytesHashed: num,
  skippedLocked: int,
  skippedTooBig: nullable(int),
  skippedCloud: int,
  groups: list(
    obj({
      sha256,
      bytes: num,
      files: list(obj({ path: str, modifiedUtc: isoTime, accessedUtc: isoTime, createdUtc: isoTime }), 50),
    }),
    20_000,
  ),
  folderGroups: list(obj({ signature: sha256, bytes: num, fileCount: int, folders: list(str, 20) }), 5000),
})

export const RawVerifyCheck: Check<RawVerify> = obj({
  isElevated: bool,
  tools: list(obj({ id: str, status: oneOf(['ok', 'not_found', 'failed'] as const), version: str }), 16),
  projects: list(obj({ path: str, exists: bool, hasGit: bool }), 500),
  quarantine: list(
    obj({ runId: str, checked: int, matched: int, missing: int, mismatched: int, notHashed: nullable(int) }),
    500,
  ),
})

const refused = obj({ status: oneOf(['refused'] as const), reason: str, detail: str })

const itemResult: Check<ItemResult> = obj({
  id: str,
  status: oneOf(['deleted', 'quarantined', 'restored', 'skipped'] as const),
  detail: (v, at) => nullable(str)(v, at) ?? '',
  destination: nullable(str),
  sha256: nullable(sha256),
  bytes: num,
})

const applyOk = obj({
  status: oneOf(['ok'] as const),
  runId: str,
  quarantineDir: nullable(str),
  deletedBytes: num,
  quarantinedBytes: num,
  restoredBytes: (v, at) => nullable(num)(v, at) ?? 0,
  isTruncated: bool,
  items: list(itemResult, 100_000),
})

const either =
  <A, B>(ok: Check<A>, no: Check<B>): Check<A | B> =>
  (v, at) =>
    typeof v === 'object' && v !== null && (v as { status?: unknown }).status === 'refused' ? no(v, at) : ok(v, at)

export const RawApplyCheck: Check<RawApply> = either(applyOk, refused)

export const RawCacheCleanCheck: Check<RawCacheClean> = either(
  obj({
    status: oneOf(['ok'] as const),
    removedCount: int,
    removedBytes: num,
    skippedCount: int,
    isTruncated: nullable(bool),
  }),
  refused,
)

export const RawPurgeCheck: Check<RawPurge> = either(
  obj({ status: oneOf(['ok'] as const), runId: str, removedCount: int, removedBytes: num, failedCount: int }),
  refused,
)

export const RawElevatedCheck: Check<RawElevated> = either(
  obj({
    status: oneOf(['ok'] as const),
    tasks: list(
      obj({
        id: str,
        status: oneOf(['done', 'skipped', 'failed', 'missing'] as const),
        removedBytes: num,
        removedCount: int,
        skippedCount: int,
        detail: str,
      }),
      10,
    ),
  }),
  refused,
)

export const RawElevatedLaunchCheck: Check<RawElevatedLaunch> = either(
  obj({ status: oneOf(['ran'] as const), exitCode: int }),
  either(obj({ status: oneOf(['declined'] as const) }), obj({ status: oneOf(['failed'] as const) })),
)
