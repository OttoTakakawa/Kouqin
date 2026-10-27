#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(0, 65535)][int]$Port = 0,
    [string]$Data = "",
    [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop')
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$configPath = Join-Path $PSScriptRoot 'launcher.json'
$existing = @{ port = 4317; data = "" }
if (Test-Path -LiteralPath $configPath) {
    $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$existing.port -lt 1 -or [int]$existing.port -gt 65535) { throw "launcher.json 端口无效，没有覆盖已有配置。" }
}
if (-not $Port) { $Port = [int]$existing.port }
if (-not $PSBoundParameters.ContainsKey('Data')) { $Data = [string]$existing.data }
if ($Data) {
    if (-not [IO.Path]::IsPathRooted($Data)) { $Data = Join-Path $appRoot $Data }
    if (-not (Test-Path -LiteralPath $Data -PathType Container)) { throw "曲库目录不存在：$Data" }
    $Data = (Resolve-Path -LiteralPath $Data).Path
}
if (-not (Test-Path -LiteralPath $DesktopDirectory -PathType Container)) { throw "桌面目录不存在：$DesktopDirectory" }
$entry = Join-Path $PSScriptRoot 'open-harmonica.cmd'
if (-not (Test-Path -LiteralPath $entry)) { throw "本机启动入口缺失：$entry" }
$backup = Join-Path $PSScriptRoot ('logs\install-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$shortcutPath = Join-Path $DesktopDirectory 'Harmonica.lnk'
$oldUrl = Join-Path $DesktopDirectory 'Harmonica.url'
foreach ($file in @($configPath, $shortcutPath, $oldUrl)) {
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination $backup -Force }
}
$shell = New-Object -ComObject WScript.Shell
$temporaryLink = Join-Path $DesktopDirectory ('Harmonica-' + [Guid]::NewGuid().ToString('N') + '.lnk')
$shortcut = $shell.CreateShortcut($temporaryLink)
$shortcut.TargetPath = $env:ComSpec
$shortcut.Arguments = '/d /c ""' + $entry + '""'
$shortcut.WorkingDirectory = $appRoot
$shortcut.Description = 'Harmonica 本机写谱台：检查服务后打开，失败保留错误窗口'
$shortcut.WindowStyle = 1
$shortcut.Save()
$check = $shell.CreateShortcut($temporaryLink)
if (-not $check.TargetPath -or $check.Arguments -notmatch 'open-harmonica\.cmd') { throw "快捷方式校验失败，旧入口未移除。" }
$configTemporary = "$configPath.next"
@{ port = $Port; data = $Data } | ConvertTo-Json | Set-Content -LiteralPath $configTemporary -Encoding UTF8
Move-Item -LiteralPath $configTemporary -Destination $configPath -Force
Move-Item -LiteralPath $temporaryLink -Destination $shortcutPath -Force
if (Test-Path -LiteralPath $oldUrl) { Remove-Item -LiteralPath $oldUrl }
Write-Host "已创建本机启动入口：$shortcutPath"
Write-Host "配置：端口 $Port，曲库 $Data"
Write-Host "旧入口与配置备份：$backup"
Write-Host "双击桌面 Harmonica 即可启动，不需要浏览器协议授权。"
