# PC Guardian AI - CLEANUP ACTION. This script empties the Recycle Bin, permanently.
# It runs only after the person ticked "Recycle Bin" in a cleanup preview and
# confirmed, with cleanup turned on in Settings. It refuses if the Recycle Bin holds
# more than the preview counted, so nothing deleted after the preview is emptied
# without being shown first. It counts the Recycle Bin again afterwards and reports
# what was emptied.
# Input: PCG_EXPECTED_COUNT, the number of items the preview counted.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$expected = [int]$env:PCG_EXPECTED_COUNT
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$drives = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType = 3' -Property DeviceID | ForEach-Object { [string]$_.DeviceID })
$reparsePoint = [System.IO.FileAttributes]::ReparsePoint
$directoryFlag = [System.IO.FileAttributes]::Directory

$counts = @{}
$bytes = @{}
$refusal = $null
foreach ($phase in @('before', 'after')) {
    if ($phase -eq 'after') {
        if ($counts['before'] -gt $expected) {
            $refusal = 'changed'
        } elseif ($counts['before'] -gt 0) {
            Clear-RecycleBin -Force -ErrorAction SilentlyContinue
        }
    }
    $count = 0
    $size = 0.0
    foreach ($drive in $drives) {
        $root = $drive + '\$Recycle.Bin\' + $sid
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $pending = [System.Collections.Generic.Stack[string]]::new()
        $pending.Push($root)
        while ($pending.Count -gt 0) {
            $directory = $pending.Pop()
            try {
                foreach ($child in [System.IO.DirectoryInfo]::new($directory).EnumerateFileSystemInfos()) {
                    if (($child.Attributes -band $reparsePoint) -ne 0) { continue }
                    if (($child.Attributes -band $directoryFlag) -ne 0) {
                        $pending.Push($child.FullName)
                        continue
                    }
                    if ($child.Name.StartsWith('$I')) { continue }
                    $count++
                    $size += $child.Length
                }
            } catch {
                # A folder that cannot be read is not counted.
            }
        }
    }
    $counts[$phase] = $count
    $bytes[$phase] = $size
}

if ($null -ne $refusal) {
    [pscustomobject]@{
        status = 'refused'
        reason = 'changed'
        detail = 'The Recycle Bin holds more than when you checked, so it was not emptied. Check again to see what is in it now.'
    } | ConvertTo-Json -Compress
} else {
    [pscustomobject]@{
        status       = 'ok'
        removedCount = [Math]::Max(0, $counts['before'] - $counts['after'])
        removedBytes = [Math]::Max(0, $bytes['before'] - $bytes['after'])
        skippedCount = $counts['after']
        isTruncated  = $false
    } | ConvertTo-Json -Compress
}
