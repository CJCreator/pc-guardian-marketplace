# PC Guardian AI - read-only. For Chrome, Edge, Brave and Firefox: whether a profile
# folder exists, how many profiles, the installed extensions (from extension manifests,
# or Firefox's add-on registry), and the browser's processes measured over 2 seconds.
# Never reads cookies, history, sessions, saved passwords, preferences or page content.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$chromium = @(
    @{ browser = 'chrome'; dataDir = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'); process = 'chrome' },
    @{ browser = 'edge'; dataDir = (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'); process = 'msedge' },
    @{ browser = 'brave'; dataDir = (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data'); process = 'brave' }
)
$firefoxProfiles = Join-Path $env:APPDATA 'Mozilla\Firefox\Profiles'
$processNames = @('chrome', 'msedge', 'brave', 'firefox')

# Browser process CPU over a short window.
$cpuAtStart = @{}
foreach ($p in @(Get-Process -Name $processNames -ErrorAction SilentlyContinue)) {
    if ($null -ne $p.TotalProcessorTime) { $cpuAtStart[[string]$p.Id] = $p.TotalProcessorTime.TotalSeconds }
}
$window = [System.Diagnostics.Stopwatch]::StartNew()
[System.Threading.Thread]::Sleep(2000)
$running = @(Get-Process -Name $processNames -ErrorAction SilentlyContinue)
$windowMs = $window.ElapsedMilliseconds

$processStats = @{}
foreach ($name in $processNames) {
    $mine = @($running | Where-Object { $_.ProcessName -eq $name })
    $cpuSeconds = 0.0
    foreach ($p in $mine) {
        $before = $cpuAtStart[[string]$p.Id]
        if ($null -ne $before -and $null -ne $p.TotalProcessorTime) { $cpuSeconds += $p.TotalProcessorTime.TotalSeconds - $before }
    }
    $processStats[$name] = [pscustomobject]@{
        count           = $mine.Count
        workingSetBytes = [double]($mine | Measure-Object -Property WorkingSet64 -Sum).Sum
        cpuSeconds      = $cpuSeconds
        windowMs        = $windowMs
    }
}

$browsers = [System.Collections.Generic.List[object]]::new()

foreach ($b in $chromium) {
    $extensions = [System.Collections.Generic.List[object]]::new()
    $unreadable = 0
    $profileCount = 0
    $dataDirExists = Test-Path -LiteralPath $b.dataDir -PathType Container
    if ($dataDirExists) {
        $profileDirs = @(Get-ChildItem -LiteralPath $b.dataDir -Directory | Where-Object {
            ($_.Name -eq 'Default' -or $_.Name -like 'Profile *') -and (Test-Path -LiteralPath (Join-Path $_.FullName 'Preferences') -PathType Leaf)
        })
        $profileCount = $profileDirs.Count
        foreach ($profileDir in $profileDirs) {
            $extensionRoot = Join-Path $profileDir.FullName 'Extensions'
            if (-not (Test-Path -LiteralPath $extensionRoot -PathType Container)) { continue }
            foreach ($idDir in @(Get-ChildItem -LiteralPath $extensionRoot -Directory)) {
                if ($idDir.Name -notmatch '^[a-p]{32}$') { continue }
                $versionDir = @(Get-ChildItem -LiteralPath $idDir.FullName -Directory | Sort-Object -Property Name -Descending) | Select-Object -First 1
                if ($null -eq $versionDir) { continue }
                try {
                    $manifest = Get-Content -LiteralPath (Join-Path $versionDir.FullName 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                    $name = [string]$manifest.name
                    if ($name -match '^__MSG_(.+)__$') {
                        $messageKey = $Matches[1]
                        $locale = [string]$manifest.default_locale
                        $messagesPath = Join-Path $versionDir.FullName ('_locales\' + $locale + '\messages.json')
                        if ($locale -and (Test-Path -LiteralPath $messagesPath -PathType Leaf)) {
                            $messages = Get-Content -LiteralPath $messagesPath -Raw -Encoding UTF8 | ConvertFrom-Json
                            $message = $messages.PSObject.Properties | Where-Object { $_.Name -eq $messageKey } | Select-Object -First 1
                            if ($null -ne $message) { $name = [string]$message.Value.message }
                        }
                    }
                    $extensions.Add([pscustomobject]@{
                        id                   = $idDir.Name
                        name                 = $name
                        version              = [string]$manifest.version
                        isEnabled            = $null
                        permissions          = @($manifest.permissions | ForEach-Object { [string]$_ })
                        hostPermissions      = @($manifest.host_permissions | ForEach-Object { [string]$_ })
                        contentScriptMatches = @($manifest.content_scripts | ForEach-Object { $_.matches } | ForEach-Object { [string]$_ })
                    })
                } catch {
                    $unreadable++
                }
            }
        }
    }
    $browsers.Add([pscustomobject]@{
        browser             = $b.browser
        dataDirExists       = $dataDirExists
        profileCount        = $profileCount
        extensions          = $extensions
        unreadableManifests = $unreadable
        processes           = $processStats[$b.process]
    })
}

$ffExtensions = [System.Collections.Generic.List[object]]::new()
$ffUnreadable = 0
$ffProfileCount = 0
$ffExists = Test-Path -LiteralPath $firefoxProfiles -PathType Container
if ($ffExists) {
    foreach ($profileDir in @(Get-ChildItem -LiteralPath $firefoxProfiles -Directory)) {
        $registry = Join-Path $profileDir.FullName 'extensions.json'
        if (-not (Test-Path -LiteralPath $registry -PathType Leaf)) { continue }
        $ffProfileCount++
        try {
            $addons = (Get-Content -LiteralPath $registry -Raw -Encoding UTF8 | ConvertFrom-Json).addons
            foreach ($addon in @($addons | Where-Object { $_.type -eq 'extension' -and $_.location -eq 'app-profile' })) {
                $ffExtensions.Add([pscustomobject]@{
                    id                   = [string]$addon.id
                    name                 = [string]$addon.defaultLocale.name
                    version              = [string]$addon.version
                    isEnabled            = [bool]$addon.active
                    permissions          = @($addon.userPermissions.permissions | ForEach-Object { [string]$_ })
                    hostPermissions      = @($addon.userPermissions.origins | ForEach-Object { [string]$_ })
                    contentScriptMatches = @()
                })
            }
        } catch {
            $ffUnreadable++
        }
    }
}
$browsers.Add([pscustomobject]@{
    browser             = 'firefox'
    dataDirExists       = $ffExists
    profileCount        = $ffProfileCount
    extensions          = $ffExtensions
    unreadableManifests = $ffUnreadable
    processes           = $processStats['firefox']
})

[pscustomobject]@{
    logicalProcessors = [System.Environment]::ProcessorCount
    browsers          = $browsers
} | ConvertTo-Json -Compress -Depth 6
