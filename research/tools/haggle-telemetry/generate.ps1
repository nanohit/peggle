param(
    [Parameter(Mandatory = $true)]
    [string]$HaggleRoot,
    [ValidateSet('vs2022')]
    [string]$Action = 'vs2022'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $HaggleRoot).Path
$premake = Join-Path $root 'tools\premake5.exe'
$haggleSource = Join-Path $root 'src\haggle\main.cpp'
$minHookHeader = Join-Path $root 'deps\minhook\include\MinHook.h'
if (-not (Test-Path -LiteralPath $premake -PathType Leaf)) {
    throw "Haggle premake executable not found: $premake"
}
if (-not (Test-Path -LiteralPath $haggleSource -PathType Leaf)) {
    throw "Haggle source not found below: $root"
}
if (-not (Test-Path -LiteralPath $minHookHeader -PathType Leaf)) {
    throw "Haggle MinHook submodule is missing; run git submodule update --init --recursive in $root"
}

$premakeFile = Join-Path $PSScriptRoot 'premake5.lua'
& $premake "--file=$premakeFile" "--haggle-root=$root" $Action
exit $LASTEXITCODE
