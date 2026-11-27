[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AntigravityPlus'),
    [string]$AntigravityResourcesDir = (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources'),
    [string]$GeminiConfigDir = (Join-Path $HOME '.gemini\config'),
    [string]$ProxyUrl = '',
    [string]$OfflineTranslatorDir = '',
    [string]$LegacyLaunchDir = '',
    [switch]$CleanLegacy,
    [switch]$AllowMissingClient,
    [switch]$SkipRegistryRun,
    [switch]$SkipScheduledTask,
    [switch]$NoStartWatcher
)
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "[Antigravity Plus] $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-WarnMsg([string]$Message) {
    Write-Host "  [提示] $Message" -ForegroundColor Yellow
}

function Write-Utf8NoBom([string]$FilePath, [string]$Content) {
    $parent = Split-Path -Parent $FilePath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FilePath, $Content, $enc)
}

function Write-Utf8NoBomCrlf([string]$FilePath, [string]$Content) {
    $crlf = ($Content -replace "`r`n", "`n") -replace "`n", "`r`n"
    if (-not $crlf.EndsWith("`r`n")) { $crlf += "`r`n" }
    Write-Utf8NoBom -FilePath $FilePath -Content $crlf
}

function Write-Utf16LeBomCrlf([string]$FilePath, [string]$Content) {
    $parent = Split-Path -Parent $FilePath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $crlf = ($Content -replace "`r`n", "`n") -replace "`n", "`r`n"
    if (-not $crlf.EndsWith("`r`n")) { $crlf += "`r`n" }
    $enc = New-Object System.Text.UnicodeEncoding($false, $true)
    [System.IO.File]::WriteAllText($FilePath, $crlf, $enc)
}

function Resolve-JsRuntime([string]$ResourcesDir) {
    if ($env:AGY_FORCE_ELECTRON_NODE -ne '1') {
        $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($nodeCmd -and $nodeCmd.Source -and (Test-Path -LiteralPath $nodeCmd.Source)) {
            if ($nodeCmd.Source -notmatch '(?i)\\Programs\\antigravity\\') {
                return @{
                    Exe = $nodeCmd.Source
                    UseElectronNode = $false
                }
            }
        }
        foreach ($candidate in @(
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            'D:\Program Files\nodejs\node.exe'
        )) {
            if ($candidate -and (Test-Path -LiteralPath $candidate)) {
                return @{
                    Exe = $candidate
                    UseElectronNode = $false
                }
            }
        }
    }
    $agyRoot = Split-Path -Parent $ResourcesDir
    $agyExe = Join-Path $agyRoot 'Antigravity.exe'
    if (Test-Path -LiteralPath $agyExe) {
        return @{
            Exe = $agyExe
            UseElectronNode = $true
        }
    }
    $defaultAgyExe = Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'
    if (Test-Path -LiteralPath $defaultAgyExe) {
        return @{
            Exe = $defaultAgyExe
            UseElectronNode = $true
        }
    }
    throw '未找到 Node.js 或 Antigravity.exe，请先安装 Google Antigravity 客户端。'
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

function Invoke-JsScript([hashtable]$Runtime, [string]$InstallRootPath, [string]$ScriptPath, [string[]]$Arguments = @(), [int]$TimeoutMs = 0) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo($Runtime.Exe)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.WorkingDirectory = $InstallRootPath
    $psi.EnvironmentVariables['AGY_PLUS_ROOT'] = $InstallRootPath
    [void]$psi.EnvironmentVariables.Remove('NODE_OPTIONS')
    if ($Runtime.UseElectronNode) {
        $psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
    } else {
        [void]$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
    }
    $allArgs = @($ScriptPath) + @($Arguments)
    $psi.Arguments = (($allArgs | ForEach-Object { Quote-WinArg ([string]$_) }) -join ' ')

    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $stderrTask = $proc.StandardError.ReadToEndAsync()
        if ($TimeoutMs -gt 0) {
            if (-not $proc.WaitForExit($TimeoutMs)) {
                try { $proc.Kill() } catch {}
                return @{
                    ExitCode = 124
                    Output = 'timeout'
                }
            }
        } else {
            $proc.WaitForExit()
        }
        $combined = ($stdoutTask.GetAwaiter().GetResult() + "`n" + $stderrTask.GetAwaiter().GetResult()).Trim()
        return @{
            ExitCode = [int]$proc.ExitCode
            Output = $combined
        }
    } finally {
        $proc.Dispose()
    }
}

function Resolve-CleanFullPath([string]$RawPath) {
    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RawPath)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($root -and $full.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { return $full }
    return $full.TrimEnd('\', '/')
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedRepo = Resolve-CleanFullPath $repoRoot
$resolvedInstall = Resolve-CleanFullPath $InstallRoot
$resolvedResources = Resolve-CleanFullPath $AntigravityResourcesDir
$resolvedGeminiCfg = Resolve-CleanFullPath $GeminiConfigDir
$targetRulesDir = Join-Path $resolvedGeminiCfg 'rules'
$pluginTargetDir = Join-Path $resolvedGeminiCfg 'plugins\task-completion-toast'

# 0/6 Pre-flight safety checks BEFORE creating directories or writing any config, rule, or plugin files
$hasStockAsar = Test-Path -LiteralPath (Join-Path $resolvedResources 'app.asar')
$hasRealAsar = Test-Path -LiteralPath (Join-Path $resolvedResources 'app.real.asar')
if (-not $hasStockAsar -and -not $hasRealAsar -and -not $AllowMissingClient) {
    throw "安装预检拦截：在客户端资源目录 $resolvedResources 未发现 app.asar 或 app.real.asar。请确认 -AntigravityResourcesDir 指向正确的 Antigravity 客户端目录（本次未修改或删除任何文件）。"
}

$sameAsRepo = ($resolvedRepo.TrimEnd('\').ToLowerInvariant() -eq $resolvedInstall.TrimEnd('\').ToLowerInvariant())
if (-not $sameAsRepo -and (Test-Path -LiteralPath $resolvedInstall)) {
    $installEntries = @(Get-ChildItem -LiteralPath $resolvedInstall -Force -ErrorAction SilentlyContinue)
    if ($installEntries.Count -gt 0) {
        $hasReceipt = Test-Path -LiteralPath (Join-Path $resolvedInstall 'install-receipt.json')
        $hasPlusCore = (Test-Path -LiteralPath (Join-Path $resolvedInstall 'src\core\patch-antigravity.cjs')) -and
                       (Test-Path -LiteralPath (Join-Path $resolvedInstall 'config\config.default.json'))
        $preservedAllowed = @('backup', 'config.json', 'cache')
        $nonPreserved = @($installEntries | Where-Object { $preservedAllowed -notcontains $_.Name })
        $isPreservedPlusRemainder = $false
        if ($nonPreserved.Count -eq 0) {
            $hasPlusBackup = (Test-Path -LiteralPath (Join-Path $resolvedInstall 'backup\legacy-rules')) -or
                             (Test-Path -LiteralPath (Join-Path $resolvedInstall 'backup\legacy-plugin-task-completion-toast')) -or
                             (Test-Path -LiteralPath (Join-Path $resolvedInstall 'backup\legacy-shim-app'))
            $cfgFile = Join-Path $resolvedInstall 'config.json'
            $hasPlusCfg = $false
            if (Test-Path -LiteralPath $cfgFile) {
                try {
                    $cfgObj = Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($cfgObj -and $cfgObj.features) { $hasPlusCfg = $true }
                } catch {}
            }
            $isPreservedPlusRemainder = $hasPlusBackup -or $hasPlusCfg
        }
        if (-not $hasReceipt -and -not $hasPlusCore -and -not $isPreservedPlusRemainder) {
            throw "安装预检拦截：目标安装目录 $resolvedInstall 已存在且非空，但不包含 Antigravity Plus 归属标识（install-receipt.json 或核心模块）。为防止覆盖/删除无关文件已终止安装！"
        }
    }
}

$existingAppDir = Join-Path $resolvedResources 'app'
$existingShimIndex = Join-Path $existingAppDir 'index.js'
$hasLegacyShim = $false
if (Test-Path -LiteralPath $existingAppDir) {
    if (-not (Test-Path -LiteralPath $existingShimIndex)) {
        $dirEntries = @(Get-ChildItem -LiteralPath $existingAppDir -Force -ErrorAction SilentlyContinue)
        if ($dirEntries.Count -gt 0) {
            throw "安装预检拦截：检测到非空且未识别的客户端引导目录 $existingAppDir，为保护现场文件已终止安装（未修改任何配置）。"
        }
    } else {
        $idxRaw = Get-Content -LiteralPath $existingShimIndex -Raw -Encoding UTF8
        $isPlusShim = $idxRaw.Contains('ANTIGRAVITY_PLUS_SHIM_V3')
        $isLegacyShim = $idxRaw.Contains('ANTIGRAVITY_NATIVE_SHIM_V3')
        if ($isLegacyShim) { $hasLegacyShim = $true }
        if (-not $isPlusShim -and -not ($isLegacyShim -and $CleanLegacy)) {
            if ($isLegacyShim) {
                throw "安装预检拦截：检测到旧版引导层 ANTIGRAVITY_NATIVE_SHIM_V3 ($existingShimIndex)。请附加 -CleanLegacy 参数授权平滑升级（本次未修改任何现有配置或插件）。"
            } else {
                throw "安装预检拦截：检测到第三方未知引导文件 $existingShimIndex，为避免覆盖其他工具已终止安装。"
            }
        }
    }
}

$existingOnStop = Join-Path $pluginTargetDir 'on-stop.cjs'
$existingPluginJson = Join-Path $pluginTargetDir 'plugin.json'
$hasForeignToastPlugin = $false
if (Test-Path -LiteralPath $pluginTargetDir) {
    $onStopOwned = (Test-Path -LiteralPath $existingOnStop) -and ((Get-Content -LiteralPath $existingOnStop -Raw -Encoding UTF8).Contains('AGY_PLUS_ROOT'))
    $pluginJsonOwned = (Test-Path -LiteralPath $existingPluginJson) -and ((Get-Content -LiteralPath $existingPluginJson -Raw -Encoding UTF8).Contains('Antigravity Plus'))
    if (-not $onStopOwned -and -not $pluginJsonOwned) {
        $existingFiles = @(Get-ChildItem -LiteralPath $pluginTargetDir -Force -ErrorAction SilentlyContinue)
        if ($existingFiles.Count -gt 0) {
            $hasForeignToastPlugin = $true
            if (-not $CleanLegacy) {
                throw "安装预检拦截：检测到已存在非 Antigravity Plus 的同名插件 $pluginTargetDir。请附加 -CleanLegacy 参数备份并接管（本次未修改任何现有文件）。"
            }
        }
    }
}

$jsRuntime = Resolve-JsRuntime -ResourcesDir $resolvedResources

# 原地升级前先按顺序停止当前安装目录的守护与通知进程（先杀 watch.cjs，再停 TaskToastHost.exe），防止删除/覆盖源码冲突或旧守护把弹窗重新拉起
$installPrefix = $resolvedInstall.TrimEnd('\') + '\'
$watchMarker = Join-Path $resolvedInstall 'src\main\watch.cjs'
$vbsMarker = Join-Path $resolvedInstall 'bin\Start-Watcher.vbs'
try {
    $staleWatchers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and (
            $_.CommandLine.IndexOf($watchMarker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $_.CommandLine.IndexOf($vbsMarker, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        )
    }
    foreach ($sw in $staleWatchers) {
        Stop-Process -Id $sw.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}

$existingToastClient = Join-Path $resolvedInstall 'src\toast\toast-client.cjs'
if (Test-Path -LiteralPath $existingToastClient) {
    try {
        [void](Invoke-JsScript -Runtime $jsRuntime -InstallRootPath $resolvedInstall -ScriptPath $existingToastClient -Arguments @('shutdown') -TimeoutMs 5000)
    } catch {}
}
$waitDeadline = [DateTime]::UtcNow.AddMilliseconds(1500)
$stillRunningToast = @()
do {
    $stillRunningToast = @()
    try {
        $stillRunningToast = @(Get-Process -Name 'TaskToastHost' -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -and $_.Path.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
        })
    } catch {}
    if ($stillRunningToast.Count -eq 0) { break }
    Start-Sleep -Milliseconds 120
} while ([DateTime]::UtcNow -lt $waitDeadline)
foreach ($tp in $stillRunningToast) {
    Stop-Process -Id $tp.Id -Force -ErrorAction SilentlyContinue
}
try {
    $staleToastCim = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq 'TaskToastHost.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    }
    foreach ($st in $staleToastCim) {
        Stop-Process -Id $st.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}
Start-Sleep -Milliseconds 150

Write-Step "1/6 部署运行时文件到 $resolvedInstall ..."
New-Item -ItemType Directory -Path $resolvedInstall -Force | Out-Null

if ($resolvedRepo.TrimEnd('\').ToLowerInvariant() -ne $resolvedInstall.TrimEnd('\').ToLowerInvariant()) {
    foreach ($subDir in @('config', 'integrations', 'src', 'scripts')) {
        $srcDir = Join-Path $resolvedRepo $subDir
        $dstDir = Join-Path $resolvedInstall $subDir
        if (Test-Path -LiteralPath $srcDir) {
            if (Test-Path -LiteralPath $dstDir) {
                Remove-Item -LiteralPath $dstDir -Recurse -Force
            }
            Copy-Item -LiteralPath $srcDir -Destination $dstDir -Recurse -Force
        }
    }
    foreach ($rootFile in @('package.json', 'LICENSE', 'README.md', 'Install.cmd', 'Uninstall.cmd', 'Manage.cmd')) {
        $srcFile = Join-Path $resolvedRepo $rootFile
        if (Test-Path -LiteralPath $srcFile) {
            Copy-Item -LiteralPath $srcFile -Destination (Join-Path $resolvedInstall $rootFile) -Force
        }
    }
}
Write-Ok "运行时目录已同步。"
Write-Ok ("JS 执行引擎: " + $jsRuntime.Exe + ($(if ($jsRuntime.UseElectronNode) { ' (ELECTRON_RUN_AS_NODE=1)' } else { '' })))

Write-Step "2/6 初始化配置与全局工作流规则 ..."
$legacySettingsFile = ''
$legacyTitleCache = ''
if ($LegacyLaunchDir -and (Test-Path -LiteralPath $LegacyLaunchDir)) {
    $candSettings = Join-Path $LegacyLaunchDir 'launcher-settings.json'
    if (Test-Path -LiteralPath $candSettings) { $legacySettingsFile = $candSettings }
    $candCache = Join-Path $LegacyLaunchDir 'logs\title-translations-cache.json'
    if (Test-Path -LiteralPath $candCache) { $legacyTitleCache = $candCache }
}

if ($legacyTitleCache) {
    $targetCache = Join-Path $resolvedInstall 'cache\title-translations.json'
    if (-not (Test-Path -LiteralPath $targetCache)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetCache) -Force | Out-Null
        Copy-Item -LiteralPath $legacyTitleCache -Destination $targetCache -Force
        Write-Ok "已迁移历史会话标题中文缓存。"
    }
}

$initScript = Join-Path $resolvedInstall 'bin\init-config-once.cjs'
$initJs = @"
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cm = require('../src/core/config-manager.cjs');

const installRoot = process.env.AGY_PLUS_ROOT;
const cfgPath = cm.defaultConfigPath(installRoot);
const hadExisting = fs.existsSync(cfgPath);
let cfg = cm.loadConfig({ installRoot });

const legacyFile = process.argv[2] || '';
const argProxy = process.argv[3] || '';
const argOffline = process.argv[4] || '';
const customRulesDir = process.argv[5] || '';

if (!hadExisting && legacyFile && fs.existsSync(legacyFile)) {
    const leg = cm.readJsonSafe(legacyFile);
    if (leg) {
        if (typeof leg.ProxyUrl === 'string' && leg.ProxyUrl.trim()) {
            cfg.network.proxyUrl = leg.ProxyUrl.trim();
        } else if (leg.ProxyPort) {
            cfg.network.proxyUrl = 'http://127.0.0.1:' + String(leg.ProxyPort).trim();
        }
        if (typeof leg.ExternalBrowserPath === 'string' && leg.ExternalBrowserPath.trim() && fs.existsSync(leg.ExternalBrowserPath.trim())) {
            cfg.network.externalBrowserPath = leg.ExternalBrowserPath.trim();
        }
    }
}
if (argProxy) cfg.network.proxyUrl = argProxy;
if (argOffline) cfg.translation.offlineRoot = argOffline;
if (!cfg.network.externalBrowserPath) {
    const chrome = cm.detectChromePath();
    if (chrome) cfg.network.externalBrowserPath = chrome;
}
if (!cfg.translation.offlineRoot) {
    const detectedOffline = cm.resolveOfflineTranslatorRoot('');
    if (detectedOffline) cfg.translation.offlineRoot = detectedOffline;
}

const saved = cm.saveConfig(cfg, { installRoot, syncRules: true, rulesDir: customRulesDir || undefined });
console.log(JSON.stringify({ hadExisting, saved }));
"@
Write-Utf8NoBom -FilePath $initScript -Content $initJs
$initRes = Invoke-JsScript -Runtime $jsRuntime -InstallRootPath $resolvedInstall -ScriptPath $initScript -Arguments @($legacySettingsFile, $ProxyUrl, $OfflineTranslatorDir, $targetRulesDir)
Remove-Item -LiteralPath $initScript -Force -ErrorAction SilentlyContinue
if ($initRes.ExitCode -ne 0) {
    throw ("初始化配置失败: " + $initRes.Output)
}
Write-Ok "配置文件 config.json 与 ~/.gemini/config/rules 已同步。"

if ($CleanLegacy) {
    $rulesDir = $targetRulesDir
    $legacyBackupDir = Join-Path $resolvedInstall 'backup\legacy-rules'
    foreach ($oldRule in @('derrick-chinese-execution.md', 'workspace-local-scripts.md', 'popup-interactive-submit.md')) {
        $oldRulePath = Join-Path $rulesDir $oldRule
        if (Test-Path -LiteralPath $oldRulePath) {
            New-Item -ItemType Directory -Path $legacyBackupDir -Force | Out-Null
            Copy-Item -LiteralPath $oldRulePath -Destination (Join-Path $legacyBackupDir $oldRule) -Force
            Remove-Item -LiteralPath $oldRulePath -Force -ErrorAction SilentlyContinue
            Write-Ok "已备份并接管旧版规则文件 $oldRule（备份位于 $legacyBackupDir）。"
        }
    }
    if ($LegacyLaunchDir -and (Test-Path -LiteralPath $LegacyLaunchDir)) {
        $resolvedLegacy = [System.IO.Path]::GetFullPath($LegacyLaunchDir)
        $legacyPrefix = $resolvedLegacy.TrimEnd('\') + '\'
        try {
            $legacyProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
                ($_.Name -ieq 'TaskToastHost.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($legacyPrefix, [System.StringComparison]::OrdinalIgnoreCase)) -or
                ($_.CommandLine -and $_.CommandLine.IndexOf($legacyPrefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match 'watch\.cjs|TaskToastHost')
            }
            foreach ($lp in $legacyProcs) {
                Stop-Process -Id $lp.ProcessId -Force -ErrorAction SilentlyContinue
            }
            if ($legacyProcs) {
                Write-Ok "已停止旧目录 ($resolvedLegacy) 后台驻留的守护与弹窗进程。"
            }
        } catch {}
    }
}

Write-Step "3/6 编译右下角原生通知宿主 TaskToastHost.exe ..."
$buildToastScript = Join-Path $resolvedInstall 'src\toast\Build-TaskToast.ps1'
& $buildToastScript -OutputDir (Join-Path $resolvedInstall 'bin') | Out-Null
$staleOldToast = Join-Path $resolvedInstall 'bin\TaskToastHost.old.exe'
if (Test-Path -LiteralPath $staleOldToast) {
    Remove-Item -LiteralPath $staleOldToast -Force -ErrorAction SilentlyContinue
}
Write-Ok "TaskToastHost.exe 编译完成。"

Write-Step "4/6 配置 ~/.gemini/config/plugins/task-completion-toast 插件 ..."
if ($hasForeignToastPlugin -and $CleanLegacy -and (Test-Path -LiteralPath $pluginTargetDir)) {
    $legacyPluginBackup = Join-Path $resolvedInstall 'backup\legacy-plugin-task-completion-toast'
    if (Test-Path -LiteralPath $legacyPluginBackup) {
        Remove-Item -LiteralPath $legacyPluginBackup -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $legacyPluginBackup) -Force | Out-Null
    Copy-Item -LiteralPath $pluginTargetDir -Destination $legacyPluginBackup -Recurse -Force
    Remove-Item -LiteralPath $pluginTargetDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "已备份并清理旧版同名插件至 $legacyPluginBackup。"
}
$pluginTemplateDir = Join-Path $resolvedInstall 'integrations\plugins\task-completion-toast'
New-Item -ItemType Directory -Path (Join-Path $pluginTargetDir 'assets') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $pluginTemplateDir 'plugin.json') -Destination (Join-Path $pluginTargetDir 'plugin.json') -Force
Copy-Item -LiteralPath (Join-Path $pluginTemplateDir 'assets\logo.svg') -Destination (Join-Path $pluginTargetDir 'assets\logo.svg') -Force

$rootJsonLiteral = ConvertTo-Json $resolvedInstall -Compress
$hookTargetJsonLiteral = ConvertTo-Json (Join-Path $resolvedInstall 'src\toast\on-task-stop.cjs') -Compress
$onStopContent = @"
'use strict';
process.env.AGY_PLUS_ROOT = process.env.AGY_PLUS_ROOT || $rootJsonLiteral;
void require($hookTargetJsonLiteral).runHook();
"@
Write-Utf8NoBom -FilePath (Join-Path $pluginTargetDir 'on-stop.cjs') -Content $onStopContent

$fallbackAgyExe = Join-Path (Split-Path -Parent $resolvedResources) 'Antigravity.exe'
if (-not (Test-Path -LiteralPath $fallbackAgyExe)) {
    $defaultAgyCand = Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'
    if (Test-Path -LiteralPath $defaultAgyCand) { $fallbackAgyExe = $defaultAgyCand }
    else { $fallbackAgyExe = $jsRuntime.Exe }
}
$resolvedInstallCmd = $resolvedInstall.Replace('%', '%%')
$fallbackAgyCmd = $fallbackAgyExe.Replace('%', '%%')
$detectedNodeCmd = if (-not $jsRuntime.UseElectronNode -and $jsRuntime.Exe) { $jsRuntime.Exe.Replace('%', '%%') } else { '' }
$explicitNodeCheck = if ($detectedNodeCmd) {
    "if exist `"$detectedNodeCmd`" (`r`n  `"$detectedNodeCmd`" `"%~dp0on-stop.cjs`"`r`n  exit /b %ERRORLEVEL%`r`n)"
} else {
    ''
}

$runOnStopCmd = @"
@echo off
setlocal
chcp 65001 >nul
set "AGY_PLUS_ROOT=$resolvedInstallCmd"
set "NODE_OPTIONS="
if "%AGY_FORCE_ELECTRON_NODE%"=="1" goto :use_electron
$explicitNodeCheck
where node.exe >nul 2>nul
if errorlevel 1 goto :use_electron
node.exe "%~dp0on-stop.cjs"
exit /b %ERRORLEVEL%
:use_electron
set "ELECTRON_RUN_AS_NODE=1"
"$fallbackAgyCmd" "%~dp0on-stop.cjs"
exit /b %ERRORLEVEL%
"@
Write-Utf8NoBomCrlf -FilePath (Join-Path $pluginTargetDir 'run-on-stop.cmd') -Content $runOnStopCmd

$hookCmdValue = 'run-on-stop.cmd'
$hooksJsonContent = @"
{
  "task-completion-toast": {
    "Stop": [
      {
        "type": "command",
        "command": $(ConvertTo-Json $hookCmdValue -Compress),
        "timeout": 5
      }
    ]
  }
}
"@
Write-Utf8NoBom -FilePath (Join-Path $pluginTargetDir 'hooks.json') -Content $hooksJsonContent
Write-Ok "Stop Hook 插件已部署。"

Write-Step "5/6 安装 Antigravity 无损原生引导层 (Shim V3) ..."
$patchState = 'skipped'
if ((Test-Path -LiteralPath (Join-Path $resolvedResources 'app.asar')) -or (Test-Path -LiteralPath (Join-Path $resolvedResources 'app.real.asar'))) {
    if ($hasLegacyShim -and $CleanLegacy -and (Test-Path -LiteralPath $existingAppDir)) {
        $legacyShimBackup = Join-Path $resolvedInstall 'backup\legacy-shim-app'
        if (Test-Path -LiteralPath $legacyShimBackup) {
            Remove-Item -LiteralPath $legacyShimBackup -Recurse -Force
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $legacyShimBackup) -Force | Out-Null
        Copy-Item -LiteralPath $existingAppDir -Destination $legacyShimBackup -Recurse -Force
        Write-Ok "已备份旧版引导目录 resources\app 至 $legacyShimBackup。"
    }
    $patchScript = Join-Path $resolvedInstall 'src\core\patch-antigravity.cjs'
    $patchArgs = @('--target', $resolvedResources, '--install-root', $resolvedInstall, '--verbose')
    if ($CleanLegacy) { $patchArgs += '--allow-legacy-shim' }
    $patchRes = Invoke-JsScript -Runtime $jsRuntime -InstallRootPath $resolvedInstall -ScriptPath $patchScript -Arguments $patchArgs
    if ($patchRes.ExitCode -eq 0) {
        $patchState = 'active'
        Write-Ok "Shim V3 已激活。"
    } elseif ($patchRes.ExitCode -eq 3) {
        $patchState = 'staged_until_restart'
        Write-WarnMsg "Antigravity 正在运行并占用原版 app.asar；引导文件已预置，下次关闭或重启客户端时将自动无感生效。"
    } else {
        throw ("Shim V3 安装失败 (exit=$($patchRes.ExitCode)): " + $patchRes.Output)
    }
} else {
    Write-WarnMsg "在 $resolvedResources 未发现 app.asar 或 app.real.asar，已按 -AllowMissingClient 跳过客户端目录注入。"
}

Write-Step "6/6 配置后台静默守护与开机自愈 ..."
$watcherVbsPath = Join-Path $resolvedInstall 'bin\Start-Watcher.vbs'
$patchVbsPath = Join-Path $resolvedInstall 'bin\Ensure-Shim.vbs'
$watchScriptPath = Join-Path $resolvedInstall 'src\main\watch.cjs'
$patchScriptPath = Join-Path $resolvedInstall 'src\core\patch-antigravity.cjs'

$jsExeEsc = $jsRuntime.Exe.Replace('"', '""')
$installEsc = $resolvedInstall.Replace('"', '""')
$resourcesEsc = $resolvedResources.Replace('"', '""')
$watchScriptEsc = $watchScriptPath.Replace('"', '""')
$patchScriptEsc = $patchScriptPath.Replace('"', '""')
$electronEnvLine = if ($jsRuntime.UseElectronNode) { 'env("ELECTRON_RUN_AS_NODE") = "1"' } else { 'env("ELECTRON_RUN_AS_NODE") = ""' }
$watchExtraArgs = if ($jsRuntime.UseElectronNode) { ' --once' } else { '' }

$watcherVbs = @"
Option Explicit
Dim shell, env
Set shell = CreateObject("WScript.Shell")
Set env = shell.Environment("PROCESS")
env("AGY_PLUS_ROOT") = "$installEsc"
env("NODE_OPTIONS") = ""
$electronEnvLine
shell.Run """$jsExeEsc"" ""$watchScriptEsc""$watchExtraArgs", 0, False
"@
Write-Utf16LeBomCrlf -FilePath $watcherVbsPath -Content $watcherVbs

$patchVbs = @"
Option Explicit
Dim shell, env
Set shell = CreateObject("WScript.Shell")
Set env = shell.Environment("PROCESS")
env("AGY_PLUS_ROOT") = "$installEsc"
env("NODE_OPTIONS") = ""
$electronEnvLine
shell.Run """$jsExeEsc"" ""$patchScriptEsc"" --target ""$resourcesEsc"" --install-root ""$installEsc""", 0, False
"@
Write-Utf16LeBomCrlf -FilePath $patchVbsPath -Content $patchVbs

$runKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValueName = 'AntigravityPlus'
$wscriptExe = Join-Path $env:WINDIR 'System32\wscript.exe'
$runCmd = "`"$wscriptExe`" //B //NoLogo `"$watcherVbsPath`""
$runRegistryRegistered = $false
if (-not $SkipRegistryRun) {
    try {
        if (-not (Test-Path -LiteralPath $runKeyPath)) {
            New-Item -Path $runKeyPath -Force | Out-Null
        }
        Set-ItemProperty -Path $runKeyPath -Name $runValueName -Value $runCmd
        $runRegistryRegistered = $true
        if ($CleanLegacy) {
            Remove-ItemProperty -Path $runKeyPath -Name 'DerrickAntigravityUI' -ErrorAction SilentlyContinue
        }
        Write-Ok "已注册当前用户登录守护项 ($runValueName)。"
    } catch {
        Write-WarnMsg ("注册表自启动项写入受限，可忽略: " + $_.Exception.Message)
    }
}

$taskName = 'Antigravity-Plus-Guard'
$scheduledTaskRegistered = $false
if (-not $SkipScheduledTask) {
    try {
        $action = New-ScheduledTaskAction -Execute $wscriptExe -Argument "//B //NoLogo `"$patchVbsPath`""
        $currentUserName = try { [System.Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { $env:USERNAME }
        $triggerRepeat = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date) `
            -RepetitionInterval (New-TimeSpan -Minutes 5) `
            -RepetitionDuration (New-TimeSpan -Days 3650)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -Hidden
        try {
            $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $currentUserName
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon, $triggerRepeat) -Settings $settings -Description 'Antigravity Plus auto-update resilience guard' -Force | Out-Null
            $scheduledTaskRegistered = $true
        } catch {
            # Standard non-admin users may be denied AtLogOn triggers; fall back to periodic-only guard task.
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerRepeat) -Settings $settings -Description 'Antigravity Plus auto-update resilience guard (periodic)' -Force | Out-Null
            $scheduledTaskRegistered = $true
        }
        if ($CleanLegacy) {
            Unregister-ScheduledTask -TaskName 'Antigravity-NewWindow-Guard' -Confirm:$false -ErrorAction SilentlyContinue
        }
        Write-Ok "已注册自动更新防覆盖计划任务 ($taskName)。"
    } catch {
        Write-WarnMsg ("计划任务注册跳过 (" + $_.Exception.Message + ")")
    }
}

$resolvedAgyExe = Join-Path (Split-Path -Parent $resolvedResources) 'Antigravity.exe'
$backupDirPath = Join-Path $resolvedInstall 'backup'
$receipt = [ordered]@{
    installedAt = (Get-Date).ToString('o')
    installRoot = $resolvedInstall
    antigravityResourcesDir = $resolvedResources
    antigravityExePath = if (Test-Path -LiteralPath $resolvedAgyExe) { $resolvedAgyExe } else { '' }
    geminiConfigDir = $resolvedGeminiCfg
    patchState = $patchState
    cleanedLegacy = [bool]$CleanLegacy
    legacyBackupDir = if (Test-Path -LiteralPath $backupDirPath) { $backupDirPath } else { '' }
    pluginDir = $pluginTargetDir
    rulesDir = $targetRulesDir
    runRegistryValue = if ($runRegistryRegistered) { $runValueName } else { '' }
    scheduledTaskName = if ($scheduledTaskRegistered) { $taskName } else { '' }
}
Write-Utf8NoBom -FilePath (Join-Path $resolvedInstall 'install-receipt.json') -Content ($receipt | ConvertTo-Json -Depth 4)

if (-not $NoStartWatcher) {
    try {
        Start-Process -FilePath $wscriptExe -ArgumentList @('//B', '//NoLogo', "`"$watcherVbsPath`"") -WindowStyle Hidden | Out-Null
    } catch {}
    $cliScript = Join-Path $resolvedInstall 'src\main\cli.cjs'
    $applyRes = Invoke-JsScript -Runtime $jsRuntime -InstallRootPath $resolvedInstall -ScriptPath $cliScript -Arguments @('apply')
    if ($applyRes.ExitCode -eq 0) {
        Write-Ok "已向正在运行的 Antigravity 窗口热同步最新 UI。"
    } elseif (Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue) {
        Write-WarnMsg "检测到当前已打开的 Antigravity 窗口启动于安装前，请关闭并重新打开一次 Antigravity 以激活全新主进程桥与菜单开关。"
    }
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Antigravity Plus 安装完成！" -ForegroundColor Green
Write-Host "  - 可视化开关：侧边栏左下角调节按钮 / Window 菜单 / Ctrl+Shift+,"
Write-Host "  - 命令行管理：双击 Manage.cmd 或运行 Manage.cmd status"
Write-Host "  - 一键卸载：双击 Uninstall.cmd"
Write-Host "==========================================================" -ForegroundColor Green
