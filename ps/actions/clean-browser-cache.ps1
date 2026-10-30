# PC Guardian AI - CLEANUP ACTION. This script deletes files. It runs only after the
# person ticked one browser's cache in a cleanup preview and confirmed, with cleanup
# turned on in Settings. It deletes, permanently, the files in that browser's cache
# folders (Chromium: Cache\Cache_Data, Code Cache and GPUCache in each profile;
# Firefox: cache2 in each profile) that already existed at the preview. It refuses
# while the browser is open. History, cookies, passwords, sessions and settings are
# in other folders and are never touched; links are never followed.
# Inputs: PCG_BROWSER (edge, chrome, brave or firefox) and PCG_PREVIEWED_AT (ISO 8601).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$browser = $env:PCG_BROWSER
$previewedAt = ([datetime]$env:PCG_PREVIEWED_AT).ToUniversalTime()
$local = $env:LOCALAPPDATA
$processOf = @{ edge = 'msedge'; chrome = 'chrome'; brave = 'brave'; firefox = 'firefox' }
$dataDirOf = @{
    edge   = 'Microsoft\Edge\User Data'
    chrome = 'Google\Chrome\User Data'
    brave  = 'BraveSoftware\Brave-Browser\User Data'
}
$maxFiles = 500000
$budgetMs = 240000
$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory

$process = $processOf[[string]$browser]
if ($null -eq $process) {
    [pscustomobject]@{ status = 'refused'; reason = 'unknown_browser'; detail = 'Not a browser PC Guardian cleans.' } | ConvertTo-Json -Compress
} elseif (@(Get-Process -Name $process -ErrorAction SilentlyContinue).Count -gt 0) {
    [pscustomobject]@{ status = 'refused'; reason = 'running'; detail = 'The browser is open. Close it, then clean its cache.' } | ConvertTo-Json -Compress
} else {
    $roots = [System.Collections.Generic.List[object]]::new()
    if ($browser -eq 'firefox') {
        $profiles = Join-Path $local 'Mozilla\Firefox\Profiles'
        if (Test-Path -LiteralPath $profiles -PathType Container) {
            foreach ($profileDir in @(Get-ChildItem -LiteralPath $profiles -Directory)) {
                $roots.Add((Join-Path $profileDir.FullName 'cache2'))
            }
        }
    } else {
        $dataDir = Join-Path $local $dataDirOf[$browser]
        if (Test-Path -LiteralPath $dataDir -PathType Container) {
            foreach ($profileDir in @(Get-ChildItem -LiteralPath $dataDir -Directory | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' })) {
                foreach ($sub in @('Cache\Cache_Data', 'Code Cache', 'GPUCache')) {
                    $roots.Add((Join-Path $profileDir.FullName $sub))
                }
            }
        }
    }

    $removed = 0
    $removedBytes = 0.0
    $skipped = 0
    $seen = 0
    $isTruncated = $false
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $pending = [System.Collections.Generic.Stack[string]]::new()
        $pending.Push($root)
        while ($pending.Count -gt 0) {
            if ($seen -ge $maxFiles -or $stopwatch.ElapsedMilliseconds -ge $budgetMs) {
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
                    $seen++
                    if ($child.CreationTimeUtc -ge $previewedAt) { continue }
                    $length = $child.Length
                    try {
                        $child.Delete()
                        $removed++
                        $removedBytes += $length
                    } catch {
                        $skipped++
                    }
                }
            } catch {
                $skipped++
            }
        }
    }
    [pscustomobject]@{
        status       = 'ok'
        removedCount = $removed
        removedBytes = $removedBytes
        skippedCount = $skipped
        isTruncated  = $isTruncated
    } | ConvertTo-Json -Compress
}
