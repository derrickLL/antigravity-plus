[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AntigravityPlus'),
    [string]$ReportPath = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $PSBoundParameters.ContainsKey('InstallRoot')) {
    $selfReceipt = Join-Path $repoRoot 'install-receipt.json'
    $isSelfSourceRepo = (Test-Path -LiteralPath (Join-Path $repoRoot '.git')) -or
                        (Test-Path -LiteralPath (Join-Path $repoRoot 'tests\run-all-tests.cjs'))
    if ((-not $isSelfSourceRepo) -and (Test-Path -LiteralPath $selfReceipt)) {
        $InstallRoot = $repoRoot
    }
}
$activeRoot = if (Test-Path -LiteralPath (Join-Path $InstallRoot 'src\core\config-manager.cjs')) {
    [System.IO.Path]::GetFullPath($InstallRoot)
} else {
    [System.IO.Path]::GetFullPath($repoRoot)
}
if (-not $ReportPath) {
    $ReportPath = Join-Path $activeRoot 'logs\cloud-permissions-check.json'
}

$receiptFile = Join-Path $activeRoot 'install-receipt.json'
$resourcesDir = Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources'
$agyExePath = Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'
if (Test-Path -LiteralPath $receiptFile) {
    try {
        $rec = Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($rec.antigravityResourcesDir -and (Test-Path -LiteralPath $rec.antigravityResourcesDir)) {
            $resourcesDir = [System.IO.Path]::GetFullPath([string]$rec.antigravityResourcesDir)
        }
        if ($rec.antigravityExePath -and (Test-Path -LiteralPath $rec.antigravityExePath)) {
            $agyExePath = [System.IO.Path]::GetFullPath([string]$rec.antigravityExePath)
        }
    } catch {}
}

$backendPath = Join-Path $resourcesDir 'bin\language_server.exe'
$backends = @(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" |
    Where-Object { $_.ExecutablePath -eq $backendPath -and $_.CommandLine -match '--standalone' })
if ($backends.Count -lt 1) {
    throw '未检测到正在运行的 Antigravity standalone language_server.exe，请先启动 Antigravity。'
}
$backend = $backends | Select-Object -Last 1
$csrfMatch = [regex]::Match($backend.CommandLine, '--csrf_token(?:=|\s+)([^\s"]+)')
if (-not $csrfMatch.Success) {
    throw '无法从 language_server 命令行提取回环 CSRF 令牌。'
}

$mainLog = Join-Path $env:APPDATA 'Antigravity\logs\main.log'
if (-not (Test-Path -LiteralPath $mainLog)) {
    throw "未找到日志文件: $mainLog"
}
$tailText = (Get-Content -LiteralPath $mainLog -Tail 150) -join "`n"
$portMatches = [regex]::Matches($tailText, 'Local:\s+https://127\.0\.0\.1:(\d+)')
if ($portMatches.Count -eq 0) {
    throw '未在 main.log 中找到本地回环 HTTPS 端口。'
}
$localPort = [int]$portMatches[$portMatches.Count - 1].Groups[1].Value

$jsExe = $null
$useElectronNode = $false
$nodeCmd = if ($env:AGY_FORCE_ELECTRON_NODE -ne '1') { Get-Command node.exe -ErrorAction SilentlyContinue } else { $null }
if ($nodeCmd -and $nodeCmd.Source -and ($nodeCmd.Source -notmatch '(?i)\\Programs\\antigravity\\')) {
    $jsExe = $nodeCmd.Source
} elseif (Test-Path -LiteralPath $agyExePath) {
    $jsExe = $agyExePath
    $useElectronNode = $true
} else {
    throw '未找到 Node.js 或 Antigravity.exe。'
}

function Quote-WinArg([string]$Arg) {
    if ($null -eq $Arg) { return '""' }
    if ($Arg.Length -gt 0 -and $Arg -notmatch '[\s"]') { return $Arg }
    $sb = New-Object System.Text.StringBuilder '"'
    $slashes = 0
    foreach ($ch in $Arg.ToCharArray()) {
        if ($ch -eq '\') { $slashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append('\', $slashes * 2 + 1)
            [void]$sb.Append('"')
        } else {
            [void]$sb.Append('\', $slashes)
            [void]$sb.Append($ch)
        }
        $slashes = 0
    }
    [void]$sb.Append('\', $slashes * 2)
    [void]$sb.Append('"')
    return $sb.ToString()
}

$probeJs = "const https=require('node:https'),cm=require('./src/core/config-manager.cjs'),rt=require('./src/core/runtime.cjs');const cfg=cm.loadConfig({installRoot:process.env.AGY_PLUS_ROOT});const rp=rt.resolveProxyUrl(cfg);let pp=0;try{if(rp&&rp.url)pp=Number(new URL(rp.url).port)||0;}catch{}const req=https.request({hostname:'127.0.0.1',port:Number(process.env.AGY_PROBE_PORT),path:'/exa.language_server_pb.LanguageServerService/GetPermissionSettings',method:'POST',rejectUnauthorized:false,agent:false,headers:{'x-codeium-csrf-token':process.env.AGY_PROBE_CSRF||'','Connect-Protocol-Version':'1','Content-Type':'application/json','Content-Length':'2'},timeout:15000},res=>{let body='';res.setEncoding('utf8');res.on('data',d=>{body+=d;});res.on('end',()=>{console.log(JSON.stringify({statusCode:res.statusCode,body,proxyPort:pp,proxySource:rp.source}));});});req.on('timeout',()=>{req.destroy(new Error('HTTP timeout'));});req.on('error',err=>{console.log(JSON.stringify({statusCode:0,body:String(err.message||err),proxyPort:pp,proxySource:rp.source}));});req.end('{}');"

$psi = New-Object System.Diagnostics.ProcessStartInfo($jsExe)
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$psi.WorkingDirectory = $activeRoot
$psi.EnvironmentVariables['AGY_PLUS_ROOT'] = $activeRoot
$psi.EnvironmentVariables['AGY_PROBE_PORT'] = [string]$localPort
$psi.EnvironmentVariables['AGY_PROBE_CSRF'] = $csrfMatch.Groups[1].Value
[void]$psi.EnvironmentVariables.Remove('NODE_OPTIONS')
if ($useElectronNode) { $psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' } else { [void]$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') }
$psi.Arguments = "-e " + (Quote-WinArg $probeJs)
$proc = [System.Diagnostics.Process]::Start($psi)
try {
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(20000)) {
        try { $proc.Kill() } catch {}
        throw '云端权限探测超时。'
    }
    $probeOut = $outTask.GetAwaiter().GetResult().Trim()
    $probeErr = $errTask.GetAwaiter().GetResult().Trim()
    if ($proc.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($probeOut)) {
        throw "云端权限探测失败 (exit=$($proc.ExitCode)): $probeErr"
    }
} finally {
    $proc.Dispose()
}

$parsed = $probeOut | ConvertFrom-Json
$proxyPort = [int]$parsed.proxyPort
$connections = @()
if ($proxyPort -gt 0) {
    $connections = @(Get-NetTCPConnection -OwningProcess $backend.ProcessId -ErrorAction SilentlyContinue |
        Where-Object { $_.RemotePort -eq $proxyPort })
}

$report = [ordered]@{
    CheckedAt = [DateTimeOffset]::Now.ToString('o')
    BackendPid = $backend.ProcessId
    ReadOnlyMethod = 'GetPermissionSettings'
    HttpStatus = [int]$parsed.statusCode
    CloudPermissionsReadable = ([int]$parsed.statusCode -eq 200)
    LoginScopeInsufficient = ([string]$parsed.body -match 'insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT')
    FastpushOverrideArgumentPresent = ($backend.CommandLine -match '--remote_agent_fastpush_override(?:=|\s+)false')
    ConfiguredProxyPort = $proxyPort
    LocalProxyConnectionCount = @($connections | Where-Object { $_.RemoteAddress -in @('127.0.0.1', '::1') }).Count
    IncorrectProxyConnectionCount = @($connections | Where-Object { $_.RemoteAddress -notin @('127.0.0.1', '::1') }).Count
}

$json = $report | ConvertTo-Json -Depth 4
$reportParent = Split-Path -Parent $ReportPath
if ($reportParent -and -not (Test-Path -LiteralPath $reportParent)) {
    New-Item -ItemType Directory -Path $reportParent -Force | Out-Null
}
[System.IO.File]::WriteAllText($ReportPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $json
