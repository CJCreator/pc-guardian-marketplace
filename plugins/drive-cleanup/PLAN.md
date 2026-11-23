# Drive Cleanup: implementation plan

| | |
| --- | --- |
| Plugin | `drive-cleanup` (marketplace `techgramam`) |
| Status | **M1–M6 built, not yet run on Windows.** 1.0.0-beta.1; see §13 for what remains and §18 for where the build differs from this plan. |
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
- registry cleaning, debloat scripts, disabling services, Defender, Windows Update or startup processes (the Windows Update service is paused only while its download cache is cleared, then started again, §20);
- uninstalling programs or developer tools;
- `DISM` or `sfc` repairs, `/ResetBase`, removing `Windows.old` or restore points (reported, with manual steps). Since 1.2, component-store cleanup (`/StartComponentCleanup`), the Windows Update and Delivery Optimization caches, Windows Temp and memory dumps are done on approval with administrator rights (§20);
- emptying the Recycle Bin by itself, or on any drive but the system drive (since 1.4 it is emptied on approval, only by name, §19.7);
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
| S3 | **Only allowlisted scripts run**, by id, after their SHA-256 matches the hash recorded at build time, as the current user. No caller text reaches a command line. **Administrator rights** only for the fixed tasks of §20, only after the person's yes and Windows' own UAC prompt, with the fingerprint checked again inside the elevated process and the checked text run from memory. *(Changed in 1.2; it was: never elevated.)* | `safe-shell.ts` (`runAllowlisted`, `runElevated`), `core/elevated.ts`. |
| S4 | **Protected paths can never be acted on** (§2.2). The rule lives in core and is repeated as a refusal at the top of every action script. | Core classifier; each action script's guard; tests for every rule. |
| S5 | **Only the person approves.** An action runs only after the person answers yes in Claude Code's own dialog: to Clean selected in the pane, or to a proposal Claude made with `propose_cleanup` (§19). Claude can propose and ask, never answer. Cleanup must be on (the proposal's dialog can turn it on, by the person's answer), the scan under 24 hours old, no scan running. A dismissed dialog, or a `-p` session with no one to ask, changes nothing. Deleting a quarantine for good is asked the same way, run by run (`empty_quarantine`, §21). *(Changed in 1.1, §19, and 1.5, §21; it was: never from a Claude tool, then purge in the pane only.)* | `cleanup.ts` is the only module that calls `runAction`; both paths go through `planCleanup` and `act`; engine tests for no answer, cooldown and refusals. |
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
`build.gradle`, `build.gradle.kts`, `composer.json` or `Gemfile`. *(As built: not `.vscode` or `.idea`, which
many profiles hold at their root; and the profile root and top-level folders are never projects.)* Everything under a
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

### 3.1 Source layout (planned for a source monorepo)

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

### 3.2 Plugin layout (this folder)

**As built in M1**, the source lives in this folder; there is no separate build. The hooks module and core
are TypeScript the engine loads directly, `hooks/core/` holds the pure logic (no engine calls), and
`dev/` holds the developer tools: `dev/update-hashes.mjs` records the scripts' SHA-256 in
`hooks/script-hashes.ts`, and `dev/test/*.spec.ts` are the core's unit tests (Node). `tests/` holds the
engine tests run by `claude plugin test`. The layout planned for a build:

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
| 3 Candidates | *(in `scan/walk.ps1`, see §4.2)* | Collected during the walk itself, in this user's areas only | — | Installers, archives, extracted-archive pairs, logs, dumps, temp folders, old downloads, large old files, empty folders |
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

Scan scripts never write files (S1). **As built in M1:** the walk collects cleanup candidates in the same
pass, so no step needs another step's output and nothing is paged. Every list is capped in the script
(100 largest files, the 1,000 largest candidates of each kind, 1,500 folders, 200-entry samples) while
totals stay exact, and the report says when a list holds only the largest items. The whole output stays
under 4 MB, below both the engine's 4 MiB stdout limit and `$.fs.read`'s 4 MiB limit, so the mod stores
it as printed. This keeps D2's goal (scans never write) with less machinery than paging. Paging, by
`DC_PAGE` and `DC_PAGE_SIZE` inputs, stays the fallback if real drives hit the caps often.

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

### 10.1 MCP tools (read-only, except the two of §19 that ask the person)

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
| `propose_cleanup` | `{ findingIds? \| categories?, classes?, maxBytes? }` | Asks the person once (§19); the run's result, or why nothing changed |
| `restore_quarantine` | `{ runId }` | Asks the person; what was restored |

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

### M1: Read-only deep audit (0.2.0), built as 0.2.0-beta.1

- [x] Runtime (D1): a process runner and safe writer of the plugin's own (`hooks/safe-shell.ts`,
      `hooks/safe-writer.ts`), following PC Guardian's design. PC Guardian's source is not in this
      repository, so the shared package waits for the source monorepo.
- [x] Core: strict output schemas (`hooks/core/validate.ts`), step model and progress, protected-path
      matcher (§2.2, `hooks/core/paths.ts`) with a test for each rule.
- [x] Scripts: `scan/volume.ps1`, `scan/walk.ps1` (candidates collected in the same pass, §4.2),
      `scan/windows.ps1`.
- [x] Classifier for every category except duplicates, dev caches and leftovers (`hooks/core/classify.ts`);
      Windows recommendations (`hooks/core/recommend.ts`).
- [x] Mod: `register.tsx`, `scan.ts`, `tools.ts`; tools `self_check`, `run_deep_scan`, `get_scan_status`,
      `get_storage_summary`, `get_largest_files`, `get_findings`, `get_windows_recommendations`,
      `generate_audit_reports`, `open_pane`.
- [x] Reports: `storage_audit.md`, `largest_files.csv`, `installers_and_archives.csv`,
      `cleanup_recommendations.md` (`hooks/core/reports.ts`).
- [x] Pane with progress, Cancel (between steps) and Retry. Skills `audit`, `report`, `self-check`,
      `drive-audit`; agent `drive-auditor`.
- [x] Tests: 58 core unit tests (`node --experimental-strip-types --test dev/test/*.spec.ts`) and 5 engine
      tests (`claude plugin test`), type-checked against the engine's declarations.
- [ ] **Run on Windows.** The PowerShell scripts were written for Windows PowerShell 5.1 but have not run
      yet: the build environment had no PowerShell. Run `/drive-cleanup:self-check` and
      `/drive-cleanup:audit` on at least two real PCs, fix what breaks, and record their output
      (anonymised) as test fixtures in place of the hand-made ones in `dev/test/fixtures.ts`.
- **Exit (open):** recorded fixtures from at least two real PCs; a full scan of a 500 GB SSD with 1.5 M
  files in under 4 min; a Process Monitor capture shows no writes outside the data folder and no reads of
  contents; junction, placeholder and long-path fixtures pass. Then release 0.2.0.

### M2: Developer caches and leftovers, built

- [x] `scan/dev-caches.ps1` (17 caches at fixed locations, with the owning tool's running state),
      `scan/leftovers.ps1` (uninstall entries and Store packages vs app-data folders); categories
      `dev_cache_safe`, `dev_cache_review`, `leftover`, and `build_cache` from the walk.
- [x] `cache_analysis.md`; tool `get_dev_caches`; skill `dev-caches`.
- [x] A test checks the cache ids agree across `devcaches.ts`, `dev-caches.ps1` and `clean-cache.ps1`.
- [ ] **Open:** every location confirmed on a real install of its tool (D5 for Antigravity).

### M3: Duplicates, built

- [x] `scan/hash.ps1` (opt-in): size buckets, quick hash of the first and last 64 KiB, full SHA-256,
      largest first, 8-minute budget, resume from where it stopped ("Continue duplicate search").
- [x] Keeper rule (§5.4), folder duplicates from file hashes (nested ones reported once, at the top),
      `duplicate_files.csv`, tool `get_duplicate_groups`, skill `duplicates`, the setting and its wording.
- [ ] **Open:** hashes compared with `Get-FileHash` on a real PC; OneDrive placeholders confirmed not
      hydrated (TESTING.md §5).

### M4: Approval, cleanup and quarantine, built

- [x] Approval in the **pane** (§18): Review by category or item, Quarantine (Restore, Delete for
      good), Settings (cleanup, duplicate search, quarantine drive).
- [x] `hooks/core/plan.ts`: the request gate, unit-tested rule by rule; `hooks/cleanup.ts`, the only
      caller of `runAction`; run log, per-run records and `deletion_manifest.csv`.
- [x] Actions: `apply.ps1` (delete class A, quarantine class B, with its own protected-path guard and
      re-checks), `clean-cache.ps1`, `restore.ps1`, `purge.ps1`; each hash-checked, inputs by strict
      pattern.
- [x] Space check and quarantine drive choice; `restore.json` in every quarantine run.
- [ ] **Open:** move and restore round-trips on a real PC, same drive and across drives
      (TESTING.md §3).

### M5: Verification, built

- [x] `scan/verify.ps1` (tool versions from file version information, projects, quarantine integrity
      by SHA-256), Verify in the pane, tool `verify_cleanup`, skills `verify` and `review`,
      `final_cleanup_report.md`.
- [x] Windows integrity: reported with the manual `sfc` command, not run (§18).

### M6: Hardening and 1.0.0

- [x] 87 unit tests and 8 engine tests; type-checked against the engine's declarations; plugin and
      marketplace validate.
- [x] README, CHANGELOG, `TESTING.md` (the Windows test plan, from read-only to destructive).
- [ ] **Open:** TESTING.md passed on five machines (developer, media-heavy, OneDrive-heavy, a small
      drive, non-English Windows); recorded fixtures replace the hand-made ones; a second engineer's
      review of `ps/actions/`; accessibility pass of the pane. Then 1.0.0.

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
| D1 | Share runtime code with PC Guardian as an internal package, or copy it? | Shared internal package, bundled into each plugin. **M1:** own copy of the design, until a source monorepo exists |
| D2 | Large scan output: paging (scripts never write) or scripts streaming into a run folder? | Scripts never write. **M1:** capped lists in one pass (§4.2); paging if real drives need it |
| D3 | Quarantine retention | Kept until the person purges; reminder after 30 days |
| D4 | Class A items: delete, or quarantine too? | Delete (they are re-created by their programs), labelled "Delete permanently" on the review screen |
| D5 | Antigravity cache paths | Confirm on a real install before M2 ships |
| D6 | Plugin name: `drive-cleanup` | Keep unless marketing prefers another; the name appears in tool ids, so change it before 0.2.0 |
| D7 | Should PC Guardian later show a "Deep cleanup" link to this plugin when it is installed? | Yes, as a small PC Guardian minor release after Drive Cleanup 1.0.0 |

---

## 18. As built: differences from this plan

| Plan | As built | Why |
| --- | --- | --- |
| Browser dashboard for approval (§7.1, §11) | Approval in the pane beside the chat, with Claude Code's own confirmation dialog | No local web server or bundled runtime to ship; the pane's buttons can only be pressed by the person, and the dialog is refused where no one can answer (`-p`). A browser dashboard can follow if large selections need it. |
| Findings list under 10 minutes old (S5) | Scan under 24 hours old; the approval itself must be under 15 minutes old when the scripts act | A deep scan takes minutes and reviewing takes longer. Safety comes from S7: every item is re-checked (size, date, SHA-256 for duplicates, links, protection) just before it is touched. |
| Separate `quarantine-move.ps1` and `delete-safe.ps1` | One `apply.ps1` for both | One copy of the guard to keep right. |
| The user Temp folder cleaned when PC Guardian is absent | Never cleaned by Drive Cleanup; PC Guardian or Windows' own tools | A folder-wide delete could not keep to the 7-day rule. Old Temp *subfolders* are still class A. |
| Gradle wrapper distributions quarantined | Manual | Which versions projects still use cannot be told safely. |
| Docker via `docker system df` | Size of Docker Desktop's data disk; manual commands | Drive Cleanup runs no third-party programs. |
| Dev tool versions by running `--version` | Read from the program file's version information | Nothing is executed. |
| `sfc /verifyonly` when elevated | Not run; the command is given | It takes long and needs administrator rights; Drive Cleanup never touches Windows files. |
| Pending approved lists removed after a run | Kept in `runs\pending\` | The engine's file API has no delete. They are small and hold only paths already in the manifest. |
| `.vscode` and `.idea` as project markers | Not markers; the profile root and top-level folders are never projects | Many profiles hold `.vscode` (and some a dotfiles `.git`) at their root, which would have hidden everything. |

## 19. One-confirm cleanup (1.1)

### 19.1 Problem

Getting space back took about eight steps: turn cleanup on in Settings, turn duplicate search on, scan,
open the pane, find items, tick each, Clean selected, confirm. Eighteen slash commands across the two
plugins, three of them duplicated. Claude could explain everything and change nothing.

### 19.2 Goal

The person says "free up space". Claude scans, chooses, and proposes; the person answers **one** dialog;
the cleanup runs, is verified, and can be undone. Three commands in all.

**Done when:** on a real PC, `/drive-cleanup:free-space` goes from prompt to space freed with exactly one
confirmation, `/drive-cleanup:undo-cleanup` restores those files byte for byte, and every rule in §2.1
still has a passing test.

### 19.3 What stays the same

Every rule in §2.1 except the wording of S5. The planner (`planCleanup`) and the action scripts refuse
exactly what they refused before; the re-check before acting (S7), quarantine for class B (S6), the
space check (S9), the duplicate keeper (S10) and the manifest (S11) are untouched. Nothing runs in `-p`.
Purge stays in the pane only. The scripts and their hashes do not change.

### 19.4 Design

| Part | What | Where |
| --- | --- | --- |
| Selection | `selectForProposal`: named ids must all exist and be actionable, or the whole proposal is refused; categories/classes take actionable items only, largest first, never a duplicate keeper; `maxBytes` caps the total; at most 500 items | `core/propose.ts` |
| Question | `proposalQuestion`: built from the scan, never from Claude's words: item count, the planner's summary (what is deleted, what is quarantined and where), the three largest items | `core/propose.ts` |
| Dialog | `$.ui.ask` with Clean (or **Turn on and clean** when cleanup is off), **Show the list**, Cancel. Planned as if cleanup were on, so the person sees the real plan before deciding | `cleanup.ts` `proposeCleanup` |
| Act | One path for both the pane and the proposal: plan again at the moment of acting, write the approved list, run `apply` and `cleanCache`, record the run | `cleanup.ts` `act` |
| Show the list | Puts the proposed ids in the pane's selection, opens Review; nothing runs | `cleanup.ts` |
| Decline | Cancel, a dismissed dialog or no one to ask: nothing changes, and new proposals are refused for 5 minutes, so a looping or steered model cannot nag | `cleanup.ts` |
| Undo | `restore_quarantine` calls the pane's restore, with its own confirmation | `tools.ts`, `cleanup.ts` |
| Duplicates | `run_deep_scan { includeDuplicates: true }` asks the person to turn duplicate search on | `consent.ts` |
| Commands | Visible: `/drive-cleanup:free-space`, `/drive-cleanup:undo-cleanup`, `/pc-guardian:audit`. The rest `user-invocable: false`, still used by Claude | `skills/*/SKILL.md` |

### 19.5 Threats, and the answer to each

| Threat | Answer |
| --- | --- |
| A file named like an instruction steers Claude into proposing it | The planner refuses anything protected or not cleanable whatever Claude names; the dialog shows the real items and totals; the person decides |
| Claude describes a proposal as smaller or safer than it is | The question is built from the scan and the planner, not from Claude |
| A model asks again and again until the person clicks yes | 5-minute cooldown after a decline; the skill tells Claude not to re-propose unless asked |
| Unattended runs (`-p`, SDK, CI) | `$.ui.ask` rejects with no one to ask; that is a decline |
| Claude deletes another way (shell) | Out of this plugin's reach; the skills forbid it, and Claude Code's own permission prompts still apply |

### 19.6 Work, in order

| Step | What | Runs alongside | Status |
| --- | --- | --- | --- |
| A | TESTING.md §0–§3 and the new §6 on a Windows VM | B, C | **Not done: needs a Windows PC** |
| B | `propose_cleanup`, `restore_quarantine`, shared `act`, cooldown; unit and engine tests | A, C | Built |
| C | Three visible commands; skills rewritten; READMEs | A, B | Built |
| D | First-run consent folded into the proposal's dialog; duplicate search asked from the scan | after B | Built |
| E | One plan with PC Guardian: `/free-space` also cleans the Recycle Bin and browser caches | after B | **Built (PC Guardian 2.1.0)**: PC Guardian's own `propose_cleanup`, one plain question, through its existing `runCleanup`; no change to its bundled `deps.js` or scripts. At most two questions in `/free-space`, see §19.7 |
| F | One question: Drive Cleanup cleans Temp, browser caches and the Recycle Bin itself (§19.7) | after B | **Built (1.4)** |
| — | Optional "approve caches under N GB without asking" | — | **Not built on purpose**: it would break "nothing without a yes"; revisit after A |

### 19.7 Why two questions, and how to get to one

Each plugin asks for its own cleanup. A shared approval is not safe between plugins: if Drive Cleanup's
yes could unlock PC Guardian's cleanup, so could Claude, by calling PC Guardian with whatever proof Drive
Cleanup passed. So `/drive-cleanup:free-space` asks at most twice: Drive Cleanup's question (files,
caches, Windows), then PC Guardian's (Recycle Bin, browser caches), only when that is worth it (about
500 MB).

**Done in 1.4: one question.** Drive Cleanup cleans the space kinds itself, through `clean-cache.ps1`
(fixed folders, by id): the user Temp folder (7-day rule), each browser's cache folders (only while it is
closed; §2.2 now excepts exactly those folders inside a browser profile), and this user's Recycle Bin on
the system drive (only items whose `$I` record predates the approval; chosen only by name, never by
"all safe items"). `/free-space` no longer asks PC Guardian. PC Guardian keeps startup apps (speed) and
its own cleanup for people without Drive Cleanup; merging the two plugins fully (one install) is still
open and needs the shared runtime (D1).

## 20. Administrator cleanup (1.2)

### 20.1 Goal

Claude can also clean the space only an administrator can reach, and the person still decides twice:
once in Claude Code's dialog (what), once in Windows' UAC prompt (with what rights). Nothing elevated runs
without both.

### 20.2 Tasks (fixed; Claude picks ids, never paths or commands)

| Task | Does | Size from the scan | Undo |
| --- | --- | --- | --- |
| `windows_temp` | Files in `C:\Windows\Temp` older than 7 days; in-use kept | `windows_temp` | Not needed |
| `memory_dumps` | `MEMORY.DMP`, `Minidump\*.dmp`, `LiveKernelReports\**\*.dmp` | dumps | Cannot; diagnostics only |
| `windows_update_cache` | Pauses `wuauserv`, clears `SoftwareDistribution\Download`, starts it again; skipped while `TiWorker` runs | `update_cache` | Not needed |
| `delivery_optimization` | `Delete-DeliveryOptimizationCache -Force` | unknown until run | Not needed |
| `component_store` | `DISM /Online /Cleanup-Image /StartComponentCleanup` (no `/ResetBase`) | unknown until run | Not needed |
| `hibernation_reduce` | `powercfg /hibernate /type reduced` (a setting; Fast Startup kept) | about half of `hiberfil.sys` | `powercfg /hibernate /type full` |

Still out: `Windows.old`, restore points, `/ResetBase`, turning hibernation fully off, anything in the
registry, any user file (those go through §7 and quarantine).

### 20.3 The chain

1. `propose_cleanup { elevatedTasks }`: the dialog adds "Needs administrator, so Windows will ask you once
   more: …" with each task's estimated size.
2. Yes → `act` runs the file part first (if any), then `runElevated`.
3. `runElevated` checks `elevated.ps1` against its compiled fingerprint, writes `elevated/<runId>.request.json`
   (the safe writer creates the folder), and runs `powershell.exe -EncodedCommand <launcher>`.
4. The launcher (as the user) runs `Start-Process powershell -Verb RunAs -EncodedCommand <bootstrap>`:
   **Windows shows UAC**. Declined (error 1223) → `declined`, nothing elevated runs; the file part stands.
5. The bootstrap (elevated) reads `elevated.ps1`, hashes it, compares with the literal it carries, and only
   then runs **that text** with `[ScriptBlock]::Create`. It writes the result with `FileMode.CreateNew` after
   refusing any linked folder on the result path.
6. The mod reads and validates the result (`RawElevatedCheck`) and logs each task in the run record and the
   manifest (category `windows_managed`, action `elevated`).

### 20.4 Threats

| Threat | Answer |
| --- | --- |
| User-level malware swaps `elevated.ps1` after the check, before UAC | The elevated process checks the bytes it read itself and runs those bytes from memory |
| It swaps a launcher file | There is none: launcher and bootstrap are built in the module and passed as `-EncodedCommand` |
| Claude passes a path or command | The input is an enum of task ids; `checkLaunch` refuses any path Drive Cleanup did not build (drive-rooted, no quotes, `$`, backtick, wildcards) |
| A planted file or junction where the result is written | `CreateNew` fails on an existing file; any reparse point on the result path is refused |
| UAC fatigue: a model asks for admin repeatedly | Admin runs only after the dialog's yes; the 5-minute decline cooldown applies to the whole proposal |
| A standard user enters another account's admin credentials | Paths are passed in, not read from the elevated account's environment; it writes to the asking user's data folder |
| Interrupting Windows Update | Skipped while `TiWorker` runs; the service is restarted in `finally` |
| Constrained Language Mode / WDAC | The elevated run fails and says so; nothing partial is claimed |

### 20.5 Status

Built and unit-tested (launch checks, fingerprint-before-run order, encoding round-trip, static rules on
`elevated.ps1`, estimates, the dialog line); engine-tested for refusals. **Never run on Windows**: UAC,
DISM, the services and the bootstrap need TESTING.md §7 on a Windows VM before release.

## 21. Three commands, and using the space well (1.5)

### 21.1 Three commands

Ten skills became three, each for one moment:

| Command | When | Changes |
| --- | --- | --- |
| `/drive-cleanup:scan [fresh \| duplicates \| caches \| reports \| a question]` | Before: what uses C: and how to get space back (clean, Windows, move) | Nothing |
| `/drive-cleanup:free-space [target]` | Clean: one proposal, one question | On the person's yes |
| `/drive-cleanup:quarantine [restore \| empty \| check]` | After: put back, delete for good, verify | On the person's yes |

`scan` also answers plain questions ("why is C: full?"), so the old model-only skills (audit,
drive-audit, duplicates, dev-caches, report, self-check, review, verify, undo-cleanup) are folded in.

### 21.2 Use the space, not only clean it

Cleaning gives space back once; caches and downloads refill it. `get_recommendations` (was
`get_windows_recommendations`) adds, from data the scan already has (no script changed):

| Id | When | Advice |
| --- | --- | --- |
| `move_personal_folders` | Videos, Pictures, Music, Documents, Downloads or Desktop ≥ 5 GB and another NTFS/ReFS drive keeps 10 % and 10 GB free after | Properties > Location > Move… |
| `new_content_location` | Another drive with room for 50 GB | Settings > Storage > Where new content is saved; game libraries |
| `move_dev_caches` | Moveable developer caches ≥ 5 GB | Each tool's own setting (`npm config set cache`, `PIP_CACHE_DIR`, `NUGET_PACKAGES`, `GRADLE_USER_HOME`, Maven `localRepository`, pnpm `store-dir`, Docker disk location) |
| `virtual_disks` | A `.vhdx` ≥ 5 GB among the largest files | Prune inside, `wsl --manage <name> --set-sparse true`, `--move`; never delete the file |
| `onedrive_files` | A OneDrive folder ≥ 5 GB downloaded | Free up space (Files On-Demand) |
| `quarantine_waiting` | Active quarantine older than 14 days, or any on the system drive (frees nothing there) | Check, then restore or delete for good |

All are steps for the person; Drive Cleanup moves no folder and changes no setting for them.

### 21.3 Deleting a quarantine for good from Claude

`empty_quarantine { runId }` asks in Claude Code's dialog ("Delete … for good? Those files cannot be put
back afterwards.") and runs the same `purge.ps1` as the pane. The skill asks Claude to use it only when the
person asks, run by run, and never in the same answer as the cleanup that made the quarantine. Without an
answer (dismissed, `-p`) nothing is deleted.

### 21.4 Review fixes (1.5)

An end-to-end review (scripts and TypeScript, read only: no Windows run yet) found and fixed: the empty
quarantine root that stopped every delete-only `apply.ps1` run; `restore.json` saved only every 50 moves;
partial cross-drive folder moves; duplicate copies leaving inside a selected folder; nested findings
counted twice; empty-folder-only selections; the 10-minute cap on administrator tasks; a junction race in
the elevated `Windows\Temp` cleanup; quarantine folders readable by every local account and a restore
that trusted `restore.json`'s original paths; OneDrive, other browsers and mail stores unprotected; scans
during a cleanup; stale approvals for later cache jobs. See CHANGELOG 1.5.0-beta.1.

### 21.5 Open gaps closed (1.6)

| Gap | Now |
| --- | --- |
| Paths over 260 characters | `walk.ps1` counts them apart from denied folders (`longPathFolders`, with a sample) and the reports and summary say their contents were not read or offered. `apply.ps1` never moves anything to a quarantine path of 260 characters or more (a file, or the deepest file of a folder), so a quarantine can always be restored and deleted. Reading such folders (`\\?\` paths) waits for a Windows run: Windows PowerShell 5.1's legacy path handling makes it unsafe to assume. |
| External USB disks reported as fixed | `volume.ps1` reads each disk's bus (`MSFT_PhysicalDisk.BusType`); USB, 1394, SD and MMC are `isExternal`. "Auto" never quarantines there and move advice never points there; a drive the person names in Settings is still used. |
| 8.3 short names | `apply.ps1` expands each `~N` segment to its real name (listing the parent with the short name as pattern) before the guard; restore refuses any original with a short-name segment. |
| `'` or `$` in the user or plugin path | Allowed: every path reaches PowerShell in single quotes, and `quote` doubles `'` and the typographic quotes PowerShell also accepts. Double quotes, control characters and wildcards are still refused. |
| `large_old` outside the user's areas | Only in the user's own areas (profile outside AppData, top-level user folders), like installers and archives. |
| Partial Restore left the size unchanged | The index subtracts what came back, so the next question says what is left. |
