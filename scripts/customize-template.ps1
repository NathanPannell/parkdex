param(
    [Parameter(Mandatory = $true)][string]$AppName,
    [Parameter(Mandatory = $true)][string]$AppSlug,
    [Parameter(Mandatory = $true)][string]$GitHubRepository
)

$ErrorActionPreference = "Stop"
if ($AppSlug -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {
    throw "AppSlug must be lowercase kebab-case."
}
if ($GitHubRepository -notmatch '^[^/]+/[^/]+$') {
    throw "GitHubRepository must be OWNER/REPO."
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$replacements = [ordered]@{
    '__APP_NAME__' = $AppName
    '__APP_SLUG__' = $AppSlug
    '__GITHUB_REPOSITORY__' = $GitHubRepository
    'uptime-monitor-frontend' = "$AppSlug-frontend"
}
$textExtensions = @('.css', '.json', '.md', '.mjs', '.py', '.sh', '.sql', '.ts', '.tsx', '.txt', '.yml', '.yaml')

Get-ChildItem -LiteralPath $repositoryRoot -Recurse -File | Where-Object {
    $_.FullName -notmatch '[\\/]\.git[\\/]' -and
    $_.FullName -notmatch '[\\/]node_modules[\\/]' -and
    $_.FullName -ne $PSCommandPath -and
    $textExtensions -contains $_.Extension
} | ForEach-Object {
    $content = Get-Content -Raw -LiteralPath $_.FullName
    $updated = $content
    foreach ($entry in $replacements.GetEnumerator()) {
        $updated = $updated.Replace($entry.Key, $entry.Value)
    }
    if ($updated -ne $content) {
        Set-Content -LiteralPath $_.FullName -Value $updated -Encoding utf8 -NoNewline
    }
}

$remaining = rg --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!scripts/customize-template.ps1' '__APP_(NAME|SLUG)__|__GITHUB_REPOSITORY__' $repositoryRoot 2>$null
if ($LASTEXITCODE -eq 0) {
    throw "Unresolved template tokens remain:`n$remaining"
}
if ($LASTEXITCODE -gt 1) {
    throw "Unable to verify template tokens with rg."
}

Write-Output "Customized $GitHubRepository as $AppName."
