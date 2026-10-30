# PC Guardian AI - read-only. Measures what cleanup could free, for the person to
# choose from: files in the user's Temp folder not written for 7 days or more, the
# Recycle Bin, and each browser's cache folders, with whether that browser is open.
# Metadata only (sizes and dates). Nothing is removed or changed here.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$maxFiles = 200000
$budgetMs = 20000
$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory
$cutoff = (Get-Date).ToUniversalTime().AddDays(-7)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$sid = $identity.User.Value
$local = $env:LOCALAPPDATA

$processOf = @{ edge = 'msedge'; chrome = 'chrome'; brave = 'brave'; firefox = 'firefox' }
$running = @{}
foreach ($p in @(Get-Process -Name @('msedge', 'chrome', 'brave', 'firefox') -ErrorAction SilentlyContinue)) {
    $running[[string]$p.ProcessName] = $true
}

# Every folder to measure, as one list: each is walked by the same loop below.
$walks = [System.Collections.Generic.List[object]]::new()
$walks.Add(@{ key = 'temp'; roots = @($env:TEMP); onlyOld = $true; skipIndex = $false })
$drives = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType = 3' -Property DeviceID | ForEach-Object { [string]$_.DeviceID })
$walks.Add(@{ key = 'recycle_bin'; roots = @($drives | ForEach-Object { $_ + '\$Recycle.Bin\' + $sid }); onlyOld = $false; skipIndex = $true })

$installed = @{}
$chromium = @(
    @{ browser = 'edge'; dataDir = (Join-Path $local 'Microsoft\Edge\User Data') },
    @{ browser = 'chrome'; dataDir = (Join-Path $local 'Google\Chrome\User Data') },
    @{ browser = 'brave'; dataDir = (Join-Path $local 'BraveSoftware\Brave-Browser\User Data') }
)
foreach ($b in $chromium) {
    $roots = [System.Collections.Generic.List[object]]::new()
    $installed[$b.browser] = Test-Path -LiteralPath $b.dataDir -PathType Container
    if ($installed[$b.browser]) {
        foreach ($profileDir in @(Get-ChildItem -LiteralPath $b.dataDir -Directory | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' })) {
            foreach ($sub in @('Cache\Cache_Data', 'Code Cache', 'GPUCache')) {
                $roots.Add((Join-Path $profileDir.FullName $sub))
            }
        }
    }
    $walks.Add(@{ key = $b.browser; roots = @($roots); onlyOld = $false; skipIndex = $false })
}
$installed['firefox'] = Test-Path -LiteralPath (Join-Path $env:APPDATA 'Mozilla\Firefox\Profiles') -PathType Container
$firefoxLocal = Join-Path $local 'Mozilla\Firefox\Profiles'
$ffRoots = [System.Collections.Generic.List[object]]::new()
if (Test-Path -LiteralPath $firefoxLocal -PathType Container) {
    foreach ($profileDir in @(Get-ChildItem -LiteralPath $firefoxLocal -Directory)) {
        $ffRoots.Add((Join-Path $profileDir.FullName 'cache2'))
    }
}
$walks.Add(@{ key = 'firefox'; roots = @($ffRoots); onlyOld = $false; skipIndex = $false })

$measured = @{}
foreach ($walk in $walks) {
    $bytes = 0.0
    $count = 0
    $denied = 0
    $isTruncated = $false
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    foreach ($root in $walk.roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $pending = [System.Collections.Generic.Stack[string]]::new()
        $pending.Push($root)
        while ($pending.Count -gt 0) {
            if ($count -ge $maxFiles -or $stopwatch.ElapsedMilliseconds -ge $budgetMs) {
                $isTruncated = $true
                break
            }
            $directory = $pending.Pop()
            try {
                foreach ($child in [System.IO.DirectoryInfo]::new($directory).EnumerateFileSystemInfos()) {
                    if (($child.Attributes -band $reparsePoint) -ne 0) { continue }
                    if (($child.Attributes -band $directoryFlag) -ne 0) {
                        $pending.Push($child.FullName)
                        continue
                    }
                    # In the Recycle Bin, $I files are the bin's own index of deleted items.
                    if ($walk.skipIndex -and $child.Name.StartsWith('$I')) { continue }
                    if ($walk.onlyOld -and $child.LastWriteTimeUtc -ge $cutoff) { continue }
                    $bytes += $child.Length
                    $count++
                }
            } catch {
                $denied++
            }
        }
    }
    $measured[$walk.key] = [pscustomobject]@{
        fileCount     = $count
        bytes         = $bytes
        deniedFolders = $denied
        isTruncated   = $isTruncated
    }
}

[pscustomobject]@{
    isElevated   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    tempIsTemp   = [bool]($env:TEMP -match '\\Temp\\?$')
    temp         = $measured['temp']
    recycleBin   = $measured['recycle_bin']
    browsers     = @(foreach ($name in @('edge', 'chrome', 'brave', 'firefox')) {
        [pscustomobject]@{
            browser     = $name
            isInstalled = [bool]$installed[$name]
            isRunning   = [bool]$running[$processOf[$name]]
            cache       = $measured[$name]
        }
    })
} | ConvertTo-Json -Compress -Depth 4
