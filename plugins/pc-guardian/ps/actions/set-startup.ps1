# PC Guardian AI - CLEANUP ACTION. This script turns one startup app off or back on,
# the way Task Manager does: it writes that app's value under StartupApproved, which
# Windows reads at sign-in. The app itself, its Run entry and its shortcut are not
# changed, so turning it back on restores it exactly. It runs only after the person
# ticked the app and confirmed (or pressed Turn back on). It refuses an app that is
# not in the startup source it names. Machine-wide apps need administrator rights.
# Inputs: PCG_STARTUP_SCOPE, PCG_STARTUP_NAME (the value or file name), PCG_STARTUP_STATE (off or on).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$scope = [string]$env:PCG_STARTUP_SCOPE
$name = [string]$env:PCG_STARTUP_NAME
$state = [string]$env:PCG_STARTUP_STATE
$approvedRoot = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\'
$approvedOf = @{
    hkcu_run            = 'HKCU:\' + $approvedRoot + 'Run'
    hklm_run            = 'HKLM:\' + $approvedRoot + 'Run'
    hklm_run32          = 'HKLM:\' + $approvedRoot + 'Run32'
    hkcu_startup_folder = 'HKCU:\' + $approvedRoot + 'StartupFolder'
    hklm_startup_folder = 'HKLM:\' + $approvedRoot + 'StartupFolder'
}
$runKeyOf = @{
    hkcu_run   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    hklm_run   = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
    hklm_run32 = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
}
$folderOf = @{
    hkcu_startup_folder = [System.Environment]::GetFolderPath('Startup')
    hklm_startup_folder = [System.Environment]::GetFolderPath('CommonStartup')
}

$approved = $approvedOf[$scope]
$exists = $false
if ($null -ne $runKeyOf[$scope]) {
    if (Test-Path -LiteralPath $runKeyOf[$scope]) {
        $exists = $null -ne (Get-ItemProperty -LiteralPath $runKeyOf[$scope]).PSObject.Properties[$name]
    }
} elseif ($null -ne $folderOf[$scope]) {
    $exists = Test-Path -LiteralPath (Join-Path $folderOf[$scope] $name) -PathType Leaf
}

if ($null -eq $approved -or ($state -ne 'off' -and $state -ne 'on')) {
    [pscustomobject]@{ status = 'refused'; reason = 'bad_input'; detail = 'Not a startup source or state PC Guardian changes.' } | ConvertTo-Json -Compress
} elseif (-not $exists) {
    [pscustomobject]@{ status = 'refused'; reason = 'not_found'; detail = 'That startup app is no longer there, so nothing was changed.' } | ConvertTo-Json -Compress
} else {
    # Task Manager's format: 3 = off, 2 = on, then the time it was turned off.
    $value = [byte[]](2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    if ($state -eq 'off') {
        $value = [byte[]](@(3, 0, 0, 0) + [System.BitConverter]::GetBytes([datetime]::UtcNow.ToFileTimeUtc()))
    }
    try {
        if (-not (Test-Path -LiteralPath $approved)) { $null = New-Item -Path $approved }
        Set-ItemProperty -LiteralPath $approved -Name $name -Value $value -Type Binary
        [pscustomobject]@{ status = 'ok'; state = $state } | ConvertTo-Json -Compress
    } catch [System.UnauthorizedAccessException], [System.Security.SecurityException] {
        [pscustomobject]@{ status = 'refused'; reason = 'needs_elevation'; detail = 'This startup app is set for all users; changing it needs administrator rights.' } | ConvertTo-Json -Compress
    }
}
