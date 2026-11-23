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
    chosen = findings.filter(
      f =>
        isActionable(f) &&
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

/**
 * The one question the person answers. It names the real totals and the
 * largest items from the scan, never Claude's words, so a proposal cannot
 * describe itself as something it is not.
 */
export function proposalQuestion(opts: {
  findings: readonly Finding[]
  ids: readonly string[]
  summary: string
  isCleanupOn: boolean
  /** The administrator line from core/elevated.ts, or ''. */
  elevatedLine?: string
}): string {
  const byId = new Map(opts.findings.map(f => [f.id, f]))
  const items = opts.ids.map(id => byId.get(id)).filter((f): f is Finding => f !== undefined)
  const largest = items
    .toSorted((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map(f => `${short(f.path)} (${sizeText(f.bytes)}, ${CATEGORY_LABEL[f.category]})`)
  const head = opts.isCleanupOn ? '' : 'Cleanup is off; answering Turn on and clean also turns it on. '
  const files =
    items.length > 0
      ? `Claude proposes cleaning ${String(items.length)} items. ${opts.summary} Largest: ${largest.join('; ')}. Quarantined items can be restored; deleted caches and temporary files cannot.`
      : 'Claude proposes Windows cleanup only.'
  const admin = opts.elevatedLine === undefined || opts.elevatedLine === '' ? '' : ` ${opts.elevatedLine}`
  return `${head}${files}${admin} Clean them?`
}

export const ANSWERS = {
  clean: 'Clean',
  turnOnAndClean: 'Turn on and clean',
  review: 'Show the list',
  cancel: 'Cancel',
} as const
