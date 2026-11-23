---
description: Compare the latest PC Guardian scan with the previous one (or two chosen scans) and explain what changed.
argument-hint: '[fromScanId] [toScanId]'
allowed-tools: mcp__pc-guardian__compare_scans mcp__pc-guardian__get_scan_history
user-invocable: false
---

Compare two PC Guardian scans.

1. If the arguments below contain two scan ids, pass them as `fromScanId` and `toScanId`; otherwise call `mcp__pc-guardian__compare_scans` with no arguments (previous scan versus the latest).
2. If it says two scans are needed, say so and suggest running `/pc-guardian:audit` again later.
3. Explain the change: the overall score difference first, then the categories that moved, then what was resolved and what is new. Use only what the tool returned.

Arguments: $ARGUMENTS
