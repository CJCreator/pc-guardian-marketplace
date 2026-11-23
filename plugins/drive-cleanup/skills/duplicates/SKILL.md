---
description: Duplicate files and folders on this PC (identical by SHA-256), with the suggested copy to keep in each group and the space keeping one copy would recover.
allowed-tools: mcp__drive-cleanup__get_duplicate_groups mcp__drive-cleanup__get_settings
user-invocable: false
---

Call `mcp__drive-cleanup__get_duplicate_groups` (limit 10).

- If it says duplicate search is off: explain that it reads file contents (only on this PC) and that only the person can turn it on, in the Drive Cleanup pane > Settings, then run a deep scan. Stop there.
- Otherwise: the total that keeping one copy of each would recover; then the largest groups, each with its size, every copy's path, which copy is suggested to keep and why. Mention protected copies and say they are never offered. If the search stopped at its time limit, say the pane's "Continue duplicate search" picks it up.

Finish with the offer to clean them: `propose_cleanup` with the copies' findingIds (never the copy marked to keep) moves them to a restorable quarantine after the person says yes; at least one copy of every group always stays. Never move or delete files any other way.
