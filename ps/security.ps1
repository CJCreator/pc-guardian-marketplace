# PC Guardian AI - read-only. Reports Microsoft Defender status, other antivirus
# products registered with Windows Security Center, firewall profiles, BitLocker on
# the system drive, the last successful Windows Update install (from the System event
# log: no online search) and pending-reboot flags. Driver ages are in drivers.ps1,
# which runs alongside this script. Each check reports its own error category instead
# of failing the script (many need administrator rights).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$defender = $null
try {
    $mp = Get-MpComputerStatus
    $defender = [pscustomobject]@{
        status                    = 'ok'
        antivirusEnabled          = [bool]$mp.AntivirusEnabled
        realTimeProtectionEnabled = [bool]$mp.RealTimeProtectionEnabled
        signatureAgeDays          = [double]$mp.AntivirusSignatureAge
        quickScanAgeDays          = [double]$mp.QuickScanAge
        isTamperProtected         = $mp.IsTamperProtected
        runningMode               = [string]$mp.AMRunningMode
    }
} catch {
    $defender = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

$antivirus = $null
try {
    $antivirus = [pscustomobject]@{
        status   = 'ok'
        products = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -Property displayName, productState | ForEach-Object {
            [pscustomobject]@{ name = [string]$_.displayName; productState = [int]$_.productState }
        })
    }
} catch {
    $antivirus = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

$firewall = $null
try {
    $firewall = [pscustomobject]@{
        status   = 'ok'
        profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object {
            [pscustomobject]@{ name = [string]$_.Name; enabled = [string]$_.Enabled }
        })
    }
} catch {
    $firewall = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

$bitlocker = $null
try {
    $volume = Get-CimInstance -Namespace root/cimv2/Security/MicrosoftVolumeEncryption -ClassName Win32_EncryptableVolume -Filter "DriveLetter='$($env:SystemDrive)'" -Property ProtectionStatus
    $protection = $null
    if ($null -ne $volume) { $protection = [int]$volume.ProtectionStatus }
    $bitlocker = [pscustomobject]@{ status = 'ok'; protectionStatus = $protection }
} catch {
    $bitlocker = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

$updates = $null
try {
    $installed = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WindowsUpdateClient'; Id = 19 } -MaxEvents 1 -ErrorAction SilentlyContinue
    $daysAgo = $null
    if ($null -ne $installed) { $daysAgo = [int][Math]::Floor(([DateTime]::UtcNow - $installed.TimeCreated.ToUniversalTime()).TotalDays) }
    $updates = [pscustomobject]@{ status = 'ok'; lastSuccessfulInstallDaysAgo = $daysAgo }
} catch {
    $updates = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

$pendingReboot = $null
try {
    $reasons = @()
    if (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { $reasons += 'component_based_servicing' }
    if (Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { $reasons += 'windows_update' }
    $sessionManager = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager'
    if ($null -ne $sessionManager.PendingFileRenameOperations -and @($sessionManager.PendingFileRenameOperations).Count -gt 0) { $reasons += 'pending_file_rename' }
    $activeName = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName').ComputerName
    $pendingName = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName').ComputerName
    if ($activeName -ne $pendingName) { $reasons += 'computer_rename' }
    $pendingReboot = [pscustomobject]@{ status = 'ok'; reasons = @($reasons) }
} catch {
    $pendingReboot = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

[pscustomobject]@{
    defender      = $defender
    antivirus     = $antivirus
    firewall      = $firewall
    bitlocker     = $bitlocker
    updates       = $updates
    pendingReboot = $pendingReboot
} | ConvertTo-Json -Compress -Depth 5
