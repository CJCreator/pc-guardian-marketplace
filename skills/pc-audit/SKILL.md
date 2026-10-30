---
description: How to answer questions about this Windows PC's health, speed, startup, storage, browsers, security or stability with PC Guardian. Use when the user asks why their PC is slow, what to clean up, whether it is secure, or about a PC Guardian score, scan or recommendation.
allowed-tools: mcp__pc-guardian__self_check mcp__pc-guardian__run_full_audit mcp__pc-guardian__get_system_performance mcp__pc-guardian__get_startup_apps mcp__pc-guardian__get_storage_analysis mcp__pc-guardian__get_browser_diagnostics mcp__pc-guardian__get_security_status mcp__pc-guardian__get_stability_status mcp__pc-guardian__get_health_score mcp__pc-guardian__get_recommendations mcp__pc-guardian__generate_report mcp__pc-guardian__get_scan_history mcp__pc-guardian__compare_scans mcp__pc-guardian__open_dashboard
---

# Explaining a PC with PC Guardian

PC Guardian is a Windows audit whose tools only read: they measure the machine and score it; your job is to explain and prioritize what they return, never to invent what they did not. Its one exception is cleanup (Temp files, Recycle Bin, browser caches, startup apps), which only the user can run, by ticking items and pressing Clean in the dashboard or the pane; you can show what it could free with `get_cleanup_preview` (`/pc-guardian:cleanup`), never clean.

## Rules

1. **Call the tools; do not guess.** Every number, finding and recommendation you mention must come from a tool result in this conversation. If there is no scan yet, run `run_full_audit` (about 40 seconds) before answering. For one area, the area tools (`get_startup_apps`, `get_storage_analysis`, ...) return it from the latest scan, or measure it again with `refresh: true`.
2. **Cite the evidence.** When you name a problem, give the reading behind it ("RAM averaged 87 % during the sample", "8 enabled startup items, 2 rated high impact").
3. **Keep measured and estimated apart.** Values marked `estimated` (startup impact, extension impact, time and space you could gain) are estimates: say "estimated", give the confidence, and give the basis when it matters. Never present an estimate as a measurement.
4. **"Not checked" is not a pass.** Report checks marked `not_checked` with their reason (for example, BitLocker needs administrator rights). Never fill them in.
5. **PC Guardian's tools change nothing; neither should you, unasked.** Recommendations are manual steps for the user. Do not run commands that change the system (registry edits, deleting files, stopping services, uninstalling) on the strength of a recommendation. If the user asks you to, explain the risk and how to undo it first, and remind them that PC Guardian's tools only read. For space or startup apps, point them to PC Guardian's own cleanup, where they choose and confirm each item.

## How to present results

- Lead with the Health Score and band in one sentence, then the few things that matter most, in the order the tool returns them (priority, then impact).
- Critical items first and explicitly. Quick wins are low-risk, reversible and fast: point them out.
- For each recommendation you discuss: what it is, the evidence, the manual steps, the risk, and how to undo it.
- Offer the dashboard (`open_dashboard`) and a report (`generate_report`, html by default) when the user wants to keep or share the results.
- Keep it short. The user can ask for more; the full details stay available through the tools.
