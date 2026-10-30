# PC Guardian AI - read-only. Samples CPU, memory, disk, GPU and network usage over a
# short window, using typed CIM performance classes only (counter paths are localized;
# class and property names are not). The first sample is a warm-up: formatted
# performance data often reads 0 on the first query in a new process.
# Per-process CPU is the change in each process's total CPU time across the window.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$sampleCount = 8
$intervalMs = 1000

$processors = @(Get-CimInstance -ClassName Win32_Processor -Property Name, NumberOfCores, NumberOfLogicalProcessors)
$os = Get-CimInstance -ClassName Win32_OperatingSystem -Property TotalVisibleMemorySize

$gpuAvailable = $true
try {
    $null = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name)
} catch {
    $gpuAvailable = $false
}

$cpuSecondsAtStart = @{}
foreach ($p in @(Get-Process)) {
    if ($null -ne $p.TotalProcessorTime) { $cpuSecondsAtStart[[string]$p.Id] = $p.TotalProcessorTime.TotalSeconds }
}

$samples = [System.Collections.Generic.List[object]]::new()
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$nextSampleAt = 0
for ($i = 0; $i -le $sampleCount; $i++) {
    # Each query costs ~300 ms; sleep only for what is left of the interval.
    $wait = $nextSampleAt - $stopwatch.ElapsedMilliseconds
    if ($wait -gt 0) { [System.Threading.Thread]::Sleep([int]$wait) }
    $nextSampleAt = $stopwatch.ElapsedMilliseconds + $intervalMs

    $cpu = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -Property PercentProcessorTime
    $memory = Get-CimInstance -ClassName Win32_OperatingSystem -Property FreePhysicalMemory
    $disks = @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name<>'_Total'" -Property Name, PercentIdleTime, CurrentDiskQueueLength)
    $nics = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface -Property Name, BytesTotalPersec, CurrentBandwidth)
    $engines = @()
    if ($gpuAvailable) {
        $engines = @(
            Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name, UtilizationPercentage |
                Where-Object { $_.UtilizationPercentage -gt 0 } |
                Group-Object -Property { $_.Name -replace '^.*_engtype_', '' } |
                ForEach-Object {
                    [pscustomobject]@{
                        type    = [string]$_.Name
                        percent = [double]($_.Group | Measure-Object -Property UtilizationPercentage -Sum).Sum
                    }
                }
        )
    }

    if ($i -eq 0) { continue }

    $samples.Add([pscustomobject]@{
        cpuPercent   = [double]$cpu.PercentProcessorTime
        freeMemoryKb = [double]$memory.FreePhysicalMemory
        disks        = @($disks | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; idlePercent = [double]$_.PercentIdleTime; queueLength = [double]$_.CurrentDiskQueueLength } })
        nics         = @($nics | Where-Object { $_.CurrentBandwidth -gt 0 } | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; bytesPerSec = [double]$_.BytesTotalPersec; bandwidthBitsPerSec = [double]$_.CurrentBandwidth } })
        gpuEngines   = $engines
    })
}
$elapsedMs = $stopwatch.ElapsedMilliseconds

$processes = @(Get-Process | Where-Object { $null -ne $_.TotalProcessorTime -and $_.Id -ne 0 } | ForEach-Object {
    $before = $cpuSecondsAtStart[[string]$_.Id]
    [pscustomobject]@{
        pid            = [int]$_.Id
        name           = [string]$_.ProcessName
        cpuSeconds     = [double]($_.TotalProcessorTime.TotalSeconds - [double]$before)
        isNew          = $null -eq $before
        workingSetBytes = [double]$_.WorkingSet64
    }
})
$byCpu = @($processes | Sort-Object -Property cpuSeconds -Descending | Select-Object -First 15)
$byMemory = @($processes | Sort-Object -Property workingSetBytes -Descending | Select-Object -First 15)
$top = @($byCpu + $byMemory | Sort-Object -Property pid -Unique)

[pscustomobject]@{
    cpu = [pscustomobject]@{
        name              = [string]$processors[0].Name
        physicalCores     = [int]($processors | Measure-Object -Property NumberOfCores -Sum).Sum
        logicalProcessors = [int]($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
    }
    totalMemoryKb = [double]$os.TotalVisibleMemorySize
    gpuAvailable  = $gpuAvailable
    elapsedMs     = $elapsedMs
    samples       = $samples
    processes     = $top
} | ConvertTo-Json -Compress -Depth 6
