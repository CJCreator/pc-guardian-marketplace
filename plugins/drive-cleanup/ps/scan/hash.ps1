# Drive Cleanup - read-only, OPT-IN. Finds duplicate files by content. It runs
# only when the person turned on "Find duplicates by content" in Drive Cleanup's
# settings, because it READS FILE CONTENTS to hash them (SHA-256). Files are
# opened for reading only, shared with other programs; nothing is written,
# changed or sent anywhere. Hashes stay on this PC.
#
# Scope: this user's profile (not AppData, not dot-folders, not development
# projects) and top-level non-system folders of the system drive. Links and
# cloud files that are not downloaded are skipped, so OneDrive never downloads
# anything for this. Only files whose size matches another file's are read: a
# quick hash of the first and last 64 KiB first, then a full hash where those
# match. Largest sizes first; at its time limit it stops and says where to
# resume (resumeBelowBytes).
#
# Inputs (set by Drive Cleanup, validated): DC_MIN_BYTES, DC_MAX_BYTES,
# DC_RESUME_BELOW (0 for a fresh run).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$minBytes = [int64]$env:DC_MIN_BYTES
$maxBytes = [int64]$env:DC_MAX_BYTES
$resumeBelow = [int64]$env:DC_RESUME_BELOW
$budgetMs = 480000
$maxFiles = 2000000
$quickSize = 65536
$keepGroups = 2000
$keepFilesPerGroup = 50
$keepFolderGroups = 500

$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory
$cloudMask = [int]([System.IO.FileAttributes]::Offline) -bor 0x40000 -bor 0x400000 -bor [int]$reparsePoint
$ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$sha = [System.Security.Cryptography.SHA256]::Create()

function Format-Time([DateTime]$time) {
    return $time.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $invariant)
}

function Get-Hex([byte[]]$bytes) {
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Open-ForReading([string]$path) {
    # Read access only; other programs may keep reading, writing or deleting it.
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    return [System.IO.FileStream]::new($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share, 1048576, [System.IO.FileOptions]::SequentialScan)
}

function Get-QuickHash([string]$path, [int64]$length) {
    $stream = Open-ForReading $path
    try {
        $buffer = [byte[]]::new($script:quickSize * 2)
        $read = $stream.Read($buffer, 0, $script:quickSize)
        [void]$stream.Seek($length - $script:quickSize, [System.IO.SeekOrigin]::Begin)
        $read += $stream.Read($buffer, $script:quickSize, $script:quickSize)
        return Get-Hex ($script:sha.ComputeHash($buffer, 0, $read))
    } finally {
        $stream.Dispose()
    }
}

function Get-FullHash([string]$path) {
    $stream = Open-ForReading $path
    try {
        return Get-Hex ($script:sha.ComputeHash($stream))
    } finally {
        $stream.Dispose()
    }
}

$userProfile = [string]$env:USERPROFILE
$appDataRoot = Join-Path $userProfile 'AppData'
$driveRoot = [string]$env:SystemDrive + '\'
$systemTop = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($n in @('Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Recovery', 'System Volume Information', '$Recycle.Bin', '$WinREAgent', 'Boot', 'EFI', 'Config.Msi', 'PerfLogs', 'Windows.old', 'Users')) { [void]$systemTop.Add($n) }
$projectMarkers = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($n in @('.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile')) { [void]$projectMarkers.Add($n) }
$skipExt = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($e in @('.pem', '.key', '.pfx', '.p12', '.kdbx', '.db', '.sqlite', '.sqlite3', '.pst', '.ost', '.mdf', '.ldf', '.accdb', '.mdb', '.edb', '.sys', '.ini', '.lnk')) { [void]$skipExt.Add($e) }

$roots = [System.Collections.Generic.List[string]]::new()
$roots.Add($userProfile)
try {
    foreach ($d in [System.IO.DirectoryInfo]::new($driveRoot).GetDirectories()) {
        if (($d.Attributes -band $reparsePoint) -ne 0) { continue }
        if ($systemTop.Contains($d.Name) -or $d.Name.StartsWith('$')) { continue }
        $roots.Add($d.FullName)
    }
} catch {
    # The drive root is always readable; nothing more is added if not.
}

# ------------------------------------------------------------- 1. by size
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$bySize = [System.Collections.Generic.Dictionary[int64, System.Collections.Generic.List[object]]]::new()
$dirAll = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::OrdinalIgnoreCase)
$dirEligible = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[object]]]::new([System.StringComparer]::OrdinalIgnoreCase)
$considered = 0
$skippedCloud = 0
$isTruncated = $false

foreach ($root in $roots) {
    if (-not [System.IO.Directory]::Exists($root)) { continue }
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        if ($considered -ge $maxFiles -or $stopwatch.ElapsedMilliseconds -ge ($budgetMs / 4)) {
            $isTruncated = $true
            break
        }
        $directory = $pending.Pop()
        try {
            $children = [System.IO.DirectoryInfo]::new($directory).GetFileSystemInfos()
        } catch {
            continue
        }
        $isProject = $false
        if (-not $directory.Equals($userProfile, $ignoreCase) -and -not $roots.Contains($directory)) {
            foreach ($c in $children) { if ($projectMarkers.Contains($c.Name)) { $isProject = $true; break } }
        }
        if ($isProject) { continue }
        $all = 0
        $eligible = [System.Collections.Generic.List[object]]::new()
        foreach ($c in $children) {
            $attr = $c.Attributes
            if (($attr -band $directoryFlag) -ne 0) {
                if (($attr -band $reparsePoint) -ne 0) { continue }
                if ($c.Name.StartsWith('.')) { continue }
                if ($c.FullName.Equals($appDataRoot, $ignoreCase)) { continue }
                $pending.Push($c.FullName)
                continue
            }
            $all++
            if (([int]$attr -band $cloudMask) -ne 0) { $skippedCloud++; continue }
            if ($skipExt.Contains($c.Extension) -or $c.Name.StartsWith('.env')) { continue }
            $len = [int64]$c.Length
            if ($len -lt $minBytes -or $len -gt $maxBytes) { continue }
            if ($resumeBelow -gt 0 -and $len -ge $resumeBelow) { continue }
            $considered++
            $entry = [pscustomobject]@{ path = $c.FullName; name = $c.Name; dir = $directory; length = $len; info = $c; hash = $null }
            $list = $null
            if (-not $bySize.TryGetValue($len, [ref]$list)) {
                $list = [System.Collections.Generic.List[object]]::new()
                $bySize[$len] = $list
            }
            $list.Add($entry)
            $eligible.Add($entry)
        }
        if ($all -ge 2 -and $eligible.Count -eq $all) {
            $dirAll[$directory] = $all
            $dirEligible[$directory] = $eligible
        }
    }
    if ($isTruncated) { break }
}

# ------------------------------------------------------------- 2. hashing
$sizes = @($bySize.Keys | Where-Object { $bySize[$_].Count -ge 2 } | Sort-Object -Descending)
$hashed = 0
$bytesHashed = 0.0
$skippedLocked = 0
$resumeAt = $null
$groups = [System.Collections.Generic.List[object]]::new()

foreach ($size in $sizes) {
    if ($stopwatch.ElapsedMilliseconds -ge $budgetMs) {
        $isTruncated = $true
        $resumeAt = [double]($size + 1)
        break
    }
    $candidates = $bySize[$size]
    if ($size -ge ($quickSize * 2)) {
        $byQuick = @{}
        foreach ($f in $candidates) {
            try {
                $q = Get-QuickHash $f.path $size
            } catch {
                $skippedLocked++
                continue
            }
            if (-not $byQuick.ContainsKey($q)) { $byQuick[$q] = [System.Collections.Generic.List[object]]::new() }
            $byQuick[$q].Add($f)
        }
        $candidates = [System.Collections.Generic.List[object]]::new()
        foreach ($k in @($byQuick.Keys)) { if ($byQuick[$k].Count -ge 2) { foreach ($f in $byQuick[$k]) { $candidates.Add($f) } } }
    }
    $byFull = @{}
    foreach ($f in $candidates) {
        try {
            $h = Get-FullHash $f.path
        } catch {
            $skippedLocked++
            continue
        }
        $hashed++
        $bytesHashed += $size
        $f.hash = $h
        if (-not $byFull.ContainsKey($h)) { $byFull[$h] = [System.Collections.Generic.List[object]]::new() }
        $byFull[$h].Add($f)
    }
    foreach ($k in @($byFull.Keys)) {
        $same = $byFull[$k]
        if ($same.Count -lt 2) { continue }
        $groups.Add([pscustomobject]@{
            sha256 = $k
            bytes  = [double]$size
            wasted = [double]$size * ($same.Count - 1)
            files  = @($same | Select-Object -First $keepFilesPerGroup | ForEach-Object {
                [pscustomobject]@{
                    path        = $_.path
                    modifiedUtc = Format-Time $_.info.LastWriteTimeUtc
                    accessedUtc = Format-Time $_.info.LastAccessTimeUtc
                    createdUtc  = Format-Time $_.info.CreationTimeUtc
                }
            })
        })
    }
}

# ------------------------------------------------------------- 3. folders
# A folder is comparable when every file in it was hashed as part of a group.
$bySignature = @{}
foreach ($pair in $dirEligible.GetEnumerator()) {
    $entries = $pair.Value
    $complete = $true
    foreach ($e in $entries) { if ($null -eq $e.hash) { $complete = $false; break } }
    if (-not $complete) { continue }
    $parts = @($entries | ForEach-Object { $_.name.ToLowerInvariant() + '|' + $_.hash } | Sort-Object)
    $signature = Get-Hex ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($parts -join "`n")))
    $total = 0.0
    foreach ($e in $entries) { $total += $e.length }
    if (-not $bySignature.ContainsKey($signature)) { $bySignature[$signature] = @{ bytes = $total; fileCount = $entries.Count; folders = [System.Collections.Generic.List[string]]::new() } }
    $bySignature[$signature].folders.Add($pair.Key)
}
$folderGroups = @($bySignature.GetEnumerator() | Where-Object { $_.Value.folders.Count -ge 2 } | Sort-Object -Property { $_.Value.bytes * ($_.Value.folders.Count - 1) } -Descending | Select-Object -First $keepFolderGroups | ForEach-Object {
    [pscustomobject]@{ signature = $_.Key; bytes = $_.Value.bytes; fileCount = $_.Value.fileCount; folders = @($_.Value.folders | Select-Object -First 20) }
})

$sha.Dispose()

[pscustomobject]@{
    elapsedMs        = [double]$stopwatch.ElapsedMilliseconds
    isTruncated      = $isTruncated
    resumeBelowBytes = $resumeAt
    filesConsidered  = $considered
    filesHashed      = $hashed
    bytesHashed      = $bytesHashed
    skippedLocked    = $skippedLocked
    skippedCloud     = $skippedCloud
    groups           = @($groups | Sort-Object -Property wasted -Descending | Select-Object -First $keepGroups | ForEach-Object {
        [pscustomobject]@{ sha256 = $_.sha256; bytes = $_.bytes; files = $_.files }
    })
    folderGroups     = $folderGroups
} | ConvertTo-Json -Compress -Depth 5
