# Wi-Fi Optimizer benchmark for Windows: the same steps and file names as scripts/bench.sh.
# UNTESTED: written from Microsoft's documentation; no command here has run on Windows yet.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File bench.ps1 init <baseline|compare>
#   powershell -NoProfile -ExecutionPolicy Bypass -File bench.ps1 <step> <run-dir>
#   powershell -NoProfile -ExecutionPolicy Bypass -File bench.ps1 latest <baseline|compare>
#
# Every step only reads. Steps run one at a time. Each command is logged to <run-dir>\commands.txt.
# Windows PowerShell 5.1 or later.

param([string]$Cmd = '', [string]$Arg = '')

$ErrorActionPreference = 'Continue'
$BenchVersion = 1
$Steps = @('env', 'link', 'scan', 'ping-gateway', 'ping-v4', 'ping-v6', 'trace', 'activity', 'dns-servers', 'dns-latency', 'throughput')
$PingCount = 30
$PingV4 = '1.1.1.1'
$PingV6 = '2606:4700:4700::1111'
$TraceTarget = '1.1.1.1'
$TraceHops = 5
$DnsServersFixed = @('1.1.1.1', '8.8.8.8')
$DnsDomains = @('github.com', 'wikipedia.org', 'apple.com', 'microsoft.com', 'amazon.com')
$EventWindowHours = 6

function DataRoot {
  if ($env:WIFI_OPTIMIZER_DIR) { return $env:WIFI_OPTIMIZER_DIR }
  return (Join-Path $env:APPDATA 'techgramam-wifi-optimizer\runs')
}

function Log([string]$Text) { Add-Content -LiteralPath (Join-Path $script:RunDir 'commands.txt') -Value "$($script:Step)`t$Text" }
function NotMeasured([string]$What, [string]$Why) { "NOT_MEASURED ${What}: $Why" }

# Prints "$ cmd", logs it, runs it. Only fixed text from this script, never user input.
function Run([string]$Text) {
  "`$ $Text"
  Log $Text
  try { Invoke-Expression $Text 2>&1 | Out-String -Width 200 } catch { "ERROR $($_.Exception.Message)" }
}

function Detect {
  $r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
  $wifi = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.PhysicalMediaType -match '802\.11' -and $_.Status -eq 'Up' } | Select-Object -First 1
  $v6 = Get-NetRoute -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -ne '::' }
  [ordered]@{
    GATEWAY    = if ($r) { $r.NextHop } else { '' }
    DEFAULT_IF = if ($r) { $r.InterfaceAlias } else { '' }
    WIFI_IF    = if ($wifi) { $wifi.Name } else { '' }
    V6_ACTIVE  = if ($v6) { 'yes' } else { 'no' }
  }
}

function LoadEnv {
  $f = Join-Path $script:RunDir 'env.vars'
  if (Test-Path -LiteralPath $f) {
    $e = [ordered]@{}
    Get-Content -LiteralPath $f | ForEach-Object { $k, $v = $_ -split '=', 2; $e[$k] = $v }
    return $e
  }
  return (Detect)
}

function Step-env {
  $e = Detect
  $lines = $e.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
  Set-Content -LiteralPath (Join-Path $script:RunDir 'env.vars') -Value $lines
  $lines
  "OS=Windows"
  "BENCH_VERSION=$BenchVersion"
  Run '[System.Environment]::OSVersion.VersionString'
  if (-not $e.WIFI_IF) { NotMeasured 'wifi_interface' 'no connected Wi-Fi adapter found' }
  elseif ($e.WIFI_IF -ne $e.DEFAULT_IF) { "NOTE default route uses $($e.DEFAULT_IF), not Wi-Fi $($e.WIFI_IF): tests measure that path (Ethernet or VPN?)" }
  if (-not $e.GATEWAY) { NotMeasured 'gateway' 'no IPv4 default route' }
}

function Step-link {
  $e = LoadEnv
  # Radio type (PHY), band, channel, signal %, receive/transmit rate. Windows reports no noise floor.
  Run 'netsh wlan show interfaces'
  NotMeasured 'noise' 'Windows does not report the noise floor, so SNR cannot be computed'
  if ($e.WIFI_IF) {
    Run "Get-NetAdapterStatistics -Name '$($e.WIFI_IF)' | Format-List ReceivedPacketErrors,OutboundPacketErrors,ReceivedDiscardedPackets,OutboundDiscardedPackets"
  }
}

function Step-scan {
  # SSID lines are dropped before anything is shown or saved. Windows 11 24H2 and later need
  # Location access for this (Settings > Privacy & security > Location > Let desktop apps access your location).
  "`$ netsh wlan show networks mode=bssid"
  Log 'netsh wlan show networks mode=bssid'
  $raw = netsh wlan show networks mode=bssid 2>&1 | Out-String
  if ($raw -match '(?i)location') { NotMeasured 'scan' 'Windows needs Location access for desktop apps to list nearby networks'; return }
  $kept = ($raw -split "`r?`n") | Where-Object { $_ -notmatch '^\s*SSID \d+\s*:' }
  $kept
  $tally = @{}
  $band = ''
  foreach ($line in $kept) {
    if ($line -match '^\s*Band\s*:\s*([\d.]+)\s*GHz') { $band = $Matches[1] }
    if ($line -match '^\s*Channel\s*:\s*(\d+)') {
      $ch = [int]$Matches[1]
      $b = if ($band) { $band } elseif ($ch -le 14) { '2.4' } else { '5' }
      $k = "$b $ch"
      $tally[$k] = 1 + $(if ($tally.ContainsKey($k)) { $tally[$k] } else { 0 })
      $band = ''
    }
  }
  if ($tally.Count -eq 0) { NotMeasured 'scan' 'netsh returned no networks' }
  foreach ($k in ($tally.Keys | Sort-Object)) { $b, $c = $k -split ' '; "TALLY band=$b channel=$c aps=$($tally[$k])" }
}

function Step-ping-gateway {
  $e = LoadEnv
  if (-not $e.GATEWAY) { NotMeasured 'ping_gateway' 'no default gateway'; return }
  Run "ping -n $PingCount $($e.GATEWAY)"
}

function Step-ping-v4 { Run "ping -n $PingCount $PingV4" }

function Step-ping-v6 {
  $e = LoadEnv
  if ($e.V6_ACTIVE -ne 'yes') { NotMeasured 'ping_v6' 'IPv6 has no default route on this network'; return }
  Run "ping -6 -n $PingCount $PingV6"
}

function Step-trace { Run "tracert -d -h $TraceHops -w 2000 $TraceTarget" }

function Step-activity {
  # Windows has no per-process network rate without Resource Monitor; adapter totals over 3 s instead.
  Run "Get-Counter '\Network Interface(*)\Bytes Total/sec' -SampleInterval 3 -MaxSamples 1 | Select-Object -ExpandProperty CounterSamples | Format-Table InstanceName,CookedValue -AutoSize"
  NotMeasured 'per_process_traffic' 'Windows exposes it only in Resource Monitor (Network tab)'
  Run 'Get-VpnConnection | Format-Table Name,ConnectionStatus -AutoSize'
  Run "Get-NetAdapter | Where-Object { `$_.Status -eq 'Up' } | Format-Table Name,InterfaceDescription -AutoSize"
  Run 'netsh winhttp show proxy'
  Run "Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Format-List ProxyEnable,ProxyServer,AutoConfigURL"
  # 8001 connected, 8002 connect failed, 8003 disconnected.
  Run "Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-WLAN-AutoConfig/Operational'; Id=8001,8002,8003; StartTime=(Get-Date).AddHours(-$EventWindowHours)} -MaxEvents 40 -ErrorAction SilentlyContinue | Format-Table TimeCreated,Id -AutoSize"
}

function Step-dns-servers { Run 'Get-DnsClientServerAddress | Where-Object { $_.ServerAddresses } | Format-Table InterfaceAlias,AddressFamily,ServerAddresses -AutoSize' }

function Step-dns-latency {
  $e = LoadEnv
  $servers = @($DnsServersFixed)
  if ($e.GATEWAY) { $servers += $e.GATEWAY }
  # A fresh random label per query forces an uncached lookup; -DnsOnly -NoHostsFile skip local
  # sources. The time includes a few ms of cmdlet overhead, the same in both runs.
  foreach ($s in $servers) {
    foreach ($d in $DnsDomains) {
      $name = "wo$(Get-Random -Minimum 100000000 -Maximum 999999999).$d"
      Log "Resolve-DnsName -Name $name -Server $s -Type A -DnsOnly -NoHostsFile -QuickTimeout"
      $status = 'NOERROR'
      $t = Measure-Command {
        try { Resolve-DnsName -Name $name -Server $s -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop | Out-Null }
        catch { $script:status = if ($_.Exception.Message -match '(?i)does not exist') { 'NXDOMAIN' } else { 'timeout' } }
      }
      if ($script:status) { $status = $script:status; $script:status = $null }
      $ms = if ($status -eq 'timeout') { 'none' } else { [int]$t.TotalMilliseconds }
      "DNS server=$s domain=$d ms=$ms status=$status"
    }
  }
}

function Step-throughput {
  $st = Get-Command speedtest.exe -ErrorAction SilentlyContinue
  if ($st -and ((& $st.Source --version 2>&1 | Out-String) -match 'Ookla')) {
    Run 'speedtest.exe --accept-license --accept-gdpr --format=json-pretty'
  } else {
    NotMeasured 'throughput' 'Ookla speedtest.exe is not installed (winget install Ookla.Speedtest.CLI)'
  }
  NotMeasured 'rpm' 'responsiveness (RPM) is measured only by macOS networkQuality'
  NotMeasured 'ecn_l4s' 'only macOS networkQuality reports ECN/L4S'
}

switch ($Cmd) {
  'steps' { $Steps; break }
  'init' {
    $mode = if ($Arg) { $Arg } else { 'baseline' }
    if ($mode -notin @('baseline', 'compare')) { Write-Error 'mode must be baseline or compare'; exit 2 }
    $script:RunDir = Join-Path (DataRoot) "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$mode"
    New-Item -ItemType Directory -Force -Path $script:RunDir | Out-Null
    @(
      "mode=$mode", "started=$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))", "bench_version=$BenchVersion", 'os=Windows',
      "params=ping_count=$PingCount ping_v4=$PingV4 ping_v6=$PingV6 trace=$TraceTarget/$TraceHops dns_servers=`"$($DnsServersFixed -join ' ')+gateway`" dns_domains=`"$($DnsDomains -join ' ')`""
    ) | Set-Content -LiteralPath (Join-Path $script:RunDir 'meta.txt')
    Set-Content -LiteralPath (Join-Path $script:RunDir 'commands.txt') -Value $null
    "RUN_DIR=$($script:RunDir)"
    break
  }
  'latest' {
    $mode = if ($Arg) { $Arg } else { 'baseline' }
    $d = Get-ChildItem -LiteralPath (DataRoot) -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*-$mode" } | Sort-Object Name | Select-Object -Last 1
    if (-not $d) { exit 1 }
    $d.FullName
    break
  }
  default {
    $i = [array]::IndexOf($Steps, $Cmd)
    if ($i -lt 0) { Write-Error "usage: bench.ps1 init|latest|steps|<step> <run-dir>; steps: $($Steps -join ' ')"; exit 2 }
    if (-not $Arg -or -not (Test-Path -LiteralPath $Arg -PathType Container)) { Write-Error "run folder missing: run 'bench.ps1 init' first"; exit 2 }
    $script:RunDir = $Arg
    $script:Step = $Cmd
    $file = Join-Path $Arg ('{0:D2}-{1}.txt' -f ($i + 1), $Cmd)
    "## $Cmd ($((Get-Date).ToUniversalTime().ToString('HH:mm:ssZ')))" | Tee-Object -FilePath $file | Out-Host
    & "Step-$Cmd" | Out-String -Width 200 | Tee-Object -FilePath $file -Append
  }
}
