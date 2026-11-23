# Drive Cleanup

> **Beta (1.7.0-beta.1): not yet run on a Windows PC.** Every milestone in [PLAN.md](PLAN.md) is built
> and unit-tested, but the PowerShell scripts have not run on Windows yet. Follow
> [TESTING.md](TESTING.md) on a test PC or with a backup before using it on files you care about.

A deep audit and cleanup of the Windows system drive (C:), inside Claude Code, from Techgramam. Drive
Cleanup finds where the space went and what can be recovered safely, and you approve each item:

- **Duplicate files and folders**, confirmed by SHA-256 of their contents, never by name (off until you
  turn it on, because it reads file contents; nothing leaves your PC).
- **Old installers and archives**, including archives you already extracted.
- **Your Temp files** (unchanged for 7 days), **browser caches** (Edge, Chrome, Brave, Firefox, while closed; history, passwords and cookies are never touched), **old Temp folders, crash dumps, old app logs**, which programs re-create.
- **The Recycle Bin**, only when you or Claude name it, and only items deleted before you say yes.
- **Developer caches and build output**: npm, Yarn, pip, NuGet, VS Code, Antigravity (cleaned on
  approval); pnpm, Gradle, Maven, Docker (manual steps); Next.js, Vite, Turbo and Parcel caches inside
  projects.
- **Leftovers** of uninstalled programs, empty folders, and large files untouched for a year.
- **Windows space that needs administrator rights**, on your approval and Windows' own permission
  prompt: the Windows Temp folder, memory dumps, the Windows Update and Delivery Optimization caches,
  superseded Windows components (DISM component cleanup), and a smaller hibernation file.
- **Windows recommendations** for the rest (Storage Sense, Windows.old, restore points, low space, disk
  health): manual steps only.
- **Use the space better**, not only once: when you have another drive, which big folders (Videos,
  Pictures, Downloads…) and developer caches to move there and how; WSL and Docker disks that never
  shrink by themselves; OneDrive files kept on this PC; and quarantine still holding space. Steps for
  you, nothing moved for you.

## How it keeps your data safe

- **Scans only read**: names, sizes and dates. Links, junctions and cloud folders are not followed;
  OneDrive files that are not downloaded are never opened.
- **Protected, always**: `C:\Windows`, Program Files, ProgramData, other users, boot and recovery files,
  browser profiles, credentials and keys (`.ssh`, `.env`, certificates), databases, editor settings and
  extensions, and every development project (`.git`, `node_modules`, lock files, source). They are never
  offered.
- **Nothing changes without your yes.** Claude can scan, choose what to clean and propose it, but the
  cleanup starts only when you answer **Free N GB** in Claude Code's own dialog, which shows the real
  totals and the largest items. **Not now**, closing the dialog, or a session with no one to ask
  (`claude -p`) changes nothing; **Let me choose** ticks the items in the pane for you to change. Prefer to pick each item? Use the pane's Choose items tab instead.
- **Administrator tasks ask twice.** Windows' own permission prompt (UAC) comes after your yes; say No
  there and only the administrator part is skipped. Claude picks from six fixed tasks, never a path or a
  command, and the elevated script is checked against its fingerprint inside the elevated process before
  it runs.
- **Your files are moved, not deleted.** Installers, archives, downloads, duplicates, leftovers and the
  rest of class B go to `Drive Cleanup Quarantine` on another drive when there is room, and can be
  restored. Only re-creatable data (caches and temporary files) is deleted. On a PC with one drive the quarantine is on C:, so that space comes back only once you delete it for good. Quarantine is never deleted until you say so (in the pane, or `/drive-cleanup:quarantine` with its own question); until then it still takes space.
- **Checked again before acting.** Each item must be unchanged since the scan (size, date, and for
  duplicates the SHA-256), not a link and not protected; a move to another drive is verified by
  SHA-256 before the original is removed. Anything else is skipped and reported.
- **Every change is logged** in `deletion_manifest.csv`. **Nothing is uploaded**, ever.

## Commands

Three commands, one for each moment:

| Command | What it does |
| --- | --- |
| `/drive-cleanup:scan` | **Before.** What is using C: and how to get space back: what can be cleaned, what Windows can free, and what to move to another drive instead of deleting. Changes nothing. Add `duplicates`, `caches` or `reports` to go deeper, or ask a question. |
| `/drive-cleanup:free-space [target]` | **Clean.** Proposes what to clean (for example `20 GB`, or `developer caches`), asks you once, cleans, checks the result, and tells you how to keep the space. |
| `/drive-cleanup:quarantine` | **After.** Put files back from quarantine, delete a quarantine for good to free its space (asked first), or check what the cleanup changed. |

You can also just ask ("why is C: full?", "find duplicates", "write the reports").

**The pane** beside the chat (ask Claude to "open Drive Cleanup") has four tabs: **Overview** (free
space, what can be cleaned, **Clean safe items** in one press, Scan again, Verify), **Choose items**
(tick by category or item, then Clean selected…), **Undo** (Restore, or Delete for good) and
**Settings** (cleanup on/off, duplicate search on/off, quarantine drive). Only you can press its
buttons.

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

Drive Cleanup works on its own and cleans your Temp files, browser caches and (only when you name it)
the Recycle Bin itself. PC Guardian keeps its own cleanup for people without Drive Cleanup, and points to
`/drive-cleanup:free-space` when both are installed.

## Development

- Core unit tests: `bun test`, from the repository root (random order, each file isolated).
- Engine tests: `claude plugin test plugins/drive-cleanup`, from the repository root.
- Everything CI checks: `bun run ci` (see the root README).
- After changing a script in `ps/`: `node dev/update-hashes.mjs` (or `--check`). A script whose
  fingerprint does not match is never run.

Copyright (c) 2026 Techgramam. Proprietary; see LICENSE.
