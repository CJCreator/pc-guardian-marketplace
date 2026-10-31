# Testing Drive Cleanup on Windows

Drive Cleanup was built and unit-tested off Windows: its PowerShell scripts have **not run yet**. This
plan tests it on a real PC, from read-only to destructive, so a problem shows up before anything is
moved. Do it first on a test PC or VM, or at least with a backup of anything you care about.

Report every failure with: the step, what `/drive-cleanup:self-check` says, the pane's text, and
the files under `%APPDATA%\techgramam-drive-cleanup\` that the step names.

## 0. Install

```
/plugin install drive-cleanup --marketplace CJCreator/pc-guardian-marketplace
```

Start a new session.

| # | Do | Expect |
| --- | --- | --- |
| 0.1 | `/drive-cleanup:self-check` | Windows detected; data folder path; "all 11 match their fingerprints". |
| 0.2 | Ask Claude "open the Drive Cleanup pane" | Pane beside the chat with Overview / Review / Quarantine / Settings. |

## 1. Read-only scan (nothing may change)

Optional but recommended: run [Process Monitor](https://learn.microsoft.com/sysinternals/downloads/procmon)
with a filter `Process Name is powershell.exe`, and after the scan filter `Operation is WriteFile`,
`SetDispositionInformationFile`, `SetRenameInformationFile`: the only hits may be under
`%APPDATA%\techgramam-drive-cleanup` (written by Claude Code, not PowerShell) — PowerShell itself
should write nothing.

| # | Do | Expect |
| --- | --- | --- |
| 1.1 | `/drive-cleanup:audit` | Pane shows the steps running; Duplicates says "Off…". Within about 5 minutes: a summary with drive usage, A/B/manual totals. |
| 1.2 | Check timings in the pane | Walk under 4 minutes (it stops at 4 and says "partial" if not). Note the file count and time. |
| 1.3 | Pane > Overview | Free space matches Explorer's "This PC" for C:. |
| 1.4 | `/drive-cleanup:report` | 8 files in `%APPDATA%\techgramam-drive-cleanup\audits\<date>\`; CSVs open in Excel with correct columns and no formula warnings. |
| 1.5 | Open `storage_audit.md` | Top-level folders add up roughly to used space; "What was not read" lists denied and linked folders. |
| 1.6 | Ask "what is protected in the largest files list?" | `pagefile.sys`, `hiberfil.sys`, anything under Windows / Program Files marked protected. |
| 1.7 | `/drive-cleanup:dev-caches` | Your installed tools' caches with sizes; tools you don't have are absent. |
| 1.8 | Look for false positives | Open `cleanup_recommendations.md`. **Nothing** under B may be inside a code project (except `.next\cache`, `node_modules\.vite`, `.turbo`, `.parcel-cache`), in `.ssh`, a `.env`, a database or a browser profile. Report any. |

## 2. Fixture folder (for destructive tests)

Create test files you don't care about, in PowerShell:

```powershell
$t = "$env:USERPROFILE\Downloads\dc-test"
New-Item -ItemType Directory -Force $t, "$t\proj", "$t\proj\.next\cache", "$t\tool", "$t\Trip", "$env:USERPROFILE\Pictures\dc-test-Trip" | Out-Null
fsutil file createnew "$t\old-setup.exe" 5242880
fsutil file createnew "$t\tool.zip" 2097152
'{}' | Set-Content "$t\proj\package.json"
fsutil file createnew "$t\proj\.next\cache\big.bin" 3145728
fsutil file createnew "$t\proj\data.bin" 3145728
'secret=1' | Set-Content "$t\.env"
1..3 | ForEach-Object { [IO.File]::WriteAllBytes("$t\Trip\p$_.jpg", [byte[]](((1..255) * 8000) + $_)) ; Copy-Item "$t\Trip\p$_.jpg" "$env:USERPROFILE\Pictures\dc-test-Trip\" }
Copy-Item "$t\old-setup.exe" "$t\old-setup (1).exe"
# Make them look old (installers and downloads are offered after 90 days):
Get-ChildItem $t -Recurse -File | ForEach-Object { $_.LastWriteTime = (Get-Date).AddDays(-400) }
```

Then Pane > Settings > Duplicate search > Turn on… (confirm), and run a new deep scan.

| # | Expect after the scan |
| --- | --- |
| 2.1 | Review > Installers lists `old-setup.exe` (or it is under Duplicate files, with `old-setup (1).exe`). |
| 2.2 | Archives lists `tool.zip` as "Already-extracted" (a `tool` folder is beside it). |
| 2.3 | Project build caches lists `proj\.next\cache`; `proj\data.bin` and `.env` are **not** offered anywhere. |
| 2.4 | Duplicate folders: `Pictures\dc-test-Trip` kept, `Downloads\dc-test\Trip` offered. |

## 3. Cleanup and quarantine

| # | Do | Expect |
| --- | --- | --- |
| 3.1 | Review > Clean selected… with cleanup off | "Cleanup is off" — nothing happens. |
| 3.2 | Settings > Cleanup > Turn on…, then press Escape on the question | Stays off. |
| 3.3 | Turn on… and confirm | "Cleanup is on". |
| 3.4 | Select only the fixture items (Show items, tick), Clean selected…, then **Cancel** | "Nothing was changed"; files still there. |
| 3.5 | Same, confirm **Clean** | Toast with what moved; files gone from `dc-test`; present under `<drive>:\Drive Cleanup Quarantine\<run id>\C\Users\...` with `restore.json`. Moved across drives? Compare a hash: `Get-FileHash`. |
| 3.6 | Before 3.5, open one selected file in an app that locks it (e.g. a zip in 7-Zip) | That item is "skipped: in use"; the rest proceed. |
| 3.7 | Modify a selected file after the scan, then clean | Skipped: "changed since the scan". |
| 3.8 | Select a developer cache (e.g. npm) with Node running | Skipped: "Close node first". Close Node, retry: cleaned. |
| 3.9 | Quarantine > Restore | Files back at their original paths, same hashes; state "Restored". |
| 3.10 | Clean again, then Quarantine > Delete for good… > confirm | The run folder is gone; space freed. |
| 3.11 | Open `deletion_manifest.csv` | One row per item per run: path, size, SHA-256, category, reason, action, destination, timestamp. |

## 4. Verification

| # | Do | Expect |
| --- | --- | --- |
| 4.1 | `/drive-cleanup:verify` | `final_cleanup_report.md`: free before/after, your tools found, projects intact, quarantine "intact". |
| 4.2 | Edit a quarantined file, verify again | Reported as **changed**. |

## 5. Edge cases

- A profile with a `.vscode` folder or a dotfiles `.git` in `C:\Users\<you>`: findings still appear (the
  profile root is never treated as a project).
- OneDrive with Files On-Demand: online-only files are never offered and never downloaded (watch the
  OneDrive icon during a duplicate scan).
- A path longer than 260 characters in the fixture: listed and handled, or skipped with a reason.
- Non-English Windows: the scan works (no text is parsed from Windows tools).
- Run Claude Code as administrator once: restore point usage is measured; nothing else changes.

## Clean up after testing

Restore or delete for good every quarantine run, then delete `Downloads\dc-test` and
`Pictures\dc-test-Trip`. Turn cleanup and duplicate search off in Settings if you want.
