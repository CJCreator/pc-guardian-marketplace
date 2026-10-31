// The audit files (PLAN.md §12) that M1 writes: storage_audit.md,
// largest_files.csv, installers_and_archives.csv, cleanup_recommendations.md.
// Pure: text in, text out. The mod writes them with the safe writer.

import { CATEGORY_LABEL, CLASS_LABEL, THRESHOLDS, type Classified } from './classify.ts'
import { ageDays, dateText, percentText, sizeText } from './format.ts'
import { protectedBy } from './paths.ts'
import type {
  ClassifyContext,
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
