'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
    defaultInstallRoot,
    loadConfig,
    updateConfig,
    resolveOfflineTranslatorRoot
} = require('../core/config-manager.cjs');
const defaultTranslator = require('./translator.cjs');
const defaultToastClient = require('../toast/toast-client.cjs');
const { defaultBridgePipeName, bridgePipePath } = require('./bridge-client.cjs');

const UI_CORE_VERSION = 10;
const THOUGHT_UI_VERSION = 7;
const DEFAULT_MODEL_UI_VERSION = 2;
const NAV_UI_VERSION = 2;
const TITLE_CACHE_LIMIT = 2000;

function loadTitleCache(cachePath) {
    try {
        if (!fs.existsSync(cachePath)) return {};
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8').replace(/^\uFEFF/, ''));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function saveTitleCache(cachePath, cacheObj) {
    try {
        const keys = Object.keys(cacheObj);
        if (keys.length > TITLE_CACHE_LIMIT) {
            for (const oldKey of keys.slice(0, keys.length - TITLE_CACHE_LIMIT)) {
                delete cacheObj[oldKey];
            }
        }
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(cacheObj, null, 2), 'utf8');
    } catch {}
}

function buildRuntimeMeta(config) {
    const offlineRoot = resolveOfflineTranslatorRoot(config?.translation?.offlineRoot);
    return {
        offlineAvailable: Boolean(offlineRoot),
        offlineRoot: offlineRoot || ''
    };
}

function buildExpression(options = {}) {
    const installRoot = options.installRoot || defaultInstallRoot();
    const config = options.config || loadConfig({ installRoot });
    const runtimeMeta = options.runtimeMeta || buildRuntimeMeta(config);
    const rendererDir = path.join(installRoot, 'src', 'renderer');

    const performance = fs.readFileSync(path.join(rendererDir, 'performance.js'), 'utf8');
    const uiCore = fs.readFileSync(path.join(rendererDir, 'ui-core.js'), 'utf8');
    const thoughtLocalization = fs.readFileSync(path.join(rendererDir, 'thought-localization.js'), 'utf8');
    const defaultModelScript = fs.readFileSync(path.join(rendererDir, 'default-model.js'), 'utf8');
    const navGesturesScript = fs.readFileSync(path.join(rendererDir, 'navigation-gestures.js'), 'utf8');

    const thoughtSummariesPath = path.join(installRoot, 'config', 'thought-summaries.json');
    const thoughtSummaries = fs.existsSync(thoughtSummariesPath)
        ? JSON.parse(fs.readFileSync(thoughtSummariesPath, 'utf8'))
        : {};
    const resolvedTitleCache = options.titleCache || loadTitleCache(path.join(installRoot, 'cache', 'title-translations.json'));
    const themeCss = fs.readFileSync(path.join(rendererDir, 'theme.css'), 'utf8');
    const widgetsCss = fs.readFileSync(path.join(rendererDir, 'widgets.css'), 'utf8');

    const defaultModelCfg = {
        enabled: config.features.autoHighestModel !== false,
        strategy: config.model.strategy,
        preferredModelHint: config.model.preferredModelHint,
        preferredEffortHint: config.model.preferredEffortHint
    };

    return `(async () => {
        if (!window.nativeStorage || !document.body ||
            (!document.querySelector('[data-testid="agent-input-box"]') &&
             !document.querySelector('[data-testid="sidebar-navigation-items"]') &&
             !document.querySelector('.bg-sidebar'))) return { ready: false };
        // Clean up any legacy Derrick globals during hot-upgrade so no duplicate badges remain
        try { window.__derrickDefaultModel?.dispose?.(); } catch {}
        try { window.__derrickNavUI?.dispose?.(); } catch {}
        try { window.__derrickThoughtUI?.dispose?.(); } catch {}
        try { window.__derrickUI?.dispose?.(); } catch {}

        const cfg = ${JSON.stringify(config)};
        if (cfg.features.codexTheme !== false || cfg.features.contextRing !== false) {
            const settings = await window.nativeStorage.getItems();
            const patch = {};
            if (cfg.features.contextRing !== false && settings.contextUsageIndicatorEnabled !== 'true') {
                patch.contextUsageIndicatorEnabled = 'true';
            }
            if (cfg.features.codexTheme !== false) {
                let canUseLocalStorage = false;
                let sidebarInitialized = false;
                try {
                    if (window.localStorage && typeof window.localStorage.getItem === 'function') {
                        canUseLocalStorage = true;
                        sidebarInitialized = window.localStorage.getItem('agy_plus_sidebar_init_v1') === '1';
                    }
                } catch {}
                if (canUseLocalStorage ? !sidebarInitialized : !settings.sidebarWidth) {
                    if (settings.sidebarWidth !== '264') {
                        patch.sidebarWidth = '264';
                    }
                    if (canUseLocalStorage) {
                        try { window.localStorage.setItem('agy_plus_sidebar_init_v1', '1'); } catch {}
                    }
                }
            }
            if (Object.keys(patch).length > 0) {
                await window.nativeStorage.updateItems(patch);
            }
        }
        ${performance}
        ${uiCore}
        ${thoughtLocalization}
        ${defaultModelScript}
        ${navGesturesScript}
        const uiStatus = installAgyPlusUI({
            themeCss: ${JSON.stringify(themeCss)},
            widgetsCss: ${JSON.stringify(widgetsCss)},
            config: cfg,
            runtimeMeta: ${JSON.stringify(runtimeMeta)}
        });
        const thoughtStatus = installAgyPlusThoughtTranslations(
            ${JSON.stringify(thoughtSummaries)},
            ${JSON.stringify(resolvedTitleCache)},
            {
                thoughtTranslation: cfg.features.thoughtTranslation !== false,
                titleTranslation: cfg.features.titleTranslation !== false
            }
        );
        const defaultModelStatus = installAgyPlusDefaultModel(${JSON.stringify(defaultModelCfg)});
        const navigationStatus = installAgyPlusNavigationGestures({
            enabled: cfg.features.navigationGestures !== false
        });
        return {
            ready: true,
            ...uiStatus,
            thought: thoughtStatus,
            defaultModel: defaultModelStatus,
            navigation: navigationStatus
        };
    })()`;
}

function buildConfigSyncExpression(config, runtimeMeta) {
    const defaultModelCfg = {
        enabled: config.features.autoHighestModel !== false,
        strategy: config.model.strategy,
        preferredModelHint: config.model.preferredModelHint,
        preferredEffortHint: config.model.preferredEffortHint
    };
    return `(() => {
        const cfg = ${JSON.stringify(config)};
        const meta = ${JSON.stringify(runtimeMeta)};
        window.__agyPlusUI?.applyConfig?.(cfg, meta);
        window.__agyPlusThoughtUI?.setFeatures?.({
            thoughtTranslation: cfg.features.thoughtTranslation !== false,
            titleTranslation: cfg.features.titleTranslation !== false
        });
        window.__agyPlusDefaultModel?.setConfig?.(${JSON.stringify(defaultModelCfg)});
        window.__agyPlusNavUI?.setEnabled?.(cfg.features.navigationGestures !== false);
        return true;
    })()`;
}

function buildNavigateExpression(conversationId, waitReady = false) {
    const safeId = JSON.stringify(conversationId);
    const waitReadyFlag = JSON.stringify(Boolean(waitReady));
    return `(async () => {
        const id = ${safeId};
        if (${waitReadyFlag}) {
            for (let i = 0; i < 40; i++) {
                if (document.querySelector('.bg-sidebar') || document.querySelector('[data-testid="agent-input-box"]')) break;
                await new Promise(r => setTimeout(r, 150));
            }
        }
        if (window.__agyPlusUI && typeof window.__agyPlusUI.openConversation === 'function') {
            return await window.__agyPlusUI.openConversation(id);
        }
        const targetPath = '/c/' + id;
        if (location.pathname === targetPath) return { navigated: true, method: 'already_open' };
        const existingLink = Array.from(document.querySelectorAll('a[href]')).find(a => {
            try { return new URL(a.href, location.origin).pathname === targetPath; } catch { return false; }
        });
        if (existingLink) {
            existingLink.click();
            await new Promise(r => setTimeout(r, 80));
            if (location.pathname === targetPath) return { navigated: true, method: 'sidebar_link' };
        }
        const tempLink = document.createElement('a');
        tempLink.href = targetPath;
        tempLink.style.display = 'none';
        (document.querySelector('.bg-sidebar') || document.body).appendChild(tempLink);
        try {
            tempLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 }));
        } finally {
            tempLink.remove();
        }
        await new Promise(r => setTimeout(r, 80));
        if (location.pathname === targetPath) return { navigated: true, method: 'synthetic_link' };
        history.pushState(history.state, '', targetPath);
        window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        return { navigated: true, method: 'history_popstate' };
    })()`;
}

function tryResolveBrowserWindow(explicit) {
    if (explicit) return explicit;
    try {
        return require('electron').BrowserWindow || null;
    } catch {
        return null;
    }
}

function install(options) {
    const installRoot = options?.installRoot || defaultInstallRoot();
    const {
        app,
        webContents,
        logPath,
        translator = defaultTranslator,
        toastClient = defaultToastClient,
        bridgePipeName = defaultBridgePipeName(installRoot),
        translateIntervalMs = 260,
        syncIntervalMs = 1000,
        disableTimers = false,
        forceNewInstance = false
    } = options || {};

    if (!forceNewInstance && globalThis.__agyPlusMainHookRuntime && !globalThis.__agyPlusMainHookRuntime.disposed) {
        return {
            installed: true,
            alreadyInstalled: true,
            bridgePipeName: globalThis.__agyPlusMainHookRuntime.bridgePipeName
        };
    }

    const BrowserWindow = tryResolveBrowserWindow(options?.BrowserWindow);
    const logsDir = path.join(installRoot, 'logs');
    const uiLogPath = logPath || path.join(logsDir, 'last-ui-customization.json');
    const backupSettingsPath = path.join(installRoot, 'settings-before.json');
    const titleCachePath = options?.titleCachePath || path.join(installRoot, 'cache', 'title-translations.json');
    const titleCache = loadTitleCache(titleCachePath);
    const attachedContents = new WeakSet();
    const attachedAppCommandWindows = new WeakSet();
    const lastSyncedSigByContents = new WeakMap();
    const appCommandDisposers = new Set();

    const usesDefaultTranslator = !options || !options.translator;
    let activeTranslator = translator;
    let activeConfig = loadConfig({ installRoot });
    let configCheckedAt = Date.now();

    let disposed = false;
    let uiRemovedPaused = false;
    let translating = false;
    let translateQueued = false;
    let syncing = false;
    let toastEnsureBackoffUntil = 0;
    let translateTimer = null;
    let syncTimer = null;
    let bridgeServer = null;

    const stats = {
        startedAt: new Date().toISOString(),
        lastTranslateAt: null,
        lastTranslatedBlocks: 0,
        lastTranslatedTitles: 0,
        lastTranslateError: '',
        lastSyncAt: null,
        bridgeListening: false,
        bridgeError: ''
    };

    function getCurrentConfig(forceReload = false) {
        const now = Date.now();
        if (forceReload || now - configCheckedAt > 1500) {
            activeConfig = loadConfig({ installRoot });
            configCheckedAt = now;
        }
        return activeConfig;
    }

    function safeAppVersion() {
        try {
            return typeof app?.getVersion === 'function' ? app.getVersion() : 'unknown';
        } catch {
            return 'unknown';
        }
    }

    function writeJsonSafe(filePath, data) {
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch {}
    }

    function recordUi(result) {
        writeJsonSafe(uiLogPath, {
            checkedAt: new Date().toISOString(),
            appVersion: safeAppVersion(),
            bridge: 'main-process',
            ...result
        });
    }

    function isHubContents(contents) {
        if (!contents || typeof contents.executeJavaScript !== 'function') return false;
        try {
            if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return false;
            if (typeof contents.getType === 'function' && contents.getType() === 'webview') return false;
            const rawUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';
            if (!rawUrl) return false;
            const url = new URL(rawUrl);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
            const host = url.hostname.toLowerCase();
            return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
        } catch {
            return false;
        }
    }

    function getHubWebContentsList() {
        try {
            const all = typeof webContents?.getAllWebContents === 'function' ? webContents.getAllWebContents() : [];
            return all.filter(isHubContents);
        } catch {
            return [];
        }
    }

    function containsContentsInViewTree(view, targetContents, depth = 0) {
        if (!view || depth > 8) return false;
        try {
            if (view.webContents === targetContents) return true;
            const children = view.children;
            if (Array.isArray(children)) {
                for (const child of children) {
                    if (containsContentsInViewTree(child, targetContents, depth + 1)) return true;
                }
            }
        } catch {}
        return false;
    }

    function resolveWindowForContents(contents) {
        if (!contents) return null;
        try {
            const direct = BrowserWindow?.fromWebContents?.(contents);
            if (direct && !direct.isDestroyed?.()) return direct;
        } catch {}
        try {
            if (contents.hostWebContents && contents.hostWebContents !== contents) {
                const fromHost = BrowserWindow?.fromWebContents?.(contents.hostWebContents);
                if (fromHost && !fromHost.isDestroyed?.()) return fromHost;
            }
        } catch {}
        try {
            const allWins = typeof BrowserWindow?.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : [];
            for (const win of allWins) {
                if (!win || win.isDestroyed?.()) continue;
                if (win.webContents === contents) return win;
                if (win.contentView && containsContentsInViewTree(win.contentView, contents, 0)) {
                    return win;
                }
            }
        } catch {}
        return null;
    }

    function isContentsFocused(contents) {
        try {
            const win = resolveWindowForContents(contents);
            if (win && typeof win.isFocused === 'function') {
                return Boolean(win.isFocused());
            }
        } catch {}
        return null;
    }

    function restoreContentsWindowWithoutFocus(contents) {
        try {
            const win = resolveWindowForContents(contents);
            if (win && !win.isDestroyed?.() && typeof win.isMinimized === 'function' && win.isMinimized()) {
                if (typeof win.restoreInactive === 'function') win.restoreInactive();
                else if (typeof win.restore === 'function') win.restore();
                else if (typeof win.showInactive === 'function') win.showInactive();
            }
        } catch {}
    }

    function focusContentsWindow(contents) {
        try {
            const win = resolveWindowForContents(contents);
            if (win && !win.isDestroyed?.()) {
                if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
                if (typeof win.show === 'function') win.show();
                if (typeof win.focus === 'function') win.focus();
            }
        } catch {}
        try {
            if (typeof app?.focus === 'function') app.focus({ steal: true });
        } catch {}
    }

    function selectHubContents(list, conversationId, preferFocused = false) {
        if (!list.length) return null;
        if (conversationId) {
            const exact = list.find(c => {
                try { return new URL(c.getURL()).pathname === `/c/${conversationId}`; } catch { return false; }
            });
            if (exact) return exact;
        }
        if (preferFocused) {
            const focused = list.find(c => isContentsFocused(c) === true);
            if (focused) return focused;
        }
        const hub = list.find(c => {
            try {
                const p = new URL(c.getURL()).pathname;
                return p === '/' || /^\/c\/[A-Za-z0-9._-]+$/.test(p);
            } catch {
                return false;
            }
        });
        return hub || list[0];
    }

    function attachWindowAppCommand(contents) {
        try {
            const win = resolveWindowForContents(contents);
            if (!win || typeof win.on !== 'function' || attachedAppCommandWindows.has(win)) return;
            attachedAppCommandWindows.add(win);
            const onAppCommand = (_event, cmd) => {
                if (disposed) return;
                if (getCurrentConfig(false).features.navigationGestures === false) return;
                if (cmd !== 'browser-backward' && cmd !== 'browser-forward') return;
                const direction = cmd === 'browser-backward' ? 'back' : 'forward';
                const target = getHubWebContentsList().find(c => {
                    try { return resolveWindowForContents(c) === win; } catch { return false; }
                }) || (isHubContents(contents) ? contents : null);
                if (!target) return;
                void target.executeJavaScript(
                    `window.__agyPlusNavUI?.navigate?.(${JSON.stringify(direction)}, 'app-command')`,
                    false
                ).catch(() => {});
            };
            let cleaned = false;
            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                appCommandDisposers.delete(cleanup);
                try {
                    if (!win.isDestroyed?.()) {
                        win.removeListener?.('app-command', onAppCommand);
                        win.off?.('app-command', onAppCommand);
                        win.removeListener?.('closed', cleanup);
                        win.off?.('closed', cleanup);
                    }
                } catch {}
            };
            win.on('app-command', onAppCommand);
            if (typeof win.once === 'function') win.once('closed', cleanup);
            else win.on('closed', cleanup);
            appCommandDisposers.add(cleanup);
        } catch {}
    }

    function attach(contents) {
        if (!contents || attachedContents.has(contents)) return;
        attachedContents.add(contents);
        attachWindowAppCommand(contents);
        let generation = 0;

        function applyToContents() {
            if (disposed) return;
            attachWindowAppCommand(contents);
            const current = ++generation;
            let attempts = 0;

            async function attempt() {
                if (disposed || current !== generation) return;
                if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return;
                if (!isHubContents(contents)) return;
                try {
                    const cfg = getCurrentConfig(false);
                    const result = await contents.executeJavaScript(buildExpression({ installRoot, config: cfg, titleCache }), false);
                    if (result?.ready) {
                        recordUi(result);
                        setTimeout(() => { void translateThoughts(); }, 250).unref?.();
                        return;
                    }
                    if (++attempts < 60 && !disposed) {
                        setTimeout(attempt, 1000).unref?.();
                    }
                } catch (error) {
                    recordUi({ installed: false, error: error && error.message ? error.message : String(error) });
                }
            }

            void attempt();
        }

        if (typeof contents.on === 'function') {
            contents.on('dom-ready', applyToContents);
        }
        try {
            if (typeof contents.isLoading !== 'function' || !contents.isLoading()) {
                applyToContents();
            }
        } catch {}
    }

    function reloadDefaultTranslatorIfApplicable() {
        if (!usesDefaultTranslator) return;
        try {
            const resolved = require.resolve('./translator.cjs');
            const prev = activeTranslator;
            delete require.cache[resolved];
            activeTranslator = require('./translator.cjs');
            if (prev && prev !== activeTranslator) prev.dispose?.();
        } catch {}
    }

    async function applyConfigUpdateAndBroadcast(patch) {
        const saved = updateConfig(patch, { installRoot });
        activeConfig = saved;
        configCheckedAt = Date.now();
        const runtimeMeta = buildRuntimeMeta(saved);
        const sig = JSON.stringify([saved, runtimeMeta]);
        const syncExpr = buildConfigSyncExpression(saved, runtimeMeta);

        for (const contents of getHubWebContentsList()) {
            try {
                await contents.executeJavaScript(syncExpr, false);
                lastSyncedSigByContents.set(contents, sig);
            } catch {}
        }

        if (saved.features.taskToast === false && typeof toastClient?.sendToastRequest === 'function') {
            try {
                await toastClient.sendToastRequest({ action: 'shutdown' }, { installRoot, ensureRunning: false });
            } catch {}
        } else if (saved.features.taskToast !== false) {
            void syncUiAndToast();
        }

        if (saved.features.thoughtTranslation !== false || saved.features.titleTranslation !== false) {
            void translateThoughts();
        }
        try { options?.onConfigUpdated?.(saved); } catch {}
        return { ok: true, config: saved, runtimeMeta };
    }

    async function drainFrontendConfigPatches(list) {
        for (const contents of list) {
            try {
                const patches = await contents.executeJavaScript('window.__agyPlusUI?.drainPendingConfigPatches?.() || []', false);
                if (Array.isArray(patches) && patches.length > 0) {
                    for (const patch of patches) {
                        await applyConfigUpdateAndBroadcast(patch);
                    }
                }
            } catch {}
        }
    }

    async function translateThoughts() {
        if (disposed) return { skipped: true };
        const list = getHubWebContentsList();
        await drainFrontendConfigPatches(list);

        const cfg = getCurrentConfig(false);
        const wantThoughts = cfg.features.thoughtTranslation !== false;
        const wantTitles = cfg.features.titleTranslation !== false;
        if (!wantThoughts && !wantTitles) {
            return { skipped: true, reason: 'translation_disabled' };
        }

        if (translating) {
            translateQueued = true;
            return { skipped: true, queued: true };
        }
        translating = true;
        translateQueued = false;
        let hasMore = false;
        let translatedBlocks = 0;
        let translatedTitles = 0;
        let titleCacheDirty = false;

        try {
            for (const contents of list) {
                const translateContentThoughts = async () => {
                    if (!wantThoughts) return;
                    let requests = [];
                    try {
                        requests = await contents.executeJavaScript('window.__agyPlusThoughtUI?.pending?.() || []', false);
                        if (!Array.isArray(requests) || !requests.length) return;
                        if (requests.length >= 8) hasMore = true;

                        const flatTexts = [];
                        for (const req of requests) flatTexts.push(...req.texts);
                        const flatTranslated = await activeTranslator.translate(flatTexts, { installRoot, config: cfg });

                        let cursor = 0;
                        const batchPayload = requests.map(req => {
                            const slice = flatTranslated.slice(cursor, cursor + req.texts.length);
                            cursor += req.texts.length;
                            return { source: req.source, originals: req.texts, translated: slice };
                        });
                        const accepted = await contents.executeJavaScript(
                            `window.__agyPlusThoughtUI?.acceptBatch?.(${JSON.stringify(batchPayload)})`,
                            false
                        );
                        translatedBlocks += Number(accepted) || 0;
                        stats.lastTranslateAt = new Date().toISOString();
                        stats.lastTranslatedBlocks = translatedBlocks;
                        stats.lastTranslateError = '';
                    } catch (err) {
                        stats.lastTranslateError = err && err.message ? err.message : String(err);
                        if (requests.length) {
                            try {
                                await contents.executeJavaScript(
                                    `(() => { for (const s of ${JSON.stringify(requests.map(r => r.source))}) window.__agyPlusThoughtUI?.failed?.(s); })()`,
                                    false
                                );
                            } catch {}
                        }
                    }
                };

                const translateContentTitles = async () => {
                    if (!wantTitles) return;
                    let titleRequests = [];
                    try {
                        titleRequests = await contents.executeJavaScript('window.__agyPlusThoughtUI?.pendingTitles?.() || []', false);
                        if (!Array.isArray(titleRequests) || !titleRequests.length) return;
                        if (titleRequests.length >= 24) hasMore = true;

                        const cachedItems = [];
                        const missItems = [];
                        for (const req of titleRequests) {
                            const hit = titleCache[req.original];
                            if (hit && typeof hit.translated === 'string' && hit.translated.trim()) {
                                cachedItems.push({ original: req.original, masked: req.masked, translated: hit.translated });
                            } else {
                                missItems.push(req);
                            }
                        }
                        if (missItems.length > 0) {
                            const translatedList = await activeTranslator.translate(
                                missItems.map(item => item.masked),
                                { installRoot, config: cfg }
                            );
                            for (let i = 0; i < missItems.length; i++) {
                                const req = missItems[i];
                                const target = String(translatedList[i] || '').trim();
                                if (target) {
                                    titleCache[req.original] = { masked: req.masked, translated: target };
                                    titleCacheDirty = true;
                                    cachedItems.push({ original: req.original, masked: req.masked, translated: target });
                                }
                            }
                        }
                        if (cachedItems.length > 0) {
                            const acceptedTitles = await contents.executeJavaScript(
                                `window.__agyPlusThoughtUI?.acceptTitles?.(${JSON.stringify(cachedItems)})`,
                                false
                            );
                            translatedTitles += Number(acceptedTitles) || 0;
                            stats.lastTranslateAt = new Date().toISOString();
                            stats.lastTranslatedTitles = translatedTitles;
                            stats.lastTranslateError = '';
                        }
                    } catch (err) {
                        stats.lastTranslateError = err && err.message ? err.message : String(err);
                        if (titleRequests.length) {
                            try {
                                await contents.executeJavaScript(
                                    `(() => { for (const t of ${JSON.stringify(titleRequests.map(r => r.original))}) window.__agyPlusThoughtUI?.failedTitle?.(t); })()`,
                                    false
                                );
                            } catch {}
                        }
                    }
                };

                await Promise.all([translateContentThoughts(), translateContentTitles()]);
            }
            if (titleCacheDirty) {
                saveTitleCache(titleCachePath, titleCache);
            }
            return { ok: true, translatedBlocks, translatedTitles, hasMore };
        } finally {
            translating = false;
            if ((hasMore || translateQueued) && !disposed) {
                translateQueued = false;
                setTimeout(() => { void translateThoughts(); }, 40).unref?.();
            }
        }
    }

    async function applyToAllWindows() {
        uiRemovedPaused = false;
        reloadDefaultTranslatorIfApplicable();
        const cfg = getCurrentConfig(true);
        const list = getHubWebContentsList();
        let primaryResult = null;
        const expression = buildExpression({ installRoot, config: cfg, titleCache });
        for (const contents of list) {
            try {
                if (!fs.existsSync(backupSettingsPath)) {
                    const previous = await contents.executeJavaScript(
                        '(async()=>{if(!window.nativeStorage)return null;const s=await window.nativeStorage.getItems();return {contextUsageIndicatorEnabled:s.contextUsageIndicatorEnabled??null};})()',
                        false
                    );
                    if (previous) {
                        try { fs.writeFileSync(backupSettingsPath, JSON.stringify(previous, null, 2), { flag: 'wx' }); } catch {}
                    }
                }
                const res = await contents.executeJavaScript(expression, false);
                if (!primaryResult && res) primaryResult = res;
                if (res?.installed) recordUi({ source: 'main-bridge-apply', ...res });
            } catch {}
        }
        void translateThoughts();
        return primaryResult || { installed: false, windowCount: list.length };
    }

    async function removeFromAllWindows() {
        uiRemovedPaused = true;
        const list = getHubWebContentsList();
        let previous = null;
        if (fs.existsSync(backupSettingsPath)) {
            try { previous = JSON.parse(fs.readFileSync(backupSettingsPath, 'utf8')); } catch {}
        }
        for (const contents of list) {
            try { await contents.executeJavaScript('window.__agyPlusDefaultModel?.dispose()', false); } catch {}
            try { await contents.executeJavaScript('window.__agyPlusNavUI?.dispose()', false); } catch {}
            try { await contents.executeJavaScript('window.__agyPlusThoughtUI?.dispose()', false); } catch {}
            try { await contents.executeJavaScript('window.__agyPlusUI?.dispose()', false); } catch {}
            if (previous) {
                try { await contents.executeJavaScript(`window.nativeStorage?.updateItems(${JSON.stringify(previous)})`, false); } catch {}
            }
        }
        return { removed: true, windowCount: list.length };
    }

    async function syncUiAndToast() {
        if (disposed || syncing || uiRemovedPaused) return;
        syncing = true;
        try {
            const list = getHubWebContentsList();
            await drainFrontendConfigPatches(list);
            const cfg = getCurrentConfig(false);
            const runtimeMeta = buildRuntimeMeta(cfg);
            const toastEnabled = cfg.features.taskToast !== false;

            if (toastEnabled) {
                const now = Date.now();
                if (now >= toastEnsureBackoffUntil && typeof toastClient?.ensureToastHostRunning === 'function') {
                    try {
                        await toastClient.ensureToastHostRunning({ installRoot });
                    } catch {
                        toastEnsureBackoffUntil = now + 30000;
                    }
                }
            }

            const multiWindow = list.length > 1;
            for (const contents of list) {
                try {
                    attachWindowAppCommand(contents);
                    const installed = await contents.executeJavaScript(
                        `Boolean(window.__agyPlusUI?.version >= ${UI_CORE_VERSION} && window.__agyPlusThoughtUI?.version >= ${THOUGHT_UI_VERSION} && window.__agyPlusDefaultModel?.version >= ${DEFAULT_MODEL_UI_VERSION} && window.__agyPlusNavUI?.version >= ${NAV_UI_VERSION})`,
                        false
                    );
                    const currentSig = JSON.stringify([cfg, runtimeMeta]);
                    if (!installed) {
                        const result = await contents.executeJavaScript(buildExpression({ installRoot, config: cfg, runtimeMeta, titleCache }), false);
                        if (result?.installed) {
                            lastSyncedSigByContents.set(contents, currentSig);
                            recordUi({ source: 'main-hook-watcher', ...result });
                        }
                    } else if (lastSyncedSigByContents.get(contents) !== currentSig) {
                        await contents.executeJavaScript(buildConfigSyncExpression(cfg, runtimeMeta), false);
                        lastSyncedSigByContents.set(contents, currentSig);
                    }

                    if (toastEnabled) {
                        const toastSync = await contents.executeJavaScript('window.__agyPlusUI?.syncToastState?.() || null', false);
                        if (toastSync && typeof toastClient?.sendToastRequest === 'function') {
                            const nativeFocused = isContentsFocused(contents);
                            const isFocusedWin = nativeFocused !== null
                                ? nativeFocused
                                : (multiWindow ? Boolean(toastSync.windowFocused) : (toastSync.windowFocused !== false));
                            const effectiveActiveId = isFocusedWin ? (toastSync.activeConversationId || '') : '';
                            try {
                                const syncPayload = {
                                    action: 'sync_active',
                                    titles: toastSync.titles || {},
                                    resolvedActionIds: toastSync.resolvedActionIds || []
                                };
                                if (isFocusedWin) {
                                    syncPayload.activeConversationId = effectiveActiveId;
                                }
                                await toastClient.sendToastRequest(syncPayload, { installRoot, ensureRunning: false });
                                for (const done of toastSync.completed || []) {
                                    const notifyPayload = {
                                        action: 'notify',
                                        kind: done.kind || 'completed',
                                        statusLabel: done.statusLabel || '',
                                        detail: done.detail || '',
                                        questions: done.questions || [],
                                        conversationId: done.conversationId,
                                        title: done.title,
                                        turnKey: done.turnKey || ''
                                    };
                                    if (isFocusedWin) {
                                        notifyPayload.activeConversationId = effectiveActiveId;
                                    }
                                    await toastClient.sendToastRequest(notifyPayload, { installRoot });
                                }
                            } catch {}
                        }
                    }
                } catch {}
            }
            stats.lastSyncAt = new Date().toISOString();
            void translateThoughts();
        } finally {
            syncing = false;
        }
    }

    async function handleBridgeAction(msg) {
        if (!msg || typeof msg !== 'object') {
            return { ok: false, error: 'invalid_request' };
        }
        const action = String(msg.action || '');
        const list = getHubWebContentsList();

        if (action === 'ping') {
            return {
                ok: true,
                pid: process.pid,
                appVersion: safeAppVersion(),
                bridge: 'main-process',
                windowCount: list.length
            };
        }

        if (action === 'get_config') {
            const cfg = getCurrentConfig(true);
            return { ok: true, config: cfg, runtimeMeta: buildRuntimeMeta(cfg) };
        }

        if (action === 'update_config') {
            return await applyConfigUpdateAndBroadcast(msg.patch || {});
        }

        if (action === 'status') {
            const cfg = getCurrentConfig(true);
            const windows = [];
            for (const contents of list) {
                let ui = { installed: false };
                let thought = { installed: false };
                let defaultModel = { installed: false };
                let navigation = { installed: false };
                try { ui = await contents.executeJavaScript('window.__agyPlusUI?.status() || {installed:false}', false); } catch {}
                try { thought = await contents.executeJavaScript('window.__agyPlusThoughtUI?.status() || {installed:false}', false); } catch {}
                try { defaultModel = await contents.executeJavaScript('window.__agyPlusDefaultModel?.status() || {installed:false}', false); } catch {}
                try { navigation = await contents.executeJavaScript('window.__agyPlusNavUI?.status() || {installed:false}', false); } catch {}
                windows.push({
                    url: contents.getURL(),
                    focused: isContentsFocused(contents),
                    ui,
                    thought,
                    defaultModel,
                    navigation
                });
            }
            const primary = windows[0]?.ui || { installed: false };
            return {
                ok: true,
                pid: process.pid,
                appVersion: safeAppVersion(),
                bridge: 'main-process',
                windowCount: list.length,
                config: cfg,
                runtimeMeta: buildRuntimeMeta(cfg),
                ...primary,
                thought: windows[0]?.thought || { installed: false },
                defaultModel: windows[0]?.defaultModel || { installed: false },
                navigation: windows[0]?.navigation || { installed: false },
                runtime: { ...stats },
                windows
            };
        }

        if (action === 'apply') {
            const res = await applyToAllWindows();
            return { ok: true, bridge: 'main-process', ...res };
        }

        if (action === 'remove') {
            const res = await removeFromAllWindows();
            return { ok: true, bridge: 'main-process', ...res };
        }

        if (action === 'translate_now') {
            const res = await translateThoughts();
            return { ok: true, bridge: 'main-process', ...res, runtime: { ...stats } };
        }

        if (action === 'sync_now') {
            await syncUiAndToast();
            return { ok: true, bridge: 'main-process', runtime: { ...stats } };
        }

        if (action === 'start_tour') {
            const target = selectHubContents(list, '', true);
            if (!target) {
                return { ok: false, error: 'no_hub_window' };
            }
            if (msg.bringToFront !== false) {
                focusContentsWindow(target);
            }
            const stepIndex = Number.isInteger(msg.stepIndex) ? msg.stepIndex : 0;
            const started = await target.executeJavaScript(
                `Boolean(window.__agyPlusUI?.startTour?.(${stepIndex}))`,
                false
            );
            return { ok: true, started: Boolean(started), bridge: 'main-process' };
        }

        if (action === 'open_conversation') {
            const conversationId = String(msg.conversationId || '');
            if (!toastClient.isValidConversationId(conversationId)) {
                return { ok: false, error: 'invalid_conversation_id' };
            }
            const target = selectHubContents(list, conversationId, false);
            if (!target) {
                return { ok: false, error: 'no_hub_window' };
            }
            if (msg.bringToFront !== false) {
                focusContentsWindow(target);
            } else if (msg.ensureRestored === true) {
                restoreContentsWindowWithoutFocus(target);
            }
            const nav = await target.executeJavaScript(
                buildNavigateExpression(conversationId, Boolean(msg.waitReady)),
                false
            );
            if (msg.waitReady) {
                for (let attempt = 0; attempt < 12 && !disposed; attempt++) {
                    try {
                        const cardReady = await target.executeJavaScript(
                            'Boolean(document.querySelector(\'[data-testid="interaction-takeover-card"]\'))',
                            false
                        );
                        if (cardReady) break;
                    } catch {}
                    await new Promise(r => setTimeout(r, 90));
                }
                await syncUiAndToast();
            }
            return {
                ok: true,
                navigated: Boolean(nav?.navigated),
                method: nav?.method || '',
                bridge: 'main-process'
            };
        }

        if (action === 'submit_question') {
            const conversationId = String(msg.conversationId || '');
            const selections = msg.selections;
            if (!toastClient.isValidConversationId(conversationId)) {
                return { ok: false, error: 'invalid_conversation_id' };
            }
            if (!Array.isArray(selections)) {
                return { ok: false, error: 'invalid_selections' };
            }
            const target = selectHubContents(list, conversationId, false);
            if (!target) {
                return { ok: false, error: 'no_hub_window' };
            }
            const expr = `(async () => {
                if (!window.__agyPlusUI || typeof window.__agyPlusUI.submitAskQuestion !== 'function') {
                    return { submitted: false, error: 'ui_bridge_unavailable' };
                }
                return await window.__agyPlusUI.submitAskQuestion(${JSON.stringify(conversationId)}, ${JSON.stringify(selections)});
            })()`;
            const res = await target.executeJavaScript(expr, false);
            return { ok: true, bridge: 'main-process', ...(res || { submitted: false }) };
        }

        if (action === 'renderer_snapshot') {
            const conversationId = String(msg.conversationId || '');
            if (conversationId && !toastClient.isValidConversationId(conversationId)) {
                return { ok: false, error: 'invalid_conversation_id' };
            }
            const target = selectHubContents(list, '', true);
            if (!target) {
                return { ok: false, error: 'no_hub_window' };
            }
            const safeId = JSON.stringify(conversationId);
            const snapshot = await target.executeJavaScript(`(() => {
                const id = ${safeId};
                const activeMatch = /^\\/c\\/([A-Za-z0-9._-]+)/.exec(location.pathname || '');
                const activeConversationId = activeMatch ? activeMatch[1] : '';
                let uiTitle = id ? (window.__agyPlusUI?.conversationTitle?.(id) || '') : '';
                if (!uiTitle && id) {
                    const link = Array.from(document.querySelectorAll('a[href]')).find(a => {
                        try { return new URL(a.href, location.origin).pathname === '/c/' + id; } catch { return false; }
                    });
                    const raw = (link?.textContent || '').trim() || (link?.parentElement?.textContent || '');
                    uiTitle = raw.replace(/\\s+/g, ' ').trim().replace(/\\s+\\d+(?:s|m|h|d|w|mo|y)$/i, '');
                }
                return { activeConversationId, uiTitle };
            })()`, false);
            return {
                ok: true,
                bridge: 'main-process',
                activeConversationId: snapshot?.activeConversationId || '',
                uiTitle: snapshot?.uiTitle || '',
                windowFocused: isContentsFocused(target)
            };
        }

        return { ok: false, error: 'unknown_action' };
    }

    function startBridgeServer() {
        const MAX_PIPE_BYTES = 2 * 1024 * 1024;
        const pipePath = bridgePipePath(bridgePipeName);
        const server = net.createServer(socket => {
            let buffer = '';
            let handled = false;
            socket.setEncoding('utf8');
            socket.setTimeout(10000, () => {
                if (handled) return;
                handled = true;
                try { socket.end(JSON.stringify({ ok: false, error: 'request_timeout' }) + '\n', 'utf8'); } catch {}
                try { socket.destroy(); } catch {}
            });
            socket.on('data', chunk => {
                if (handled) return;
                buffer += chunk;
                const nl = buffer.indexOf('\n');
                const frameLen = nl === -1
                    ? Buffer.byteLength(buffer, 'utf8')
                    : Buffer.byteLength(buffer.slice(0, nl), 'utf8');
                if (frameLen > MAX_PIPE_BYTES) {
                    handled = true;
                    try { socket.end(JSON.stringify({ ok: false, error: 'payload_too_large' }) + '\n', 'utf8'); } catch {}
                    try { socket.destroy(); } catch {}
                    return;
                }
                if (nl === -1) return;
                handled = true;
                socket.setTimeout(0);
                const rawLine = buffer.slice(0, nl).trim();
                Promise.resolve()
                    .then(() => JSON.parse(rawLine))
                    .then(msg => handleBridgeAction(msg))
                    .catch(err => ({ ok: false, error: err && err.message ? err.message : String(err) }))
                    .then(reply => {
                        try { socket.end(JSON.stringify(reply) + '\n', 'utf8'); } catch {}
                    });
            });
            socket.on('error', () => {});
        });
        server.on('error', err => {
            stats.bridgeListening = false;
            stats.bridgeError = err && err.code ? `${err.code}: ${err.message}` : String(err);
        });
        try {
            server.listen(pipePath, () => {
                stats.bridgeListening = true;
                stats.bridgeError = '';
            });
            server.unref?.();
        } catch (err) {
            stats.bridgeListening = false;
            stats.bridgeError = err && err.message ? err.message : String(err);
        }
        bridgeServer = server;
    }

    async function disposeRuntime({ removeUi = false, shutdownToast = false } = {}) {
        if (disposed) return;
        disposed = true;
        if (translateTimer) { clearInterval(translateTimer); translateTimer = null; }
        if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
        try {
            if (onWebContentsCreated) {
                app?.removeListener?.('web-contents-created', onWebContentsCreated);
                app?.off?.('web-contents-created', onWebContentsCreated);
            }
            if (onQuit) {
                app?.removeListener?.('will-quit', onQuit);
                app?.off?.('will-quit', onQuit);
            }
        } catch {}
        for (const fn of Array.from(appCommandDisposers)) {
            try { fn(); } catch {}
        }
        appCommandDisposers.clear();
        if (removeUi) {
            try { await removeFromAllWindows(); } catch {}
        }
        if (shutdownToast && typeof toastClient?.sendToastRequest === 'function') {
            try { await toastClient.sendToastRequest({ action: 'shutdown' }, { installRoot, ensureRunning: false }); } catch {}
        }
        try { activeTranslator?.dispose?.(); } catch {}
        if (bridgeServer) {
            try { bridgeServer.close(); } catch {}
            bridgeServer = null;
            stats.bridgeListening = false;
        }
        if (globalThis.__agyPlusMainHookRuntime === runtime) {
            delete globalThis.__agyPlusMainHookRuntime;
        }
    }

    const runtime = {
        get disposed() { return disposed; },
        bridgePipeName,
        translateThoughts,
        syncUiAndToast,
        handleBridgeAction,
        dispose: disposeRuntime
    };

    if (!forceNewInstance) {
        globalThis.__agyPlusMainHookRuntime = runtime;
    }

    let servicesStarted = false;
    function startActiveServices() {
        if (disposed || servicesStarted) return;
        servicesStarted = true;
        startBridgeServer();
        try {
            const existing = typeof webContents?.getAllWebContents === 'function' ? webContents.getAllWebContents() : [];
            existing.forEach(attach);
        } catch {}
        if (!disableTimers) {
            syncTimer = setInterval(() => { void syncUiAndToast(); }, syncIntervalMs);
            syncTimer.unref?.();
            translateTimer = setInterval(() => { void translateThoughts(); }, translateIntervalMs);
            translateTimer.unref?.();
            setTimeout(() => { void syncUiAndToast(); }, 1000).unref?.();
        }
    }

    const onWebContentsCreated = (_event, contents) => attach(contents);
    if (typeof app?.on === 'function') {
        app.on('web-contents-created', onWebContentsCreated);
    }

    const deferUntilReady = typeof app?.isReady === 'function' && !app.isReady() && typeof app?.whenReady === 'function';
    if (deferUntilReady) {
        Promise.resolve(app.whenReady()).then(startActiveServices).catch(() => {});
    } else {
        startActiveServices();
    }

    const onQuit = () => {
        void disposeRuntime({ removeUi: false, shutdownToast: false });
    };
    if (typeof app?.once === 'function') app.once('will-quit', onQuit);
    else if (typeof app?.on === 'function') app.on('will-quit', onQuit);

    return {
        installed: true,
        bridgePipeName,
        dispose: disposeRuntime,
        runtime
    };
}

module.exports = {
    install,
    buildExpression,
    buildConfigSyncExpression,
    buildNavigateExpression
};
