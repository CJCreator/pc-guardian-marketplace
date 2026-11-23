---
description: Turn the latest PC Guardian recommendations into a short, ordered plan of what to fix first.
allowed-tools: mcp__pc-guardian__get_recommendations
user-invocable: false
---

Call `mcp__pc-guardian__get_recommendations` (page through with `offset` if `nextOffset` is not null). If there is no scan yet, suggest `/pc-guardian:audit`.

Make a plan from what it returns, in this order:

1. **Now:** every critical item.
2. **Quick wins:** low-risk, reversible items (`isQuickWin`), the ones with the highest impact first.
3. **Worth doing:** the remaining recommended items.
4. **Optional:** mention how many there are; list them only if asked.

For each item: the title, the evidence in a few words, the risk, the first manual step and how to undo it. Mark estimated benefits as estimated, with their confidence. Do not add fixes the tool did not return. End with: PC Guardian does not carry these out; these are steps for you to take.
