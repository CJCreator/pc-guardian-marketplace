// The audit files (PLAN.md §12) that M1 writes: storage_audit.md,
// largest_files.csv, installers_and_archives.csv, cleanup_recommendations.md.
// Pure: text in, text out. The mod writes them with the safe writer.

import { CATEGORY_LABEL, CLASS_LABEL, THRESHOLDS, type Classified } from './classify.ts'
import { ageDays, dateText, percentText, sizeText } from './format.ts'
import { DEV_CACHES } from './devcaches.ts'
import { protectedBy } from './paths.ts'
import type {
  ClassifyContext,
  RawDevCaches,
  RawHash,
  RawVerify,
  Finding,
  FindingClass,
  RawVolume,
  RawWalk,
  RawWindows,
  Recommendation,
  ScanMeta,
} from './types.ts'

/**
 * One CSV cell. Quoted always; a cell that a spreadsheet would read as a
 * formula (= + - @, tab, carriage return) is prefixed with an apostrophe.
 */
export function csvCell(value: string | number | boolean | null): string {
  let text = value === null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

/** CSV with a UTF-8 BOM and CRLF line ends, as Excel expects. */
export function csv(header: readonly string[], rows: readonly (readonly (string | number | boolean | null)[])[]): string {
  const lines = [header, ...rows].map(row => row.map(csvCell).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** Text for a Markdown table cell: pipes and line breaks escaped. */
const md = (text: string): string => text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

export type ReportInput = {
  meta: ScanMeta
  volume: RawVolume | null
  walk: RawWalk | null
  windows: RawWindows | null
  devcaches?: RawDevCaches | null
  hash?: RawHash | null
  classified: Classified
  recommendations: Recommendation[]
  ctx: ClassifyContext
}

export type ReportFile = { name: string; text: string }

export function buildReports(input: ReportInput): ReportFile[] {
  return [
    { name: 'storage_audit.md', text: storageAudit(input) },
    { name: 'largest_files.csv', text: largestFiles(input) },
    { name: 'installers_and_archives.csv', text: installersAndArchives(input) },
    { name: 'cleanup_recommendations.md', text: cleanupRecommendations(input) },
    { name: 'cache_analysis.md', text: cacheAnalysis(input) },
    { name: 'duplicate_files.csv', text: duplicateFiles(input) },
  ]
}

function stepLines(meta: ScanMeta): string[] {
  return meta.steps.map(s => {
    const state =
      s.state === 'ok'
        ? s.isTruncated
          ? 'done, stopped at its limit (partial)'
          : 'done'
        : s.state === 'not_checked'
          ? `not checked: ${s.notChecked?.detail ?? ''}`
          : s.state
    return `- ${s.label}: ${state}`
  })
}

function storageAudit({ meta, volume, walk, windows, ctx }: ReportInput): string {
  const out: string[] = ['# Storage audit', '']
  out.push(`Scan ${meta.scanId}, ${meta.createdAt}. Read-only: nothing was changed.`, '')
  out.push('## Steps', '', ...stepLines(meta), '')

  out.push('## Drives', '')
  if (volume === null) out.push('Not checked.', '')
  else {
    out.push('| Drive | Label | File system | Capacity | Used | Free | Free % |', '| --- | --- | --- | ---: | ---: | ---: | ---: |')
    for (const d of volume.drives) {
      const used = Math.max(0, d.totalBytes - d.freeBytes)
      out.push(
        `| ${md(d.letter)}${d.isSystem ? ' (system)' : ''} | ${md(d.label)} | ${md(d.fileSystem)} | ${sizeText(d.totalBytes)} | ${sizeText(used)} | ${sizeText(d.freeBytes)} | ${percentText(d.freeBytes, d.totalBytes)} |`,
      )
    }
    out.push('')
  }

  if (walk === null) {
    out.push('## Where the space is', '', 'Not checked: the drive walk did not complete.', '')
    return out.join('\n')
  }

  const system = volume?.drives.find(d => d.isSystem)
  out.push('## Where the space is', '')
  out.push(
    `The walk read ${walk.totals.fileCount.toLocaleString('en-US')} files in ${walk.totals.folderCount.toLocaleString('en-US')} folders, ${sizeText(walk.totals.bytes)} in all, in ${(walk.elapsedMs / 1000).toFixed(0)} s.`,
  )
  if (walk.isTruncated) out.push('**The walk stopped at its time or entry limit, so these figures are partial.**')
  if (system !== undefined) {
    const used = system.totalBytes - system.freeBytes
    const unread = used - walk.totals.bytes
    if (unread > 0) {
      out.push(
        `${sizeText(unread)} of used space was not readable without administrator rights (system files, other users, restore points) or is in linked or cloud folders that are not walked.`,
      )
    }
  }
  out.push('')
  out.push('### Top-level folders', '', '| Folder | Size | Files | Share of used |', '| --- | ---: | ---: | ---: |')
  const usedBytes = system !== undefined ? system.totalBytes - system.freeBytes : walk.totals.bytes
  for (const f of walk.folders.filter(f => f.depth === 1).slice(0, 40)) {
    out.push(`| ${md(f.path)} | ${sizeText(f.bytes)} | ${f.fileCount.toLocaleString('en-US')} | ${percentText(f.bytes, usedBytes)} |`)
  }
  out.push('')
  out.push('### Largest folders, two and three levels down', '', '| Folder | Size | Files |', '| --- | ---: | ---: |')
  for (const f of walk.folders.filter(f => f.depth > 1).slice(0, 60)) {
    out.push(`| ${md(f.path)} | ${sizeText(f.bytes)} | ${f.fileCount.toLocaleString('en-US')} |`)
  }
  out.push('')

  out.push('## Age', '')
  out.push(
    `- Not modified for 12 months: ${walk.ages.modifiedOver12m.count.toLocaleString('en-US')} files, ${sizeText(walk.ages.modifiedOver12m.bytes)}.`,
  )
  out.push(
    ctx.lastAccessTrusted
      ? `- Not opened for 6 months: ${walk.ages.accessedOver6m.count.toLocaleString('en-US')} files, ${sizeText(walk.ages.accessedOver6m.bytes)}.`
      : '- Not opened for 6 months: **Not checked**. Windows is not recording last-access times on this PC, so they cannot be trusted.',
  )
  out.push('')

  out.push('## File types', '', '| Extension | Files | Size |', '| --- | ---: | ---: |')
  for (const e of walk.extensions.slice(0, 25)) {
    out.push(`| ${md(e.extension)} | ${e.fileCount.toLocaleString('en-US')} | ${sizeText(e.bytes)} |`)
  }
  out.push('')

  out.push('## Found by kind', '', '| Kind | Count | Size | Listed |', '| --- | ---: | ---: | --- |')
  for (const t of walk.candidateTotals) {
    out.push(`| ${t.kind} | ${t.count.toLocaleString('en-US')} | ${sizeText(t.bytes)} | ${t.isCapped ? 'largest 1,000' : 'all'} |`)
  }
  out.push('')
  out.push(
    `User Temp folder: ${walk.userTemp.fileCount.toLocaleString('en-US')} files, ${sizeText(walk.userTemp.bytes)}; ${walk.userTemp.oldCount.toLocaleString('en-US')} files (${sizeText(walk.userTemp.oldBytes)}) not written for ${String(THRESHOLDS.tempDays)} days or more.`,
    '',
  )

  if (windows !== null) {
    out.push('## Windows-managed space', '', '| Item | Path | Size | Status |', '| --- | --- | ---: | --- |')
    for (const i of windows.items) {
      out.push(`| ${i.id} | ${md(i.path)} | ${i.status === 'ok' ? sizeText(i.bytes) : ''} | ${i.status}${i.isTruncated ? ' (partial)' : ''} |`)
    }
    out.push(
      '',
      windows.shadowStorage.status === 'ok'
        ? `Restore points: ${sizeText(windows.shadowStorage.usedBytes)} used of ${sizeText(windows.shadowStorage.maxBytes)} allowed.`
        : `Restore points: not checked (${windows.shadowStorage.detail}).`,
      '',
    )
  }

  out.push('## What was not read', '')
  out.push(`- Folders that could not be opened: ${walk.deniedFolders.toLocaleString('en-US')}.`)
  for (const p of walk.deniedSample.slice(0, 20)) out.push(`  - ${p}`)
  out.push(`- Linked folders (junctions, symbolic links, cloud folders) not followed: ${walk.linkedFolders.toLocaleString('en-US')}.`)
  for (const p of walk.linkedSample.slice(0, 20)) out.push(`  - ${p}`)
  out.push(`- Development projects found (left untouched): ${walk.projectRootCount.toLocaleString('en-US')}.`)
  out.push('')
  return out.join('\n')
}

function largestFiles({ walk, ctx }: ReportInput): string {
  const rows = (walk?.largest ?? []).map(f => {
    const rule = protectedBy(f.path, ctx) ?? (f.inProject ? 'Inside a development project' : null)
    return [
      f.path,
      f.bytes,
      sizeText(f.bytes),
      dateText(f.modifiedUtc),
      ctx.lastAccessTrusted ? dateText(f.accessedUtc) : 'not recorded',
      dateText(f.createdUtc),
      rule === null ? 'not protected' : 'protected',
      rule,
    ]
  })
  return csv(
    ['path', 'size_bytes', 'size', 'modified', 'accessed', 'created', 'class', 'protected_by'],
    rows,
  )
}

function installersAndArchives({ classified, ctx }: ReportInput): string {
  const wanted = new Set(['installer', 'archive', 'extracted_pair'])
  const rows = classified.findings
    .filter(f => wanted.has(f.category) || (f.category === 'protected' && /installer|archive/.test(String(f.evidence.values.kind))))
    .map(f => [
      f.path,
      f.category === 'protected' ? String(f.evidence.values.kind) : f.category,
      f.bytes,
      sizeText(f.bytes),
      dateText(f.modifiedUtc),
      ageDays(f.modifiedUtc, ctx.nowMs),
      f.category === 'extracted_pair' ? String(f.evidence.values.folder ?? '') : '',
      CLASS_LABEL[f.class],
      f.action,
      f.reason,
    ])
  return csv(
    ['path', 'kind', 'size_bytes', 'size', 'modified', 'age_days', 'extracted_folder', 'class', 'proposed_action', 'reason'],
    rows,
  )
}

const ACTION_TEXT: Record<Finding['action'], string> = {
  delete: 'Delete (re-creatable)',
  quarantine: 'Move to quarantine (restorable)',
  manual: 'Manual, with Windows tools',
  pc_guardian: "PC Guardian's cleanup",
  none: 'None',
}

function cleanupRecommendations({ meta, classified, recommendations }: ReportInput): string {
  const out: string[] = ['# Cleanup recommendations', '']
  out.push(`Scan ${meta.scanId}, ${meta.createdAt}. Nothing has been changed. Drive Cleanup acts only on items you approve on its Review page (coming in a later version); until then, these are for you to act on yourself.`, '')
  const r = classified.recoverable
  out.push('## Recoverable space', '')
  out.push(`- **A. Safe to clean:** ${sizeText(r.safeBytes)}`)
  out.push(`- **B. Review before cleaning:** ${sizeText(r.reviewBytes)}`)
  out.push(`- **Windows-managed (manual):** ${sizeText(r.manualBytes)}`)
  out.push('')
  out.push('| Category | Class | Items | Size | |', '| --- | --- | ---: | ---: | --- |')
  for (const t of classified.totals) {
    out.push(`| ${CATEGORY_LABEL[t.category]} | ${CLASS_LABEL[t.class]} | ${t.count.toLocaleString('en-US')} | ${sizeText(t.bytes)} | ${t.isCapped ? 'largest items only' : ''} |`)
  }
  out.push('')

  const classes: FindingClass[] = ['safe', 'review', 'protected']
  for (const cls of classes) {
    const items = classified.findings.filter(f => f.class === cls)
    out.push(`## ${CLASS_LABEL[cls]} (${items.length.toLocaleString('en-US')})`, '')
    if (cls === 'protected') {
      out.push('Shown so you can see why they are not offered. Drive Cleanup never acts on them.', '')
    }
    if (items.length === 0) {
      out.push('None.', '')
      continue
    }
    const limit = cls === 'protected' ? 100 : 500
    out.push('| Path | Size | Modified | Proposed action | Why |', '| --- | ---: | --- | --- | --- |')
    for (const f of items.slice(0, limit)) {
      out.push(`| ${md(f.path)} | ${sizeText(f.bytes)} | ${dateText(f.modifiedUtc)} | ${ACTION_TEXT[f.action]} | ${md(f.reason)} |`)
    }
    if (items.length > limit) out.push('', `…and ${(items.length - limit).toLocaleString('en-US')} more (largest shown).`)
    out.push('')
  }

  out.push('## Windows recommendations', '')
  if (recommendations.length === 0) out.push('None.', '')
  for (const rec of recommendations) {
    out.push(`### ${rec.title}`, '', rec.evidence, '')
    rec.steps.forEach((s, i) => out.push(`${String(i + 1)}. ${s}`))
    out.push('', `Risk: ${rec.risk} Undo: ${rec.undo}`, '')
  }
  return out.join('\n')
}

function cacheAnalysis({ meta, devcaches, classified }: ReportInput): string {
  const out: string[] = ['# Cache analysis', '', `Scan ${meta.scanId}, ${meta.createdAt}.`, '']
  out.push('## Developer tool caches', '')
  if (devcaches === null || devcaches === undefined) {
    out.push('Not checked in this scan.', '')
  } else {
    out.push('| Cache | Tool | Size | Files | Last written | Tool running | Class | How it is cleaned |', '| --- | --- | ---: | ---: | --- | --- | --- | --- |')
    for (const spec of DEV_CACHES) {
      const c = devcaches.caches.find(x => x.id === spec.id)
      if (c === undefined || !c.isPresent) continue
      out.push(
        `| ${md(spec.label)} | ${md(spec.tool)} | ${sizeText(c.bytes)}${c.isTruncated ? ' (partial)' : ''} | ${c.fileCount.toLocaleString('en-US')} | ${dateText(c.lastWriteUtc)} | ${c.isRunning ? 'yes' : 'no'} | ${spec.cls === 'safe' ? 'A. Safe' : 'B. Manual'} | ${md(spec.how)} |`,
      )
    }
    const absent = DEV_CACHES.filter(spec => !devcaches.caches.some(c => c.id === spec.id && c.isPresent)).map(s => s.label)
    if (absent.length > 0) out.push('', `Not present on this PC: ${absent.join(', ')}.`)
    out.push('')
  }
  out.push('## Build caches inside projects', '')
  const builds = classified.findings.filter(f => f.category === 'build_cache')
  if (builds.length === 0) out.push('None found.', '')
  else {
    out.push('| Folder | Size | Last written |', '| --- | ---: | --- |')
    for (const f of builds.slice(0, 200)) out.push(`| ${md(f.path)} | ${sizeText(f.bytes)} | ${dateText(f.modifiedUtc)} |`)
    out.push('', 'Only these folders are ever offered; node_modules, lock files, sources and .git never are.', '')
  }
  out.push('Drive Cleanup never uninstalls tools and never runs their commands; manual steps are for you to run.', '')
  return out.join('\n')
}

function duplicateFiles({ hash, classified, ctx }: ReportInput): string {
  const rows = classified.findings
    .filter(f => f.duplicate !== undefined)
    .sort((a, b) => (a.duplicate?.groupId ?? '').localeCompare(b.duplicate?.groupId ?? '') || Number(b.duplicate?.isSuggestedKeeper) - Number(a.duplicate?.isSuggestedKeeper))
    .map(f => [
      f.duplicate?.groupId ?? '',
      f.category === 'duplicate_folder' || (f.isFolder && f.category === 'protected') ? 'folder' : 'file',
      f.duplicate?.sha256 ?? '',
      f.bytes,
      sizeText(f.bytes),
      extensionText(f.path),
      f.path,
      dateText(f.modifiedUtc),
      ctx.lastAccessTrusted ? dateText(f.accessedUtc) : 'not recorded',
      f.duplicate?.isSuggestedKeeper === true ? 'yes' : 'no',
      f.duplicate?.keeperReason ?? '',
      f.protectedBy,
    ])
  const header = ['group_id', 'kind', 'sha256', 'size_bytes', 'size', 'extension', 'path', 'modified', 'accessed', 'is_suggested_keeper', 'keeper_reason', 'protected_by']
  if (hash === null || hash === undefined) {
    return csv(header, [['', '', '', '', '', '', 'Duplicate search was off or did not run in this scan.', '', '', '', '', '']])
  }
  return csv(header, rows)
}

const extensionText = (path: string): string => {
  const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

export type Verification = {
  at: string
  scanId: string | null
  freeBeforeBytes: number | null
  freeAfterBytes: number | null
  reportedFreedBytes: number
  quarantinedOnSystemDriveBytes: number
  verify: RawVerify | null
  verifyDetail: string | null
  runs: { runId: string; kind: string; startedAt: string; summary: string }[]
}

export function finalReport(v: Verification): string {
  const out: string[] = ['# Final cleanup report', '', `Verified ${v.at}${v.scanId === null ? '' : `, after scan ${v.scanId}`}. Read-only: verifying changed nothing.`, '']
  out.push('## Space', '')
  if (v.freeBeforeBytes !== null && v.freeAfterBytes !== null) {
    out.push(`- Free on the system drive at the scan: ${sizeText(v.freeBeforeBytes)}`)
    out.push(`- Free now: ${sizeText(v.freeAfterBytes)}`)
    out.push(`- Difference: ${sizeText(Math.max(0, v.freeAfterBytes - v.freeBeforeBytes))}${v.freeAfterBytes < v.freeBeforeBytes ? ' (less than at the scan: other programs wrote meanwhile)' : ''}`)
  } else {
    out.push('- Free space before or after: not checked.')
  }
  out.push(`- What the cleanups reported: ${sizeText(v.reportedFreedBytes)} deleted or moved.`)
  if (v.quarantinedOnSystemDriveBytes > 0) {
    out.push(`- ${sizeText(v.quarantinedOnSystemDriveBytes)} is quarantined on the system drive itself: it frees space there only once that quarantine is deleted for good.`)
  }
  out.push('', 'The two figures differ when other programs write to the drive, or when quarantine is on the same drive.', '')
  out.push('## Cleanups since the scan', '')
  if (v.runs.length === 0) out.push('None.')
  for (const r of v.runs) out.push(`- ${r.startedAt.slice(0, 16).replace('T', ' ')} ${r.kind}: ${r.summary}`)
  out.push('')
  out.push('## Checks', '')
  if (v.verify === null) {
    out.push(`Not checked: ${v.verifyDetail ?? 'the check did not run'}.`, '')
  } else {
    out.push('### Developer tools', '', '| Tool | Status | Version |', '| --- | --- | --- |')
    for (const t of v.verify.tools) out.push(`| ${t.id} | ${t.status === 'ok' ? 'found' : t.status === 'not_found' ? 'not on PATH' : 'could not be read'} | ${md(t.version)} |`)
    const missing = v.verify.projects.filter(p => !p.exists || !p.hasGit)
    out.push('', '### Projects', '', `${String(v.verify.projects.length)} projects from the scan checked; ${String(missing.length)} missing or without .git.`)
    for (const p of missing.slice(0, 50)) out.push(`- ${p.path}: ${p.exists ? 'no .git folder (may never have had one)' : 'missing'}`)
    out.push('', '### Quarantine', '')
    if (v.verify.quarantine.length === 0) out.push('No active quarantine.')
    for (const q of v.verify.quarantine) {
      out.push(`- Run ${q.runId}: ${String(q.matched)} of ${String(q.checked)} items intact${q.missing > 0 ? `, ${String(q.missing)} missing` : ''}${q.mismatched > 0 ? `, **${String(q.mismatched)} changed**` : ''}.`)
    }
    out.push('', '### Windows integrity', '')
    out.push(
      'Not checked by Drive Cleanup: it never touches Windows files, and a full check takes a long time and needs administrator rights. To check yourself, in an administrator terminal: `sfc /verifyonly` (or `sfc /scannow` to repair).',
    )
  }
  out.push('')
  return out.join('\n')
}
