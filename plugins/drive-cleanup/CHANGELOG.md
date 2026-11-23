# Changelog

All notable changes to Drive Cleanup. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
