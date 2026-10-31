# Plan: Deep Cleanup (detailed C: drive audit, deduplication and quarantine)

Status: **proposed**, not started. Target release: **2.1.0** (see "Versioning" below).

This plan maps the "Complete Windows C drive cleanup & optimization" brief onto PC Guardian. It does not
turn Claude into a cleaner that runs PowerShell on its own: the brief's own safety rules (read-only first,
nothing destructive without explicit approval, zero data loss) are exactly PC Guardian's existing model, so
every new capability is built the PC Guardian way:

| Brief asks for                     | Built as                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Read-only scanning                 | New allowlisted, hash-checked **read-only scripts** in `ps/`, run by `safe-shell.ts`, as the current user.              |
| Classification and recommendations | Pure functions in core (`deps.js` source), unit-tested on recorded real-machine output.                                 |
| "Request my approval"              | The person ticks items on the dashboard's **Deep cleanup** page and confirms. Claude can preview and explain, never act. |
| Deletion / move                    | New allowlisted **action scripts** in `ps/actions/`, each guarded to one kind of change, run only by `cleanup.ts`.      |
| Quarantine + manifest              | A new reversible action (move, with **Restore**) and a CSV manifest beside the existing cleanup log.                    |
| The eight report files             | Written by `safe-writer.ts` into `%APPDATA%\pc-guardian-ai\audits\<timestamp>\`.                                        |

> **Where the work happens.** This repository holds the *built* plugin. `hooks/deps.js` is a bundle of the
> core package (schemas, `SCRIPTS`/`ACTIONS`, `SCRIPT_HASHES`, view models), and `dashboard/app` is a static
> Next.js export. The schema, guard, test and dashboard work below happens in the source repository and
> lands here as a rebuilt release. The `ps/` scripts, `hooks/*.ts`, skills, agent and README are edited in
> both places as today.

---

## 1. Ground rules (non-negotiable, enforced in code, not only in prompts)

These apply to every phase and are tested.

1. **Scans only read.** Deep-scan scripts open no file for writing, change no attribute, and do not follow
   reparse points (junctions, symlinks, OneDrive placeholders are counted as entries, never walked or
   hydrated: `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` / `OFFLINE` files are skipped for hashing).
2. **Protected paths** — one list, defined once in core and duplicated as a hard refusal at the top of every
   action script (defence in depth). An item under any of these is classified **C. Protected** and can never
   be ticked:
   - `C:\Windows` (incl. `System32`, `WinSxS`), `C:\Program Files`, `C:\Program Files (x86)`,
     `C:\ProgramData`, `C:\Users\Default`, `C:\Users\Public`, `C:\Recovery`, `C:\System Volume Information`,
     `C:\$Recycle.Bin` (handled only by the existing Recycle Bin item), boot files (`bootmgr`, `BOOTNT`,
     `pagefile.sys`, `hiberfil.sys`, `swapfile.sys`), other users' profiles.
   - Browser profile folders (everything under `User Data\<profile>` and Firefox profiles except the cache
     folders the existing browser-cache item already handles).
   - Credentials and keys anywhere: `.ssh\`, `.gnupg\`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `id_*`,
     `.env*`, `*.kdbx`, `credentials*`, `.aws\`, `.azure\`, `.kube\`, `.docker\config.json`, `.npmrc`,
     `.pypirc`, `.git-credentials`.
   - Databases: `*.db`, `*.sqlite*`, `*.mdf`, `*.ldf`, `*.accdb`, `*.pst`, `*.ost`.
   - **Projects**: any folder that contains (or is under a folder that contains) `.git`, `package.json`,
     `pyproject.toml`, `*.sln`, `*.csproj`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle*`,
     `.vscode`, `.idea`. Inside a project, only the named regenerable caches in §5 are ever listed, and only
     as **B. Review**.
   - VS Code / Antigravity installs and their `User` settings, extensions folders, and workspace storage.
3. **No automatic decisions.** Age, size, name similarity or "unused" never make an item deletable on their
   own. Duplicates are only ever confirmed by **SHA-256 over the full contents**, after a size match.
4. **Personal files are moved, not deleted.** Anything classified B (documents, media, installers,
   archives, downloads, duplicates) is **moved to quarantine** and can be restored. Only items classified
   A (verified regenerable caches, temp, logs, dumps) are deleted, as cleanup already does.
5. **Claude never acts.** New MCP tools only read. Actions run only from the dashboard/pane after the person
   ticks and confirms, with cleanup turned on, from a preview under 10 minutes old, with no scan running —
   the same `checkCleanRequest` gate that 1.1.0 introduced (decisions #33), extended to the new items.
6. **Not touched at all**, even with approval, because Windows has a supported way to do it: services,
   Defender, Windows Update settings, registry cleaning, drivers, uninstalling programs, `WinSxS`, system
   restore points. PC Guardian *reports* and gives manual steps (Settings > Storage, Disk Cleanup,
   `DISM /StartComponentCleanup`) — see §8.
7. **Recycle Bin is never emptied as a side effect.** Moves to quarantine do not use the Recycle Bin; the
   existing Recycle Bin item stays a separate, explicit tick.

---

## 2. Phase 1 — Deep storage audit (read-only)

A new, separate **Deep scan** job. It is *not* part of the 40-second health audit and does not change the
Health Score; it can take several minutes, shows progress per step in the pane and dashboard, and can be
cancelled between steps (the existing `CancelSignal`).

### New read-only scripts (`ps/deep/`)

Each one is added to `SCRIPTS` with its own timeout, output cap and `SCRIPT_HASHES` entry, and to
Settings > What PC Guardian reads.

| Script                     | Reads                                                                                                                                                                                                      | Output (capped)                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `deep/volume.ps1`          | Capacity / used / free of the system drive and other fixed drives (for quarantine), Storage Sense policy (HKCU `StorageSense\Parameters\StoragePolicy`, read only), NTFS last-access setting (`fsutil behavior query disablelastaccess` equivalent via registry). | Drives, Storage Sense on/off + cadence, whether last-access dates are trustworthy.                      |
| `deep/tree.ps1`            | One walk of `C:\` metadata (name, size, created, modified, accessed, attributes), skipping reparse points and protected roots' *contents* (their total size is still measured). Budget ~3 min / 2 M entries, `isTruncated` when hit. | Folder sizes to depth 3, top 100 largest files, empty directories (in user areas), counts/bytes not accessed 6 months / not modified 12 months, per-extension totals. |
| `deep/candidates.ps1`      | The same walk restricted to the user profile + `C:\` root non-system folders, matching category rules (§3).                                                                                               | Installers, archives, extracted-archive pairs, logs, crash dumps, temp/cache dirs, old downloads.       |
| `deep/dev-caches.ps1`      | Fixed list of known tool cache roots (§5) + project build dirs found under the user profile.                                                                                                              | Size, file count, last write, owning tool, whether the tool is running.                                 |
| `deep/duplicates.ps1`      | Groups files ≥ 1 MiB (configurable) by size; hashes only size collisions with SHA-256, reading contents. Opt-in (§6). Budget-limited; resumable by size buckets already done.                               | Duplicate groups: size, hash, paths, modified/accessed dates, suggested keeper.                         |
| `deep/leftovers.ps1`       | Installed programs (Uninstall keys, HKLM + HKCU, read only) vs folder names in `%LOCALAPPDATA%`, `%APPDATA%`, `%LOCALAPPDATA%\Programs`.                                                                 | Folders with no matching installed program — always **B. Review, low confidence**.                      |

**Output volume.** Today every script returns one JSON document on stdout, capped (64 KiB–1 MiB). Deep
scan results are larger, so each deep script returns *summaries plus top-N lists* on stdout (cap 4–8 MiB),
and the full per-file lists needed for the CSV reports are produced by paging (`PCG_PAGE`, `PCG_PAGE_SIZE`
params, validated by the script's zod schema). *Decision needed (D1):* alternatively let deep scripts stream
NDJSON into a run folder that `safe-writer.ts` pre-creates under `%APPDATA%\pc-guardian-ai\deep-scan\<runId>`;
simpler and faster, but it makes a read-only script write a file, which changes a stated guarantee.
Recommendation: **paging**, keep the guarantee.

**Last-accessed caveat.** When NTFS last-access updates are disabled (the default on many systems), "not
accessed for 6 months" is reported as *Not checked* with that reason, never inferred.

---

## 3. Phase 2 — Classification

Pure core function `classifyDeepScan(raw) → DeepFinding[]`. Each finding has: `id`, `path`, `kind`,
`sizeBytes`, `modified`, `accessed`, `class` (`safe` | `review` | `protected`), `reason` (human sentence),
`evidence` (the rule and the reading that matched), `proposedAction` (`delete` | `quarantine` | `none` |
`manual`), `confidence` (for heuristics), and for duplicates `groupId` + `isSuggestedKeeper`.

| Class                 | Contents                                                                                                                                                         | Proposed action                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **A. Safe to clean**  | User `%TEMP%` ≥ 7 days (existing), browser caches (existing), `%LOCALAPPDATA%\CrashDumps`, `%LOCALAPPDATA%\Temp\*\` extraction folders ≥ 7 days, app log folders on an allowlist (`*.log` in known app `logs\` dirs ≥ 30 days), npm/pnpm/yarn/pip caches (§5), `%LOCALAPPDATA%\D3DSCache`, thumbnail cache. | `delete` (permanent, as today).                                                                           |
| **B. Review**         | Duplicates, installers (`.exe/.msi/.msix/.msixbundle/.appx`) in Downloads/Desktop/Documents, archives (`.zip/.rar/.7z/.tar*/.iso`), archive+extracted-folder pairs, Downloads > 90 days, large files not modified 12 months, leftovers, empty folders, Gradle/Maven/Docker caches, project `.next`/`.vite` caches, `Windows.old` (manual only). | `quarantine` (reversible), or `manual` where Windows owns it.                                            |
| **C. Protected**      | Everything matched by §1.2.                                                                                                                                       | `none` — shown greyed with the rule that protects it, so the person sees *why* it is not offered.         |

**Duplicate keeper rule** (suggestion only; the person can choose another): prefer a copy that is
(1) inside Documents/Pictures/Videos/Music/OneDrive over Downloads/Desktop/Temp, (2) not inside an archive
extraction folder, (3) shortest path depth, (4) earliest created date, (5) has the original name over
`name (1).ext` / `Copy of name`. Each group needs its own tick; there is no "select all duplicates".

**Duplicate folders**: a folder pair is a duplicate when it has the same set of (relative path, size,
SHA-256) — computed from file hashes, so folder duplicates are found only when the duplicate step ran.

---

## 4. Phase 3 — Development environment caches

Measured by `deep/dev-caches.ps1` from fixed, known locations (never discovered by name guessing):

| Tool                 | Location(s)                                                                                   | Class | Clean by                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| npm                  | `%LOCALAPPDATA%\npm-cache\_cacache`, `_npx`                                                    | A     | Deleting the cache folder contents while `node.exe` is not running.                                |
| pnpm                 | `%LOCALAPPDATA%\pnpm\store`, `%LOCALAPPDATA%\pnpm-cache`                                      | B     | Manual: `pnpm store prune` (deleting the store breaks hard-linked `node_modules`).                 |
| Yarn                 | `%LOCALAPPDATA%\Yarn\Cache`, `%LOCALAPPDATA%\Yarn\Berry\cache`                                | A     | Folder contents, Yarn not running.                                                                 |
| pip                  | `%LOCALAPPDATA%\pip\cache`                                                                    | A     | Folder contents.                                                                                   |
| Gradle               | `%USERPROFILE%\.gradle\caches`, `wrapper\dists` (old versions)                                | B     | Quarantine of old wrapper dists; caches manual (offline builds need them).                         |
| Maven                | `%USERPROFILE%\.m2\repository`                                                                | B     | Manual only (report size; re-download cost noted).                                                 |
| Docker               | `docker system df` output if Docker CLI exists (read only)                                    | B     | Manual: `docker builder prune` — PC Guardian never runs Docker commands.                           |
| VS Code              | `%APPDATA%\Code\Cache`, `CachedData` (non-current versions), `CachedExtensionVSIXs`, `logs`    | A     | Folder contents, Code not running. `User\`, `extensions\`, `workspaceStorage` are protected.        |
| Antigravity          | Same layout as VS Code under its own `%APPDATA%` folder (path confirmed on a real install first) | A     | As VS Code.                                                                                        |
| Next.js / Vite       | `<project>\.next\cache`, `<project>\node_modules\.vite` under the user profile                 | B     | Quarantine of that one folder. Never `node_modules`, lock files, sources, `.git`.                  |

A tool's caches are offered only while that tool's process is not running. Uninstalling tools is out of
scope.

---

## 5. Phase 4 — Duplicate detection details

- Opt-in (§6) because it **reads file contents**; everything else in PC Guardian reads metadata only.
- Scope: user profile and non-system top-level folders of `C:\`; never protected paths; skips cloud
  placeholders and files over a size limit set in Settings (default 4 GiB) unless the person raises it.
- Algorithm: size buckets → (files ≥ 64 KiB) first-and-last 64 KiB pre-hash → full SHA-256 only on pre-hash
  collisions. Hashes stay on the machine in the run folder; they are never uploaded or put in a shared
  report.
- Each group shows size, hash, extension, every location, modified and accessed dates, the suggested keeper
  and why. Recoverable space for a group = size × (copies − 1).

---

## 6. Settings additions (all off by default)

- **Settings > Deep cleanup > Allow deep scan** (whole-drive metadata walk).
- **… > Find duplicates by content (SHA-256)** — explains it reads file contents, locally only.
- **… > Quarantine location** — auto-picks another fixed drive with enough space (`D:\PC Guardian
  Quarantine\<date>`); falls back to `C:\PC Guardian Quarantine` only after a free-space check (free space
  after the move ≥ 10 % of the drive and ≥ 10 GiB). Never a removable or network drive unless chosen.
- **… > Minimum duplicate size** (default 1 MiB), **maximum file size to hash** (default 4 GiB).
- Existing **Settings > Cleanup** switch still gates every action.

---

## 7. Phase 5 — Cleanup execution

### Flow (dashboard "Deep cleanup" page; pane gets a summary + link only)

1. Person runs Deep scan → findings by class, with total recoverable space (A total, B total, per category).
2. Person filters, ticks items or whole duplicate groups (keeper pre-unticked and cannot be ticked unless
   another copy in the group is unticked).
3. **Review screen**: exact paths, size, reason, action (`Delete permanently` / `Move to quarantine`),
   destination, and space check. Confirm button names the totals.
4. TS writes the request manifest (`%APPDATA%\pc-guardian-ai\quarantine\pending\<runId>.json`) via
   `safe-writer.ts`; the action script reads it by id, never by a caller-supplied path.
5. Action scripts, per item, **re-verify** before acting: path not under a protected root, not a reparse
   point, size and modified time unchanged since the scan, SHA-256 unchanged for duplicates. Any mismatch →
   item skipped with reason.
6. Results logged to the cleanup log and to the manifest CSV.

### New action scripts (`ps/actions/`)

| Action                     | Does                                                                                                                       | Params (validated)                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `quarantine-move.ps1`      | Moves listed files/folders into the quarantine root, preserving relative path (`<root>\C\Users\...`); same-volume rename, cross-volume copy → verify hash → delete source. Writes `restore.json` in the quarantine root. | `PCG_RUN_ID` (uuid), `PCG_PREVIEWED_AT`              |
| `quarantine-restore.ps1`   | Moves items back from a quarantine run (refuses if the original path now exists).                                         | `PCG_RUN_ID`, optional `PCG_ITEM_IDS` via manifest    |
| `quarantine-purge.ps1`     | Permanently deletes one quarantine run, only when the person presses **Delete quarantine for good**, never automatically.   | `PCG_RUN_ID`                                          |
| `clean-known-cache.ps1`    | Deletes contents of one allowlisted class-A cache root (enum id, not a path), only if its owning process is not running.  | `PCG_CACHE_ID` (enum), `PCG_PREVIEWED_AT`             |

Each gets its own ESLint-enforced guard entry (only `cleanup.ts` may call `runAction`) and hash.

### Deletion manifest

`%APPDATA%\pc-guardian-ai\audits\<timestamp>\deletion_manifest.csv`, appended per item:
`original_path, size_bytes, sha256, category, class, reason, action (deleted|quarantined|restored|skipped),
destination, timestamp_utc, run_id`. SHA-256 is filled for duplicates and for every quarantined file
(computed on move for verification).

---

## 8. Phase 6 — Windows optimization (report + manual steps only)

New recommendations in the existing recommendations engine, each with evidence, manual steps, risk and undo:

- Storage Sense off → how to turn it on (Settings > System > Storage > Storage Sense).
- Large `SoftwareDistribution\Download` / `Windows.old` / component store → *Disk Cleanup > Clean up system
  files* or *Settings > Storage > Temporary files*; `DISM /Online /Cleanup-Image /StartComponentCleanup`
  given as a manual admin command, never run.
- Browser caches → existing cleanup item.
- Startup apps → existing startup item.
- Unused applications → installed programs with no Start-menu launch evidence is not reliable; report only
  size + install date, sorted, and point to Settings > Apps. No uninstalling.
- Disk health → existing storage/stability data (SMART status via `MSFT_PhysicalDisk.HealthStatus`).

Explicitly out of scope: disabling services, Defender, Windows Update, registry cleaners, debloat scripts.

---

## 9. Phase 7 — Final verification

After a deep cleanup run, the dashboard offers **Verify**:

- Re-run `deep/volume.ps1` + `deep/tree.ps1` summary → space recovered = free-after − free-before, shown
  next to the sum the actions reported (they differ when other programs wrote meanwhile; both are shown).
- System integrity: `sfc /verifyonly` needs administrator rights → when not elevated, *Not checked* with the
  manual command; never `sfc /scannow` or DISM repair automatically.
- Dev environment check (read only): `code --version`, Antigravity version, `node -v`, `git --version`
  resolved from PATH with a timeout; each project root seen in the scan still has its `.git` and manifest
  files (count before/after).
- Writes `final_cleanup_report.md`.

---

## 10. Deliverables (reports)

Written by `safe-writer.ts` to `%APPDATA%\pc-guardian-ai\audits\<yyyy-mm-dd_hhmmss>\`, opened from the
dashboard ("Open audit folder" uses the existing safe open path). These contain **full local paths** — the
"remove personal paths" setting applies when they are exported or shared via `/pc-guardian:report`, and the
page says so.

| File                           | Produced by                                                       |
| ------------------------------ | ----------------------------------------------------------------- |
| `storage_audit.md`             | Phase 1 summary: capacity, folder sizes, age buckets, truncation. |
| `largest_files.csv`            | Top 100 largest files.                                            |
| `duplicate_files.csv`          | Phase 4 groups (group id, hash, size, path, dates, keeper).       |
| `installers_and_archives.csv`  | Phase 1/2 installer + archive findings.                           |
| `cache_analysis.md`            | Phase 3 table with sizes and how each is cleaned.                 |
| `cleanup_recommendations.md`   | All findings by class with reasons and estimated recoverable space.|
| `deletion_manifest.csv`        | Phase 5, appended per run.                                        |
| `final_cleanup_report.md`      | Phase 7.                                                          |

CSV writing escapes formula-leading characters (`= + - @`) to prevent CSV injection when opened in Excel.

---

## 11. Claude-facing surface

- New read-only MCP tools: `run_deep_scan` (starts the job; returns when done or with progress),
  `get_deep_findings` (filter by class/category, paged), `get_duplicate_groups`, `get_dev_cache_analysis`,
  `generate_deep_audit_reports`. Added to `skills/pc-audit` and the `pc-auditor` agent's allowlist.
- New skill `/pc-guardian:deep-cleanup`: runs/reads the deep scan, presents findings by class A/B/C with
  evidence and recoverable space, and directs the person to the dashboard's Deep cleanup page. Same rule as
  `/pc-guardian:cleanup`: Claude cannot move or delete, and must not try another way.
- `generate_report` gains a "deep audit" section when a deep scan exists.

---

## 12. Milestones

| #  | Milestone                                   | Contents                                                                                                   | Exit criteria                                                                                               |
| -- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| M1 | Read-only deep audit                        | `deep/volume`, `deep/tree`, `deep/candidates`, classification, `storage_audit.md`, `largest_files.csv`, `installers_and_archives.csv`, `cleanup_recommendations.md`, dashboard page (read only), `run_deep_scan` + `get_deep_findings`. | Recorded real-machine fixtures; full C: walk < 3 min on a 500 GB SSD; zero writes outside the data folder (Process Monitor capture in the release checklist). |
| M2 | Dev caches                                  | `deep/dev-caches`, `cache_analysis.md`, `clean-known-cache.ps1` for class-A caches.                         | Each cache id tested on a machine with the tool installed and running (refused) and closed (cleaned).        |
| M3 | Duplicates                                  | `deep/duplicates` (opt-in), keeper rule, folder duplicates, `duplicate_files.csv`.                          | Hash results match `Get-FileHash` on fixtures; budget/resume works; cloud placeholders never hydrated.       |
| M4 | Quarantine                                  | `quarantine-move/restore/purge`, manifest CSV, review screen, space checks.                                | Move → restore round-trip byte-identical (hash) same-drive and cross-drive; protected-path refusal tests for every rule in §1.2; changed-since-scan items skipped. |
| M5 | Optimization + verification                 | Storage Sense / Windows Update / disk-health recommendations, Verify step, `final_cleanup_report.md`.      | Not-elevated paths report *Not checked*; no system command runs that changes state.                          |
| M6 | Docs + release                              | README (What it reads: content hashing), dashboard What-we-read page, CHANGELOG, `/pc-guardian:deep-cleanup`. | Release checklist in `docs/deployment.md` passes; hashes regenerated.                                       |

M1 is shippable alone (read-only) and is the recommended first step.

---

## 13. Testing

- **Core:** classification, protected-path matcher (Windows path casing, `\\?\` prefixes, 8.3 short names,
  trailing dots/spaces, junctions into protected roots), keeper rule, CSV escaping, manifest round-trip —
  on recorded real output, as every test already is (2.0.0).
- **Scripts:** Pester tests on a throwaway VHDX fixture drive with junctions, symlinks, locked files,
  long paths (> 260), ACL-denied folders, OneDrive placeholders, and a fake project tree.
- **Guards:** each action refuses: protected path in manifest, stale preview (> 10 min), cleanup off, scan
  running, `-p` session, unknown cache id, manifest id not created by the mod.
- **Manual release check:** Process Monitor capture of a deep scan shows only reads; a quarantine
  run + restore on a real profile.

---

## 14. Versioning and open decisions

- **Version:** 2.1.0 (new capabilities, all opt-in). Content hashing is a change to "what it reads", but it
  is off until the person turns it on, so under the changelog's rule it is minor. *Decision D2:* confirm, or
  ship as 3.0.0 if the team treats any content read as a promise change.
- **D1:** paging vs run-folder output for deep scripts (§2). Recommended: paging.
- **D3:** default quarantine retention. Recommended: kept until the person purges; the dashboard shows its
  size and age and suggests purging after 30 days.
- **D4:** whether class-A items from the deep scan (crash dumps, dev caches, logs) are deleted (like Temp
  today) or also quarantined. Recommended: delete, matching the existing Temp/browser-cache behaviour, and
  say "deleted permanently" on the review screen.
- **D5:** Antigravity's cache layout must be confirmed on a real install before its cache ids are added.
