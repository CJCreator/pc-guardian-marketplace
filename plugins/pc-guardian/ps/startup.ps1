# PC Guardian AI - read-only. Lists what starts at sign-in: the registry Run keys, the
# Startup folders, and non-Microsoft scheduled tasks with a logon trigger. Adds each
# item's enabled state as Windows records it (StartupApproved) and details of its
# target file from the file's version resource. Nothing is launched or changed.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$registryNoise = @('PSPath', 'PSParentPath', 'PSChildName', 'PSDrive', 'PSProvider')
$entries = [System.Collections.Generic.List[object]]::new()
$errors = [System.Collections.Generic.List[object]]::new()

$runKeys = @(
    @{ source = 'registry_hkcu_run'; path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' },
    @{ source = 'registry_hklm_run'; path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' },
    @{ source = 'registry_hklm_run_wow64'; path = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run' }
)
foreach ($key in $runKeys) {
    try {
        if (-not (Test-Path -LiteralPath $key.path)) { continue }
        $values = Get-ItemProperty -LiteralPath $key.path
        foreach ($value in $values.PSObject.Properties) {
            if ($registryNoise -contains $value.Name) { continue }
            $entries.Add([pscustomobject]@{ source = $key.source; name = [string]$value.Name; fileName = $null; command = [string]$value.Value; taskEnabled = $null })
        }
    } catch {
        $errors.Add([pscustomobject]@{ source = $key.source; category = $_.CategoryInfo.Category.ToString() })
    }
}

$folders = @(
    @{ source = 'startup_folder_user'; path = [System.Environment]::GetFolderPath('Startup') },
    @{ source = 'startup_folder_common'; path = [System.Environment]::GetFolderPath('CommonStartup') }
)
foreach ($folder in $folders) {
    try {
        if (-not (Test-Path -LiteralPath $folder.path -PathType Container)) { continue }
        foreach ($file in @(Get-ChildItem -LiteralPath $folder.path -File -Force)) {
            if ($file.Name -eq 'desktop.ini') { continue }
            $entries.Add([pscustomobject]@{ source = $folder.source; name = [string]$file.BaseName; fileName = [string]$file.Name; command = [string]$file.FullName; taskEnabled = $null })
        }
    } catch {
        $errors.Add([pscustomobject]@{ source = $folder.source; category = $_.CategoryInfo.Category.ToString() })
    }
}

try {
    $tasks = @(Get-ScheduledTask | Where-Object {
        -not $_.TaskPath.StartsWith('\Microsoft\') -and
        @($_.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }).Count -gt 0
    })
    foreach ($task in $tasks) {
        $action = @($task.Actions | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskExecAction' }) | Select-Object -First 1
        if ($null -eq $action) { continue }
        # Some tasks store the program path already quoted; quote it exactly once.
        $command = ('"' + ([string]$action.Execute).Trim('"') + '" ' + [string]$action.Arguments).Trim()
        $entries.Add([pscustomobject]@{ source = 'scheduled_task_logon'; name = [string]$task.TaskName; fileName = $null; command = $command; taskEnabled = ([string]$task.State -ne 'Disabled') })
    }
} catch {
    $errors.Add([pscustomobject]@{ source = 'scheduled_task_logon'; category = $_.CategoryInfo.Category.ToString() })
}

$approvedKeys = @(
    @{ scope = 'hkcu_run'; path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' },
    @{ scope = 'hkcu_run32'; path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32' },
    @{ scope = 'hkcu_startup_folder'; path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder' },
    @{ scope = 'hklm_run'; path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' },
    @{ scope = 'hklm_run32'; path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32' },
    @{ scope = 'hklm_startup_folder'; path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder' }
)
$approved = [System.Collections.Generic.List[object]]::new()
foreach ($key in $approvedKeys) {
    try {
        if (-not (Test-Path -LiteralPath $key.path)) { continue }
        $values = Get-ItemProperty -LiteralPath $key.path
        foreach ($value in $values.PSObject.Properties) {
            if ($registryNoise -contains $value.Name) { continue }
            $bytes = $value.Value -as [byte[]]
            if ($null -eq $bytes -or $bytes.Length -eq 0) { continue }
            $approved.Add([pscustomobject]@{ scope = $key.scope; name = [string]$value.Name; firstByte = [int]$bytes[0] })
        }
    } catch {
        $errors.Add([pscustomobject]@{ source = ('approved_' + $key.scope); category = $_.CategoryInfo.Category.ToString() })
    }
}

$items = foreach ($entry in $entries) {
    $target = $null
    $expanded = [System.Environment]::ExpandEnvironmentVariables($entry.command).Trim()
    if ($expanded.StartsWith('"')) {
        $end = $expanded.IndexOf('"', 1)
        if ($end -gt 1) { $target = $expanded.Substring(1, $end - 1) }
    } else {
        $match = [regex]::Match($expanded, '^(.+?\.(exe|bat|cmd|com|lnk|vbs|js|ps1|scr))(\s|$)', 'IgnoreCase')
        if ($match.Success) { $target = $match.Groups[1].Value }
    }

    $details = $null
    if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {
        $file = Get-Item -LiteralPath $target -Force
        $details = [pscustomobject]@{
            sizeBytes   = [double]$file.Length
            company     = [string]$file.VersionInfo.CompanyName
            description = [string]$file.VersionInfo.FileDescription
        }
    }

    [pscustomobject]@{
        source       = $entry.source
        name         = $entry.name
        fileName     = $entry.fileName
        command      = $entry.command
        taskEnabled  = $entry.taskEnabled
        targetExists = $null -ne $details
        sizeBytes    = if ($details) { $details.sizeBytes } else { $null }
        company      = if ($details) { $details.company } else { $null }
        description  = if ($details) { $details.description } else { $null }
    }
}

# With no entries $items is $null, and @($null) is one null element, not an empty list.
[pscustomobject]@{
    items    = @($items | Where-Object { $null -ne $_ })
    approved = $approved
    errors   = $errors
} | ConvertTo-Json -Compress -Depth 5
