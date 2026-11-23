// Phase 4 (PLAN.md §6): duplicate groups from hash.ps1 become findings. One
// copy in every group is the suggested keeper (§5.4); the others are class B,
// quarantined only if the person ticks them, and never all copies of a group.

import { ageDays, ageText, sizeText, stableId } from './format.ts'
import { baseName, isUnder, normalizePath, parentPath, protectedBy } from './paths.ts'
import type { ClassifyContext, Finding, RawDuplicateFile, RawHash } from './types.ts'

const PREFERRED = ['Documents', 'Pictures', 'Videos', 'Music', 'Desktop', 'OneDrive'] as const
const UNPREFERRED = ['Downloads'] as const

const COPY_NAME = /( \(\d+\)| - copy( \(\d+\))?|^copy of )/i

export type KeeperChoice = { index: number; reason: string }

/** The copy to keep, and why: the first rule that tells the copies apart. */
export function chooseKeeper(files: readonly RawDuplicateFile[], ctx: ClassifyContext): KeeperChoice {
  if (files.length === 0) return { index: 0, reason: 'only copy' }
  const score = (f: RawDuplicateFile): number[] => {
    const inPreferred = PREFERRED.some(p => isUnder(f.path, `${ctx.userProfile}\\${p}`)) ? 0 : 1
    const inBad =
      UNPREFERRED.some(p => isUnder(f.path, `${ctx.userProfile}\\${p}`)) || isUnder(f.path, ctx.temp) ? 1 : 0
    const inExtraction = /\\(7z[^\\]*|[^\\]*\.extracted|temp[^\\]*)\\/i.test(f.path) ? 1 : 0
    const isCopyName = COPY_NAME.test(baseName(f.path)) ? 1 : 0
    const depth = normalizePath(f.path).split('\\').length
    const created = Date.parse(f.createdUtc) || 0
    return [inPreferred, inBad, inExtraction, isCopyName, depth, created]
  }
  const reasons = [
    'in Documents, Pictures, Videos, Music, Desktop or OneDrive',
    'not in Downloads or Temp',
    'not in an extraction folder',
    'has the original name, not a copy name',
    'the shortest path',
    'the oldest copy',
  ]
  let best = 0
  let reason = 'the first copy found'
  for (let i = 1; i < files.length; i++) {
    const a = score(files[best] as RawDuplicateFile)
    const b = score(files[i] as RawDuplicateFile)
    for (let k = 0; k < a.length; k++) {
      const x = a[k] as number
      const y = b[k] as number
      if (x === y) continue
      if (y < x) best = i
      break
    }
  }
  // Name the rule that separates the keeper from the runner-up.
  const keeper = score(files[best] as RawDuplicateFile)
  for (let i = 0; i < files.length; i++) {
    if (i === best) continue
    const other = score(files[i] as RawDuplicateFile)
    const k = keeper.findIndex((v, j) => v !== other[j])
    if (k >= 0) {
      reason = reasons[k] ?? reason
      break
    }
  }
  return { index: best, reason }
}

export function duplicateFindings(hash: RawHash, ctx: ClassifyContext): Finding[] {
  const out: Finding[] = []
  for (const group of hash.groups) {
    const groupId = group.sha256.slice(0, 16)
    const keeper = chooseKeeper(group.files, ctx)
    group.files.forEach((f, i) => {
      const rule = protectedBy(f.path, ctx)
      const isKeeper = i === keeper.index
      const others = group.files.length - 1
      const days = ageDays(f.modifiedUtc, ctx.nowMs)
      out.push({
        id: stableId(`duplicate|${normalizePath(f.path)}`),
        category: rule === null ? 'duplicate' : 'protected',
        class: rule === null ? 'review' : 'protected',
        action: rule !== null || isKeeper ? 'none' : 'quarantine',
        path: f.path,
        bytes: group.bytes,
        fileCount: 1,
        isFolder: false,
        modifiedUtc: f.modifiedUtc,
        accessedUtc: ctx.lastAccessTrusted ? f.accessedUtc : null,
        reason: isKeeper
          ? `Suggested copy to keep (${keeper.reason}) of ${String(others + 1)} identical files.`
          : `Identical (SHA-256) to ${String(others)} other file${others === 1 ? '' : 's'}; ${sizeText(group.bytes)}, modified ${ageText(days)} ago. The suggested keeper is in ${parentPath(group.files[keeper.index]?.path ?? '')}.`,
        evidence: { rule: 'sha256_match', values: { sha256: group.sha256, copies: others + 1 } },
        confidence: 'high',
        protectedBy: rule,
        duplicate: { groupId, sha256: group.sha256, isSuggestedKeeper: isKeeper, keeperReason: keeper.reason },
      })
    })
  }

  // Folders: drop a folder group whose folders all sit inside folders of another group.
  const allFolders = hash.folderGroups.flatMap(g => g.folders)
  for (const group of hash.folderGroups) {
    const isNested = group.folders.every(f => allFolders.some(o => o !== f && isUnder(f, o)))
    if (isNested) continue
    const files: RawDuplicateFile[] = group.folders.map(path => ({
      path,
      modifiedUtc: new Date(0).toISOString(),
      accessedUtc: new Date(0).toISOString(),
      createdUtc: new Date(0).toISOString(),
    }))
    const keeper = chooseKeeper(files, ctx)
    const groupId = group.signature.slice(0, 16)
    group.folders.forEach((path, i) => {
      const rule = protectedBy(path, ctx, true)
      const isKeeper = i === keeper.index
      out.push({
        id: stableId(`duplicate_folder|${normalizePath(path)}`),
        category: rule === null ? 'duplicate_folder' : 'protected',
        class: rule === null ? 'review' : 'protected',
        action: rule !== null || isKeeper ? 'none' : 'quarantine',
        path,
        bytes: group.bytes,
        fileCount: group.fileCount,
        isFolder: true,
        modifiedUtc: null,
        accessedUtc: null,
        reason: isKeeper
          ? `Suggested folder to keep (${keeper.reason}); ${String(group.folders.length - 1)} other folder(s) hold the same files.`
          : `Holds the same ${String(group.fileCount)} files (by name and SHA-256) as ${parentPath(group.folders[keeper.index] ?? '')}\\${baseName(group.folders[keeper.index] ?? '')}.`,
        evidence: {
          rule: 'folder_signature_match',
          values: { signature: group.signature, folders: group.folders.length },
        },
        confidence: 'high',
        protectedBy: rule,
        duplicate: { groupId, sha256: group.signature, isSuggestedKeeper: isKeeper, keeperReason: keeper.reason },
      })
    })
  }
  return out
}

/** Merges a resumed hash run into the previous one (groups by hash, folders by signature). */
export function mergeHash(previous: RawHash, next: RawHash): RawHash {
  const groups = new Map(previous.groups.map(g => [g.sha256, g]))
  for (const g of next.groups) groups.set(g.sha256, g)
  const folders = new Map(previous.folderGroups.map(g => [g.signature, g]))
  for (const g of next.folderGroups) folders.set(g.signature, g)
  return {
    elapsedMs: previous.elapsedMs + next.elapsedMs,
    isTruncated: next.isTruncated,
    resumeBelowBytes: next.resumeBelowBytes,
    filesConsidered: previous.filesConsidered + next.filesConsidered,
    filesHashed: previous.filesHashed + next.filesHashed,
    bytesHashed: previous.bytesHashed + next.bytesHashed,
    skippedLocked: previous.skippedLocked + next.skippedLocked,
    skippedCloud: Math.max(previous.skippedCloud, next.skippedCloud),
    groups: [...groups.values()]
      .toSorted((a, b) => b.bytes * (b.files.length - 1) - a.bytes * (a.files.length - 1))
      .slice(0, 4000),
    folderGroups: [...folders.values()].slice(0, 5000),
  }
}
