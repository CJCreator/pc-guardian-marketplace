# Techgramam plugins for Claude Code

The `techgramam` marketplace: Claude Code plugins for Windows PCs.

| Plugin | What it does | Version |
| --- | --- | --- |
| [PC Guardian](plugins/pc-guardian/README.md) | Health audit of a Windows PC (performance, startup, storage, browsers, security, stability) with a Health Score, and cleanup you turn on, tick and confirm. | 2.0.1 |
| [Drive Cleanup](plugins/drive-cleanup/README.md) | Deep audit and cleanup of the system drive: duplicates, installers, archives, developer caches, leftovers. You approve each item; personal files go to a restorable quarantine. **Beta, not yet tested on Windows.** | 1.0.0-beta.1 |

## Install

Your computer needs a git credential for github.com (an SSH key, or `gh auth login` then
`gh auth setup-git`). In a Claude Code session:

```
/plugin install pc-guardian --marketplace CJCreator/pc-guardian-marketplace
/plugin install drive-cleanup --marketplace CJCreator/pc-guardian-marketplace
```

Each plugin's README has its requirements, commands and how to uninstall it.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per plugin
plugins/pc-guardian/              PC Guardian
plugins/drive-cleanup/            Drive Cleanup
```

Each plugin keeps its own `LICENSE`, `CHANGELOG.md` and README.

Copyright (c) 2026 Techgramam. Proprietary; see [LICENSE](LICENSE).
