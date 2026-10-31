// Drive Cleanup's data model. Pure types: no engine, no I/O.

export type StepId = 'volume' | 'walk' | 'windows'

export type NotCheckedReason =
  'needs_admin' | 'timeout' | 'failed' | 'cancelled' | 'unsupported_platform'

export type NotChecked = { status: 'not_checked'; reason: NotCheckedReason; detail: string }

export type ScriptRun = { status: 'ok'; stdout: string } | NotChecked

export type Parsed<T> = { status: 'ok'; data: T } | NotChecked

// ---------------------------------------------------------------- raw output

export type RawDrive = {
  letter: string
  label: string
  fileSystem: string
  totalBytes: number
  freeBytes: number
  isSystem: boolean
  mediaType: number | null
  healthStatus: string | null
}

/** ps/scan/volume.ps1 */
export type RawVolume = {
  isElevated: boolean
  windowsVersion: string
  systemDrive: string
  systemRoot: string
  userProfile: string
  profilesRoot: string
  appData: string
  localAppData: string
  temp: string
  downloads: string
  drives: RawDrive[]
  storageSense: { isEnabled: boolean | null; cadenceDays: number | null }
  lastAccess: { isUpdated: boolean | null; rawValue: number | null }
}

export type CandidateKind =
  | 'installer'
  | 'archive'
  | 'crash_dump'
  | 'log'
  | 'temp_extract'
  | 'old_download'
  | 'large_old'
  | 'empty_folder'

export const CANDIDATE_KINDS: readonly CandidateKind[] = [
  'installer',
  'archive',
  'crash_dump',
  'log',
  'temp_extract',
  'old_download',
  'large_old',
  'empty_folder',
]

export type RawFile = {
  path: string
  bytes: number
  modifiedUtc: string
  accessedUtc: string
  createdUtc: string
  inProject: boolean
}

export type RawCandidate = {
  kind: CandidateKind
  path: string
  bytes: number
  fileCount: number
  isFolder: boolean
  modifiedUtc: string
  accessedUtc: string
  createdUtc: string
  inProject: boolean
  /** Archives only: a sibling folder with the archive's name, by name alone. */
  extractedFolder: string | null
}

/** ps/scan/walk.ps1 */
export type RawWalk = {
  root: string
  elapsedMs: number
  isTruncated: boolean
  entryCount: number
  deniedFolders: number
  deniedSample: string[]
  linkedFolders: number
  linkedSample: string[]
  totals: { fileCount: number; folderCount: number; bytes: number }
  protectedRoots: { path: string; bytes: number; fileCount: number }[]
  ages: {
    modifiedOver12m: { count: number; bytes: number }
    accessedOver6m: { count: number; bytes: number }
  }
  extensions: { extension: string; fileCount: number; bytes: number }[]
  folders: { path: string; depth: number; bytes: number; fileCount: number }[]
  largest: RawFile[]
  candidates: RawCandidate[]
  candidateTotals: { kind: CandidateKind; count: number; bytes: number; isCapped: boolean }[]
  userTemp: { fileCount: number; bytes: number; oldCount: number; oldBytes: number }
  projectRootCount: number
  projectRootSample: string[]
}

export type WindowsItemId =
  | 'update_cache'
  | 'windows_old'
  | 'windows_temp'
  | 'minidump'
  | 'memory_dmp'
  | 'live_kernel_reports'
  | 'hiberfil'
  | 'pagefile'
  | 'swapfile'
  | 'recycle_bin'

export type RawWindowsItem = {
  id: WindowsItemId
  path: string
  status: 'ok' | 'missing' | 'denied'
  bytes: number
  fileCount: number
  isTruncated: boolean
}

/** ps/scan/windows.ps1 */
export type RawWindows = {
  isElevated: boolean
  items: RawWindowsItem[]
  hibernation: { isEnabled: boolean | null }
  shadowStorage: { status: 'ok' | 'not_checked'; usedBytes: number; maxBytes: number; detail: string }
}

// ------------------------------------------------------------------ findings

export type FindingClass = 'safe' | 'review' | 'protected'
export type ProposedAction = 'delete' | 'quarantine' | 'none' | 'manual' | 'pc_guardian'
export type Confidence = 'high' | 'medium' | 'low'

export type CategoryId =
  | 'user_temp'
  | 'temp_extract'
  | 'crash_dumps'
  | 'app_logs'
  | 'installer'
  | 'archive'
  | 'extracted_pair'
  | 'old_download'
  | 'large_old'
  | 'empty_folder'
  | 'windows_managed'
  | 'protected'

export type Finding = {
  id: string
  category: CategoryId
  class: FindingClass
  action: ProposedAction
  path: string
  bytes: number
  fileCount: number
  isFolder: boolean
  modifiedUtc: string | null
  accessedUtc: string | null
  reason: string
  evidence: { rule: string; values: Record<string, string | number> }
  confidence: Confidence
  protectedBy: string | null
}

/** What classification needs to know about this PC, from volume.ps1 and the mod. */
export type ClassifyContext = {
  nowMs: number
  systemDrive: string
  systemRoot: string
  userProfile: string
  profilesRoot: string
  appData: string
  localAppData: string
  temp: string
  downloads: string
  dataFolder: string
  isPcGuardianInstalled: boolean
  lastAccessTrusted: boolean
}

export type CategoryTotal = {
  category: CategoryId
  class: FindingClass
  count: number
  bytes: number
  isCapped: boolean
}

export type Recommendation = {
  id: string
  title: string
  severity: 'info' | 'suggested' | 'important'
  evidence: string
  steps: string[]
  risk: string
  undo: string
  estimatedBytes: number | null
}

export type StepState = 'pending' | 'running' | 'ok' | 'not_checked'

export type StepStatus = {
  id: StepId
  label: string
  state: StepState
  durationMs: number | null
  notChecked: NotChecked | null
  isTruncated: boolean
}

export type ScanMeta = {
  scanId: string
  createdAt: string
  finishedAt: string
  steps: StepStatus[]
  isPcGuardianInstalled: boolean
  dataFolder: string
}
