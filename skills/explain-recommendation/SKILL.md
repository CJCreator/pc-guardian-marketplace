---
description: Explain one PC Guardian recommendation in depth (pass its id, or describe it).
argument-hint: '<recommendation id or title>'
disable-model-invocation: true
allowed-tools: mcp__pc-guardian__get_recommendations
---

Explain one PC Guardian recommendation.

1. Call `mcp__pc-guardian__get_recommendations` (page with `offset` as needed) and find the recommendation whose `id` matches the arguments below, or whose title best matches what the user described. If none matches, list the closest few titles and ask which one.
2. Explain, using only what it returns:
   - the problem and why it matters;
   - the evidence, keeping measured and estimated values apart;
   - the estimated benefit, if any, with its confidence and basis;
   - the manual steps, numbered, exactly as given;
   - the risk, and how to undo it.
3. Remind the user that PC Guardian will not do this for them, and that you will not run system-changing commands unless they ask, after explaining the risk.

Arguments: $ARGUMENTS
