# Changelog

All notable changes to Drive Cleanup. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0-beta.1] - 2026-11-23

Three commands, better use of the space, and the fixes from an end-to-end review. Still not run on Windows: see TESTING.md §10.

### Changed

- **Three commands**: `/drive-cleanup:scan` (before: what uses C:, read-only), `/drive-cleanup:free-space` (clean, one question), `/drive-cleanup:quarantine` (after: put back, delete for good, check). The nine other skills (audit, drive-audit, duplicates, dev-caches, report, review, self-check, verify, undo-cleanup) are folded into them; plain questions still work.
- Tool `get_windows_recommendations` is now `get_recommendations` and also covers how to use the space better (below).

### Added

- **Move, don't delete**: big personal folders (Videos, Pictures, Music, Documents, Downloads, Desktop) and developer caches to another drive with room, with each tool's own setting; where new apps and files are saved; WSL and Docker virtual disks (`--set-sparse`, `--move`, never delete the `.vhdx`); OneDrive files kept on this PC; quarantine still holding space (older than 14 days, or on C: where it frees nothing). Steps for the person only.
- **Tool `empty_quarantine`**: Claude can offer to delete a quarantine run for good; Claude Code asks the person first, as for Restore.

### Fixed

- **A cleanup with nothing to quarantine** (only caches, Temp, dumps, logs) stopped `apply.ps1` before it touched anything: `Join-Path` on an empty quarantine root.
- **Nothing moved is ever lost from Undo**: `restore.json` is saved after every move, not every 50; a cleanup stopped at Drive Cleanup's time limit records what it had already moved; a move to another drive that could not finish in time is not started.
- **A folder moved to another drive** whose original files could not all be removed is put back as it was, instead of leaving some originals gone and copies untracked.
- **Every copy of a duplicate** could go when a selected folder (a duplicate folder, a leftover) held the copy to keep; the planner now counts copies that stay where they are.
- **Space counted twice**: an old log inside Temp or a cache, a file inside a leftover folder. Nested findings are folded into the outer one.
- **Empty folders alone** got no quarantine and blocked the run.
- **Administrator tasks** were cut off at 10 minutes (DISM needs up to 30); in `Windows\Temp` the elevated script now enters only folders Windows or an administrator owns, and checks each folder for a link again just before entering it.
- **Quarantine folders** are readable only by you, SYSTEM and Administrators; Restore refuses to put files into Windows, Program Files, ProgramData or a Startup folder, and checks a file's SHA-256 before putting it back. A stopped or failed restore undoes its partial copy; Restore and Delete for good can be retried after a partial run.
- **Protection**: OneDrive folders (moving a file out deletes it from the cloud), every Chromium-based browser profile (Vivaldi, Opera GX, Arc, …), Thunderbird and Outlook data; `apply.ps1` now repeats the credential names, `.docker\config.json`, `.cursor` and `.antigravity`.
- A scan can no longer start during a cleanup; retrying one scan step no longer makes an old scan look fresh.
- Cache jobs after a long file move expired under the 15-minute approval rule; a cache where nothing could be removed is reported skipped, not cleaned.
- Temp cleanup keeps files extracted recently with old dates (creation time checked too).
- Verify's "freed" total no longer adds quarantine on C: and its purge together.
- Many browser profiles no longer fail the developer-cache step (limit 192 cache folders); the app-leftovers list stays within its limit and time; duplicate search stops before a group it cannot finish; Verify counts an unreadable quarantined file as missing instead of failing.

## [1.4.0-beta.1] - 2026-11-23

One question for everything. Still not run on Windows: see TESTING.md §6–§9.

### Added

- **Your Temp files** (unchanged for 7 days) are cleaned by Drive Cleanup itself, file by file, with the 7-day rule enforced in `clean-cache.ps1`. They used to be left to PC Guardian or Windows.
- **Browser caches** (Edge, Chrome, Brave, Firefox): only each profile's cache folders (Chromium: `Cache\Cache_Data`, `Code Cache`, `GPUCache`; Firefox: `cache2`), only while that browser is closed. The rest of a browser profile stays protected (§2.2 exception, tested).
- **The Recycle Bin** on the system drive: emptied item by item, only items deleted before the approval (by their `$I` record). Never chosen by "all safe items" or the pane's one-press button, only by name; the dialog says "Those files are gone for good."

### Changed

- `/drive-cleanup:free-space` asks **one** question: PC Guardian's second question is gone. PC Guardian keeps startup apps (speed, not space) and its own cleanup for people without Drive Cleanup.
- Emptied cache subfolders are removed only if they were older than the approval when read, so a folder an app just made stays.

## [1.3.0-beta.1] - 2026-11-23

Easier to use. Still not run on Windows: see TESTING.md §6–§8.

### Added

- **Clean safe items (…)** on the pane's Overview: one press selects every cache and temporary file and asks once (and turns cleanup on, if needed, by asking).
- **Turn on cleanup and clean selected…** in Choose items, in place of a trip to Settings.

### Changed

- **The confirmation is plain**: "Free up about 21 GB on C:?", then what is deleted (apps rebuild it), what is moved and can be put back, the Windows part with a heads-up about the "Windows PowerShell" permission prompt, and the biggest items. The yes button names the size (**Free 21 GB**); the others are **Let me choose** and **Not now**. A quarantine on C: is not counted as freed, and the dialog says so.
- **Plain words everywhere**: no "class A/B" in the pane; tabs are Overview, Choose items, Undo, Settings; results read "Deleted 14.2 GB of caches and temporary files, moved 4.1 GB of your files to quarantine" and end with how to undo.
- **`/drive-cleanup:free-space`** tells Claude how to talk: a short plan before and a before/after summary, sizes in GB, no jargon, and a fresh scan on its own when the old one is too old.

## [1.2.0-beta.1] - 2026-11-23

Administrator cleanup, asked twice. Not yet run on Windows: see TESTING.md §7.

### Added

- **`propose_cleanup` `elevatedTasks`**: six fixed administrator tasks: Windows Temp (older than 7 days), memory dumps, Windows Update download cache (skipped while updates install; the service restarts after), Delivery Optimization cache, DISM component cleanup (no /ResetBase), smaller hibernation file. The dialog lists them with estimated sizes; after Clean, Windows asks for permission (UAC). Declining UAC skips only those tasks.
- `get_windows_recommendations` lists the administrator tasks with size, effect and undo.
- Each administrator task is logged in the run record and `deletion_manifest.csv` (action `elevated`).

### Security

- The elevated process checks `ps/actions/elevated.ps1` against the fingerprint compiled into the plugin and runs the bytes it checked from memory; launcher and bootstrap are passed inline (`-EncodedCommand`), never from files; only task ids and Drive Cleanup's own paths reach them. PLAN.md §20, rule S3 reworded.

## [1.1.0-beta.1] - 2026-11-23

One command to free space; Claude proposes, you answer once. Still not run on a Windows PC: see TESTING.md §4.

### Added

- **`/drive-cleanup:free-space [target]`**: scans, picks what to clean (all class A, and class B only where the evidence is strong), proposes it, and verifies afterwards.
- **Tool `propose_cleanup`**: Claude names findings, or categories and classes with an optional size cap; Claude Code's own dialog shows the person the real totals and largest items with Clean (Turn on and clean, when cleanup is off), Show the list, or Cancel. Checked by the same planner as the pane; protected items, a duplicate group's copy to keep and anything Drive Cleanup does not clean are refused. After a Cancel, new proposals are refused for 5 minutes.
- **Tool `restore_quarantine`** and **`/drive-cleanup:undo-cleanup`**: restore a cleanup run after the person confirms.
- **`run_deep_scan` `includeDuplicates`**: asks the person to turn on duplicate search, in place of a trip to Settings.

### Changed

- **Safety rule S5**: "only the person approves" now covers both the pane and Claude's proposal; in both, nothing runs without the person's answer in Claude Code's dialog, and never in `-p`. Purging a quarantine stays in the pane only. PLAN.md §19.
- **Two commands instead of eight**: the other skills are no longer in the slash menu (`user-invocable: false`); Claude still uses them when asked.

## [1.0.0-beta.1] - 2026-10-31

Every milestone of PLAN.md built. Tested off Windows; not yet run on a Windows PC: see TESTING.md.

### Added

- **Cleanup you approve** (M4): in the pane's Review, select by category or item and press Clean selected…; Claude Code asks you to confirm. Class A (re-creatable) is deleted; class B is moved to `Drive Cleanup Quarantine`, on another drive when there is room. Each item is re-checked just before it is touched (unchanged, not a link, not protected, SHA-256 for duplicates); a move across drives is verified before the original is removed. Off until you turn it on in Settings.
- **Quarantine view**: Restore a run, or Delete it for good (with its own confirmation). Never deleted by itself.
- **Developer caches** (M2): npm, Yarn, pip, NuGet, VS Code and Antigravity caches cleaned on approval while the tool is closed; pnpm, Gradle, Maven, NuGet packages and Docker as manual steps. Project build caches (`.next\cache`, `node_modules\.vite`, `.turbo`, `.parcel-cache`).
- **App leftovers** (M2): app-data folders matching no installed program, as low-confidence review items.
- **Duplicates** (M3), opt-in because it reads file contents: SHA-256 groups and duplicate folders, a suggested copy to keep, never every copy; resumable.
- **Verification** (M5): free space again, developer tools, projects and quarantined files checked; `final_cleanup_report.md`.
- **Reports**: `duplicate_files.csv`, `cache_analysis.md`, `deletion_manifest.csv`, `final_cleanup_report.md`.
- **Tools** `get_dev_caches`, `get_duplicate_groups`, `get_quarantine`, `get_settings`, `verify_cleanup` (all read-only; none can clean); skills `/drive-cleanup:duplicates`, `/drive-cleanup:dev-caches`, `/drive-cleanup:review`, `/drive-cleanup:verify`.
- `TESTING.md`: the Windows test plan.

### Fixed

- A `.vscode` folder or a dotfiles `.git` in the profile no longer makes the whole profile count as a development project.

## [0.2.0-beta.1] - 2026-10-31

The read-only deep audit (milestone M1). Built and tested off Windows; not yet run on a Windows PC.

### Added

- **Deep scan** of the system drive in three read-only steps, each a fingerprint-checked PowerShell script: drives and settings, one metadata walk of C:, and Windows-managed space. Progress, Cancel and Retry in a pane beside the chat.
- **Classification** of what the walk finds into A. safe to clean, B. review, C. protected, with the rule and evidence for each: old Temp folders, crash dumps, old app logs, installers, archives (and archives already extracted), old downloads, large old files, empty folders, and Windows-managed space. Protected paths (Windows, Program Files, other profiles, credentials, `.env`, databases, browser profiles, editors, development projects) are never offered.
- **Windows recommendations** with manual steps: Storage Sense, Windows Update files, Windows.old, memory dumps, hibernation file, restore points, low space, disk health.
- **Reports:** `storage_audit.md`, `largest_files.csv`, `installers_and_archives.csv`, `cleanup_recommendations.md`.
- **Tools** for Claude, all read-only: `self_check`, `run_deep_scan`, `get_scan_status`, `get_storage_summary`, `get_largest_files`, `get_findings`, `get_windows_recommendations`, `generate_audit_reports`, `open_pane`. Skills `/drive-cleanup:audit`, `/drive-cleanup:report`, `/drive-cleanup:self-check`, and the `drive-auditor` agent.

## [0.1.0] - 2026-10-31

### Added

- The plugin's scaffold in the `techgramam` marketplace, and its implementation plan (`PLAN.md`). Nothing runs yet.
