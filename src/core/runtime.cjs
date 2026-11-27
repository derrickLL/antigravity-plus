'use strict';

/**
 * Antigravity Plus Native Shim Runtime (V3)
 *
 * Runs inside the Electron main process right before `app.real.asar/dist/main.js` loads:
 * 1. Optional process-scoped loopback HTTP proxy + Chromium proxy switches (no persistent OS env changes).
 * 2. Optional `language_server.exe --standalone` Fastpush dialer override (`--remote_agent_fastpush_override=false`).
 * 3. Seamless NSIS auto-update interception & shim reconstruction.
 * 4. Dynamic preferred external browser routing (instant toggle support).
 * 5. Multi-window support (`--new-window` / `-n`, Windows JumpList, top `Window` menu) + Settings menu bridge.
 * 6. Main-process UI/Telemetry/Translation/Toast controller (`src/main/main-hook.cjs`).
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const { defaultInstallRoot, loadConfig, updateConfig } = require('./config-manager.cjs');
const { resolveSystemNode } = require('./node-runner.cjs');
const externalBrowser = require('./external-browser.cjs');

const NEW_WINDOW_IPC_CHANNEL = 'agy-plus:new-window';
const CONFIG_UPDATE_IPC_CHANNEL = 'agy-plus:update-config';
const MENU_PRELOAD_ID = 'agy-plus-window-menu';

const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';
const DEFAULT_CHROMIUM_BYPASS = 'localhost;127.0.0.1;[::1];<local>';

function validateLoopbackHttpProxy(raw) {
    if (typeof raw !== 'string') return null;
    let text = raw.trim();
    if (!text) return null;
    if (!text.includes('://')) text = 'http://' + text;
    try {
        const u = new URL(text);
        if (u.protocol !== 'http:') return null;
        const host = u.hostname.toLowerCase();
        const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
        if (!isLoopback) return null;
        if (u.username || u.password) return null;
        if (u.pathname && u.pathname !== '/') return null;
        if (u.search || u.hash) return null;
        const port = Number(u.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
        return `${u.protocol}//${u.hostname}:${port}`;
    } catch {
        return null;
    }
}

function parseWinInetProxyOutput(output) {
    if (typeof output !== 'string' || !output) return null;
    const enableMatch = /\bProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(output);
    const enabled = enableMatch ? Number(enableMatch[1]) === 1 : false;
    if (!enabled) return null;

    const serverMatch = /\bProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(output);
    if (!serverMatch) return null;
    const rawServer = serverMatch[1].trim();
    if (!rawServer) return null;

    if (!rawServer.includes('=')) {
        return validateLoopbackHttpProxy(rawServer);
    }
    const parts = rawServer.split(';').map(p => p.trim()).filter(Boolean);
    for (const prefix of ['https=', 'http=']) {
        const hit = parts.find(p => p.toLowerCase().startsWith(prefix));
        if (hit) {
            const valid = validateLoopbackHttpProxy(hit.slice(prefix.length));
            if (valid) return valid;
        }
    }
    return null;
}

function readWinInetProxy(execFileSyncFn = cp.execFileSync) {
    if (process.platform !== 'win32') return null;
    try {
        const out = execFileSyncFn(
            'reg.exe',
            ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
            { encoding: 'utf8', timeout: 1500, windowsHide: true }
        );
        return parseWinInetProxyOutput(out);
    } catch {
        return null;
    }
}

function resolveProxyUrl(config, execFileSyncFn = cp.execFileSync) {
    if (config?.features?.localProxy === false) {
        return { url: null, source: 'disabled_by_config' };
    }
    if (config?.network?.proxyUrl) {
        const configured = validateLoopbackHttpProxy(config.network.proxyUrl);
        if (configured) return { url: configured, source: 'config' };
    }
    const winInet = readWinInetProxy(execFileSyncFn);
    if (winInet) return { url: winInet, source: 'wininet' };
    return { url: null, source: 'none' };
}

function probeLocalTcp(proxyUrl, timeoutMs = 1200) {
    return new Promise(resolve => {
        try {
            const u = new URL(proxyUrl);
            const socket = new net.Socket();
            let settled = false;
            const done = ok => {
                if (settled) return;
                settled = true;
                try { socket.destroy(); } catch {}
                resolve(ok);
            };
            socket.setTimeout(timeoutMs);
            socket.once('connect', () => done(true));
            socket.once('timeout', () => done(false));
            socket.once('error', () => done(false));
            socket.connect(Number(u.port), u.hostname);
        } catch {
            resolve(false);
        }
    });
}

function isLanguageServerStandalone(command, args) {
    return (
        typeof command === 'string' &&
        /language_server(\.exe)?$/i.test(command) &&
        Array.isArray(args) &&
        args.includes('--standalone')
    );
}

function detectUpdaterSpawn(command, args) {
    if (typeof command !== 'string' || !Array.isArray(args)) return null;
    const baseName = path.basename(command).toLowerCase();

    const looksLikeDirectInstaller =
        args.includes('--updated') &&
        (command.toLowerCase().includes('antigravity-updater') || /^antigravity.*\.exe$/i.test(baseName));
    if (looksLikeDirectInstaller) {
        return { elevated: false, installerPath: command, installerArgsOffset: 0 };
    }

    if (baseName === 'elevate.exe' && args.length >= 2 && typeof args[0] === 'string') {
        const innerCmd = args[0];
        const innerArgs = args.slice(1);
        const innerBase = path.basename(innerCmd).toLowerCase();
        if (
            innerArgs.includes('--updated') &&
            (innerCmd.toLowerCase().includes('antigravity-updater') || /^antigravity.*\.exe$/i.test(innerBase))
        ) {
            return { elevated: true, installerPath: innerCmd, installerArgsOffset: 1 };
        }
    }
    return null;
}

function rewriteUpdaterArgs(args, offset) {
    const prefix = args.slice(0, offset);
    const updaterArgs = args.slice(offset);
    let hadForceRun = false;
    let hasSilent = false;
    const filtered = [];

    for (const arg of updaterArgs) {
        const s = String(arg);
        if (s === '--force-run') {
            hadForceRun = true;
            continue;
        }
        if (s.toUpperCase() === '/S') {
            hasSilent = true;
        }
        filtered.push(arg);
    }
    if (!hasSilent) filtered.push('/S');
    return { nextArgs: prefix.concat(filtered), hadForceRun };
}

function isLoopbackHubUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
        const host = parsed.hostname.toLowerCase();
        return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    } catch {
        return false;
    }
}

function isAuthorizedHubIpcEvent(event, allowedContentsSet, isKnownHubContentsFn) {
    const sender = event && event.sender;
    if (!sender) return false;
    try {
        if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return false;
        if (typeof sender.getType === 'function' && sender.getType() === 'webview') return false;
        const frame = event.senderFrame;
        if (!frame || frame.parent) return false;
        if (sender.mainFrame && frame !== sender.mainFrame) return false;
        const rawUrl = typeof sender.getURL === 'function' ? sender.getURL() : '';
        if (!isLoopbackHubUrl(rawUrl)) return false;
        if (allowedContentsSet && allowedContentsSet.has(sender)) return true;
        if (typeof isKnownHubContentsFn === 'function' && isKnownHubContentsFn(sender)) return true;
        return false;
    } catch {
        return false;
    }
}

function registerMenuPreloadForSession(ses, preloadPath) {
    if (!ses || typeof preloadPath !== 'string' || !preloadPath.trim()) {
        return { ok: false, mode: null };
    }
    const resolvedPath = path.resolve(preloadPath);
    if (!fs.existsSync(resolvedPath)) {
        return { ok: false, mode: null };
    }
    const normalizedTarget = resolvedPath.toLowerCase();

    if (typeof ses.registerPreloadScript === 'function') {
        const existing = typeof ses.getPreloadScripts === 'function' ? ses.getPreloadScripts() : [];
        const already = Array.isArray(existing) && existing.some(
            entry => entry && (
                entry.id === MENU_PRELOAD_ID ||
                (typeof entry.filePath === 'string' && path.resolve(entry.filePath).toLowerCase() === normalizedTarget)
            )
        );
        if (!already) {
            ses.registerPreloadScript({
                id: MENU_PRELOAD_ID,
                type: 'frame',
                filePath: resolvedPath
            });
        }
        return { ok: true, mode: 'registerPreloadScript' };
    }

    if (typeof ses.setPreloads === 'function' && typeof ses.getPreloads === 'function') {
        const current = ses.getPreloads();
        const list = Array.isArray(current) ? current : [];
        const already = list.some(p => typeof p === 'string' && path.resolve(p).toLowerCase() === normalizedTarget);
        if (!already) {
            ses.setPreloads([...list, resolvedPath]);
        }
        return { ok: true, mode: 'setPreloads' };
    }

    return { ok: false, mode: null };
}

function writeJsonSafe(filePath, data) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch {}
}

function bootstrap(ctx) {
    const installRoot = ctx?.installRoot || defaultInstallRoot();
    const {
        appDir,
        realAsarPath,
        realPkg,
        electron,
        childProcessModule = cp,
        postUpdateScript = path.join(__dirname, 'post-update-relaunch.cjs'),
        runtimeStateFile = path.join(installRoot, 'runtime_state.json'),
        menuPreloadScript = path.join(installRoot, 'src', 'preload', 'window-menu-preload.cjs'),
        utilsModuleOverride = null,
        forceNewInstance = false
    } = ctx || {};

    if (!forceNewInstance && globalThis.__agyPlusRuntimeInitialized) {
        return globalThis.__agyPlusRuntimeState;
    }
    if (!forceNewInstance) {
        globalThis.__agyPlusRuntimeInitialized = true;
    }

    const logFile = path.join(installRoot, 'logs', 'patch.log');
    const appendLog = msg => {
        try {
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
            fs.appendFileSync(logFile, `[${new Date().toISOString()}] [Runtime] ${msg}\n`, 'utf8');
        } catch {}
    };

    const app = electron && electron.app;
    let cachedConfig = loadConfig({ installRoot });
    let cachedConfigAt = Date.now();
    const getFreshConfig = () => {
        const now = Date.now();
        if (now - cachedConfigAt > 1500) {
            cachedConfig = loadConfig({ installRoot });
            cachedConfigAt = now;
        }
        return cachedConfig;
    };

    const resourcesDir = realAsarPath ? path.dirname(realAsarPath) : '';

    // 1. Sync resources/app/package.json version
    try {
        if (appDir && realPkg && realPkg.version) {
            const shimPkgPath = path.join(appDir, 'package.json');
            let currentVer = '';
            try { currentVer = JSON.parse(fs.readFileSync(shimPkgPath, 'utf8')).version; } catch {}
            if (currentVer !== realPkg.version) {
                const syncedPkg = Object.assign({}, realPkg, { main: 'index.js' });
                delete syncedPkg.dependencies;
                delete syncedPkg.devDependencies;
                fs.writeFileSync(shimPkgPath, JSON.stringify(syncedPkg, null, 2) + '\n', 'utf8');
            }
        }
    } catch {}

    if (app && realAsarPath) {
        try {
            if (realPkg && realPkg.version) {
                if (typeof app.setVersion === 'function') app.setVersion(realPkg.version);
                app.getVersion = () => realPkg.version;
            }
            app.getAppPath = () => realAsarPath;
        } catch {}
    }

    // 2. Clean hazardous inherited env & optional process-scoped loopback proxy
    delete process.env.NODE_OPTIONS;
    delete process.env.ELECTRON_RUN_AS_NODE;
    const proxyDisabledByEnv = process.env.AGY_NATIVE_PROXY_DISABLE === '1';
    const proxyResolved = proxyDisabledByEnv
        ? { url: null, source: 'disabled_by_env' }
        : resolveProxyUrl(cachedConfig, childProcessModule.execFileSync || cp.execFileSync);

    if (proxyResolved.url) {
        process.env.HTTP_PROXY = proxyResolved.url;
        process.env.HTTPS_PROXY = proxyResolved.url;
        process.env.NO_PROXY = DEFAULT_NO_PROXY;
        delete process.env.ALL_PROXY;

        if (app?.commandLine && typeof app.commandLine.appendSwitch === 'function') {
            try {
                if (!app.commandLine.hasSwitch || !app.commandLine.hasSwitch('proxy-server')) {
                    app.commandLine.appendSwitch('proxy-server', proxyResolved.url);
                }
                if (!app.commandLine.hasSwitch || !app.commandLine.hasSwitch('proxy-bypass-list')) {
                    app.commandLine.appendSwitch('proxy-bypass-list', DEFAULT_CHROMIUM_BYPASS);
                }
            } catch (err) {
                appendLog(`Failed to configure Chromium proxy switches: ${err && err.message ? err.message : err}`);
            }
        }
    }

    const runtimeState = {
        ShimVersion: 'ANTIGRAVITY_PLUS_SHIM_V3',
        InstallRoot: installRoot,
        StartedAt: new Date().toISOString(),
        AppVersion: (realPkg && realPkg.version) || 'unknown',
        AppPid: process.pid,
        AppExe: process.execPath,
        ProxyUrl: proxyResolved.url,
        ProxySource: proxyResolved.source,
        ProxyListening: null,
        NoProxy: proxyResolved.url ? DEFAULT_NO_PROXY : null,
        ChangesPersistentEnvironment: false,
        BackendPid: null,
        FastpushOverrideArgument: null,
        UpdaterHookInstalled: true,
        ExternalBrowserConfigured: false,
        ExternalBrowserPath: null,
        UiControllerInstalled: false,
        NewWindowJumpListInstalled: false,
        NewWindowMenuInstalled: false,
        NewWindowMenuPreloadMode: null
    };
    globalThis.__agyPlusRuntimeState = runtimeState;

    // 3. Intercept child_process.spawn for Fastpush fix + seamless NSIS auto-update relaunch
    const origSpawn = childProcessModule.spawn;
    if (!childProcessModule.__agyPlusSpawnPatched && typeof origSpawn === 'function') {
        childProcessModule.spawn = function agyPlusPatchedSpawn(command, args, options) {
            let finalArgs = args;
            let finalOptions = options;
            const liveConfig = getFreshConfig();

            const isLs = isLanguageServerStandalone(command, finalArgs);
            if (isLs) {
                if (
                    liveConfig.features.fastpushFix !== false &&
                    proxyResolved.url &&
                    !finalArgs.some(a => String(a).startsWith('--remote_agent_fastpush_override'))
                ) {
                    finalArgs = [...finalArgs, '--remote_agent_fastpush_override=false'];
                }
                if (finalOptions && finalOptions.env) {
                    const cleanedEnv = {};
                    for (const [k, v] of Object.entries(finalOptions.env)) {
                        const kl = k.toLowerCase();
                        if (kl === 'node_options' || kl === 'all_proxy' || kl === 'electron_run_as_node') continue;
                        if (proxyResolved.url && liveConfig.features.localProxy !== false &&
                            (kl === 'http_proxy' || kl === 'https_proxy' || kl === 'no_proxy')) {
                            continue;
                        }
                        cleanedEnv[k] = v;
                    }
                    if (proxyResolved.url && liveConfig.features.localProxy !== false) {
                        cleanedEnv.HTTP_PROXY = proxyResolved.url;
                        cleanedEnv.HTTPS_PROXY = proxyResolved.url;
                        cleanedEnv.NO_PROXY = DEFAULT_NO_PROXY;
                    }
                    finalOptions = Object.assign({}, finalOptions, { env: cleanedEnv });
                }
            }

            const updaterInfo = detectUpdaterSpawn(command, finalArgs);
            let pendingPostUpdate = null;
            if (updaterInfo && fs.existsSync(postUpdateScript)) {
                const systemNode = resolveSystemNode();
                const psExe = process.platform === 'win32'
                    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
                    : '';
                const hasPsFallback = Boolean(!systemNode && psExe && fs.existsSync(psExe));
                if (systemNode || hasPsFallback) {
                    const rewritten = rewriteUpdaterArgs(finalArgs, updaterInfo.installerArgsOffset);
                    finalArgs = rewritten.nextArgs;
                    let prevRealSnap = '';
                    try {
                        if (realAsarPath && fs.existsSync(realAsarPath)) {
                            const st = fs.statSync(realAsarPath);
                            if (st.isFile() && st.size > 0) {
                                prevRealSnap = `${st.size}:${Math.floor(st.mtimeMs)}`;
                            }
                        }
                    } catch {}
                    pendingPostUpdate = {
                        systemNode: systemNode || null,
                        psExe: hasPsFallback ? psExe : null,
                        hadForceRun: rewritten.hadForceRun,
                        installerPath: updaterInfo.installerPath,
                        prevVersion: String((realPkg && realPkg.version) || ''),
                        prevRealSnap
                    };
                    appendLog(`Intercepted updater spawn (${updaterInfo.installerPath}); hadForceRun=${rewritten.hadForceRun}`);
                }
            }

            const child = origSpawn.call(this, command, finalArgs, finalOptions);

            if (isLs && child) {
                runtimeState.BackendPid = child.pid || null;
                runtimeState.FastpushOverrideArgument =
                    finalArgs.find(a => String(a).startsWith('--remote_agent_fastpush_override')) || null;
                runtimeState.BackendStartedAt = new Date().toISOString();
                writeJsonSafe(runtimeStateFile, runtimeState);
            }

            if (pendingPostUpdate && child) {
                try {
                    const helperEnv = Object.assign({}, process.env, { AGY_PLUS_ROOT: installRoot });
                    delete helperEnv.ELECTRON_RUN_AS_NODE;
                    delete helperEnv.NODE_OPTIONS;
                    delete helperEnv.PSModulePath;
                    const helperArgs = [
                        postUpdateScript,
                        '--parent-pid', String(process.pid),
                        '--installer-pid', String(child.pid || 0),
                        '--relaunch', pendingPostUpdate.hadForceRun ? '1' : '0',
                        '--exe', process.execPath,
                        '--resources-dir', resourcesDir
                    ];
                    if (pendingPostUpdate.prevVersion) {
                        helperArgs.push('--prev-version', pendingPostUpdate.prevVersion);
                    }
                    if (pendingPostUpdate.prevRealSnap) {
                        helperArgs.push('--prev-real-snap', pendingPostUpdate.prevRealSnap);
                    }
                    if (pendingPostUpdate.systemNode) {
                        const helper = origSpawn.call(this, pendingPostUpdate.systemNode, helperArgs, {
                            cwd: installRoot,
                            env: helperEnv,
                            detached: true,
                            stdio: 'ignore',
                            windowsHide: true
                        });
                        helper?.unref?.();
                    } else if (pendingPostUpdate.psExe) {
                        // Zero-Node fallback via -EncodedCommand (UTF-16LE Base64) to avoid all quoting bugs.
                        // Waits until processes exit AND either new app.asar appears/stabilizes or app.real.asar changes
                        // relative to pre-update baseline before touching Antigravity.exe (prevents file lock race).
                        const escPs = s => String(s).replace(/'/g, "''");
                        const watchPids = [process.pid, child.pid].filter(pid => Number.isInteger(pid) && pid > 0);
                        const relaunchFlag = pendingPostUpdate.hadForceRun ? '1' : '0';
                        const psScript = [
                            `$watchPids = @(${watchPids.join(',')})`,
                            `$resDir = '${escPs(resourcesDir)}'`,
                            `$asarPath = Join-Path $resDir 'app.asar'`,
                            `$realAsarPath = Join-Path $resDir 'app.real.asar'`,
                            `$prevSnap = '${escPs(pendingPostUpdate.prevRealSnap)}'`,
                            `$deadline = (Get-Date).AddMinutes(4)`,
                            `$lastSnap = ''; $stableSince = [DateTime]::MinValue; $ready = $false`,
                            `while ((Get-Date) -lt $deadline) {`,
                            `  $alive = (($watchPids.Count -gt 0) -and (Get-Process -Id $watchPids -ErrorAction SilentlyContinue)) -or (Get-Process -Name 'Antigravity-x64','Au_','Uninstall Antigravity' -ErrorAction SilentlyContinue)`,
                            `  if (-not $alive) {`,
                            `    if (Test-Path -LiteralPath $asarPath) {`,
                            `      try { $fi = Get-Item -LiteralPath $asarPath; $s = "$($fi.Length):$([long](($fi.LastWriteTimeUtc - [DateTime]'1970-01-01').TotalMilliseconds))"; if ($s -eq $lastSnap) { if (((Get-Date) - $stableSince).TotalMilliseconds -ge 1200) { $ready = $true; break } } else { $lastSnap = $s; $stableSince = Get-Date } } catch {}`,
                            `    } elseif ($prevSnap -and (Test-Path -LiteralPath $realAsarPath)) {`,
                            `      try { $ri = Get-Item -LiteralPath $realAsarPath; $rs = "$($ri.Length):$([long](($ri.LastWriteTimeUtc - [DateTime]'1970-01-01').TotalMilliseconds))"; if ($rs -ne $prevSnap) { $ready = $true; break } } catch {}`,
                            `    }`,
                            `  }`,
                            `  Start-Sleep -Milliseconds 500`,
                            `}`,
                            `if ($ready) {`,
                            `  $env:ELECTRON_RUN_AS_NODE = '1'`,
                            `  $env:AGY_PLUS_ROOT = '${escPs(installRoot)}'`,
                            `  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue`,
                            `  $psi = New-Object System.Diagnostics.ProcessStartInfo('${escPs(process.execPath)}')`,
                            `  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true`,
                            `  $argsArr = @('${escPs(postUpdateScript)}','--parent-pid','0','--installer-pid','0','--skip-tasklist','--stable-ms','800','--relaunch','${relaunchFlag}','--exe','${escPs(process.execPath)}','--resources-dir','${escPs(resourcesDir)}','--prev-version','${escPs(pendingPostUpdate.prevVersion)}','--prev-real-snap','${escPs(pendingPostUpdate.prevRealSnap)}')`,
                            `  $quoted = ($argsArr | ForEach-Object { '"' + ($_.Replace('\"','\\\"')) + '"' }) -join ' '`,
                            `  $psi.Arguments = $quoted`,
                            `  $p2 = [System.Diagnostics.Process]::Start($psi)`,
                            `  if ($p2) { $p2.WaitForExit(30000) | Out-Null; $p2.Dispose() }`,
                            `}`
                        ].join('\n');
                        const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
                        const helper = origSpawn.call(this, pendingPostUpdate.psExe, [
                            '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedCmd
                        ], {
                            cwd: installRoot,
                            env: helperEnv,
                            detached: false,
                            stdio: 'ignore',
                            windowsHide: true
                        });
                        helper?.unref?.();
                    }
                } catch (err) {
                    appendLog(`Failed to spawn post-update helper: ${err && err.message ? err.message : err}`);
                }
            }

            return child;
        };
        childProcessModule.__agyPlusSpawnPatched = true;
    }

    // 4. Dynamic External Browser hook
    if (electron?.shell) {
        try {
            const extRes = externalBrowser.install({
                shell: electron.shell,
                spawn: origSpawn,
                getConfig: getFreshConfig,
                receiptPath: path.join(installRoot, 'logs', 'last-external-browser.json')
            });
            runtimeState.ExternalBrowserConfigured = Boolean(extRes && extRes.configured);
            runtimeState.ExternalBrowserPath = extRes?.browserPath || null;
        } catch (err) {
            appendLog(`External browser hook skipped: ${err && err.message ? err.message : err}`);
        }
    }

    // 5. Main-process UI/Telemetry/Translation/Toast controller
    let mainHookRuntime = null;
    let syncJumpListFn = null;
    if (app && electron?.webContents) {
        try {
            const mainHookPath = path.join(installRoot, 'src', 'main', 'main-hook.cjs');
            if (fs.existsSync(mainHookPath)) {
                const uiRes = require(mainHookPath).install({
                    app,
                    webContents: electron.webContents,
                    BrowserWindow: electron.BrowserWindow,
                    installRoot,
                    logPath: path.join(installRoot, 'logs', 'last-ui-customization.json'),
                    onConfigUpdated: nextCfg => {
                        cachedConfig = nextCfg;
                        cachedConfigAt = Date.now();
                        try { syncJumpListFn?.(nextCfg); } catch {}
                    }
                });
                mainHookRuntime = uiRes?.runtime || null;
                runtimeState.UiControllerInstalled = Boolean(uiRes && uiRes.installed);
            }
        } catch (err) {
            appendLog(`Main UI hook error: ${err && err.message ? err.message : err}`);
        }
    }

    // 6. Multi-window (JumpList + Top Window Menu + CLI --new-window / -n) & IPC config bridge
    if (app && realAsarPath) {
        let lastUrl = null;
        let lastStorageManager = undefined;
        let utilsMod = null;
        let ipcRegistered = false;
        const allowedHubContents = new WeakSet();
        const onNewWindowByContents = new WeakMap();
        const registeredSessions = new WeakSet();

        const ipcMain = electron && electron.ipcMain;
        const sessionMod = electron && electron.session;

        const mainEntryRel = ((realPkg && realPkg.main) || 'dist/main.js').replace(/\\/g, '/');
        const mainDirRel = path.posix.dirname(mainEntryRel);
        const utilsFullPath = path.join(realAsarPath, mainDirRel, 'utils');
        const lsFullPath = path.join(realAsarPath, mainDirRel, 'languageServer');
        const constFullPath = path.join(realAsarPath, mainDirRel, 'constants');

        function isKnownHubContents(sender) {
            try {
                const uMod = ensureUtilsWrapped();
                if (!uMod) return false;
                const listFn = typeof uMod.getHubWindows === 'function'
                    ? uMod.getHubWindows
                    : (typeof uMod.getLocalHubWindows === 'function' ? uMod.getLocalHubWindows : null);
                if (!listFn) return false;
                const wins = listFn();
                if (!Array.isArray(wins)) return false;
                for (const win of wins) {
                    const wc = (typeof uMod.getHubWebContents === 'function' ? uMod.getHubWebContents(win) : null) || win?.webContents;
                    if (wc === sender) return true;
                }
            } catch {}
            return false;
        }

        function ensureMenuAndConfigBridge(partition) {
            if (!ipcRegistered && ipcMain && typeof ipcMain.handle === 'function') {
                try {
                    ipcMain.removeHandler?.(NEW_WINDOW_IPC_CHANNEL);
                    ipcMain.handle(NEW_WINDOW_IPC_CHANNEL, event => {
                        if (!isAuthorizedHubIpcEvent(event, allowedHubContents, isKnownHubContents)) {
                            return false;
                        }
                        const customHandler = onNewWindowByContents.get(event.sender);
                        if (typeof customHandler === 'function') {
                            customHandler();
                            return true;
                        }
                        return openNewHubWindow();
                    });

                    ipcMain.removeHandler?.(CONFIG_UPDATE_IPC_CHANNEL);
                    ipcMain.handle(CONFIG_UPDATE_IPC_CHANNEL, async (event, patch) => {
                        if (!isAuthorizedHubIpcEvent(event, allowedHubContents, isKnownHubContents)) {
                            return { ok: false, error: 'unauthorized' };
                        }
                        cachedConfigAt = 0;
                        if (mainHookRuntime && typeof mainHookRuntime.handleBridgeAction === 'function') {
                            return await mainHookRuntime.handleBridgeAction({ action: 'update_config', patch });
                        }
                        const saved = updateConfig(patch, { installRoot });
                        cachedConfig = saved;
                        cachedConfigAt = Date.now();
                        try { syncJumpListFn?.(saved); } catch {}
                        return { ok: true, config: saved };
                    });

                    ipcRegistered = true;
                } catch (err) {
                    appendLog(`Failed to register IPC handlers: ${err && err.message ? err.message : err}`);
                }
            }

            if (sessionMod) {
                const targets = [];
                try { if (sessionMod.defaultSession) targets.push(sessionMod.defaultSession); } catch {}
                if (typeof partition === 'string' && partition.trim() && typeof sessionMod.fromPartition === 'function') {
                    try {
                        const partSes = sessionMod.fromPartition(partition);
                        if (partSes && !targets.includes(partSes)) targets.push(partSes);
                    } catch {}
                }
                for (const ses of targets) {
                    if (!ses || registeredSessions.has(ses)) continue;
                    try {
                        const reg = registerMenuPreloadForSession(ses, menuPreloadScript);
                        if (reg.ok) {
                            registeredSessions.add(ses);
                            runtimeState.NewWindowMenuInstalled = Boolean(ipcRegistered);
                            runtimeState.NewWindowMenuPreloadMode = reg.mode;
                        }
                    } catch (err) {
                        appendLog(`Failed to register preload: ${err && err.message ? err.message : err}`);
                    }
                }
            }
        }

        function ensureUtilsWrapped() {
            if (utilsMod) return utilsMod;
            try {
                utilsMod = utilsModuleOverride || require(utilsFullPath);
                if (utilsMod && typeof utilsMod.createWindow === 'function' && !utilsMod.__agyPlusCreateWindowWrapped) {
                    const origCreateWindow = utilsMod.createWindow;
                    const wrappedCreateWindow = function (url, storageManager, options) {
                        if (typeof url === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\b/i.test(url)) {
                            lastUrl = url;
                        } else if (typeof url === 'string' && !lastUrl) {
                            lastUrl = url;
                        }
                        if (storageManager !== undefined) lastStorageManager = storageManager;
                        ensureMenuAndConfigBridge(options && options.partition);
                        const win = origCreateWindow.apply(this, arguments);
                        if (win) {
                            try {
                                const hubContents = (typeof utilsMod.getHubWebContents === 'function' ? utilsMod.getHubWebContents(win) : null) || win.webContents;
                                if (hubContents) {
                                    allowedHubContents.add(hubContents);
                                    if (options && typeof options.onNewWindow === 'function') {
                                        onNewWindowByContents.set(hubContents, options.onNewWindow);
                                    }
                                }
                            } catch {}
                        }
                        return win;
                    };
                    const desc = Object.getOwnPropertyDescriptor(utilsMod, 'createWindow');
                    if (!desc || desc.writable) {
                        utilsMod.createWindow = wrappedCreateWindow;
                    } else if (desc.configurable) {
                        Object.defineProperty(utilsMod, 'createWindow', {
                            enumerable: true,
                            configurable: true,
                            get: () => wrappedCreateWindow
                        });
                    }
                    Object.defineProperty(utilsMod, '__agyPlusCreateWindowWrapped', {
                        value: true,
                        enumerable: false,
                        configurable: true
                    });
                }
            } catch (err) {
                appendLog(`Failed to wrap utils.createWindow: ${err && err.message ? err.message : err}`);
            }
            return utilsMod;
        }

        function resolveHubUrl() {
            if (process.env.DEV_URL) return process.env.DEV_URL;
            try {
                const lsMod = require(lsFullPath);
                let origin = 'https://127.0.0.1';
                try {
                    const constMod = require(constFullPath);
                    if (constMod && constMod.WINDOW_ORIGIN) origin = constMod.WINDOW_ORIGIN;
                } catch {}
                const port = typeof lsMod.getLsPort === 'function' ? lsMod.getLsPort() : 0;
                if (port && port > 0) return `${origin}:${port}/`;
            } catch {}
            if (lastUrl) return lastUrl;
            try {
                const uMod = ensureUtilsWrapped();
                const wins = uMod && typeof uMod.getLocalHubWindows === 'function' ? uMod.getLocalHubWindows() : [];
                if (wins.length > 0 && typeof uMod.getHubWebContents === 'function') {
                    const currentUrl = uMod.getHubWebContents(wins[0])?.getURL?.();
                    if (currentUrl) {
                        const parsed = new URL(currentUrl);
                        return `${parsed.origin}/`;
                    }
                }
            } catch {}
            return null;
        }

        function openNewHubWindow() {
            if (process.env.ELECTRON_OZONE_PLATFORM_HINT === 'headless') return false;
            const uMod = ensureUtilsWrapped();
            const targetUrl = resolveHubUrl();
            if (!targetUrl || !uMod || typeof uMod.createWindow !== 'function') return false;
            const win = uMod.createWindow(targetUrl, lastStorageManager, { cascade: true });
            if (win) {
                try {
                    win.show?.();
                    win.focus?.();
                } catch {}
            }
            try { app.focus({ steal: true }); } catch {}
            return true;
        }

        if (typeof app.on === 'function') {
            const origAppOn = app.on.bind(app);
            app.on = function (event, listener) {
                if (event === 'second-instance' && typeof listener === 'function') {
                    const wrappedSecondInstance = function (_ev, commandLine) {
                        try {
                            const hasDeepLink = Array.isArray(commandLine) && commandLine.some(a => typeof a === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(a));
                            const hasSsh = Array.isArray(commandLine) && commandLine.some(a => typeof a === 'string' && a.startsWith('--ssh-host='));
                            const hasNewWin = Array.isArray(commandLine) && commandLine.some(a => a === '--new-window' || a === '-n');
                            if (hasNewWin && !hasDeepLink && !hasSsh && getFreshConfig().features.newWindowMenu !== false) {
                                if (openNewHubWindow()) return;
                            }
                        } catch {}
                        return listener.apply(this, arguments);
                    };
                    return origAppOn(event, wrappedSecondInstance);
                }
                return origAppOn(event, listener);
            };
        }

        function syncJumpList(cfg) {
            if (process.platform !== 'win32' || typeof app.setUserTasks !== 'function') return;
            try {
                const tasks = cfg?.features?.newWindowMenu !== false
                    ? [{
                        program: process.execPath,
                        arguments: '--new-window',
                        iconPath: process.execPath,
                        iconIndex: 0,
                        workingDirectory: path.dirname(process.execPath),
                        title: '新建窗口',
                        description: '打开一个新的 Antigravity 窗口'
                    }]
                    : [];
                const ok = app.setUserTasks(tasks);
                runtimeState.NewWindowJumpListInstalled = Boolean(ok && tasks.length > 0);
            } catch {}
        }
        syncJumpListFn = syncJumpList;

        process.nextTick(() => {
            ensureUtilsWrapped();
            if (typeof app.whenReady === 'function') {
                app.whenReady().then(async () => {
                    ensureMenuAndConfigBridge();
                    syncJumpList(cachedConfig);

                    if (proxyResolved.url) {
                        runtimeState.ProxyListening = await probeLocalTcp(proxyResolved.url, 1200);
                    }
                    writeJsonSafe(runtimeStateFile, runtimeState);
                }).catch(() => {});
            }
        });
    }

    return runtimeState;
}

module.exports = {
    bootstrap,
    validateLoopbackHttpProxy,
    parseWinInetProxyOutput,
    resolveProxyUrl,
    isLanguageServerStandalone,
    detectUpdaterSpawn,
    rewriteUpdaterArgs,
    isLoopbackHubUrl,
    isAuthorizedHubIpcEvent,
    registerMenuPreloadForSession,
    NEW_WINDOW_IPC_CHANNEL,
    CONFIG_UPDATE_IPC_CHANNEL,
    MENU_PRELOAD_ID
};
