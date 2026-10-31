# Drive Cleanup - read-only. Measures space Windows manages itself, for
# recommendations only (Drive Cleanup never acts on any of it): the Windows
# Update download cache, Windows.old, the Windows Temp folder, memory dumps and
# kernel reports, the hibernation, page and swap files, this user's Recycle
# Bin, and restore point usage (that one needs administrator rights). Sizes and
# counts only; nothing is opened, created or changed.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$budgetMs = 15000
$maxFiles = 300000
$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$driveRoot = [string]$env:SystemDrive + '\'
$windir = [string]$env:SystemRoot

function Measure-Folder([string]$id, [string[]]$roots, [string]$label) {
    $bytes = 0.0
    $count = 0
    $found = 0
    $rootsDenied = 0
    $isTruncated = $false
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    foreach ($root in $roots) {
        if (-not [System.IO.Directory]::Exists($root)) { continue }
        $found++
        $pending = [System.Collections.Generic.Stack[string]]::new()
        $pending.Push($root)
        while ($pending.Count -gt 0) {
            if ($count -ge $script:maxFiles -or $stopwatch.ElapsedMilliseconds -ge $script:budgetMs) {
                $isTruncated = $true
                break
            }
            $directory = $pending.Pop()
            try {
                foreach ($child in [System.IO.DirectoryInfo]::new($directory).EnumerateFileSystemInfos()) {
                    if (($child.Attributes -band $script:reparsePoint) -ne 0) { continue }
                    if (($child.Attributes -band $script:directoryFlag) -ne 0) {
                        $pending.Push($child.FullName)
                        continue
                    }
                    if ($id -eq 'recycle_bin' -and $child.Name.StartsWith('$I')) { continue }
                    $bytes += $child.Length
                    $count++
                }
            } catch {
                if ($directory -eq $root) { $rootsDenied++ }
            }
        }
    }
    $status = 'ok'
    if ($found -eq 0) { $status = 'missing' }
    elseif ($rootsDenied -eq $found) { $status = 'denied' }
    return [pscustomobject]@{ id = $id; path = $label; status = $status; bytes = $bytes; fileCount = $count; isTruncated = $isTruncated }
}

function Measure-File([string]$id, [string]$path) {
    # Root system files are hidden and locked: list them through their folder, never open them.
    try {
        $folder = [System.IO.Path]::GetDirectoryName($path)
        $name = [System.IO.Path]::GetFileName($path)
        $match = @([System.IO.DirectoryInfo]::new($folder).GetFiles($name))
        if ($match.Count -eq 0) {
            return [pscustomobject]@{ id = $id; path = $path; status = 'missing'; bytes = 0; fileCount = 0; isTruncated = $false }
        }
        return [pscustomobject]@{ id = $id; path = $path; status = 'ok'; bytes = [double]$match[0].Length; fileCount = 1; isTruncated = $false }
    } catch {
        return [pscustomobject]@{ id = $id; path = $path; status = 'denied'; bytes = 0; fileCount = 0; isTruncated = $false }
    }
}

$sid = $identity.User.Value
$items = @(
    (Measure-Folder 'update_cache' @(Join-Path $windir 'SoftwareDistribution\Download') (Join-Path $windir 'SoftwareDistribution\Download')),
    (Measure-Folder 'windows_old' @(Join-Path $driveRoot 'Windows.old') (Join-Path $driveRoot 'Windows.old')),
    (Measure-Folder 'windows_temp' @(Join-Path $windir 'Temp') (Join-Path $windir 'Temp')),
    (Measure-Folder 'minidump' @(Join-Path $windir 'Minidump') (Join-Path $windir 'Minidump')),
    (Measure-File 'memory_dmp' (Join-Path $windir 'MEMORY.DMP')),
    (Measure-Folder 'live_kernel_reports' @(Join-Path $windir 'LiveKernelReports') (Join-Path $windir 'LiveKernelReports')),
    (Measure-File 'hiberfil' (Join-Path $driveRoot 'hiberfil.sys')),
    (Measure-File 'pagefile' (Join-Path $driveRoot 'pagefile.sys')),
    (Measure-File 'swapfile' (Join-Path $driveRoot 'swapfile.sys')),
    (Measure-Folder 'recycle_bin' @(Join-Path $driveRoot ('$Recycle.Bin\' + $sid)) (Join-Path $driveRoot ('$Recycle.Bin\' + $sid)))
)

$hibernation = $null
try {
    $power = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Power' -Name 'HibernateEnabled'
    $hibernation = ([int]$power.HibernateEnabled) -eq 1
} catch {
    $hibernation = $null
}

$shadow = [pscustomobject]@{ status = 'not_checked'; usedBytes = 0; maxBytes = 0; detail = 'Needs administrator rights.' }
if ($isElevated) {
    try {
        $used = 0.0
        $max = 0.0
        foreach ($s in @(Get-CimInstance -ClassName Win32_ShadowStorage -Property UsedSpace, MaxSpace)) {
            $used += [double]$s.UsedSpace
            $max += [double]$s.MaxSpace
        }
        $shadow = [pscustomobject]@{ status = 'ok'; usedBytes = $used; maxBytes = $max; detail = '' }
    } catch {
        $shadow = [pscustomobject]@{ status = 'not_checked'; usedBytes = 0; maxBytes = 0; detail = 'Restore point usage could not be read.' }
    }
}

[pscustomobject]@{
    isElevated    = $isElevated
    items         = $items
    hibernation   = [pscustomobject]@{ isEnabled = $hibernation }
    shadowStorage = $shadow
} | ConvertTo-Json -Compress -Depth 4
