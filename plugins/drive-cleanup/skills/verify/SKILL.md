---
description: After a Drive Cleanup cleanup - measures free space again, checks developer tools, projects and quarantined files are intact, and writes final_cleanup_report.md and the deletion manifest.
allowed-tools: mcp__drive-cleanup__verify_cleanup mcp__drive-cleanup__get_quarantine
user-invocable: false
---

Call `mcp__drive-cleanup__verify_cleanup` once (read-only; up to a few minutes), then `mcp__drive-cleanup__get_quarantine`.

Report briefly: free space at the scan and now; what the cleanups reported; developer tools not found (say that a tool absent before is not a problem); projects missing; any quarantine item missing or changed (important: say so first if any); what is still in quarantine and that it frees space only once deleted for good from the pane; and the report folder exactly as the tool gave it. Windows integrity is not checked by Drive Cleanup: give the `sfc /verifyonly` command for the person to run as administrator if they want.
