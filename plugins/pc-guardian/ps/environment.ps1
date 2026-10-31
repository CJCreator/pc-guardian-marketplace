# PC Guardian AI - read-only. Reports the Windows version and whether this process is elevated.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$os = Get-CimInstance -ClassName Win32_OperatingSystem -Property Caption, Version, BuildNumber, LastBootUpTime
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())

[pscustomobject]@{
    osCaption      = [string]$os.Caption
    osVersion      = [string]$os.Version
    osBuild        = [int]$os.BuildNumber
    is64Bit        = [Environment]::Is64BitOperatingSystem
    uiCulture      = [string](Get-UICulture).Name
    psVersion      = $PSVersionTable.PSVersion.ToString()
    isElevated     = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    lastBootUpTime = $os.LastBootUpTime.ToUniversalTime().ToString('o')
} | ConvertTo-Json -Compress
