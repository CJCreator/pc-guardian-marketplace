# PC Guardian AI - read-only. Lists signed device drivers with their class, provider and
# age in days. Age is a fact about the driver's date only; it says nothing about whether
# a newer driver exists. Runs alongside security.ps1 (this query alone takes seconds).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$result = $null
try {
    $now = [DateTime]::Now
    $result = [pscustomobject]@{
        status  = 'ok'
        drivers = @(Get-CimInstance -ClassName Win32_PnPSignedDriver -Property DeviceClass, DeviceName, DriverProviderName, DriverDate |
            Where-Object { $null -ne $_.DriverDate -and $_.DeviceName } |
            ForEach-Object {
                [pscustomobject]@{
                    deviceClass = [string]$_.DeviceClass
                    deviceName  = [string]$_.DeviceName
                    provider    = [string]$_.DriverProviderName
                    ageDays     = [int][Math]::Floor(($now - $_.DriverDate).TotalDays)
                }
            })
    }
} catch {
    $result = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

$result | ConvertTo-Json -Compress -Depth 4
