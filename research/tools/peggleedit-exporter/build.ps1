param(
    [Parameter(Mandatory = $true)]
    [string]$PeggleEditRoot,
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'PeggleEditExporter.csproj'
$root = (Resolve-Path -LiteralPath $PeggleEditRoot).Path
$toolsProject = Join-Path $root 'src\IntelOrca.PeggleEdit.Tools\IntelOrca.PeggleEdit.Tools.csproj'
if (-not (Test-Path -LiteralPath $toolsProject)) {
    throw "PeggleEdit tools project not found below: $root"
}

$msbuild = Get-Command msbuild.exe -ErrorAction SilentlyContinue
if (-not $msbuild) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $install = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
        if ($install) {
            $candidate = Join-Path $install 'MSBuild\Current\Bin\MSBuild.exe'
            if (Test-Path -LiteralPath $candidate) { $msbuild = Get-Item $candidate }
        }
    }
}

$dotnetCandidates = @()
$systemDotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if ($systemDotnet) { $dotnetCandidates += $systemDotnet.Source }
$portableDotnet = Join-Path $PSScriptRoot '..\..\.tools\dotnet\dotnet.exe'
if (Test-Path -LiteralPath $portableDotnet) { $dotnetCandidates += (Resolve-Path -LiteralPath $portableDotnet).Path }
foreach ($dotnet in ($dotnetCandidates | Select-Object -Unique)) {
    $dotnetInfo = & $dotnet --list-sdks 2>$null
    if ($LASTEXITCODE -eq 0 -and $dotnetInfo) {
        & $dotnet build $project -c $Configuration -p:PeggleEditRoot=$root
        exit $LASTEXITCODE
    }
}

if ($msbuild) {
    $msbuildPath = if ($msbuild -is [System.Management.Automation.CommandInfo]) {
        $msbuild.Source
    } else {
        $msbuild.FullName
    }
    & $msbuildPath $project /restore /m /p:Configuration=$Configuration /p:PeggleEditRoot=$root
    exit $LASTEXITCODE
}

throw 'A modern Visual Studio MSBuild or .NET SDK with the .NET Framework 4.7.2 targeting pack is required.'
