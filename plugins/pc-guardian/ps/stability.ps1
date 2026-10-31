# PC Guardian AI - read-only. Summarizes the last 7 days: uptime, Reliability Monitor
# records grouped by source and event id, the latest stability index, and critical and
# error events from the System and Application logs counted by provider. Event message
# text is never read or returned.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$windowDays = 7
$maxEvents = 5000
$since = (Get-Date).AddDays(-$windowDays)
$sinceDmtf = $since.ToUniversalTime().ToString('yyyyMMddHHmmss.000000+000')

$uptime = $null
try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime
    $uptime = [pscustomobject]@{ status = 'ok'; hours = ([DateTime]::Now - $os.LastBootUpTime).TotalHours }
} catch {
    $uptime = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

$reliability = $null
try {
    $records = @(Get-CimInstance -ClassName Win32_ReliabilityRecords -Filter "TimeGenerated >= '$sinceDmtf'" -Property SourceName, EventIdentifier)
    $metric = @(Get-CimInstance -ClassName Win32_ReliabilityStabilityMetrics -Filter "TimeGenerated >= '$sinceDmtf'" -Property SystemStabilityIndex, TimeGenerated) |
        Sort-Object -Property TimeGenerated -Descending | Select-Object -First 1
    $index = $null
    if ($null -ne $metric) { $index = [double]$metric.SystemStabilityIndex }
    $reliability = [pscustomobject]@{
        status         = 'ok'
        recordCount    = $records.Count
        stabilityIndex = $index
        groups         = @($records | Group-Object -Property SourceName, EventIdentifier | ForEach-Object {
            [pscustomobject]@{ source = [string]$_.Group[0].SourceName; eventId = [int]$_.Group[0].EventIdentifier; count = $_.Count }
        })
    }
} catch {
    $reliability = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

$events = $null
try {
    $list = @()
    try {
        $list = @(Get-WinEvent -FilterHashtable @{ LogName = 'System', 'Application'; Level = 1, 2; StartTime = $since } -MaxEvents $maxEvents)
    } catch {
        if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
    }
    $events = [pscustomobject]@{
        status        = 'ok'
        criticalCount = @($list | Where-Object { $_.Level -eq 1 }).Count
        errorCount    = @($list | Where-Object { $_.Level -eq 2 }).Count
        isTruncated   = $list.Count -ge $maxEvents
        topSources    = @($list | Group-Object -Property ProviderName | Sort-Object -Property Count -Descending | Select-Object -First 10 | ForEach-Object {
            [pscustomobject]@{ source = [string]$_.Name; count = $_.Count }
        })
    }
} catch {
    $events = [pscustomobject]@{ status = 'error'; category = $_.CategoryInfo.Category.ToString() }
}

[pscustomobject]@{
    windowDays  = $windowDays
    uptime      = $uptime
    reliability = $reliability
    events      = $events
} | ConvertTo-Json -Compress -Depth 5
