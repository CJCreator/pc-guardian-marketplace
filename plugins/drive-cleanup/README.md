# Drive Cleanup

> **Beta (1.1.0-beta.1): not yet run on a Windows PC.** Every milestone in [PLAN.md](PLAN.md) is built
> and unit-tested, but the PowerShell scripts have not run on Windows yet. Follow
> [TESTING.md](TESTING.md) on a test PC or with a backup before using it on files you care about.

A deep audit and cleanup of the Windows system drive (C:), inside Claude Code, from Techgramam. Drive
Cleanup finds where the space went and what can be recovered safely, and you approve each item:

- **Duplicate files and folders**, confirmed by SHA-256 of their contents, never by name (off until you
  turn it on, because it reads file contents; nothing leaves your PC).
- **Old installers and archives**, including archives you already extracted.
- **Old Temp folders, crash dumps, old app logs**, which programs re-create.
- **Developer caches and build output**: npm, Yarn, pip, NuGet, VS Code, Antigravity (cleaned on
  approval); pnpm, Gradle, Maven, Docker (manual steps); Next.js, Vite, Turbo and Parcel caches inside
  projects.
- **Leftovers** of uninstalled programs, empty folders, and large files untouched for a year.
- **Windows recommendations**: Storage Sense, Windows Update files, Windows.old, memory dumps, the
  hibernation file, restore points, low space, disk health. Manual steps only: Drive Cleanup never
  changes Windows settings.

## How it keeps your data safe

- **Scans only read**: names, sizes and dates. Links, junctions and cloud folders are not followed;
  OneDrive files that are not downloaded are never opened.
- **Protected, always**: `C:\Windows`, Program Files, ProgramData, other users, boot and recovery files,
  browser profiles, credentials and keys (`.ssh`, `.env`, certificates), databases, editor settings and
  extensions, and every development project (`.git`, `node_modules`, lock files, source). They are never
  offered.
- **Nothing changes without your yes.** Claude can scan, choose what to clean and propose it, but the
  cleanup starts only when you answer **Clean** in Claude Code's own dialog, which shows the real totals
  and the largest items. Cancel, closing the dialog, or a session with no one to ask (`claude -p`)
  changes nothing. Prefer to pick each item? Do it in the pane's Review instead.
- **Your files are moved, not deleted.** Installers, archives, downloads, duplicates, leftovers and the
  rest of class B go to `Drive Cleanup Quarantine` on another drive when there is room, and can be
  restored. Only re-creatable data (class A) is deleted. Quarantine is never deleted until you say so.
- **Checked again before acting.** Each item must be unchanged since the scan (size, date, and for
  duplicates the SHA-256), not a link and not protected; a move to another drive is verified by
  SHA-256 before the original is removed. Anything else is skipped and reported.
- **Every change is logged** in `deletion_manifest.csv`. **Nothing is uploaded**, ever.

## Commands

| Command | What it does |
| --- | --- |
| `/drive-cleanup:free-space [target]` | Scans C:, proposes what to clean (for example `20 GB`, or `developer caches`), asks you once, cleans, then verifies |
| `/drive-cleanup:undo-cleanup` | Puts back the files of a cleanup from quarantine, after you confirm |

That is all you need. You can also just ask ("why is C: full?", "find duplicates", "write the reports"):
Claude uses Drive Cleanup's other skills (audit, duplicates, developer caches, reports, verify,
self-check, choosing items by hand in the pane) without a command of their own.

You can also just ask ("why is my C: drive full?", "which installers can I remove?").
**The pane** beside the chat has four views: **Overview** (free space, recoverable space, scan
progress with Cancel and Retry, Verify), **Review** (select by category or item, then Clean
selected…), **Quarantine** (Restore, or Delete for good) and **Settings** (cleanup on/off, duplicate
search on/off, quarantine drive). Only you can press its buttons.

## Reports

In `%APPDATA%\techgramam-drive-cleanup\audits\<date>\`: `storage_audit.md`, `largest_files.csv`,
`duplicate_files.csv`, `installers_and_archives.csv`, `cache_analysis.md`,
`cleanup_recommendations.md`, `deletion_manifest.csv` and `final_cleanup_report.md`. They contain full
paths from your PC, so share them with care.

## What it reads

Scripts in `ps/scan/`, each checked against its recorded fingerprint before it runs, as your normal
user: drives and settings (`volume.ps1`); one walk of C: (`walk.ps1`, up to 4 minutes); developer caches
at their fixed locations (`dev-caches.ps1`); installed programs and app-data folders (`leftovers.ps1`);
Windows-managed space (`windows.ps1`); file contents for duplicates, only when you turn it on
(`hash.ps1`); and, when you verify, program version information and quarantined files
(`verify.ps1`). The scripts that change files are in `ps/actions/`, and run only after you approve.

## Install

Requirements: Windows 10 or 11, Claude Code 2.1.312 or later, no administrator rights.

```
/plugin install drive-cleanup --marketplace CJCreator/pc-guardian-marketplace
```

Then start a new session and ask Claude to check that Drive Cleanup can run (its self-check). Uninstalling leaves
`%APPDATA%\techgramam-drive-cleanup` and any `Drive Cleanup Quarantine` folder: restore or delete your
quarantine runs first.

## With PC Guardian

Drive Cleanup works on its own. The user Temp folder and the Recycle Bin are left to PC Guardian's
cleanup (or Windows' own), and Drive Cleanup links to it.

## Development

- Core unit tests: `bun test`, from the repository root (random order, each file isolated).
- Engine tests: `claude plugin test plugins/drive-cleanup`, from the repository root.
- Everything CI checks: `bun run ci` (see the root README).
- After changing a script in `ps/`: `node dev/update-hashes.mjs` (or `--check`). A script whose
  fingerprint does not match is never run.

Copyright (c) 2026 Techgramam. Proprietary; see LICENSE.
