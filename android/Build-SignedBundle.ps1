param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2100000000)]
    [int]$VersionCode,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$VersionName
)

$ErrorActionPreference = 'Stop'
$androidDirectory = $PSScriptRoot
$sdkDirectory = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$privateDirectory = Join-Path $env:USERPROFILE '.codex\private\parkdex-android\play-upload-v1'
$keystoreFile = Join-Path $privateDirectory 'parkdex-upload.p12'
$credentialFile = Join-Path $privateDirectory 'upload-credential.dpapi.xml'
$syncedConfigFile = Join-Path $androidDirectory 'app\src\main\assets\capacitor.config.json'
# The Play build is the production app: its App Links and content API use the production host.
$productionHost = 'web.parkdex.app'

foreach ($requiredPath in @($sdkDirectory, $keystoreFile, $credentialFile, $syncedConfigFile)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path does not exist: $requiredPath"
    }
}

# Refuse to sign staging web assets: the last sync must be `npm run android:sync:production`.
$syncedChannel = (Get-Content -LiteralPath $syncedConfigFile -Raw | ConvertFrom-Json).plugins.CapacitorUpdater.defaultChannel
if ($syncedChannel -ne 'production') {
    throw "The synced web bundle is on channel '$syncedChannel'. Run npm run android:sync:production first."
}

$environmentNames = @(
    'ANDROID_HOME',
    'ANDROID_SDK_ROOT',
    'PARKDEX_AUTH_LINK_HOST',
    'PARKDEX_CONTENT_API_HOST',
    'PARKDEX_RELEASE_PROPERTIES_FILE',
    'PARKDEX_RELEASE_KEYSTORE_FILE',
    'PARKDEX_RELEASE_KEY_ALIAS',
    'PARKDEX_RELEASE_KEYSTORE_PASSWORD',
    'PARKDEX_RELEASE_KEY_PASSWORD',
    'PARKDEX_ANDROID_VERSION_CODE',
    'PARKDEX_ANDROID_VERSION_NAME'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location -LiteralPath $androidDirectory
try {
    # local.properties takes precedence over ANDROID_HOME when Gradle locates the SDK.
    # It is ignored by Git and contains only the SDK path, never signing credentials.
    $localProperties = Join-Path $androidDirectory 'local.properties'
    $otherProperties = @()
    if (Test-Path -LiteralPath $localProperties) {
        $otherProperties = @(Get-Content -LiteralPath $localProperties | Where-Object { $_ -notmatch '^\s*sdk\.dir\s*=' })
    }
    $sdkProperty = 'sdk.dir=' + $sdkDirectory.Replace('\', '/')
    Set-Content -LiteralPath $localProperties -Value @($otherProperties + $sdkProperty) -Encoding Ascii

    # Import-Clixml decrypts this credential only for the Windows user who created it.
    $credential = Import-Clixml -LiteralPath $credentialFile
    $signingPassword = $credential.GetNetworkCredential().Password
    if ([string]::IsNullOrEmpty($signingPassword) -or [string]::IsNullOrEmpty($credential.UserName)) {
        throw 'The saved signing credential is incomplete.'
    }

    [Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdkDirectory, 'Process')
    [Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $sdkDirectory, 'Process')
    [Environment]::SetEnvironmentVariable('PARKDEX_AUTH_LINK_HOST', $productionHost, 'Process')
    # Cleared so a host or properties file left in the shell cannot reach the Play build.
    [Environment]::SetEnvironmentVariable('PARKDEX_CONTENT_API_HOST', $null, 'Process')
    [Environment]::SetEnvironmentVariable('PARKDEX_RELEASE_PROPERTIES_FILE', $null, 'Process')
    [Environment]::SetEnvironmentVariable('PARKDEX_RELEASE_KEYSTORE_FILE', $keystoreFile, 'Process')
    [Environment]::SetEnvironmentVariable('PARKDEX_RELEASE_KEY_ALIAS', $credential.UserName, 'Process')
    [Environment]::SetEnvironmentVariable('PARKDEX_RELEASE_KEYSTORE_PASSWORD', $signingPassword, 'Process')
    [Environment]::SetEnvironmentVariable('PARKDEX_RELEASE_KEY_PASSWORD', $signingPassword, 'Process')
    [Environment]::SetEnvironmentVariable('PARKDEX_ANDROID_VERSION_CODE', $VersionCode.ToString(), 'Process')
    [Environment]::SetEnvironmentVariable('PARKDEX_ANDROID_VERSION_NAME', $VersionName, 'Process')

    # Gradle writes warnings to stderr; judge the build by its exit code, not by stderr output.
    $ErrorActionPreference = 'Continue'
    & (Join-Path $androidDirectory 'gradlew.bat') bundleRelease --no-daemon
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle bundleRelease failed with exit code $LASTEXITCODE."
    }

    Write-Host "Signed bundle: $(Join-Path $androidDirectory 'app\build\outputs\bundle\release\app-release.aab')"
} finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    $signingPassword = $null
    $credential = $null
    $previousEnvironment.Clear()
    Pop-Location
}
