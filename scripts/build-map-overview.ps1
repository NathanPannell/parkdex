param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$SourceArchive,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$PmtilesCli
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceArchive = (Resolve-Path -LiteralPath $SourceArchive).Path
$pmtilesCli = (Resolve-Path -LiteralPath $PmtilesCli).Path
$assetPath = Join-Path $repositoryRoot 'public\map\bootstrap\island-overview.pmtiles'
$provenancePath = Join-Path $repositoryRoot 'public\map\bootstrap\island-overview.provenance.json'
$expectedSourceSha256 = 'b9e13d21f76ad52da76dc1ab2599e3b48c04879af4b91bf4fa3dd62baace4243'
$expectedSourceBytes = 95805433
$expectedToolSha256 = '77043701c3584b2df0d0491beab8407370a3840025e1384a5eb177b99a69c1f4'
$expectedArtifactSha256 = '53c1a1e0ec2cd80ffdfef98b3400aa9fd87a2ae55359256aa3fba10ff632e07f'
$expectedArtifactBytes = 1636725
$maxArtifactBytes = 2000000
$bounds = '-128.45,48.28,-123.25,50.92'

foreach ($requiredPath in @($sourceArchive, $pmtilesCli, $provenancePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required pinned map input is missing: $requiredPath"
    }
}

$sourceItem = Get-Item -LiteralPath $sourceArchive
$sourceSha256 = (Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceItem.Length -ne $expectedSourceBytes -or $sourceSha256 -ne $expectedSourceSha256) {
    throw 'The authoritative Vancouver Island PMTiles source does not match the pinned size and SHA-256.'
}
$toolSha256 = (Get-FileHash -LiteralPath $pmtilesCli -Algorithm SHA256).Hash.ToLowerInvariant()
if ($toolSha256 -ne $expectedToolSha256) {
    throw 'The PMTiles CLI does not match the pinned binary SHA-256.'
}

$provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
if ($provenance.schema -ne 'parkdex.bundled-map-overview/v1' -or
    $provenance.source.sha256 -ne $expectedSourceSha256 -or
    $provenance.tool.sha256 -ne $expectedToolSha256 -or
    $provenance.extract.maxZoom -ne 7 -or
    $provenance.artifact.sha256 -ne $expectedArtifactSha256 -or
    $provenance.artifact.bytes -ne $expectedArtifactBytes -or
    $provenance.artifact.bytes -gt $maxArtifactBytes) {
    throw 'The checked-in overview provenance does not match the pinned extraction contract.'
}
$toolVersion = (& $pmtilesCli version 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0 -or $toolVersion.Trim() -ne $provenance.tool.reportedVersion) {
    throw 'The PMTiles CLI version text differs from the recorded tool provenance.'
}

$sourceInfo = (& $pmtilesCli show $sourceArchive 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0 -or
    $sourceInfo -notmatch '(?m)^bounds: \(long: -128\.450000, lat: 48\.280000\) \(long: -123\.250000, lat: 50\.920000\)$' -or
    $sourceInfo -notmatch '(?m)^min zoom: 0$' -or
    $sourceInfo -notmatch '(?m)^max zoom: 14$' -or
    $sourceInfo -notmatch '(?m)^tile type: mvt$') {
    throw 'The source archive metadata differs from the recorded whole-island input.'
}

$temporaryArchive = Join-Path ([System.IO.Path]::GetTempPath()) "parkdex-island-overview-$([Guid]::NewGuid().ToString('N')).pmtiles"
try {
    & $pmtilesCli extract $sourceArchive $temporaryArchive "--bbox=$bounds" --minzoom=0 --maxzoom=7
    if ($LASTEXITCODE -ne 0) { throw 'PMTiles overview extraction failed.' }

    & $pmtilesCli verify $temporaryArchive
    if ($LASTEXITCODE -ne 0) { throw 'PMTiles overview archive verification failed.' }
    $outputInfo = (& $pmtilesCli show $temporaryArchive 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0 -or
        $outputInfo -notmatch '(?m)^bounds: \(long: -128\.450000, lat: 48\.280000\) \(long: -123\.250000, lat: 50\.920000\)$' -or
        $outputInfo -notmatch '(?m)^min zoom: 0$' -or
        $outputInfo -notmatch '(?m)^max zoom: 7$' -or
        $outputInfo -notmatch '(?m)^tile entries count: 22$') {
        throw 'The extracted archive does not cover the pinned island bounds and zoom range.'
    }

    $artifact = Get-Item -LiteralPath $temporaryArchive
    if ($artifact.Length -gt $maxArtifactBytes) { throw "Overview exceeds the $maxArtifactBytes-byte size budget." }
    $artifactSha256 = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($artifact.Length -ne $expectedArtifactBytes -or $artifactSha256 -ne $expectedArtifactSha256) {
        throw 'The extracted overview differs from its checked-in size and SHA-256 pin.'
    }

    if (Test-Path -LiteralPath $assetPath -PathType Leaf) {
        $existingSha256 = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($existingSha256 -ne $expectedArtifactSha256) {
            throw 'The existing bundled overview differs from the pinned artifact; preserve it and review the change before updating the pin.'
        }
    } else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $assetPath) -Force | Out-Null
        Move-Item -LiteralPath $temporaryArchive -Destination $assetPath
    }

    Write-Output "Pinned island overview: $assetPath"
    Write-Output "Bytes: $expectedArtifactBytes"
    Write-Output "SHA256: $expectedArtifactSha256"
    Write-Output 'Bounds: -128.45,48.28,-123.25,50.92; zooms 0-7; tile entries 22'
} finally {
    if (Test-Path -LiteralPath $temporaryArchive -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryArchive -Force
    }
}
