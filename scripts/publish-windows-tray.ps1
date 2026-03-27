param(
    [string]$Configuration = "Release",
    [string]$Runtime = "win-x64"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$projectPath = Join-Path $repoRoot "windows-tray\CodexSwitch.Tray\CodexSwitch.Tray.csproj"
$outputPath = Join-Path $repoRoot "windows-tray\publish\$Runtime"

dotnet publish $projectPath `
    -c $Configuration `
    -r $Runtime `
    --self-contained false `
    -o $outputPath
