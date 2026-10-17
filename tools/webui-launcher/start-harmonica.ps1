#Requires -Version 5.1
<#
    Start the Harmonica Studio local server without opening a browser.

    Safe to call repeatedly: when something is already listening on the
    requested port the script simply exits and lets the launcher attach to it.

    Examples
        start-harmonica.ps1
        start-harmonica.ps1 -Port 4318
        start-harmonica.ps1 -Port 4318 -Data D:\Harmonica\data\rework-preview
        start-harmonica.ps1 -Url "harmonica://launch?port=4318"
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$Data = "",
    [string]$Url = "",
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"

$launcherDir = $PSScriptRoot
$appRoot = Split-Path -Parent (Split-Path -Parent $launcherDir)
$configPath = Join-Path $launcherDir "launcher.json"

# Defaults may live in launcher.json next to this script.
$config = @{ port = 4317; data = "" }
if (Test-Path -LiteralPath $configPath) {
    try {
        $raw = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($raw.port) { $config.port = [int]$raw.port }
        if ($raw.data) { $config.data = [string]$raw.data }
    } catch {
        Write-Warning "launcher.json could not be read; using built-in defaults."
    }
}

if ($Url -and $Url -match '[?&]port=(\d+)') { $Port = [int]$Matches[1] }
if (-not $Port -or $Port -le 0) { $Port = [int]$config.port }
if (-not $Data) { $Data = [string]$config.data }

function Test-LocalPort {
    param([int]$TargetPort)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect("127.0.0.1", $TargetPort, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

if (Test-LocalPort -TargetPort $Port) {
    Write-Host "Harmonica is already listening on port $Port."
    exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js was not found on PATH. Install Node.js 22 or newer and try again."
    exit 2
}

$logDir = Join-Path $launcherDir "logs"
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$stamp = Get-Date -Format "yyyyMMdd"
$outLog = Join-Path $logDir "server-$stamp.log"

$env:PORT = "$Port"
if ($Data) { $env:HARMONICA_DATA = $Data }

if ($Foreground) {
    Write-Host "Starting Harmonica on port $Port (foreground)..."
    & $node.Source server.mjs
    exit $LASTEXITCODE
}

Write-Host "Starting Harmonica on port $Port..."
Write-Host "  root: $appRoot"
if ($Data) { Write-Host "  data: $Data" }
Write-Host "  logs: $logDir"

# Start-Process in Windows PowerShell 5.1 throws "Item has already been added"
# when the environment block holds both NO_PROXY and no_proxy. Creating the
# process directly avoids that dictionary entirely: because we never touch
# ProcessStartInfo.EnvironmentVariables the child simply inherits the block.
$cmdLine = '"' + $node.Source + '" server.mjs > "' + $outLog + '" 2>&1'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:ComSpec
$psi.Arguments = '/c "' + $cmdLine + '"'
$psi.WorkingDirectory = $appRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
try {
    [void][System.Diagnostics.Process]::Start($psi)
} catch {
    Write-Error "Could not start the server: $($_.Exception.Message)"
    exit 3
}
exit 0
