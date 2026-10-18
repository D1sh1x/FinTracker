param([string]$Serial, [ValidateRange(1024, 65535)][int]$Port = 18088)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$adb = Join-Path $projectRoot '.local/android/sdk/platform-tools/adb.exe'
if (-not (Test-Path -LiteralPath $adb)) {
    $adbCommand = Get-Command adb -ErrorAction SilentlyContinue
    if (-not $adbCommand) { throw 'adb not found. Install Android Platform Tools or use the project-local SDK.' }
    $adb = $adbCommand.Source
}
try {
    $ready = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/health/ready" -TimeoutSec 10
    if ($ready.StatusCode -ne 200) { throw 'API not ready' }
} catch { throw 'Start scripts/open-vps-tunnel.ps1 first; the VPS tracker must be reachable on this PC.' }
if (-not $Serial) {
    $devices = @(& $adb devices | Select-String '^([^\s]+)\s+device$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
    if ($devices.Count -ne 1) { throw 'Connect and authorize one USB Android device, or pass -Serial (see adb devices).' }
    $Serial = $devices[0]
}
& $adb -s $Serial reverse "tcp:$Port" "tcp:$Port"
if ($LASTEXITCODE -ne 0) { throw 'USB reverse tunnel failed' }
Write-Output "Phone browser / APK server URL: http://127.0.0.1:$Port"
Write-Output 'Keep USB connected and the SSH tunnel running. No SSH key is copied to the phone.'
