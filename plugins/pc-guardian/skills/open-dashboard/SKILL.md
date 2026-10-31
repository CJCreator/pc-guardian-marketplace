---
description: Open the PC Guardian dashboards - the pane beside the chat, and the full dashboard in a browser on this PC (one-time link).
argument-hint: '[pane|browser|both]'
disable-model-invocation: true
allowed-tools: mcp__pc-guardian__open_dashboard
---

Call `mcp__pc-guardian__open_dashboard` with `target` set to "$ARGUMENTS" when it is "pane", "browser" or "both"; otherwise leave `target` out (both).

Then answer in at most three short lines:

- Whether the pane is open, or why it could not be shown (for example, the window is too narrow).
- The browser dashboard link exactly as the tool returned it, as a clickable link, with: "works once, within 5 minutes; only on this PC". If the tool said the browser dashboard is unavailable, give its reason in one line (for example, a file that failed its integrity check) and say the pane works without it.
- If there is no scan yet, that they can press "Run scan" in either dashboard or use `/pc-guardian:audit`.

Never shorten, rewrite or guess a link. PC Guardian never opens a browser by itself.
