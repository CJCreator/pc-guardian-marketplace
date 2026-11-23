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
# The quarantine folders must be this user's (or Windows'): another account that made the root
# first could have renamed run folders and planted a restore.json.
$trusted = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($p in @($root, $runDir)) {
    try {
        if (([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'link' }
        $owner = [System.IO.Directory]::GetAccessControl($p, [System.Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($trusted -notcontains $owner) { throw 'owner' }
    } catch {
        Write-Refusal ('The quarantine folder ' + $p + ' is missing, a link, or belongs to another account, so nothing was changed.')
        exit 0
    }
}
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

# Copies one file back across drives under a temporary name, verifies it, then gives it its
# real name: a stop half-way never leaves a broken file at the original place.
function Copy-Verified([string]$src, [string]$target) {
    $temp = $target + '.dc-restore'
    if ([System.IO.File]::Exists($temp)) { [System.IO.File]::Delete($temp) }
    [System.IO.File]::Copy($src, $temp, $false)
    if ((Get-Sha256 $src) -ne (Get-Sha256 $temp)) {
        [System.IO.File]::Delete($temp)
        throw 'A copy did not match; the item stays in quarantine.'
    }
    [System.IO.File]::SetLastWriteTimeUtc($temp, [System.IO.File]::GetLastWriteTimeUtc($src))
    [System.IO.File]::Move($temp, $target)
}

# Puts an item back. $merge (a folder recorded as "moving": its move was cut short) puts back
# only what is missing at the original place; a copy that matches what is there is dropped,
# and one that differs stays in quarantine.
function Move-Back([string]$src, [string]$dest, [bool]$isFolder, [bool]$merge) {
    if (-not $merge -and (Test-SameVolume $src $dest)) {
        if ($isFolder) { [System.IO.Directory]::Move($src, $dest) } else { [System.IO.File]::Move($src, $dest) }
        return
    }
    if (-not $isFolder) {
        Copy-Verified $src $dest
        [System.IO.File]::Delete($src)
        return
    }
    $files = [System.Collections.Generic.List[string]]::new()
    $dirs = [System.Collections.Generic.List[string]]::new()
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
    $kept = 0
    foreach ($f in $files) {
        if ($script:stopwatch.ElapsedMilliseconds -ge $script:hardStopMs) { throw 'Time limit reached part-way; press Restore again for the rest.' }
        $target = Join-Path $dest $f.Substring($src.Length)
        if ([System.IO.File]::Exists($target)) {
            if ($merge -and (Get-Sha256 $f) -eq (Get-Sha256 $target)) { [System.IO.File]::Delete($f) } else { $kept++ }
            continue
        }
        if (Test-SameVolume $f $target) { [System.IO.File]::Move($f, $target) } else { Copy-Verified $f $target; [System.IO.File]::Delete($f) }
    }
    for ($i = $dirs.Count - 1; $i -ge 0; $i--) { try { [System.IO.Directory]::Delete($dirs[$i], $false) } catch { } }
    if ($kept -gt 0) { throw ([string]$kept + ' files differ from what is at the original place again; they stay in quarantine.') }
}

# Never put a file back where it would run, change Windows or touch protected data, whatever
# restore.json says: the same places apply.ps1 never takes from.
$systemRoot = [System.IO.Path]::GetFullPath([string]$env:SystemRoot).TrimEnd('\')
$driveRoot = [string]$env:SystemDrive + '\'
$userProfile = [System.IO.Path]::GetFullPath([string]$env:USERPROFILE).TrimEnd('\')
$profilesRoot = Split-Path -Parent $userProfile
$forbidden = [System.Collections.Generic.List[string]]::new()
foreach ($name in @('Program Files', 'Program Files (x86)', 'ProgramData', 'Recovery', 'System Volume Information', '$Recycle.Bin', 'Boot', 'EFI', 'PerfLogs', 'Windows.old')) { $forbidden.Add((Join-Path $driveRoot $name)) }
$forbidden.Add($systemRoot)
$forbidden.Add((Join-Path ([string]$env:APPDATA) 'techgramam-drive-cleanup'))
foreach ($rel in @('AppData\Local\Packages', 'AppData\Roaming\Microsoft', 'AppData\Local\Microsoft\Windows', 'AppData\Local\Programs', 'Documents\WindowsPowerShell', 'Documents\PowerShell', '.vscode\extensions', '.cursor', '.antigravity')) { $forbidden.Add((Join-Path $userProfile $rel)) }
$forbiddenSegments = @('.ssh', '.gnupg', '.aws', '.azure', '.kube', '.gcloud', '.git', 'drive cleanup quarantine')
function Test-Forbidden([string]$path) {
    if ($path -notmatch '^[A-Za-z]:\\' -or $path.Length -le 3 -or $path.Split('\').Length -lt 3) { return $true }
    # An 8.3 short name (PROGRA~1) could hide a forbidden folder: never restore through one.
    if ($path -match '~\d') { return $true }
    if ($path.StartsWith($profilesRoot + '\', $ignoreCase) -and -not ($path.Equals($userProfile, $ignoreCase) -or $path.StartsWith($userProfile + '\', $ignoreCase))) { return $true }
    foreach ($r in $script:forbidden) { if ($path.Equals($r, $ignoreCase) -or $path.StartsWith($r + '\', $ignoreCase)) { return $true } }
    foreach ($segment in $path.Split('\')) { if ($forbiddenSegments -contains $segment) { return $true } }
    return $path -match '\\Start Menu\\Programs\\Startup(\\|$)'
}

# Written to a temporary file, then swapped in: a stop half-way never leaves a broken restore.json.
function Save-Doc {
    $temp = $script:restorePath + '.new'
    [System.IO.File]::WriteAllText($temp, ($script:doc | ConvertTo-Json -Depth 4))
    [System.IO.File]::Replace($temp, $script:restorePath, $null)
}

$budgetMs = 540000
$hardStopMs = 570000
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$results = [System.Collections.Generic.List[object]]::new()
$restoredBytes = 0.0
$isTruncated = $false
$runDirFull = [System.IO.Path]::GetFullPath($runDir).TrimEnd('\')
foreach ($item in @($doc.items)) {
    $id = [string]$item.id
    if ($null -ne $only -and -not $only.Contains($id)) { continue }
    $state = [string]$item.state
    if ($state -ne 'quarantined' -and $state -ne 'moving') { continue }
    $isFolder = [bool]$item.isFolder
    $result = [ordered]@{ id = $id; status = 'skipped'; detail = ''; destination = [string]$item.original; sha256 = $null; bytes = [double]$item.bytes }
    try {
        # Both paths resolved first: a "..\" in restore.json cannot reach outside the run or past the rules.
        $src = [System.IO.Path]::GetFullPath([string]$item.destination).TrimEnd('\')
        $dest = [System.IO.Path]::GetFullPath([string]$item.original).TrimEnd('\')
        $result.destination = $dest
        if (-not $src.StartsWith($runDirFull + '\', $ignoreCase)) { throw 'Its quarantine path is outside this run.' }
        if (Test-Forbidden $dest) { throw 'Its original place is not one Drive Cleanup puts files back to.' }
        # Time: copying back across drives reads it twice (copy, verify); a same-drive file is hashed once.
        $passes = $(if (Test-SameVolume $src $dest) { $(if ($isFolder) { 0 } else { 1 }) } else { 3 })
        $needMs = [double]$item.bytes * $passes / 60MB * 1000
        if ($stopwatch.ElapsedMilliseconds + $needMs -gt $budgetMs -and $results.Count -gt 0) {
            $isTruncated = $true
            throw 'Time limit reached; press Restore again for the rest.'
        }
        if (-not $isFolder -and $item.sha256 -and [System.IO.File]::Exists($src) -and (Get-Sha256 $src) -ne [string]$item.sha256) {
            throw 'It changed in quarantine, so it was not put back. It is still there.'
        }
        $merge = $state -eq 'moving'
        if (-not $merge -and ([System.IO.File]::Exists($dest) -or [System.IO.Directory]::Exists($dest))) { throw 'Something is at its original place again; it stays in quarantine.' }
        if ($isFolder) { if (-not [System.IO.Directory]::Exists($src)) { throw 'It is missing from quarantine.' } }
        elseif (-not [System.IO.File]::Exists($src)) { throw 'It is missing from quarantine.' }
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $dest))
        Move-Back $src $dest $isFolder $merge
        $item.state = 'restored'
        $result.status = 'restored'
        $restoredBytes += [double]$item.bytes
    } catch {
        $result.detail = [string]$_.Exception.Message
    }
    # Saved after every item: if the run is stopped, a retry does not trip over what is already back.
    try { Save-Doc } catch { if ($result.detail -eq '') { $result.detail = 'Put back, but restore.json could not be updated.' } }
    $results.Add([pscustomobject]$result)
}
$sha.Dispose()

[pscustomobject]@{
    status           = 'ok'
    runId            = $runId
    quarantineDir    = $runDir
    deletedBytes     = 0
    quarantinedBytes = 0
    restoredBytes    = $restoredBytes
    isTruncated      = $isTruncated
    items            = @($results)
} | ConvertTo-Json -Compress -Depth 4
