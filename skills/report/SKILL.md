---
description: Save a PC Guardian report of the latest scan (html, markdown or json) and give its path. Read-only; it writes only to PC Guardian's own reports folder.
argument-hint: '[html|markdown|json|pdf]'
disable-model-invocation: true
allowed-tools: mcp__pc-guardian__generate_report
---

Generate a PC Guardian report.

1. Pick the format from the arguments below: `html`, `markdown` or `json`. If none is given, use `html`. If the user asked for `pdf`, explain that PDF export is not available and generate `html` instead: it is styled for printing, so they can print it to PDF from their browser.
2. Call `mcp__pc-guardian__generate_report` with that `format`. Leave `redactPersonalPaths` at its default (personal paths removed) unless the user explicitly asked to keep them.
3. If it says there is no scan yet, suggest `/pc-guardian:audit` first.
4. Reply with the saved file's full path, the format, and whether personal paths were removed.

Arguments: $ARGUMENTS
