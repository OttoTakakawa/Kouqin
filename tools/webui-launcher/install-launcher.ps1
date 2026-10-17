#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 4317,
    [string]$Data = ""
)

$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ($Data) {
    if (-not [System.IO.Path]::IsPathRooted($Data)) {
        $Data = Join-Path $appRoot $Data
    }
    if (-not (Test-Path -LiteralPath $Data -PathType Container)) {
        throw "Library directory does not exist: $Data"
    }
    $Data = (Resolve-Path -LiteralPath $Data).Path
}

@{ port = $Port; data = $Data } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $PSScriptRoot 'launcher.json') -Encoding UTF8
& (Join-Path $PSScriptRoot 'install-protocol.ps1')

$page = [System.Uri]::new((Join-Path $PSScriptRoot 'launch-harmonica.html'))
$launchUrl = $page.AbsoluteUri + "?port=$Port"
$desktopDir = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopDir 'Harmonica.url'
@("[InternetShortcut]", "URL=$launchUrl") |
    Set-Content -LiteralPath $shortcutPath -Encoding ASCII
Write-Host "Created desktop launcher: $shortcutPath"
Write-Host "Double-click Harmonica to start and open the app. No browser extension needed."
