param(
    [Parameter(Mandatory = $true)]
    [string]$HaggleRoot,
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = (Resolve-Path -LiteralPath $HaggleRoot).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw "Visual Studio Installer discovery tool not found: $vswhere"
}

$installation = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
if (-not $installation) {
    throw 'No Visual Studio installation with MSBuild was found.'
}
$msbuild = Join-Path $installation 'MSBuild\Current\Bin\MSBuild.exe'
if (-not (Test-Path -LiteralPath $msbuild -PathType Leaf)) {
    throw "MSBuild not found: $msbuild"
}

& (Join-Path $here 'generate.ps1') -HaggleRoot $root
if ($LASTEXITCODE -ne 0) { throw "Premake generation failed with exit code $LASTEXITCODE" }

$solution = Join-Path $here 'build\PeggleResearchTelemetry.sln'
# Codex desktop can expose both `Path` and `PATH` in the inherited Windows
# environment. The .NET Framework MSBuild task host treats them as duplicate
# case-insensitive dictionary keys when spawning cl.exe, so normalize to one.
$normalizedPath = $env:Path
[Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
[Environment]::SetEnvironmentVariable('Path', $normalizedPath, 'Process')
& $msbuild $solution /m /nologo /verbosity:minimal "/p:Configuration=$Configuration" /p:Platform=Win32
if ($LASTEXITCODE -ne 0) { throw "MSBuild failed with exit code $LASTEXITCODE" }

$output = Join-Path $here "build\bin\$Configuration-x86"
$required = @(
    'haggle-sdk.dll',
    'research-telemetry-mod.dll',
    'peggle-fast-mod.dll',
    'peggle-fast-launcher.exe',
    'peggle-capture-recorder.exe'
)
foreach ($name in $required) {
    $artifact = Join-Path $output $name
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
        throw "Expected build artifact is missing: $artifact"
    }
}

Write-Host "Built x86 artifacts in $output"
