---
description: Write Drive Cleanup's audit reports for the latest deep scan (storage_audit.md, largest_files.csv, installers_and_archives.csv, cleanup_recommendations.md) and give their folder.
disable-model-invocation: true
allowed-tools: mcp__drive-cleanup__generate_audit_reports mcp__drive-cleanup__get_scan_status
---

Call `mcp__drive-cleanup__generate_audit_reports` once. If it says there is no deep scan yet, say to run `/drive-cleanup:audit` first and stop.

Then answer in a few lines: the folder the reports were written to, exactly as the tool gave it; one line per file saying what it holds; and that the reports contain full paths from this PC, so they should be shared with care. Do not open, rewrite or summarise the files unless asked.
