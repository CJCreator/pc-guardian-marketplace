---
description: Put back files Drive Cleanup moved to quarantine - lists recent cleanups and restores the one you choose, after you confirm.
argument-hint: "[which cleanup, e.g. 'the last one']"
allowed-tools: mcp__drive-cleanup__get_quarantine mcp__drive-cleanup__restore_quarantine mcp__drive-cleanup__open_pane
---

The person wants files back from Drive Cleanup's quarantine. Their request: $ARGUMENTS

1. Call `get_quarantine`. If no run is `active`, say there is nothing to restore (deleted caches and temporary files cannot be restored; they were re-creatable).
2. Pick the run the person means. With no hint, and only one active run, use it. With several, list them (date, size, location) and ask which one, unless they said "the last one".
3. Call `restore_quarantine` with its `runId`. Claude Code asks the person to confirm; do not ask in chat as well.
4. Report what came back exactly: how much was restored, and anything left in quarantine because its original place is taken again. For single files, or to choose items, point to the pane's Quarantine view (`open_pane`).

Deleting a quarantine for good is not something you can do; only the person does it in the pane.
