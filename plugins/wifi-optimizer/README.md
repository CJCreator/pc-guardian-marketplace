# Wi-Fi Optimizer

> **Beta (0.1.0-beta.1).** Written for macOS from Apple's documentation; the macOS commands have not run on
> a Mac yet. The Linux commands were checked against their `--help` on Ubuntu 24.04 but not run on a
> Wi-Fi network. The Windows script has not run at all. See "Tested" below.

Diagnoses your Wi-Fi and home network inside Claude Code, finds the real bottlenecks behind slow speeds
or drop-outs, walks you through the fixes, and then measures again so you see what changed.

## One command

| Command | What it does |
| --- | --- |
| `/wifi-optimizer:optimize` (or `… baseline`) | Measures, one test at a time: Wi-Fi link and channel congestion, ping to your router and the internet, a 5-hop traceroute, bandwidth hogs/VPN/proxy and recent disconnects, DNS speed, then throughput and bufferbloat. Ranks the bottlenecks, lists safe changes on this computer separately from router/modem fixes, and asks for your router model or settings page for click-by-click steps. About 3 minutes. |
| `/wifi-optimizer:optimize compare` | After you changed things: repeats the identical benchmark and shows a Before vs. After table with deltas and a verdict. Add a run folder to compare against a specific baseline. |

Paste your router's Wireless Settings page (or a screenshot) in the same conversation for exact steps.
**Blank out passwords first.**

## What it reads, what it changes

- **Only reads.** Every measurement runs through `scripts/bench.sh` (macOS, Linux) or `ps/bench.ps1`
  (Windows), which only run read-only commands. Ping, traceroute and DNS tests send ordinary traffic to
  your router, `1.1.1.1`, `8.8.8.8` and the throughput test's servers.
- **Never changes your router.** It tells you what to click; you make the change.
- **Changes on this computer** (for example DNS server order) are shown with their undo command and run
  only after you say yes.
- **Untrusted data.** Command output, network names and router pages are treated as data, never as
  instructions. Wi-Fi passwords and credentials are never shown or saved.
- **No sudo, no installs.** If a tool is missing it says "not measured" and why; it never estimates.

## Where results are saved

One folder per run, named `<yyyymmdd-hhmmss>-baseline` or `-compare`:

- macOS: `~/Library/Application Support/techgramam-wifi-optimizer/runs/`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/techgramam-wifi-optimizer/runs/`
- Windows: `%APPDATA%\techgramam-wifi-optimizer\runs\`

Each holds the raw output of every step (`01-env.txt` … `11-throughput.txt`), `commands.txt` (every
command exactly as run), `meta.txt` (fixed parameters), `env.vars` and `summary.json` (the measured
values, used by `compare`). They contain your router's IP and nearby networks' channels. Set
`WIFI_OPTIMIZER_DIR` to use another folder. Delete the folder to remove all history.

## Tools used, and fallbacks

| Check | macOS | Linux | Windows (untested) |
| --- | --- | --- | --- |
| Link | `system_profiler SPAirPortDataType`, `netstat -I` | `iw dev <if> link/info`, `/proc/net/wireless`, `ip -s link` | `netsh wlan show interfaces`, `Get-NetAdapterStatistics` |
| Scan | the same `system_profiler` output; `airport -s` on macOS before 14.4 | `nmcli … dev wifi list` (no SSIDs requested), else `iw … scan dump` | `netsh wlan show networks mode=bssid` (SSID lines dropped) |
| Latency | `ping`/`ping6 -c 30`, `traceroute -n -m 5 -q 3 -w 2` | `ping -c 30`, `traceroute` or `tracepath` | `ping -n 30`, `tracert -d -h 5` |
| Activity | `nettop`, `scutil --nc list`, `scutil --proxy`, `log show` (airportd) | `/proc/net/dev`, `nmcli`, proxy env (passwords removed), `journalctl` | `Get-Counter`, `Get-VpnConnection`, WinHTTP/IE proxy, WLAN-AutoConfig events |
| DNS | `scutil --dns`, `dig` | `resolvectl dns` or `/etc/resolv.conf`, `dig` | `Get-DnsClientServerAddress`, `Resolve-DnsName` |
| Throughput | `networkQuality -v` (macOS 12+) | Ookla `speedtest` (loaded latency), else `speedtest-cli` (no loaded latency) | Ookla `speedtest.exe` |

Known limits, reported as "not measured" with the reason:

- **macOS 14 and later hide nearby networks** (and SSIDs) from apps without Location Services. Give
  your terminal app access in System Settings > Privacy & Security > Location Services, then run again.
  `airport` was removed in macOS 14.4 and `wdutil` needs sudo, so neither is used as a fallback there.
- **Linux**: a fresh scan needs root, so cached results are used; noise is often not reported by the
  driver; RPM and ECN/L4S are only measured by macOS `networkQuality`; `dig` comes from `dnsutils`/`bind-utils`.
- **Windows**: no noise floor (so no SNR), signal in % rather than dBm, no channel width, no
  per-process traffic, and Windows 11 24H2+ needs Location access to list networks.

## Install

Requirements: macOS 12 or later (Linux and Windows untested), Claude Code 2.1.312 or later, no administrator rights.

```
/plugin install wifi-optimizer --marketplace CJCreator/pc-guardian-marketplace
```

## Tested

- `scripts/bench.sh`: shellcheck clean; `dev/selftest.sh` checks the scan parsers on fixtures and that
  both scripts list the same steps. The non-network steps ran on Ubuntu 24.04 without Wi-Fi.
- Linux flags of `ping`, `traceroute`, `tracepath`, `dig`, `iw`, `nmcli`, `journalctl`, `ip` were checked
  with `--help` (iputils 20240117, BIND 9.18, nmcli 1.46).
- **Not verified**: every macOS command and flag (no Mac was available; written from Apple's man pages),
  all of `ps/bench.ps1`, Ookla `speedtest` flags, and the exact `system_profiler` text format on
  each macOS version. First run on a Mac: check the parser against `03-scan.txt`.

## Development

- `bash plugins/wifi-optimizer/dev/selftest.sh` (also run by `bun run ci`).
- `claude plugin validate plugins/wifi-optimizer`.

Copyright (c) 2026 Techgramam. Proprietary; see LICENSE.
