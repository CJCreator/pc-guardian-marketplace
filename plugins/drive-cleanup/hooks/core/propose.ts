// One-confirm cleanup (PLAN.md §19): turns what Claude proposes into a
// selection the planner checks, and writes the single question the person
// answers. Pure, so every rule here is unit-tested. Claude only proposes: the
// planner (plan.ts) and the action scripts still refuse anything protected,
// and nothing runs until the person answers the dialog.

import { CATEGORY_LABEL } from './classify.ts'
import { sizeText } from './format.ts'
import { checkTasks, type ElevatedTaskId } from './elevated.ts'
import type { CategoryId, Finding, FindingClass } from './types.ts'

/** The most items one proposal may hold. */
export const MAX_PROPOSAL_ITEMS = 500
/** After the person declines, new proposals are refused for this long. */
export const DECLINE_COOLDOWN_MS = 5 * 60_000

export type ProposalInput = {
  findingIds?: readonly string[]
  categories?: readonly CategoryId[]
  classes?: readonly Exclude<FindingClass, 'protected'>[]
  /** Stop adding items, largest first, once this many bytes are chosen. */
  maxBytes?: number
  /** Administrator tasks (core/elevated.ts), by id. */
  elevatedTasks?: readonly string[]
}

export type Selection =
  | { status: 'ok'; ids: string[]; skipped: string[]; elevated: ElevatedTaskId[] }
  | { status: 'refused'; message: string }

/** What Drive Cleanup can act on at all; the planner checks again. */
export const isActionable = (f: Finding): boolean =>
  f.class !== 'protected' &&
  f.protectedBy === null &&
  (f.action === 'delete' || f.action === 'quarantine') &&
  f.duplicate?.isSuggestedKeeper !== true

/**
 * Resolves a proposal to finding ids. Named ids must exist and be
 * actionable, or the whole proposal is refused (Claude named something it
 * should not). Categories and classes pick actionable findings only, largest
 * first, never a duplicate group's suggested keeper.
 */
export function selectForProposal(findings: readonly Finding[], input: ProposalInput): Selection {
  const hasIds = input.findingIds !== undefined && input.findingIds.length > 0
  const hasFilter =
    (input.categories !== undefined && input.categories.length > 0) ||
    (input.classes !== undefined && input.classes.length > 0)
  const elevatedIn = input.elevatedTasks ?? []
  const checkedTasks = checkTasks(elevatedIn)
  if (checkedTasks.status !== 'ok') return checkedTasks
  const elevated = checkedTasks.tasks
  if (hasIds && hasFilter) return { status: 'refused', message: 'Name findingIds, or categories/classes, not both.' }
  if (!hasIds && !hasFilter) {
    if (elevated.length > 0) return { status: 'ok', ids: [], skipped: [], elevated }
    return { status: 'refused', message: 'Name findingIds, or categories and/or classes, and/or elevatedTasks.' }
  }

  const byId = new Map(findings.map(f => [f.id, f]))
  let chosen: Finding[]
  const skipped: string[] = []
  if (hasIds) {
    chosen = []
    for (const id of new Set(input.findingIds)) {
      const f = byId.get(id)
      if (f === undefined) return { status: 'refused', message: `${id} is not in the latest scan. Use get_findings.` }
      if (!isActionable(f)) {
        const why =
          f.class === 'protected' || f.protectedBy !== null
            ? 'is protected'
            : f.duplicate?.isSuggestedKeeper === true
              ? 'is the copy to keep in its duplicate group'
              : 'is not cleaned by Drive Cleanup'
        return { status: 'refused', message: `${f.path} ${why}; leave it out.` }
      }
      chosen.push(f)
    }
  } else {
    // The Recycle Bin holds the person's own deleted files: only when named by category or id.
    const namesBin = input.categories?.includes('recycle_bin') === true
    chosen = findings.filter(
      f =>
        isActionable(f) &&
        (f.category !== 'recycle_bin' || namesBin) &&
        (input.categories === undefined || input.categories.length === 0 || input.categories.includes(f.category)) &&
        (input.classes === undefined ||
          input.classes.length === 0 ||
          (input.classes as readonly FindingClass[]).includes(f.class)),
    )
  }
  chosen = chosen.toSorted((a, b) => b.bytes - a.bytes)
  if (input.maxBytes !== undefined) {
    let total = 0
    chosen = chosen.filter(f => {
      if (total + f.bytes > (input.maxBytes ?? 0)) {
        skipped.push(f.id)
        return false
      }
      total += f.bytes
      return true
    })
  }
  if (chosen.length > MAX_PROPOSAL_ITEMS) {
    skipped.push(...chosen.slice(MAX_PROPOSAL_ITEMS).map(f => f.id))
    chosen = chosen.slice(0, MAX_PROPOSAL_ITEMS)
  }
  if (chosen.length === 0 && elevated.length === 0)
    return { status: 'refused', message: 'Nothing in the latest scan matches that proposal.' }
  return { status: 'ok', ids: chosen.map(f => f.id), skipped, elevated }
}

const short = (path: string, max = 70): string => (path.length <= max ? path : `…${path.slice(-(max - 1))}`)

/** What the dialog needs to know about the plan: from the planner, never from Claude. */
export type QuestionPlan = {
  deleteBytes: number
  quarantineBytes: number
  /** Where quarantined items go, or ''. */
  quarantineRoot: string
  /** The system drive, to say when a quarantine on it frees nothing yet. */
  systemDrive: string
}

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

/** What the person gets back: deleted, quarantined off the system drive, and administrator estimates. */
export function freedEstimate(plan: QuestionPlan, elevatedBytes: number): number {
  const movesOff =
    plan.quarantineRoot !== '' && !plan.quarantineRoot.toUpperCase().startsWith(plan.systemDrive.toUpperCase())
  return plan.deleteBytes + (movesOff ? plan.quarantineBytes : 0) + elevatedBytes
}

/**
 * The one question the person answers, in plain words. Every number and name
 * comes from the scan and the planner, never from Claude, so a proposal
 * cannot describe itself as something it is not.
 */
export function proposalQuestion(opts: {
  findings: readonly Finding[]
  ids: readonly string[]
  plan: QuestionPlan
  isCleanupOn: boolean
  /** The administrator line from core/elevated.ts, or ''. */
  elevatedLine?: string
  /** What the administrator tasks are estimated to free (known sizes only). */
  elevatedBytes?: number
}): string {
  const byId = new Map(opts.findings.map(f => [f.id, f]))
  const items = opts.ids.map(id => byId.get(id)).filter((f): f is Finding => f !== undefined)
  const p = opts.plan
  const total = freedEstimate(p, opts.elevatedBytes ?? 0)
  const lines: string[] = [total > 0 ? `Free up about ${sizeText(total)} on ${p.systemDrive}?` : 'Run this cleanup?']
  const binBytes = items.filter(f => f.category === 'recycle_bin').reduce((sum, f) => sum + f.bytes, 0)
  const cacheBytes = Math.max(0, p.deleteBytes - binBytes)
  if (cacheBytes > 0) {
    lines.push(
      `• Delete ${sizeText(cacheBytes)} of caches and temporary files. Apps rebuild these; this cannot be undone.`,
    )
  }
  if (binBytes > 0) lines.push(`• Empty the Recycle Bin (${sizeText(binBytes)}). Those files are gone for good.`)
  if (p.quarantineBytes > 0) {
    const kinds = [...new Set(items.filter(f => f.action === 'quarantine').map(f => lower(CATEGORY_LABEL[f.category])))]
    const onSystem = p.quarantineRoot.toUpperCase().startsWith(p.systemDrive.toUpperCase())
    lines.push(
      `• Move ${sizeText(p.quarantineBytes)} of your files (${kinds.slice(0, 3).join(', ')}) to ${p.quarantineRoot}. You can put them back any time.${onSystem ? ` It is on ${p.systemDrive}, so that space comes back only when you empty it.` : ''}`,
    )
  }
  if (opts.elevatedLine !== undefined && opts.elevatedLine !== '') lines.push(`• ${opts.elevatedLine}`)
  if (items.length > 0) {
    const largest = items
      .toSorted((a, b) => b.bytes - a.bytes)
      .slice(0, 3)
      .map(f => `${short(f.path, 60)} (${sizeText(f.bytes)})`)
    lines.push(`Biggest: ${largest.join('; ')}.${items.length > 3 ? ` Plus ${String(items.length - 3)} more.` : ''}`)
  }
  if (!opts.isCleanupOn) lines.push('Cleanup is turned off now; this answer also turns it on.')
  return lines.join('\n')
}

/** The dialog's answers. The yes label names the size, so the person sees what they agree to. */
export function answers(total: number): { yes: string; review: string; cancel: string } {
  const size = total > 0 ? ` ${sizeText(total)}` : ''
  return {
    yes: size === '' ? 'Clean up' : `Free${size}`,
    review: 'Let me choose',
    cancel: 'Not now',
  }
}
