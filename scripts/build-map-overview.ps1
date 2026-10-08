param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$PmtilesCli
)

# Rebuilds the bundled low-detail Canada base map from a pinned Protomaps build and
# refuses to replace the checked-in archive unless the result matches its pin.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pmtilesCli = (Resolve-Path -LiteralPath $PmtilesCli).Path
$assetPath = Join-Path $repositoryRoot 'public\map\bootstrap\canada-overview.pmtiles'
$provenancePath = Join-Path $repositoryRoot 'public\map\bootstrap\canada-overview.provenance.json'
$expectedToolSha256 = '77043701c3584b2df0d0491beab8407370a3840025e1384a5eb177b99a69c1f4'

$provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
if ($provenance.schema -ne 'parkdex.bundled-map-overview/v2' -or
    $provenance.tool.sha256 -ne $expectedToolSha256 -or
    $provenance.artifact.bytes -gt $provenance.artifact.maxBytes) {
    throw 'The checked-in overview provenance does not match the pinned extraction contract.'
}
$toolSha256 = (Get-FileHash -LiteralPath $pmtilesCli -Algorithm SHA256).Hash.ToLowerInvariant()
if ($toolSha256 -ne $expectedToolSha256) {
    throw 'The PMTiles CLI does not match the pinned binary SHA-256.'
}

$bounds = ($provenance.extract.bounds | ForEach-Object { $_.ToString('0.0###', [System.Globalization.CultureInfo]::InvariantCulture) }) -join ','
$temporaryArchive = Join-Path ([System.IO.Path]::GetTempPath()) "parkdex-canada-overview-$([Guid]::NewGuid().ToString('N')).pmtiles"
try {
    & $pmtilesCli extract $provenance.source.url $temporaryArchive "--bbox=$bounds" "--minzoom=$($provenance.extract.minZoom)" "--maxzoom=$($provenance.extract.maxZoom)"
    if ($LASTEXITCODE -ne 0) { throw 'PMTiles overview extraction failed.' }
    & $pmtilesCli verify $temporaryArchive
    if ($LASTEXITCODE -ne 0) { throw 'PMTiles overview archive verification failed.' }

    $artifact = Get-Item -LiteralPath $temporaryArchive
    if ($artifact.Length -gt $provenance.artifact.maxBytes) { throw "Overview exceeds the $($provenance.artifact.maxBytes)-byte size budget." }
    $artifactSha256 = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($artifact.Length -ne $provenance.artifact.bytes -or $artifactSha256 -ne $provenance.artifact.sha256) {
        throw "The extracted overview ($($artifact.Length) bytes, $artifactSha256) differs from its pin; review the change and update the provenance before replacing it."
    }
    Move-Item -LiteralPath $temporaryArchive -Destination $assetPath -Force
    Write-Output "Pinned Canada overview: $assetPath ($($artifact.Length) bytes, $artifactSha256)"
} finally {
    if (Test-Path -LiteralPath $temporaryArchive -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryArchive -Force
    }
}
