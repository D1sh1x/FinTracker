param(
    [string]$Server = 'avaki@167.86.68.233',
    [string]$KeyPath = "$env:USERPROFILE\.ssh\engsider_friend",
    [ValidateRange(1024, 65535)][int]$LocalPort = 18088,
    [ValidateRange(1024, 65535)][int]$RemotePort = 8088
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw 'SSH private key not found' }
Write-Output "VPS tracker: http://127.0.0.1:$LocalPort (keep this terminal open; Ctrl+C disconnects)"
& ssh -N -T -i $KeyPath -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L "127.0.0.1:$($LocalPort):127.0.0.1:$RemotePort" $Server
exit $LASTEXITCODE
