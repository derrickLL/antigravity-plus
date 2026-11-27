[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AntigravityPlus'),
    [string]$AntigravityResourcesDir = (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources'),
    [string]$GeminiConfigDir = (Join-Path $HOME '.gemini\config'),
    [switch]$SkipSystemRegistration,
    [switch]$KeepConfigAndCache,
    [switch]$NoRestoreLegacy,
    [switch]$PurgeBackups
)
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "[Antigravity Plus 卸载] $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-WarnMsg([string]$Message) {
    Write-Host "  [提示] $Message" -ForegroundColor Yellow
}

function Resolve-CleanFullPath([string]$RawPath) {
    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RawPath)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($root -and $full.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { return $full }
    return $full.TrimEnd('\', '/')
}

function Normalize-DirPath([string]$PathValue) {
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
    return (Resolve-CleanFullPath $PathValue).ToLowerInvariant()
}

$repoRoot = Resolve-CleanFullPath (Split-Path -Parent $PSScriptRoot)
if (-not $PSBoundParameters.ContainsKey('InstallRoot')) {
    $selfReceipt = Join-Path $repoRoot 'install-receipt.json'
    $isSelfSourceRepo = (Test-Path -LiteralPath (Join-Path $repoRoot '.git')) -or
                        (Test-Path -LiteralPath (Join-Path $repoRoot 'tests\run-all-tests.cjs'))
    if ((-not $isSelfSourceRepo) -and (Test-Path -LiteralPath $selfReceipt)) {
        $InstallRoot = $repoRoot
    }
}

$resolvedInstall = Resolve-CleanFullPath $InstallRoot
$resolvedResources = Resolve-CleanFullPath $AntigravityResourcesDir
$resolvedGeminiCfg = Resolve-CleanFullPath $GeminiConfigDir
$isSelfInstalledRun = ($repoRoot.ToLowerInvariant() -eq $resolvedInstall.ToLowerInvariant()) -and
                      (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) -and
                      (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'tests\run-all-tests.cjs'))) -and
                      ([bool]$env:AGY_UNINSTALL_FROM_CMD) -and
                      ((Normalize-DirPath $env:AGY_UNINSTALL_FROM_CMD) -eq (Normalize-DirPath (Join-Path $resolvedInstall 'Uninstall.cmd')))

# Verify InstallRoot ownership and receipt-to-client binding BEFORE touching or deleting anything
$receiptPath = Join-Path $resolvedInstall 'install-receipt.json'
$hasReceipt = Test-Path -LiteralPath $receiptPath
$receiptObj = $null
if ($hasReceipt) {
    try {
        $receiptObj = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "卸载安全拦截：无法解析安装回执 $receiptPath，已中止卸载以防误删。"
    }
    if ($receiptObj -and $receiptObj.installRoot) {
        if ((Normalize-DirPath $receiptObj.installRoot) -ne (Normalize-DirPath $resolvedInstall)) {
            throw "卸载安全拦截：安装回执记录的运行时目录 ($($receiptObj.installRoot)) 与目标 -InstallRoot ($resolvedInstall) 不匹配，拒绝卸载！"
        }
    }
    if ($receiptObj -and $receiptObj.antigravityResourcesDir) {
        if (-not $PSBoundParameters.ContainsKey('AntigravityResourcesDir')) {
            $resolvedResources = [System.IO.Path]::GetFullPath([string]$receiptObj.antigravityResourcesDir)
        } elseif ((Normalize-DirPath $receiptObj.antigravityResourcesDir) -ne (Normalize-DirPath $resolvedResources)) {
            throw "卸载安全拦截：运行时目录 $resolvedInstall 的安装回执绑定于客户端目录 $($receiptObj.antigravityResourcesDir)，与传入的 -AntigravityResourcesDir ($resolvedResources) 不一致，已中止跨实例卸载！"
        }
    }
    if ($receiptObj -and $receiptObj.geminiConfigDir -and (-not $PSBoundParameters.ContainsKey('GeminiConfigDir'))) {
        $resolvedGeminiCfg = [System.IO.Path]::GetFullPath([string]$receiptObj.geminiConfigDir)
    }
}

$hasCoreMarker = (Test-Path -LiteralPath (Join-Path $resolvedInstall 'src\core\patch-antigravity.cjs')) -and
                 (Test-Path -LiteralPath (Join-Path $resolvedInstall 'config\config.default.json'))
if ((Test-Path -LiteralPath $resolvedInstall) -and -not $hasReceipt -and -not $hasCoreMarker) {
    $existingItems = @(Get-ChildItem -LiteralPath $resolvedInstall -Force -ErrorAction SilentlyContinue)
    if ($existingItems.Count -gt 0) {
        throw "卸载安全拦截：目录 $resolvedInstall 不包含 Antigravity Plus 部署回执 (install-receipt.json) 或核心标识文件，拒绝执行卸载与删除！"
    }
}

$scriptBase = if (Test-Path -LiteralPath (Join-Path $resolvedInstall 'src\core\patch-antigravity.cjs')) {
    $resolvedInstall
} else {
    $repoRoot
}

$jsExe = $null
$useElectronNode = $false
$nodeCmd = if ($env:AGY_FORCE_ELECTRON_NODE -ne '1') { Get-Command node.exe -ErrorAction SilentlyContinue } else { $null }
if ($nodeCmd -and $nodeCmd.Source -and ($nodeCmd.Source -notmatch '(?i)\\Programs\\antigravity\\')) {
    $jsExe = $nodeCmd.Source
} else {
    foreach ($cand in @(
        (Join-Path (Split-Path -Parent $resolvedResources) 'Antigravity.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe')
    )) {
        if ($cand -and (Test-Path -LiteralPath $cand)) {
            $jsExe = $cand
            $useElectronNode = $true
            break
        }
    }
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

function Invoke-UninstallJs([string]$ScriptFile, [string[]]$ArgsList = @(), [switch]$Required) {
    if (-not $jsExe -or -not (Test-Path -LiteralPath $ScriptFile)) {
        if ($Required) { return 4 }
        return 0
    }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo($jsExe)
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.EnvironmentVariables['AGY_PLUS_ROOT'] = $resolvedInstall
        [void]$psi.EnvironmentVariables.Remove('NODE_OPTIONS')
        if ($useElectronNode) { $psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1' } else { [void]$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') }
        $allArgs = @($ScriptFile) + @($ArgsList)
        $psi.Arguments = (($allArgs | ForEach-Object { Quote-WinArg ([string]$_) }) -join ' ')
        $proc = [System.Diagnostics.Process]::Start($psi)
        try {
            [void]$proc.StandardOutput.ReadToEndAsync()
            [void]$proc.StandardError.ReadToEndAsync()
            if (-not $proc.WaitForExit(15000)) {
                try { $proc.Kill() } catch {}
                return 1
            }
            return [int]$proc.ExitCode
        } finally {
            $proc.Dispose()
        }
    } catch {
        return 1
    }
}

$installPrefix = $resolvedInstall.TrimEnd('\') + '\'

Write-Step "1/5 移除开机自启项与自动更新守护计划任务（先于还原防止 5 分钟守护抢跑）..."
if (-not $SkipSystemRegistration) {
    try {
        $runRegPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        $curRunVal = (Get-ItemProperty -Path $runRegPath -Name 'AntigravityPlus' -ErrorAction SilentlyContinue).AntigravityPlus
        if ($curRunVal -and ($curRunVal.IndexOf($installPrefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
            Remove-ItemProperty -Path $runRegPath -Name 'AntigravityPlus' -ErrorAction SilentlyContinue
        }
    } catch {}
    try {
        $taskObj = Get-ScheduledTask -TaskName 'Antigravity-Plus-Guard' -ErrorAction SilentlyContinue
        if ($taskObj) {
            $taskArgsStr = (($taskObj.Actions | ForEach-Object { [string]$_.Arguments }) -join ' ')
            if ($taskArgsStr -and ($taskArgsStr.IndexOf($installPrefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
                Unregister-ScheduledTask -TaskName 'Antigravity-Plus-Guard' -Confirm:$false -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}
Write-Ok "系统自启项与计划任务已清理。"

Write-Step "2/5 移除打开窗口中的前端 UI 并关闭后台守护与通知宿主 ..."
$cliScript = Join-Path $scriptBase 'src\main\cli.cjs'
Invoke-UninstallJs -ScriptFile $cliScript -ArgsList @('remove') | Out-Null

# 先停 watch.cjs，再优雅关闭 TaskToastHost.exe，避免守护进程重拉起弹窗
try {
    $watchMarker = Join-Path $resolvedInstall 'src\main\watch.cjs'
    $vbsMarker = Join-Path $resolvedInstall 'bin\Start-Watcher.vbs'
    $watchProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and (
            $_.CommandLine.IndexOf($watchMarker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $_.CommandLine.IndexOf($vbsMarker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        )
    }
    foreach ($wp in $watchProcs) {
        Stop-Process -Id $wp.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}

$shutdownToastJs = Join-Path $scriptBase 'src\toast\toast-client.cjs'
if ($jsExe -and (Test-Path -LiteralPath $shutdownToastJs)) {
    Invoke-UninstallJs -ScriptFile $shutdownToastJs -ArgsList @('shutdown') | Out-Null
}
Start-Sleep -Milliseconds 200
try {
    Get-Process -Name 'TaskToastHost' -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq 'TaskToastHost.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    }
    foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}
Write-Ok "前端 UI 与后台守护进程已停止。"

Write-Step "3/5 还原 Antigravity 官方原版 app.asar ..."
$patchScript = Join-Path $scriptBase 'src\core\patch-antigravity.cjs'
$restoreExit = Invoke-UninstallJs -ScriptFile $patchScript -ArgsList @('--target', $resolvedResources, '--install-root', $resolvedInstall, '--restore') -Required
if ($restoreExit -eq 3) {
    Write-WarnMsg "检测到 Antigravity.exe 正在运行并占用 app.real.asar。请先关闭 Antigravity 客户端，然后重新运行 Uninstall.cmd 即可完成归档还原。"
    exit 3
}
if ($restoreExit -eq 4) {
    throw "还原客户端目录失败 (exit=4)：未找到可用的 Node.js / Antigravity.exe 或核心还原脚本 $patchScript，已中止后续删除以保护现场。"
}
if ($restoreExit -ne 0) {
    throw "还原客户端目录失败 (exit=$restoreExit)：目标 resources\app 包含非 Antigravity Plus 文件或归属不匹配，已中止后续删除以保护现场。"
}
Write-Ok "Antigravity 客户端目录已恢复至 100% 官方原版状态。"

Write-Step "4/5 移除 ~/.gemini/config 插件与可开关规则（并按需恢复旧版备份）..."
$pluginDir = Join-Path $resolvedGeminiCfg 'plugins\task-completion-toast'
$rootJsonNorm = (ConvertTo-Json $resolvedInstall -Compress).ToLowerInvariant()
$rootSingleQuotedNorm = ("'" + ($resolvedInstall -replace '\\', '\\\\') + "'").ToLowerInvariant()
$removedPlusPlugin = $false
$otherInstanceOwnsPlugin = $false
if (Test-Path -LiteralPath $pluginDir) {
    $onStopPath = Join-Path $pluginDir 'on-stop.cjs'
    $runCmdPath = Join-Path $pluginDir 'run-on-stop.cmd'
    $pluginJsonPath = Join-Path $pluginDir 'plugin.json'
    $onStopRaw = if (Test-Path -LiteralPath $onStopPath) { Get-Content -LiteralPath $onStopPath -Raw -Encoding UTF8 } else { '' }
    $runCmdRaw = if (Test-Path -LiteralPath $runCmdPath) { Get-Content -LiteralPath $runCmdPath -Raw -Encoding UTF8 } else { '' }
    $pluginJsonRaw = if (Test-Path -LiteralPath $pluginJsonPath) { Get-Content -LiteralPath $pluginJsonPath -Raw -Encoding UTF8 } else { '' }

    $ownedPlugin = $onStopRaw.Contains('AGY_PLUS_ROOT') -or $pluginJsonRaw.Contains('Antigravity Plus')
    $boundToThisInstall = $true
    if ($onStopRaw.Contains('AGY_PLUS_ROOT')) {
        $onStopLower = $onStopRaw.ToLowerInvariant()
        $cmdLineMatch = 'set "agy_plus_root=' + $resolvedInstall.Replace('%', '%%').ToLowerInvariant() + '"'
        $cmdLineMatchPlain = 'set "agy_plus_root=' + $resolvedInstall.ToLowerInvariant() + '"'
        $matchedOnStop = $onStopLower.Contains($rootJsonNorm) -or $onStopLower.Contains($rootSingleQuotedNorm)
        $matchedRunCmd = $runCmdRaw -and (
            $runCmdRaw.ToLowerInvariant().Contains($cmdLineMatch) -or
            $runCmdRaw.ToLowerInvariant().Contains($cmdLineMatchPlain)
        )
        if (-not $matchedOnStop -and -not $matchedRunCmd) {
            $boundToThisInstall = $false
        }
    }
    if ($ownedPlugin -and $boundToThisInstall) {
        Remove-Item -LiteralPath $pluginDir -Recurse -Force -ErrorAction SilentlyContinue
        $removedPlusPlugin = $true
    } elseif ($ownedPlugin -and -not $boundToThisInstall) {
        $otherInstanceOwnsPlugin = $true
        Write-WarnMsg "检测到 $pluginDir 绑定于另一套 Antigravity Plus 实例，已保留插件及共享规则未删除。"
    }
}
$rulesDir = Join-Path $resolvedGeminiCfg 'rules'
if (-not $otherInstanceOwnsPlugin) {
    foreach ($ruleName in @('agy-plus-chinese-execution.md', 'agy-plus-workspace-local-scripts.md')) {
        $rp = Join-Path $rulesDir $ruleName
        if (Test-Path -LiteralPath $rp) {
            Remove-Item -LiteralPath $rp -Force -ErrorAction SilentlyContinue
        }
    }
}

$backupRoot = Join-Path $resolvedInstall 'backup'
if (-not $NoRestoreLegacy -and (Test-Path -LiteralPath $backupRoot)) {
    $legacyPluginBackup = Join-Path $backupRoot 'legacy-plugin-task-completion-toast'
    if ((Test-Path -LiteralPath $legacyPluginBackup) -and (-not (Test-Path -LiteralPath $pluginDir))) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $pluginDir) -Force | Out-Null
        Copy-Item -LiteralPath $legacyPluginBackup -Destination $pluginDir -Recurse -Force
        Write-Ok "已自动从备份恢复旧版插件 task-completion-toast（备份原件仍保留于 $legacyPluginBackup）。"
    }
    $legacyRulesBackup = Join-Path $backupRoot 'legacy-rules'
    if (Test-Path -LiteralPath $legacyRulesBackup) {
        New-Item -ItemType Directory -Path $rulesDir -Force | Out-Null
        $restoredRuleNames = @()
        foreach ($ruleFile in @(Get-ChildItem -LiteralPath $legacyRulesBackup -File -ErrorAction SilentlyContinue)) {
            $destRule = Join-Path $rulesDir $ruleFile.Name
            if (-not (Test-Path -LiteralPath $destRule)) {
                Copy-Item -LiteralPath $ruleFile.FullName -Destination $destRule -Force
                $restoredRuleNames += $ruleFile.Name
            }
        }
        if ($restoredRuleNames.Count -gt 0) {
            Write-Ok ("已自动从备份恢复旧版规则文件: " + ($restoredRuleNames -join ', ') + "（备份原件仍保留于 $legacyRulesBackup）。")
        }
    }
}
Write-Ok "Hook 插件与规则文件处理完成。"

Write-Step "5/5 精确清理 Antigravity Plus 运行时产物（保留备份与无关文件）..."
if (Test-Path -LiteralPath $resolvedInstall) {
    $isSourceRepo = (Test-Path -LiteralPath (Join-Path $resolvedInstall '.git')) -or
                    (Test-Path -LiteralPath (Join-Path $resolvedInstall 'tests\run-all-tests.cjs'))
    if (-not $isSourceRepo) {
        $ownedItems = @(
            'bin', 'config', 'integrations', 'logs', 'scripts', 'src',
            'install-receipt.json', 'patch_state.json', 'runtime_state.json', 'settings-before.json',
            'package.json', 'LICENSE', 'README.md',
            'Install.cmd', 'Manage.cmd'
        )
        if (-not $isSelfInstalledRun) {
            $ownedItems += 'Uninstall.cmd'
        }
        if (-not $KeepConfigAndCache) {
            $ownedItems += @('config.json', 'cache')
        }
        if ($PurgeBackups) {
            $ownedItems += @('backup')
        }
        foreach ($sub in $ownedItems) {
            $p = Join-Path $resolvedInstall $sub
            if (Test-Path -LiteralPath $p) {
                Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        $remaining = @(Get-ChildItem -LiteralPath $resolvedInstall -Force -ErrorAction SilentlyContinue)
        if ($remaining.Count -eq 0) {
            Remove-Item -LiteralPath $resolvedInstall -Force -ErrorAction SilentlyContinue
            Write-Ok "已彻底清理空运行目录 $resolvedInstall。"
        } elseif ($isSelfInstalledRun -and $remaining.Count -eq 1 -and $remaining[0].Name -ieq 'Uninstall.cmd') {
            Set-Location $env:TEMP
            $cmdExe = Join-Path $env:WINDIR 'System32\cmd.exe'
            $selfCmd = Join-Path $resolvedInstall 'Uninstall.cmd'
            $delCmd = "ping 127.0.0.1 -n 2 >nul & del /f /q `"$selfCmd`" >nul 2>nul & rmdir `"$resolvedInstall`" >nul 2>nul"
            Start-Process -FilePath $cmdExe -ArgumentList "/c $delCmd" -WindowStyle Hidden -ErrorAction SilentlyContinue
            Write-Ok "已清理全部运行时产物，并将在窗口退出后自动移除自身入口与空目录 $resolvedInstall。"
        } else {
            $keptNames = ($remaining | ForEach-Object { $_.Name }) -join ', '
            Write-Ok "已清理全部 Antigravity Plus 运行时产物；为保护数据安全已保留以下目录/文件 ($resolvedInstall): $keptNames"
        }
    } else {
        Write-WarnMsg "目标目录 $resolvedInstall 为源码仓库，已保留仓库源码文件。"
    }
}

Write-Host ""
Write-Host "Antigravity Plus 已彻底卸载完成。" -ForegroundColor Green
