#requires -Version 7.0
param([ValidateSet('cpu','gpu')][string]$Mode = 'gpu', [int]$Threads = 4, [switch]$Stop, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
if ($Threads -lt 1 -or $Threads -gt 32) { throw 'Threads must be between 1 and 32.' }
$labRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$labFiles = @('-f', 'compose.import-lab.yml')
if ($Mode -eq 'gpu') { $labFiles += @('-f', 'compose.import-lab.gpu.yml') }
$env:LAB_MODE = $Mode
$env:LAB_THREADS = [string]$Threads
$env:LAB_GPU_LAYERS = if ($Mode -eq 'gpu') { '99' } else { '0' }
Push-Location $labRoot
try {
    if ($Stop) { & docker compose @labFiles down; exit $LASTEXITCODE }
    & (Join-Path $PSScriptRoot 'download-lab-model.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Model preparation failed.' }
    if (-not $SkipBuild) {
        $labAlias = $null
        foreach ($letter in @('R','S','T','U','V','W','X','Y','Z')) { if (-not (Test-Path -LiteralPath "$($letter):\")) { $labAlias = "$($letter):"; break } }
        if (-not $labAlias) { throw 'No free drive letter for Docker build.' }
        & subst.exe $labAlias $labRoot
        if ($LASTEXITCODE -ne 0) { throw 'Could not create Docker build alias.' }
        try {
            Push-Location "$labAlias\"
            & docker compose @labFiles build lab
            $labBuildExit = $LASTEXITCODE
        } finally { Pop-Location; & subst.exe $labAlias /d }
        if ($labBuildExit -ne 0) { throw 'Lab build failed.' }
    }
    & docker compose @labFiles up -d --wait --wait-timeout 600
    if ($LASTEXITCODE -ne 0) { throw 'Lab startup failed. Inspect docker compose -f compose.import-lab.yml logs.' }
    Write-Output "Import lab ready: http://localhost:8090 ($Mode, $Threads CPU threads)."
} finally { Pop-Location }
