[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AntigravityPlus'),
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$CliArgs
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
$activeRoot = if (Test-Path -LiteralPath (Join-Path $InstallRoot 'src\main\cli.cjs')) {
    [System.IO.Path]::GetFullPath($InstallRoot)
} else {
    [System.IO.Path]::GetFullPath($repoRoot)
}

$jsExe = $null
$useElectronNode = $false
$nodeCmd = if ($env:AGY_FORCE_ELECTRON_NODE -ne '1') { Get-Command node.exe -ErrorAction SilentlyContinue } else { $null }
if ($nodeCmd -and $nodeCmd.Source -and ($nodeCmd.Source -notmatch '(?i)\\Programs\\antigravity\\')) {
    $jsExe = $nodeCmd.Source
} else {
    $receiptFile = Join-Path $activeRoot 'install-receipt.json'
    $receiptExe = ''
    if (Test-Path -LiteralPath $receiptFile) {
        try {
            $rObj = Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($rObj.antigravityExePath -and (Test-Path -LiteralPath $rObj.antigravityExePath)) {
                $receiptExe = $rObj.antigravityExePath
            }
        } catch {}
    }
    $agyExe = if ($receiptExe) {
        $receiptExe
    } elseif ($env:AGY_EXE_PATH -and (Test-Path -LiteralPath $env:AGY_EXE_PATH)) {
        $env:AGY_EXE_PATH
    } else {
        Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'
    }
    if (Test-Path -LiteralPath $agyExe) {
        $jsExe = $agyExe
        $useElectronNode = $true
    }
}
if (-not $jsExe) {
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

function Invoke-Cli([string[]]$Arguments) {
    $cliPath = Join-Path $activeRoot 'src\main\cli.cjs'
    $psi = New-Object System.Diagnostics.ProcessStartInfo($jsExe)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.WorkingDirectory = $activeRoot
    $psi.EnvironmentVariables['AGY_PLUS_ROOT'] = $activeRoot
    [void]$psi.EnvironmentVariables.Remove('NODE_OPTIONS')
    if ($useElectronNode) { $psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' } else { [void]$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') }
    $allArgs = @($cliPath) + @($Arguments)
    $psi.Arguments = (($allArgs | ForEach-Object { Quote-WinArg ([string]$_) }) -join ' ')
    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $proc.WaitForExit()
        $stdoutText = $outTask.GetAwaiter().GetResult().Trim()
        $stderrText = $errTask.GetAwaiter().GetResult().Trim()
        return @{
            ExitCode = [int]$proc.ExitCode
            Output = if ($stdoutText) { $stdoutText } else { $stderrText }
        }
    } finally {
        $proc.Dispose()
    }
}

if ($CliArgs -and $CliArgs.Count -gt 0) {
    $res = Invoke-Cli -Arguments $CliArgs
    if ($res.Output) { Write-Output $res.Output }
    exit $res.ExitCode
}

$featureDefs = @(
    @{ Key = 'codexTheme'; Label = 'Codex 极简桌面排版主题' },
    @{ Key = 'contextRing'; Label = '上下文窗口进度圆环' },
    @{ Key = 'performancePill'; Label = '任务耗时与 Avg tok/s 速率胶囊' },
    @{ Key = 'quotaSplitRing'; Label = '5 小时 / 周双半环配额指示器' },
    @{ Key = 'autoHighestModel'; Label = '空白新对话自动锁定最高旗舰模型' },
    @{ Key = 'navigationGestures'; Label = '鼠标侧键与右键四向手势' },
    @{ Key = 'newWindowMenu'; Label = 'Window 菜单新建独立窗口 (Ctrl+Shift+N)' },
    @{ Key = 'thoughtTranslation'; Label = 'Thinking 思考过程实时流式中文化' },
    @{ Key = 'titleTranslation'; Label = '侧边栏与顶栏英文对话标题中文化' },
    @{ Key = 'taskToast'; Label = '右下角无抢焦交互式任务弹窗' },
    @{ Key = 'externalBrowser'; Label = '优先使用外部浏览器打开链接' },
    @{ Key = 'localProxy'; Label = '进程级本地代理与残留环境清理 (下次启动生效)' },
    @{ Key = 'fastpushFix'; Label = 'language_server 流式断连修复 (下次启动生效)' },
    @{ Key = 'chineseExecutionRule'; Label = '全局默认简体中文沟通规则 (~/.gemini/config/rules)' },
    @{ Key = 'workspaceScriptsRule'; Label = '全局禁止 C 盘临时脚本规则 (~/.gemini/config/rules)' }
)

while ($true) {
    $cfgRes = Invoke-Cli -Arguments @('config')
    if ($cfgRes.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($cfgRes.Output)) {
        throw ("读取配置失败: " + $cfgRes.Output)
    }
    $rawCfg = $cfgRes.Output | ConvertFrom-Json
    $cfg = $rawCfg.config
    $offlineResolved = [string]$rawCfg.offlineRootResolved

    Clear-Host
    Write-Host "==============================================================" -ForegroundColor Cyan
    Write-Host "            Antigravity Plus 功能开关控制台" -ForegroundColor Cyan
    Write-Host "  运行时目录: $activeRoot" -ForegroundColor DarkGray
    Write-Host "==============================================================" -ForegroundColor Cyan
    for ($i = 0; $i -lt $featureDefs.Count; $i++) {
        $item = $featureDefs[$i]
        $val = [bool]$cfg.features.($item.Key)
        $num = ($i + 1).ToString().PadLeft(2, ' ')
        $badge = if ($val) { '[开启]' } else { '[关闭]' }
        $color = if ($val) { 'Green' } else { 'DarkGray' }
        Write-Host ("  {0}. " -f $num) -NoNewline
        Write-Host $badge -ForegroundColor $color -NoNewline
        Write-Host (" {0}" -f $item.Label)
    }
    Write-Host "--------------------------------------------------------------" -ForegroundColor DarkGray
    $offlineTag = if ($offlineResolved) { "已就绪 ($offlineResolved)" } else { '未安装可选离线包' }
    Write-Host ("  [M] 切换翻译引擎模式   当前: {0}  |  离线模型: {1}" -f $cfg.translation.mode, $offlineTag)
    Write-Host ("  [P] 设置本地代理地址   当前: {0}" -f ($(if ($cfg.network.proxyUrl) { $cfg.network.proxyUrl } else { '(未配置/直连)' })))
    Write-Host ("  [S] 查看实时桥接状态   [A] 全部开启   [D] 全部关闭   [Q] 退出")
    Write-Host "==============================================================" -ForegroundColor Cyan
    $rawChoice = Read-Host "请输入编号 (1-15) 或快捷键并回车"
    if ($null -eq $rawChoice) { break }
    $choice = $rawChoice.Trim()

    if ($choice -match '^(?i)q$') { break }
    if ($choice -match '^\d+$') {
        $idx = [int]$choice - 1
        if ($idx -ge 0 -and $idx -lt $featureDefs.Count) {
            Invoke-Cli -Arguments @('toggle', $featureDefs[$idx].Key) | Out-Null
            continue
        }
    }
    switch ($choice.ToUpperInvariant()) {
        'M' {
            $nextMode = switch ($cfg.translation.mode) {
                'hybrid' { 'online' }
                'online' { 'offline' }
                default  { 'hybrid' }
            }
            Invoke-Cli -Arguments @('set-mode', $nextMode) | Out-Null
        }
        'P' {
            $rawProxy = Read-Host "输入代理地址 (例如 http://127.0.0.1:7897，直接回车清空)"
            if ($null -ne $rawProxy) {
                Invoke-Cli -Arguments @('set-proxy', $rawProxy.Trim()) | Out-Null
            }
        }
        'A' {
            Invoke-Cli -Arguments @('enable-all') | Out-Null
        }
        'D' {
            Invoke-Cli -Arguments @('disable-all') | Out-Null
        }
        'S' {
            Clear-Host
            Write-Host (Invoke-Cli -Arguments @('status')).Output
            Write-Host ""
            [void](Read-Host "按回车键返回菜单")
        }
    }
}
