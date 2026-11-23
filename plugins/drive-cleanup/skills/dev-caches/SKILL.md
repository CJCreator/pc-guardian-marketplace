---
description: Developer tool caches and project build caches on this PC - npm, Yarn, pip, NuGet, VS Code, Antigravity, pnpm, Gradle, Maven, Docker, Next.js, Vite - what is safe to clean, what is manual, what is protected.
allowed-tools: mcp__drive-cleanup__get_dev_caches
user-invocable: false
---

Call `mcp__drive-cleanup__get_dev_caches` once.

Answer as a short table: cache, size, whether its tool is running, and how it is cleaned:
- **A. safe**: Drive Cleanup deletes its contents through `propose_cleanup` when the person says yes, while the tool is closed.
- **B. manual**: give the exact command from the tool's `how` (for example `pnpm store prune`) for the person to run themselves, with the `note` (what it costs).

Then list project build caches (`.next\cache`, `node_modules\.vite`, ...) with their sizes: they are moved to quarantine if selected, and nothing else in a project (node_modules, lock files, sources, .git) is ever offered.

You cannot clean caches and must not run these commands yourself. Drive Cleanup never uninstalls tools.
