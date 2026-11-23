// Phase 2 (PLAN.md §5): every candidate the walk found, and the Windows
// locations it measured, become findings in class A (safe), B (review) or
// C (protected), each with the rule and the evidence behind it.
//
// Pure: the same scan always classifies the same way, so findings are not
// stored; they are computed from the stored raw output when asked.

import { ageDays, ageText, sizeText, stableId } from './format.ts'
import { baseName, extensionOf, isInAppData, isUnder, normalizePath, parentPath, protectedBy } from './paths.ts'
import { DEV_CACHES } from './devcaches.ts'
import { duplicateFindings } from './duplicates.ts'
import type {
  CategoryId,
  CategoryTotal,
  ClassifyContext,
  Finding,
  FindingClass,
  RawCandidate,
  RawDevCaches,
  RawHash,
  RawLeftovers,
  RawWalk,
  RawWindows,
  RawWindowsItem,
} from './types.ts'

/** Thresholds (PLAN.md §11.1 defaults; Settings arrive in M4). */
export const THRESHOLDS = {
  tempDays: 7,
  logDays: 30,
  oldDownloadDays: 90,
  largeOldBytes: 500 * 1024 * 1024,
  largeOldDays: 365,
} as const

/** Folders named like these hold logs an app re-creates (PLAN.md §5.3). */
const LOG_VENDORS = new Set([
  'teams',
  'microsoft teams',
  'zoom',
  'slack',
  'discord',
  'spotify',
  'nvidia',
  'nvidia corporation',
  'adobe',
  'jetbrains',
  'npm-cache',
  'squirreltemp',
  'whatsapp',
  'steam',
  'epicgameslauncher',
  'gog.com',
  'dropbox',
  'google',
])

const finding = (
  ctx: ClassifyContext,
  f: Omit<Finding, 'id' | 'protectedBy'> & { protectedBy?: string | null },
): Finding => ({
  ...f,
  id: stableId(`${f.category}|${normalizePath(f.path)}`),
  protectedBy: f.protectedBy ?? null,
})

const protectedFinding = (ctx: ClassifyContext, c: RawCandidate, rule: string): Finding =>
  finding(ctx, {
    category: 'protected',
    class: 'protected',
    action: 'none',
    path: c.path,
    bytes: c.bytes,
    fileCount: c.fileCount,
    isFolder: c.isFolder,
    modifiedUtc: c.modifiedUtc,
    accessedUtc: c.accessedUtc,
    reason: `Protected: ${rule}. Drive Cleanup never offers it.`,
    evidence: { rule: 'protected_path', values: { kind: c.kind, protectedBy: rule } },
    confidence: 'high',
    protectedBy: rule,
  })

function isAllowlistedLog(path: string, ctx: ClassifyContext): boolean {
  if (isUnder(path, ctx.temp)) return true
  if (!isInAppData(path, ctx)) return false
  const segments = normalizePath(parentPath(path)).split('\\')
  const hasLogFolder = segments.some(s => s === 'logs' || s === 'log' || s === '_logs')
  const hasVendor = segments.some(s => LOG_VENDORS.has(s))
  return hasLogFolder && hasVendor
}

/** One candidate from the walk, classified. Undefined: not a finding after all. */
export function classifyCandidate(c: RawCandidate, ctx: ClassifyContext): Finding | undefined {
  const rule = protectedBy(c.path, ctx, c.isFolder)
  if (rule !== null) return protectedFinding(ctx, c, rule)
  if (c.inProject && c.kind !== 'build_cache') return protectedFinding(ctx, c, 'Inside a development project')

  const modifiedDays = ageDays(c.modifiedUtc, ctx.nowMs)
  const age = ageText(modifiedDays)
  const where = parentPath(c.path)
  const base = {
    path: c.path,
    bytes: c.bytes,
    fileCount: c.fileCount,
    isFolder: c.isFolder,
    modifiedUtc: c.modifiedUtc,
    accessedUtc: ctx.lastAccessTrusted ? c.accessedUtc : null,
  }
  const values = { modifiedDays: modifiedDays ?? -1, bytes: c.bytes }

  switch (c.kind) {
    case 'installer':
      return finding(ctx, {
        ...base,
        category: 'installer',
        class: 'review',
        action: 'quarantine',
        reason: `Program or installer file (${extensionOf(c.path)}) in ${where}, not modified for ${age}. A setup file is not needed once its program is installed; a portable program runs from here, so review it.`,
        evidence: { rule: 'installer_extension', values },
        confidence: 'medium',
      })
    case 'archive':
      if (c.extractedFolder !== null) {
        return finding(ctx, {
          ...base,
          category: 'extracted_pair',
          class: 'review',
          action: 'quarantine',
          reason: `Archive with a folder of the same name beside it (${baseName(c.extractedFolder)}), so it was probably extracted. Matched by name only: check the folder before approving.`,
          evidence: { rule: 'archive_with_extracted_folder', values: { ...values, folder: c.extractedFolder } },
          confidence: 'low',
        })
      }
      return finding(ctx, {
        ...base,
        category: 'archive',
        class: 'review',
        action: 'quarantine',
        reason: `Archive (${extensionOf(c.path)}) in ${where}, not modified for ${age}.`,
        evidence: { rule: 'archive_extension', values },
        confidence: 'medium',
      })
    case 'crash_dump': {
      const inCrashDumps = isUnder(c.path, `${ctx.localAppData}\\CrashDumps`)
      return finding(ctx, {
        ...base,
        category: 'crash_dumps',
        class: inCrashDumps ? 'safe' : 'review',
        action: inCrashDumps ? 'delete' : 'quarantine',
        reason: inCrashDumps
          ? `Crash dump written by Windows Error Reporting, ${age} old. Only useful to debug that crash.`
          : `Memory dump file (.dmp) outside the crash dump folder, ${age} old. It may belong to a debugging session.`,
        evidence: { rule: inCrashDumps ? 'crash_dumps_folder' : 'dump_extension', values },
        confidence: inCrashDumps ? 'high' : 'medium',
      })
    }
    case 'log': {
      const isOld = modifiedDays !== null && modifiedDays >= THRESHOLDS.logDays
      if (!isOld) return undefined
      const isSafe = isAllowlistedLog(c.path, ctx)
      return finding(ctx, {
        ...base,
        category: 'app_logs',
        class: isSafe ? 'safe' : 'review',
        action: isSafe ? 'delete' : 'quarantine',
        reason: isSafe
          ? `Old log in an app's log folder, not written for ${age}. The app writes new logs as needed.`
          : `Log file not written for ${age}, in a folder Drive Cleanup does not know; review before approving.`,
        evidence: { rule: isSafe ? 'log_allowlist' : 'log_extension', values },
        confidence: isSafe ? 'high' : 'low',
      })
    }
    case 'temp_extract': {
      const isOld = modifiedDays !== null && modifiedDays >= THRESHOLDS.tempDays
      if (!isOld) return undefined
      return finding(ctx, {
        ...base,
        category: 'temp_extract',
        class: 'safe',
        action: 'delete',
        reason: `Folder in Temp with nothing written for ${age}: left behind by an installer or app.`,
        evidence: { rule: 'temp_folder_age', values },
        confidence: 'high',
      })
    }
    case 'old_download':
      return finding(ctx, {
        ...base,
        category: 'old_download',
        class: 'review',
        action: 'quarantine',
        reason: `In Downloads and not modified for ${age}.`,
        evidence: { rule: 'download_age', values },
        confidence: 'medium',
      })
    case 'large_old':
      return finding(ctx, {
        ...base,
        category: 'large_old',
        class: 'review',
        action: 'quarantine',
        reason: `Large file (${sizeText(c.bytes)}) not modified for ${age}. Size and age alone never make it unnecessary: review it.`,
        evidence: { rule: 'large_and_old', values },
        confidence: 'low',
      })
    case 'build_cache':
      return finding(ctx, {
        ...base,
        category: 'build_cache',
        class: 'review',
        action: 'quarantine',
        reason: `Build cache inside the project ${parentPath(parentPath(c.path))}, last written ${age} ago. Its tool rebuilds it (the next build is slower once). Nothing else in the project is touched.`,
        evidence: { rule: 'project_build_cache', values },
        confidence: 'medium',
      })
    case 'empty_folder':
      return finding(ctx, {
        ...base,
        category: 'empty_folder',
        class: 'review',
        action: 'quarantine',
        reason: 'Empty folder. Some apps expect their folders to exist; review before approving.',
        evidence: { rule: 'empty_folder', values },
        confidence: 'low',
      })
  }
}

/** The user Temp folder as one finding (PC Guardian already cleans it). */
function userTempFinding(walk: RawWalk, ctx: ClassifyContext): Finding | undefined {
  if (walk.userTemp.oldCount === 0) return undefined
  return finding(ctx, {
    category: 'user_temp',
    class: 'safe',
    // Never cleaned here: a folder-wide delete could not keep to the 7-day rule.
    action: ctx.isPcGuardianInstalled ? 'pc_guardian' : 'manual',
    path: ctx.temp,
    bytes: walk.userTemp.oldBytes,
    fileCount: walk.userTemp.oldCount,
    isFolder: true,
    modifiedUtc: null,
    accessedUtc: null,
    reason: ctx.isPcGuardianInstalled
      ? `Temp files not written for ${String(THRESHOLDS.tempDays)} days or more. Clean them with PC Guardian's cleanup.`
      : `Temp files not written for ${String(THRESHOLDS.tempDays)} days or more. Clean them with Settings > System > Storage > Temporary files, or Storage Sense. (Old folders in Temp are listed separately and can be cleaned here.)`,
    evidence: {
      rule: 'temp_file_age',
      values: { oldCount: walk.userTemp.oldCount, totalCount: walk.userTemp.fileCount },
    },
    confidence: 'high',
  })
}

const WINDOWS_TEXT: Record<
  RawWindowsItem['id'],
  { cls: FindingClass; action: Finding['action']; reason: string } | null
> = {
  update_cache: {
    cls: 'review',
    action: 'manual',
    reason: 'Windows Update downloads. Clean them with Settings > System > Storage > Temporary files.',
  },
  windows_old: {
    cls: 'review',
    action: 'manual',
    reason:
      'The previous Windows installation. Removing it ends the option to go back; use Settings > System > Storage > Temporary files > Previous Windows installation(s).',
  },
  windows_temp: {
    cls: 'review',
    action: 'manual',
    reason: "Windows' own Temp folder. Clean it with Disk Cleanup or Storage Sense.",
  },
  minidump: {
    cls: 'review',
    action: 'manual',
    reason: 'Small crash dumps from blue screens. Disk Cleanup > System error memory dump files removes them.',
  },
  memory_dmp: {
    cls: 'review',
    action: 'manual',
    reason: 'Full memory dump from a blue screen. Disk Cleanup > System error memory dump files removes it.',
  },
  live_kernel_reports: {
    cls: 'review',
    action: 'manual',
    reason: 'Kernel error reports. Disk Cleanup > System error memory dump files removes them.',
  },
  recycle_bin: {
    cls: 'safe',
    action: 'manual',
    reason: 'Your Recycle Bin. Drive Cleanup never empties it; empty it yourself, or with PC Guardian.',
  },
  hiberfil: null,
  pagefile: null,
  swapfile: null,
}

function windowsFindings(win: RawWindows, ctx: ClassifyContext): Finding[] {
  const out: Finding[] = []
  for (const item of win.items) {
    const text = WINDOWS_TEXT[item.id]
    if (text === null || item.status !== 'ok' || item.bytes <= 0) continue
    out.push(
      finding(ctx, {
        category: 'windows_managed',
        class: text.cls,
        action: item.id === 'recycle_bin' && ctx.isPcGuardianInstalled ? 'pc_guardian' : text.action,
        path: item.path,
        bytes: item.bytes,
        fileCount: item.fileCount,
        isFolder: true,
        modifiedUtc: null,
        accessedUtc: null,
        reason: text.reason,
        evidence: { rule: `windows_${item.id}`, values: { bytes: item.bytes, fileCount: item.fileCount } },
        confidence: 'high',
      }),
    )
  }
  return out
}

function devCacheFindings(raw: RawDevCaches, ctx: ClassifyContext): Finding[] {
  const out: Finding[] = []
  for (const cache of raw.caches) {
    const spec = DEV_CACHES.find(c => c.id === cache.id)
    if (spec === undefined || !cache.isPresent || cache.bytes <= 0) continue
    const root = cache.roots.find(r => r.status !== 'missing')?.path ?? ''
    const isSafe = spec.cls === 'safe'
    out.push(
      finding(ctx, {
        category: isSafe ? 'dev_cache_safe' : 'dev_cache_review',
        class: isSafe ? 'safe' : 'review',
        action: isSafe ? 'delete' : 'manual',
        path: cache.roots.length > 1 ? parentPath(root) : root,
        bytes: cache.bytes,
        fileCount: cache.fileCount,
        isFolder: true,
        modifiedUtc: cache.lastWriteUtc,
        accessedUtc: null,
        reason: `${spec.label} (${spec.tool}). ${spec.how} ${spec.note}${cache.isRunning ? ` ${spec.tool} is running now: close it before cleaning.` : ''}`,
        evidence: {
          rule: `dev_cache_${spec.id}`,
          values: { bytes: cache.bytes, isRunning: cache.isRunning ? 'yes' : 'no' },
        },
        confidence: isSafe ? 'high' : 'medium',
        cacheId: spec.id,
      }),
    )
  }
  return out
}

function leftoverFindings(raw: RawLeftovers, ctx: ClassifyContext): Finding[] {
  return raw.folders.map(f => {
    const rule = protectedBy(f.path, ctx, true)
    const days = ageDays(f.lastWriteUtc, ctx.nowMs)
    return finding(ctx, {
      category: rule === null ? 'leftover' : 'protected',
      class: rule === null ? 'review' : 'protected',
      action: rule === null ? 'quarantine' : 'none',
      path: f.path,
      bytes: f.bytes,
      fileCount: f.fileCount,
      isFolder: true,
      modifiedUtc: f.lastWriteUtc,
      accessedUtc: null,
      reason:
        rule === null
          ? `App data folder whose name matches none of the ${String(raw.installedCount)} installed programs; last changed ${ageText(days)} ago. Matched by name only: it may belong to a portable app or a program installed another way.`
          : `Protected: ${rule}.`,
      evidence: { rule: 'no_installed_program', values: { installed: raw.installedCount } },
      confidence: 'low',
      protectedBy: rule,
    })
  })
}

export type ScanInputs = {
  walk: RawWalk | null
  windows: RawWindows | null
  devcaches?: RawDevCaches | null
  leftovers?: RawLeftovers | null
  hash?: RawHash | null
  /** Finding ids already cleaned or quarantined since this scan. */
  done?: ReadonlySet<string>
}

export type Classified = {
  findings: Finding[]
  totals: CategoryTotal[]
  recoverable: { safeBytes: number; reviewBytes: number; manualBytes: number }
}

const CATEGORY_ORDER: readonly CategoryId[] = [
  'user_temp',
  'temp_extract',
  'crash_dumps',
  'app_logs',
  'installer',
  'archive',
  'extracted_pair',
  'old_download',
  'large_old',
  'empty_folder',
  'build_cache',
  'dev_cache_safe',
  'dev_cache_review',
  'leftover',
  'duplicate',
  'duplicate_folder',
  'windows_managed',
  'protected',
]

/** Every finding of a scan, largest first, with totals by category. */
export function classifyScan(inputs: ScanInputs, ctx: ClassifyContext): Classified {
  const { walk, windows: win } = inputs
  const findings: Finding[] = []
  const seen = new Set<string>()
  const done = inputs.done ?? new Set<string>()
  // A file in a duplicate group is listed there only, not again as a download or installer.
  const dupes = inputs.hash ? duplicateFindings(inputs.hash, ctx) : []
  const dupePaths = new Set(dupes.map(f => normalizePath(f.path)))
  const push = (f: Finding | undefined): void => {
    if (f === undefined || seen.has(f.id) || done.has(f.id)) return
    seen.add(f.id)
    findings.push(f)
  }
  if (walk !== null) {
    push(userTempFinding(walk, ctx))
    for (const c of walk.candidates) {
      if (!c.isFolder && dupePaths.has(normalizePath(c.path))) continue
      push(classifyCandidate(c, ctx))
    }
  }
  for (const f of dupes) push(f)
  if (inputs.devcaches) for (const f of devCacheFindings(inputs.devcaches, ctx)) push(f)
  if (inputs.leftovers) for (const f of leftoverFindings(inputs.leftovers, ctx)) push(f)
  if (win !== null) for (const f of windowsFindings(win, ctx)) push(f)
  findings.sort((a, b) => b.bytes - a.bytes)

  const cappedKinds = new Set((walk?.candidateTotals ?? []).filter(t => t.isCapped).map(t => t.kind as string))
  const capOf: Partial<Record<CategoryId, string>> = {
    installer: 'installer',
    archive: 'archive',
    extracted_pair: 'archive',
    crash_dumps: 'crash_dump',
    app_logs: 'log',
    temp_extract: 'temp_extract',
    old_download: 'old_download',
    large_old: 'large_old',
    empty_folder: 'empty_folder',
    build_cache: 'build_cache',
  }
  const totals: CategoryTotal[] = []
  for (const category of CATEGORY_ORDER) {
    for (const cls of ['safe', 'review', 'protected'] as const) {
      const items = findings.filter(f => f.category === category && f.class === cls)
      if (items.length === 0) continue
      const kind = capOf[category]
      totals.push({
        category,
        class: cls,
        count: items.length,
        bytes: items.reduce((sum, f) => sum + f.bytes, 0),
        isCapped: kind !== undefined && cappedKinds.has(kind),
      })
    }
  }

  let safeBytes = 0
  let reviewBytes = 0
  let manualBytes = 0
  for (const f of findings) {
    if (f.action === 'none') continue
    if (f.action === 'manual') manualBytes += f.bytes
    else if (f.class === 'safe') safeBytes += f.bytes
    else if (f.class === 'review') reviewBytes += f.bytes
  }
  return { findings, totals, recoverable: { safeBytes, reviewBytes, manualBytes } }
}

export const CATEGORY_LABEL: Record<CategoryId, string> = {
  user_temp: 'Temp files',
  temp_extract: 'Old Temp folders',
  crash_dumps: 'Crash dumps',
  app_logs: 'Old logs',
  installer: 'Installers',
  archive: 'Archives',
  extracted_pair: 'Already-extracted archives',
  old_download: 'Old downloads',
  large_old: 'Large old files',
  empty_folder: 'Empty folders',
  build_cache: 'Project build caches',
  dev_cache_safe: 'Developer caches',
  dev_cache_review: 'Developer caches (manual)',
  leftover: 'App leftovers',
  duplicate: 'Duplicate files',
  duplicate_folder: 'Duplicate folders',
  windows_managed: 'Windows-managed',
  protected: 'Protected',
}

export const CLASS_LABEL: Record<FindingClass, string> = {
  safe: 'A. Safe to clean',
  review: 'B. Review before cleaning',
  protected: 'C. Protected',
}
