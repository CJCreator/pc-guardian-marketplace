# Testing Drive Cleanup on Windows

Drive Cleanup was built and unit-tested off Windows: its PowerShell scripts have **not run yet**. This
plan tests it on a real PC, from read-only to destructive, so a problem shows up before anything is
moved. Do it first on a test PC or VM, or at least with a backup of anything you care about.

Report every failure with: the step, what Claude says when you ask "run Drive Cleanup's self-check", the pane's text, and
the files under `%APPDATA%\techgramam-drive-cleanup\` that the step names.

## 0. Install

```
/plugin install drive-cleanup --marketplace CJCreator/pc-guardian-marketplace
```

Start a new session.

| # | Do | Expect |
| --- | --- | --- |
| 0.1 | Ask "run Drive Cleanup's self-check" | Windows detected; data folder path; "all 12 match their fingerprints". |
| 0.2 | Ask Claude "open the Drive Cleanup pane" | Pane beside the chat with Overview / Review / Quarantine / Settings. |

## 1. Read-only scan (nothing may change)

Optional but recommended: run [Process Monitor](https://learn.microsoft.com/sysinternals/downloads/procmon)
with a filter `Process Name is powershell.exe`, and after the scan filter `Operation is WriteFile`,
`SetDispositionInformationFile`, `SetRenameInformationFile`: the only hits may be under
`%APPDATA%\techgramam-drive-cleanup` (written by Claude Code, not PowerShell) — PowerShell itself
should write nothing.

| # | Do | Expect |
| --- | --- | --- |
| 1.1 | `/drive-cleanup:scan fresh` | Pane shows the steps running; Duplicates says "Off…". Within about 5 minutes: a summary with drive usage, A/B/manual totals. |
| 1.2 | Check timings in the pane | Walk under 4 minutes (it stops at 4 and says "partial" if not). Note the file count and time. |
| 1.3 | Pane > Overview | Free space matches Explorer's "This PC" for C:. |
| 1.4 | `/drive-cleanup:scan reports` | 8 files in `%APPDATA%\techgramam-drive-cleanup\audits\<date>\`; CSVs open in Excel with correct columns and no formula warnings. |
| 1.5 | Open `storage_audit.md` | Top-level folders add up roughly to used space; "What was not read" lists denied and linked folders. |
| 1.6 | Ask "what is protected in the largest files list?" | `pagefile.sys`, `hiberfil.sys`, anything under Windows / Program Files marked protected. |
| 1.7 | `/drive-cleanup:scan caches` | Your installed tools' caches with sizes; tools you don't have are absent. |
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
| 4.1 | `/drive-cleanup:quarantine check` | `final_cleanup_report.md`: free before/after, your tools found, projects intact, quarantine "intact". |
| 4.2 | Edit a quarantined file, verify again | Reported as **changed**. |

## 5. Edge cases

- A profile with a `.vscode` folder or a dotfiles `.git` in `C:\Users\<you>`: findings still appear (the
  profile root is never treated as a project).
- OneDrive with Files On-Demand: online-only files are never offered and never downloaded (watch the
  OneDrive icon during a duplicate scan).
- A path longer than 260 characters in the fixture: listed and handled, or skipped with a reason.
- Non-English Windows: the scan works (no text is parsed from Windows tools).
- Run Claude Code as administrator once: restore point usage is measured; nothing else changes.

## 6. One-confirm cleanup (1.1)

Recreate the fixture folder (§2) and run a new deep scan first.

| # | Do | Expect |
| --- | --- | --- |
| 6.1 | With cleanup **off** in Settings, `/drive-cleanup:free-space` | Claude scans if needed, says what it proposes, then **one** plain dialog: "Free up about … on C:?", what is deleted, what is moved (and that it can be put back), the biggest items, "Cleanup is turned off now; this answer also turns it on", with **Free N GB** / **Let me choose** / **Not now**. No jargon (class A/B, SHA-256, UAC). |
| 6.2 | Answer **Not now** | "Nothing was changed"; cleanup still off; fixture files untouched. Ask Claude to propose again at once: it refuses ("declined … a few minutes ago"). |
| 6.3 | After 5 minutes, `/drive-cleanup:free-space` again, answer **Let me choose** | Pane opens on **Choose items** with the proposed items ticked; nothing moved. |
| 6.4 | `/drive-cleanup:free-space 1 GB` and answer **Free … GB** | Cleanup turns on; only items up to about 1 GB are cleaned; Claude reports deleted and quarantined sizes, skips with reasons, and runs Verify (free space before and after). |
| 6.5 | Ask Claude to clean `C:\Windows\notepad.exe` or a file in `.ssh` | Refused before any dialog: protected / not in the scan. |
| 6.6 | `/drive-cleanup:quarantine restore` and answer **Restore** | Quarantined fixture files back in place; compare with `Get-FileHash`. |
| 6.7 | `claude -p "free up space on my C drive with drive cleanup"` | Claude proposes; no one can answer, so nothing changes, and it says so. |
| 6.8 | Type `/` in a new session | Only `drive-cleanup:scan`, `drive-cleanup:free-space`, `drive-cleanup:quarantine` and `pc-guardian:audit` from these plugins. "Explain my score", "find duplicates", "write the reports" still work by asking. |

## 7. Administrator cleanup (1.2)

Do this on a VM with a snapshot. Run `/drive-cleanup:free-space` first so there is a fresh scan.

| # | Do | Expect |
| --- | --- | --- |
| 7.1 | Ask "clean Windows temp and memory dumps too" | The dialog lists files (if any) and "Clean Windows itself: Windows Temp folder (about …); System memory dumps (…). Windows will then show a \"Windows PowerShell\" permission prompt…". |
| 7.2 | Answer **Free … GB**, then **No** at the Windows PowerShell permission prompt | File part done; Claude reports "Windows did not get permission … Administrator tasks were not done." Nothing in `C:\Windows\Temp` changed. |
| 7.3 | Again (after 5 min), **Free … GB**, then **Yes** at the permission prompt | Old files in `C:\Windows\Temp` gone, newer and in-use ones kept; dumps gone; sizes reported; both tasks in `deletion_manifest.csv` with action `elevated`. |
| 7.4 | Propose `windows_update_cache` while Windows Update is installing (TiWorker running) | Task skipped with "Windows is installing updates now"; `wuauserv` still running afterwards (`Get-Service wuauserv`). |
| 7.5 | Propose `windows_update_cache` when idle | `SoftwareDistribution\Download` emptied; `wuauserv` running again if it was before. |
| 7.6 | Propose `component_store` | Takes minutes; reports freed space; `Dism /Online /Cleanup-Image /AnalyzeComponentStore` afterwards shows no cleanup recommended. Installed updates can still be uninstalled. |
| 7.7 | Propose `hibernation_reduce` | `powercfg /a` shows hibernation type reduced; Fast Startup still available; undo with `powercfg /hibernate /type full`. |
| 7.8 | Tamper test: after the dialog's Clean and **before** answering UAC, edit one character of `ps\actions\elevated.ps1` in the plugin cache, then answer Yes | The elevated run refuses: "elevated.ps1 does not match its recorded fingerprint"; nothing deleted. Reinstall the plugin afterwards. |
| 7.9 | As a standard user, answer UAC with an administrator's credentials | Works; the result is written to the standard user's `%APPDATA%\techgramam-drive-cleanup\elevated\`. |
| 7.10 | `claude -p "clean memory dumps with drive cleanup"` | No dialog can be answered: nothing runs, no UAC prompt appears. |

## 8. Plain language and one-press cleaning (1.3)

| # | Do | Expect |
| --- | --- | --- |
| 8.1 | Open the pane after a scan | Overview says "Safe to clean: … (caches and temporary files; apps rebuild them)" and "Worth a look: … (your old files; moved to quarantine, so you can undo)". Tabs: Overview, Choose items, Undo, Settings. |
| 8.2 | With cleanup off, press **Clean safe items (…)** | First "Turn on cleanup?", then one plain confirmation; only caches and temporary files are cleaned. |
| 8.3 | After a cleanup that quarantined files | The message ends "Changed your mind? /drive-cleanup:quarantine, or the Undo tab in the pane, puts files back." |
| 8.4 | `/drive-cleanup:free-space` end to end | Claude's plan and result follow the skill's templates: sizes in GB, no class A/B, no paths except the three biggest, free space before and after. |

## 9. Temp, browser caches and the Recycle Bin (1.4)

Put a few files in the Recycle Bin, then wait a minute. Leave Edge open, close Chrome.

| # | Do | Expect |
| --- | --- | --- |
| 9.1 | Run a deep scan, then open Choose items | Categories **Temp files**, **Browser caches** (one row per browser), **Recycle Bin**. |
| 9.2 | Overview > **Clean safe items** | The question lists caches and temporary files, **not** the Recycle Bin. After yes: Chrome's cache folders emptied; Edge skipped ("Close msedge first"); Temp files older than 7 days gone, newer ones kept (compare a fresh file's presence). |
| 9.3 | Check Chrome afterwards | History, bookmarks, saved passwords and signed-in sites are all still there. |
| 9.4 | `/drive-cleanup:free-space` with a Recycle Bin over 500 MB | **One** question, with its own line: "Empty the Recycle Bin (…). Those files are gone for good." No second question from PC Guardian. |
| 9.5 | Before answering 9.4, delete one more file to the Recycle Bin, then answer yes | That newest file is still in the Recycle Bin afterwards; the older ones are gone. Explorer shows no broken entries. |
| 9.6 | Ask "clean my caches" with "keep my Recycle Bin" | The Recycle Bin is not in the question. |
| 9.7 | `claude -p "free up space with drive cleanup"` | Nothing changes. |

## 10. Three commands and using the space (1.5)

Best on a PC with a second fixed drive (D:) and, if you have it, WSL or Docker Desktop.

| # | Do | Expect |
| --- | --- | --- |
| 10.1 | `/drive-cleanup:scan` | Changes nothing. Free of total, the biggest folders, then three buckets: clean, Windows itself, and **move, don't delete** (only if something applies). |
| 10.2 | With a Videos or Pictures folder over 5 GB and room on D: | "Move Videos … to D:" with Properties > Location > Move… steps and `D:\Users\<you>\Videos`. Without a second drive: no move advice at all. |
| 10.3 | With npm/Gradle/NuGet caches over 5 GB | "Keep developer caches on D:" with one command per tool you have, and sizes. |
| 10.4 | With a WSL distribution or Docker Desktop over 5 GB | "Shrink or move virtual disks": `--set-sparse`, `--move`, and "Never delete a .vhdx file yourself". |
| 10.5 | After a cleanup that quarantined on **C:** (Settings > quarantine drive C:) | `/drive-cleanup:scan` and `/drive-cleanup:free-space` say that quarantine frees nothing on C: until deleted for good. |
| 10.6 | `/drive-cleanup:quarantine` with no words | Lists the runs and offers Restore or Delete for good; asks nothing in a dialog and changes nothing. |
| 10.7 | `/drive-cleanup:quarantine empty the last one`, answer **Not now** | "Nothing was deleted"; the run is still active. |
| 10.8 | Same, answer **Delete for good** | The run folder is gone; freed space reported; the pane's Undo tab shows it deleted. |
| 10.9 | `claude -p "empty my drive cleanup quarantine"` | Nothing is deleted. |

## Clean up after testing

Restore or delete for good every quarantine run, then delete `Downloads\dc-test` and
`Pictures\dc-test-Trip`. Turn cleanup and duplicate search off in Settings if you want.
