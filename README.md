# Techgramam plugins for Claude Code

The `techgramam` marketplace: Claude Code plugins for Windows PCs.

| Plugin | What it does | Version |
| --- | --- | --- |
| [PC Guardian](plugins/pc-guardian/README.md) | Health audit of a Windows PC (performance, startup, storage, browsers, security, stability) with a Health Score, and cleanup you turn on, tick and confirm. | 2.0.2 |
| [Drive Cleanup](plugins/drive-cleanup/README.md) | Deep audit and cleanup of the system drive: duplicates, installers, archives, developer caches, leftovers. Claude proposes, you answer once; personal files go to a restorable quarantine. **Beta, not yet tested on Windows.** | 1.3.0-beta.1 |

## Install

Your computer needs a git credential for github.com (an SSH key, or `gh auth login` then
`gh auth setup-git`). In a Claude Code session:

```
/plugin install pc-guardian --marketplace CJCreator/pc-guardian-marketplace
/plugin install drive-cleanup --marketplace CJCreator/pc-guardian-marketplace
```

Then: `/drive-cleanup:free-space` to get space back, `/pc-guardian:audit` for a health check, `/drive-cleanup:undo-cleanup` to put files back. Anything else, just ask. Each plugin's README has its requirements and how to uninstall it.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per plugin
plugins/pc-guardian/              PC Guardian
plugins/drive-cleanup/            Drive Cleanup
```

Each plugin keeps its own `LICENSE`, `CHANGELOG.md` and README.

## Checks

[Bun](https://bun.com) 1.4.4 (pinned in `.bun-version`). `bun install`, then:

| Command | What it runs |
| --- | --- |
| `bun run ci` | Every check CI runs, at once, each against a time budget: format, lint, both type checks, unit and mod tests, script hashes, plugin and marketplace validation. `bun run ci lint test` runs only those. |
| `bun fmt` | Formats the code (config in `bunfig.toml`; Markdown and built files are left alone). |
| `bun run lint` | oxlint with `.oxlintrc.json`. |
| `bun check` | Type-checks the mod code; `bun check -p tsconfig.node.json` the dev tooling. |
| `bun test` | Drive Cleanup's unit tests, in random order. |

Git hooks run through [hk](https://hk.jdx.dev) 2.13 (`hk.pkl`): `hk install` once. Pre-commit formats and lints
the staged files; pre-push runs `bun run ci`.

`dev/types/claude-code` holds the plugin API types written by Claude Code 2.1.330, the version in
`package.json`; CI fails if the two differ. To update both, bump `@anthropic-ai/claude-code`, then copy
`types/claude-code.d.ts` from the `plugin-authoring` skill's folder of the new version over
`dev/types/claude-code/index.d.ts`.

PC Guardian is linted, validated and formatted, but not type-checked yet: its hooks import their types from
`hooks/deps.js`, a bundle whose typed source is not in this repository.

Copyright (c) 2026 Techgramam. Proprietary; see [LICENSE](LICENSE).
