# Drive Cleanup - CLEANUP ACTION. This script deletes and moves files.
#
# It runs only after the person turned cleanup on, ticked items in Drive
# Cleanup's Review and confirmed. It acts only on the approved list Drive
# Cleanup wrote for this run, read by its run id from Drive Cleanup's own data
# folder, and only if that list was approved within the last 15 minutes.
#
# For each item, just before acting, it checks again (independently of the
# checks Drive Cleanup already made):
#  - the path is not protected (Windows, Program Files, ProgramData, other
#    profiles, credentials and keys, databases, browser and app data, Git data,
#    development projects, Drive Cleanup's own data and quarantine);
#  - it is not a link or junction, and it still exists;
#  - it has not changed since the scan (size and last-write time; for
#    duplicates, the SHA-256 too).
# Anything that fails a check is skipped and reported.
#
# Class A items (re-creatable: Temp, crash dumps, old app logs) are deleted.
# Everything else is MOVED to the quarantine folder, keeping its original path
# under <quarantine>\<run id>\, and recorded in restore.json so it can be put
# back. A move to another drive copies, verifies the copy's SHA-256 against the
# original, and only then removes the original. Files in use are skipped. The
# Recycle Bin is not used and never emptied.
#
# Input: DC_RUN_ID (set by Drive Cleanup).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$budgetMs = 540000
$ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory

function Write-Refusal([string]$reason, [string]$detail) {
    [pscustomobject]@{ status = 'refused'; reason = $reason; detail = $detail } | ConvertTo-Json -Compress
}

$runId = [string]$env:DC_RUN_ID
if ($runId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
    Write-Refusal 'bad_input' 'The run id is not valid, so nothing was changed.'
    exit 0
}
$dataFolder = Join-Path ([string]$env:APPDATA) 'techgramam-drive-cleanup'
$listPath = Join-Path $dataFolder ('runs\pending\' + $runId + '.json')
if (-not [System.IO.File]::Exists($listPath)) {
    Write-Refusal 'no_list' 'There is no approved list for this run, so nothing was changed.'
    exit 0
}
$list = [System.IO.File]::ReadAllText($listPath) | ConvertFrom-Json
$approvedAt = [DateTime]::Parse([string]$list.approvedAt, $invariant, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
$scanFinishedAt = [DateTime]::Parse([string]$list.scanFinishedAt, $invariant, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
$age = ([DateTime]::UtcNow - $approvedAt).TotalMinutes
if ([string]$list.runId -ne $runId -or $age -gt 15 -or $age -lt -1) {
    Write-Refusal 'stale' 'The approved list is not for this run or is more than 15 minutes old, so nothing was changed.'
    exit 0
}

# ------------------------------------------------------------------ guard
$userProfile = [System.IO.Path]::GetFullPath([string]$env:USERPROFILE).TrimEnd('\')
$profilesRoot = Split-Path -Parent $userProfile
$systemRoot = [System.IO.Path]::GetFullPath([string]$env:SystemRoot).TrimEnd('\')
$driveRoot = [string]$env:SystemDrive + '\'
$protectedRoots = [System.Collections.Generic.List[string]]::new()
foreach ($name in @('Program Files', 'Program Files (x86)', 'ProgramData', 'Recovery', 'System Volume Information', '$Recycle.Bin', '$WinREAgent', '$Windows.~BT', '$Windows.~WS', 'Boot', 'EFI', 'Config.Msi', 'Windows.old')) {
    $protectedRoots.Add((Join-Path $driveRoot $name))
}
$protectedRoots.Add($systemRoot)
$protectedRoots.Add($dataFolder)
foreach ($rel in @('AppData\Local\Packages', 'AppData\Roaming\Microsoft', 'AppData\Local\Microsoft\Windows', 'AppData\Local\Microsoft\Credentials', 'AppData\Local\Microsoft\Vault', 'AppData\Local\Microsoft\Edge\User Data', 'AppData\Local\Google\Chrome\User Data', 'AppData\Local\BraveSoftware\Brave-Browser\User Data', 'AppData\Roaming\Opera Software', 'AppData\Roaming\Mozilla', 'AppData\Roaming\Thunderbird', 'AppData\Local\Thunderbird', 'AppData\Local\Microsoft\Outlook', 'AppData\Local\Programs', '.vscode\extensions', '.cursor', '.antigravity')) {
    $protectedRoots.Add((Join-Path $userProfile $rel))
}
$editorCaches = @('Cache', 'CachedData', 'CachedExtensionVSIXs', 'Code Cache', 'GPUCache', 'logs')
$editors = @('Code', 'Code - Insiders', 'Cursor', 'Antigravity', 'VSCodium')
$protectedSegments = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($n in @('.ssh', '.gnupg', '.aws', '.azure', '.kube', '.gcloud', '.git', 'drive cleanup quarantine')) { [void]$protectedSegments.Add($n) }
$credentialNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($n in @('.npmrc', '.pypirc', '.git-credentials', '.netrc', '_netrc', '.pgpass')) { [void]$credentialNames.Add($n) }
$protectedExt = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($e in @('.pem', '.key', '.pfx', '.p12', '.crt', '.cer', '.ppk', '.kdbx', '.keychain', '.jks', '.keystore', '.db', '.sqlite', '.sqlite3', '.db-wal', '.db-shm', '.mdf', '.ldf', '.accdb', '.mdb', '.pst', '.ost', '.edb', '.sys', '.inf', '.cat')) { [void]$protectedExt.Add($e) }
$projectMarkers = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($n in @('.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile')) { [void]$projectMarkers.Add($n) }

function Test-Under([string]$path, [string]$root) {
    $r = $root.TrimEnd('\')
    return $path.Equals($r, $ignoreCase) -or $path.StartsWith($r + '\', $ignoreCase)
}

$markerCache = [System.Collections.Generic.Dictionary[string, bool]]::new([System.StringComparer]::OrdinalIgnoreCase)
function Test-HasMarker([string]$dir) {
    $known = $false
    if ($script:markerCache.TryGetValue($dir, [ref]$known)) { return $known }
    $found = $false
    try {
        foreach ($child in [System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos()) {
            if ($projectMarkers.Contains($child.Name) -or $child.Name.EndsWith('.sln', $ignoreCase) -or $child.Name.EndsWith('.csproj', $ignoreCase)) { $found = $true; break }
        }
    } catch {
        $found = $true
    }
    $script:markerCache[$dir] = $found
    return $found
}

function Test-InProject([string]$path) {
    # Climbs to, but not into, the profile or a top-level folder: those are never projects.
    $dir = Split-Path -Parent $path
    while ($dir -and $dir.Length -gt 3 -and -not $dir.Equals($userProfile, $ignoreCase) -and $dir.Split('\').Length -gt 2) {
        if (Test-HasMarker $dir) { return $true }
        $dir = Split-Path -Parent $dir
    }
    return $false
}

function Test-BuildCache([string]$path) {
    $leaf = [System.IO.Path]::GetFileName($path)
    $parentLeaf = [System.IO.Path]::GetFileName((Split-Path -Parent $path))
    return ($leaf -eq 'cache' -and $parentLeaf -eq '.next') -or ($leaf -eq '.vite' -and $parentLeaf -eq 'node_modules') -or $leaf -eq '.turbo' -or $leaf -eq '.parcel-cache'
}

# The reason a path must not be touched, or $null.
function Get-ProtectedReason([string]$path, [string]$category, [bool]$isFolder) {
    if ($path.Length -le 3 -or ($path.Split('\').Length -lt 3)) { return 'a drive or top-level folder' }
    if ($path.StartsWith('\\')) { return 'a network or device path' }
    if ($path.Equals($userProfile, $ignoreCase) -or $path.Equals($profilesRoot, $ignoreCase)) { return 'a profile folder' }
    if ((Test-Under $path $profilesRoot) -and -not (Test-Under $path $userProfile)) { return "another user's profile" }
    $isEditorCache = $false
    foreach ($ed in $editors) { foreach ($part in $editorCaches) { if (Test-Under $path (Join-Path (Join-Path ([string]$env:APPDATA) $ed) $part)) { $isEditorCache = $true } } }
    if (-not $isEditorCache) {
        foreach ($ed in $editors) { if (Test-Under $path (Join-Path ([string]$env:APPDATA) $ed)) { return 'editor data' } }
    }
    # OneDrive: moving a file out of it deletes it from the cloud and the person's other devices.
    if ((Test-Under $path $userProfile) -and -not $path.Equals($userProfile, $ignoreCase)) {
        $top = $path.Substring($userProfile.Length + 1).Split('\')[0]
        if ($top -match '^OneDrive( - .+)?$') { return 'a OneDrive folder' }
    }
    $isAppData = (Test-Under $path ([string]$env:APPDATA)) -or (Test-Under $path ([string]$env:LOCALAPPDATA))
    $isBrowserCache = $path -match '\\User Data\\(Default|Profile \d+)\\(Cache\\Cache_Data|Code Cache|GPUCache)(\\|$)'
    if ($isAppData -and -not $isBrowserCache -and $path -match '\\User Data(\\|$)') { return 'a browser or app profile' }
    $isWinCache = (Test-Under $path (Join-Path $userProfile 'AppData\Local\Microsoft\Windows\INetCache')) -or (Test-Under $path (Join-Path $userProfile 'AppData\Local\Microsoft\Windows\Explorer'))
    foreach ($root in $protectedRoots) {
        if ((Test-Under $path $root) -and -not $isWinCache) { return 'a protected location' }
    }
    foreach ($segment in $path.Split('\')) { if ($protectedSegments.Contains($segment)) { return 'a protected folder (' + $segment + ')' } }
    if (-not $isFolder) {
        $name = [System.IO.Path]::GetFileName($path).ToLowerInvariant()
        if ($protectedExt.Contains([System.IO.Path]::GetExtension($name))) { return 'a key, certificate, database or system file' }
        if ($credentialNames.Contains($name) -or ($name.Contains('token') -and $isAppData)) { return 'credentials' }
        if ($path.EndsWith('\.docker\config.json', $ignoreCase)) { return 'credentials' }
        if ($name -eq '.env' -or $name.StartsWith('.env.') -or $name -match '^id_(rsa|dsa|ecdsa|ed25519)' -or $name -match '^(credentials|secrets?)([._-]|$)') { return 'credentials' }
    }
    if ($category -eq 'build_cache') {
        if (-not (Test-BuildCache $path)) { return 'not a known build cache' }
    } elseif (Test-InProject $path) {
        return 'inside a development project'
    }
    return $null
}

# ------------------------------------------------------------------ helpers
$sha = [System.Security.Cryptography.SHA256]::Create()
function Get-Sha256([string]$path) {
    $share = [System.IO.FileShare]::Read
    $stream = [System.IO.FileStream]::new($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share, 1048576, [System.IO.FileOptions]::SequentialScan)
    try {
        return ([System.BitConverter]::ToString($script:sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
    }
}

function Get-TreeSize([string]$root) {
    $bytes = 0.0
    $hasLink = $false
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        $dir = $pending.Pop()
        foreach ($child in [System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos()) {
            if (($child.Attributes -band $script:reparsePoint) -ne 0) { $hasLink = $true; continue }
            if (($child.Attributes -band $script:directoryFlag) -ne 0) { $pending.Push($child.FullName); continue }
            $bytes += $child.Length
        }
    }
    return @{ bytes = $bytes; hasLink = $hasLink }
}

function Test-SameVolume([string]$a, [string]$b) {
    return [System.IO.Path]::GetPathRoot($a).Equals([System.IO.Path]::GetPathRoot($b), $ignoreCase)
}

# Copies one file across volumes, verifies it, then removes the original.
function Move-FileVerified([string]$src, [string]$dest, [string]$expected) {
    $info = [System.IO.FileInfo]::new($src)
    [System.IO.File]::Copy($src, $dest, $false)
    $copyHash = Get-Sha256 $dest
    if ($copyHash -ne $expected) {
        [System.IO.File]::Delete($dest)
        throw 'The copy did not match the original.'
    }
    [System.IO.File]::SetCreationTimeUtc($dest, $info.CreationTimeUtc)
    [System.IO.File]::SetLastWriteTimeUtc($dest, $info.LastWriteTimeUtc)
    try {
        $info.Delete()
    } catch {
        [System.IO.File]::Delete($dest)
        throw 'The original could not be removed (in use or read-only), so it was left in place.'
    }
}

# ------------------------------------------------------------------ space check
$quarantineRoot = [string]$list.quarantineRoot
$needsQuarantine = @($list.items | Where-Object { $_.action -eq 'quarantine' }).Count -gt 0
if ($needsQuarantine) {
    if ($quarantineRoot -notmatch '^[A-Za-z]:\\Drive Cleanup Quarantine$') {
        Write-Refusal 'bad_quarantine' 'The quarantine folder is not one Drive Cleanup uses, so nothing was changed.'
        exit 0
    }
    $drive = [System.IO.DriveInfo]::new($quarantineRoot.Substring(0, 2))
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or -not $drive.IsReady) {
        Write-Refusal 'bad_quarantine' 'The quarantine drive is not a ready, fixed drive, so nothing was changed.'
        exit 0
    }
    $crossBytes = 0.0
    foreach ($item in @($list.items)) {
        if ($item.action -eq 'quarantine' -and -not (Test-SameVolume ([string]$item.path) $quarantineRoot)) { $crossBytes += [double]$item.bytes }
    }
    $keep = [Math]::Max([double]$drive.TotalSize * 0.1, [double]10GB)
    if (([double]$drive.AvailableFreeSpace - $crossBytes) -lt $keep) {
        Write-Refusal 'no_space' ('Moving these items would leave ' + $quarantineRoot.Substring(0, 2) + ' with less than 10 % or 10 GB free, so nothing was changed.')
        exit 0
    }
}
# An empty root (nothing to quarantine) must not reach Join-Path: it would stop the script.
$runDir = $null
if ($needsQuarantine) {
    $runDir = Join-Path $quarantineRoot $runId
    foreach ($p in @($quarantineRoot, $runDir)) {
        if ([System.IO.Directory]::Exists($p) -and (([System.IO.File]::GetAttributes($p) -band $reparsePoint) -ne 0)) {
            Write-Refusal 'bad_quarantine' 'The quarantine folder is a link, so nothing was changed.'
            exit 0
        }
    }
    # The run folder is readable and writable by this user, SYSTEM and Administrators only:
    # a folder at a drive's root would otherwise let every local account read the files
    # and edit restore.json.
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $none = [System.Security.AccessControl.PropagationFlags]::None
    $full = [System.Security.AccessControl.FileSystemRights]::FullControl
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    foreach ($sid in @(
            [Security.Principal.WindowsIdentity]::GetCurrent().User,
            [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
            [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inherit, $none, $allow))
    }
    [void][System.IO.Directory]::CreateDirectory($quarantineRoot)
    if ([System.IO.Directory]::Exists($runDir)) {
        Write-Refusal 'bad_quarantine' 'This run already has a quarantine folder, so nothing was changed.'
        exit 0
    }
    [void][System.IO.Directory]::CreateDirectory($runDir, $acl)
}
$restore = [System.Collections.Generic.List[object]]::new()

function Save-Restore {
    if ($script:restore.Count -eq 0) { return }
    $doc = [pscustomobject]@{ runId = $script:runId; createdAt = [DateTime]::UtcNow.ToString('o'); root = $script:quarantineRoot; items = @($script:restore) }
    [System.IO.File]::WriteAllText((Join-Path $script:runDir 'restore.json'), ($doc | ConvertTo-Json -Depth 4))
}

# ------------------------------------------------------------------ items
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$results = [System.Collections.Generic.List[object]]::new()
$deletedBytes = 0.0
$quarantinedBytes = 0.0
$isTruncated = $false

foreach ($item in @($list.items)) {
    $id = [string]$item.id
    $path = [System.IO.Path]::GetFullPath([string]$item.path).TrimEnd('\')
    $isFolder = [bool]$item.isFolder
    $action = [string]$item.action
    $result = [ordered]@{ id = $id; status = 'skipped'; detail = ''; destination = $null; sha256 = $null; bytes = 0.0 }
    if ($stopwatch.ElapsedMilliseconds -ge $budgetMs) {
        $isTruncated = $true
        $result.detail = 'Time limit reached; not done. Run the cleanup again for the rest.'
        $results.Add([pscustomobject]$result)
        continue
    }
    try {
        $reason = Get-ProtectedReason $path ([string]$item.category) $isFolder
        if ($null -ne $reason) { throw ('Protected: ' + $reason + '.') }
        if ($isFolder) {
            if (-not [System.IO.Directory]::Exists($path)) { throw 'It no longer exists.' }
            $info = [System.IO.DirectoryInfo]::new($path)
        } else {
            if (-not [System.IO.File]::Exists($path)) { throw 'It no longer exists.' }
            $info = [System.IO.FileInfo]::new($path)
        }
        if (($info.Attributes -band $reparsePoint) -ne 0) { throw 'It is a link or junction.' }

        if (-not $isFolder) {
            $expectedTime = [DateTime]::Parse([string]$item.modifiedUtc, $invariant, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
            if ([double]$info.Length -ne [double]$item.bytes -or [Math]::Abs(($info.LastWriteTimeUtc - $expectedTime).TotalSeconds) -gt 2) {
                throw 'It changed since the scan.'
            }
        }

        if ($action -eq 'delete' -and -not $isFolder) {
            $len = [double]$info.Length
            $info.Delete()
            $deletedBytes += $len
            $result.status = 'deleted'
            $result.bytes = $len
        } elseif ($action -eq 'delete' -and $isFolder) {
            # Only files that already existed, unchanged, at the scan; then empty folders.
            $removed = 0.0
            $kept = 0
            $dirs = [System.Collections.Generic.List[string]]::new()
            $pending = [System.Collections.Generic.Stack[string]]::new()
            $pending.Push($path)
            while ($pending.Count -gt 0) {
                $dir = $pending.Pop()
                $dirs.Add($dir)
                try { $children = @([System.IO.DirectoryInfo]::new($dir).GetFileSystemInfos()) } catch { $kept++; continue }
                foreach ($child in $children) {
                    if (($child.Attributes -band $reparsePoint) -ne 0) { $kept++; continue }
                    if (($child.Attributes -band $directoryFlag) -ne 0) { $pending.Push($child.FullName); continue }
                    if ($child.LastWriteTimeUtc -gt $scanFinishedAt -or $child.CreationTimeUtc -gt $scanFinishedAt) { $kept++; continue }
                    try {
                        $len = [double]$child.Length
                        $child.Delete()
                        $removed += $len
                    } catch {
                        $kept++
                    }
                }
            }
            for ($i = $dirs.Count - 1; $i -ge 0; $i--) {
                try { [System.IO.Directory]::Delete($dirs[$i], $false) } catch { }
            }
            $deletedBytes += $removed
            $result.status = 'deleted'
            $result.bytes = $removed
            if ($kept -gt 0) { $result.detail = [string]$kept + ' files were in use or newer than the scan and were kept.' }
        } elseif ($action -eq 'quarantine') {
            # A move to another drive reads the data three times (hash, copy, hash of the copy).
            # At a cautious 60 MB/s, skip what cannot finish before Drive Cleanup stops waiting.
            if (-not (Test-SameVolume $path $quarantineRoot)) {
                $needMs = [double]$item.bytes * 3 / 60MB * 1000
                if ($stopwatch.ElapsedMilliseconds + $needMs -gt $budgetMs) {
                    if ($needMs -gt $budgetMs) { throw 'Too big to move to another drive in one go; move it yourself, or choose quarantine on the same drive in Settings.' }
                    $isTruncated = $true
                    throw 'Time limit reached; not done. Run the cleanup again for the rest.'
                }
            }
            $relative = $path.Substring(0, 1) + $path.Substring(2)
            $dest = Join-Path $runDir $relative
            if ([System.IO.File]::Exists($dest) -or [System.IO.Directory]::Exists($dest)) { throw 'Something is already at its quarantine place.' }
            [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $dest))
            if ($isFolder) {
                $tree = Get-TreeSize $path
                if ($tree.hasLink) { throw 'It contains a link or junction.' }
                $expected = [double]$item.bytes
                if ($tree.bytes -gt ($expected * 1.05 + 1MB) -or $tree.bytes -lt ($expected * 0.95 - 1MB)) { throw 'It changed since the scan.' }
                if (Test-SameVolume $path $dest) {
                    [System.IO.Directory]::Move($path, $dest)
                } else {
                    # Copy every file verified, then remove the originals and the empty folders.
                    $files = [System.Collections.Generic.List[string]]::new()
                    $dirs = [System.Collections.Generic.List[string]]::new()
                    $pending = [System.Collections.Generic.Stack[string]]::new()
                    $pending.Push($path)
                    while ($pending.Count -gt 0) {
                        $dir = $pending.Pop()
                        $dirs.Add($dir)
                        foreach ($child in [System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos()) {
                            if (($child.Attributes -band $directoryFlag) -ne 0) { $pending.Push($child.FullName) } else { $files.Add($child.FullName) }
                        }
                    }
                    foreach ($d in $dirs) { [void][System.IO.Directory]::CreateDirectory((Join-Path $dest $d.Substring($path.Length))) }
                    $copied = [System.Collections.Generic.List[string]]::new()
                    try {
                        foreach ($f in $files) {
                            $target = Join-Path $dest $f.Substring($path.Length)
                            [System.IO.File]::Copy($f, $target, $false)
                            $copied.Add($target)
                            if ((Get-Sha256 $f) -ne (Get-Sha256 $target)) { throw 'A copy did not match its original.' }
                            [System.IO.File]::SetLastWriteTimeUtc($target, [System.IO.File]::GetLastWriteTimeUtc($f))
                        }
                    } catch {
                        foreach ($t in $copied) { try { [System.IO.File]::Delete($t) } catch { } }
                        throw
                    }
                    # Remove the originals; if one cannot go, put back those already removed and undo the copy.
                    $removedFiles = [System.Collections.Generic.List[string]]::new()
                    try {
                        foreach ($f in $files) {
                            [System.IO.File]::SetAttributes($f, ([System.IO.File]::GetAttributes($f) -band (-bnot [System.IO.FileAttributes]::ReadOnly)))
                            [System.IO.File]::Delete($f)
                            $removedFiles.Add($f)
                        }
                    } catch {
                        $why = [string]$_.Exception.Message
                        foreach ($f in $removedFiles) {
                            $copy = Join-Path $dest $f.Substring($path.Length)
                            [System.IO.File]::Copy($copy, $f, $false)
                            [System.IO.File]::SetLastWriteTimeUtc($f, [System.IO.File]::GetLastWriteTimeUtc($copy))
                        }
                        foreach ($t in $copied) { try { [System.IO.File]::Delete($t) } catch { } }
                        try { [System.IO.Directory]::Delete($dest, $true) } catch { }
                        throw ('A file in it could not be removed, so the folder was left in place: ' + $why)
                    }
                    for ($i = $dirs.Count - 1; $i -ge 0; $i--) { try { [System.IO.Directory]::Delete($dirs[$i], $false) } catch { } }
                }
                $quarantinedBytes += $tree.bytes
                $result.bytes = $tree.bytes
            } else {
                $hash = Get-Sha256 $path
                if ($item.sha256 -and $hash -ne [string]$item.sha256) { throw 'Its contents changed since the scan.' }
                if (Test-SameVolume $path $dest) {
                    [System.IO.File]::Move($path, $dest)
                } else {
                    Move-FileVerified $path $dest $hash
                }
                $result.sha256 = $hash
                $result.bytes = [double]$item.bytes
                $quarantinedBytes += [double]$item.bytes
            }
            $result.status = 'quarantined'
            $result.destination = $dest
            $restore.Add([pscustomobject]@{ id = $id; original = $path; destination = $dest; isFolder = $isFolder; sha256 = $result.sha256; bytes = $result.bytes; category = [string]$item.category; state = 'quarantined' })
            # Saved after every move: if the run is stopped, everything moved so far can still be put back.
            Save-Restore
        } else {
            throw 'Unknown action.'
        }
    } catch {
        $result.status = 'skipped'
        $result.detail = [string]$_.Exception.Message
        if ($result.detail -match 'being used by another process') { $result.detail = 'It is in use.' }
        elseif ($result.detail -match 'denied' -and $result.detail -notmatch 'left in place') { $result.detail = 'Access was denied.' }
        elseif ($result.detail -match 'too long|PathTooLong') { $result.detail = 'Its path is too long for Windows PowerShell; move it yourself.' }
    }
    $results.Add([pscustomobject]$result)
}
Save-Restore
# Nothing was moved after all: remove the empty run folder made for it.
if ($null -ne $runDir -and $restore.Count -eq 0) { try { [System.IO.Directory]::Delete($runDir, $false) } catch { } }
$sha.Dispose()

[pscustomobject]@{
    status           = 'ok'
    runId            = $runId
    quarantineDir    = $(if ($restore.Count -gt 0) { $runDir } else { $null })
    deletedBytes     = $deletedBytes
    quarantinedBytes = $quarantinedBytes
    isTruncated      = $isTruncated
    items            = @($results)
} | ConvertTo-Json -Compress -Depth 4
