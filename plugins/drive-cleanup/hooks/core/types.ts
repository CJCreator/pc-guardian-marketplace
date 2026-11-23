// Drive Cleanup's data model. Pure types: no engine, no I/O.

export type StepId = 'volume' | 'walk' | 'devcaches' | 'leftovers' | 'windows' | 'hash'

export type NotCheckedReason = 'needs_admin' | 'timeout' | 'failed' | 'cancelled' | 'unsupported_platform' | 'disabled'

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
  /** On a USB, 1394, SD or MMC bus: it can be unplugged, so "auto" never puts quarantine there. Null when Windows does not say. */
  isExternal?: boolean | null
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
  | 'build_cache'

export const CANDIDATE_KINDS: readonly CandidateKind[] = [
  'installer',
  'archive',
  'crash_dump',
  'log',
  'temp_extract',
  'old_download',
  'large_old',
  'empty_folder',
  'build_cache',
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
  /** Folders with a path too long for Windows PowerShell 5.1 (260 characters): not read. */
  /** node_modules folders of projects (advice only, never offered), largest first; absent from older scripts. */
  nodeModules?: { path: string; bytes: number; fileCount: number; modifiedUtc: string }[]
  longPathFolders: number
  longPathSample: string[]
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

/** ps/scan/dev-caches.ps1: one known developer cache. */
export type RawDevCache = {
  id: string
  isPresent: boolean
  bytes: number
  fileCount: number
  lastWriteUtc: string | null
  isRunning: boolean
  isTruncated: boolean
  roots: { path: string; status: 'ok' | 'missing' | 'denied'; bytes: number; fileCount: number }[]
}

export type RawDevCaches = { caches: RawDevCache[] }

/** ps/scan/leftovers.ps1 */
export type RawLeftovers = {
  installedCount: number
  folders: {
    path: string
    bytes: number
    fileCount: number
    lastWriteUtc: string
    isTruncated: boolean
  }[]
}

export type RawDuplicateFile = {
  path: string
  modifiedUtc: string
  accessedUtc: string
  createdUtc: string
}

/** ps/scan/hash.ps1 (opt-in: reads file contents) */
export type RawHash = {
  elapsedMs: number
  isTruncated: boolean
  /** When truncated: the next run starts with files smaller than this. */
  resumeBelowBytes: number | null
  filesConsidered: number
  filesHashed: number
  bytesHashed: number
  skippedLocked: number
  /** Files in a size group too big to hash in the time left (null from older scripts). */
  skippedTooBig?: number | null
  skippedCloud: number
  groups: { sha256: string; bytes: number; files: RawDuplicateFile[] }[]
  folderGroups: { signature: string; bytes: number; fileCount: number; folders: string[] }[]
}

/** ps/scan/verify.ps1 */
export type RawVerify = {
  isElevated: boolean
  tools: { id: string; status: 'ok' | 'not_found' | 'failed'; version: string }[]
  projects: { path: string; exists: boolean; hasGit: boolean }[]
  /** notHashed: present but not compared by SHA-256 (verify's time limit); null from older scripts. */
  quarantine: {
    runId: string
    checked: number
    matched: number
    missing: number
    mismatched: number
    notHashed?: number | null
  }[]
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
  | 'build_cache'
  | 'dev_cache_safe'
  | 'dev_cache_review'
  | 'browser_cache'
  | 'recycle_bin'
  | 'leftover'
  | 'duplicate'
  | 'duplicate_folder'
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
  /** Developer caches: the cache id clean-cache.ps1 knows. */
  cacheId?: string
  duplicate?: { groupId: string; sha256: string; isSuggestedKeeper: boolean; keeperReason: string }
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

// ------------------------------------------------------------------ actions

export type ApprovedItem = {
  id: string
  path: string
  isFolder: boolean
  action: 'delete' | 'quarantine'
  category: CategoryId
  bytes: number
  modifiedUtc: string
  sha256: string | null
}

/** runs/pending/<runId>.json: what apply.ps1 reads. */
export type ApprovedList = {
  runId: string
  scanId: string
  approvedAt: string
  scanFinishedAt: string
  quarantineRoot: string
  items: ApprovedItem[]
}

export type ItemResult = {
  id: string
  status: 'deleted' | 'quarantined' | 'restored' | 'skipped'
  detail: string
  destination: string | null
  sha256: string | null
  bytes: number
}

/** apply.ps1 and restore.ps1 */
export type RawApply =
  | {
      status: 'ok'
      runId: string
      quarantineDir: string | null
      deletedBytes: number
      quarantinedBytes: number
      restoredBytes: number
      isTruncated: boolean
      items: ItemResult[]
    }
  | { status: 'refused'; reason: string; detail: string }

/** clean-cache.ps1 */
export type RawCacheClean =
  | { status: 'ok'; removedCount: number; removedBytes: number; skippedCount: number; isTruncated?: boolean | null }
  | { status: 'refused'; reason: string; detail: string }

/** elevated.ps1, one task's result. */
export type RawElevatedTask = {
  id: string
  status: 'done' | 'skipped' | 'failed' | 'missing'
  removedBytes: number
  removedCount: number
  skippedCount: number
  detail: string
}

/** elevated.ps1, through the bootstrap's result file. */
export type RawElevated =
  { status: 'ok'; tasks: RawElevatedTask[] } | { status: 'refused'; reason: string; detail: string }

/** The launcher's one line: whether Windows started the elevated part. */
export type RawElevatedLaunch = { status: 'ran'; exitCode: number } | { status: 'declined' } | { status: 'failed' }

/** purge.ps1 */
export type RawPurge =
  | { status: 'ok'; runId: string; removedCount: number; removedBytes: number; failedCount: number }
  | { status: 'refused'; reason: string; detail: string }

export type Settings = {
  cleanupEnabled: boolean
  duplicatesEnabled: boolean
  /** 'auto', or a drive letter such as 'D:'. */
  quarantineDrive: string
  minDuplicateBytes: number
  maxHashBytes: number
}

export const DEFAULT_SETTINGS: Settings = {
  cleanupEnabled: false,
  duplicatesEnabled: false,
  quarantineDrive: 'auto',
  minDuplicateBytes: 1024 * 1024,
  maxHashBytes: 4 * 1024 ** 3,
}

/** One cleanup, restore or purge, as the run log keeps it. */
export type RunRecord = {
  runId: string
  kind: 'cleanup' | 'restore' | 'purge'
  scanId: string | null
  startedAt: string
  finishedAt: string
  quarantineRoot: string | null
  quarantineDir: string | null
  deletedBytes: number
  quarantinedBytes: number
  restoredBytes: number
  purgedBytes: number
  counts: { done: number; skipped: number }
  /** Per item, joined with what the scan knew (for the manifest). */
  items: (ItemResult & { path: string; category: string; reason: string; action: string })[]
  messages: string[]
}
