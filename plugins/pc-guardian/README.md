# PC Guardian

A health audit for Windows 10 and 11, inside Claude Code. PC Guardian looks at performance, startup apps, storage, browsers, security and updates, and stability; gives the PC a Health Score from 0 to 100; and explains what it found with evidence and manual steps you can take yourself.

**Scans only read.** They run only a fixed list of read-only PowerShell scripts that ship with the plugin (each checked against its recorded fingerprint before it runs), as your normal user. **It changes your machine only when you clean up**: with cleanup turned on in Settings, you tick old Temp files, the Recycle Bin, browser caches or startup apps and confirm, and only those are deleted or turned off. Nothing is uploaded: no telemetry, no network calls; the browser dashboard is served from your own PC on 127.0.0.1. Checks that need administrator rights are reported as "Not checked", never guessed. The only files it writes are its own scan history, settings, cleanup log and the reports you ask for, in `%APPDATA%\pc-guardian-ai`.

## Install

Requirements: Windows 10 or 11 (64-bit), Claude Code 2.1.312 or later, no administrator rights. The browser dashboard runs on Node.js: a copy of the PC Guardian folder ships its own (about 95 MB in all), but the GitHub repository leaves it out, so an install from GitHub needs Node.js 22 or later installed for the browser dashboard (`node --version` shows it). Everything else, the pane beside the chat included, works without Node.js.

**From GitHub** (for people invited to the private repository `CJCreator/pc-guardian-marketplace`). Your computer needs a git credential for github.com first, because the install never asks for one: an SSH key, or `gh auth login` then `gh auth setup-git`. In a Claude Code terminal session:

```
/plugin install pc-guardian --marketplace CJCreator/pc-guardian-marketplace
```

From a shell: `claude plugin install pc-guardian --marketplace CJCreator/pc-guardian-marketplace`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `CJCreator/pc-guardian-marketplace`, then Add plugin.

**From a folder** (no GitHub): keep the whole marketplace folder (the one holding `.claude-plugin\marketplace.json` and `plugins\`) where everyone can read it (for example `C:\Tools\techgramam` or a network share) and install with `--marketplace C:\Tools\techgramam` in place of the repository.

Answer `y` to add the marketplace and choose the user scope. Then start a new session and ask Claude to run PC Guardian's self-check.

**Update:** run `claude plugin marketplace update techgramam` and `claude plugin update pc-guardian@techgramam`, and restart Claude Code (from a folder, replace its contents with the new version first). `CHANGELOG.md` says what changed. History and settings carry over.

**Uninstall:** `claude plugin uninstall pc-guardian@techgramam`, then `claude plugin marketplace remove techgramam`. PC Guardian creates no registry keys, services, scheduled tasks or startup entries, so nothing of that kind is left. Two folders remain until you delete them:

- `%APPDATA%\pc-guardian-ai`: your scan history, reports, settings and cleanup log, kept so a reinstall keeps your history;
- `%USERPROFILE%\.claude\plugins\cache\techgramam\pc-guardian`: Claude Code's cached copy of the plugin, which Claude Code marks as uninstalled and removes in its own cleanup later.

## Commands

| Command              | What it does                                                   |
| -------------------- | -------------------------------------------------------------- |
| `/pc-guardian:audit` | Audits this PC (about 40 seconds) and summarizes the results.  |

Everything else, just ask: "why is my PC slow?", "what starts with Windows?", "explain my score", "what changed since last time?", "what should I fix first?", "save a report", "open the dashboard", "what could cleanup free?". Claude uses PC Guardian's skills and tools to answer from real measurements, without a command for each. To free disk space, Drive Cleanup's `/drive-cleanup:free-space` also lists what PC Guardian's cleanup can free. The `pc-guardian:pc-auditor` agent can run an audit on its own with only those read-only tools.

## Cleanup (off until you turn it on)

Turn it on in the browser dashboard under Settings > Cleanup. Then open **Clean up** (or press **Clean up…** in the pane), check what can be cleaned, tick what you want and press Clean after reviewing the list:

- **Temp files** not changed for 7 days or more, the **Recycle Bin**, and a closed browser's **cache** are **deleted permanently**; they cannot be restored.
- **Startup apps** are turned off the way Task Manager does; **Turn back on** undoes it. Apps installed for all users need Claude Code running as administrator.

Claude can tell you what could be freed, but never cleans. Every cleanup is logged and shown on the Clean up page. If you uninstall PC Guardian, turn startup apps back on first if you want them to start again.

## The dashboards

- **Beside the chat:** the Health Score, each area, live scan progress with Cancel, a Retry on any step that timed out or failed, and quick wins.
- **In your browser:** every area in depth with charts (each with its numbers as a table), recommendations with steps and how to undo them, scan history and a comparison of any two scans, and Settings: what to scan, how many scans to keep, removing personal paths, card colors, and cleanup. Light, dark and high-contrast themes; keyboard and screen-reader friendly; reduced motion honored. It works only while your Claude Code session runs, through a link that works once within 5 minutes.

## What it reads

Performance counters, startup entries (registry Run keys, Startup folders, logon tasks), drive space and folder sizes (names, sizes and dates only, never contents), browser extension manifests and browser process totals (never history, cookies, passwords or sessions), Windows Security and Windows Update status, driver dates, and Reliability Monitor and event-log counts (never message text). The scripts are in this folder's `ps\` folder, so you can read exactly what runs. The browser dashboard's Settings > What PC Guardian reads lists it area by area.

## Scores and estimates

Each area starts at 100 and loses points by published rules. Values marked **Estimated** (startup impact, extension impact, time or space you could gain) are not measured; each carries its confidence and how it was derived. Areas that could not be checked are left out of the score, never counted as zero.

## Help

Ask Claude to run PC Guardian's self-check and send its output, the versions (`claude plugin list`, `claude --version`) and what happened to the Techgramam team that gave you PC Guardian. Report security problems to them privately.

Copyright (c) 2026 Techgramam. Proprietary; see LICENSE. Third-party notices: THIRD_PARTY_NOTICES.md (Node.js's own license: runtime\LICENSE).
