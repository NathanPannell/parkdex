param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 999999)]
  [int]$PullRequest,
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$scriptPath = Join-Path $repoRoot "scripts\kip-delivery.py"
$pythonLauncher = Get-Command py -ErrorAction SilentlyContinue

if ($pythonLauncher) {
  $pythonArgs = @("-3", $scriptPath, "teardown", "--pr", $PullRequest)
  if ($Apply) { $pythonArgs += "--apply" }
  & $pythonLauncher.Source @pythonArgs
} else {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $python) { throw "Python 3 is required to run the Parkdex Kip delivery scripts." }
  $pythonArgs = @($scriptPath, "teardown", "--pr", $PullRequest)
  if ($Apply) { $pythonArgs += "--apply" }
  & $python.Source @pythonArgs
}

if ($LASTEXITCODE -ne 0) {
  throw "Preview teardown failed with exit code $LASTEXITCODE."
}
