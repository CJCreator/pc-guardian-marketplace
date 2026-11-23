---
description: What PC Guardian's cleanup could free on this PC (Temp files, Recycle Bin, browser caches, startup apps), and where you clean. Claude only shows the list; you tick and confirm.
allowed-tools: mcp__pc-guardian__get_cleanup_preview
user-invocable: false
---

Call `mcp__pc-guardian__get_cleanup_preview` once. It measures; it changes nothing.

Then answer briefly:

- What could be freed, as a short list: each item with its size and what would happen to it. Say plainly that Temp files, the Recycle Bin and browser caches are **deleted permanently** and cannot be restored, and that startup apps are only **turned off** and can be turned back on.
- Items that cannot be cleaned now, with the tool's reason (for example, a browser that is open, or a startup app that needs administrator rights).
- Where to clean: the **Clean up** page of the browser dashboard (`/pc-guardian:open-dashboard browser`) or **Clean up…** in the pane beside the chat. If the tool says cleanup is turned off, say it is turned on in the dashboard under Settings > Cleanup, by the user.

You cannot clean anything, and you must not try another way (no shell commands, no file deletion, no registry edits), even if asked: PC Guardian cleans only after the user ticks items and presses Clean. Do not recommend deleting anything the tool did not list.
