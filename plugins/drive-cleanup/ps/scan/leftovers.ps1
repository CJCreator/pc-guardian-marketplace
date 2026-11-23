# Drive Cleanup - read-only. Lists app-data folders (in Roaming, Local and
# Local\Programs) whose name matches no installed program, as possible leftovers
# of uninstalled software. Reads the uninstall entries in the registry (HKLM and
# HKCU) and this user's Store packages, and folder sizes and dates. Matching is by
# name only, so every result is a low-confidence suggestion for review. Links are
# not followed; nothing is opened, created or changed.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$minBytes = 10MB
$budgetMs = 8000
$maxFiles = 200000
$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory
$invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Get-Token([string]$text) {
    if ($null -eq $text) { return '' }
    return ($text.ToLowerInvariant() -replace '[^a-z0-9]', '')
}

# What is installed: names, publishers and install folders, as tokens.
$known = [System.Collections.Generic.List[string]]::new()
$uninstallKeys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$installedCount = 0
foreach ($key in $uninstallKeys) {
    try {
        foreach ($entry in @(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue)) {
            $installedCount++
            foreach ($field in @('DisplayName', 'Publisher', 'InstallLocation', 'DisplayIcon')) {
                $value = [string]$entry.$field
                if ($value) {
                    $known.Add((Get-Token $value))
                    if ($field -eq 'InstallLocation' -or $field -eq 'DisplayIcon') {
                        foreach ($part in $value.Split([char[]]@('\', '/', '"', ','))) { if ($part.Length -ge 3) { $known.Add((Get-Token $part)) } }
                    }
                }
            }
        }
    } catch {
        # A key that cannot be read adds nothing.
    }
}
try {
    foreach ($pkg in @(Get-AppxPackage -ErrorAction SilentlyContinue)) {
        $installedCount++
        $known.Add((Get-Token ([string]$pkg.Name)))
        $known.Add((Get-Token ([string]$pkg.Publisher)))
    }
} catch {
    # Store packages are optional evidence.
}
$knownText = ' ' + ($known -join ' ') + ' '

# Folders Windows and common runtimes own: never suggested.
$skip = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($n in @('Microsoft', 'Packages', 'Temp', 'Programs', 'ConnectedDevicesPlatform', 'D3DSCache', 'CrashDumps', 'Comms', 'PeerDistRepub', 'PlaceholderTileLogoFolder', 'Publishers', 'VirtualStore', 'History', 'Microsoft_Corporation', 'Adobe', 'Google', 'Mozilla', 'npm-cache', 'pip', 'Yarn', 'pnpm', 'pnpm-cache', 'NuGet', 'Docker', 'Code', 'Antigravity', 'techgramam-drive-cleanup', 'pc-guardian-ai', 'Intel', 'NVIDIA', 'NVIDIA Corporation', 'AMD', 'Apple', 'Sun', 'Oracle', 'IsolatedStorage', 'SquirrelTemp', 'fontconfig', 'cache', 'Application Data', 'Local Settings')) {
    [void]$skip.Add($n)
}

function Measure-Folder([string]$root) {
    $bytes = 0.0
    $count = 0
    $isTruncated = $false
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
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
                $bytes += $child.Length
                $count++
            }
        } catch {
            # Unreadable parts are left out of the size.
        }
    }
    return @{ bytes = $bytes; fileCount = $count; isTruncated = $isTruncated }
}

$parents = @([string]$env:APPDATA, [string]$env:LOCALAPPDATA, (Join-Path ([string]$env:LOCALAPPDATA) 'Programs'))
$folders = [System.Collections.Generic.List[object]]::new()
# Stops well before Drive Cleanup's 300 s limit, whatever the number of folders.
$overall = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($parent in $parents) {
    if (-not [System.IO.Directory]::Exists($parent)) { continue }
    try {
        $children = [System.IO.DirectoryInfo]::new($parent).GetDirectories()
    } catch {
        continue
    }
    foreach ($dir in $children) {
        if ($folders.Count -ge 300 -or $overall.ElapsedMilliseconds -ge 240000) { break }
        if (($dir.Attributes -band $reparsePoint) -ne 0) { continue }
        if ($skip.Contains($dir.Name) -or $dir.Name.StartsWith('.')) { continue }
        $token = Get-Token $dir.Name
        if ($token.Length -lt 3) { continue }
        if ($knownText.Contains($token)) { continue }
        $measured = Measure-Folder $dir.FullName
        if ($measured.bytes -lt $minBytes) { continue }
        $folders.Add([pscustomobject]@{
            path         = $dir.FullName
            bytes        = $measured.bytes
            fileCount    = $measured.fileCount
            lastWriteUtc = $dir.LastWriteTimeUtc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $invariant)
            isTruncated  = $measured.isTruncated
        })
    }
}

[pscustomobject]@{
    installedCount = $installedCount
    folders        = @($folders)
} | ConvertTo-Json -Compress -Depth 4
