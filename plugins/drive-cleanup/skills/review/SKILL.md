---
description: Choose items by hand in Drive Cleanup's pane (Choose items tab) and clean them - for when you want to pick each item yourself instead of /drive-cleanup:free-space.
allowed-tools: mcp__drive-cleanup__open_pane mcp__drive-cleanup__get_settings mcp__drive-cleanup__get_storage_summary
user-invocable: false
---

Call `mcp__drive-cleanup__get_settings` and `mcp__drive-cleanup__get_storage_summary`, then `mcp__drive-cleanup__open_pane`.

Then explain in a few lines:

1. **Fastest:** on **Overview**, **Clean safe items** selects every cache and temporary file and asks once. If cleanup is off, the pane's buttons ask to turn it on first.
2. In **Choose items**, they open a category, tick items (or Select all), and press **Clean selected…**; Claude Code then asks them to confirm, showing what will happen.
3. **Caches and temporary files** (old Temp folders, crash dumps, old app logs, developer caches) are **deleted**; apps rebuild them. **The person's own files** (installers, archives, old downloads, large old files, duplicates, leftovers, empty folders, build caches) are **moved to quarantine**, on another drive when there is room, and can be put back from the pane's **Undo** tab. Protected items are never listed.
4. Each item is checked again just before it is touched; anything changed since the scan, in use, or protected is skipped and reported.
5. Afterwards: **Verify** in the pane (or `/drive-cleanup:verify`) checks the result and writes the final report. Quarantine is never deleted by itself; they delete a run for good when sure.

You cannot press the pane's buttons or answer the dialog. To clean on the person's behalf instead, use `propose_cleanup` (see `/drive-cleanup:free-space`).
