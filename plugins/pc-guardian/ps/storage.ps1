# PC Guardian AI - read-only. Reports fixed drives and the size of a few well-known
# folders: Downloads, the user and Windows temp folders, the Windows Update download
# cache and the Recycle Bin. Metadata only (names, sizes, dates, extensions): file
# contents are never opened. Junctions and symbolic links are not followed. Each
# folder scan stops at a time and file-count cap and says so (isTruncated).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$folderBudgetMs = 6000
$folderMaxFiles = 100000

$mediaByLetter = @{}
try {
    $partitions = @(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_Partition -Property DriveLetter, DiskNumber)
    $physical = @(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_PhysicalDisk -Property DeviceId, MediaType)
    foreach ($partition in $partitions) {
        $letter = [string]$partition.DriveLetter
        if ($letter -notmatch '^[A-Za-z]$') { continue }
        $disk = $physical | Where-Object { [string]$_.DeviceId -eq [string]$partition.DiskNumber } | Select-Object -First 1
        if ($null -ne $disk) { $mediaByLetter[$letter.ToUpperInvariant() + ':'] = [int]$disk.MediaType }
    }
} catch {
    $mediaByLetter = @{}
}

$drives = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -Property DeviceID, VolumeName, FileSystem, Size, FreeSpace | ForEach-Object {
    [pscustomobject]@{
        letter     = [string]$_.DeviceID
        label      = [string]$_.VolumeName
        fileSystem = [string]$_.FileSystem
        totalBytes = [double]$_.Size
        freeBytes  = [double]$_.FreeSpace
        mediaType  = $mediaByLetter[[string]$_.DeviceID]
        isSystem   = [string]$_.DeviceID -eq $env:SystemDrive
    }
})

$downloads = $null
try {
    $shellFolders = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'
    $downloads = [string]$shellFolders.'{374DE290-123F-4565-9164-39C4925E467B}'
} catch {
    $downloads = $null
}
if (-not $downloads) { $downloads = Join-Path $env:USERPROFILE 'Downloads' }

$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$targets = @(
    @{ kind = 'downloads'; roots = @($downloads) },
    @{ kind = 'user_temp'; roots = @($env:TEMP) },
    @{ kind = 'windows_temp'; roots = @(Join-Path $env:SystemRoot 'Temp') },
    @{ kind = 'windows_update_cache'; roots = @(Join-Path $env:SystemRoot 'SoftwareDistribution\Download') },
    @{ kind = 'recycle_bin'; roots = @($drives | ForEach-Object { $_.letter + '\$Recycle.Bin\' + $sid }) }
)

$cutoff = (Get-Date).AddDays(-30)
$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory

$folders = foreach ($target in $targets) {
    $sizeBytes = 0.0
    $fileCount = 0
    $oldCount = 0
    $oldBytes = 0.0
    $extensionCount = @{}
    $extensionBytes = @{}
    $deniedFolders = 0
    $rootsFound = 0
    $rootsDenied = 0
    $isTruncated = $false
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    foreach ($root in $target.roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $rootsFound++
        $pending = [System.Collections.Generic.Stack[string]]::new()
        $pending.Push($root)
        while ($pending.Count -gt 0) {
            if ($fileCount -ge $folderMaxFiles -or $stopwatch.ElapsedMilliseconds -ge $folderBudgetMs) {
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
                    $sizeBytes += $child.Length
                    # In the Recycle Bin, $I files are the bin's own index of deleted items.
                    if ($target.kind -eq 'recycle_bin' -and $child.Name.StartsWith('$I')) { continue }
                    $fileCount++
                    if ($child.LastWriteTime -lt $cutoff) {
                        $oldCount++
                        $oldBytes += $child.Length
                    }
                    $extension = $child.Extension.ToLowerInvariant()
                    if ($extension -eq '') { $extension = '(none)' }
                    $extensionCount[$extension] = [int]$extensionCount[$extension] + 1
                    $extensionBytes[$extension] = [double]$extensionBytes[$extension] + $child.Length
                }
            } catch {
                if ($directory -eq $root) { $rootsDenied++ } else { $deniedFolders++ }
            }
        }
    }

    $status = 'ok'
    if ($rootsFound -eq 0) { $status = 'missing' }
    elseif ($rootsDenied -eq $rootsFound) { $status = 'denied' }

    [pscustomobject]@{
        kind          = $target.kind
        status        = $status
        sizeBytes     = $sizeBytes
        fileCount     = $fileCount
        olderThan30DaysCount = $oldCount
        olderThan30DaysBytes = $oldBytes
        topExtensions = @($extensionBytes.Keys | Sort-Object -Property { $extensionBytes[$_] } -Descending | Select-Object -First 10 | ForEach-Object {
            [pscustomobject]@{ extension = [string]$_; fileCount = $extensionCount[$_]; sizeBytes = $extensionBytes[$_] }
        })
        deniedFolders = $deniedFolders
        isTruncated   = $isTruncated
    }
}

[pscustomobject]@{
    drives  = $drives
    folders = @($folders)
} | ConvertTo-Json -Compress -Depth 5
