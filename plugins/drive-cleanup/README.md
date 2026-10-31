# Drive Cleanup

> **Preview: in development.** Version 0.1.0 is the plugin's scaffold and its implementation plan. It does
> nothing yet. The first usable release, 0.2.0, will be a read-only deep audit. See [PLAN.md](PLAN.md).

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
- **You approve each item.** Claude can run the audit and explain it, but cannot delete or move anything.
  You tick items on the dashboard, review the exact list, and confirm.
- **Your files are moved, not deleted.** Documents, media, installers, archives and duplicates go to a
  quarantine folder, on another drive when there is one, and can be restored. Only re-creatable data
  (temp files, caches, old logs) is deleted.
- **Every change is logged** in `deletion_manifest.csv`.
- **Nothing is uploaded.** No telemetry, no network calls.

## Planned commands (from 0.2.0)

| Command | What it does |
| --- | --- |
| `/drive-cleanup:audit` | Deep audit of C: and a summary of what can be recovered |
| `/drive-cleanup:duplicates` | Duplicate groups and which copy to keep |
| `/drive-cleanup:dev-caches` | Developer caches: what is safe, what is manual, what is protected |
| `/drive-cleanup:report` | Writes the audit reports (storage audit, largest files, duplicates, installers and archives, cache analysis, recommendations, deletion manifest, final report) |
| `/drive-cleanup:review` | Opens the dashboard's review page, where you approve cleanup |
| `/drive-cleanup:self-check` | Confirms Drive Cleanup can read this machine |

## With PC Guardian

Drive Cleanup works on its own. When PC Guardian is installed, the Temp folder, Recycle Bin and browser
caches are left to PC Guardian's cleanup, and Drive Cleanup links to it.

## Install

Not yet useful to install. From 0.2.0: `/plugin install drive-cleanup@techgramam` (marketplace
`CJCreator/pc-guardian-marketplace`).

Copyright (c) 2026 Techgramam. Proprietary; see LICENSE.
