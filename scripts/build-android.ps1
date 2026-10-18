param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [ValidateRange(1, 2100000000)][int]$VersionCode = 1,
    [ValidatePattern('^[0-9A-Za-z.\-]+$')][string]$VersionName = '0.1.0-alpha',
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$SdkRoot = $env:ANDROID_HOME,
    [switch]$Verify,
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$toolchainRoot = Join-Path $projectRoot '.local/android'
if (-not $JavaHome) {
    if (Test-Path -LiteralPath "$toolchainRoot/jdk") {
        $JavaHome = (Get-ChildItem -LiteralPath "$toolchainRoot/jdk" -Directory | Select-Object -First 1).FullName
    }
}
if (-not $SdkRoot) { $SdkRoot = "$toolchainRoot/sdk" }
if (-not (Test-Path -LiteralPath "$JavaHome/bin/java.exe")) { throw 'JDK 21 required: pass -JavaHome or set JAVA_HOME. See docs/ANDROID.md.' }
if (-not (Test-Path -LiteralPath "$SdkRoot/platforms/android-36/android.jar")) { throw 'Android SDK Platform 36 required: pass -SdkRoot or set ANDROID_HOME. See docs/ANDROID.md.' }
$previousEnvironment = @{}
foreach ($variableName in @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME')) {
    $previousEnvironment[$variableName] = [Environment]::GetEnvironmentVariable($variableName, 'Process')
}
$aliasLetter = @('R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z') | Where-Object { -not (Test-Path -LiteralPath "$($_):\") } | Select-Object -First 1
if (-not $aliasLetter) { throw 'No free drive letter for an ASCII Android build path' }
$aliasDrive = "$($aliasLetter):"
& subst.exe $aliasDrive $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not create Android project path alias' }
try {
    $aliasRoot = "$aliasDrive\"
    $env:JAVA_HOME = $JavaHome.Replace($projectRoot, $aliasRoot.TrimEnd('\'))
    $env:ANDROID_HOME = $SdkRoot.Replace($projectRoot, $aliasRoot.TrimEnd('\'))
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    $env:GRADLE_USER_HOME = "$aliasRoot.local\android\gradle"
    $sdkProperty = $env:ANDROID_HOME.Replace('\', '/').Replace(':', '\:')
    [IO.File]::WriteAllText("$aliasRoot/frontend/android/local.properties", "sdk.dir=$sdkProperty`n", [Text.UTF8Encoding]::new($false))
    Push-Location "$aliasRoot/frontend"
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
        & npx.cmd cap sync android
        if ($LASTEXITCODE -ne 0) { throw 'Capacitor sync failed' }
    } finally { Pop-Location }
    Push-Location "$aliasRoot/frontend/android"
    try {
        $gradleArguments = @('--no-daemon', '--max-workers=2', '-Pandroid.overridePathCheck=true', "-PfintrackVersionCode=$VersionCode", "-PfintrackVersionName=$VersionName", "assemble$Configuration")
        if ($Offline) { $gradleArguments += '--offline' }
        if ($Verify) { $gradleArguments += @("lint$Configuration", "test$($Configuration)UnitTest") }
        & .\gradlew.bat @gradleArguments
        if ($LASTEXITCODE -ne 0) { throw 'Android build or verification failed' }
    } finally { Pop-Location }
    $artifactDirectory = "$aliasRoot/artifacts/android"
    New-Item -ItemType Directory -Force $artifactDirectory | Out-Null
    $artifactName = if ($Configuration -eq 'Release') { "FinTrack-$VersionName.apk" } else { "FinTrack-$VersionName-debug.apk" }
    $artifact = "$artifactDirectory/$artifactName"
    $buildTools = "$env:ANDROID_HOME/build-tools/36.0.0"
    if ($Configuration -eq 'Release') {
        $signingDirectory = "$aliasRoot.local/android/signing"
        New-Item -ItemType Directory -Force $signingDirectory | Out-Null
        $keystore = "$signingDirectory/fintrack-release.jks"
        $passwordFile = "$signingDirectory/password.txt"
        if (-not (Test-Path -LiteralPath $keystore)) {
            if (Test-Path -LiteralPath $passwordFile) { throw 'Signing password exists without keystore; restore signing files before rebuilding.' }
            $randomBytes = New-Object byte[] 32
            $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $randomGenerator.GetBytes($randomBytes) } finally { $randomGenerator.Dispose() }
            [IO.File]::WriteAllText($passwordFile, [Convert]::ToBase64String($randomBytes), [Text.UTF8Encoding]::new($false))
            & "$env:JAVA_HOME/bin/keytool.exe" -genkeypair -keystore $keystore -storepass:file $passwordFile -keypass:file $passwordFile -alias fintrack -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=FinTrack Personal, O=FinTrack' -storetype PKCS12
            if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed; preserve signing files and inspect the error.' }
        }
        if (-not (Test-Path -LiteralPath $passwordFile)) { throw 'Restore signing/password.txt to update the existing APK signing key.' }
        $unsigned = "$aliasRoot/frontend/android/app/build/outputs/apk/release/app-release-unsigned.apk"
        $aligned = "$aliasRoot.local/android/aligned-release.apk"
        & "$buildTools/zipalign.exe" -P 16 -f 4 $unsigned $aligned
        if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed' }
        & "$buildTools/apksigner.bat" sign --ks $keystore --ks-key-alias fintrack --ks-pass "file:$passwordFile" --out $artifact $aligned
        if ($LASTEXITCODE -ne 0) { throw 'APK signing failed' }
    } else {
        Copy-Item -LiteralPath "$aliasRoot/frontend/android/app/build/outputs/apk/debug/app-debug.apk" -Destination $artifact -Force
    }
    & "$buildTools/apksigner.bat" verify --verbose $artifact
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
    $checksum = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$artifact.sha256", "$checksum  $artifactName`n", [Text.UTF8Encoding]::new($false))
    Write-Output "APK: $projectRoot/artifacts/android/$artifactName"
    Write-Output "SHA-256: $checksum"
} finally {
    & subst.exe $aliasDrive /d
    foreach ($variableName in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($variableName, $previousEnvironment[$variableName], 'Process')
    }
}
