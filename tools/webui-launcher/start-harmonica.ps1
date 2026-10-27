#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateRange(0, 65535)][int]$Port = 0,
    [string]$Data = "",
    [string]$Url = "",
    [switch]$OpenBrowser,
    [switch]$Foreground,
    [ValidateRange(3, 120)][int]$StartupTimeoutSeconds = 25
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logPath = $null
$serverLogPath = $null
$startLock = $null
$ownsLock = $false
$requestId = $null
$statusPath = $null
$appUrl = $null

function Publish-LaunchState([string]$State, [string]$Message, [string]$Detail = "") {
    if (-not $statusPath) { return }
    $availableServerLog = $null
    if ($serverLogPath -and (Test-Path -LiteralPath $serverLogPath)) { $availableServerLog = $serverLogPath }
    $payload = @{ requestId = $requestId; state = $State; message = $Message; detail = $Detail;
        logPath = $logPath; serverLogPath = $availableServerLog; appUrl = $appUrl }
    $javascript = 'window.harmonicaLaunchStatus(' + ($payload | ConvertTo-Json -Compress) + ');'
    $temporary = "$statusPath.next"
    [IO.File]::WriteAllText($temporary, $javascript, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}

function Write-LaunchMessage([string]$Text) {
    Write-Host $Text
    if ($logPath) { Add-Content -LiteralPath $logPath -Value $Text -Encoding UTF8 }
    Publish-LaunchState "starting" $Text
}
function Test-LocalPort([int]$TargetPort) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect("127.0.0.1", $TargetPort, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(200)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false } finally { $client.Close() }
}
function Read-ServiceHealth {
    try {
        $request = [System.Net.HttpWebRequest]::Create("${appUrl}api/health")
        $request.Proxy = $null
        $request.Timeout = 1000
        $request.ReadWriteTimeout = 1000
        $response = $request.GetResponse()
        try {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
            try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
        } finally { $response.Close() }
    } catch { return $null }
}
function Assert-HarmonicaHealth($Health) {
    if (-not $Health -or $Health.ok -ne $true -or $Health.version -ne 1) {
        throw "端口 $Port 已被占用，但服务未通过 Harmonica 健康检查。请查看占用程序，不能直接当作启动成功。"
    }
    if ($Health.app -eq "harmonica-studio") {
        if (-not $Health.dataDirectory -or
            -not [string]::Equals([IO.Path]::GetFullPath($Health.dataDirectory).TrimEnd('\'), $Data.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            throw "端口 $Port 上的 Harmonica 使用了另一个曲库。当前需要：$Data；运行中：$($Health.dataDirectory)。未改动现有服务。"
        }
    } elseif (-not $Health.app -and $Health.legacyAutoSave -eq $true -and $null -ne $Health.libraryCount) {
        $html = (Invoke-WebRequest -UseBasicParsing -Uri $appUrl -TimeoutSec 2).Content
        if ($html -notmatch '<title>Harmonica') { throw "端口 $Port 不是 Harmonica 写谱台。" }
        Write-LaunchMessage "检测到旧版健康检查接口；复用正在运行的 Harmonica。下次正常启动会使用新版检查。"
    } else { throw "端口 $Port 返回的是其他程序，未启动第二个实例。" }
    foreach ($route in @("", "app.js")) {
        $request = [System.Net.HttpWebRequest]::Create($appUrl + $route)
        $request.Proxy = $null
        $request.Timeout = 2000
        $request.ReadWriteTimeout = 2000
        $page = $request.GetResponse()
        try {
            if ([int]$page.StatusCode -ne 200 -or $page.GetResponseStream().ReadByte() -lt 0) { throw "写谱台资源未就绪：$route" }
        } finally { $page.Close() }
    }
}
try {
    $logDir = Join-Path $PSScriptRoot "logs"
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $runId = "$stamp-" + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $logPath = Join-Path $logDir "launch-$runId.log"
    $serverLogPath = Join-Path $logDir "server-$runId.log"
    # 在读配置之前建立回执，配置损坏也能把原因送回书签页。
    if ($Url) {
        Add-Content -LiteralPath $logPath -Value "启动请求：$Url" -Encoding UTF8
        if ($Url -match '[?&]request=([^&]*)(?:&|$)') {
            $candidate = $Matches[1]
            if ($candidate -cnotmatch '^[a-f0-9]{32}$') { throw "启动请求编号无效。" }
            $requestId = $candidate
        }
        if ($requestId) { $statusPath = Join-Path $logDir "status-$requestId.js" }
        if ($Url -notmatch '^harmonica://launch/?(?:\?|$)') { throw "启动协议地址无效。" }
        if ($Url -match '[?&]port=(\d+)(?:&|$)') { $Port = [int]$Matches[1] }
    }
    Write-LaunchMessage "Harmonica 启动检查"
    Write-LaunchMessage "日志：$logPath"
    $config = @{ port = 4317; data = "" }
    $configPath = Join-Path $PSScriptRoot "launcher.json"
    if (Test-Path -LiteralPath $configPath) {
        try {
            $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -eq $raw.port -or [int]$raw.port -lt 1 -or [int]$raw.port -gt 65535) { throw "端口必须为 1-65535" }
            $config = @{ port = [int]$raw.port; data = [string]$raw.data }
        } catch { throw "启动配置 launcher.json 无效：$($_.Exception.Message)。没有回退到其他曲库。" }
    }
    if (-not $Port) { $Port = [int]$config.port }
    if ($Port -lt 1 -or $Port -gt 65535) { throw "端口必须为 1-65535。" }
    if (-not $Data) { $Data = [string]$config.data }
    if (-not $Data) {
        $Data = Join-Path $appRoot "data"
        if (-not (Test-Path -LiteralPath $Data)) { New-Item -ItemType Directory -Path $Data | Out-Null }
    }
    if (-not [IO.Path]::IsPathRooted($Data)) { $Data = Join-Path $appRoot $Data }
    if (-not (Test-Path -LiteralPath $Data -PathType Container)) { throw "曲库目录不存在：$Data。没有创建空曲库代替。" }
    $Data = (Resolve-Path -LiteralPath $Data).Path
    $appUrl = "http://127.0.0.1:$Port/"
    Write-LaunchMessage "曲库：$Data"
    Write-LaunchMessage "地址：$appUrl"
    Write-LaunchMessage "正在检查本机服务…"
    $startLock = New-Object System.Threading.Mutex($false, "Local\HarmonicaStudio.Start.$Port")
    try { $ownsLock = $startLock.WaitOne($StartupTimeoutSeconds * 1000) }
    catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
    if (-not $ownsLock) { throw "另一次启动仍在检查，请稍后再试。" }
    if (Test-LocalPort $Port) {
        Assert-HarmonicaHealth (Read-ServiceHealth)
        Write-LaunchMessage "Harmonica 已在运行，复用现有服务。"
    } else {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $node) { throw "未找到 Node.js，请安装 Node.js 22 或更高版本。" }
        $nodeVersion = (& $node.Source -p "process.versions.node")
        if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 22) { throw "需要 Node.js 22 或更高版本，当前：$nodeVersion" }
        foreach ($file in @("server.mjs", "public\model.mjs", "public\index.html")) {
            if (-not (Test-Path -LiteralPath (Join-Path $appRoot $file))) { throw "应用文件缺失：$file" }
        }
        $bundle = Join-Path $appRoot "dist\app.js"
        $sources = @(Get-ChildItem -LiteralPath (Join-Path $appRoot "public") -Filter '*.mjs' -File)
        $buildScript = Join-Path $appRoot "scripts\build.mjs"
        if (Test-Path -LiteralPath $buildScript) { $sources += Get-Item -LiteralPath $buildScript }
        $needsBuild = -not (Test-Path -LiteralPath $bundle)
        if (-not $needsBuild) { $needsBuild = @($sources | Where-Object { $_.LastWriteTimeUtc -gt (Get-Item -LiteralPath $bundle).LastWriteTimeUtc }).Count -gt 0 }
        if ($needsBuild) {
            if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules\esbuild'))) { throw "前端需要构建，但依赖未安装。请在项目目录运行 npm ci 后重试。" }
            Write-LaunchMessage "正在更新写谱台资源…"
            Push-Location -LiteralPath $appRoot
            try {
                & $node.Source $buildScript 2>&1 | ForEach-Object { Write-LaunchMessage "$_" }
                if ($LASTEXITCODE -ne 0) { throw "前端构建失败，请查看本次日志。" }
            } finally { Pop-Location }
            if (-not (Test-Path -LiteralPath $bundle)) { throw "前端构建没有生成 dist/app.js。" }
        }
        $env:PORT = "$Port"
        $env:HARMONICA_DATA = $Data
        if ($Foreground) {
            if ($OpenBrowser) { throw "前台调试模式不能与自动打开浏览器一起使用。" }
            $startLock.ReleaseMutex(); $ownsLock = $false
            Push-Location -LiteralPath $appRoot
            try { & $node.Source server.mjs; if ($LASTEXITCODE -ne 0) { throw "前台服务退出：$LASTEXITCODE" } }
            finally { Pop-Location }
            exit 0
        }
        Write-LaunchMessage "正在启动本机服务…"
        Write-LaunchMessage "服务输出：$serverLogPath"
        # 不访问 EnvironmentVariables，保留对 WinPS 5.1 重复代理环境变量的兼容。
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $env:ComSpec
        $psi.Arguments = '/d /s /c ""' + $node.Source + '" "server.mjs" >> "' + $serverLogPath + '" 2>&1"'
        $psi.WorkingDirectory = $appRoot
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $child = [System.Diagnostics.Process]::Start($psi)
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $ready = $false
        while ($timer.Elapsed.TotalSeconds -lt $StartupTimeoutSeconds) {
            if ($child.HasExited) { throw "服务启动后退出，退出码 $($child.ExitCode)。请查看日志中的具体报错。" }
            $health = Read-ServiceHealth
            if ($health) { Assert-HarmonicaHealth $health; $ready = $true; break }
            Start-Sleep -Milliseconds 200
        }
        if (-not $ready) { throw "等待服务就绪超时（$StartupTimeoutSeconds 秒）。请查看日志后重试。" }
        Write-LaunchMessage "服务和写谱台资源均已就绪。"
    }
    $startLock.ReleaseMutex(); $ownsLock = $false
    Publish-LaunchState "ready" "写谱台已就绪"
    if ($OpenBrowser) {
        Write-LaunchMessage "正在打开写谱台…"
        $browser = New-Object System.Diagnostics.ProcessStartInfo
        $browser.FileName = $appUrl
        $browser.UseShellExecute = $true
        [void][System.Diagnostics.Process]::Start($browser)
    }
    exit 0
} catch {
    $message = "启动失败：$($_.Exception.Message)"
    $detail = ""
    Write-Host $message -ForegroundColor Red
    if ($serverLogPath -and (Test-Path -LiteralPath $serverLogPath)) {
        try {
            $detail = (Get-Content -LiteralPath $serverLogPath -Tail 40 -Encoding UTF8) -join "`n"
            foreach ($line in ($detail -split "`n")) { Write-LaunchMessage $line }
        } catch {}
        Write-Host "服务输出：$serverLogPath"
    }
    if ($logPath) {
        try { Add-Content -LiteralPath $logPath -Value $message -Encoding UTF8 } catch {}
        Write-Host "日志：$logPath"
    }
    try { Publish-LaunchState "error" $message $detail } catch { Write-Host "无法写入启动回执：$($_.Exception.Message)" }
    exit 1
} finally {
    if ($ownsLock) { $startLock.ReleaseMutex() }
    if ($startLock) { $startLock.Dispose() }
}
