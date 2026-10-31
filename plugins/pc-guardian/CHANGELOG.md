# Changelog

All notable changes to PC Guardian AI. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): a fix is a patch release, a new capability a minor one, and anything that removes a capability, breaks stored history, or changes what PC Guardian may do to a machine without the person opting in, a major one. `docs/deployment.md` describes how a release is made.

## [Unreleased]

## [2.0.1] - 2026-10-31

### Changed

- **PC Guardian now lives in `plugins/pc-guardian/`** of the marketplace repository, beside the other plugins. Nothing it does changes, and history and settings carry over. Its installed copy no longer includes other plugins' files.

## [2.0.0] - 2026-10-30

PC Guardian now works only with this PC's own data. A major version because it removes a capability (demo mode) that tools, settings and requests offered.

### Removed

- **Demo mode** and its three sample machines: the Demo scan button, the Settings switch, `run_full_audit`'s `mode` and `demoScenario` inputs, the dashboard's demo banners, and simulated cleanup. A scan always measures this PC.

### Changed

- **Saved data from earlier versions still reads.** Demo scans already in history are left out and their slots reused; a settings file's old demo switch is ignored; a cleanup log's demo runs are dropped.
- **Every test runs on real data**: script output recorded on this PC (two recordings a day apart, personal details removed), through the real collectors. Where a test checks a failure path (a timeout, a file that could not be read), it injects only that fault into the real data, and says so.

### Added

- **Install from GitHub:** the private repository `CJCreator/pc-guardian-marketplace` holds the built plugin and its marketplace: `/plugin install pc-guardian --marketplace CJCreator/pc-guardian-marketplace`. It leaves out the bundled Node.js runtime, so installed from there the browser dashboard needs Node.js 22 or later on PATH. Installing from a folder still works, Node.js included.

### Fixed

- The redaction placeholder for the computer's name in recordings is `REDACTED-PC`.
- The plugin's description no longer says it never changes the machine: scans only read, and cleanup you turn on, tick and confirm does change it.

## [1.1.0] - 2026-10-30

The first version that can change the machine, and only through cleanup you turn on, choose and confirm. Scans, tools and reports still only read.

### Added

- **Cleanup you choose** (decisions #33): a Clean up page in the browser dashboard and Clean up… in the pane. Check what can be cleaned, tick items, review the list, press Clean:
  - **Temp files** not changed for 7 days or more, skipping files in use: deleted permanently.
  - **Recycle Bin**: emptied permanently, and refused if it holds more than the preview counted.
  - **Browser caches** of Edge, Chrome, Brave and Firefox, only while that browser is closed: deleted permanently. Never history, cookies, passwords or sessions.
  - **Startup apps**: turned off the way Task Manager does, and back on with Turn back on. Machine-wide apps need Claude Code running as administrator.
- **Settings > Cleanup**: cleanup is off until turned on here.
- **`get_cleanup_preview`** tool and **`/pc-guardian:cleanup`**: Claude can show what cleanup could free, and where to do it. It cannot clean.
- **A cleanup log** of the last 100 runs in `%APPDATA%\pc-guardian-ai\cleanup`, shown on the Clean up page.
- In demo mode, cleanup lists the demo machine's items and only pretends: nothing on the PC is changed.

### Changed

- The dashboard, pane and docs no longer say PC Guardian only reads; they say scans only read, and what cleanup changes.

### Security

- The four cleanup actions are their own allowlisted scripts (`ps/actions/`), hash-checked like every script, each held by its own guard entry to the one kind of change it exists for. Only the mod's cleanup module can run them, and only for items the person ticked in a list under 10 minutes old and confirmed. A clean never runs from Claude's tool, in a `-p` session, or while a scan runs.

## [1.0.0] - 2026-10-30

The first release. Read-only: PC Guardian changes nothing on the machine.

### Added

- **Audit of six areas** on Windows 10 and 11: Performance (CPU, memory, disk and GPU, sampled per second), Startup apps with estimated impact, Storage (drives and the folders that grow), Browsers (extensions with estimated impact, process totals), Security & Updates (antivirus, firewall, BitLocker, updates, pending restart, driver age) and Stability (crashes, Reliability Monitor). About 40 seconds, as the current user, with no administrator rights; what needs them is shown as "Not checked".
- **Health Score** from 0 to 100, by published rules (`docs/scoring.md`), with every point explained; areas that could not be checked are left out, never scored as zero.
- **Recommendations** with evidence, manual steps, risk and how to undo; estimates always labelled with their confidence and basis.
- **Reports** in HTML (print-styled), Markdown and JSON, with personal paths removed by default.
- **14 tools** Claude uses to answer questions about the PC, **slash commands** (`/pc-guardian:audit`, `:report`, `:open-dashboard`, `:compare` and more), the `pc-audit` skill and a read-only `pc-auditor` agent.
- **Dashboard pane** beside the chat: score, areas, live scan progress, quick wins, Run scan, and Retry on a step that timed out or failed.
- **Browser dashboard** on 127.0.0.1, opened by a one-time link: every area in depth, charts with table alternatives, recommendations, history and comparison of any two scans, settings, three themes, WCAG 2.2 AA. It runs on the Node.js runtime shipped with the plugin (verified by hash before it starts).
- **Scan workflow:** seven steps with live progress and a log, Cancel, Retry that re-checks one area into the same scan, and reduced-motion support.
- **History** of the last 50 scans (configurable) in `%APPDATA%\pc-guardian-ai`, with personal paths removed.
- **Demo mode** with three sample machines, always badged "Demo data".

### Security

- Only allowlisted PowerShell scripts run, each checked against its recorded SHA-256 first; a two-layer guard fails the build on any command that could change the machine.
- The only files written are PC Guardian's own history, reports and settings. No telemetry, no network calls beyond the local dashboard on 127.0.0.1.
