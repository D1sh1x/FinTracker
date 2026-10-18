param([string]$Serial = 'emulator-5556')
$ErrorActionPreference = 'Stop'
if (-not $Serial.StartsWith('emulator-')) { throw 'This fake bank fixture may only be installed on an isolated emulator.' }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$drive = @('R:','T:','U:','V:','W:','X:','Y:','Z:') | Where-Object { -not (Test-Path -LiteralPath "$_\") } | Select-Object -First 1
if (-not $drive) { throw 'No temporary drive available' }
& subst.exe $drive $workspace
if ($LASTEXITCODE -ne 0) { throw 'Path alias failed' }
$previousJavaHome = $env:JAVA_HOME
try {
$projectRoot = "$drive/"
$fixtureSource = "$projectRoot/scripts/android-notification-fixture"
$jdk = (Get-ChildItem -LiteralPath "$projectRoot/.local/android/jdk" -Directory | Select-Object -First 1).FullName
$sdk = "$projectRoot/.local/android/sdk"
$tools = "$sdk/build-tools/36.0.0"
$target = "$projectRoot/.local/push/fixture"
New-Item -ItemType Directory -Force "$target/classes", "$target/dex" | Out-Null
& "$jdk/bin/javac.exe" -encoding UTF-8 -source 17 -target 17 -classpath "$sdk/platforms/android-36/android.jar" -d "$target/classes" "$fixtureSource/MainActivity.java"
if ($LASTEXITCODE -ne 0) { throw 'Fixture javac failed' }
& "$jdk/bin/java.exe" -cp "$tools/lib/d8.jar" com.android.tools.r8.D8 --lib "$sdk/platforms/android-36/android.jar" --output "$target/dex" "$target/classes/fixture/MainActivity.class"
if ($LASTEXITCODE -ne 0) { throw 'Fixture dex failed' }
& "$tools/aapt.exe" package -f -M "$fixtureSource/AndroidManifest.xml" -I "$sdk/platforms/android-36/android.jar" -F "$target/fixture-unsigned.apk"
if ($LASTEXITCODE -ne 0) { throw 'Fixture packaging failed' }
Push-Location "$target/dex"
try { & "$tools/aapt.exe" add "$target/fixture-unsigned.apk" classes.dex; if ($LASTEXITCODE -ne 0) { throw 'Fixture dex packaging failed' } } finally { Pop-Location }
$env:JAVA_HOME = $jdk
$key = "$projectRoot/.local/android/signing/fixture.jks"
if (-not (Test-Path -LiteralPath $key)) { & "$jdk/bin/keytool.exe" -genkeypair -keystore $key -storepass android -keypass android -alias fixture -keyalg RSA -validity 365 -dname 'CN=Emulator Only Fixture' | Out-Null }
& "$tools/zipalign.exe" -f 4 "$target/fixture-unsigned.apk" "$target/fixture-aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'Fixture alignment failed' }
& "$tools/apksigner.bat" sign --ks $key --ks-pass pass:android --out "$target/fixture.apk" "$target/fixture-aligned.apk"
if ($LASTEXITCODE -ne 0) { throw 'Fixture signing failed' }
& "$sdk/platform-tools/adb.exe" -s $Serial install -r "$target/fixture.apk"
if ($LASTEXITCODE -ne 0) { throw 'Fixture install failed' }
& "$sdk/platform-tools/adb.exe" -s $Serial shell pm grant ru.wildberries.bank android.permission.POST_NOTIFICATIONS
if ($LASTEXITCODE -ne 0) { throw 'Fixture notification permission failed' }
} finally { $env:JAVA_HOME = $previousJavaHome; & subst.exe $drive /d }
