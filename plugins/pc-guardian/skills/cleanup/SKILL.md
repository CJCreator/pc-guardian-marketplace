---
description: What PC Guardian's cleanup could free on this PC (Temp files, Recycle Bin, browser caches, startup apps), and cleaning it with one yes from you.
allowed-tools: mcp__pc-guardian__get_cleanup_preview mcp__pc-guardian__propose_cleanup
user-invocable: false
---

Call `mcp__pc-guardian__get_cleanup_preview` once. It measures; it changes nothing.

Then answer briefly:

- What could be freed, as a short list: each item with its size and what would happen to it. Say plainly that Temp files, the Recycle Bin and browser caches are **deleted permanently** and cannot be restored, and that startup apps are only **turned off** and can be turned back on.
- Items that cannot be cleaned now, with the tool's reason (for example, a browser that is open, or a startup app that needs administrator rights).
- Then offer to clean what is worth it, and if the user wants it, call `mcp__pc-guardian__propose_cleanup` with those kinds. It asks the user once, in plain words, and cleans only on their yes (that yes also turns cleanup on). Include `recycle_bin` only if the user did not say to keep it, and `startup` only if they asked about startup or speed. Report what it returns exactly. If they decline, do not ask again unless they bring it up.
- They can also clean by hand: the **Clean up** page of the browser dashboard, or **Clean up…** in the pane beside the chat.

Never clean any other way (no shell commands, no file deletion, no registry edits), even if asked. Do not recommend deleting anything the tool did not list.
