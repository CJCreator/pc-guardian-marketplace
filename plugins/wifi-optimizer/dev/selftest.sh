#!/usr/bin/env bash
# Offline checks of bench.sh: syntax, the scan parsers on fixtures, and that the macOS/Linux and
# Windows scripts list the same steps in the same order. Runs no network command.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else printf 'FAIL %s\n  want: %s\n  got:  %s\n' "$1" "$3" "$2"; fail=1; fi; }

bash -n "$HERE/scripts/bench.sh" || fail=1
export BENCH_SOURCE_ONLY=1
# shellcheck source=/dev/null
. "$HERE/scripts/bench.sh"

mac=$(cat <<'TXT'
      Current Network Information:
          Home:
            PHY Mode: 802.11ax
            Channel: 149 (5GHz, 80MHz)
            Signal / Noise: -55 dBm / -92 dBm
      Other Local Wi-Fi Networks:
          A:
            Channel: 6 (2GHz, 20MHz)
          B:
            Channel: 6 (2GHz, 20MHz)
          C:
            Channel: 36 (5GHz, 80MHz)
          D:
            Channel: 37 (6GHz, 160MHz)
TXT
)
check 'macOS scan tally' "$(printf '%s\n' "$mac" | mac_scan_lines | tally | tr '\n' ';')" \
  'TALLY band=2.4 channel=6 aps=2;TALLY band=5 channel=36 aps=1;TALLY band=6 channel=37 aps=1;'

check 'frequency to band/channel' "$(printf '2412\n2437\n2484\n5180\n5745\n5955\n6115\n' | freq_to_band_channel | tr '\n' ';')" \
  '2.4 1;2.4 6;2.4 14;5 36;5 149;6 1;6 33;'

nm=$(printf '*:6:2437 MHz:20 MHz:70\n :6:2437 MHz:20 MHz:40\n :44:5220 MHz:80 MHz:30\n')
check 'nmcli scan tally' "$(printf '%s\n' "$nm" | awk -F: 'NF>=4 && $3 ~ /MHz/ {split($3,a," "); print a[1]}' | freq_to_band_channel | tally | tr '\n' ';')" \
  'TALLY band=2.4 channel=6 aps=2;TALLY band=5 channel=44 aps=1;'

# shellcheck disable=SC2016 # literal $Steps
ps_steps=$(sed -nE 's/^\$Steps = @\((.*)\)/\1/p' "$HERE/ps/bench.ps1" | tr -d "' " | tr ',' ' ')
check 'same steps on Windows' "$ps_steps" "$STEPS"

exit $fail
