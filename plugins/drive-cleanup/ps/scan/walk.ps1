# Drive Cleanup - read-only. One metadata walk of the system drive: names,
# sizes, dates and attributes only. File contents are never opened; nothing is
# created, changed or opened for writing. Junctions, symbolic links and cloud
# folders (any reparse point) are counted and never followed, and cloud files
# that are not downloaded are never opened or offered.
#
# Reports: folder sizes three levels deep, the 100 largest files, age totals,
# file types, development projects (left alone), and candidates for cleanup by
# kind (installers, archives, crash dumps, old logs, old Temp folders, old
# downloads, large old files, empty folders, and build caches inside projects).
# Candidates are only collected in this user's own areas; system folders and other profiles are summed only.
# Stops at a time and entry limit and says so (isTruncated).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$budgetMs = 240000
$maxEntries = 3000000
$keepLargest = 100
$keepPerKind = 1000
$keepFolders = 1500
$keepSamples = 200

$now = [DateTime]::UtcNow
$cut12m = $now.AddDays(-365).Ticks
$cut6m = $now.AddDays(-182).Ticks
$cut7d = $now.AddDays(-7).Ticks
$cutLog = $now.AddDays(-30).Ticks
$cutDownload = $now.AddDays(-90).Ticks
$largeOldBytes = 500MB

$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory
# Offline, RecallOnOpen (0x40000), RecallOnDataAccess (0x400000), plus reparse: cloud or linked files.
$cloudMask = [int]([System.IO.FileAttributes]::Offline) -bor 0x40000 -bor 0x400000 -bor [int]$reparsePoint
$ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
$invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Get-LongPath([string]$path) {
    try {
        $full = [System.IO.Path]::GetFullPath($path)
        if ($full -notmatch '~') { return $full.TrimEnd('\') }
        $root = [System.IO.Path]::GetPathRoot($full)
        $current = $root
        foreach ($part in $full.Substring($root.Length).Split([char]'\', [StringSplitOptions]::RemoveEmptyEntries)) {
            $found = @([System.IO.DirectoryInfo]::new($current).GetFileSystemInfos($part))
            if ($found.Count -ge 1) { $current = $found[0].FullName } else { $current = Join-Path $current $part }
        }
        return $current.TrimEnd('\')
    } catch {
        return $path
    }
}

function Format-Time([long]$ticks) {
    return [DateTime]::new($ticks, [DateTimeKind]::Utc).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $invariant)
}

$driveRoot = [string]$env:SystemDrive + '\'
$systemRoot = Get-LongPath $env:SystemRoot
$userProfile = Get-LongPath $env:USERPROFILE
$profilesRoot = Split-Path -Parent $userProfile
$appDataRoot = Join-Path $userProfile 'AppData'
$appData = Get-LongPath $env:APPDATA
$localAppData = Get-LongPath $env:LOCALAPPDATA
$temp = Get-LongPath $env:TEMP
$downloads = $null
try {
    $shellFolders = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'
    $downloads = [string]$shellFolders.'{374DE290-123F-4565-9164-39C4925E467B}'
} catch {
    $downloads = $null
}
if (-not $downloads) { $downloads = Join-Path $userProfile 'Downloads' }
$downloads = Get-LongPath $downloads

# Summed, never searched for candidates.
$sumOnly = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Recovery', 'System Volume Information', '$Recycle.Bin', '$WinREAgent', '$Windows.~BT', '$Windows.~WS', 'Boot', 'EFI', 'Config.Msi', 'PerfLogs', 'Windows.old')) {
    [void]$sumOnly.Add((Join-Path $driveRoot $name))
}
[void]$sumOnly.Add($systemRoot)

$projectMarkers = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile')) {
    [void]$projectMarkers.Add($name)
}
$installerExt = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($e in @('.exe', '.msi', '.msix', '.msixbundle', '.appx', '.appxbundle')) { [void]$installerExt.Add($e) }
$archiveExt = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($e in @('.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.iso', '.img', '.cab')) { [void]$archiveExt.Add($e) }

# ------------------------------------------------------------------ results
$entries = 0
$fileCount = 0
$folderCount = 0
$totalBytes = 0.0
$denied = 0
$deniedSample = [System.Collections.Generic.List[string]]::new()
# Folders whose path is too long for Windows PowerShell 5.1 (260 characters): reported, not read.
$longPaths = 0
$longPathSample = [System.Collections.Generic.List[string]]::new()
$linked = 0
$linkedSample = [System.Collections.Generic.List[string]]::new()
$old12Count = 0
$old12Bytes = 0.0
$old6Count = 0
$old6Bytes = 0.0
$projectCount = 0
$projectSample = [System.Collections.Generic.List[string]]::new()
$tempFiles = 0
$tempBytes = 0.0
$tempOldFiles = 0
$tempOldBytes = 0.0

$folderAgg = [System.Collections.Generic.Dictionary[string, double[]]]::new([System.StringComparer]::OrdinalIgnoreCase)
$folderDepth = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::OrdinalIgnoreCase)
$protAgg = [System.Collections.Generic.Dictionary[string, double[]]]::new([System.StringComparer]::OrdinalIgnoreCase)
$extAgg = [System.Collections.Generic.Dictionary[string, double[]]]::new([System.StringComparer]::OrdinalIgnoreCase)
$tempBuckets = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
# Build caches inside projects that their tools re-create: Next.js, Vite, Turbo, Parcel.
$buildBuckets = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)

$largest = [System.Collections.Generic.List[object]]::new()
$largestFloor = -1.0

$kinds = @('installer', 'archive', 'crash_dump', 'log', 'temp_extract', 'old_download', 'large_old', 'empty_folder', 'build_cache')
$cand = @{}
$candCount = @{}
$candBytes = @{}
$candFloor = @{}
foreach ($k in $kinds) {
    $cand[$k] = [System.Collections.Generic.List[object]]::new()
    $candCount[$k] = 0
    $candBytes[$k] = 0.0
    $candFloor[$k] = -1.0
}

function Add-Candidate([string]$kind, [string]$path, [double]$bytes, [int]$count, [bool]$isFolder, [long]$mt, [long]$at, [long]$ct, $extracted, [bool]$inProject = $false) {
    $script:candCount[$kind] = $script:candCount[$kind] + 1
    $script:candBytes[$kind] = $script:candBytes[$kind] + $bytes
    if ($bytes -le $script:candFloor[$kind]) { return }
    $list = $script:cand[$kind]
    $list.Add([pscustomobject]@{
        kind            = $kind
        path            = $path
        bytes           = $bytes
        fileCount       = $count
        isFolder        = $isFolder
        modifiedUtc     = Format-Time $mt
        accessedUtc     = Format-Time $at
        createdUtc      = Format-Time $ct
        inProject       = $inProject
        extractedFolder = $extracted
    })
    if ($list.Count -ge ($script:keepPerKind * 4)) {
        $kept = @($list | Sort-Object -Property bytes -Descending | Select-Object -First $script:keepPerKind)
        $list.Clear()
        foreach ($x in $kept) { $list.Add($x) }
        $script:candFloor[$kind] = [double]$kept[$kept.Count - 1].bytes
    }
}

function Add-Sample($list, [string]$text) {
    if ($list.Count -lt $script:keepSamples) { $list.Add($text) }
}

# ------------------------------------------------------------------ the walk
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$isTruncated = $false
$pending = [System.Collections.Generic.Stack[object]]::new()
$pending.Push(@{
    Path = $driveRoot.TrimEnd('\') + '\'; Depth = 0; FolderKeys = @(); InProject = $false; SumOnly = $false; ProtKey = $null; BuildBucket = $null
    InProfile = $false; InAppData = $false; InTemp = $false; TempBucket = $null; InDownloads = $false; InRootUser = $false
})

while ($pending.Count -gt 0) {
    if ($entries -ge $maxEntries -or $stopwatch.ElapsedMilliseconds -ge $budgetMs) {
        $isTruncated = $true
        break
    }
    $item = $pending.Pop()
    try {
        $children = [System.IO.DirectoryInfo]::new($item.Path).GetFileSystemInfos()
    } catch {
        if ($_.Exception -is [System.IO.PathTooLongException] -or $item.Path.Length -ge 248) {
            $longPaths++
            Add-Sample $longPathSample $item.Path
        } else {
            $denied++
            Add-Sample $deniedSample $item.Path
        }
        continue
    }
    $folderCount++

    if ($children.Length -eq 0) {
        if ($item.InProfile -and -not $item.InAppData -and -not $item.InProject -and $item.Depth -ge 4) {
            $dir = [System.IO.DirectoryInfo]::new($item.Path)
            if (-not $dir.Name.StartsWith('.')) {
                Add-Candidate 'empty_folder' $item.Path 0 0 $true $dir.LastWriteTimeUtc.Ticks $dir.LastAccessTimeUtc.Ticks $dir.CreationTimeUtc.Ticks $null
            }
        }
        continue
    }

    $inProject = $item.InProject
    # The profile and the drive's top folders are never projects themselves (a
    # dotfiles repository or a stray package.json there would cover everything).
    if (-not $inProject -and -not $item.SumOnly -and $item.Depth -ge 2 -and -not $item.Path.Equals($userProfile, $ignoreCase)) {
        foreach ($c in $children) {
            $n = $c.Name
            if ($projectMarkers.Contains($n) -or $n.EndsWith('.sln', $ignoreCase) -or $n.EndsWith('.csproj', $ignoreCase)) {
                $inProject = $true
                $projectCount++
                Add-Sample $projectSample $item.Path
                break
            }
        }
    }

    foreach ($c in $children) {
        $entries++
        $attr = $c.Attributes
        if (($attr -band $directoryFlag) -ne 0) {
            if (($attr -band $reparsePoint) -ne 0) {
                $linked++
                Add-Sample $linkedSample $c.FullName
                continue
            }
            $p = $c.FullName
            $depth = $item.Depth + 1
            $isNewSum = (-not $item.SumOnly) -and ($sumOnly.Contains($p) -or ($item.Path.Equals($profilesRoot, $ignoreCase) -and -not $p.Equals($userProfile, $ignoreCase)))
            $protKey = $item.ProtKey
            if ($isNewSum) {
                $protKey = $p
                $protAgg[$p] = [double[]]@(0, 0)
            }
            $keys = $item.FolderKeys
            if ($depth -le 3) {
                $keys = @($item.FolderKeys) + $p
                $folderAgg[$p] = [double[]]@(0, 0)
                $folderDepth[$p] = $depth
            }
            $inTemp = $item.InTemp -or $p.Equals($temp, $ignoreCase)
            $bucket = $item.TempBucket
            if ($item.InTemp -and $null -eq $bucket) {
                $bucket = $p
                $tempBuckets[$p] = @{ Bytes = 0.0; Files = 0; MaxTicks = $c.LastWriteTimeUtc.Ticks; At = $c.LastAccessTimeUtc.Ticks; Ct = $c.CreationTimeUtc.Ticks }
            }
            $build = $item.BuildBucket
            if ($null -eq $build -and $inProject -and -not $item.SumOnly) {
                $leaf = $c.Name
                $parentLeaf = [System.IO.Path]::GetFileName($item.Path.TrimEnd('\'))
                if (($leaf -eq 'cache' -and $parentLeaf -eq '.next') -or ($leaf -eq '.vite' -and $parentLeaf -eq 'node_modules') -or $leaf -eq '.turbo' -or $leaf -eq '.parcel-cache') {
                    $build = $p
                    $buildBuckets[$p] = @{ Bytes = 0.0; Files = 0; MaxTicks = $c.LastWriteTimeUtc.Ticks; At = $c.LastAccessTimeUtc.Ticks; Ct = $c.CreationTimeUtc.Ticks }
                }
            }
            $pending.Push(@{
                BuildBucket = $build
                Path        = $p
                Depth       = $depth
                FolderKeys  = $keys
                InProject   = $inProject
                SumOnly     = $item.SumOnly -or $isNewSum
                ProtKey     = $protKey
                InProfile   = $item.InProfile -or $p.Equals($userProfile, $ignoreCase)
                InAppData   = $item.InAppData -or $p.Equals($appDataRoot, $ignoreCase) -or $p.Equals($appData, $ignoreCase) -or $p.Equals($localAppData, $ignoreCase)
                InTemp      = $inTemp
                TempBucket  = $bucket
                InDownloads = $item.InDownloads -or $p.Equals($downloads, $ignoreCase)
                InRootUser  = $item.InRootUser -or ($depth -eq 1 -and -not $isNewSum -and -not $p.Equals($profilesRoot, $ignoreCase) -and -not $c.Name.StartsWith('$'))
            })
            continue
        }

        # A file.
        $len = [double]$c.Length
        $fileCount++
        $totalBytes += $len
        foreach ($k in $item.FolderKeys) {
            $agg = $folderAgg[$k]
            $agg[0] += $len
            $agg[1] += 1
        }
        if ($null -ne $item.ProtKey) {
            $pa = $protAgg[$item.ProtKey]
            $pa[0] += $len
            $pa[1] += 1
        }
        $mt = $c.LastWriteTimeUtc.Ticks
        $at = $c.LastAccessTimeUtc.Ticks
        if ($mt -lt $cut12m) { $old12Count++; $old12Bytes += $len }
        if ($at -lt $cut6m) { $old6Count++; $old6Bytes += $len }
        $ext = $c.Extension.ToLowerInvariant()
        if ($ext -eq '') { $ext = '(none)' }
        $ea = $null
        if (-not $extAgg.TryGetValue($ext, [ref]$ea)) {
            $ea = [double[]]@(0, 0)
            $extAgg[$ext] = $ea
        }
        $ea[0] += 1
        $ea[1] += $len

        if ($len -gt $largestFloor) {
            $largest.Add([pscustomobject]@{ path = $c.FullName; bytes = $len; mt = $mt; at = $at; ct = $c.CreationTimeUtc.Ticks; inProject = $inProject })
            if ($largest.Count -ge 400) {
                $kept = @($largest | Sort-Object -Property bytes -Descending | Select-Object -First $keepLargest)
                $largest.Clear()
                foreach ($x in $kept) { $largest.Add($x) }
                $largestFloor = [double]$kept[$kept.Count - 1].bytes
            }
        }

        if ($item.InTemp) {
            $tempFiles++
            $tempBytes += $len
            if ($mt -lt $cut7d) { $tempOldFiles++; $tempOldBytes += $len }
            if ($null -ne $item.TempBucket) {
                $b = $tempBuckets[$item.TempBucket]
                $b.Bytes += $len
                $b.Files += 1
                if ($mt -gt $b.MaxTicks) { $b.MaxTicks = $mt }
            }
        }

        if ($null -ne $item.BuildBucket) {
            $bb = $buildBuckets[$item.BuildBucket]
            $bb.Bytes += $len
            $bb.Files += 1
            if ($mt -gt $bb.MaxTicks) { $bb.MaxTicks = $mt }
        }

        if ($item.SumOnly -or $inProject) { continue }
        if (([int]$attr -band $cloudMask) -ne 0) { continue }

        $isUserArea = ($item.InProfile -and -not $item.InAppData) -or $item.InRootUser
        if ($isUserArea -and $installerExt.Contains($ext)) {
            Add-Candidate 'installer' $c.FullName $len 1 $false $mt $at $c.CreationTimeUtc.Ticks $null
        } elseif ($isUserArea -and $archiveExt.Contains($ext)) {
            $stem = [System.IO.Path]::GetFileNameWithoutExtension($c.Name)
            if ($stem.EndsWith('.tar', $ignoreCase)) { $stem = $stem.Substring(0, $stem.Length - 4) }
            $sibling = Join-Path $c.DirectoryName $stem
            $extracted = $null
            if ($stem -ne '' -and [System.IO.Directory]::Exists($sibling)) { $extracted = $sibling }
            Add-Candidate 'archive' $c.FullName $len 1 $false $mt $at $c.CreationTimeUtc.Ticks $extracted
        } elseif ($ext -eq '.dmp' -and $item.InProfile) {
            Add-Candidate 'crash_dump' $c.FullName $len 1 $false $mt $at $c.CreationTimeUtc.Ticks $null
        } elseif ($item.InAppData -and $mt -lt $cutLog -and ($ext -eq '.log' -or $ext -eq '.etl' -or $c.Name -match '\.log\.\d+$')) {
            Add-Candidate 'log' $c.FullName $len 1 $false $mt $at $c.CreationTimeUtc.Ticks $null
        } elseif ($item.InDownloads -and $mt -lt $cutDownload) {
            Add-Candidate 'old_download' $c.FullName $len 1 $false $mt $at $c.CreationTimeUtc.Ticks $null
        } elseif ($isUserArea -and $len -ge $largeOldBytes -and $mt -lt $cut12m) {
            Add-Candidate 'large_old' $c.FullName $len 1 $false $mt $at $c.CreationTimeUtc.Ticks $null
        }
    }
}

# Folders in Temp, each as one candidate with its newest write.
foreach ($pair in $tempBuckets.GetEnumerator()) {
    $b = $pair.Value
    if ($b.Bytes -le 0) { continue }
    Add-Candidate 'temp_extract' $pair.Key $b.Bytes $b.Files $true $b.MaxTicks $b.At $b.Ct $null
}

foreach ($pair in $buildBuckets.GetEnumerator()) {
    $b = $pair.Value
    if ($b.Bytes -le 0) { continue }
    Add-Candidate 'build_cache' $pair.Key $b.Bytes $b.Files $true $b.MaxTicks $b.At $b.Ct $null $true
}

# ------------------------------------------------------------------ output
$largestOut = @($largest | Sort-Object -Property bytes -Descending | Select-Object -First $keepLargest | ForEach-Object {
    [pscustomobject]@{
        path        = $_.path
        bytes       = $_.bytes
        modifiedUtc = Format-Time $_.mt
        accessedUtc = Format-Time $_.at
        createdUtc  = Format-Time $_.ct
        inProject   = $_.inProject
    }
})

$candidatesOut = [System.Collections.Generic.List[object]]::new()
$totalsOut = [System.Collections.Generic.List[object]]::new()
foreach ($k in $kinds) {
    $kept = @($cand[$k] | Sort-Object -Property bytes -Descending | Select-Object -First $keepPerKind)
    foreach ($x in $kept) { $candidatesOut.Add($x) }
    $totalsOut.Add([pscustomobject]@{
        kind     = $k
        count    = $candCount[$k]
        bytes    = $candBytes[$k]
        isCapped = $candCount[$k] -gt $kept.Count
    })
}

$foldersOut = @($folderAgg.GetEnumerator() | Sort-Object -Property { $_.Value[0] } -Descending | Select-Object -First $keepFolders | ForEach-Object {
    [pscustomobject]@{ path = $_.Key; depth = $folderDepth[$_.Key]; bytes = $_.Value[0]; fileCount = [long]$_.Value[1] }
})
$extOut = @($extAgg.GetEnumerator() | Sort-Object -Property { $_.Value[1] } -Descending | Select-Object -First 40 | ForEach-Object {
    [pscustomobject]@{ extension = $_.Key; fileCount = [long]$_.Value[0]; bytes = $_.Value[1] }
})
$protOut = @($protAgg.GetEnumerator() | Sort-Object -Property { $_.Value[0] } -Descending | Select-Object -First 64 | ForEach-Object {
    [pscustomobject]@{ path = $_.Key; bytes = $_.Value[0]; fileCount = [long]$_.Value[1] }
})

[pscustomobject]@{
    root              = $driveRoot
    elapsedMs         = [double]$stopwatch.ElapsedMilliseconds
    isTruncated       = $isTruncated
    entryCount        = $entries
    deniedFolders     = $denied
    deniedSample      = @($deniedSample)
    longPathFolders   = $longPaths
    longPathSample    = @($longPathSample)
    linkedFolders     = $linked
    linkedSample      = @($linkedSample)
    totals            = [pscustomobject]@{ fileCount = $fileCount; folderCount = $folderCount; bytes = $totalBytes }
    protectedRoots    = $protOut
    ages              = [pscustomobject]@{
        modifiedOver12m = [pscustomobject]@{ count = $old12Count; bytes = $old12Bytes }
        accessedOver6m  = [pscustomobject]@{ count = $old6Count; bytes = $old6Bytes }
    }
    extensions        = $extOut
    folders           = $foldersOut
    largest           = $largestOut
    candidates        = @($candidatesOut)
    candidateTotals   = @($totalsOut)
    userTemp          = [pscustomobject]@{ fileCount = $tempFiles; bytes = $tempBytes; oldCount = $tempOldFiles; oldBytes = $tempOldBytes }
    projectRootCount  = $projectCount
    projectRootSample = @($projectSample)
} | ConvertTo-Json -Compress -Depth 5
