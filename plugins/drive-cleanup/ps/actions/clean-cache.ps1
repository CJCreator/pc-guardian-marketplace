# Drive Cleanup - CLEANUP ACTION. Deletes the contents of one developer cache.
#
# Runs only after the person ticked that cache in Drive Cleanup's Review and
# confirmed, with cleanup turned on. The cache is named by its id; its folders
# are fixed here (the same as ps/scan/dev-caches.ps1), never taken from input.
# Only class A caches, which their tools re-create, are listed. Refused while
# the tool that owns it is running. Deletes files last written before the
# approval, never follows links, keeps the cache folder itself, and removes
# the emptied subfolders. Files in use are skipped. Deleted, not quarantined.
#
# Inputs: DC_CACHE_ID, DC_APPROVED_AT (ISO 8601, UTC).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$local = [string]$env:LOCALAPPDATA
$roaming = [string]$env:APPDATA
$editorParts = @('Cache', 'CachedData', 'CachedExtensionVSIXs', 'Code Cache', 'GPUCache', 'logs')
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
$removed = 0
$removedBytes = 0.0
$skipped = 0
foreach ($root in $cache.roots) {
    if (-not [System.IO.Directory]::Exists($root)) { continue }
    if (([System.IO.DirectoryInfo]::new($root).Attributes -band $reparsePoint) -ne 0) { $skipped++; continue }
    $dirs = [System.Collections.Generic.List[string]]::new()
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        $dir = $pending.Pop()
        if ($dir -ne $root) { $dirs.Add($dir) }
        try {
            foreach ($child in [System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos()) {
                if (($child.Attributes -band $reparsePoint) -ne 0) { $skipped++; continue }
                if (($child.Attributes -band $directoryFlag) -ne 0) { $pending.Push($child.FullName); continue }
                if ($child.LastWriteTimeUtc -gt $approvedAt) { $skipped++; continue }
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
    for ($i = $dirs.Count - 1; $i -ge 0; $i--) { try { [System.IO.Directory]::Delete($dirs[$i], $false) } catch { } }
}

[pscustomobject]@{
    status       = 'ok'
    removedCount = $removed
    removedBytes = $removedBytes
    skippedCount = $skipped
} | ConvertTo-Json -Compress
