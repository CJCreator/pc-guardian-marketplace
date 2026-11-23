# Drive Cleanup - ELEVATED CLEANUP ACTION. Runs as administrator.
#
# Never started from this file directly. hooks/elevate.ts starts Windows
# PowerShell with an inline bootstrap; Windows asks the person (UAC); the
# bootstrap, already elevated, reads this file, checks its SHA-256 against the
# value compiled into the plugin, and runs the checked text from memory, so the
# file cannot be swapped between the check and the run. It runs only after the
# person answered yes to a cleanup that named these tasks (PLAN.md §20).
#
# Tasks are fixed ids. Every path is built here from Windows' own folders;
# nothing from outside reaches a path or a command line. Nothing here touches
# the registry, user files, Windows.old or restore points, or removes updates
# (no /ResetBase). Files in use are skipped. Links are never followed.
#
# Input: -Tasks, a list of task ids. Output: one JSON object.
param([string[]]$Tasks)
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    return ([pscustomobject]@{ status = 'refused'; reason = 'not_elevated'; detail = 'Not running as administrator.' } | ConvertTo-Json -Compress)
}

$known = @('windows_temp', 'memory_dumps', 'windows_update_cache', 'delivery_optimization', 'component_store', 'hibernation_reduce')
foreach ($t in $Tasks) {
    if ($known -notcontains $t) {
        return ([pscustomobject]@{ status = 'refused'; reason = 'unknown_task'; detail = "Unknown task: $t" } | ConvertTo-Json -Compress)
    }
}

$windir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$systemDrive = [IO.Path]::GetPathRoot($windir)
$reparse = [IO.FileAttributes]::ReparsePoint
$directoryFlag = [IO.FileAttributes]::Directory
$budget = [Diagnostics.Stopwatch]::StartNew()  # read by the functions below through scope
$budgetMs = 20 * 60 * 1000

function New-Result([string]$id) {
    return [ordered]@{ id = $id; status = 'done'; removedBytes = 0.0; removedCount = 0; skippedCount = 0; detail = '' }
}

$trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')

# True when Windows or an administrator owns the folder: a folder a standard user
# made (in Windows\Temp anyone can) could be swapped for a junction while this
# elevated script works in it, so it is never entered.
function Test-TrustedFolder([string]$path) {
    try {
        $owner = [IO.Directory]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
        return $trustedOwners -contains $owner
    } catch { return $false }
}

# Deletes files under $root (never $root itself) last written before $before
# whose name matches $pattern. Skips links, files in use and anything it cannot
# delete. Removes subfolders it emptied. With $trustedOnly, enters only folders
# Windows or an administrator owns.
function Remove-Files($result, [string]$root, [string]$pattern, [datetime]$before, [bool]$recurse, [bool]$trustedOnly = $false) {
    if (-not [IO.Directory]::Exists($root)) { $result.status = 'missing'; return }
    $rootInfo = [IO.DirectoryInfo]::new($root)
    if (($rootInfo.Attributes -band $reparse) -ne 0) {
        $result.status = 'skipped'; $result.detail = "$root is a link; not followed."; return
    }
    $folders = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        if ($budget.ElapsedMilliseconds -ge $budgetMs) { $result.detail = 'Stopped at the time limit.'; break }
        $dir = $pending.Pop()
        # Checked again just before entering: it may have become a link since it was listed.
        if ($dir -ne $root) {
            try { if (([IO.File]::GetAttributes($dir) -band $reparse) -ne 0) { $result.skippedCount++; continue } } catch { continue }
            if ($trustedOnly -and -not (Test-TrustedFolder $dir)) { $result.skippedCount++; continue }
        }
        try { $children = [IO.DirectoryInfo]::new($dir).GetFileSystemInfos() } catch { $result.skippedCount++; continue }
        foreach ($child in $children) {
            if (($child.Attributes -band $reparse) -ne 0) { continue }
            if (($child.Attributes -band $directoryFlag) -ne 0) {
                if ($recurse -and (-not $trustedOnly -or (Test-TrustedFolder $child.FullName))) { $pending.Push($child.FullName); $folders.Add($child.FullName) }
                continue
            }
            if ($child.Name -notlike $pattern) { continue }
            if ($child.LastWriteTimeUtc -ge $before) { continue }
            try {
                $length = $child.Length
                if (($child.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { $child.Attributes = [IO.FileAttributes]::Normal }
                $child.Delete()
                $result.removedBytes += $length
                $result.removedCount++
            } catch { $result.skippedCount++ }
        }
    }
    # Deepest first; only folders now empty.
    foreach ($folder in ($folders | Sort-Object { $_.Length } -Descending)) {
        try {
            $info = [IO.DirectoryInfo]::new($folder)
            if (($info.Attributes -band $reparse) -eq 0 -and @($info.GetFileSystemInfos()).Count -eq 0) { $info.Delete() }
        } catch { }
    }
}

function Remove-OneFile($result, [string]$path) {
    if (-not [IO.File]::Exists($path)) { return }
    $info = [IO.FileInfo]::new($path)
    if (($info.Attributes -band $reparse) -ne 0) { $result.skippedCount++; return }
    try {
        $length = $info.Length
        $info.Delete()
        $result.removedBytes += $length
        $result.removedCount++
    } catch { $result.skippedCount++ }
}

function Get-FolderBytes([string]$root) {
    if (-not [IO.Directory]::Exists($root)) { return 0.0 }
    $total = 0.0
    try {
        foreach ($f in [IO.DirectoryInfo]::new($root).EnumerateFiles('*', [IO.SearchOption]::AllDirectories)) { $total += $f.Length }
    } catch { }
    return $total
}

function Get-FreeBytes { return [double]([IO.DriveInfo]::new($systemDrive).AvailableFreeSpace) }

$results = @()
$now = [DateTime]::UtcNow
foreach ($task in $Tasks) {
    $r = New-Result $task
    try {
        switch ($task) {
            'windows_temp' {
                Remove-Files $r (Join-Path $windir 'Temp') '*' $now.AddDays(-7) $true $true
            }
            'memory_dumps' {
                Remove-OneFile $r (Join-Path $windir 'MEMORY.DMP')
                $mini = New-Result 'x'; Remove-Files $mini (Join-Path $windir 'Minidump') '*.dmp' $now $false
                $live = New-Result 'x'; Remove-Files $live (Join-Path $windir 'LiveKernelReports') '*.dmp' $now $true
                foreach ($part in @($mini, $live)) {
                    $r.removedBytes += $part.removedBytes; $r.removedCount += $part.removedCount; $r.skippedCount += $part.skippedCount
                }
            }
            'windows_update_cache' {
                if (@(Get-Process -Name 'TiWorker' -ErrorAction SilentlyContinue).Count -gt 0) {
                    $r.status = 'skipped'; $r.detail = 'Windows is installing updates now. Try again after it finishes and the PC restarts.'
                    break
                }
                $service = Get-Service -Name 'wuauserv'
                $wasRunning = $service.Status -eq 'Running'
                try {
                    if ($wasRunning) {
                        Stop-Service -Name 'wuauserv' -Force
                        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
                    }
                    Remove-Files $r (Join-Path $windir 'SoftwareDistribution\Download') '*' $now $true
                } finally {
                    if ($wasRunning) { Start-Service -Name 'wuauserv' -ErrorAction SilentlyContinue }
                }
            }
            'delivery_optimization' {
                if ($null -eq (Get-Command -Name 'Delete-DeliveryOptimizationCache' -ErrorAction SilentlyContinue)) {
                    $r.status = 'skipped'; $r.detail = 'This version of Windows has no Delivery Optimization cleanup command.'
                    break
                }
                $folder = Join-Path $windir 'ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache'
                $before = Get-FolderBytes $folder
                Delete-DeliveryOptimizationCache -Force | Out-Null
                $r.removedBytes = [Math]::Max(0.0, $before - (Get-FolderBytes $folder))
            }
            'component_store' {
                $freeBefore = Get-FreeBytes
                $dism = Join-Path $windir 'System32\Dism.exe'
                $p = Start-Process -FilePath $dism -ArgumentList @('/Online', '/Cleanup-Image', '/StartComponentCleanup', '/NoRestart') -Wait -PassThru -WindowStyle Hidden
                if ($p.ExitCode -ne 0) { $r.status = 'failed'; $r.detail = "DISM exited with code $($p.ExitCode)." }
                $r.removedBytes = [Math]::Max(0.0, (Get-FreeBytes) - $freeBefore)
            }
            'hibernation_reduce' {
                $hiber = Join-Path $systemDrive 'hiberfil.sys'
                $before = 0.0
                if ([IO.File]::Exists($hiber)) { $before = [double]([IO.FileInfo]::new($hiber).Length) }
                $powercfg = Join-Path $windir 'System32\powercfg.exe'
                $p = Start-Process -FilePath $powercfg -ArgumentList @('/hibernate', '/type', 'reduced') -Wait -PassThru -WindowStyle Hidden
                if ($p.ExitCode -ne 0) { $r.status = 'failed'; $r.detail = "powercfg exited with code $($p.ExitCode)." }
                $after = 0.0
                if ([IO.File]::Exists($hiber)) { $after = [double]([IO.FileInfo]::new($hiber).Length) }
                $r.removedBytes = [Math]::Max(0.0, $before - $after)
                $r.detail = 'Undo: powercfg /hibernate /type full (administrator).'
            }
        }
    } catch {
        $r.status = 'failed'
        $r.detail = ([string]$_.Exception.Message).Substring(0, [Math]::Min(200, ([string]$_.Exception.Message).Length))
    }
    $results += [pscustomobject]$r
}

return ([pscustomobject]@{ status = 'ok'; tasks = @($results) } | ConvertTo-Json -Compress -Depth 4)
