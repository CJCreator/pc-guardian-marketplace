# Drive Cleanup - read-only. Reports the fixed drives (capacity, free space,
# file system, media type, health), this user's well-known folders, whether
# Storage Sense is on, and whether NTFS records last-access times. Reads
# settings and metadata only; nothing is created, changed or opened for writing.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# TEMP is often spelled with 8.3 short names (C:\Users\JOHNSM~1\...): spell each
# folder with its long name, so the paths compare with what the walk reports.
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

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)

# Media type and health of the disk behind each drive letter.
$diskByLetter = @{}
try {
    $partitions = @(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_Partition -Property DriveLetter, DiskNumber)
    $physical = @(Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_PhysicalDisk -Property DeviceId, MediaType, HealthStatus)
    foreach ($partition in $partitions) {
        $letter = [string]$partition.DriveLetter
        if ($letter -notmatch '^[A-Za-z]$') { continue }
        $disk = $physical | Where-Object { [string]$_.DeviceId -eq [string]$partition.DiskNumber } | Select-Object -First 1
        if ($null -ne $disk) { $diskByLetter[$letter.ToUpperInvariant() + ':'] = $disk }
    }
} catch {
    $diskByLetter = @{}
}

$healthNames = @{ 0 = 'Healthy'; 1 = 'Warning'; 2 = 'Unhealthy'; 5 = 'Unknown' }

$drives = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -Property DeviceID, VolumeName, FileSystem, Size, FreeSpace | ForEach-Object {
    $id = [string]$_.DeviceID
    $disk = $diskByLetter[$id]
    $media = $null
    $health = $null
    if ($null -ne $disk) {
        $media = [int]$disk.MediaType
        $code = [int]$disk.HealthStatus
        if ($healthNames.ContainsKey($code)) { $health = $healthNames[$code] } else { $health = [string]$code }
    }
    [pscustomobject]@{
        letter       = $id
        label        = [string]$_.VolumeName
        fileSystem   = [string]$_.FileSystem
        totalBytes   = [double]$_.Size
        freeBytes    = [double]$_.FreeSpace
        isSystem     = $id -eq $env:SystemDrive
        mediaType    = $media
        healthStatus = $health
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

$profilesRoot = Split-Path -Parent $env:USERPROFILE
try {
    $listValue = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -Name 'ProfilesDirectory'
    $expanded = [Environment]::ExpandEnvironmentVariables([string]$listValue.ProfilesDirectory)
    if ($expanded) { $profilesRoot = $expanded }
} catch {
    # Keep the parent of this user's profile.
}

# Storage Sense: value "01" is on/off, "2048" is how often it runs (days; 0 = when space is low).
$senseEnabled = $null
$senseCadence = $null
try {
    $policy = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\StorageSense\Parameters\StoragePolicy'
    if ($null -ne $policy.'01') { $senseEnabled = ([int]$policy.'01') -eq 1 }
    if ($null -ne $policy.'2048') { $senseCadence = [int]$policy.'2048' }
} catch {
    $senseEnabled = $false
}

# NtfsDisableLastAccessUpdate: the low bit set means last-access times are not updated.
$lastAccessRaw = $null
$lastAccessUpdated = $null
try {
    $fs = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'NtfsDisableLastAccessUpdate'
    # A DWORD reads as a signed Int32 (0x80000003 is negative): widen before masking.
    $value = [int64]$fs.NtfsDisableLastAccessUpdate
    $lastAccessRaw = [double]($value -band 4294967295)
    $lastAccessUpdated = ($value -band 1) -eq 0
} catch {
    $lastAccessUpdated = $null
}

$version = ''
try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -Property Caption, Version
    $version = ([string]$os.Caption + ' ' + [string]$os.Version).Trim()
} catch {
    $version = [string][Environment]::OSVersion.VersionString
}

[pscustomobject]@{
    isElevated     = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    windowsVersion = $version
    systemDrive    = [string]$env:SystemDrive
    systemRoot     = [string]$env:SystemRoot
    userProfile    = Get-LongPath $env:USERPROFILE
    profilesRoot   = Get-LongPath $profilesRoot
    appData        = Get-LongPath $env:APPDATA
    localAppData   = Get-LongPath $env:LOCALAPPDATA
    temp           = Get-LongPath $env:TEMP
    downloads      = Get-LongPath $downloads
    drives         = $drives
    storageSense   = [pscustomobject]@{ isEnabled = $senseEnabled; cadenceDays = $senseCadence }
    lastAccess     = [pscustomobject]@{ isUpdated = $lastAccessUpdated; rawValue = $lastAccessRaw }
} | ConvertTo-Json -Compress -Depth 4
