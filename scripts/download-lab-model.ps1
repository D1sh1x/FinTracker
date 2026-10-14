#requires -Version 7.0
param()
$ErrorActionPreference = 'Stop'
$labRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$labModelDir = Join-Path $labRoot '.local\models'
$labModelName = 'Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
$labModelPath = [IO.Path]::GetFullPath((Join-Path $labModelDir $labModelName))
if (-not $labModelPath.StartsWith($labRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Model target is outside the workspace' }
$labSha256 = '2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e'
$labUrl = 'https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/resolve/ae44f08e1392f39c0e474af10c3ff8355c8b6688/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
New-Item -ItemType Directory -Path $labModelDir -Force | Out-Null
if (Test-Path -LiteralPath $labModelPath) {
    if ((Get-FileHash -LiteralPath $labModelPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $labSha256) { Write-Output 'Qwen3-4B model verified.'; exit 0 }
    throw 'Existing model checksum does not match. Keep it aside before retrying.'
}
$labPart = $labModelPath + '.part'
Write-Output 'Downloading Qwen3-4B Q4_K_M (2.50 GB) to .local/models ...'
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $labUrl -OutFile $labPart -Resume -TimeoutSec 3600
if ((Get-Item -LiteralPath $labPart).Length -ne 2497280736 -or (Get-FileHash -LiteralPath $labPart -Algorithm SHA256).Hash.ToLowerInvariant() -ne $labSha256) { throw 'Downloaded model failed SHA-256 verification.' }
Move-Item -LiteralPath $labPart -Destination $labModelPath
Write-Output 'Qwen3-4B downloaded and SHA-256 verified.'
