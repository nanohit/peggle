param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspaceRoot,
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$output = Join-Path $PSScriptRoot "build\bin\$Configuration-x86"
$artifacts = @(
    'haggle-sdk.dll',
    'research-telemetry-mod.dll',
    'peggle-fast-mod.dll',
    'peggle-fast-launcher.exe',
    'peggle-capture-recorder.exe'
)
$captureConfigSource = Join-Path $PSScriptRoot '..\native-capture\peggle-capture.ini'
$legacyCaptureConfigSha256 = '19a1d6d9ec7f5d4978639c898c64e688465d0725db50d81c917af4fe7b60545b'
$targets = @(
    @{
        Name = 'Peggle Deluxe'
        Directory = Join-Path $workspace 'Peggle Deluxe'
        Executable = 'Peggle.exe'
        Sha256 = '503f7afcedd7d0e02a2ade8cd3b1e8237a501006c167cce329ed44d7df0ab563'
    },
    @{
        Name = 'Peggle Nights'
        Directory = Join-Path $workspace 'Peggle Nights'
        Executable = 'PeggleNights.exe'
        Sha256 = 'aaa1b2823fb93b6f4b3d1374f44725121687ee4f05bda2dd8532b735051f2067'
    }
)

foreach ($artifact in $artifacts) {
    $source = Join-Path $output $artifact
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Build artifact is missing: $source"
    }
}

foreach ($target in $targets) {
    $directory = $target.Directory
    $executable = Join-Path $directory $target.Executable
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "$($target.Name) executable is missing: $executable"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant()
    if ($actual -ne $target.Sha256) {
        throw "$($target.Name) hash mismatch. Expected $($target.Sha256), got $actual. Nothing was deployed to this game."
    }

    $backupRoot = Join-Path $directory 'fastmod-backup'
    foreach ($artifact in $artifacts) {
        $source = Join-Path $output $artifact
        $destination = Join-Path $directory $artifact
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
            $destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
            if ($sourceHash -ne $destinationHash) {
                if (-not (Test-Path -LiteralPath $backupRoot)) {
                    New-Item -ItemType Directory -Path $backupRoot | Out-Null
                }
                $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
                Copy-Item -LiteralPath $destination -Destination (Join-Path $backupRoot "$stamp-$artifact")
            }
        }
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
    $captureConfigDestination = Join-Path $directory 'peggle-capture.ini'
    if (-not (Test-Path -LiteralPath $captureConfigDestination -PathType Leaf)) {
        Copy-Item -LiteralPath $captureConfigSource -Destination $captureConfigDestination
    } else {
        $configHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $captureConfigDestination).Hash.ToLowerInvariant()
        # Migrate only the exact prior generated default. Any user-edited tuning
        # has a different digest and remains untouched.
        if ($configHash -eq $legacyCaptureConfigSha256) {
            if (-not (Test-Path -LiteralPath $backupRoot)) {
                New-Item -ItemType Directory -Path $backupRoot | Out-Null
            }
            $configStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            Copy-Item -LiteralPath $captureConfigDestination -Destination (Join-Path $backupRoot "$configStamp-peggle-capture.ini")
            Copy-Item -LiteralPath $captureConfigSource -Destination $captureConfigDestination -Force
        }
    }

    $manifest = [ordered]@{
        format = 'peggle-fastmod-install'
        version = 1
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
        game = $target.Name
        executable = $target.Executable
        executableSha256 = $actual
        originalExecutableModified = $false
        hotkeys = [ordered]@{ cycle = 'F6'; direct = @('Ctrl+1', 'Ctrl+2', 'Ctrl+3') }
        capture = [ordered]@{
            enabled = $true
            config = 'peggle-capture.ini'
            outputDirectory = 'research-sessions'
            clock = 'gameTimeMs'
        }
        files = @($artifacts | ForEach-Object {
            $path = Join-Path $directory $_
            [ordered]@{ name = $_; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
        })
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $directory 'fastmod-manifest.json') -Encoding UTF8
    Write-Host "Deployed reversible fast mode to $($target.Name)"
}
