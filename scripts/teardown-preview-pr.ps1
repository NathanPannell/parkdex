[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateRange(1, 999999)]
  [int]$PullRequest,
  [string]$StatePath = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$repository = 'NathanPannell/parkdex'
$externalRoot = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Parkdex\preview-pr' } else { Join-Path ([System.IO.Path]::GetTempPath()) 'Parkdex\preview-pr' }
$activeDirectory = Join-Path $externalRoot 'active'
$activePath = Join-Path $activeDirectory "pr-$PullRequest.json"
$lockPath = Join-Path $activeDirectory "pr-$PullRequest.lock"
[System.IO.Directory]::CreateDirectory($activeDirectory) | Out-Null
try {
  $lifecycleLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
  throw "PR #$PullRequest has a preview create/teardown process in progress. Retry after that owner finishes."
}

try {
  $active = if (Test-Path -LiteralPath $activePath -PathType Leaf) { Get-Content -Raw -LiteralPath $activePath | ConvertFrom-Json } else { $null }
  $requestedJournal = if ($StatePath) { [System.IO.Path]::GetFullPath($StatePath) } else { $null }
  if ($active) {
    if ($active.schema -ne 'parkdex.preview-pr-active/v1' -or $active.repository -ne $repository -or $active.pullRequest -ne $PullRequest -or -not $active.releaseId -or -not $active.headSha -or -not $active.journalPath) {
      throw "The active record is not valid for PR #$PullRequest."
    }
    $activeJournal = [System.IO.Path]::GetFullPath($active.journalPath)
    if ($requestedJournal -and $requestedJournal -ne $activeJournal) {
      throw "The requested journal is not the active release for PR #$PullRequest. Refusing to claim a whole-PR cleanup."
    }
    $journalPath = $activeJournal
  } elseif ($requestedJournal) {
    $journalPath = $requestedJournal
  } else {
    throw "No active preview record exists for PR #$PullRequest; provide -StatePath with the exact journal for journal-only recovery."
  }
  if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) { throw "Preview journal does not exist: $journalPath" }

  $journal = Get-Content -Raw -LiteralPath $journalPath | ConvertFrom-Json
  if ($journal.schema -notin @('parkdex.local-release/v3', 'parkdex.local-release/v4') -or $journal.mode -ne 'preview' -or $journal.pullRequest -ne $PullRequest) {
    throw "The journal is not an owned preview for PR #$PullRequest."
  }
  $wholePrGate = $false
  if ($active) {
    if ($active.releaseId -ne $journal.releaseId -or $active.headSha -ne $journal.commitSha -or [System.IO.Path]::GetFullPath($active.journalPath) -ne [System.IO.Path]::GetFullPath($journalPath)) {
      throw "The active record and provider journal do not describe the same PR #$PullRequest release."
    }
    $wholePrGate = $true
  }

  if (-not $Apply) {
    [ordered]@{
      pullRequest = $PullRequest
      commitSha = $journal.commitSha
      status = $journal.status
      frontendUrl = $journal.frontendUrl
      railwayEnvironment = $journal.railwayEnvironment
      neonBranch = $journal.neonBranch
      journal = $journalPath
      activeRecordBound = $wholePrGate
      providerMutations = $false
    } | ConvertTo-Json -Depth 4
    Write-Output "teardown-command=pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest $PullRequest -StatePath `"$journalPath`" -Apply"
    return
  }

  $root = & git rev-parse --show-toplevel
  if ($LASTEXITCODE -ne 0) { throw 'Git repository discovery failed.' }
  Push-Location $root
  try {
    & pwsh -NoProfile -File scripts/local-release.ps1 -Mode Cleanup -StatePath $journalPath -Apply
    if ($LASTEXITCODE -ne 0) { throw "Preview teardown failed with exit $LASTEXITCODE. Retry this exact command; do not merge while cleanup is incomplete." }
  } finally {
    Pop-Location
  }

  $cleaned = Get-Content -Raw -LiteralPath $journalPath | ConvertFrom-Json
  if ($cleaned.status -ne 'cleaned' -or -not $cleaned.absenceVerifiedAt -or $cleaned.absenceVerification.consecutiveEmptyInventories -lt 3 -or $cleaned.absenceVerification.vercel.absent -ne $true -or $cleaned.absenceVerification.railway.absent -ne $true -or $cleaned.absenceVerification.neon.absent -ne $true) {
    throw 'Teardown returned without stable, authoritative absence proof for all preview resources. Do not merge.'
  }

  if ($wholePrGate -and (Test-Path -LiteralPath $activePath -PathType Leaf)) {
    $historyDirectory = Join-Path $externalRoot "history\pr-$PullRequest"
    [System.IO.Directory]::CreateDirectory($historyDirectory) | Out-Null
    $historyPath = Join-Path $historyDirectory "$($cleaned.releaseId)-cleaned-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')).json"
    [System.IO.File]::Move($activePath, $historyPath, $false)
  }

  Write-Output "teardown-preview-pr status=cleaned pr=$PullRequest sha=$($cleaned.commitSha)"
  Write-Output "absence-verified-at=$($cleaned.absenceVerifiedAt)"
  Write-Output "journal=$journalPath"
  if ($wholePrGate) {
    Write-Output 'merge-gate=Preview resources are stably absent. Reconfirm the PR head and complete browser evidence before merging to staging.'
  } else {
    Write-Output 'merge-gate=blocked-no-active-record. This exact journal is clean, but whole-PR absence was not proven; reconcile local preview history before merging.'
  }
} finally {
  $lifecycleLock.Dispose()
}
