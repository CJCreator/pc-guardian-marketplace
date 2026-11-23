# Drive Cleanup - read-only. Measures known developer tool and browser caches at
# their fixed locations (never found by guessing folder names), and whether the tool that
# owns each is running. Sizes, counts and dates only; links are not followed;
# nothing is opened, created or changed. The ids and roots here match
# hooks/core/devcaches.ts and ps/actions/clean-cache.ps1.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$budgetMs = 20000
$maxFiles = 400000
$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory
$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$local = [string]$env:LOCALAPPDATA
$roaming = [string]$env:APPDATA
$home_ = [string]$env:USERPROFILE

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
$caches = @(
    @{ id = 'npm_cache'; roots = @(Join-Path $local 'npm-cache\_cacache'); owners = @('node') },
    @{ id = 'npm_npx'; roots = @(Join-Path $local 'npm-cache\_npx'); owners = @('node') },
    @{ id = 'npm_logs'; roots = @(Join-Path $local 'npm-cache\_logs'); owners = @('node') },
    @{ id = 'yarn_cache'; roots = @(Join-Path $local 'Yarn\Cache'); owners = @('node', 'yarn') },
    @{ id = 'yarn_berry'; roots = @(Join-Path $local 'Yarn\Berry\cache'); owners = @('node', 'yarn') },
    @{ id = 'pip_cache'; roots = @(Join-Path $local 'pip\cache'); owners = @('python', 'pythonw', 'pip', 'py') },
    @{ id = 'nuget_http'; roots = @(Join-Path $local 'NuGet\v3-cache'); owners = @('dotnet', 'devenv', 'MSBuild') },
    @{ id = 'nuget_plugins'; roots = @(Join-Path $local 'NuGet\plugins-cache'); owners = @('dotnet', 'devenv', 'MSBuild') },
    @{ id = 'vscode_cache'; roots = @($editorParts | ForEach-Object { Join-Path (Join-Path $roaming 'Code') $_ }); owners = @('Code') },
    @{ id = 'antigravity_cache'; roots = @($editorParts | ForEach-Object { Join-Path (Join-Path $roaming 'Antigravity') $_ }); owners = @('Antigravity') },
    @{ id = 'pnpm_store'; roots = @(Join-Path $local 'pnpm\store'); owners = @('node', 'pnpm') },
    @{ id = 'pnpm_cache'; roots = @(Join-Path $local 'pnpm-cache'); owners = @('node', 'pnpm') },
    @{ id = 'gradle_caches'; roots = @(Join-Path $home_ '.gradle\caches'); owners = @('java', 'javaw') },
    @{ id = 'gradle_wrapper'; roots = @(Join-Path $home_ '.gradle\wrapper\dists'); owners = @('java', 'javaw') },
    @{ id = 'maven_repo'; roots = @(Join-Path $home_ '.m2\repository'); owners = @('java', 'javaw') },
    @{ id = 'nuget_packages'; roots = @(Join-Path $home_ '.nuget\packages'); owners = @('dotnet', 'devenv', 'MSBuild') },
    @{ id = 'docker_data'; roots = @(Join-Path $local 'Docker\wsl'); owners = @('Docker Desktop', 'com.docker.backend') },
    @{ id = 'edge_cache'; roots = @(Get-ChromiumCacheRoots (Join-Path $local 'Microsoft\Edge\User Data')); owners = @('msedge') },
    @{ id = 'chrome_cache'; roots = @(Get-ChromiumCacheRoots (Join-Path $local 'Google\Chrome\User Data')); owners = @('chrome') },
    @{ id = 'brave_cache'; roots = @(Get-ChromiumCacheRoots (Join-Path $local 'BraveSoftware\Brave-Browser\User Data')); owners = @('brave') },
    @{ id = 'firefox_cache'; roots = @(Get-FirefoxCacheRoots $local); owners = @('firefox') }
)

$running = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) { [void]$running.Add([string]$p.ProcessName) }

function Measure-Root([string]$root) {
    $bytes = 0.0
    $count = 0
    $latest = 0L
    $isTruncated = $false
    if (-not [System.IO.Directory]::Exists($root)) {
        return @{ path = $root; status = 'missing'; bytes = 0.0; fileCount = 0; latest = 0L; isTruncated = $false }
    }
    $rootInfo = [System.IO.DirectoryInfo]::new($root)
    if (($rootInfo.Attributes -band $script:reparsePoint) -ne 0) {
        return @{ path = $root; status = 'denied'; bytes = 0.0; fileCount = 0; latest = 0L; isTruncated = $false }
    }
    $status = 'ok'
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        if ($count -ge $script:maxFiles -or $stopwatch.ElapsedMilliseconds -ge $script:budgetMs) {
            $isTruncated = $true
            break
        }
        $directory = $pending.Pop()
        try {
            foreach ($child in [System.IO.DirectoryInfo]::new($directory).EnumerateFileSystemInfos()) {
                if (($child.Attributes -band $script:reparsePoint) -ne 0) { continue }
                if (($child.Attributes -band $script:directoryFlag) -ne 0) {
                    $pending.Push($child.FullName)
                    continue
                }
                $bytes += $child.Length
                $count++
                $t = $child.LastWriteTimeUtc.Ticks
                if ($t -gt $latest) { $latest = $t }
            }
        } catch {
            if ($directory -eq $root) { $status = 'denied' }
        }
    }
    return @{ path = $root; status = $status; bytes = $bytes; fileCount = $count; latest = $latest; isTruncated = $isTruncated }
}

$out = foreach ($cache in $caches) {
    $measured = @($cache.roots | ForEach-Object { Measure-Root $_ })
    $bytes = 0.0
    $count = 0
    $latest = 0L
    $isTruncated = $false
    $isPresent = $false
    foreach ($m in $measured) {
        if ($m.status -ne 'missing') { $isPresent = $true }
        $bytes += $m.bytes
        $count += $m.fileCount
        if ($m.latest -gt $latest) { $latest = $m.latest }
        if ($m.isTruncated) { $isTruncated = $true }
    }
    $isRunning = $false
    foreach ($owner in $cache.owners) { if ($running.Contains($owner)) { $isRunning = $true } }
    $lastWrite = $null
    if ($latest -gt 0) { $lastWrite = [DateTime]::new($latest, [DateTimeKind]::Utc).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $invariant) }
    [pscustomobject]@{
        id           = $cache.id
        isPresent    = $isPresent
        bytes        = $bytes
        fileCount    = $count
        lastWriteUtc = $lastWrite
        isRunning    = $isRunning
        isTruncated  = $isTruncated
        roots        = @($measured | ForEach-Object {
            [pscustomobject]@{ path = $_.path; status = $_.status; bytes = $_.bytes; fileCount = $_.fileCount }
        })
    }
}

[pscustomobject]@{ caches = @($out) } | ConvertTo-Json -Compress -Depth 5
