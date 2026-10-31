# PC Guardian AI - CLEANUP ACTION. This script deletes files. It runs only after the
# person ticked "Temp files" in a cleanup preview and confirmed, with cleanup turned
# on in Settings. It deletes, permanently, files in the user's Temp folder that were
# last written 7 days or more before that preview and already existed at it, so
# nothing outside what the preview measured is removed. Files in use are skipped,
# links are never followed, and folders are left in place.
# Input: PCG_PREVIEWED_AT, the preview's time (ISO 8601, UTC), set by PC Guardian.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$previewedAt = ([datetime]$env:PCG_PREVIEWED_AT).ToUniversalTime()
$cutoff = $previewedAt.AddDays(-7)
$root = $env:TEMP
$maxFiles = 200000
$budgetMs = 120000
$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory

if (-not ($root -match '\\Temp\\?$') -or -not (Test-Path -LiteralPath $root -PathType Container)) {
    [pscustomobject]@{
        status = 'refused'
        reason = 'not_temp'
        detail = 'The Temp folder is not where PC Guardian expects it, so nothing was deleted.'
    } | ConvertTo-Json -Compress
} else {
    $removed = 0
    $removedBytes = 0.0
    $skipped = 0
    $seen = 0
    $isTruncated = $false
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
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
                if ($child.LastWriteTimeUtc -ge $cutoff -or $child.CreationTimeUtc -ge $previewedAt) { continue }
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
    [pscustomobject]@{
        status       = 'ok'
        removedCount = $removed
        removedBytes = $removedBytes
        skippedCount = $skipped
        isTruncated  = $isTruncated
    } | ConvertTo-Json -Compress
}
