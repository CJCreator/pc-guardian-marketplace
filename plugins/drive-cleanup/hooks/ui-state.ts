import type { EngineInterface } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { DcActivity, DcSelection, DcView } from '../types'

// The pane's own state: which view is open, what the person selected, and
// what a cleanup is doing now. Session state only.

const viewAtom = atom({ plugin: 'drive-cleanup', key: 'view' } as const, { name: 'overview', category: null, page: 0 }, {
  shape: 'view-1',
})
const selectionAtom = atom({ plugin: 'drive-cleanup', key: 'selection' } as const, { scanId: '', ids: [] }, {
  shape: 'selection-1',
})
const activityAtom = atom({ plugin: 'drive-cleanup', key: 'activity' } as const, { state: 'idle', message: null }, {
  shape: 'activity-1',
})

export async function readView($: EngineInterface): Promise<DcView> {
  return read($, viewAtom)
}

export async function readSelection($: EngineInterface): Promise<DcSelection> {
  return read($, selectionAtom)
}

export async function readActivity($: EngineInterface): Promise<DcActivity> {
  return read($, activityAtom)
}

export async function setView($: EngineInterface, change: Partial<DcView>): Promise<void> {
  await update($, viewAtom, v => ({ ...v, ...change }))
}

export async function setSelection($: EngineInterface, change: (s: DcSelection) => DcSelection): Promise<void> {
  await update($, selectionAtom, change)
}

export async function setActivity($: EngineInterface, activity: DcActivity): Promise<void> {
  await update($, activityAtom, () => activity)
}
