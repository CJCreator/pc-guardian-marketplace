# Drive Cleanup: implementation plan

| | |
| --- | --- |
| Plugin | `drive-cleanup` (marketplace `techgramam`) |
| Status | **Planned.** Version 0.1.0 is the empty plugin plus this plan; nothing runs yet. |
| First usable release | 0.2.0 (milestone M1: read-only deep audit and reports) |
| Feature-complete release | 1.0.0 (M1 to M6) |
| Platform | Windows 10 and 11, 64-bit, Claude Code 2.1.312 or later, no administrator rights needed |

---

## 0. What this plugin is

Drive Cleanup is a deep audit and cleanup of the Windows system drive (C:). It finds where the space went and
what can safely be recovered, and lets the person approve each item. It covers:

- duplicate files and folders, confirmed by SHA-256 of their contents;
- old installers (`.exe`, `.msi`, `.msix`) and archives (`.zip`, `.rar`, `.7z`), including archives that were
  already extracted;
- temporary files, crash dumps, disposable logs and caches that programs re-create;
- developer tool caches and build output (npm, pnpm, Yarn, pip, Gradle, Maven, Docker, Next.js, Vite,
  VS Code, Antigravity);
- leftovers from uninstalled programs, empty folders, and large files untouched for a long time.

**Its promise** is the one the brief ends with: *maximum storage recovery with zero data loss and no damage
to Windows, installed programs or development projects.* Every design decision below serves that promise.

### Goals

1. A complete, read-only storage audit of C: that finishes in minutes and says exactly what it could not
   read.
2. Every finding classified **A. Safe to clean**, **B. Review** or **C. Protected**, with the rule and the
   evidence behind it.
3. Nothing changes until the person approves specific items. Personal files are **moved to a quarantine
   and can be restored**, never deleted outright.
4. The eight report files the brief lists, plus a CSV manifest of every change.
5. Claude can run the audit and explain it, but cannot delete or move anything.

### Non-goals

These are never done, even if the person asks, because Windows has a supported way to do them or because
they risk the system:

- deleting from `C:\Windows`, `Program Files`, `ProgramData` or other protected locations (§2.2);
- registry cleaning, debloat scripts, disabling services, Defender, Windows Update or startup processes;
- uninstalling programs or developer tools;
- `DISM` or `sfc` repairs, component-store cleanup, removing `Windows.old` (reported, with manual steps);
- emptying the Recycle Bin (PC Guardian's cleanup or Windows does that);
- deleting anything because of its age, size or name alone.

---

## 1. Relationship to PC Guardian

Drive Cleanup is a **separate plugin** in the same marketplace. It installs, updates and uninstalls on its
own, and does not need PC Guardian.

| | PC Guardian | Drive Cleanup |
| --- | --- | --- |
| Purpose | PC health score across six areas, about 40 s | Deep storage audit and cleanup of C:, minutes |
| Cleanup | Temp files over 7 days, Recycle Bin, browser caches, startup apps | Duplicates, installers, archives, developer caches, logs, dumps, leftovers, large old files |
| Effect of cleanup | Permanent delete (startup: turn off) | Quarantine (move, restorable) for personal files; delete only for re-creatable data |
| Reads file contents | Never | Only for duplicate hashing, and only when turned on |
| Data folder | `%APPDATA%\pc-guardian-ai` | `%APPDATA%\techgramam-drive-cleanup` |
| Tool prefix | `mcp__pc-guardian__` | `mcp__drive-cleanup__` |

**Overlap rules.** Drive Cleanup reports the user Temp folder, the Recycle Bin and browser caches as
*measured* findings so the audit adds up. It offers to clean them only when PC Guardian is not installed,
and then the same way PC Guardian does. When PC Guardian is installed, those items show "Clean with PC
Guardian" and a link to its Clean up page. Detection reads only whether PC Guardian's plugin folder exists.
Drive Cleanup never reads or writes PC Guardian's data.

**Shared code.** The safe-process runner (hash-checked allowlisted scripts, fixed command line, `PCG_*`-style
inputs), the safe file writer (writes only inside the data folder, never through a link) and the local
dashboard server are taken from PC Guardian's source as a shared internal package
(`packages/win-safe-runtime`) and bundled into each plugin. Neither plugin loads the other's code at
runtime. *(Decision D1, §17.)*

---

## 2. Safety model

### 2.1 Rules enforced in code

Each rule has a test (§14) that names it.

| # | Rule | Where it is enforced |
| --- | --- | --- |
| S1 | **Scans only read.** Scan scripts open no file for writing, change no attribute or timestamp, and create nothing. | Script review checklist; a test greps scan scripts for write cmdlets/APIs; a Process Monitor capture in the release checklist. |
| S2 | **No links are followed.** Junctions, symbolic links and mount points are counted as entries and never walked. Cloud placeholder files (`RECALL_ON_DATA_ACCESS`, `RECALL_ON_OPEN`, `OFFLINE`) are never opened, so OneDrive never downloads them. | Shared walker function in every script; fixture drive with links and placeholders. |
| S3 | **Only allowlisted scripts run**, by id, after their SHA-256 matches the hash recorded at build time, as the current user, never elevated. No caller text reaches a command line. | `safe-shell.ts` (shared runtime). |
| S4 | **Protected paths can never be acted on** (§2.2). The rule lives in core and is repeated as a refusal at the top of every action script. | Core classifier; each action script's guard; tests for every rule. |
| S5 | **Only the person approves.** Actions run only from the dashboard after the person ticks items and confirms, with cleanup turned on in Settings, from a findings list under 10 minutes old, and with no scan running. Never from a Claude tool, never in a `-p` session. | `cleanup.ts` is the only module allowed to call `runAction` (ESLint rule); `checkActionRequest` gate. |
| S6 | **Personal files are moved, not deleted.** Every class B item is quarantined and can be restored. Only class A items (re-creatable data) are deleted. | Action selection is a function of class, not a user choice; the review screen shows which action each item gets. |
| S7 | **Re-check before acting.** Just before each item is touched, the action script confirms it still matches the scan: same path, not a link, same size and modified time, and the same SHA-256 for duplicates and quarantined files. Anything that changed is skipped and reported. | Action scripts. |
| S8 | **Nothing is lost in a move.** A cross-drive move copies, verifies the copy's SHA-256 against the source, and only then deletes the source. A same-drive move is a rename. | `quarantine-move.ps1`. |
| S9 | **Space is checked first.** A quarantine run is refused unless the destination keeps at least 10 % and 10 GiB free after the move. | Core plus a repeat check in the action script. |
| S10 | **Duplicates need a keeper.** At least one copy in every duplicate group is unticked; the dashboard does not offer "select all duplicates". | Core request check; dashboard. |
| S11 | **Everything is logged.** Every action, skip and restore is appended to `deletion_manifest.csv` and the JSON run log. | `cleanup.ts`. |
| S12 | **Nothing leaves the PC.** No telemetry and no network calls. The dashboard is served on 127.0.0.1 through a one-time link. Hashes and paths stay in the data folder. | Shared runtime; no network APIs in core (lint rule). |

### 2.2 Protected paths and content

An item matched by any rule below is class **C. Protected**. It is shown greyed out with the rule that
protects it, and it cannot be ticked. Matching ignores case, normalises `\\?\` prefixes, 8.3 short names,
trailing dots and spaces, and forward slashes, and resolves the real path of every parent so that a
junction into a protected folder is still protected.

**System locations**

- `C:\Windows` (including `System32` and `WinSxS`), `C:\Program Files`, `C:\Program Files (x86)`,
  `C:\ProgramData`
- `C:\Users\Default`, `C:\Users\Public`, `C:\Users\All Users`, and every other user's profile
- `C:\Recovery`, `C:\System Volume Information`, `C:\$Recycle.Bin`, `C:\$WinREAgent`, `C:\Boot`, `C:\EFI`
- Root system files: `bootmgr`, `BOOTNXT`, `pagefile.sys`, `hiberfil.sys`, `swapfile.sys`, `DumpStack.log*`
- `%LOCALAPPDATA%\Packages` (Store app data), `%LOCALAPPDATA%\Microsoft\Windows` (except
  `Explorer\thumbcache_*.db` and `INetCache`, which are class A), `%APPDATA%\Microsoft`
- Driver stores and any `.sys`, `.inf` or `.cat` file

**Credentials and keys**, anywhere:
`.ssh\`, `.gnupg\`, `.aws\`, `.azure\`, `.kube\`, `.docker\config.json`, `.npmrc`, `.pypirc`,
`.git-credentials`, `.netrc`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.crt`, `*.cer`, `id_rsa*`, `id_ed25519*`,
`*.ppk`, `.env`, `.env.*`, `*.kdbx`, `*.keychain`, `credentials*`, `secrets*`, `*token*` files under
`%APPDATA%` and `%USERPROFILE%\.*` folders.

**Databases and mail**: `*.db`, `*.sqlite`, `*.sqlite3`, `*.db-wal`, `*.db-shm`, `*.mdf`, `*.ldf`,
`*.accdb`, `*.mdb`, `*.pst`, `*.ost`, `*.edb`.

**Browsers**: every Chromium `User Data` folder and Firefox profile, except the cache folders that §5 lists.

**Development projects.** A *project root* is a folder that contains any of `.git`, `package.json`,
`pyproject.toml`, `requirements.txt`, `setup.py`, `*.sln`, `*.csproj`, `go.mod`, `Cargo.toml`, `pom.xml`,
`build.gradle`, `build.gradle.kts`, `composer.json`, `Gemfile`, `.vscode` or `.idea`. Everything under a
project root is protected **except** the build caches named in §5 (`.next\cache`, `node_modules\.vite`,
`.turbo`, `.parcel-cache`, `__pycache__`, `.pytest_cache`), and those are only ever class B. `node_modules`,
lock files, source, `.git` and configuration are never offered.

**Editors**: VS Code and Antigravity installation folders, `User\` settings, `extensions\`,
`workspaceStorage\`, `globalStorage\`. Only the caches in §5 are offered.

**Drive Cleanup's own data**: its data folder and the quarantine root (handled only by Restore and Purge).

### 2.3 Threat model

| Threat | Mitigation |
| --- | --- |
| Claude, a prompt injection in a file name, or another tool asks for a deletion | No tool can act (S5). Tool output treats paths as data; skills tell Claude it cannot clean. |
| A path is swapped for a junction between scan and action (TOCTOU) | S7 re-check opens each item without following reparse points and confirms its attributes and identity (volume serial plus file ID) are unchanged. |
| A file is edited after the scan | Size, modified time and hash re-check (S7): the item is skipped. |
| A script file is tampered with | Hash check (S3). |
| A huge or deep tree hangs the scan | Time and entry budgets for each step, `isTruncated` reported, cancel between steps. |
| A file name holds a CSV formula | CSV writer escapes cells starting with `= + - @ \t \r`. |
| A long path (over 260 characters) | All file APIs use `\\?\` long paths; fixture tests. |
| A file is in use | Skipped with the reason "in use". Never forced. |
| The quarantine drive is removed | Restore says which drive is missing. The manifest still records where everything is. |

---

## 3. Architecture

```
Claude Code session
├── Claude ── MCP tools (read-only) ──────────────┐
│                                                 ▼
├── hooks/register.tsx  (mod: tools, pane, events)
│     ├── scan.ts       runs the deep-scan steps, keeps progress
│     ├── findings.ts   classification, paging and filters (from core)
│     ├── reports.ts    writes the 8 report files via safe-writer
│     ├── cleanup.ts    the ONLY caller of runAction (ESLint)
│     ├── dashboard.ts  local web dashboard (127.0.0.1, one-time link)
│     ├── safe-shell.ts / safe-writer.ts  (shared runtime)
│     └── deps.js       bundled core: schemas, rules, views, SCRIPTS/ACTIONS, hashes
├── ps/scan/*.ps1       read-only scan scripts (hash-checked)
├── ps/actions/*.ps1    the only scripts that change files (hash-checked, guarded)
└── dashboard/app       static web app: Findings, Duplicates, Dev caches, Review, Quarantine, Reports, Settings
```

The flow is one-way: **scan → classify → person ticks and confirms → act → verify**. Claude sits beside it
and can start scans and read results, never act.

### 3.1 Source layout (in the source monorepo)

```
packages/
  win-safe-runtime/        shared with PC Guardian: process runner, safe writer, dashboard server, CSV writer
  drive-cleanup-core/
    src/
      schemas/             zod schemas for every script's output and every action's params
      scan/                step list, budgets, progress model
      classify/            rules, protected-path matcher, project detection, categories
      duplicates/          grouping, keeper rule, folder-duplicate detection
      quarantine/          planning, space check, restore planning
      reports/             markdown and CSV generators
      tools/               MCP tool specs, input schemas, text views
      settings/            settings schema and defaults
    test/                  unit tests on recorded real-machine output
    fixtures/              recordings (personal details removed)
  drive-cleanup-mod/       hooks/*.ts, register.tsx (built into hooks/)
  drive-cleanup-dashboard/ Next.js static export (built into dashboard/app)
  drive-cleanup-ps/        ps/ scripts + Pester tests + fixture-drive builder
```

### 3.2 Built plugin layout (this folder, from release 0.2.0)

```
plugins/drive-cleanup/
  .claude-plugin/plugin.json
  hooks/hooks.json, register.tsx, *.ts, deps.js
  ps/scan/*.ps1, ps/actions/*.ps1
  dashboard/app/…, dashboard/server.mjs
  skills/<name>/SKILL.md
  agents/drive-auditor.md
  types/index.d.ts
  README.md, CHANGELOG.md, PLAN.md, LICENSE, THIRD_PARTY_NOTICES.md
```

### 3.3 Data folder layout

```
%APPDATA%\techgramam-drive-cleanup\
  settings.json
  scans\<scanId>\
    summary.json                 totals, step statuses, truncation
    findings-<n>.json            findings, in pages of 5,000
    duplicates.json              duplicate groups (only if hashing ran)
  audits\<yyyy-mm-dd_hhmmss>\    the 8 report files (§12)
  runs\log.json                  last 200 action runs
  runs\pending\<runId>.json      the approved list an action reads (deleted after the run)
```

The quarantine lives on the chosen drive, not in the data folder (§7).

---

## 4. Phase 1: the deep scan (read-only)

The deep scan is a job with seven steps. The pane and dashboard show live progress for each step. **Cancel**
stops at the next step boundary, or inside the walk at its next checkpoint. Each step has its own time
budget; a step that runs out of time stops cleanly and its results are marked `isTruncated`. A step that
fails or times out shows **Retry** and does not stop the other steps.

| Step | Script | Reads | Budget | Output (summary on stdout, lists paged) |
| --- | --- | --- | --- | --- |
| 1 Volume | `scan/volume.ps1` | Fixed drives (capacity, used, free, file system, media type, health), Storage Sense policy, NTFS last-access setting, elevation | 20 s | Drives; whether C: is the system drive; candidate quarantine drives; `lastAccessTrusted` |
| 2 Walk | `scan/walk.ps1` | One metadata walk of C: (name, size, size on disk, created, modified, accessed, attributes, file ID). Protected roots are summed but their contents are not listed. | 4 min or 3 M entries | Folder tree sizes to depth 4; top 100 largest files; age buckets; per-extension totals; empty folders in user areas; project roots |
| 3 Candidates | `scan/candidates.ps1` | Only the folders the classifier selected from step 2's results, passed as a list id (§4.2); no second full walk | 30 s | Installers, archives, extracted-archive pairs, logs, dumps, temp folders, old downloads, large old files |
| 4 Dev caches | `scan/dev-caches.ps1` | Fixed list of known cache roots (§5) plus the project build caches found in step 2; running processes | 60 s | One record per cache: tool, path, size, files, last write, whether the tool is running |
| 5 Leftovers | `scan/leftovers.ps1` | Installed programs (Uninstall keys, HKLM and HKCU, read only; Store packages via `Get-AppxPackage` for the current user) compared with folders in `%APPDATA%`, `%LOCALAPPDATA%` and `%LOCALAPPDATA%\Programs` | 30 s | Unmatched folders with size and last write, always class B, low confidence |
| 6 Duplicates (opt-in) | `scan/hash.ps1` | File contents, only for size collisions (§6) | 10 min, resumable | Duplicate groups |
| 7 Windows | `scan/windows.ps1` | Size of `SoftwareDistribution\Download`, `Windows.old`, `C:\Windows\Temp`, `LiveKernelReports`, `Minidump`, `MEMORY.DMP`, delivery optimisation cache, hibernation file, page file, restore point usage (`vssadmin list shadowstorage` needs admin: otherwise Not checked) | 60 s | Measurements for the Windows optimisation recommendations (§8). Never acted on. |

### 4.1 The walk

- An explicit stack, not recursion. `EnumerateFileSystemInfos` with `\\?\` long paths.
- Reparse points are recorded as entries with their target type and never pushed (S2).
- Access-denied folders are counted (`deniedFolders`) and listed (up to 200) so the report says what was not
  read.
- Inside protected roots, only total size and file count are collected, so "Where did my space go" still
  adds up to the drive's used space. The difference between the walk's total and the volume's used space
  is shown as "not readable without administrator rights (system files, other users, shadow copies)".
- **Last accessed.** When NTFS last-access updates are off (`NtfsDisableLastAccessUpdate` with the system
  setting enabled), every "not accessed for 6 months" figure is *Not checked* with that reason. Modified
  dates are always used.

### 4.2 Passing data between steps without writing from scripts

Scan scripts never write files (S1). Large results come back as **pages**: the script takes
`DC_PAGE` and `DC_PAGE_SIZE` (validated integers) and a `DC_SCAN_ID`, and returns that page. The mod stores
the pages in the data folder through the safe writer. Steps that need step 2's index (candidates,
leftovers, hash) re-derive what they need from a narrow re-walk of the folders the classifier selected.
The mod passes those folders as a **list id**, which the script reads from
`scans\<scanId>\lists\<listId>.json` (read-only for the script, written by the safe writer).
*(Decision D2: paging, as planned, versus letting scan scripts stream NDJSON into a folder the mod
pre-creates. Paging keeps S1 absolute.)*

### 4.3 Output schemas (summary)

Every script prints exactly one compressed JSON object, validated by a strict zod schema. Unknown keys
fail validation, and a step that fails validation is *Not checked* with the reason. Key types:

```ts
type FileEntry = {
  path: string; sizeBytes: number; allocatedBytes: number | null
  createdUtc: string; modifiedUtc: string; accessedUtc: string | null
  attributes: number; volumeSerial: string; fileId: string
}
type FolderNode = { path: string; sizeBytes: number; fileCount: number; depth: number; isProtected: boolean }
type StepResult<T> =
  | { status: 'ok'; data: T; isTruncated: boolean; deniedFolders: number; elapsedMs: number }
  | { status: 'not_checked'; reason: 'needs_admin' | 'timeout' | 'failed' | 'cancelled' | 'disabled'; detail: string }
```

---

## 5. Phases 2 and 3: classification and developer caches

`classify(scan) → Finding[]` is a pure function in core. It is unit-tested on recorded output.

```ts
type Finding = {
  id: string                       // stable: hash of category + volumeSerial + fileId
  category: CategoryId
  class: 'safe' | 'review' | 'protected'
  action: 'delete' | 'quarantine' | 'none' | 'manual' | 'pc_guardian'
  path: string; sizeBytes: number; fileCount: number
  modifiedUtc: string; accessedUtc: string | null
  reason: string                   // one plain sentence
  evidence: { rule: string; values: Record<string, string | number> }
  confidence: 'high' | 'medium' | 'low'
  protectedBy: string | null       // the §2.2 rule, when class is protected
  duplicate?: { groupId: string; isSuggestedKeeper: boolean; keeperReason: string }
  owner?: { tool: string; isRunning: boolean }   // dev caches
}
```

### 5.1 Categories

| Category id | What | Class | Action |
| --- | --- | --- | --- |
| `user_temp` | `%TEMP%` files not written for 7 days or more | A | delete, or `pc_guardian` when PC Guardian is installed |
| `temp_extract` | Folders in `%TEMP%` that look like installer extractions (`7z*`, `{GUID}`, `*.tmp` folders, `msi*`) not written for 7 days or more | A | delete |
| `crash_dumps` | `%LOCALAPPDATA%\CrashDumps\*.dmp`, app `*.dmp` in known crash folders | A | delete |
| `app_logs` | `*.log`, `*.log.N` and `*.etl` in allowlisted log folders (§5.3), not written for 30 days or more | A | delete |
| `thumb_cache` | `Explorer\thumbcache_*.db` (Windows re-creates them) | A | delete, only while Explorer can release them; otherwise skipped |
| `inet_cache` | `%LOCALAPPDATA%\Microsoft\Windows\INetCache` | A | delete |
| `shader_cache` | `D3DSCache`, `NVIDIA\DXCache`, `NVIDIA\GLCache`, `AMD\DxCache` | A | delete |
| `dev_cache_safe` | npm, Yarn, pip, VS Code and Antigravity caches (§5.2) | A | delete, only while the tool is not running |
| `browser_cache` | Browser cache folders | A | `pc_guardian`, or delete when PC Guardian is not installed |
| `recycle_bin` | The current user's Recycle Bin | A (measured) | `pc_guardian` or `manual`; never emptied by Drive Cleanup |
| `duplicate` | Copies in a duplicate group, except the keeper | B | quarantine |
| `duplicate_folder` | Folders whose whole contents duplicate another folder | B | quarantine |
| `installer` | `.exe`, `.msi`, `.msix`, `.msixbundle`, `.appx`, `.appxbundle` in Downloads, Desktop, Documents and the profile root | B | quarantine |
| `archive` | `.zip`, `.rar`, `.7z`, `.tar`, `.gz`, `.tgz`, `.bz2`, `.xz`, `.iso`, `.img`, `.cab` in the same folders | B | quarantine |
| `extracted_pair` | An archive whose sibling folder has the archive's name and at least 90 % of its listed entries by name and size (zip central directory read only when hashing is on, otherwise name match only, confidence low) | B | quarantine the archive, never the folder |
| `old_download` | Files in Downloads not modified for 90 days or more (setting) | B | quarantine |
| `large_old` | Files ≥ 500 MiB (setting) not modified for 12 months, outside protected locations | B | quarantine |
| `leftover` | App data folders with no matching installed program | B, low confidence | quarantine |
| `empty_folder` | Empty folders in user areas, outside project roots, not special shell folders | B | quarantine (recorded so Restore re-creates them) |
| `dev_cache_review` | pnpm store, Gradle, Maven, Docker, project `.next\cache` and `node_modules\.vite` (§5.2) | B | quarantine or manual, as listed |
| `windows_managed` | Windows Update download cache, `Windows.old`, system temp, hibernation file, restore points | B | manual (§8) |
| `protected` | Anything matched by §2.2 | C | none |

### 5.2 Developer caches

Locations are fixed per tool and checked on a real install of each tool before release. They are never
guessed from folder names.

| Tool | Locations | Class | How it is cleaned | Notes |
| --- | --- | --- | --- | --- |
| npm | `%LOCALAPPDATA%\npm-cache\_cacache`, `\_npx`, `\_logs` | A | Contents deleted while no `node.exe` runs | Equivalent to `npm cache clean --force` |
| Yarn 1 | `%LOCALAPPDATA%\Yarn\Cache` | A | Contents deleted while no `yarn`/`node` runs | |
| Yarn Berry | `%LOCALAPPDATA%\Yarn\Berry\cache` | A | As above | Project-local `.yarn\cache` is protected (zero-installs) |
| pip | `%LOCALAPPDATA%\pip\cache` | A | Contents deleted while no `python.exe` runs | Equivalent to `pip cache purge` |
| pnpm | `%LOCALAPPDATA%\pnpm\store`, `%LOCALAPPDATA%\pnpm-cache` | B | **Manual**: `pnpm store prune` | Deleting the store breaks hard-linked `node_modules` |
| Gradle | `%USERPROFILE%\.gradle\caches`, `\wrapper\dists` | B | Quarantine wrapper distributions other than the newest per major version; caches manual | Offline builds need the caches |
| Maven | `%USERPROFILE%\.m2\repository` | B | Manual only | Re-download cost is shown |
| Docker | `docker system df` output when the Docker CLI exists, read only, 15 s timeout | B | **Manual**: `docker builder prune`, `docker image prune` | Drive Cleanup never runs Docker commands that change anything |
| NuGet | `%LOCALAPPDATA%\NuGet\v3-cache`, `\plugins-cache` | A | Contents deleted while no `dotnet`/`devenv`/`msbuild` runs | `%USERPROFILE%\.nuget\packages` is B, manual |
| VS Code | `%APPDATA%\Code\Cache`, `\CachedData\<not current>`, `\CachedExtensionVSIXs`, `\Code Cache`, `\GPUCache`, `\logs` | A | Contents deleted while `Code.exe` is not running | `User\`, `extensions`, `workspaceStorage`, `globalStorage` protected |
| Antigravity | The same layout under Antigravity's own `%APPDATA%` folder | A | As VS Code | Paths confirmed on a real install first (D5) |
| Next.js | `<project>\.next\cache` | B | Quarantine that one folder | Never `.next` itself, never `node_modules` |
| Vite | `<project>\node_modules\.vite` | B | Quarantine that one folder | |
| Turbo / Parcel | `<project>\.turbo`, `<project>\.parcel-cache` | B | Quarantine that folder | |
| Python | `__pycache__`, `.pytest_cache`, `.mypy_cache` in project roots | B | Quarantine | Tiny; listed only when over 50 MiB in total |

### 5.3 Log allowlist

Logs are class A only in folders on this allowlist: `%LOCALAPPDATA%\<vendor>\<app>\logs`,
`%APPDATA%\<app>\logs` for apps on a curated list (Teams, Zoom, Slack, Discord, Spotify, NVIDIA, Adobe,
JetBrains, Code, Antigravity, npm `_logs`), and `%LOCALAPPDATA%\Temp\*.log`. Anywhere else, a log file is
class B. The list is data in core, so it can grow without changes to the scripts.

### 5.4 Duplicate keeper rule

A suggestion only; the person can pick a different keeper. In order:

1. A copy in Documents, Pictures, Videos, Music, Desktop or OneDrive beats one in Downloads, Temp or an
   extraction folder.
2. A copy outside an archive-extraction folder.
3. A copy in a folder that has other files of the same kind (an album beats a stray copy).
4. The original name beats `name (1).ext`, `name - Copy.ext`, `Copy of name.ext`.
5. The shorter path depth.
6. The earliest created date.

The rule that decided is shown as `keeperReason`.

---

## 6. Phase 4: duplicate detection

- **Off by default.** Turned on in Settings > Duplicates, which says plainly: "Reads the contents of files
  to compare them. Nothing leaves this PC."
- **Scope:** the user profile and non-system top-level folders of C:. Never protected paths, never cloud
  placeholders, never files larger than the size limit (default 4 GiB) or smaller than the minimum (default
  1 MiB).
- **Algorithm**
  1. Group the walk's files by exact size; drop groups of one.
  2. For files of 128 KiB or more, a quick hash (SHA-256 of the first and last 64 KiB). Drop groups that
     differ.
  3. A full SHA-256 for what remains, streamed with a 1 MiB buffer and `FileShare.ReadWrite`, opened without
     following links. Files that are locked are skipped and reported.
  4. Groups are identical files with the same full hash.
- **Budget and resume:** hashing works through size buckets from largest to smallest, so the biggest savings
  come first. When the budget runs out, the finished buckets are kept and the next run continues from the
  first unfinished bucket. Hashes are cached by (volume serial, file ID, size, modified time), so unchanged
  files are never hashed twice.
- **Duplicate folders:** two folders are duplicates when their sets of (relative path, size, hash) are equal.
  Computed in core from file hashes; nested duplicates are reported only at the highest folder.
- **Each group shows** the size, hash, extension, every location with modified and accessed dates, the
  suggested keeper and why, and the space recovered (size × (copies − 1)).

---

## 7. Phase 5: cleanup and quarantine

### 7.1 The person's flow (dashboard)

1. **Findings** page: totals by class and category, with recoverable space for A, B and the total. Filters
   by category, class, size, age and folder. Each row shows the path, size, dates, reason, evidence and
   action.
2. Tick items. Duplicate groups tick as a group; the keeper is unticked and cannot be ticked unless another
   copy is unticked (S10). Class C rows have no checkbox.
3. **Review** screen, the brief's approval step: exact paths, sizes, reasons, the action for each item
   (**Delete permanently** for class A, **Move to quarantine** for class B), the quarantine destination, and
   the space check. The confirm button names the totals ("Move 1,284 files (38.2 GB) to D:\Drive Cleanup
   Quarantine and delete 12.4 GB of caches"). The pane cannot confirm; it only links here.
4. The mod writes the approved list to `runs\pending\<runId>.json` (safe writer) and runs the actions, which
   read the list **by run id**, never by a path from the caller.
5. Progress for each item; a summary at the end; results in the manifest and the run log.

### 7.2 Quarantine

- **Location:** the setting chooses one. **Auto** (the default) picks the fixed, non-removable, NTFS drive
  other than C: with the most free space that passes the space check (S9), at
  `<drive>:\Drive Cleanup Quarantine\`. If there is none, C: is used (`C:\Drive Cleanup Quarantine\`),
  but only after the same space check, and the review screen warns that a quarantine on C: frees no space
  until it is purged.
- **Layout:** `<root>\<runId>\C\Users\…`: the original path is kept under the run folder, so nothing
  collides and Restore is exact. `<root>\<runId>\restore.json` lists every item: original path, quarantine
  path, size, SHA-256, original timestamps and attributes. `<root>\README.txt` says what the folder is.
- **Moves:** same volume, a rename (`MoveFileEx` without copy). Another volume, copy → SHA-256 verify →
  set timestamps and attributes → delete source (S8). A failed verify deletes the bad copy and leaves the
  source.
- **Never quarantined:** class A items (deleted), class C items, anything Windows manages (§8).
- **Restore:** per item or per run, from the Quarantine page. Restore refuses an item whose original path
  now exists (it offers "Restore beside it as `name (restored).ext`" instead), and re-creates parent folders.
- **Purge:** "Delete this quarantine run for good", per run, only when the person presses it and confirms.
  The Quarantine page shows each run's size and age and suggests purging runs older than 30 days. It never
  purges by itself (D3).

### 7.3 Action scripts

| Script | Does | Inputs (strict schema) |
| --- | --- | --- |
| `actions/quarantine-move.ps1` | Moves the class B items in an approved list into the quarantine (S4, S7, S8, S9) | `DC_RUN_ID` (uuid), `DC_APPROVED_AT` (ISO time) |
| `actions/delete-safe.ps1` | Deletes the class A items in an approved list: files only, folders left in place, files in use skipped (S4, S7) | `DC_RUN_ID`, `DC_APPROVED_AT` |
| `actions/clean-cache.ps1` | Deletes the contents of one cache root from the §5.2 allowlist, chosen by enum id, never by path; refused while the owning process runs | `DC_CACHE_ID` (enum), `DC_APPROVED_AT` |
| `actions/quarantine-restore.ps1` | Moves items of one run back | `DC_RUN_ID`, `DC_RESTORE_LIST_ID` (uuid) |
| `actions/quarantine-purge.ps1` | Deletes one quarantine run folder, only one that holds a valid `restore.json` written by Drive Cleanup | `DC_RUN_ID` |

Each script starts with the same guard: the approved list must exist in the data folder, belong to this run
id, be younger than 10 minutes, and every path in it must pass the protected-path check again. Each script
has its own ESLint guard entry and its own hash.

### 7.4 The deletion manifest

`audits\<timestamp>\deletion_manifest.csv`, UTF-8 with BOM (so Excel opens it correctly), one row per item
and per outcome:

| Column | Example |
| --- | --- |
| `timestamp_utc` | `2026-11-02T10:14:03Z` |
| `run_id` | `6f1c…` |
| `original_path` | `C:\Users\Asha\Downloads\setup-old.exe` |
| `size_bytes` | `104857600` |
| `sha256` | filled for duplicates and every quarantined file |
| `category` | `installer` |
| `class` | `review` |
| `reason` | `Installer in Downloads, not modified for 14 months` |
| `action` | `quarantined` \| `deleted` \| `restored` \| `skipped` \| `purged` |
| `destination` | `D:\Drive Cleanup Quarantine\6f1c…\C\Users\…` |
| `detail` | skip reason, for example `changed since scan` |

---

## 8. Phase 6: Windows optimisation (recommendations only)

Each recommendation has the evidence, manual steps, the risk, and how to undo it. Drive Cleanup runs none of
them.

| Finding | Recommendation |
| --- | --- |
| Storage Sense off | Settings > System > Storage > Storage Sense: turn on, set Temp files and Downloads cadence |
| Windows Update download cache over 1 GB, or `Windows.old` present | Settings > System > Storage > Temporary files, or Disk Cleanup > Clean up system files |
| Large component store (only when elevated) | Manual admin command `DISM /Online /Cleanup-Image /StartComponentCleanup`, with its risk (removes the ability to uninstall superseded updates) |
| Hibernation file over 8 GB and hibernation not used | Manual: `powercfg /h /type reduced` or off; explains Fast Startup depends on it |
| Restore points using over 10 % of C: | System Protection > Configure > Max usage |
| Memory dumps (`MEMORY.DMP`, `Minidump`, `LiveKernelReports`) | Disk Cleanup > System error memory dump files |
| Browser caches large | Clean with PC Guardian, or each browser's own setting |
| Startup apps | PC Guardian's startup cleanup, or Task Manager > Startup apps |
| Large programs installed long ago | Listed with size and install date (no "unused" claim: Windows has no reliable last-used data); Settings > Apps |
| Disk health warning or under 10 % free | Back up; the drive's health status and what it means |

---

## 9. Phase 7: final verification

**Verify** appears after any action run. It is read-only.

- Re-runs steps 1 and 2 (summary only). Space recovered = free space after − free space before, shown next to
  the total the actions reported; when they differ (other programs wrote to the drive meanwhile), both
  figures are shown with the reason.
- **Windows integrity:** `sfc /verifyonly` needs administrator rights. When Claude Code is not elevated, it
  is *Not checked* with the manual command. `sfc /scannow` and DISM repairs are never run.
- **Developer tools:** `code --version`, Antigravity's version, `node -v`, `npm -v`, `git --version`,
  `python --version`, resolved from PATH with a 10 s timeout each. Each reports a version or "not found";
  "not found" before and after is not a failure.
- **Projects:** every project root found in the scan still exists with its `.git` folder and manifest files
  (counts before and after; any difference is listed by path).
- **Quarantine integrity:** each moved file's SHA-256 in quarantine matches the manifest.
- Writes `final_cleanup_report.md` (§12).

---

## 10. Claude's tools, skills and agent

### 10.1 MCP tools (all read-only)

| Tool | Input | Returns |
| --- | --- | --- |
| `self_check` | none | Windows version, PowerShell, elevation, data folder, script integrity, settings |
| `run_deep_scan` | `{ steps?: StepId[]; includeDuplicates?: boolean }` (`includeDuplicates` only works when the setting is on) | Starts the job; waits up to 9 min and returns the summary, or returns progress and a `scanId` to poll |
| `get_scan_status` | `{ scanId? }` | Progress for each step |
| `get_storage_summary` | `{ scanId? }` | Capacity, used, free, folder tree to depth 3, top folders, age buckets, what was not read |
| `get_largest_files` | `{ limit≤100, offset }` | Top files with class and reason |
| `get_findings` | `{ class?, category?, minBytes?, folder?, limit≤200, offset }` | Findings and totals |
| `get_duplicate_groups` | `{ limit≤50, offset, minBytes? }` | Groups with keeper and reason |
| `get_dev_caches` | `{}` | §5.2 table with sizes and how each is cleaned |
| `get_windows_recommendations` | `{}` | §8 items |
| `generate_audit_reports` | `{ scanId? }` | Writes the §12 files; returns their paths |
| `get_quarantine` | `{}` | Quarantine runs, sizes, ages, restore status |
| `open_dashboard` | `{ page? }` | One-time dashboard link |

Paths in tool output are data. The tool descriptions say so, and the views quote them, so a file named like
an instruction cannot steer Claude.

### 10.2 Skills

| Skill | Purpose |
| --- | --- |
| `/drive-cleanup:audit` | Runs the deep scan (or reads the latest), then summarises: capacity, where the space is, recoverable A / B totals, top 5 categories, what was not checked, next step. |
| `/drive-cleanup:duplicates` | Explains the duplicate groups and keepers; says hashing is off and where to turn it on if so. |
| `/drive-cleanup:dev-caches` | The developer cache table with what is safe, what is manual (with the exact command for the person to run), and what is protected. |
| `/drive-cleanup:report` | Writes the 8 audit files and gives the folder. |
| `/drive-cleanup:review` | Opens the dashboard's Review page. Claude says it cannot approve or clean. |
| `/drive-cleanup:self-check` | Confirms the plugin can read this machine. |
| `drive-audit` (model-invoked) | How to answer "why is my C: drive full?", "what can I delete?" with the tools: cite evidence, keep estimates apart, never recommend deleting what the tools did not list, never act. |

### 10.3 Agent

`drive-auditor`: tools limited to the read-only MCP tools above; no shell, no file tools. It runs an audit
and returns a prioritised summary.

---

## 11. Dashboard and pane

**Pane beside the chat:** drive gauge (used / free), the scan's progress with Cancel and Retry, recoverable
A and B totals, the largest three categories, and buttons: Run deep scan, Open dashboard, Quarantine.

**Browser dashboard** (127.0.0.1, one-time link valid for 5 minutes):

| Page | Contents |
| --- | --- |
| Overview | Drive usage, where the space went (treemap with a table alternative), recoverable totals, scan history |
| Findings | The filterable table (§7.1) with tick boxes |
| Duplicates | Groups, keeper choice, preview of file metadata (never contents) |
| Dev caches | §5.2 table; tool running state; manual commands to copy |
| Windows | §8 recommendations |
| Review | The approval screen |
| Quarantine | Runs, Restore, Purge |
| Reports | Audit folders and their files; Open folder |
| Settings | §11.1 |
| What we read | Every script, what it reads, and what it never reads |

Light, dark and high-contrast themes; keyboard and screen-reader friendly; every chart has its numbers as a
table; reduced motion honoured. The same standard as PC Guardian.

### 11.1 Settings

| Setting | Default |
| --- | --- |
| Cleanup (allow any action) | Off |
| Find duplicates by content (SHA-256) | Off |
| Minimum duplicate size | 1 MiB |
| Maximum file size to hash | 4 GiB |
| Quarantine location | Auto (another drive; C: only after the space check) |
| Old download age | 90 days |
| Large old file size / age | 500 MiB / 12 months |
| Log age for class A | 30 days |
| Scans to keep | 10 |
| Remove personal paths from exported reports | On |

---

## 12. Reports (the brief's deliverables)

Written by the safe writer to `%APPDATA%\techgramam-drive-cleanup\audits\<yyyy-mm-dd_hhmmss>\`.

| File | Contents |
| --- | --- |
| `storage_audit.md` | Capacity, used, free; folder sizes to depth 3; files not accessed 6 months (or Not checked) and not modified 12 months; counts by category; what was not read and why; truncation |
| `largest_files.csv` | Top 100: path, size, modified, accessed, extension, class, category, reason |
| `duplicate_files.csv` | group id, sha256, size, extension, path, modified, accessed, is_suggested_keeper, keeper_reason |
| `installers_and_archives.csv` | path, kind, size, modified, extracted_pair_path, class, reason |
| `cache_analysis.md` | §5.2 table filled with this PC's sizes, running state and how each is cleaned |
| `cleanup_recommendations.md` | Every finding grouped by class and category, with reasons, actions and recoverable space |
| `deletion_manifest.csv` | §7.4, appended per run |
| `final_cleanup_report.md` | §9: before and after, recovered space, verification results, quarantine state |

These files hold full local paths, because the person needs them to decide. "Remove personal paths" applies
when a report is exported or shared, and the Reports page says so. CSV cells are escaped against formula
injection.

---

## 13. Milestones

Estimates are engineer-days for one engineer familiar with the PC Guardian codebase.

### M0: Plugin scaffold (0.1.0), done

- [x] Plugin folder, manifest, marketplace entry, README, this plan.

### M1: Read-only deep audit (0.2.0), about 15 days

- [ ] Extract `win-safe-runtime` from PC Guardian (runner, writer, CSV, dashboard server); PC Guardian
      switches to it with no behaviour change (its own tests prove it).
- [ ] Core: schemas, step model, progress, protected-path matcher (§2.2) with tests for every rule.
- [ ] Scripts: `scan/volume.ps1`, `scan/walk.ps1` (paged), `scan/candidates.ps1`, `scan/windows.ps1`.
- [ ] Classifier for every category except duplicates, dev caches and leftovers.
- [ ] Mod: `register.tsx`, `scan.ts`, `findings.ts`, `reports.ts`; tools `self_check`, `run_deep_scan`,
      `get_scan_status`, `get_storage_summary`, `get_largest_files`, `get_findings`,
      `get_windows_recommendations`, `generate_audit_reports`.
- [ ] Reports: `storage_audit.md`, `largest_files.csv`, `installers_and_archives.csv`,
      `cleanup_recommendations.md`.
- [ ] Pane with progress, Cancel and Retry. Skills `audit`, `report`, `self-check`, `drive-audit`; agent.
- **Exit:** recorded fixtures from at least two real PCs; a full scan of a 500 GB SSD with 1.5 M files in
  under 4 min; a Process Monitor capture shows no writes outside the data folder and no reads of contents;
  junction, placeholder and long-path fixtures pass.

### M2: Developer caches and leftovers (0.3.0), about 6 days

- [ ] `scan/dev-caches.ps1`, `scan/leftovers.ps1`; categories `dev_cache_*`, `leftover`.
- [ ] `cache_analysis.md`; tool `get_dev_caches`; skill `dev-caches`.
- [ ] Each cache location confirmed on a real install of its tool (D5 for Antigravity).
- **Exit:** for every tool, the location is found when installed, absent when not, and the running state is
  right.

### M3: Duplicates (0.4.0), about 7 days

- [ ] `scan/hash.ps1` with quick hash, full hash, resume and the hash cache.
- [ ] Grouping, keeper rule, folder duplicates; `duplicate_files.csv`; tool `get_duplicate_groups`;
      skill `duplicates`; the setting and its wording.
- **Exit:** hashes equal `Get-FileHash -Algorithm SHA256` on fixtures; a cancelled run resumes; placeholders
  are never hydrated (OneDrive fixture); a locked file is skipped, not failed.

### M4: Approval, cleanup and quarantine (0.5.0), about 12 days

- [ ] Browser dashboard: Overview, Findings, Duplicates, Dev caches, Windows, Review, Quarantine, Reports,
      Settings, What we read.
- [ ] `cleanup.ts` with the request gate (S5), approved lists, run log, manifest.
- [ ] Actions: `quarantine-move`, `delete-safe`, `clean-cache`, `quarantine-restore`, `quarantine-purge`,
      each with its guard and hash; ESLint rule that only `cleanup.ts` calls `runAction`.
- [ ] Space check, quarantine location choice, `restore.json`, README in the quarantine root.
- **Exit:** move and restore give byte-identical files (hash) on the same drive and across drives; every
  §2.2 rule refuses in every action; changed-since-scan, in-use and junction-swap items are skipped;
  refused in a `-p` session, with cleanup off, with a stale list, while scanning.

### M5: Verification (0.6.0), about 4 days

- [ ] Verify step, `final_cleanup_report.md`, `get_quarantine` tool, `review` skill.
- **Exit:** not-elevated checks report Not checked; no command that changes state runs.

### M6: Hardening and 1.0.0, about 6 days

- [ ] Accessibility pass, performance pass (3 M files), docs (README, What we read, CHANGELOG),
      THIRD_PARTY_NOTICES, release checklist, security review of the action scripts by a second engineer.
- [ ] Beta on five machines with different profiles: developer, media-heavy, OneDrive-heavy, a small 128 GB
      drive, a non-English Windows.
- **Exit:** no data-loss bug open; every S-rule has a passing test; release checklist signed off.

Total: about 50 engineer-days.

---

## 14. Testing

| Layer | What | How |
| --- | --- | --- |
| Core unit | Classifier, protected-path matcher (case, `\\?\`, 8.3 names, trailing dots, junction parents), keeper rule, folder duplicates, quarantine planning, space check, CSV escaping, manifest, request gate | Vitest on recorded real output (personal details removed), as PC Guardian does since 2.0.0; faults injected only where a test checks a failure path, and it says so |
| Script | Each scan and action script | Pester against a fixture drive (VHDX built by a script): junctions, symlinks, mount points, OneDrive-style placeholders, ACL-denied folders, locked files, 300-character paths, Unicode names, a fake project tree, fake tool caches |
| Mod | Tool answers, progress, cancel, retry, the only-cleanup-calls-runAction rule | Engine test harness; ESLint |
| Safety | One named test for each S-rule and each §2.2 rule, in each action | Test names map to rule ids; CI fails if a rule has no test |
| Manual release | Process Monitor capture of a full scan (only reads); a real quarantine + restore + purge on a real profile; uninstall leaves only the data folder and quarantine | Release checklist |

---

## 15. Release, versioning, distribution

- Semantic versioning as in PC Guardian: a fix is a patch, a new capability a minor, and anything that
  changes what Drive Cleanup may do to a machine without the person opting in a major.
- 0.x releases are marked "preview" in the marketplace description and README.
- Built from the source monorepo; the build writes `deps.js`, script hashes, `dashboard/app` and copies
  `ps/`. A CI check fails if any script's hash in `deps.js` does not match the file.
- The bundled Node.js runtime is left out of this repository, as for PC Guardian. Installed from GitHub, the
  browser dashboard needs Node.js 22 or later on PATH; the pane and tools work without it.
- **Install** (once 0.2.0 ships): `/plugin install drive-cleanup@techgramam`.
- **Uninstall** leaves `%APPDATA%\techgramam-drive-cleanup` and any quarantine folder. README tells the person
  to restore or purge quarantines first.

---

## 16. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| A path is misclassified as safe | Low | High | Class A is limited to an allowlist of locations; everything else is B and quarantined; S7 re-check |
| A scan is too slow on large drives | Medium | Medium | Budgets, truncation shown, resume for hashing, paging |
| Hashing hydrates cloud files | Low | High (downloads, data costs) | Attribute check before open; OneDrive fixture test |
| Quarantine fills the other drive | Low | Medium | Space check S9; review screen shows the destination's free space |
| The person forgets the quarantine | Medium | Low | Quarantine page shows size and age; pane reminder after 30 days; never auto-purged |
| A tool's cache layout changes in an update | Medium | Low | Locations confirmed per release; unknown layouts become B, not A |
| Overlap and confusion with PC Guardian | Medium | Low | Overlap rules (§1); shared wording; links between the plugins |
| Last-access dates are not reliable | High | Low | Reported as Not checked, never inferred |

---

## 17. Open decisions

| Id | Question | Recommendation |
| --- | --- | --- |
| D1 | Share runtime code with PC Guardian as an internal package, or copy it? | Shared internal package, bundled into each plugin; no runtime dependency between plugins |
| D2 | Large scan output: paging (scripts never write) or scripts streaming into a run folder? | Paging, so "scans only read" stays absolute |
| D3 | Quarantine retention | Kept until the person purges; reminder after 30 days |
| D4 | Class A items: delete, or quarantine too? | Delete (they are re-created by their programs), labelled "Delete permanently" on the review screen |
| D5 | Antigravity cache paths | Confirm on a real install before M2 ships |
| D6 | Plugin name: `drive-cleanup` | Keep unless marketing prefers another; the name appears in tool ids, so change it before 0.2.0 |
| D7 | Should PC Guardian later show a "Deep cleanup" link to this plugin when it is installed? | Yes, as a small PC Guardian minor release after Drive Cleanup 1.0.0 |
