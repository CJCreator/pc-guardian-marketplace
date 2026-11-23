// Synthetic scan output for unit tests, shaped exactly as the scripts print
// it. These are hand-made, not recordings from a real PC: replace them with
// recorded (and anonymised) output once M1 has run on real machines.

import type { ClassifyContext, RawCandidate, RawVolume, RawWalk, RawWindows } from '../../hooks/core/types.ts'

export const NOW = Date.parse('2026-10-31T12:00:00Z')
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString()

export const PROFILE = 'C:\\Users\\Asha'

export const ctx = (over: Partial<ClassifyContext> = {}): ClassifyContext => ({
  nowMs: NOW,
  systemDrive: 'C:',
  systemRoot: 'C:\\Windows',
  userProfile: PROFILE,
  profilesRoot: 'C:\\Users',
  appData: `${PROFILE}\\AppData\\Roaming`,
  localAppData: `${PROFILE}\\AppData\\Local`,
  temp: `${PROFILE}\\AppData\\Local\\Temp`,
  downloads: `${PROFILE}\\Downloads`,
  dataFolder: `${PROFILE}\\AppData\\Roaming\\techgramam-drive-cleanup`,
  isPcGuardianInstalled: false,
  lastAccessTrusted: false,
  ...over,
})

export const candidate = (over: Partial<RawCandidate> & Pick<RawCandidate, 'kind' | 'path'>): RawCandidate => ({
  bytes: 10 * 1024 * 1024,
  fileCount: 1,
  isFolder: false,
  modifiedUtc: daysAgo(400),
  accessedUtc: daysAgo(400),
  createdUtc: daysAgo(500),
  inProject: false,
  extractedFolder: null,
  ...over,
})

export const volume = (over: Partial<RawVolume> = {}): RawVolume => ({
  isElevated: false,
  windowsVersion: 'Microsoft Windows 11 Pro 10.0.26100',
  systemDrive: 'C:',
  systemRoot: 'C:\\Windows',
  userProfile: PROFILE,
  profilesRoot: 'C:\\Users',
  appData: `${PROFILE}\\AppData\\Roaming`,
  localAppData: `${PROFILE}\\AppData\\Local`,
  temp: `${PROFILE}\\AppData\\Local\\Temp`,
  downloads: `${PROFILE}\\Downloads`,
  drives: [
    {
      letter: 'C:',
      label: 'OS',
      fileSystem: 'NTFS',
      totalBytes: 512 * 1024 ** 3,
      freeBytes: 80 * 1024 ** 3,
      isSystem: true,
      mediaType: 4,
      healthStatus: 'Healthy',
    },
  ],
  storageSense: { isEnabled: false, cadenceDays: null },
  lastAccess: { isUpdated: false, rawValue: 2147483651 },
  ...over,
})

export const walk = (candidates: RawCandidate[] = []): RawWalk => ({
  root: 'C:\\',
  elapsedMs: 81_000,
  isTruncated: false,
  entryCount: 900_000,
  deniedFolders: 12,
  deniedSample: ['C:\\Windows\\CSC'],
  longPathFolders: 0,
  longPathSample: [],
  linkedFolders: 3,
  linkedSample: [`${PROFILE}\\OneDrive`],
  totals: { fileCount: 850_000, folderCount: 50_000, bytes: 400 * 1024 ** 3 },
  protectedRoots: [{ path: 'C:\\Windows', bytes: 30 * 1024 ** 3, fileCount: 300_000 }],
  ages: {
    modifiedOver12m: { count: 300_000, bytes: 120 * 1024 ** 3 },
    accessedOver6m: { count: 400_000, bytes: 150 * 1024 ** 3 },
  },
  extensions: [{ extension: '.mp4', fileCount: 120, bytes: 60 * 1024 ** 3 }],
  folders: [
    { path: 'C:\\Users', depth: 1, bytes: 250 * 1024 ** 3, fileCount: 400_000 },
    { path: PROFILE, depth: 2, bytes: 240 * 1024 ** 3, fileCount: 390_000 },
  ],
  largest: [
    {
      path: 'C:\\pagefile.sys',
      bytes: 16 * 1024 ** 3,
      modifiedUtc: daysAgo(1),
      accessedUtc: daysAgo(1),
      createdUtc: daysAgo(300),
      inProject: false,
    },
    {
      path: `${PROFILE}\\Videos\\holiday=1+1.mp4`,
      bytes: 8 * 1024 ** 3,
      modifiedUtc: daysAgo(800),
      accessedUtc: daysAgo(800),
      createdUtc: daysAgo(800),
      inProject: false,
    },
  ],
  candidates,
  candidateTotals: [
    { kind: 'installer', count: 1500, bytes: 40 * 1024 ** 3, isCapped: true },
    { kind: 'archive', count: 2, bytes: 1024 ** 3, isCapped: false },
  ],
  userTemp: { fileCount: 5000, bytes: 3 * 1024 ** 3, oldCount: 4000, oldBytes: 2 * 1024 ** 3 },
  projectRootCount: 14,
  projectRootSample: [`${PROFILE}\\source\\shop`],
})

export const windows = (): RawWindows => ({
  isElevated: false,
  items: [
    {
      id: 'update_cache',
      path: 'C:\\Windows\\SoftwareDistribution\\Download',
      status: 'ok',
      bytes: 3 * 1024 ** 3,
      fileCount: 40,
      isTruncated: false,
    },
    { id: 'windows_old', path: 'C:\\Windows.old', status: 'missing', bytes: 0, fileCount: 0, isTruncated: false },
    { id: 'hiberfil', path: 'C:\\hiberfil.sys', status: 'ok', bytes: 12 * 1024 ** 3, fileCount: 1, isTruncated: false },
    {
      id: 'recycle_bin',
      path: 'C:\\$Recycle.Bin\\S-1-5-21',
      status: 'ok',
      bytes: 500 * 1024 ** 2,
      fileCount: 20,
      isTruncated: false,
    },
  ],
  hibernation: { isEnabled: true },
  shadowStorage: { status: 'not_checked', usedBytes: 0, maxBytes: 0, detail: 'Needs administrator rights.' },
})
