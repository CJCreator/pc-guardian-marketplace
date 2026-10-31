# Drive Cleanup - CLEANUP ACTION. Permanently deletes one quarantine run.
#
# Runs only when the person presses "Delete for good" on one quarantine run in
# Drive Cleanup's Quarantine view and confirms. Never runs by itself. It deletes
# only <quarantine>\<run id>\, and only when that folder holds the restore.json
# Drive Cleanup wrote for that run. Links inside are removed as links; what they
# point to is never touched. This cannot be undone.
#
# Inputs: DC_RUN_ID, DC_QUARANTINE_ROOT.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$runId = [string]$env:DC_RUN_ID
$root = [string]$env:DC_QUARANTINE_ROOT
function Write-Refusal([string]$detail) {
    [pscustomobject]@{ status = 'refused'; reason = 'refused'; detail = $detail } | ConvertTo-Json -Compress
}
if ($runId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $root -notmatch '^[A-Za-z]:\\Drive Cleanup Quarantine$') {
    Write-Refusal 'The request is not valid, so nothing was deleted.'
    exit 0
}
$runDir = Join-Path $root $runId
$restorePath = Join-Path $runDir 'restore.json'
if (-not [System.IO.File]::Exists($restorePath)) {
    Write-Refusal 'That folder is not a Drive Cleanup quarantine run, so nothing was deleted.'
    exit 0
}
$doc = [System.IO.File]::ReadAllText($restorePath) | ConvertFrom-Json
if ([string]$doc.runId -ne $runId) {
    Write-Refusal 'restore.json belongs to another run, so nothing was deleted.'
    exit 0
}

$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory
$bytes = 0.0
$count = 0
$failed = 0
$dirs = [System.Collections.Generic.List[string]]::new()
$pending = [System.Collections.Generic.Stack[string]]::new()
$pending.Push($runDir)
while ($pending.Count -gt 0) {
    $dir = $pending.Pop()
    $dirs.Add($dir)
    foreach ($child in [System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos()) {
        $isDir = ($child.Attributes -band $directoryFlag) -ne 0
        if (($child.Attributes -band $reparsePoint) -ne 0) {
            # Remove the link itself, never what it points to.
            try { if ($isDir) { [System.IO.Directory]::Delete($child.FullName, $false) } else { $child.Delete() } } catch { $failed++ }
            continue
        }
        if ($isDir) { $pending.Push($child.FullName); continue }
        try {
            $len = [double]$child.Length
            $child.Attributes = [System.IO.FileAttributes]::Normal
            $child.Delete()
            $bytes += $len
            $count++
        } catch {
            $failed++
        }
    }
}
for ($i = $dirs.Count - 1; $i -ge 0; $i--) { try { [System.IO.Directory]::Delete($dirs[$i], $false) } catch { } }

[pscustomobject]@{
    status       = 'ok'
    runId        = $runId
    removedCount = $count
    removedBytes = $bytes
    failedCount  = $failed
} | ConvertTo-Json -Compress
