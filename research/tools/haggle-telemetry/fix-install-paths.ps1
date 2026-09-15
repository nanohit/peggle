param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspaceRoot
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$deluxe = Join-Path $workspace 'Peggle Deluxe'
$nights = Join-Path $workspace 'Peggle Nights'

if (-not (Test-Path -LiteralPath (Join-Path $deluxe 'Peggle.exe') -PathType Leaf)) {
    throw "Peggle.exe not found below $deluxe"
}
if (-not (Test-Path -LiteralPath (Join-Path $nights 'PeggleNights.exe') -PathType Leaf)) {
    throw "PeggleNights.exe not found below $nights"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$registryTargets = @(
    @{ Key = 'HKLM\SOFTWARE\WOW6432Node\PopCap\Peggle'; Directory = $deluxe; Name = 'hklm-peggle' },
    @{ Key = 'HKLM\SOFTWARE\WOW6432Node\PopCap\PeggleNights'; Directory = $nights; Name = 'hklm-peggle-nights' },
    @{ Key = 'HKCU\Software\PopCap\Peggle'; Directory = $deluxe; Name = 'hkcu-peggle' },
    @{ Key = 'HKCU\Software\PopCap\PeggleNights'; Directory = $nights; Name = 'hkcu-peggle-nights' }
)
foreach ($target in $registryTargets) {
    $backup = Join-Path $target.Directory 'fastmod-backup'
    if (-not (Test-Path -LiteralPath $backup)) { New-Item -ItemType Directory -Path $backup | Out-Null }
    reg.exe query $target.Key *> $null
    if ($LASTEXITCODE -eq 0) {
        reg.exe export $target.Key (Join-Path $backup "$stamp-$($target.Name).reg") /y | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to back up $($target.Key)" }
    }
}

reg.exe add 'HKLM\SOFTWARE\WOW6432Node\PopCap\Peggle' /v InstallPath /t REG_SZ /d $deluxe /f
if ($LASTEXITCODE -ne 0) { throw "Failed to set Peggle InstallPath ($LASTEXITCODE)" }
reg.exe add 'HKLM\SOFTWARE\WOW6432Node\PopCap\PeggleNights' /v InstallPath /t REG_SZ /d $nights /f
if ($LASTEXITCODE -ne 0) { throw "Failed to set Peggle Nights InstallPath ($LASTEXITCODE)" }
reg.exe add 'HKCU\Software\PopCap\Peggle' /v InstallPath /t REG_SZ /d $deluxe /f
if ($LASTEXITCODE -ne 0) { throw "Failed to set HKCU Peggle InstallPath ($LASTEXITCODE)" }
reg.exe add 'HKCU\Software\PopCap\PeggleNights' /v InstallPath /t REG_SZ /d $nights /f
if ($LASTEXITCODE -ne 0) { throw "Failed to set HKCU Peggle Nights InstallPath ($LASTEXITCODE)" }

Write-Host "PopCap install paths updated to $workspace; previous values were exported under fastmod-backup."
