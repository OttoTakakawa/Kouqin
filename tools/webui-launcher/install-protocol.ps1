#Requires -Version 5.1
<#
    Register (or remove) the harmonica:// URL protocol for the current user.

    The protocol lets a browser launcher or the Edge extension start the local
    Harmonica server without asking you to touch a terminal.

    Examples
        install-protocol.ps1              # register
        install-protocol.ps1 -Uninstall   # remove
        install-protocol.ps1 -Status      # show current registration
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Status
)

$ErrorActionPreference = "Stop"

$root = "HKCU:\Software\Classes\harmonica"
$handler = Join-Path $PSScriptRoot "launch-from-protocol.bat"

function Show-Status {
    if (-not (Test-Path -LiteralPath $root)) {
        Write-Host "harmonica:// is not registered."
        return
    }
    $command = ""
    try {
        $command = (Get-ItemProperty -LiteralPath "$root\shell\open\command" -ErrorAction Stop)."(default)"
    } catch {
        $command = "(command entry missing)"
    }
    Write-Host "harmonica:// is registered."
    Write-Host "  handler: $command"
    if (-not (Test-Path -LiteralPath $handler)) {
        Write-Host "  warning: $handler does not exist."
    }
}

if ($Status) {
    Show-Status
    exit 0
}

if ($Uninstall) {
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force
        Write-Host "Removed the harmonica:// protocol."
    } else {
        Write-Host "harmonica:// was not registered."
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $handler)) {
    Write-Error "Handler script not found: $handler"
    exit 2
}

New-Item -Path $root -Force | Out-Null
New-ItemProperty -LiteralPath $root -Name "(default)" -Value "URL:Harmonica Studio" -PropertyType String -Force | Out-Null
New-ItemProperty -LiteralPath $root -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null

New-Item -Path "$root\DefaultIcon" -Force | Out-Null
$icon = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "public\favicon.svg"
New-ItemProperty -LiteralPath "$root\DefaultIcon" -Name "(default)" -Value "$icon,0" -PropertyType String -Force | Out-Null

New-Item -Path "$root\shell\open\command" -Force | Out-Null
$command = '"' + $handler + '" "%1"'
New-ItemProperty -LiteralPath "$root\shell\open\command" -Name "(default)" -Value $command -PropertyType String -Force | Out-Null

Write-Host "Registered the harmonica:// protocol."
Write-Host "  handler: $command"
Write-Host ""
Write-Host "Try it: press Win+R and type  harmonica://launch"
