# PC Guardian AI - read-only. Reports the SHA-256 of the Node.js runtime shipped
# with the plugin (runtime\node.exe), so the mod can check it before it starts
# the browser dashboard's server. Takes no input: the path is fixed beside ps\.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$runtime = Join-Path $PSScriptRoot '..\runtime\node.exe'

if (Test-Path -LiteralPath $runtime -PathType Leaf) {
    $hash = Get-FileHash -LiteralPath $runtime -Algorithm SHA256
    [pscustomobject]@{
        status = 'ok'
        sha256 = $hash.Hash.ToLowerInvariant()
        bytes  = (Get-Item -LiteralPath $runtime).Length
    } | ConvertTo-Json -Compress
} else {
    [pscustomobject]@{ status = 'missing' } | ConvertTo-Json -Compress
}
