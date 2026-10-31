# Drive Cleanup - read-only. After a cleanup, checks that nothing it should not
# touch was affected:
#  - developer tools are still installed: node, npm, git, python, VS Code and
#    Antigravity, found on PATH, with the version read from the program file's
#    own version information (no program is started);
#  - development projects seen in the scan still exist with their .git folder;
#  - files Drive Cleanup moved to quarantine are still there, byte for byte
#    (their SHA-256 against the one recorded when they were moved).
# Input: DC_LIST_ID, the id of a list Drive Cleanup wrote in its data folder
# (runs\pending\<id>.json) naming the projects and quarantine runs to check.
# Nothing is created, changed or deleted.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$listId = [string]$env:DC_LIST_ID
if ($listId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Invalid list id.' }
$listPath = Join-Path ([string]$env:APPDATA) ('techgramam-drive-cleanup\runs\pending\' + $listId + '.json')
$list = [System.IO.File]::ReadAllText($listPath) | ConvertFrom-Json

function Get-Version([string]$file) {
    $v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($file)
    $text = [string]$v.ProductVersion
    if (-not $text) { $text = [string]$v.FileVersion }
    return $text.Trim()
}

$tools = foreach ($t in @(
        @{ id = 'node'; name = 'node' },
        @{ id = 'npm'; name = 'npm' },
        @{ id = 'git'; name = 'git' },
        @{ id = 'python'; name = 'python' },
        @{ id = 'vscode'; name = 'code' },
        @{ id = 'antigravity'; name = 'antigravity' }
    )) {
    $status = 'not_found'
    $version = ''
    try {
        $cmd = Get-Command -Name $t.name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $cmd) {
            $source = [string]$cmd.Source
            $status = 'ok'
            if ($t.id -eq 'npm') {
                $pkg = Join-Path (Split-Path -Parent $source) 'node_modules\npm\package.json'
                if ([System.IO.File]::Exists($pkg)) { $version = [string](([System.IO.File]::ReadAllText($pkg) | ConvertFrom-Json).version) }
            } elseif ($source -match '\.(cmd|bat)$') {
                # Editor launchers sit in bin\; the program is one folder up.
                $exeName = 'Code.exe'
                if ($t.id -eq 'antigravity') { $exeName = 'Antigravity.exe' }
                $exe = Join-Path (Split-Path -Parent (Split-Path -Parent $source)) $exeName
                if ([System.IO.File]::Exists($exe)) { $version = Get-Version $exe }
            } elseif ($source -match 'WindowsApps\\python') {
                $version = 'Microsoft Store alias (python may not be installed)'
            } else {
                $version = Get-Version $source
            }
        }
    } catch {
        $status = 'failed'
    }
    [pscustomobject]@{ id = $t.id; status = $status; version = [string]$version }
}

$projects = foreach ($p in @($list.projects)) {
    $path = [string]$p
    [pscustomobject]@{
        path   = $path
        exists = [System.IO.Directory]::Exists($path)
        hasGit = [System.IO.Directory]::Exists((Join-Path $path '.git'))
    }
}

$sha = [System.Security.Cryptography.SHA256]::Create()
$quarantine = foreach ($q in @($list.quarantine)) {
    $runId = [string]$q.runId
    $root = [string]$q.root
    $checked = 0
    $matched = 0
    $missing = 0
    $mismatched = 0
    $restorePath = Join-Path (Join-Path $root $runId) 'restore.json'
    if ([System.IO.File]::Exists($restorePath)) {
        $restore = [System.IO.File]::ReadAllText($restorePath) | ConvertFrom-Json
        foreach ($item in @($restore.items)) {
            if ([string]$item.state -ne 'quarantined') { continue }
            $checked++
            $dest = [string]$item.destination
            if ([bool]$item.isFolder) {
                if ([System.IO.Directory]::Exists($dest)) { $matched++ } else { $missing++ }
                continue
            }
            if (-not [System.IO.File]::Exists($dest)) { $missing++; continue }
            if (-not $item.sha256) { $matched++; continue }
            $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
            $stream = [System.IO.FileStream]::new($dest, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share, 1048576, [System.IO.FileOptions]::SequentialScan)
            try {
                $hex = ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
            } finally {
                $stream.Dispose()
            }
            if ($hex -eq [string]$item.sha256) { $matched++ } else { $mismatched++ }
        }
    } else {
        $missing++
    }
    [pscustomobject]@{ runId = $runId; checked = $checked; matched = $matched; missing = $missing; mismatched = $mismatched }
}
$sha.Dispose()

[pscustomobject]@{
    isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    tools      = @($tools)
    projects   = @($projects)
    quarantine = @($quarantine)
} | ConvertTo-Json -Compress -Depth 4
