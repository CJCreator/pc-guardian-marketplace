#!/usr/bin/env bash
# Wi-Fi Optimizer benchmark: one read-only measurement step per call, macOS and Linux.
# Windows: ps/bench.ps1 (same steps, same file names).
#
#   bench.sh init <baseline|compare>   make a timestamped run folder, print RUN_DIR=<path>
#   bench.sh <step> <run-dir>          run one step, print its raw output, save it in the run folder
#   bench.sh latest <baseline|compare> print the newest run folder of that kind
#   bench.sh steps                     list the steps, in the order they must run
#
# Every step only reads. Steps run one at a time, never in parallel, so idle latency is never measured
# under load. Each command is logged verbatim to <run-dir>/commands.txt, and every parameter is fixed
# here, so a compare run repeats the baseline exactly. Written for bash 3.2 (macOS's /bin/bash).
# macOS verified only by documentation, Linux flags checked with --help on Ubuntu 24.04: see README.

set -u
export LC_ALL=C

BENCH_VERSION=1
STEPS="env link scan ping-gateway ping-v4 ping-v6 trace activity dns-servers dns-latency throughput"
PING_COUNT=30
PING_V4=1.1.1.1
PING_V6=2606:4700:4700::1111
TRACE_TARGET=1.1.1.1
TRACE_HOPS=5
DNS_SERVERS_FIXED="1.1.1.1 8.8.8.8"
DNS_DOMAINS="github.com wikipedia.org apple.com microsoft.com amazon.com"
EVENT_WINDOW_HOURS=6

OS=$(uname -s)

data_root() {
  if [ -n "${WIFI_OPTIMIZER_DIR:-}" ]; then
    printf '%s\n' "$WIFI_OPTIMIZER_DIR"
  elif [ "$OS" = Darwin ]; then
    printf '%s\n' "$HOME/Library/Application Support/techgramam-wifi-optimizer/runs"
  else
    printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}/techgramam-wifi-optimizer/runs"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# Prints "$ cmd", logs it, runs it, keeps its output. stderr is kept: errors are evidence.
run() {
  printf '$ %s\n' "$*"
  printf '%s\t%s\n' "$STEP" "$*" >>"$RUN_DIR/commands.txt"
  "$@" 2>&1
  printf '[exit %s]\n' "$?"
}

# Same, for a pipeline given as one string (only fixed text from this script, never user input).
run_sh() {
  printf '$ %s\n' "$1"
  printf '%s\t%s\n' "$STEP" "$1" >>"$RUN_DIR/commands.txt"
  bash -c "$1" 2>&1
  printf '[exit %s]\n' "$?"
}

not_measured() { printf 'NOT_MEASURED %s: %s\n' "$1" "$2"; }

# ---- interface and gateway ------------------------------------------------------------------------

detect() {
  GATEWAY='' DEFAULT_IF='' WIFI_IF='' V6_ACTIVE=no
  if [ "$OS" = Darwin ]; then
    GATEWAY=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2; exit}')
    DEFAULT_IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
    WIFI_IF=$(networksetup -listallhardwareports 2>/dev/null |
      awk '/Hardware Port: (Wi-Fi|AirPort)/{f=1; next} f && /Device:/{print $2; exit}')
    route -n get -inet6 default 2>/dev/null | grep -q 'gateway:' && V6_ACTIVE=yes
  else
    GATEWAY=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="via"){print $(i+1); exit}}')
    DEFAULT_IF=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
    if have iw; then WIFI_IF=$(iw dev 2>/dev/null | awk '/Interface/{print $2; exit}'); fi
    if [ -z "$WIFI_IF" ] && have nmcli; then
      WIFI_IF=$(nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}')
    fi
    [ -n "$(ip -6 route show default 2>/dev/null)" ] && V6_ACTIVE=yes
  fi
}

load_env() {
  if [ -f "$RUN_DIR/env.vars" ]; then
    # shellcheck disable=SC1091
    . "$RUN_DIR/env.vars"
  else
    detect
  fi
}

# ---- steps ----------------------------------------------------------------------------------------

step_env() {
  detect
  {
    printf 'GATEWAY=%s\nDEFAULT_IF=%s\nWIFI_IF=%s\nV6_ACTIVE=%s\n' "$GATEWAY" "$DEFAULT_IF" "$WIFI_IF" "$V6_ACTIVE"
  } >"$RUN_DIR/env.vars"
  cat "$RUN_DIR/env.vars"
  printf 'OS=%s\nBENCH_VERSION=%s\n' "$OS" "$BENCH_VERSION"
  if [ "$OS" = Darwin ]; then run sw_vers; else run_sh 'cat /etc/os-release | head -n 4'; fi
  [ -z "$WIFI_IF" ] && not_measured wifi_interface 'no Wi-Fi interface found'
  [ -n "$WIFI_IF" ] && [ "$WIFI_IF" != "$DEFAULT_IF" ] &&
    printf 'NOTE default route uses %s, not Wi-Fi %s: tests measure that path (Ethernet or VPN?)\n' "$DEFAULT_IF" "$WIFI_IF"
  [ -z "$GATEWAY" ] && not_measured gateway 'no IPv4 default route'
}

step_link() {
  load_env
  if [ "$OS" = Darwin ]; then
    # PHY mode, channel (band, width), signal / noise, transmit rate, MCS; no administrator rights needed.
    run system_profiler SPAirPortDataType
    [ -n "$WIFI_IF" ] && run netstat -I "$WIFI_IF"
  else
    [ -z "$WIFI_IF" ] && { not_measured link 'no Wi-Fi interface'; return; }
    if have iw; then
      run iw dev "$WIFI_IF" link
      run iw dev "$WIFI_IF" info
    else
      not_measured link 'iw is not installed'
    fi
    run cat /proc/net/wireless
    run ip -s link show dev "$WIFI_IF"
  fi
}

# Tally of nearby access points per band and channel: "TALLY band=<GHz> channel=<n> aps=<count>".
tally() { sort | uniq -c | awk '{printf "TALLY band=%s channel=%s aps=%s\n", $2, $3, $1}'; }

freq_to_band_channel() {
  awk '{f=$1+0; if (f>=2412 && f<=2484) {c=(f==2484)?14:(f-2407)/5; b="2.4"}
       else if (f>=5955 && f<=7115) {c=(f-5950)/5; b="6"} else if (f>=5160 && f<=5885) {c=(f-5000)/5; b="5"}
       else next; printf "%s %d\n", b, c}'
}

# system_profiler's "Other Local Wi-Fi Networks" -> "<band> <channel>" per network.
mac_scan_lines() {
  awk '/Other Local Wi-Fi Networks:/{f=1} f && /Channel:/' |
    sed -E 's/.*Channel: ([0-9]+) \(([0-9.]+)GHz.*/\2 \1/' | sed -E 's/^2 /2.4 /'
}

step_scan() {
  load_env
  if [ "$OS" = Darwin ]; then
    # The same system_profiler call as "link": its "Other Local Wi-Fi Networks" section is the scan.
    # macOS hides nearby networks from apps without Location Services permission (macOS 14+).
    out=$(run system_profiler SPAirPortDataType)
    printf '%s\n' "$out" | awk '/Other Local Wi-Fi Networks:/{f=1} f' | sed -n '1,400p'
    lines=$(printf '%s\n' "$out" | mac_scan_lines)
    if [ -n "$lines" ]; then
      printf '%s\n' "$lines" | tally
    else
      AIRPORT=/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport
      if [ -x "$AIRPORT" ] && "$AIRPORT" -s >/dev/null 2>&1; then
        run "$AIRPORT" -s
      else
        not_measured scan 'macOS returned no nearby networks: give Location Services permission to the terminal app (System Settings > Privacy & Security > Location Services), then run again; airport -s was removed in macOS 14.4'
      fi
    fi
  else
    if have nmcli; then
      # Cached scan results; no SSIDs are requested.
      out=$(run nmcli -t -f IN-USE,CHAN,FREQ,BANDWIDTH,SIGNAL dev wifi list --rescan auto)
      printf '%s\n' "$out"
      lines=$(printf '%s\n' "$out" | awk -F: 'NF>=4 && $3 ~ /MHz/ {split($3,a," "); print a[1]}' | freq_to_band_channel)
      if [ -n "$lines" ]; then printf '%s\n' "$lines" | tally; else not_measured scan 'nmcli returned no networks'; fi
    elif have iw && [ -n "$WIFI_IF" ]; then
      # "scan dump" reads the kernel's cached results; a fresh scan ("iw scan") needs root, so it is not used.
      out=$(run iw dev "$WIFI_IF" scan dump)
      lines=$(printf '%s\n' "$out" | awk '/^[[:space:]]*freq:/{print int($2)}' | freq_to_band_channel)
      printf '%s\n' "$out" | grep -E '^BSS|freq:|signal:' | sed -n '1,300p'
      if [ -n "$lines" ]; then printf '%s\n' "$lines" | tally; else not_measured scan 'no cached scan results (a fresh scan needs root)'; fi
    else
      not_measured scan 'neither nmcli nor iw is installed'
    fi
  fi
}

step_ping_gateway() {
  load_env
  [ -z "$GATEWAY" ] && { not_measured ping_gateway 'no default gateway'; return; }
  run ping -n -c "$PING_COUNT" "$GATEWAY"
}

step_ping_v4() { run ping -n -c "$PING_COUNT" "$PING_V4"; }

step_ping_v6() {
  load_env
  [ "$V6_ACTIVE" = yes ] || { not_measured ping_v6 'IPv6 has no default route on this network'; return; }
  if [ "$OS" = Darwin ]; then run ping6 -n -c "$PING_COUNT" "$PING_V6"; else run ping -6 -n -c "$PING_COUNT" "$PING_V6"; fi
}

step_trace() {
  if have traceroute; then
    run traceroute -n -m "$TRACE_HOPS" -q 3 -w 2 "$TRACE_TARGET"
  elif have tracepath; then
    run tracepath -n -m "$TRACE_HOPS" "$TRACE_TARGET"
  else
    not_measured trace 'neither traceroute nor tracepath is installed'
  fi
}

step_activity() {
  load_env
  if [ "$OS" = Darwin ]; then
    # Per-process traffic over 3 s (2 samples, delta mode): bandwidth hogs.
    run nettop -P -x -d -L 2 -s 3 -J bytes_in,bytes_out
    run scutil --nc list
    run ifconfig -l
    run scutil --proxy
    run_sh "log show --last ${EVENT_WINDOW_HOURS}h --style compact --predicate 'process == \"airportd\" AND (eventMessage CONTAINS[c] \"disassoc\" OR eventMessage CONTAINS[c] \"deauth\" OR eventMessage CONTAINS[c] \"roam\" OR eventMessage CONTAINS[c] \"link down\")' | tail -n 40"
  else
    # Interface byte counters 3 s apart (Linux has no per-process view without root tools).
    run_sh 'cat /proc/net/dev; sleep 3; cat /proc/net/dev'
    run ip -br link
    have nmcli && run nmcli -t -f NAME,TYPE,DEVICE connection show --active
    # Proxy variable names and hosts only: any user:password@ is removed.
    run_sh "env | grep -i '_proxy=' | sed -E 's#://[^/@]*@#://<redacted>@#'"
    have gsettings && run gsettings get org.gnome.system.proxy mode
    if have journalctl; then
      run_sh "journalctl --no-pager -q --since '-${EVENT_WINDOW_HOURS}h' -u NetworkManager -u wpa_supplicant | grep -Ei 'disconnect|deauth|roam|CTRL-EVENT-(DIS)?CONNECTED' | tail -n 40"
    else
      not_measured events 'journalctl is not available'
    fi
  fi
}

step_dns_servers() {
  if [ "$OS" = Darwin ]; then
    run_sh "scutil --dns | grep 'nameserver\\[' | sort -u"
  elif have resolvectl; then
    run resolvectl dns
  else
    run_sh "grep '^nameserver' /etc/resolv.conf"
  fi
}

step_dns_latency() {
  load_env
  have dig || { not_measured dns_latency 'dig is not installed (Linux: package dnsutils or bind-utils)'; return; }
  servers="$DNS_SERVERS_FIXED"
  [ -n "$GATEWAY" ] && servers="$servers $GATEWAY"
  # A fresh random label per query forces each resolver to look the name up (uncached); dig itself
  # bypasses the OS cache. NXDOMAIN answers are expected and are timed like any other.
  for s in $servers; do
    for d in $DNS_DOMAINS; do
      name="wo$(od -An -N4 -tu4 /dev/urandom | tr -d ' ').$d"
      printf '%s\tdig @%s +tries=1 +time=3 +noall +comments +stats %s A\n' "$STEP" "$s" "$name" >>"$RUN_DIR/commands.txt"
      res=$(dig @"$s" +tries=1 +time=3 +noall +comments +stats "$name" A 2>&1)
      ms=$(printf '%s\n' "$res" | awk '/Query time:/{print $4; exit}')
      st=$(printf '%s\n' "$res" | sed -nE 's/.*status: ([A-Z]+).*/\1/p' | head -n 1)
      printf 'DNS server=%s domain=%s ms=%s status=%s\n' "$s" "$d" "${ms:-none}" "${st:-timeout}"
    done
  done
}

step_throughput() {
  if [ "$OS" = Darwin ]; then
    if have networkQuality; then
      run networkQuality -v
    else
      not_measured throughput 'networkQuality needs macOS 12 or later'
    fi
  elif have speedtest && speedtest --version 2>/dev/null | grep -q 'Ookla'; then
    # Ookla's CLI: download/upload, idle latency and loaded latency (download.latency, upload.latency).
    run speedtest --accept-license --accept-gdpr --format=json-pretty
  elif have speedtest-cli; then
    run speedtest-cli --secure --json
    not_measured loaded_latency 'speedtest-cli does not measure latency under load'
  else
    not_measured throughput 'no throughput tool: install Ookla speedtest (recommended) or speedtest-cli'
  fi
  if [ "$OS" != Darwin ]; then
    not_measured rpm 'responsiveness (RPM) is measured only by macOS networkQuality'
    not_measured ecn_l4s 'only macOS networkQuality reports ECN/L4S'
  fi
}

# Tests source this file for its functions only.
# shellcheck disable=SC2317 # reached only when executed, not sourced
if [ "${BENCH_SOURCE_ONLY:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

# ---- entry ----------------------------------------------------------------------------------------

cmd=${1:-}
case "$cmd" in
  steps)
    for s in $STEPS; do printf '%s\n' "$s"; done
    ;;
  init)
    mode=${2:-baseline}
    case "$mode" in baseline | compare) ;; *) echo "mode must be baseline or compare" >&2; exit 2 ;; esac
    root=$(data_root)
    RUN_DIR="$root/$(date +%Y%m%d-%H%M%S)-$mode"
    mkdir -p "$RUN_DIR" || exit 1
    chmod 700 "$root" "$RUN_DIR" 2>/dev/null
    {
      printf 'mode=%s\nstarted=%s\nbench_version=%s\nos=%s\n' "$mode" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BENCH_VERSION" "$OS"
      printf 'params=ping_count=%s ping_v4=%s ping_v6=%s trace=%s/%s dns_servers="%s+gateway" dns_domains="%s"\n' \
        "$PING_COUNT" "$PING_V4" "$PING_V6" "$TRACE_TARGET" "$TRACE_HOPS" "$DNS_SERVERS_FIXED" "$DNS_DOMAINS"
    } >"$RUN_DIR/meta.txt"
    : >"$RUN_DIR/commands.txt"
    printf 'RUN_DIR=%s\n' "$RUN_DIR"
    ;;
  latest)
    mode=${2:-baseline}
    root=$(data_root)
    [ -d "$root" ] || exit 1
    latest=''
    for d in "$root"/*-"$mode"; do [ -d "$d" ] && latest=$d; done # glob order is sorted: newest last
    [ -n "$latest" ] || exit 1
    printf '%s\n' "$latest"
    ;;
  *)
    case " $STEPS " in *" $cmd "*) ;; *) echo "usage: bench.sh init|latest|steps|<step> <run-dir>; steps: $STEPS" >&2; exit 2 ;; esac
    RUN_DIR=${2:-}
    if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then echo "run folder missing: run 'bench.sh init' first" >&2; exit 2; fi
    STEP=$cmd
    n=0
    for s in $STEPS; do n=$((n + 1)); [ "$s" = "$cmd" ] && break; done
    file=$(printf '%s/%02d-%s.txt' "$RUN_DIR" "$n" "$cmd")
    fn="step_$(printf '%s' "$cmd" | tr '-' '_')"
    printf '## %s (%s)\n' "$cmd" "$(date -u +%H:%M:%SZ)" | tee "$file"
    "$fn" 2>&1 | tee -a "$file"
    ;;
esac
