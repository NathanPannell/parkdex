[CmdletBinding()]
param(
  [ValidateSet('Staging', 'Preview', 'Cleanup')]
  [string]$Mode = 'Staging',
  [int]$PullRequest = 0,
  [string]$CommitSha = '',
  [string]$StatePath = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSNativeCommandUseErrorActionPreference = $true }
$root = (git rev-parse --show-toplevel).Trim()
$actualSha = (git rev-parse HEAD).Trim()
if ($CommitSha -and $CommitSha -ne $actualSha) { throw "Refusing stale checkout: expected $CommitSha, found $actualSha" }
if ((git status --porcelain)) { throw 'Refusing deployment from a dirty worktree.' }

$shortSha = $actualSha.Substring(0, 12)
$railwayEnvironment = if ($Mode -eq 'Preview') { "pr-$PullRequest" } elseif ($Mode -eq 'Staging') { 'staging' } else { '' }
$neonBranch = if ($Mode -eq 'Preview') { "preview/pr-$PullRequest" } else { '' }
if ($Mode -eq 'Preview' -and ($PullRequest -lt 1 -or $PullRequest -gt 999999)) { throw 'Preview requires a valid pull request number.' }
if ($Mode -eq 'Cleanup' -and $PullRequest -lt 1) { throw 'Cleanup requires the recorded pull request number.' }
if (-not $StatePath) { $StatePath = Join-Path $env:TEMP "parkdex-local-release-$railwayEnvironment.json" }

$plan = [ordered]@{
  mode = $Mode.ToLowerInvariant()
  commitSha = $actualSha
  railwayEnvironment = $railwayEnvironment
  neonBranch = $neonBranch
  statePath = $StatePath
  apply = [bool]$Apply
  safety = @('exact clean SHA', 'schema-only Neon branch for previews', '7-day preview TTL', 'recorded namespace cleanup only')
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 4
  exit 0
}

function Require-Env([string[]]$Names) {
  foreach ($name in $Names) {
    if (-not (Get-Item "Env:$name" -ErrorAction SilentlyContinue)) { throw "Required environment variable is missing: $name" }
  }
}

function Invoke-Bash([string]$Script) {
  bash $Script
  if ($LASTEXITCODE -ne 0) { throw "Release helper failed: $Script" }
}

if ($Mode -eq 'Cleanup') {
  if (-not (Test-Path -LiteralPath $StatePath)) { throw "Release state not found: $StatePath" }
  $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
  if ($state.mode -ne 'preview' -or $state.railwayEnvironment -ne "pr-$PullRequest" -or $state.neonBranch -ne "preview/pr-$PullRequest") {
    throw 'Cleanup state does not match the requested preview namespace.'
  }
  if ($state.neonBranchId -notmatch '^br-[a-z0-9-]+$') { throw 'Cleanup state contains an invalid Neon branch id.' }
  if ($state.vercelDeploymentId -and $state.vercelDeploymentId -notmatch '^dpl_[A-Za-z0-9]+$') { throw 'Cleanup state contains an invalid Vercel deployment id.' }
  Require-Env @('RAILWAY_API_TOKEN', 'RAILWAY_PROJECT_ID', 'RAILWAY_BASE_ENVIRONMENT_ID', 'NEON_PROJECT_ID', 'NEON_API_KEY', 'VERCEL_TOKEN', 'VERCEL_ORG_ID')
  railway link --project $env:RAILWAY_PROJECT_ID --environment $env:RAILWAY_BASE_ENVIRONMENT_ID | Out-Null
  railway environment delete $state.railwayEnvironment --yes | Out-Null
  $headers = @{ Authorization = "Bearer $env:NEON_API_KEY"; Accept = 'application/json' }
  $branchInfo = Invoke-RestMethod -Method Get -Uri "https://console.neon.tech/api/v2/projects/$env:NEON_PROJECT_ID/branches/$($state.neonBranchId)" -Headers $headers
  $branchName = if ($branchInfo.branch) { $branchInfo.branch.name } else { $branchInfo.name }
  if ($branchName -ne $state.neonBranch) { throw 'Recorded Neon branch id does not belong to the requested preview namespace.' }
  Invoke-RestMethod -Method Delete -Uri "https://console.neon.tech/api/v2/projects/$env:NEON_PROJECT_ID/branches/$($state.neonBranchId)" -Headers $headers | Out-Null
  if ($state.vercelDeploymentId) {
    $deployment = vercel inspect $state.vercelDeploymentId --json --scope $env:VERCEL_ORG_ID | ConvertFrom-Json
    if ($deployment.id -ne $state.vercelDeploymentId -or $deployment.projectId -ne $env:VERCEL_PROJECT_ID) { throw 'Recorded Vercel deployment ownership could not be verified.' }
    vercel remove $state.vercelDeploymentId --yes --scope $env:VERCEL_ORG_ID | Out-Null
  }
  Write-Output "Cleaned recorded preview namespace $($state.railwayEnvironment) for commit $($state.commitSha)."
  exit 0
}

Require-Env @('RAILWAY_API_TOKEN', 'RAILWAY_PROJECT_ID', 'RAILWAY_BASE_ENVIRONMENT_ID', 'RAILWAY_API_SERVICE_ID', 'RAILWAY_WORKER_SERVICE_ID', 'VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID')
if ($Mode -eq 'Staging') {
  Require-Env @('PARKDEX_STAGING_DATABASE_URL', 'PARKDEX_STAGING_DATABASE_URL_UNPOOLED')
  $pooledUrl = $env:PARKDEX_STAGING_DATABASE_URL
  $unpooledUrl = $env:PARKDEX_STAGING_DATABASE_URL_UNPOOLED
} else {
  Require-Env @('NEON_PROJECT_ID', 'NEON_API_KEY', 'NEON_PARENT_BRANCH')
  $expiresAt = [DateTime]::UtcNow.AddDays(7).ToString('yyyy-MM-ddTHH:mm:ssZ')
  $neonOutput = Join-Path $env:TEMP "parkdex-neon-$PullRequest-$shortSha.json"
  $env:NEON_BRANCH = $neonBranch
  $env:NEON_EXPIRES_AT = $expiresAt
  $env:NEON_RUN_MARKER = "$actualSha/$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
  $env:NEON_OUTPUT_PATH = $neonOutput
  python (Join-Path $root 'scripts/provision_local_neon.py')
  $neon = Get-Content -Raw -LiteralPath $neonOutput | ConvertFrom-Json
  $pooledUrl = $neon.db_url_pooled
  $unpooledUrl = $neon.db_url
}

railway link --project $env:RAILWAY_PROJECT_ID --environment $env:RAILWAY_BASE_ENVIRONMENT_ID | Out-Null
$environments = railway environment list --json | ConvertFrom-Json
$exists = @($environments | Where-Object { $_.name -eq $railwayEnvironment }).Count -gt 0
if (-not $exists) { railway environment new $railwayEnvironment --copy $env:RAILWAY_BASE_ENVIRONMENT_ID | Out-Null }

function Set-RailwayVariable([string]$Value, [string]$Name, [string]$Service) {
  $Value | railway variable set $Name --stdin --skip-deploys --service $Service --environment $railwayEnvironment --project $env:RAILWAY_PROJECT_ID | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Railway variable update failed for $Name/$Service" }
}

$dbName = if ($Mode -eq 'Preview') { 'PREVIEW_DATABASE_URL' } else { 'DATABASE_URL' }
$dbDirectName = if ($Mode -eq 'Preview') { 'PREVIEW_DATABASE_URL_UNPOOLED' } else { 'DATABASE_URL_UNPOOLED' }
foreach ($service in @($env:RAILWAY_API_SERVICE_ID, $env:RAILWAY_WORKER_SERVICE_ID)) {
  Set-RailwayVariable $pooledUrl $dbName $service
  Set-RailwayVariable $actualSha 'APP_COMMIT_SHA' $service
  if ($Mode -eq 'Preview') { Set-RailwayVariable 'preview' 'APP_ENVIRONMENT' $service }
}
Set-RailwayVariable $unpooledUrl $dbDirectName $env:RAILWAY_API_SERVICE_ID
if ($Mode -eq 'Staging') { Set-RailwayVariable 'staging' 'APP_ENVIRONMENT' $env:RAILWAY_API_SERVICE_ID }
foreach ($service in @($env:RAILWAY_API_SERVICE_ID, $env:RAILWAY_WORKER_SERVICE_ID)) {
  railway service source disconnect --service $service --environment $railwayEnvironment --project $env:RAILWAY_PROJECT_ID | Out-Null
}

$markerPath = Join-Path $root 'backend/.local-release-source-sha'
Set-Content -LiteralPath $markerPath -Value "$actualSha local-release" -NoNewline
try {
  foreach ($service in @($env:RAILWAY_API_SERVICE_ID, $env:RAILWAY_WORKER_SERVICE_ID)) {
    railway up --ci --yes --message "local-release $actualSha" --service $service --environment $railwayEnvironment --project $env:RAILWAY_PROJECT_ID | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Railway deploy failed for $service" }
  }
} finally { Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue }

$env:RAILWAY_ENVIRONMENT = $railwayEnvironment
$env:EXPECTED_COMMIT_SHA = $actualSha
$outputFile = Join-Path $env:TEMP "parkdex-railway-output-$shortSha.txt"
Remove-Item -LiteralPath $outputFile -Force -ErrorAction SilentlyContinue
$env:GITHUB_OUTPUT = $outputFile
if (Get-Command bash -ErrorAction SilentlyContinue) { Invoke-Bash (Join-Path $root 'scripts/wait-for-railway-api.sh') } else { throw 'bash is required for the proven Railway readiness helper.' }
$apiLine = Select-String -Path $outputFile -Pattern '^api_url=' | Select-Object -Last 1
if (-not $apiLine) { throw 'Railway readiness helper did not return an API URL.' }
$apiUrl = $apiLine.Line.Split('=', 2)[1]
$env:API_URL = $apiUrl
Invoke-Bash (Join-Path $root 'scripts/wait-for-worker-catalogue.sh')
Invoke-Bash (Join-Path $root 'scripts/smoke-catalogue.sh')

$env:NEXT_PUBLIC_API_BASE_URL = $apiUrl
$env:NEXT_PUBLIC_RELEASE_VERSION = 'local'
$env:NEXT_PUBLIC_COMMIT_SHA = $actualSha
$env:NEXT_PUBLIC_COMMIT_DATE = [DateTime]::UtcNow.ToString('o')
npm.cmd --prefix frontend run build | Out-Null
$frontendUrl = (vercel deploy --yes --target preview --cwd frontend --build-env NEXT_PUBLIC_API_BASE_URL=$apiUrl --build-env NEXT_PUBLIC_RELEASE_VERSION=local --build-env NEXT_PUBLIC_COMMIT_SHA=$actualSha --build-env NEXT_PUBLIC_COMMIT_DATE=$env:NEXT_PUBLIC_COMMIT_DATE --meta githubCommitSha=$actualSha --scope $env:VERCEL_ORG_ID | Select-Object -Last 1).Trim()
$deployment = vercel inspect $frontendUrl --json --scope $env:VERCEL_ORG_ID | ConvertFrom-Json
if (-not $deployment.id -or $deployment.projectId -ne $env:VERCEL_PROJECT_ID) { throw 'New Vercel deployment ownership could not be verified.' }
if ($Mode -eq 'Staging') { vercel alias set $frontendUrl 'staging.parkdex.app' --scope $env:VERCEL_ORG_ID | Out-Null; $frontendOrigin = 'https://staging.parkdex.app' } else { $frontendOrigin = $frontendUrl }
Set-RailwayVariable $frontendOrigin 'FRONTEND_ORIGINS' $env:RAILWAY_API_SERVICE_ID
railway redeploy --yes --service $env:RAILWAY_API_SERVICE_ID --environment $railwayEnvironment --project $env:RAILWAY_PROJECT_ID | Out-Null
Invoke-Bash (Join-Path $root 'scripts/wait-for-railway-api.sh')
$state = [ordered]@{ mode = $Mode.ToLowerInvariant(); commitSha = $actualSha; railwayEnvironment = $railwayEnvironment; neonBranch = $neonBranch; neonBranchId = if ($neon) { $neon.branch_id } else { $null }; expiresAt = if ($neon) { $neon.expires_at } else { $null }; apiUrl = $apiUrl; frontendUrl = $frontendOrigin; vercelDeploymentId = $deployment.id; createdAt = [DateTime]::UtcNow.ToString('o') }
$state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
Write-Output "Local $Mode release ready for exact commit $actualSha. State: $StatePath"
