---
description: How to approve a cleanup with Drive Cleanup - opens the pane's Review, and explains what will happen to what you select. Claude cannot approve or clean.
disable-model-invocation: true
allowed-tools: mcp__drive-cleanup__open_pane mcp__drive-cleanup__get_settings mcp__drive-cleanup__get_storage_summary
---

Call `mcp__drive-cleanup__get_settings` and `mcp__drive-cleanup__get_storage_summary`, then `mcp__drive-cleanup__open_pane`.

Then explain in a few lines:

1. If cleanup is off: the person turns it on in the pane > Settings (it asks them to confirm).
2. In **Review**, they open a category, tick items (or Select all), and press **Clean selected…**; Claude Code then asks them to confirm, showing what will happen.
3. **Class A** (re-creatable: old Temp folders, crash dumps, old app logs, developer caches) is **deleted**. **Class B** (installers, archives, old downloads, large old files, duplicates, leftovers, empty folders, build caches) is **moved to quarantine** — on another drive when there is room — and can be restored from the pane's **Quarantine** view. Protected items are never listed.
4. Each item is checked again just before it is touched; anything changed since the scan, in use, or protected is skipped and reported.
5. Afterwards: **Verify** in the pane (or `/drive-cleanup:verify`) checks the result and writes the final report. Quarantine is never deleted by itself; they delete a run for good when sure.

You cannot select, approve, clean, restore or delete anything; do not try another way.
