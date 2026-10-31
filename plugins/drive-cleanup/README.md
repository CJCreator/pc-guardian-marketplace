# Drive Cleanup

> **Preview (0.2.0-beta.1).** The read-only deep audit (milestone M1) is built and tested here, but has
> **not yet run on a Windows PC**: expect rough edges, and please report what `/drive-cleanup:self-check`
> and `/drive-cleanup:audit` say. It cannot delete or move anything yet; approval, quarantine and
> duplicate detection come in later versions. See [PLAN.md](PLAN.md).

A deep audit and cleanup of the Windows system drive (C:), inside Claude Code, from Techgramam. Drive
Cleanup finds where the space went and what can be recovered safely, and lets you approve each item:

- **Duplicate files and folders**, confirmed by SHA-256 of their contents, never by name (off until you
  turn it on, because it reads file contents; nothing leaves your PC).
- **Old installers and archives**, including archives you already extracted.
- **Temp files, crash dumps, old logs and caches** that programs re-create.
- **Developer caches and build output**: npm, pnpm, Yarn, pip, NuGet, Gradle, Maven, Docker, Next.js, Vite,
  VS Code and Antigravity.
- **Leftovers** from uninstalled programs, empty folders, and large files untouched for a year.
- **Windows recommendations** (Storage Sense, Windows Update cleanup, hibernation file, restore points),
  with manual steps. Drive Cleanup never changes Windows settings.

## How it keeps your data safe

- **Scans only read**: names, sizes and dates. Links and junctions are not followed, and OneDrive files
  that are not downloaded are never opened.
- **Protected, always**: `C:\Windows`, Program Files, ProgramData, other users, boot and recovery files,
  browser profiles, credentials and keys (`.ssh`, `.env`, certificates), databases, and every development
  project (`.git`, `node_modules`, lock files and source). These are shown but can never be selected.
- **You approve each item** (cleanup arrives in a later version; this preview only reads). Claude can run
  the audit and explain it, but cannot delete or move anything. You will tick items on the dashboard,
  review the exact list, and confirm.
- **Your files will be moved, not deleted.** Documents, media, installers, archives and duplicates go to a
  quarantine folder, on another drive when there is one, and can be restored. Only re-creatable data
  (temp files, caches, old logs) is deleted.
- **Every change will be logged** in `deletion_manifest.csv`.
- **Nothing is uploaded.** No telemetry, no network calls.

## Commands

| Command | What it does |
| --- | --- |
| `/drive-cleanup:audit [rescan]` | Deep, read-only audit of C: (a few minutes) and a summary of what could be recovered, by class |
| `/drive-cleanup:report` | Writes `storage_audit.md`, `largest_files.csv`, `installers_and_archives.csv` and `cleanup_recommendations.md` |
| `/drive-cleanup:self-check` | Confirms Drive Cleanup can run on this PC |

You can also just ask ("why is my C: drive full?", "which old installers can I remove?"): Claude answers
with Drive Cleanup's read-only tools. The **Drive Cleanup pane** beside the chat shows scan progress with
Cancel and Retry, free space and recoverable space.

Coming later: `/drive-cleanup:duplicates`, `/drive-cleanup:dev-caches`, and `/drive-cleanup:review`, where
you approve cleanup; and the duplicate, cache-analysis, deletion-manifest and final reports.

## What the audit reads

Three scripts in `ps/scan/`, each checked against its recorded fingerprint before it runs, as your normal
user:

- **Drives and settings** (`volume.ps1`): capacity, free space, file system, disk health; your profile
  folders; whether Storage Sense is on; whether Windows records last-opened dates.
- **Walk of the drive** (`walk.ps1`): one pass over C: reading names, sizes and dates only, up to 4
  minutes. System folders and other users' profiles are only added up. Links, junctions and cloud folders
  are not followed.
- **Windows-managed space** (`windows.ps1`): sizes of Windows Update downloads, Windows.old, Windows Temp,
  memory dumps, the hibernation, page and swap files, your Recycle Bin, and (as administrator only)
  restore points.

Results and reports are kept in `%APPDATA%\techgramam-drive-cleanup`. The reports contain full paths, so
share them with care.

## With PC Guardian

Drive Cleanup works on its own. When PC Guardian is installed, the Temp folder, Recycle Bin and browser
caches are left to PC Guardian's cleanup, and Drive Cleanup links to it.

## Install

Requirements: Windows 10 or 11, Claude Code 2.1.312 or later, no administrator rights.

```
/plugin install drive-cleanup --marketplace CJCreator/pc-guardian-marketplace
```

Then start a new session and run `/drive-cleanup:self-check`. Uninstalling leaves
`%APPDATA%\techgramam-drive-cleanup` (your scans and reports) until you delete it.

## Development

- Core unit tests: `node --experimental-strip-types --test dev/test/*.spec.ts` (Node 22.6 or later).
- Engine tests: `claude plugin test plugins/drive-cleanup`, from the repository root.
- After changing a script in `ps/`: `node dev/update-hashes.mjs` (or `--check`). The mod refuses to run a
  script whose fingerprint does not match.

Copyright (c) 2026 Techgramam. Proprietary; see LICENSE.
