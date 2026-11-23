// Phase 5 (PLAN.md §7): turns the person's selection into the approved list
// the action scripts act on, or refuses with the reason. Pure, so every rule
// here is unit-tested. The action scripts repeat the safety checks on their own.

import { CATEGORY_LABEL } from './classify.ts'
import { sizeText } from './format.ts'
import type { ApprovedItem, ApprovedList, Finding, RawVolume, Settings } from './types.ts'

export const MAX_SCAN_AGE_HOURS = 24
const GiB = 1024 ** 3

export type CacheJob = { cacheId: string; findingId: string; bytes: number; label: string }

export type Plan =
  | {
      status: 'ok'
      list: ApprovedList
      caches: CacheJob[]
      deleteBytes: number
      quarantineBytes: number
      itemCount: number
      summary: string
    }
  | { status: 'refused'; message: string }

const refuse = (message: string): Plan => ({ status: 'refused', message })

/** Where quarantined files go: another fixed NTFS drive with room, else the system drive. */
export function chooseQuarantineRoot(
  volume: RawVolume | null,
  setting: string,
  bytesFromSystemDrive: number,
): { status: 'ok'; root: string; drive: string } | { status: 'refused'; message: string } {
  const drives = (volume?.drives ?? []).filter(d => /^ntfs$/i.test(d.fileSystem) && /^[A-Za-z]:$/.test(d.letter))
  const fits = (free: number, total: number, needed: number): boolean =>
    free - needed >= Math.max(total * 0.1, 10 * GiB)
  let candidates = drives
  if (setting !== 'auto') {
    candidates = drives.filter(d => d.letter.toUpperCase() === setting.toUpperCase())
    if (candidates.length === 0)
      return {
        status: 'refused',
        message: `The quarantine drive ${setting} was not found as a fixed NTFS drive. Choose another in Settings.`,
      }
  } else {
    const others = drives.filter(d => !d.isSystem).sort((a, b) => b.freeBytes - a.freeBytes)
    const system = drives.filter(d => d.isSystem)
    candidates = [...others, ...system]
  }
  for (const d of candidates) {
    // A move within the system drive is a rename and needs no space of its own.
    const needed = d.isSystem ? 0 : bytesFromSystemDrive
    if (fits(d.freeBytes, d.totalBytes, needed)) {
      const letter = d.letter.toUpperCase()
      return { status: 'ok', root: `${letter}\\Drive Cleanup Quarantine`, drive: letter }
    }
  }
  return {
    status: 'refused',
    message: `No drive has room to quarantine ${sizeText(bytesFromSystemDrive)} while keeping 10 % and 10 GB free.`,
  }
}

export type PlanInput = {
  runId: string
  scanId: string
  scanFinishedAt: string
  findings: readonly Finding[]
  selectedIds: readonly string[]
  settings: Settings
  volume: RawVolume | null
  nowMs: number
  isScanRunning: boolean
}

export function planCleanup(input: PlanInput): Plan {
  if (!input.settings.cleanupEnabled) {
    return refuse('Cleanup is off. Only you can turn it on, in the Drive Cleanup pane: Settings.')
  }
  if (input.isScanRunning) return refuse('A scan is running. Wait for it to finish.')
  const scanAgeHours = (input.nowMs - Date.parse(input.scanFinishedAt)) / 3_600_000
  if (!(scanAgeHours >= 0 && scanAgeHours <= MAX_SCAN_AGE_HOURS)) {
    return refuse(`The scan is more than ${String(MAX_SCAN_AGE_HOURS)} hours old. Run a new deep scan first.`)
  }
  const ids = [...new Set(input.selectedIds)]
  if (ids.length === 0) return refuse('Nothing is selected.')

  const byId = new Map(input.findings.map(f => [f.id, f]))
  const items: ApprovedItem[] = []
  const caches: CacheJob[] = []
  for (const id of ids) {
    const f = byId.get(id)
    if (f === undefined) return refuse('The selection includes an item that is not in the current scan. Select again.')
    if (f.class === 'protected' || f.protectedBy !== null)
      return refuse(`${f.path} is protected and cannot be cleaned.`)
    if (f.action !== 'delete' && f.action !== 'quarantine') {
      return refuse(
        `${f.path} is not cleaned by Drive Cleanup (${f.action === 'manual' ? 'use the manual steps' : f.action === 'pc_guardian' ? "use PC Guardian's cleanup" : 'kept'}).`,
      )
    }
    if (f.cacheId !== undefined) {
      if (f.action !== 'delete') return refuse(`${f.path} is cleaned by hand only.`)
      caches.push({ cacheId: f.cacheId, findingId: f.id, bytes: f.bytes, label: f.reason.split('.')[0] ?? f.cacheId })
      continue
    }
    if (f.action === 'delete' && f.class !== 'safe') return refuse(`${f.path} can only be moved to quarantine.`)
    if (!f.isFolder && f.modifiedUtc === null)
      return refuse(`${f.path} has no recorded date, so it cannot be checked before acting.`)
    items.push({
      id: f.id,
      path: f.path,
      isFolder: f.isFolder,
      action: f.action,
      category: f.category,
      bytes: f.bytes,
      modifiedUtc: f.modifiedUtc ?? new Date(0).toISOString(),
      sha256: f.category === 'duplicate' ? (f.duplicate?.sha256 ?? null) : null,
    })
  }

  // Never every copy of a duplicate group.
  const groups = new Map<string, { total: number; selected: number }>()
  for (const f of input.findings) {
    if (f.duplicate === undefined) continue
    const g = groups.get(f.duplicate.groupId) ?? { total: 0, selected: 0 }
    g.total++
    if (ids.includes(f.id)) g.selected++
    groups.set(f.duplicate.groupId, g)
  }
  for (const g of groups.values()) {
    if (g.selected > 0 && g.selected >= g.total)
      return refuse('Every copy of a duplicate group is selected. Keep at least one.')
  }

  const quarantineBytes = items.filter(i => i.action === 'quarantine').reduce((s, i) => s + i.bytes, 0)
  const deleteBytes =
    items.filter(i => i.action === 'delete').reduce((s, i) => s + i.bytes, 0) + caches.reduce((s, c) => s + c.bytes, 0)
  let quarantineRoot = ''
  if (quarantineBytes > 0) {
    const fromSystem = items
      .filter(
        i =>
          i.action === 'quarantine' &&
          i.path.slice(0, 2).toUpperCase() === (input.volume?.systemDrive ?? 'C:').toUpperCase(),
      )
      .reduce((s, i) => s + i.bytes, 0)
    const chosen = chooseQuarantineRoot(input.volume, input.settings.quarantineDrive, fromSystem)
    if (chosen.status !== 'ok') return refuse(chosen.message)
    quarantineRoot = chosen.root
  }

  const byCategory = new Map<string, { count: number; bytes: number }>()
  for (const id of ids) {
    const f = byId.get(id)
    if (f === undefined) continue
    const c = byCategory.get(f.category) ?? { count: 0, bytes: 0 }
    c.count++
    c.bytes += f.bytes
    byCategory.set(f.category, c)
  }
  const parts = [...byCategory.entries()].map(
    ([cat, c]) => `${CATEGORY_LABEL[cat as Finding['category']]}: ${String(c.count)} (${sizeText(c.bytes)})`,
  )
  const lines = [
    quarantineBytes > 0 ? `Move ${sizeText(quarantineBytes)} to ${quarantineRoot} (restorable).` : '',
    deleteBytes > 0 ? `Delete ${sizeText(deleteBytes)} of re-creatable data permanently.` : '',
    parts.join('; '),
  ].filter(l => l !== '')

  return {
    status: 'ok',
    list: {
      runId: input.runId,
      scanId: input.scanId,
      approvedAt: new Date(input.nowMs).toISOString(),
      scanFinishedAt: input.scanFinishedAt,
      quarantineRoot,
      items,
    },
    caches,
    deleteBytes,
    quarantineBytes,
    itemCount: items.length + caches.length,
    summary: lines.join(' '),
  }
}
