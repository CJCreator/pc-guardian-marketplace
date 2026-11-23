// Windows path handling and the protected-path rules (PLAN.md §2.2).
//
// A path matched here is class C: shown, never offered for any action. The
// action scripts (M4) repeat these rules on their own; this is the first of
// two independent checks, never the only one.

import type { ClassifyContext } from './types.ts'

/**
 * A comparable form of a Windows path: `\\?\` and `\\?\UNC\` prefixes
 * removed, forward slashes made backslashes, repeated separators collapsed,
 * trailing dots and spaces dropped from each segment (Windows ignores them),
 * no trailing separator except a drive root, lower case (NTFS is case
 * insensitive for these purposes).
 */
export function normalizePath(path: string): string {
  let p = path.replaceAll('/', '\\')
  if (p.startsWith('\\\\?\\UNC\\')) p = `\\\\${p.slice(8)}`
  else if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\')) p = p.slice(4)
  const isUnc = p.startsWith('\\\\')
  const segments = p
    .split('\\')
    .filter(s => s !== '')
    .map(s => (/^[.]+$/.test(s) ? s : s.replace(/[. ]+$/, '')))
  let out = segments.join('\\')
  if (isUnc) out = `\\\\${out}`
  if (/^[A-Za-z]:$/.test(out)) out += '\\'
  return out.toLowerCase()
}

/** True when `path` is `root` or inside it (both normalised). */
export function isUnder(path: string, root: string): boolean {
  const p = normalizePath(path)
  const r = normalizePath(root)
  if (p === r) return true
  return p.startsWith(r.endsWith('\\') ? r : `${r}\\`)
}

export function baseName(path: string): string {
  const p = path.replace(/[\\/]+$/, '')
  const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return cut < 0 ? p : p.slice(cut + 1)
}

export function parentPath(path: string): string {
  const p = path.replace(/[\\/]+$/, '')
  const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return cut < 0 ? '' : p.slice(0, cut)
}

export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

const join = (root: string, ...parts: string[]): string => [root.replace(/[\\/]+$/, ''), ...parts].join('\\')

// ------------------------------------------------------------------ rules

const SYSTEM_ROOT_FOLDERS = [
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'Recovery',
  'System Volume Information',
  '$Recycle.Bin',
  '$WinREAgent',
  '$Windows.~BT',
  '$Windows.~WS',
  'Boot',
  'EFI',
  'Config.Msi',
  'PerfLogs',
] as const

const ROOT_SYSTEM_FILES = new Set([
  'bootmgr',
  'bootnxt',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'dumpstack.log',
  'dumpstack.log.tmp',
])

const SHARED_PROFILES = ['Default', 'Default User', 'Public', 'All Users'] as const

const CREDENTIAL_FOLDERS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.gcloud'])
const CREDENTIAL_NAMES = new Set(['.npmrc', '.pypirc', '.git-credentials', '.netrc', '_netrc', '.pgpass'])
const CREDENTIAL_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.pfx',
  '.p12',
  '.crt',
  '.cer',
  '.ppk',
  '.kdbx',
  '.keychain',
  '.jks',
  '.keystore',
])
const DATABASE_EXTENSIONS = new Set([
  '.db',
  '.sqlite',
  '.sqlite3',
  '.db-wal',
  '.db-shm',
  '.mdf',
  '.ldf',
  '.accdb',
  '.mdb',
  '.pst',
  '.ost',
  '.edb',
])
const DRIVER_EXTENSIONS = new Set(['.sys', '.inf', '.cat'])

const EDITOR_DATA = ['Code', 'Code - Insiders', 'Cursor', 'Antigravity', 'VSCodium'] as const

/** Inside an editor's data folder, only these re-creatable caches are not protected. */
const EDITOR_CACHE_PARTS = ['Cache', 'CachedData', 'CachedExtensionVSIXs', 'Code Cache', 'GPUCache', 'logs'] as const

/** Profile-relative locations Windows or apps own outright. */
const PROFILE_PROTECTED: readonly { parts: string[]; rule: string }[] = [
  { parts: ['AppData', 'Local', 'Packages'], rule: 'Microsoft Store app data' },
  { parts: ['AppData', 'Roaming', 'Microsoft'], rule: 'Windows settings and credentials' },
  { parts: ['AppData', 'Local', 'Microsoft', 'Credentials'], rule: 'Windows credentials' },
  { parts: ['AppData', 'Local', 'Microsoft', 'Vault'], rule: 'Windows credentials' },
  { parts: ['AppData', 'Local', 'Microsoft', 'Edge', 'User Data'], rule: 'Browser profile' },
  { parts: ['AppData', 'Local', 'Google', 'Chrome', 'User Data'], rule: 'Browser profile' },
  {
    parts: ['AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'],
    rule: 'Browser profile',
  },
  { parts: ['AppData', 'Roaming', 'Opera Software'], rule: 'Browser profile' },
  { parts: ['AppData', 'Roaming', 'Mozilla', 'Firefox'], rule: 'Browser profile' },
  { parts: ['AppData', 'Local', 'Programs'], rule: 'Installed programs' },
  { parts: ['.vscode', 'extensions'], rule: 'Editor extensions' },
  { parts: ['.antigravity'], rule: 'Editor data' },
  { parts: ['.cursor'], rule: 'Editor data' },
  ...EDITOR_DATA.map(name => ({ parts: ['AppData', 'Roaming', name], rule: 'Editor data' })),
]

/** `AppData\Local\Microsoft\Windows` is protected except these re-creatable caches. */
const WINDOWS_PROFILE_EXCEPTIONS = [['INetCache'], ['Explorer']] as const

/**
 * The §2.2 rule that protects `path`, or null. `isFolder` matters only for
 * rules about file names.
 */
export function protectedBy(path: string, ctx: ClassifyContext, isFolder = false): string | null {
  const p = normalizePath(path)
  const drive = normalizePath(ctx.systemDrive)

  // Drive Cleanup's own data and quarantine.
  if (isUnder(p, ctx.dataFolder)) return "Drive Cleanup's own data"
  if (/\\drive cleanup quarantine(\\|$)/.test(p)) return 'Drive Cleanup quarantine'

  // System locations.
  if (isUnder(p, ctx.systemRoot)) return 'Windows system folder'
  for (const folder of SYSTEM_ROOT_FOLDERS) {
    if (isUnder(p, join(drive, folder))) return `System location (${folder})`
  }
  if (normalizePath(parentPath(p)) === drive && ROOT_SYSTEM_FILES.has(baseName(p))) {
    return 'Windows boot or memory file'
  }

  // Profiles other than this user's.
  if (isUnder(p, ctx.profilesRoot) && !isUnder(p, ctx.userProfile)) {
    for (const shared of SHARED_PROFILES) {
      if (isUnder(p, join(ctx.profilesRoot, shared))) return `Shared profile (${shared})`
    }
    if (normalizePath(p) !== normalizePath(ctx.profilesRoot)) return "Another user's profile"
  }

  // Locations inside this user's profile owned by Windows or apps.
  if (isUnder(p, ctx.userProfile)) {
    const windowsData = join(ctx.userProfile, 'AppData', 'Local', 'Microsoft', 'Windows')
    if (isUnder(p, windowsData)) {
      const isException = WINDOWS_PROFILE_EXCEPTIONS.some(parts => isUnder(p, join(windowsData, ...parts)))
      if (!isException) return 'Windows profile data'
    }
    const isEditorCache = EDITOR_DATA.some(name =>
      EDITOR_CACHE_PARTS.some(part => isUnder(p, join(ctx.appData, name, part))),
    )
    for (const entry of PROFILE_PROTECTED) {
      if (isEditorCache && entry.rule === 'Editor data') continue
      if (isUnder(p, join(ctx.userProfile, ...entry.parts))) return entry.rule
    }
  }

  // Names and extensions, anywhere.
  const segments = p.split('\\')
  for (const segment of segments) {
    if (CREDENTIAL_FOLDERS.has(segment)) return `Credentials folder (${segment})`
    if (segment === '.git') return 'Git repository data'
  }
  if (p.endsWith('\\.docker\\config.json')) return 'Credentials (Docker)'
  if (!isFolder) {
    const name = baseName(p)
    const ext = extensionOf(p)
    if (CREDENTIAL_NAMES.has(name)) return 'Credentials file'
    if (name === '.env' || name.startsWith('.env.')) return 'Environment file (.env)'
    if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return 'SSH key'
    if (/^(credentials|secrets?)([._-]|$)/.test(name)) return 'Credentials file'
    if (CREDENTIAL_EXTENSIONS.has(ext)) return 'Key or certificate'
    if (DATABASE_EXTENSIONS.has(ext)) return 'Database or mail store'
    if (DRIVER_EXTENSIONS.has(ext)) return 'Driver file'
    if (name.includes('token') && segments.some(s => s === 'appdata' || s.startsWith('.'))) {
      return 'Possible credential (token)'
    }
  }
  return null
}

/** The profile's AppData folders: logs there are judged by the allowlist. */
export function isInAppData(path: string, ctx: ClassifyContext): boolean {
  return isUnder(path, ctx.appData) || isUnder(path, ctx.localAppData)
}
