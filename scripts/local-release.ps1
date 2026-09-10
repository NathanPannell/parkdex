[CmdletBinding()]
param(
  [ValidateSet('Staging', 'Preview', 'Cleanup')]
  [string]$Mode = 'Staging',
  [int]$PullRequest = 0,
  [string]$CommitSha = '',
  [string]$StatePath = '',
  [string]$ReleaseId = '',
  [string]$HeadRef = '',
  [string]$AttestationPath = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$releaseArgs = @('scripts/local-release.mjs', '--mode', $Mode.ToLowerInvariant())
if ($PullRequest -gt 0) { $releaseArgs += @('--pr', "$PullRequest") }
if ($CommitSha) { $releaseArgs += @('--sha', $CommitSha) }
if ($StatePath) { $releaseArgs += @('--journal', $StatePath) }
if ($ReleaseId) { $releaseArgs += @('--release-id', $ReleaseId) }
if ($HeadRef) { $releaseArgs += @('--head-ref', $HeadRef) }
if ($AttestationPath) { $releaseArgs += @('--attestation', $AttestationPath) }
if ($Apply) { $releaseArgs += '--apply' }

node @releaseArgs
if ($LASTEXITCODE -ne 0) { throw "Local release command failed with exit $LASTEXITCODE." }
