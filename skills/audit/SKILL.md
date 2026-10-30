---
description: Run a full PC Guardian audit of this Windows PC and summarize the results. Read-only; changes nothing.
disable-model-invocation: true
allowed-tools: mcp__pc-guardian__run_full_audit mcp__pc-guardian__open_dashboard mcp__pc-guardian__get_recommendations
---

Run a full PC Guardian audit.

1. Call `mcp__pc-guardian__run_full_audit` with no arguments. It audits this PC, which takes about 40 seconds.
2. Call `mcp__pc-guardian__open_dashboard` so the user can watch the score beside the chat.
3. Summarize, following the pc-audit skill's rules:
   - the Health Score and band in one sentence;
   - critical items first, then up to three recommended items, each with its evidence and the first manual step;
   - the quick wins, briefly;
   - anything marked "Not checked" that matters, with its reason;
   - one line saying PC Guardian only read information and changed nothing.
4. Offer a report (`/pc-guardian:report`) and, if there is an earlier scan, a comparison (`/pc-guardian:compare`).

Arguments: $ARGUMENTS
