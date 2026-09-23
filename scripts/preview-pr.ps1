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

function Invoke-NativeText {
  param([string]$Command, [string[]]$Arguments, [string]$Label)
  $output = & $Command @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit $LASTEXITCODE.`n$($output -join [Environment]::NewLine)" }
  return ($output -join [Environment]::NewLine).Trim()
}

function Write-NewJsonFile {
  param([string]$Path, [object]$Value)
  $directory = Split-Path -Parent $Path
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}

function Write-AtomicJsonFile {
  param([string]$Path, [object]$Value)
  $temporary = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::Move($temporary, $Path, $true)
}

function Archive-ActivePreviewRecord {
  param([string]$ActivePath, [string]$ExternalRoot, [int]$PrNumber, [object]$Record, [string]$Reason)
  $historyDirectory = Join-Path $ExternalRoot "history\pr-$PrNumber"
  [System.IO.Directory]::CreateDirectory($historyDirectory) | Out-Null
  $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $historyPath = Join-Path $historyDirectory "$($Record.releaseId)-$Reason-$timestamp.json"
  [System.IO.File]::Move($ActivePath, $historyPath, $false)
}

$root = Invoke-NativeText 'git' @('rev-parse', '--show-toplevel') 'Git repository discovery'
$lifecycleLock = $null
Push-Location $root
try {
  if (Invoke-NativeText 'git' @('status', '--porcelain') 'Git worktree check') { throw 'Preview creation requires a clean worktree.' }
  $origin = Invoke-NativeText 'git' @('remote', 'get-url', 'origin') 'Git origin check'
  if ($origin -notmatch '^(?:https://github\.com/|git@github\.com:)(?:NathanPannell/parkdex)(?:\.git)?$') { throw 'Origin does not match NathanPannell/parkdex.' }

  $prJson = Invoke-NativeText 'gh' @('pr', 'view', "$PullRequest", '--repo', $repository, '--json', 'number,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid') 'GitHub pull request lookup'
  $pr = $prJson | ConvertFrom-Json
  if ($pr.number -ne $PullRequest -or $pr.state -ne 'OPEN' -or $pr.isDraft -ne $true -or $pr.isCrossRepository -ne $false -or $pr.baseRefName -ne 'staging') {
    throw 'Preview creation requires an open, same-repository draft PR targeting staging.'
  }
  if ($pr.headRefName -notmatch '^[A-Za-z0-9._/-]+$' -or $pr.headRefName.StartsWith('/') -or $pr.headRefName.Contains('..') -or $pr.headRefOid -notmatch '^[0-9a-f]{40}$') {
    throw 'The draft PR head identity is unsafe or incomplete.'
  }

  Invoke-NativeText 'git' @('fetch', '--no-tags', 'origin', '+refs/heads/staging:refs/remotes/origin/staging', "+refs/heads/$($pr.headRefName):refs/remotes/origin/$($pr.headRefName)") 'Git source refresh' | Out-Null
  $harnessSha = Invoke-NativeText 'git' @('rev-parse', 'HEAD') 'Harness revision lookup'
  $remoteStagingSha = Invoke-NativeText 'git' @('rev-parse', 'refs/remotes/origin/staging') 'Remote staging revision lookup'
  $remoteHeadSha = Invoke-NativeText 'git' @('rev-parse', "refs/remotes/origin/$($pr.headRefName)") 'Remote PR revision lookup'
  if ($harnessSha -ne $remoteStagingSha) { throw 'Preview creation must run from a clean checkout at the current origin/staging revision.' }
  if ($remoteHeadSha -ne $pr.headRefOid) { throw 'The fetched feature branch no longer matches the draft PR head.' }

  $releaseId = [guid]::NewGuid().ToString()
  $externalRoot = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Parkdex\preview-pr' } else { Join-Path ([System.IO.Path]::GetTempPath()) 'Parkdex\preview-pr' }
  $journalPath = if ($StatePath) { [System.IO.Path]::GetFullPath($StatePath) } else { Join-Path $externalRoot "journals\pr-$PullRequest\$releaseId.json" }
  $evidenceDirectory = Join-Path $externalRoot "evidence\pr-$PullRequest"
  $attestationPath = Join-Path $evidenceDirectory "$releaseId-merge-candidate.json"
  $localEvidencePath = Join-Path $evidenceDirectory "$releaseId-local-ci.json"
  $activePath = Join-Path $externalRoot "active\pr-$PullRequest.json"
  $lockPath = Join-Path $externalRoot "active\pr-$PullRequest.lock"

  if (-not $Apply) {
    & pwsh -NoProfile -File scripts/local-release.ps1 -Mode Preview -PullRequest $PullRequest -CommitSha $pr.headRefOid -ReleaseId $releaseId -StatePath $journalPath
    if ($LASTEXITCODE -ne 0) { throw "Preview plan failed with exit $LASTEXITCODE." }
    Write-Output 'preview-pr plan=ready provider-mutations=false validation=not-run'
    Write-Output "preview-pr apply-command=pwsh -File scripts/preview-pr.ps1 -PullRequest $PullRequest -Apply"
    return
  }

  [System.IO.Directory]::CreateDirectory((Split-Path -Parent $activePath)) | Out-Null
  try {
    $lifecycleLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    throw "PR #$PullRequest already has a preview create/teardown process in progress. Retry after that owner finishes."
  }
  if (Test-Path -LiteralPath $activePath -PathType Leaf) {
    $existing = Get-Content -Raw -LiteralPath $activePath | ConvertFrom-Json
    if ($existing.schema -ne 'parkdex.preview-pr-active/v1' -or $existing.repository -ne $repository -or $existing.pullRequest -ne $PullRequest -or -not $existing.releaseId -or -not $existing.journalPath) {
      throw "PR #$PullRequest has an invalid active preview record; recover it manually before continuing."
    }
    if (Test-Path -LiteralPath $existing.journalPath -PathType Leaf) {
      $existingJournal = Get-Content -Raw -LiteralPath $existing.journalPath | ConvertFrom-Json
      $existingClean = $existingJournal.pullRequest -eq $PullRequest -and $existingJournal.releaseId -eq $existing.releaseId -and $existingJournal.commitSha -eq $existing.headSha -and $existingJournal.status -eq 'cleaned' -and $existingJournal.absenceVerification.vercel.absent -eq $true -and $existingJournal.absenceVerification.railway.absent -eq $true -and $existingJournal.absenceVerification.neon.absent -eq $true
      if (-not $existingClean) { throw "PR #$PullRequest already has an active local preview record at $($existing.journalPath). Tear it down before creating another." }
      Archive-ActivePreviewRecord $activePath $externalRoot $PullRequest $existing 'cleaned'
    } elseif ($existing.status -eq 'validating') {
      Archive-ActivePreviewRecord $activePath $externalRoot $PullRequest $existing 'abandoned-no-journal'
    } else {
      throw "PR #$PullRequest has an active preview record whose journal is missing. Recover it manually before continuing."
    }
  }
  $active = [ordered]@{
    schema = 'parkdex.preview-pr-active/v1'
    repository = $repository
    pullRequest = $PullRequest
    releaseId = $releaseId
    headRef = $pr.headRefName
    headSha = $pr.headRefOid
    baseSha = $harnessSha
    journalPath = $journalPath
    status = 'validating'
    processId = $PID
    owner = "$([Environment]::UserName)@$([Environment]::MachineName)"
    taskId = if ($env:CODEX_THREAD_ID) { $env:CODEX_THREAD_ID } else { $null }
    createdAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-NewJsonFile $activePath $active

  try {
    [System.IO.Directory]::CreateDirectory($evidenceDirectory) | Out-Null
    & node scripts/merge-candidate.mjs --base origin/staging --head $pr.headRefOid --head-ref $pr.headRefName --suite all --output $attestationPath --local-output $localEvidencePath
    if ($LASTEXITCODE -ne 0) { throw "Full merge-candidate validation failed with exit $LASTEXITCODE." }

    $active.status = 'deploying'
    Write-AtomicJsonFile $activePath $active
    & pwsh -NoProfile -File scripts/local-release.ps1 -Mode Preview -PullRequest $PullRequest -CommitSha $pr.headRefOid -HeadRef $pr.headRefName -AttestationPath $attestationPath -ReleaseId $releaseId -StatePath $journalPath -Apply
    if ($LASTEXITCODE -ne 0) { throw "Preview deployment failed with exit $LASTEXITCODE." }

    $journal = Get-Content -Raw -LiteralPath $journalPath | ConvertFrom-Json
    if ($journal.status -ne 'ready' -or $journal.pullRequest -ne $PullRequest -or $journal.commitSha -ne $pr.headRefOid -or $journal.frontendUrl -notmatch '^https://[A-Za-z0-9-]+\.vercel\.app$' -or $journal.apiUrl -notmatch '^https://[A-Za-z0-9-]+\.up\.railway\.app$') {
      throw 'Preview journal did not prove an exact ready frontend and API.'
    }
    $active.status = 'ready'
    $active.frontendUrl = $journal.frontendUrl
    $active.apiUrl = $journal.apiUrl
    $active.expiresAt = $journal.expiresAt
    $active.readyAt = $journal.readyAt
    Write-AtomicJsonFile $activePath $active

    Write-Output "preview-pr status=ready pr=$PullRequest sha=$($pr.headRefOid)"
    Write-Output "preview-url=$($journal.frontendUrl)"
    Write-Output "api-url=$($journal.apiUrl)"
    Write-Output "journal=$journalPath"
    Write-Output 'known-limitations=Google OAuth and outbound email are disabled. Only isolated database credentials and public/release values enter the preview; no persistent application or provider credentials are copied.'
    Write-Output "teardown-command=pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest $PullRequest -StatePath `"$journalPath`" -Apply"
  } catch {
    if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
      $active.status = 'failed-needs-teardown'
      $active.failure = $_.Exception.Message
      Write-AtomicJsonFile $activePath $active
      [Console]::Error.WriteLine("Preview failed after a provider journal was created. Partial resources may exist. Run: pwsh -File scripts/teardown-preview-pr.ps1 -PullRequest $PullRequest -StatePath `"$journalPath`" -Apply")
    } elseif (Test-Path -LiteralPath $activePath -PathType Leaf) {
      Remove-Item -LiteralPath $activePath -Force
    }
    throw
  }
} finally {
  if ($lifecycleLock) { $lifecycleLock.Dispose() }
  Pop-Location
}
