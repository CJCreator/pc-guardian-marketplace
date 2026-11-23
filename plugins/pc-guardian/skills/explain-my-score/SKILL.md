---
description: Explain exactly why this PC got its PC Guardian Health Score, rule by rule.
allowed-tools: mcp__pc-guardian__get_health_score
user-invocable: false
---

Call `mcp__pc-guardian__get_health_score`. If there is no scan yet, suggest `/pc-guardian:audit`.

Explain the score from what it returns, and nothing else:

1. The overall score and band; whether it is partial (and which categories were skipped and why), and whether a critical security finding capped it.
2. For each category: its score and how much it counts (its effective weight), then each point lost: the rule, the reading, and the threshold it crossed. Mark estimated readings as estimated.
3. Rules that were not scored because a check did not run, with the reason.
4. One line on the formula: each category is 100 minus the points its rules take; the overall score is the weighted average of the categories that were checked (rules in docs/scoring.md).

Keep it plain and short; offer `/pc-guardian:prioritize-fixes` next.
