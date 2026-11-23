# Drive Cleanup - CLEANUP ACTION. Permanently deletes one quarantine run.
#
# Runs only when the person confirms "Delete for good" for one quarantine run
# (in Drive Cleanup's pane, or when Claude asks them with empty_quarantine). Never runs by itself. It deletes
# only <quarantine>\<run id>\, and only when that folder holds the restore.json
# Drive Cleanup wrote for that run (deleted last, so a partial purge can be retried). Links inside are removed as links; what they
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
foreach ($p in @($root, $runDir)) {
    if ((([System.IO.File]::GetAttributes($p)) -band $reparsePoint) -ne 0) {
        Write-Refusal 'The quarantine folder is a link, so nothing was deleted.'
        exit 0
    }
}
$bytes = 0.0
$count = 0
$failed = 0
$dirs = [System.Collections.Generic.List[string]]::new()
$pending = [System.Collections.Generic.Stack[string]]::new()
$pending.Push($runDir)
while ($pending.Count -gt 0) {
    $dir = $pending.Pop()
    $dirs.Add($dir)
    try { $children = @([System.IO.DirectoryInfo]::new($dir).GetFileSystemInfos()) } catch { $failed++; continue }
    foreach ($child in $children) {
        $isDir = ($child.Attributes -band $directoryFlag) -ne 0
        if (($child.Attributes -band $reparsePoint) -ne 0) {
            # Remove the link itself, never what it points to.
            try { if ($isDir) { [System.IO.Directory]::Delete($child.FullName, $false) } else { $child.Delete() } } catch { $failed++ }
            continue
        }
        if ($isDir) { $pending.Push($child.FullName); continue }
        # restore.json goes last: while anything is left, the run can be purged again.
        if ($child.FullName.Equals($restorePath, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
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
for ($i = $dirs.Count - 1; $i -ge 1; $i--) {
    try {
        [System.IO.File]::SetAttributes($dirs[$i], [System.IO.FileAttributes]::Directory)
        [System.IO.Directory]::Delete($dirs[$i], $false)
    } catch {
        $failed++
    }
}
if ($failed -eq 0) {
    try {
        [System.IO.File]::Delete($restorePath)
        [System.IO.Directory]::Delete($runDir, $false)
    } catch {
        $failed++
    }
}

[pscustomobject]@{
    status       = 'ok'
    runId        = $runId
    removedCount = $count
    removedBytes = $bytes
    failedCount  = $failed
} | ConvertTo-Json -Compress
