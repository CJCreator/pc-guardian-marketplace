# Drive Cleanup - CLEANUP ACTION. Puts quarantined items back where they were.
#
# Runs only when the person presses Restore in Drive Cleanup's Quarantine view.
# It reads restore.json in <quarantine>\<run id>\ (written when the items were
# moved) and moves each item still in quarantine back to its original path. An
# item whose original path is taken again is left in quarantine and reported;
# nothing is ever overwritten. A move across drives copies, verifies the copy's
# SHA-256, then removes the quarantined copy.
#
# Inputs: DC_RUN_ID, DC_QUARANTINE_ROOT, DC_LIST_ID ('' for every item of the
# run, else the id of a list of item ids in Drive Cleanup's data folder).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
$uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$runId = [string]$env:DC_RUN_ID
$root = [string]$env:DC_QUARANTINE_ROOT
$listId = [string]$env:DC_LIST_ID

function Write-Refusal([string]$detail) {
    [pscustomobject]@{ status = 'refused'; reason = 'refused'; detail = $detail } | ConvertTo-Json -Compress
}
if ($runId -notmatch $uuid -or $root -notmatch '^[A-Za-z]:\\Drive Cleanup Quarantine$' -or ($listId -ne '' -and $listId -notmatch $uuid)) {
    Write-Refusal 'The request is not valid, so nothing was changed.'
    exit 0
}
$runDir = Join-Path $root $runId
$restorePath = Join-Path $runDir 'restore.json'
if (-not [System.IO.File]::Exists($restorePath)) {
    Write-Refusal 'That quarantine run has no restore.json, so nothing was changed.'
    exit 0
}
$doc = [System.IO.File]::ReadAllText($restorePath) | ConvertFrom-Json
if ([string]$doc.runId -ne $runId) {
    Write-Refusal 'restore.json belongs to another run, so nothing was changed.'
    exit 0
}
$only = $null
if ($listId -ne '') {
    $listPath = Join-Path ([string]$env:APPDATA) ('techgramam-drive-cleanup\runs\pending\' + $listId + '.json')
    $only = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($id in @(([System.IO.File]::ReadAllText($listPath) | ConvertFrom-Json).itemIds)) { [void]$only.Add([string]$id) }
}

$sha = [System.Security.Cryptography.SHA256]::Create()
function Get-Sha256([string]$path) {
    $stream = [System.IO.FileStream]::new($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read, 1048576, [System.IO.FileOptions]::SequentialScan)
    try { return ([System.BitConverter]::ToString($script:sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() } finally { $stream.Dispose() }
}
function Test-SameVolume([string]$a, [string]$b) {
    return [System.IO.Path]::GetPathRoot($a).Equals([System.IO.Path]::GetPathRoot($b), $ignoreCase)
}
function Move-Back([string]$src, [string]$dest, [bool]$isFolder) {
    if (Test-SameVolume $src $dest) {
        if ($isFolder) { [System.IO.Directory]::Move($src, $dest) } else { [System.IO.File]::Move($src, $dest) }
        return
    }
    $files = [System.Collections.Generic.List[string]]::new()
    $dirs = [System.Collections.Generic.List[string]]::new()
    if ($isFolder) {
        $pending = [System.Collections.Generic.Stack[string]]::new()
        $pending.Push($src)
        while ($pending.Count -gt 0) {
            $dir = $pending.Pop()
            $dirs.Add($dir)
            foreach ($child in [System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos()) {
                if (($child.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { $pending.Push($child.FullName) } else { $files.Add($child.FullName) }
            }
        }
        foreach ($d in $dirs) { [void][System.IO.Directory]::CreateDirectory((Join-Path $dest $d.Substring($src.Length))) }
    } else {
        $files.Add($src)
    }
    # On any failure, undo the copies made so far: the item stays whole in quarantine.
    $copied = [System.Collections.Generic.List[string]]::new()
    try {
        foreach ($f in $files) {
            $target = $dest
            if ($isFolder) { $target = Join-Path $dest $f.Substring($src.Length) }
            [System.IO.File]::Copy($f, $target, $false)
            $copied.Add($target)
            if ((Get-Sha256 $f) -ne (Get-Sha256 $target)) { throw 'A copy did not match; the item stays in quarantine.' }
            [System.IO.File]::SetLastWriteTimeUtc($target, [System.IO.File]::GetLastWriteTimeUtc($f))
        }
    } catch {
        foreach ($t in $copied) { try { [System.IO.File]::Delete($t) } catch { } }
        if ($isFolder) { try { [System.IO.Directory]::Delete($dest, $true) } catch { } }
        throw
    }
    foreach ($f in $files) { [System.IO.File]::Delete($f) }
    for ($i = $dirs.Count - 1; $i -ge 0; $i--) { try { [System.IO.Directory]::Delete($dirs[$i], $false) } catch { } }
}

# Never put a file back where it would run or change Windows, whatever restore.json says.
$systemRoot = [System.IO.Path]::GetFullPath([string]$env:SystemRoot).TrimEnd('\')
$driveRoot = [string]$env:SystemDrive + '\'
$forbidden = @($systemRoot, (Join-Path $driveRoot 'Program Files'), (Join-Path $driveRoot 'Program Files (x86)'), (Join-Path $driveRoot 'ProgramData'))
function Test-Forbidden([string]$path) {
    if ($path -notmatch '^[A-Za-z]:\\' -or $path.Length -le 3) { return $true }
    # An 8.3 short name (PROGRA~1) could hide a forbidden folder: never restore through one.
    if ($path -match '~\d') { return $true }
    foreach ($r in $script:forbidden) { if ($path.Equals($r, $ignoreCase) -or $path.StartsWith($r + '\', $ignoreCase)) { return $true } }
    return $path -match '\\Start Menu\\Programs\\Startup(\\|$)'
}

$budgetMs = 540000
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$results = [System.Collections.Generic.List[object]]::new()
$restoredBytes = 0.0
foreach ($item in @($doc.items)) {
    $id = [string]$item.id
    if ($null -ne $only -and -not $only.Contains($id)) { continue }
    if ([string]$item.state -ne 'quarantined') { continue }
    $src = [string]$item.destination
    $dest = [string]$item.original
    $isFolder = [bool]$item.isFolder
    $result = [ordered]@{ id = $id; status = 'skipped'; detail = ''; destination = $dest; sha256 = $null; bytes = [double]$item.bytes }
    if ($stopwatch.ElapsedMilliseconds -ge $budgetMs) {
        $result.detail = 'Time limit reached; press Restore again for the rest.'
        $results.Add([pscustomobject]$result)
        continue
    }
    try {
        if (-not ($src.StartsWith($runDir + '\', $ignoreCase))) { throw 'Its quarantine path is outside this run.' }
        if (Test-Forbidden $dest) { throw 'Its original place is not one Drive Cleanup puts files back to.' }
        if (-not $isFolder -and $item.sha256 -and [System.IO.File]::Exists($src) -and (Get-Sha256 $src) -ne [string]$item.sha256) {
            throw 'It changed in quarantine, so it was not put back. It is still there.'
        }
        if ([System.IO.File]::Exists($dest) -or [System.IO.Directory]::Exists($dest)) { throw 'Something is at its original place again; it stays in quarantine.' }
        if ($isFolder) { if (-not [System.IO.Directory]::Exists($src)) { throw 'It is missing from quarantine.' } }
        elseif (-not [System.IO.File]::Exists($src)) { throw 'It is missing from quarantine.' }
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $dest))
        Move-Back $src $dest $isFolder
        $item.state = 'restored'
        $result.status = 'restored'
        $restoredBytes += [double]$item.bytes
        # Saved after every item: if the run is stopped, a retry does not trip over what is already back.
        [System.IO.File]::WriteAllText($restorePath, ($doc | ConvertTo-Json -Depth 4))
    } catch {
        $result.detail = [string]$_.Exception.Message
    }
    $results.Add([pscustomobject]$result)
}
$sha.Dispose()
[System.IO.File]::WriteAllText($restorePath, ($doc | ConvertTo-Json -Depth 4))

[pscustomobject]@{
    status           = 'ok'
    runId            = $runId
    quarantineDir    = $runDir
    deletedBytes     = 0
    quarantinedBytes = 0
    restoredBytes    = $restoredBytes
    isTruncated      = $false
    items            = @($results)
} | ConvertTo-Json -Compress -Depth 4
