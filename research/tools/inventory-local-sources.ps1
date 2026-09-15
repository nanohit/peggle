param(
    [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '..\..\..'),
    [string]$Output = (Join-Path $PSScriptRoot '..\generated\local-source-inventory.json')
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$sourceSpecs = @(
    @{ Id = 'peggle-deluxe'; Directory = 'Peggle Deluxe'; Executable = 'Peggle.exe' },
    @{ Id = 'peggle-nights'; Directory = 'Peggle Nights'; Executable = 'PeggleNights.exe' },
    @{ Id = 'pego-deluxe-prototype'; Directory = 'Pego Deluxe'; Executable = 'Pego.exe' }
)

function Get-FileFact([string]$Path, [string]$BasePath) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $Path
    $basePrefix = [IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    $filePath = [IO.Path]::GetFullPath($item.FullName)
    if (-not $filePath.StartsWith($basePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Inventory file escaped its source directory: $filePath"
    }
    $relative = $filePath.Substring($basePrefix.Length).Replace('\', '/')
    [ordered]@{
        path = $relative
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        fileVersion = $item.VersionInfo.FileVersion
        productVersion = $item.VersionInfo.ProductVersion
    }
}

$sources = foreach ($spec in $sourceSpecs) {
    $sourcePath = Join-Path $workspace $spec.Directory
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        [ordered]@{ id = $spec.Id; directory = $spec.Directory; present = $false }
        continue
    }
    $resolvedSource = (Resolve-Path -LiteralPath $sourcePath).Path
    $files = @(Get-ChildItem -LiteralPath $resolvedSource -Recurse -File)
    $extensions = [ordered]@{}
    foreach ($group in ($files | Group-Object { if ($_.Extension) { $_.Extension.ToLowerInvariant() } else { '[none]' } } | Sort-Object Name)) {
        $extensions[$group.Name] = $group.Count
    }
    [ordered]@{
        id = $spec.Id
        directory = $spec.Directory
        present = $true
        fileCount = $files.Count
        totalBytes = ($files | Measure-Object Length -Sum).Sum
        extensions = $extensions
        executable = Get-FileFact (Join-Path $resolvedSource $spec.Executable) $resolvedSource
        mainArchive = Get-FileFact (Join-Path $resolvedSource 'main.pak') $resolvedSource
    }
}

$manifest = [ordered]@{
    format = 'peggle-source-inventory'
    version = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    workspace = $workspace
    sources = @($sources)
}

$outputPath = [IO.Path]::GetFullPath($Output)
$outputDirectory = Split-Path -Parent $outputPath
if ($outputDirectory) { New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null }
$json = $manifest | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($outputPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Output "wrote $outputPath"
