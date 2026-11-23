---
description: Confirms Drive Cleanup can run on this PC - Windows, its data folder, and the fingerprints of its read-only scan scripts.
allowed-tools: mcp__drive-cleanup__self_check
user-invocable: false
---

Call `mcp__drive-cleanup__self_check` once and report its lines as they are. If any script's fingerprint does not match, say Drive Cleanup should be reinstalled (`claude plugin update drive-cleanup@techgramam`, then restart Claude Code), and that it will not run a script that does not match.
