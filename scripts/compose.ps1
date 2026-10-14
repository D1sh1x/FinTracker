param([string[]]$DockerArguments = @('up', '-d', '--build', '--wait'))

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$buildOnly = $DockerArguments.Count -gt 0 -and $DockerArguments[0] -eq 'build'
if ($buildOnly -or $DockerArguments -contains '--build') {
    $aliasLetter = $null
    foreach ($candidateLetter in @('R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z')) {
        if (-not (Test-Path -LiteralPath "$($candidateLetter):\")) { $aliasLetter = $candidateLetter; break }
    }
    if (-not $aliasLetter) { throw 'No free drive letter for the Docker build path' }
    $aliasDrive = "$($aliasLetter):"
    & subst.exe $aliasDrive $projectRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not create project path alias' }
    $buildExitCode = 1
    try {
        Push-Location "$aliasDrive\"
        if ($buildOnly) { & docker compose @DockerArguments }
        else { & docker compose build }
        $buildExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
        & subst.exe $aliasDrive /d
    }
    if ($buildExitCode -ne 0 -or $buildOnly) { exit $buildExitCode }
}

$runtimeArguments = @($DockerArguments | Where-Object { $_ -ne '--build' })
Push-Location $projectRoot
try {
    & docker compose @runtimeArguments
    $runtimeExitCode = $LASTEXITCODE
}
finally { Pop-Location }
exit $runtimeExitCode
