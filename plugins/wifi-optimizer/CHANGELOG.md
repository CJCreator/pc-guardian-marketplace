# Changelog

All notable changes to Wi-Fi Optimizer. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-beta.1] - 2026-11-23

First release. Not yet run on a Mac or on Windows: see README, "Tested".

### Added

- **One command**, `/wifi-optimizer:optimize`: `baseline` (default) measures and diagnoses; `compare` repeats the identical benchmark and shows Before vs. After.
- Read-only benchmark scripts, one step per call, run strictly in order: `scripts/bench.sh` (macOS, Linux) and `ps/bench.ps1` (Windows, untested). Every command is logged per run.
- Fix catalogue, thresholds and router-page rules in `skills/optimize/reference.md`.
