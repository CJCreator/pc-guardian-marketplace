# Drive Cleanup - CLEANUP ACTION. Deletes the contents of one cache.
#
# Runs only after the person approved a cleanup that named this cache (the
# pane's Clean selected, or Claude's proposal, answered yes in Claude Code's
# own dialog), with cleanup turned on. The cache is named by its id; its
# folders are fixed here (the same as ps/scan/dev-caches.ps1, or the user Temp
# folder and this user's Recycle Bin on the system drive), never taken from
# input. Refused while the program that owns it is running. Deletes files last
# written before the approval (Temp: also not changed for 7 days), never
# follows links, keeps the cache folder itself, and removes the emptied
# subfolders. Files in use are skipped. Deleted, not quarantined.
#
# The Recycle Bin is emptied item by item: only items deleted before the
# approval (their $I record is older), each with its $R content.
#
# Inputs: DC_CACHE_ID, DC_APPROVED_AT (ISO 8601, UTC).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$local = [string]$env:LOCALAPPDATA
$roaming = [string]$env:APPDATA
$editorParts = @('Cache', 'CachedData', 'CachedExtensionVSIXs', 'Code Cache', 'GPUCache', 'logs')
# Browser cache folders: in each profile (Default, Profile N) only Cache\Cache_Data,
# Code Cache and GPUCache; for Firefox, only each local profile's cache2. History,
# cookies, passwords, sessions and settings live elsewhere and are never listed.
function Get-ChromiumCacheRoots([string]$dataDir) {
    $roots = @()
    if (-not [System.IO.Directory]::Exists($dataDir)) { return $roots }
    foreach ($profileDir in @(Get-ChildItem -LiteralPath $dataDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' })) {
        foreach ($sub in @('Cache\Cache_Data', 'Code Cache', 'GPUCache')) { $roots += (Join-Path $profileDir.FullName $sub) }
    }
    return $roots
}
function Get-FirefoxCacheRoots([string]$local) {
    $roots = @()
    $profiles = Join-Path $local 'Mozilla\Firefox\Profiles'
    if (-not [System.IO.Directory]::Exists($profiles)) { return $roots }
    foreach ($profileDir in @(Get-ChildItem -LiteralPath $profiles -Directory -ErrorAction SilentlyContinue)) { $roots += (Join-Path $profileDir.FullName 'cache2') }
    return $roots
}
$caches = @{
    npm_cache         = @{ roots = @(Join-Path $local 'npm-cache\_cacache'); owners = @('node') }
    npm_npx           = @{ roots = @(Join-Path $local 'npm-cache\_npx'); owners = @('node') }
    npm_logs          = @{ roots = @(Join-Path $local 'npm-cache\_logs'); owners = @('node') }
    yarn_cache        = @{ roots = @(Join-Path $local 'Yarn\Cache'); owners = @('node', 'yarn') }
    yarn_berry        = @{ roots = @(Join-Path $local 'Yarn\Berry\cache'); owners = @('node', 'yarn') }
    pip_cache         = @{ roots = @(Join-Path $local 'pip\cache'); owners = @('python', 'pythonw', 'pip', 'py') }
    nuget_http        = @{ roots = @(Join-Path $local 'NuGet\v3-cache'); owners = @('dotnet', 'devenv', 'MSBuild') }
    nuget_plugins     = @{ roots = @(Join-Path $local 'NuGet\plugins-cache'); owners = @('dotnet', 'devenv', 'MSBuild') }
    vscode_cache      = @{ roots = @($editorParts | ForEach-Object { Join-Path (Join-Path $roaming 'Code') $_ }); owners = @('Code') }
    antigravity_cache = @{ roots = @($editorParts | ForEach-Object { Join-Path (Join-Path $roaming 'Antigravity') $_ }); owners = @('Antigravity') }
    edge_cache        = @{ roots = @(Get-ChromiumCacheRoots (Join-Path $local 'Microsoft\Edge\User Data')); owners = @('msedge') }
    chrome_cache      = @{ roots = @(Get-ChromiumCacheRoots (Join-Path $local 'Google\Chrome\User Data')); owners = @('chrome') }
    brave_cache       = @{ roots = @(Get-ChromiumCacheRoots (Join-Path $local 'BraveSoftware\Brave-Browser\User Data')); owners = @('brave') }
    firefox_cache     = @{ roots = @(Get-FirefoxCacheRoots $local); owners = @('firefox') }
    user_temp         = @{ roots = @([System.IO.Path]::GetTempPath().TrimEnd('\')); owners = @(); olderThanDays = 7 }
    recycle_bin       = @{ roots = @(); owners = @(); isRecycleBin = $true }
}

function Write-Refusal([string]$reason, [string]$detail) {
    [pscustomobject]@{ status = 'refused'; reason = $reason; detail = $detail } | ConvertTo-Json -Compress
}

$id = [string]$env:DC_CACHE_ID
if (-not $caches.ContainsKey($id)) {
    Write-Refusal 'unknown_cache' 'That is not a cache Drive Cleanup cleans, so nothing was deleted.'
    exit 0
}
$approvedAt = [DateTime]::Parse([string]$env:DC_APPROVED_AT, $invariant, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
if (([DateTime]::UtcNow - $approvedAt).TotalMinutes -gt 15) {
    Write-Refusal 'stale' 'The approval is more than 15 minutes old, so nothing was deleted.'
    exit 0
}
$cache = $caches[$id]
foreach ($owner in $cache.owners) {
    if (@(Get-Process -Name $owner -ErrorAction SilentlyContinue).Count -gt 0) {
        Write-Refusal 'running' ("Close " + $owner + ' first: the cache is in use, so nothing was deleted.')
        exit 0
    }
}

$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory

# Files must be older than the approval, and for Temp also unchanged for 7 days.
$cutoff = $approvedAt
if ($cache.ContainsKey('olderThanDays')) {
    $byAge = [DateTime]::UtcNow.AddDays(-[double]$cache.olderThanDays)
    if ($byAge -lt $cutoff) { $cutoff = $byAge }
}

if ($cache.ContainsKey('isRecycleBin')) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $bin = Join-Path ([System.IO.Path]::GetPathRoot([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows))) ('$Recycle.Bin\' + $sid)
    $removed = 0
    $removedBytes = 0.0
    $skipped = 0
    if ([System.IO.Directory]::Exists($bin) -and ([System.IO.DirectoryInfo]::new($bin).Attributes -band $reparsePoint) -eq 0) {
        foreach ($record in @([System.IO.DirectoryInfo]::new($bin).GetFiles('$I*'))) {
            if (($record.Attributes -band $reparsePoint) -ne 0) { $skipped++; continue }
            if ($record.LastWriteTimeUtc -gt $approvedAt) { $skipped++; continue }
            $content = Join-Path $bin ('$R' + $record.Name.Substring(2))
            try {
                $bytes = 0.0
                if ([System.IO.File]::Exists($content)) {
                    $info = [System.IO.FileInfo]::new($content)
                    if (($info.Attributes -band $reparsePoint) -ne 0) { $skipped++; continue }
                    $bytes = [double]$info.Length
                    $info.Delete()
                } elseif ([System.IO.Directory]::Exists($content)) {
                    $dir = [System.IO.DirectoryInfo]::new($content)
                    if (($dir.Attributes -band $reparsePoint) -ne 0) { $skipped++; continue }
                    foreach ($f in $dir.EnumerateFiles('*', [System.IO.SearchOption]::AllDirectories)) { $bytes += $f.Length }
                    $dir.Delete($true)
                }
                $record.Delete()
                $removed++
                $removedBytes += $bytes
            } catch {
                $skipped++
            }
        }
    }
    [pscustomobject]@{ status = 'ok'; removedCount = $removed; removedBytes = $removedBytes; skippedCount = $skipped } | ConvertTo-Json -Compress
    exit 0
}

$removed = 0
$removedBytes = 0.0
$skipped = 0
foreach ($root in $cache.roots) {
    if (-not [System.IO.Directory]::Exists($root)) { continue }
    if (([System.IO.DirectoryInfo]::new($root).Attributes -band $reparsePoint) -ne 0) { $skipped++; continue }
    $dirs = [System.Collections.Generic.List[string]]::new()
    $dirTimes = @{}
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        $dir = $pending.Pop()
        if ($dir -ne $root) {
            $dirs.Add($dir)
            # Read before anything inside is deleted, which would update it.
            try { $dirTimes[$dir] = [System.IO.Directory]::GetLastWriteTimeUtc($dir) } catch { $dirTimes[$dir] = [DateTime]::MaxValue }
        }
        try {
            foreach ($child in [System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos()) {
                if (($child.Attributes -band $reparsePoint) -ne 0) { $skipped++; continue }
                if (($child.Attributes -band $directoryFlag) -ne 0) { $pending.Push($child.FullName); continue }
                if ($child.LastWriteTimeUtc -gt $cutoff) { $skipped++; continue }
                try {
                    $len = [double]$child.Length
                    $child.Delete()
                    $removed++
                    $removedBytes += $len
                } catch {
                    $skipped++
                }
            }
        } catch {
            $skipped++
        }
    }
    for ($i = $dirs.Count - 1; $i -ge 0; $i--) {
        # Only folders already older than the cutoff, so a folder an app just made stays.
        try { if ($dirTimes[$dirs[$i]] -le $cutoff) { [System.IO.Directory]::Delete($dirs[$i], $false) } } catch { }
    }
}

[pscustomobject]@{
    status       = 'ok'
    removedCount = $removed
    removedBytes = $removedBytes
    skippedCount = $skipped
} | ConvertTo-Json -Compress
