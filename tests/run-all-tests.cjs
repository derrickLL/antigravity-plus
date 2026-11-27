'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const repoRoot = path.resolve(__dirname, '..');
const tmpBase = path.join(repoRoot, '.tmp', `test-run-${process.pid}-${Date.now()}`);
process.env.AGY_PLUS_RULES_DIR = path.join(tmpBase, 'isolated-global-rules');

const configManager = require('../src/core/config-manager.cjs');
const patchManager = require('../src/core/patch-antigravity.cjs');
const runtime = require('../src/core/runtime.cjs');
const externalBrowser = require('../src/core/external-browser.cjs');
const translator = require('../src/main/translator.cjs');
const mainHook = require('../src/main/main-hook.cjs');
const bridgeClient = require('../src/main/bridge-client.cjs');
const toastClient = require('../src/toast/toast-client.cjs');
const menuPreload = require('../src/preload/window-menu-preload.cjs');
const { formatAgyPlusDuration, readAgyPlusPerformance } = require('../src/renderer/performance.js');
const { installAgyPlusDefaultModel } = require('../src/renderer/default-model.js');
const { installAgyPlusNavigationGestures } = require('../src/renderer/navigation-gestures.js');
const { installAgyPlusThoughtTranslations } = require('../src/renderer/thought-localization.js');
const { installAgyPlusUI } = require('../src/renderer/ui-core.js');

function buildMockAsarBuffer(filesMap) {
    const entries = {};
    const chunks = [];
    let offset = 0;
    for (const [name, content] of Object.entries(filesMap)) {
        const buf = Buffer.from(content, 'utf8');
        entries[name] = { size: buf.length, offset: String(offset) };
        chunks.push(buf);
        offset += buf.length;
    }
    const headerJson = Buffer.from(JSON.stringify({ files: entries }), 'utf8');
    const jsonLen = headerJson.length;
    const alignedJsonLen = Math.ceil(jsonLen / 4) * 4;
    const headerSize = 8 + alignedJsonLen;
    const picklePayloadSize = headerSize - 4;

    const prefix = Buffer.alloc(16 + alignedJsonLen);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(headerSize, 4);
    prefix.writeUInt32LE(picklePayloadSize, 8);
    prefix.writeUInt32LE(jsonLen, 12);
    headerJson.copy(prefix, 16);

    return Buffer.concat([prefix, ...chunks]);
}

async function runTests() {
    const results = [];
    async function step(name, fn) {
        await fn();
        results.push(name);
        console.log(`  [PASS] ${name}`);
    }

    fs.mkdirSync(tmpBase, { recursive: true });
    try {
        await step('1. config-manager: BOM parsing, patch merge, and live global rules toggle', async () => {
            const mockRoot = path.join(tmpBase, 'cfg-root');
            const mockRulesDir = path.join(tmpBase, 'gemini-rules');
            fs.cpSync(path.join(repoRoot, 'config'), path.join(mockRoot, 'config'), { recursive: true });
            fs.cpSync(path.join(repoRoot, 'integrations'), path.join(mockRoot, 'integrations'), { recursive: true });

            const cfgPath = configManager.defaultConfigPath(mockRoot);
            fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
            fs.writeFileSync(cfgPath, '\uFEFF' + JSON.stringify({ features: { codexTheme: false } }), 'utf8');

            const loaded = configManager.loadConfig({ installRoot: mockRoot });
            assert.equal(loaded.features.codexTheme, false);
            assert.equal(loaded.features.contextRing, true);

            configManager.saveConfig(loaded, { installRoot: mockRoot, rulesDir: mockRulesDir });
            assert.equal(fs.existsSync(path.join(mockRulesDir, 'agy-plus-chinese-execution.md')), true);
            assert.equal(fs.existsSync(path.join(mockRulesDir, 'agy-plus-workspace-local-scripts.md')), true);

            const updated = configManager.updateConfig(
                { features: { chineseExecutionRule: false }, translation: { mode: 'online' } },
                { installRoot: mockRoot, rulesDir: mockRulesDir }
            );
            assert.equal(updated.features.chineseExecutionRule, false);
            assert.equal(updated.translation.mode, 'online');
            assert.equal(fs.existsSync(path.join(mockRulesDir, 'agy-plus-chinese-execution.md')), false);
            assert.equal(fs.existsSync(path.join(mockRulesDir, 'agy-plus-workspace-local-scripts.md')), true);
        });

        await step('2. patch-antigravity: lossless Shim V3 apply, verify, and restore round-trip', async () => {
            const mockInstall = path.join(tmpBase, 'shim-install');
            const mockResources = path.join(tmpBase, 'shim-resources');
            fs.mkdirSync(path.join(mockInstall, 'src', 'core'), { recursive: true });
            fs.copyFileSync(path.join(repoRoot, 'src', 'core', 'runtime.cjs'), path.join(mockInstall, 'src', 'core', 'runtime.cjs'));
            fs.mkdirSync(mockResources, { recursive: true });

            const asarBuf = buildMockAsarBuffer({
                'package.json': JSON.stringify({ name: 'antigravity', version: '2.99.0', main: 'dist/main.js' })
            });
            const origAsar = path.join(mockResources, 'app.asar');
            fs.writeFileSync(origAsar, asarBuf);

            const res = patchManager.applyShim(mockResources, { installRoot: mockInstall });
            assert.equal(res.activated, true);
            assert.equal(res.appVersion, '2.99.0');
            assert.equal(fs.existsSync(origAsar), false);
            assert.equal(fs.existsSync(path.join(mockResources, 'app.real.asar')), true);
            assert.deepEqual(fs.readFileSync(path.join(mockResources, 'app.real.asar')), asarBuf);

            const status = patchManager.inspectStatus(mockResources, mockInstall);
            assert.equal(status.patched, true);
            assert.equal(status.versionSynced, true);

            const restoreCode = patchManager.removeShim(mockResources, mockInstall);
            assert.equal(restoreCode, 0);
            assert.equal(fs.existsSync(origAsar), true);
            assert.equal(fs.existsSync(path.join(mockResources, 'app')), false);
            assert.deepEqual(fs.readFileSync(origAsar), asarBuf);
        });

        await step('3. runtime: loopback proxy validation, WinINET parser, Fastpush toggle & updater rewrite', async () => {
            assert.equal(runtime.validateLoopbackHttpProxy('127.0.0.1:7897'), 'http://127.0.0.1:7897');
            assert.equal(runtime.validateLoopbackHttpProxy('http://localhost:10809'), 'http://localhost:10809');
            assert.equal(runtime.validateLoopbackHttpProxy('http://192.168.1.5:7890'), null);

            const winInetOut = [
                'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
                '    ProxyEnable    REG_DWORD    0x1',
                '    ProxyServer    REG_SZ    http=127.0.0.1:7897;https=127.0.0.1:7897'
            ].join('\r\n');
            assert.equal(runtime.parseWinInetProxyOutput(winInetOut), 'http://127.0.0.1:7897');

            const disabledProxy = runtime.resolveProxyUrl({ features: { localProxy: false }, network: { proxyUrl: 'http://127.0.0.1:7897' } });
            assert.equal(disabledProxy.url, null);
            assert.equal(disabledProxy.source, 'disabled_by_config');

            assert.equal(runtime.isLanguageServerStandalone('C:\\app\\language_server.exe', ['--standalone', '--csrf_token', 'abc']), true);

            const det = runtime.detectUpdaterSpawn('C:\\Temp\\elevate.exe', ['C:\\Updater\\antigravity-updater.exe', '--updated', '--force-run']);
            assert.equal(det.elevated, true);
            const rewritten = runtime.rewriteUpdaterArgs(['C:\\Updater\\antigravity-updater.exe', '--updated', '--force-run'], det.installerArgsOffset);
            assert.equal(rewritten.hadForceRun, true);
            assert.deepEqual(rewritten.nextArgs, ['C:\\Updater\\antigravity-updater.exe', '--updated', '/S']);
        });

        await step('4. external-browser: live routing, per-browser args, .exe guard & instant fallback', async () => {
            const fakeChrome = path.join(tmpBase, 'chrome.exe');
            const fakeFirefox = path.join(tmpBase, 'firefox.exe');
            const fakeCustom = path.join(tmpBase, 'custom-browser.exe');
            const fakeBatch = path.join(tmpBase, 'evil-browser.cmd');
            fs.writeFileSync(fakeChrome, 'stub');
            fs.writeFileSync(fakeFirefox, 'stub');
            fs.writeFileSync(fakeCustom, 'stub');
            fs.writeFileSync(fakeBatch, '@echo off\r\n');

            let externalEnabled = true;
            let activeBrowserPath = fakeChrome;
            let fallbackCount = 0;
            let spawnedArgs = null;

            const mockShell = {
                openExternal: async () => { fallbackCount++; }
            };
            const mockSpawn = (cmd, args) => {
                spawnedArgs = [cmd, args];
                const emitter = new EventEmitter();
                emitter.pid = 4242;
                emitter.unref = () => {};
                process.nextTick(() => emitter.emit('spawn'));
                return emitter;
            };

            externalBrowser.install({
                shell: mockShell,
                spawn: mockSpawn,
                getConfig: () => ({
                    features: { externalBrowser: externalEnabled },
                    network: { externalBrowserPath: activeBrowserPath }
                })
            });

            await mockShell.openExternal('https://github.com/example');
            assert.equal(spawnedArgs[0], fakeChrome);
            assert.deepEqual(spawnedArgs[1], ['--new-tab', 'https://github.com/example']);
            assert.equal(fallbackCount, 0);

            activeBrowserPath = fakeFirefox;
            await mockShell.openExternal('https://github.com/example');
            assert.equal(spawnedArgs[0], fakeFirefox);
            assert.deepEqual(spawnedArgs[1], ['-new-tab', 'https://github.com/example']);

            activeBrowserPath = fakeCustom;
            await mockShell.openExternal('https://github.com/example');
            assert.equal(spawnedArgs[0], fakeCustom);
            assert.deepEqual(spawnedArgs[1], ['https://github.com/example']);

            // Non-.exe path must be rejected and fall back safely to OS default
            activeBrowserPath = fakeBatch;
            await mockShell.openExternal('https://github.com/example');
            assert.equal(fallbackCount, 1);

            activeBrowserPath = fakeChrome;
            externalEnabled = false;
            await mockShell.openExternal('https://github.com/example');
            assert.equal(fallbackCount, 2);
        });

        await step('5. translator: 4-tier failover, AI term polish, and missing-offline safety', async () => {
            translator.resetCooldowns();
            const mockRoot = path.join(tmpBase, 'trans-root');
            fs.mkdirSync(mockRoot, { recursive: true });

            // Tier 1 fail -> Tier 2 (Alibaba) succeed + AI term polish ("培训" -> "训练", "[P0]" -> "PyTorch")
            const calls = [];
            const mockRequestTier2 = async url => {
                calls.push(url);
                if (url.includes('clients5.google.com')) {
                    throw new Error('Connect timeout');
                }
                if (url.includes('csrftoken')) {
                    return { status: 200, headers: { 'set-cookie': ['XSRF=1; Path=/'] }, body: JSON.stringify({ token: 'tok1', headerName: 'X-CSRF-TOKEN' }) };
                }
                if (url.includes('translate.alibaba.com/api/translate/text')) {
                    return { status: 200, headers: {}, body: JSON.stringify({ success: true, data: { translateText: '正在检查 [P0] DDP 培训配置' } }) };
                }
                throw new Error('Unexpected URL');
            };

            const out1 = await translator.translate(
                ['Checking PyTorch DDP training setup'],
                { installRoot: mockRoot, mode: 'online', bypassCache: true, requestFn: mockRequestTier2 }
            );
            assert.equal(out1[0], '正在检查 PyTorch DDP 训练配置');
            assert.ok(calls.some(u => u.includes('clients5.google.com')));
            assert.ok(calls.some(u => u.includes('translate.alibaba.com')));

            // Offline mode when offline package is absent should reject cleanly without ENOENT crash
            await assert.rejects(
                () => translator.translate(['Inspecting build configuration'], {
                    installRoot: mockRoot,
                    mode: 'offline',
                    offlineRoot: path.join(tmpBase, 'non-existent-offline-dir'),
                    allowAutoDetect: false,
                    bypassCache: true
                }),
                /not installed|unavailable/i
            );
            translator.dispose();
        });

        await step('6. performance: task duration formatting and Avg tok/s calculation', async () => {
            assert.equal(formatAgyPlusDuration(8.34, false), '8.3s');
            assert.equal(formatAgyPlusDuration(125, true), '2m 05s');

            const state = {
                fullyIdle: true,
                trajectorySlice: {
                    stepsInSlice: [
                        { step: { case: 'userInput' }, metadata: { source: 1, createdAt: { seconds: 100, nanos: 0 } } },
                        {
                            step: { case: 'plannerResponse' },
                            metadata: {
                                createdAt: { seconds: 101, nanos: 0 },
                                finishedGeneratingAt: { seconds: 105, nanos: 0 },
                                completedAt: { seconds: 105, nanos: 0 },
                                modelUsage: { outputTokens: 200, responseOutputTokens: 150, thinkingOutputTokens: 50, inputTokens: 1000 }
                            }
                        }
                    ]
                }
            };
            const perf = readAgyPlusPerformance(state, 110000);
            assert.equal(perf.phase, 'Completed');
            assert.equal(perf.elapsedSeconds, 5);
            assert.equal(perf.averageTokensPerSecond, 50);
        });

        await step('7. default-model: flagship ranking, loose effort hint & live enable/disable toggle', async () => {
            const origWin = global.window;
            const origDoc = global.document;
            try {
                let selected = { value: '1', modelId: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' };
                const ctx = {
                    selectedModel: selected,
                    isModelListLoading: false,
                    open: false,
                    modelOptions: [
                        { value: 'auto', modelId: 'auto', label: 'Auto' },
                        { value: '1', modelId: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
                        { value: '2', modelId: 'gemini-3.1-pro-medium', label: 'Gemini 3.1 Pro (Medium)' },
                        { value: '3', modelId: 'gemini-3.1-pro-max', label: 'Gemini 3.1 Pro (Max)' },
                        { value: '4', modelId: 'deep-research', label: 'Deep Research' }
                    ],
                    setSelectedModel(next) {
                        selected = next;
                        ctx.selectedModel = next;
                    }
                };
                const fakeTrigger = {
                    hidden: false,
                    getAttribute: () => null,
                    getBoundingClientRect: () => ({ width: 100, height: 28 }),
                    __reactFiber$test: { memoizedProps: { value: ctx }, return: null }
                };
                global.window = {
                    location: { pathname: '/' },
                    getComputedStyle: () => ({ display: 'inline-flex', visibility: 'visible' }),
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    setInterval,
                    clearInterval
                };
                global.document = {
                    body: null,
                    querySelector: sel => (sel === '[data-testid="model-selector-trigger"]' ? fakeTrigger : null),
                    querySelectorAll: () => [],
                    addEventListener: () => {},
                    removeEventListener: () => {}
                };

                const stDisabled = installAgyPlusDefaultModel({ enabled: false });
                assert.equal(stDisabled.state, 'disabled');
                assert.equal(selected.modelId, 'gemini-2.5-flash');

                const stEnabled = global.window.__agyPlusDefaultModel.setConfig({ enabled: true });
                assert.equal(stEnabled.state, 'applied');
                assert.equal(selected.modelId, 'gemini-3.1-pro-max');

                // Strict weak ordering check across all 6 permutations (no cyclic comparator)
                const trio = [
                    { value: 'p', modelId: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', recommended: true, recommendationOrder: 0 },
                    { value: 'u', modelId: 'gemini-3.1-ultra', label: 'Gemini 3.1 Ultra', recommended: true, recommendationOrder: 2 },
                    { value: 'x', modelId: 'codename-alpha', label: 'Codename Alpha', recommended: true, recommendationOrder: 1 }
                ];
                const perms = [
                    [0, 1, 2], [0, 2, 1], [1, 0, 2],
                    [1, 2, 0], [2, 0, 1], [2, 1, 0]
                ];
                for (const perm of perms) {
                    global.window.__agyPlusDefaultModel.dispose();
                    selected = { value: '1', modelId: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' };
                    ctx.selectedModel = selected;
                    ctx.modelOptions = perm.map(i => trio[i]);
                    const stPerm = installAgyPlusDefaultModel({ enabled: true });
                    assert.equal(stPerm.state, 'applied');
                    assert.equal(selected.modelId, 'gemini-3.1-ultra', `Comparator must be permutation-invariant for order ${perm.join(',')}`);
                }

                global.window.__agyPlusDefaultModel.dispose();
            } finally {
                global.window = origWin;
                global.document = origDoc;
            }
        });

        await step('8. window-menu-preload: cross-world attrObserver live toggle & idempotent mode sync', async () => {
            const attrObservers = [];
            class MockMutationObserver {
                constructor(cb) { this.cb = cb; this.target = null; this.opts = null; }
                observe(target, opts) {
                    this.target = target;
                    this.opts = opts;
                    if (opts && opts.attributes) attrObservers.push(this);
                }
                disconnect() { this.target = null; }
            }

            function makeFakeDom(newWinAttr) {
                const makeEl = tag => {
                    const attrs = {};
                    const children = [];
                    const listeners = {};
                    const el = {
                        tagName: tag.toUpperCase(),
                        className: '',
                        textContent: '',
                        style: {},
                        children,
                        parentElement: null,
                        isConnected: true,
                        get firstElementChild() { return children[0] || null; },
                        setAttribute(k, v) {
                            attrs[k] = String(v);
                            for (const obs of attrObservers) {
                                if (obs.target === el && (!obs.opts.attributeFilter || obs.opts.attributeFilter.includes(k))) {
                                    obs.cb([{ type: 'attributes', attributeName: k }]);
                                }
                            }
                        },
                        getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
                        appendChild(c) { c.parentElement = el; children.push(c); return c; },
                        prepend(c) { c.parentElement = el; children.unshift(c); },
                        remove() {
                            if (el.parentElement) {
                                const idx = el.parentElement.children.indexOf(el);
                                if (idx >= 0) el.parentElement.children.splice(idx, 1);
                            }
                        },
                        addEventListener(ev, fn) { listeners[ev] = fn; },
                        removeEventListener() {},
                        querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
                        querySelectorAll(sel) {
                            const out = [];
                            const visit = node => {
                                for (const ch of node.children) {
                                    if (sel === '[data-testid="title-menu-bar"]' && ch.getAttribute('data-testid') === 'title-menu-bar') out.push(ch);
                                    if (sel === '[data-testid="title-menu-bar-item"]' && ch.getAttribute('data-testid') === 'title-menu-bar-item') out.push(ch);
                                    if (sel === '[data-testid="title-menu-bar-option"]' && ch.getAttribute('data-testid') === 'title-menu-bar-option') out.push(ch);
                                    if (sel === `[${menuPreload.WRAPPER_ATTR}="true"]` && ch.getAttribute(menuPreload.WRAPPER_ATTR) === 'true') out.push(ch);
                                    if (sel === 'span' && ch.tagName === 'SPAN') out.push(ch);
                                    visit(ch);
                                }
                            };
                            visit(el);
                            return out;
                        }
                    };
                    return el;
                };

                const docEl = makeEl('html');
                docEl.setAttribute('data-agy-plus-new-window-menu', newWinAttr);
                const body = makeEl('body');
                const menuBar = makeEl('div');
                menuBar.setAttribute('data-testid', 'title-menu-bar');
                const windowRoot = makeEl('div');
                const trigger = makeEl('button');
                trigger.setAttribute('data-testid', 'title-menu-bar-item');
                trigger.textContent = 'Window';
                const dropdown = makeEl('div');
                dropdown.setAttribute('data-browser-occluder', 'true');
                const minimizeOpt = makeEl('button');
                minimizeOpt.setAttribute('data-testid', 'title-menu-bar-option');
                minimizeOpt.className = 'menu-opt-cls';
                minimizeOpt.textContent = 'Minimize';
                dropdown.appendChild(minimizeOpt);
                windowRoot.appendChild(trigger);
                windowRoot.appendChild(dropdown);
                menuBar.appendChild(windowRoot);
                body.appendChild(menuBar);

                const doc = {
                    documentElement: docEl,
                    body,
                    createElement: makeEl,
                    querySelector: sel => body.querySelector(sel),
                    querySelectorAll: sel => body.querySelectorAll(sel),
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    dispatchEvent: () => {}
                };
                return { doc, docEl, dropdown };
            }

            const dom = makeFakeDom('true');
            const controller = menuPreload.installWindowMenuNewWindow(dom.doc, { MutationObserver: MockMutationObserver });

            let opts = dom.dropdown.querySelectorAll('[data-testid="title-menu-bar-option"]');
            assert.equal(opts.some(b => b.getAttribute(menuPreload.NEW_WIN_BTN_ATTR) === 'true'), true);
            assert.equal(opts.some(b => b.getAttribute(menuPreload.SETTINGS_BTN_ATTR) === 'true'), true);

            // Live cross-world flip via html[data-agy-plus-new-window-menu="false"]
            dom.docEl.setAttribute('data-agy-plus-new-window-menu', 'false');
            opts = dom.dropdown.querySelectorAll('[data-testid="title-menu-bar-option"]');
            assert.equal(opts.some(b => b.getAttribute(menuPreload.NEW_WIN_BTN_ATTR) === 'true'), false);
            assert.equal(opts.some(b => b.getAttribute(menuPreload.SETTINGS_BTN_ATTR) === 'true'), true);

            // Flip back to true
            dom.docEl.setAttribute('data-agy-plus-new-window-menu', 'true');
            opts = dom.dropdown.querySelectorAll('[data-testid="title-menu-bar-option"]');
            assert.equal(opts.some(b => b.getAttribute(menuPreload.NEW_WIN_BTN_ATTR) === 'true'), true);

            controller.dispose();
        });

        await step('9. main-hook & bridge-client: loopback hostnames, named-pipe update & multi-window broadcast', async () => {
            const mockRoot = path.join(tmpBase, 'bridge-root');
            fs.cpSync(path.join(repoRoot, 'config'), path.join(mockRoot, 'config'), { recursive: true });
            fs.cpSync(path.join(repoRoot, 'integrations'), path.join(mockRoot, 'integrations'), { recursive: true });

            const testPipe = `AgyPlus-MainBridge-Test-${process.pid}-${Date.now()}`;
            const scriptsWin1 = [];
            const scriptsWin2 = [];
            const makeWin = (url, sink) => ({
                isDestroyed: () => false,
                getType: () => 'window',
                getURL: () => url,
                on: () => {},
                isLoading: () => true,
                executeJavaScript: async code => {
                    sink.push(code);
                    return true;
                }
            });
            const fakeWinIp = makeWin('https://127.0.0.1:51234/', scriptsWin1);
            const fakeWinLocalhost = makeWin('http://localhost:51234/', scriptsWin2);

            const hookRes = mainHook.install({
                installRoot: mockRoot,
                app: { getVersion: () => '2.35.1', on: () => {} },
                webContents: { getAllWebContents: () => [fakeWinIp, fakeWinLocalhost] },
                bridgePipeName: testPipe,
                disableTimers: true,
                forceNewInstance: true,
                toastClient: { sendToastRequest: async () => ({ ok: true }) }
            });
            assert.equal(hookRes.installed, true);

            await new Promise(r => setTimeout(r, 120));

            const ping = await bridgeClient.sendBridgeRequest({ action: 'ping' }, { pipeName: testPipe });
            assert.equal(ping.ok, true);

            const updateReply = await bridgeClient.sendBridgeRequest(
                { action: 'update_config', patch: { features: { codexTheme: false, workspaceScriptsRule: false } } },
                { pipeName: testPipe }
            );
            assert.equal(updateReply.ok, true);
            assert.equal(updateReply.config.features.codexTheme, false);
            assert.ok(scriptsWin1.some(s => s.includes('window.__agyPlusUI?.applyConfig')));
            assert.ok(scriptsWin2.some(s => s.includes('window.__agyPlusUI?.applyConfig')));

            // Oversized (>2 MiB) named-pipe payload must be rejected cleanly without breaking subsequent requests
            const oversizedReply = await new Promise((resolve, reject) => {
                const net = require('node:net');
                const sock = net.createConnection(`\\\\.\\pipe\\${testPipe}`);
                let data = '';
                sock.setEncoding('utf8');
                sock.on('data', chunk => { data += chunk; });
                sock.on('end', () => resolve(data.trim()));
                sock.on('error', () => resolve(data.trim()));
                sock.on('connect', () => {
                    const bigChunk = 'x'.repeat(256 * 1024);
                    for (let i = 0; i < 10; i++) {
                        if (!sock.destroyed) sock.write(bigChunk);
                    }
                    if (!sock.destroyed) sock.write('\n');
                });
                setTimeout(() => { try { sock.destroy(); } catch {} reject(new Error('oversized pipe test timeout')); }, 5000);
            });
            assert.ok(oversizedReply.includes('payload_too_large'), `Expected payload_too_large from MainBridge, got: ${oversizedReply}`);
            const pingAfterBig = await bridgeClient.sendBridgeRequest({ action: 'ping' }, { pipeName: testPipe });
            assert.equal(pingAfterBig.ok, true);

            // Verify sidebarWidth is only initialized once so user-dragged widths are never overwritten on restart
            const mainHookSrc = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'main-hook.cjs'), 'utf8');
            assert.ok(mainHookSrc.includes("agy_plus_sidebar_init_v1"), 'main-hook.cjs must guard one-time sidebarWidth initialization');

            // Verify `remove` pauses automatic syncUiAndToast re-injection until `apply` is called again
            const removeReply = await bridgeClient.sendBridgeRequest({ action: 'remove' }, { pipeName: testPipe });
            assert.equal(removeReply.ok, true);
            const scriptsBeforeSync = scriptsWin1.length;
            await hookRes.runtime.syncUiAndToast();
            assert.equal(scriptsWin1.length, scriptsBeforeSync, 'syncUiAndToast must NOT re-inject UI right after remove');

            hookRes.runtime.dispose();
        });

        await step('10. TaskToastHost.exe: native pipe protocol (status, notify, select, scroll, dismiss, shutdown)', async () => {
            const exePath = path.join(repoRoot, 'bin', 'TaskToastHost.exe');
            assert.equal(fs.existsSync(exePath), true, 'TaskToastHost.exe must be compiled before running tests');

            const toastInstallRoot = path.join(tmpBase, 'toast-root');
            fs.mkdirSync(toastInstallRoot, { recursive: true });
            const testPipe = `AgyPlus-TaskToast-Test-${process.pid}-${Date.now()}`;
            const openLog = path.join(tmpBase, 'toast-open.log');
            const submitLog = path.join(tmpBase, 'toast-submit.jsonl');

            const status = await toastClient.ensureToastHostRunning({
                installRoot: toastInstallRoot,
                exePath,
                pipeName: testPipe,
                testForegroundAg: 'false',
                openLogPath: openLog,
                submitLogPath: submitLog,
                allowCurrentDesktop: true
            });
            assert.equal(status.running, true);
            assert.equal(status.protocolVersion, 2);

            // Reject invalid conversationId with path traversal / protocol characters
            const invalidIdRes = await toastClient.sendToastRequest({
                action: 'notify',
                kind: 'completed',
                conversationId: '../evil?cmd=1',
                title: 'Invalid'
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(invalidIdRes.ok, false);

            // Hold a slow client open without sending newline; concurrent status request must still succeed immediately
            const slowSock = require('node:net').createConnection(`\\\\.\\pipe\\${testPipe}`);
            slowSock.on('error', () => {});
            await new Promise(r => {
                const t = setTimeout(r, 400);
                slowSock.once('connect', () => { clearTimeout(t); r(); });
            });
            const statusWhileSlow = await toastClient.sendToastRequest({
                action: 'status'
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false, timeoutMs: 2500 });
            assert.equal(statusWhileSlow.running, true, 'Async pipe server must not block while another client stalls');
            try { slowSock.destroy(); } catch {}

            // Cross-turnKey completed deduplication & dismiss suppression (Stop Hook vs ui-core poll)
            const comp1 = await toastClient.sendToastRequest({
                action: 'notify',
                kind: 'completed',
                conversationId: 'conv-dedup-1',
                title: 'Cross TurnKey Test',
                turnKey: 'step:1:2026-11-26T00:00:00Z'
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(comp1.shown, true);
            await toastClient.sendToastRequest({ action: 'dismiss_all' }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            const comp2AfterDismiss = await toastClient.sendToastRequest({
                action: 'notify',
                kind: 'completed',
                conversationId: 'conv-dedup-1',
                title: 'Cross TurnKey Test',
                turnKey: 'ui-start:1795600000000'
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(comp2AfterDismiss.shown, false, 'Dismissed completed toast must not resurrect from different turnKey within 8s');

            const notified = await toastClient.sendToastRequest({
                action: 'notify',
                kind: 'action_required',
                statusLabel: 'Input needed',
                conversationId: 'conv-test-001',
                title: 'Automated Test Card',
                turnKey: 'ask:1',
                questions: [{
                    question: 'Select deployment mode',
                    isMultiSelect: false,
                    options: ['(Recommended) Standard', 'Minimal']
                }]
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(notified.shown, true);

            const selectedOpt = await toastClient.sendToastRequest({
                action: 'select_option',
                conversationId: 'conv-test-001',
                questionIndex: 0,
                optionIndex: 1
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(selectedOpt.ok, true);

            const submittedQ = await toastClient.sendToastRequest({
                action: 'submit_question',
                conversationId: 'conv-test-001'
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(submittedQ.submitted, true);
            assert.equal(fs.existsSync(submitLog), true);

            const scrolled = await toastClient.sendToastRequest({
                action: 'scroll_card',
                conversationId: 'conv-test-001',
                delta: 120
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(scrolled.ok, true);

            const dismissed = await toastClient.sendToastRequest({
                action: 'dismiss_all'
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(dismissed.ok, true);

            // Oversized (>2 MiB) payload to TaskToastHost named pipe must be rejected with payload_too_large
            const toastBigReply = await new Promise((resolve, reject) => {
                const net = require('node:net');
                const sock = net.createConnection(`\\\\.\\pipe\\${testPipe}`);
                let data = '';
                sock.setEncoding('utf8');
                sock.on('data', chunk => { data += chunk; });
                sock.on('end', () => resolve(data.trim()));
                sock.on('error', () => resolve(data.trim()));
                sock.on('connect', () => {
                    const bigChunk = 'a'.repeat(256 * 1024);
                    for (let i = 0; i < 10; i++) {
                        if (!sock.destroyed) sock.write(bigChunk);
                    }
                    if (!sock.destroyed) sock.write('\n');
                });
                setTimeout(() => { try { sock.destroy(); } catch {} reject(new Error('toast oversized pipe test timeout')); }, 5000);
            });
            assert.ok(toastBigReply.includes('payload_too_large'), `Expected payload_too_large from TaskToastHost, got: ${toastBigReply}`);

            const statusAfterBig = await toastClient.sendToastRequest({
                action: 'status'
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(statusAfterBig.running, true);

            const shut = await toastClient.sendToastRequest({
                action: 'shutdown'
            }, { installRoot: toastInstallRoot, exePath, pipeName: testPipe, ensureRunning: false });
            assert.equal(shut.ok, true);
            assert.equal(shut.shuttingDown, true);
            await new Promise(r => setTimeout(r, 200));
        });

        await step('11. ui-core v10: 3-stage context colors (green/orange/red), hover preview, 140ms bridge & click pin', async () => {
            const origWin = global.window;
            const origDoc = global.document;
            const origLoc = global.location;
            const origMut = global.MutationObserver;
            const origIw = global.innerWidth;
            const origIh = global.innerHeight;
            try {
                let currentTokensUsed = 45000;
                const maxTokens = 100000;
                const nativeStorageUpdates = [];
                const agentState = {
                    get contextWindowUsage() {
                        return {
                            estimatedTokensUsed: currentTokensUsed,
                            maxContextTokens: maxTokens,
                            tokenGroups: [{ name: 'System', numTokens: 10000 }, { name: 'History', numTokens: 35000 }]
                        };
                    }
                };

                function makeEl(tag, init = {}) {
                    const attrs = new Map();
                    const listeners = new Map();
                    const styleProps = new Map();
                    const node = {
                        tagName: String(tag || 'div').toUpperCase(),
                        id: init.id || '',
                        className: init.className || '',
                        hidden: false,
                        textContent: init.textContent || '',
                        dataset: { ...(init.dataset || {}) },
                        children: [],
                        parentNode: null,
                        parentElement: null,
                        isConnected: Boolean(init.isConnected),
                        offsetWidth: 320,
                        offsetHeight: 160,
                        style: {
                            setProperty(k, v) { styleProps.set(k, String(v)); },
                            getPropertyValue(k) { return styleProps.get(k) || ''; }
                        },
                        setAttribute(k, v) { attrs.set(k, String(v)); },
                        getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
                        removeAttribute(k) { attrs.delete(k); },
                        addEventListener(type, fn) {
                            if (!listeners.has(type)) listeners.set(type, []);
                            listeners.get(type).push(fn);
                        },
                        removeEventListener(type, fn) {
                            const list = listeners.get(type);
                            if (!list) return;
                            const i = list.indexOf(fn);
                            if (i >= 0) list.splice(i, 1);
                        },
                        dispatchEvent(ev) {
                            for (const fn of (listeners.get(ev.type) || []).slice()) fn(ev);
                        },
                        click() { this.dispatchEvent({ type: 'click', target: this }); },
                        append(...items) {
                            for (const it of items) {
                                if (!it) continue;
                                if (it.parentNode) it.remove();
                                it.parentNode = this;
                                it.parentElement = this;
                                this.children.push(it);
                                setConn(it, this.isConnected);
                            }
                        },
                        prepend(it) {
                            if (!it) return;
                            if (it.parentNode) it.remove();
                            it.parentNode = this;
                            it.parentElement = this;
                            this.children.unshift(it);
                            setConn(it, this.isConnected);
                        },
                        before(it) {
                            if (!it || !this.parentNode) return;
                            if (it.parentNode) it.remove();
                            const sibs = this.parentNode.children;
                            const idx = sibs.indexOf(this);
                            it.parentNode = this.parentNode;
                            it.parentElement = this.parentNode;
                            sibs.splice(Math.max(0, idx), 0, it);
                            setConn(it, this.parentNode.isConnected);
                        },
                        replaceChildren(...items) {
                            for (const ch of this.children) { ch.parentNode = null; ch.parentElement = null; setConn(ch, false); }
                            this.children = [];
                            this.append(...items);
                        },
                        remove() {
                            if (!this.parentNode) return;
                            const sibs = this.parentNode.children;
                            const idx = sibs.indexOf(this);
                            if (idx >= 0) sibs.splice(idx, 1);
                            this.parentNode = null;
                            this.parentElement = null;
                            setConn(this, false);
                        },
                        get previousElementSibling() {
                            if (!this.parentNode) return null;
                            const sibs = this.parentNode.children;
                            const idx = sibs.indexOf(this);
                            return idx > 0 ? sibs[idx - 1] : null;
                        },
                        get firstElementChild() { return this.children[0] || null; },
                        get lastElementChild() { return this.children[this.children.length - 1] || null; },
                        contains(t) {
                            let cur = t;
                            while (cur) { if (cur === this) return true; cur = cur.parentNode; }
                            return false;
                        },
                        getBoundingClientRect: () => ({ left: 400, right: 428, top: 700, bottom: 728, width: 28, height: 28 }),
                        closest(sel) {
                            let cur = this;
                            while (cur) { if (matchSel(cur, sel)) return cur; cur = cur.parentNode; }
                            return null;
                        },
                        querySelector(sel) { return findAll(this, sel)[0] || null; },
                        querySelectorAll(sel) { return findAll(this, sel); }
                    };
                    let rawHtml = '';
                    Object.defineProperty(node, 'innerHTML', {
                        get() { return rawHtml; },
                        set(val) {
                            rawHtml = String(val);
                            if (rawHtml.includes('agy-plus-quota-split-ring')) {
                                const ring = makeEl('span', { className: 'agy-plus-quota-ring agy-plus-quota-split-ring' });
                                const arc5h = makeEl('path'); arc5h.setAttribute('data-arc', '5h');
                                const arcWk = makeEl('path'); arcWk.setAttribute('data-arc', 'weekly');
                                ring.append(arc5h, arcWk);
                                node.replaceChildren(ring);
                            } else if (rawHtml.includes('agy-plus-quota-ring')) {
                                node.replaceChildren(makeEl('span', { className: 'agy-plus-quota-ring' }));
                            }
                        }
                    });
                    return node;
                }
                function setConn(n, c) { n.isConnected = c; for (const ch of n.children || []) setConn(ch, c); }
                function matchSel(n, sel) {
                    if (!n || !sel) return false;
                    if (sel.startsWith('#')) return n.id === sel.slice(1);
                    if (sel.startsWith('.')) return String(n.className || '').split(/\s+/).includes(sel.slice(1));
                    const mAttrVal = /^\[([a-z0-9_-]+)="([^"]+)"\]$/i.exec(sel);
                    if (mAttrVal) {
                        const attrName = mAttrVal[1];
                        const expected = mAttrVal[2];
                        if (attrName === 'data-testid' && n.dataset?.testid === expected) return true;
                        return n.getAttribute(attrName) === expected;
                    }
                    const mAttrPresent = /^\[([a-z0-9_-]+)\]$/i.exec(sel);
                    if (mAttrPresent) {
                        const attrName = mAttrPresent[1];
                        return n.getAttribute(attrName) !== null;
                    }
                    return false;
                }
                function findAll(root, sel) {
                    if (sel === '[data-testid="agent-input-box"] [data-testid="permissions-selector-trigger"]') {
                        const ib = findAll(root, '[data-testid="agent-input-box"]')[0];
                        return ib ? findAll(ib, '[data-testid="permissions-selector-trigger"]') : [];
                    }
                    const out = [];
                    const walk = cur => {
                        for (const ch of cur.children || []) {
                            if (matchSel(ch, sel)) out.push(ch);
                            walk(ch);
                        }
                    };
                    walk(root);
                    return out;
                }

                const docEl = makeEl('html', { isConnected: true });
                const head = makeEl('head', { isConnected: true });
                const body = makeEl('body', { isConnected: true });
                const classes = new Set();
                body.classList = {
                    add(...c) { c.forEach(x => classes.add(x)); },
                    remove(...c) { c.forEach(x => classes.delete(x)); },
                    contains(x) { return classes.has(x); }
                };

                const sidebar = makeEl('aside', { className: 'bg-sidebar' });
                const navItems = makeEl('div', { dataset: { testid: 'sidebar-navigation-items' } });
                const footer = makeEl('footer');
                sidebar.append(navItems, footer);

                const inputBox = makeEl('div', { dataset: { testid: 'agent-input-box' } });
                inputBox.__reactFiber$mock = {
                    memoizedProps: {
                        value: {
                            conversationId: 'conv-ctx-1',
                            getAgentStates: () => new Map([['conv-ctx-1', { provider: { getState: () => agentState } }]])
                        }
                    },
                    return: null
                };
                const permTrigger = makeEl('button', { dataset: { testid: 'permissions-selector-trigger' } });
                inputBox.append(permTrigger);
                body.append(sidebar, inputBox);

                const docListeners = new Map();
                global.innerWidth = 1280;
                global.innerHeight = 800;
                global.location = { hostname: '127.0.0.1', pathname: '/c/conv-ctx-1', origin: 'https://127.0.0.1' };
                global.MutationObserver = class { observe() {} disconnect() {} };
                global.document = {
                    documentElement: docEl,
                    head,
                    body,
                    createElement: tag => makeEl(tag),
                    querySelector: sel => findAll(body, sel)[0] || null,
                    querySelectorAll: sel => (sel.includes(':is(') || sel.includes('[style*=') || sel === 'a[href]' ? [] : findAll(body, sel)),
                    addEventListener(t, fn) { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(fn); },
                    removeEventListener() {},
                    dispatchEvent(ev) { for (const fn of (docListeners.get(ev.type) || [])) fn(ev); }
                };
                const bridgePatches = [];
                let newWindowCalls = 0;
                global.window = {
                    location: global.location,
                    __agyPlusBridge: {
                        updateConfig: async patch => {
                            bridgePatches.push(patch);
                            return { ok: true };
                        },
                        openNewWindow: async () => {
                            newWindowCalls++;
                            return { ok: true };
                        }
                    },
                    nativeStorage: {
                        getItems: async () => ({}),
                        updateItems: async patch => { nativeStorageUpdates.push(patch); }
                    },
                    setTimeout,
                    clearTimeout,
                    setInterval: () => 999,
                    clearInterval: () => {},
                    addEventListener: () => {},
                    removeEventListener: () => {}
                };

                // Boot initially with contextRing: false, then live-enable to verify nativeStorage sync
                const st = installAgyPlusUI({ themeCss: '/*theme*/', widgetsCss: '/*widgets*/', config: { features: { contextRing: false } } });
                assert.equal(st.installed, true);
                assert.equal(st.version, 10);
                assert.equal(nativeStorageUpdates.length, 0);

                global.window.__agyPlusUI.applyConfig({ features: { contextRing: true } });
                await new Promise(r => setTimeout(r, 10));
                const updatesAfterEnable = nativeStorageUpdates.length;
                assert.ok(nativeStorageUpdates.some(u => u && u.contextUsageIndicatorEnabled === 'true'));

                // Verify idempotent applyConfig does NOT re-query nativeStorage or destroy settingsPanel buttons
                global.window.__agyPlusUI.openSettingsPanel(true);
                const settingsPanel = findAll(body, '#agy-plus-settings-panel')[0];
                const codexSwitchBefore = settingsPanel.querySelector('[data-feature-key="codexTheme"]');
                assert.ok(codexSwitchBefore, 'codexTheme switch must exist in settings panel');

                global.window.__agyPlusUI.applyConfig({ features: { contextRing: true } });
                await new Promise(r => setTimeout(r, 10));
                assert.equal(nativeStorageUpdates.length, updatesAfterEnable, 'idempotent applyConfig must skip redundant nativeStorage calls');
                assert.equal(settingsPanel.querySelector('[data-feature-key="codexTheme"]'), codexSwitchBefore, 'settings button DOM node must not be recreated');

                // Clicking switch invokes contextBridge __agyPlusBridge.updateConfig in-place without destroying node
                codexSwitchBefore.click();
                await new Promise(r => setTimeout(r, 10));
                assert.equal(bridgePatches.length, 1);
                assert.equal(bridgePatches[0].features.codexTheme, false);
                assert.equal(codexSwitchBefore.getAttribute('aria-checked'), 'false');
                assert.equal(codexSwitchBefore.isConnected, true);
                global.window.__agyPlusUI.openSettingsPanel(false);

                const ctxBtn = findAll(body, '[data-testid="agy-plus-context-pending"]')[0];
                const ctxPanel = findAll(body, '#agy-plus-context-panel')[0];
                const perfBtn = findAll(body, '[data-testid="agy-plus-performance-indicator"]')[0];
                const perfPanel = findAll(body, '#agy-plus-performance-panel')[0];

                // 45% -> green
                assert.equal(ctxBtn.dataset.contextLevel, 'green');
                assert.equal(ctxPanel.dataset.contextLevel, 'green');

                // Hover opens without clicking, moving into panel within 140ms keeps it alive
                assert.equal(ctxPanel.hidden, true);
                ctxBtn.dispatchEvent({ type: 'pointerenter', target: ctxBtn });
                assert.equal(ctxPanel.hidden, false);
                assert.equal(ctxBtn.dataset.pinned, undefined);

                ctxBtn.dispatchEvent({ type: 'pointerleave', target: ctxBtn });
                await new Promise(r => setTimeout(r, 50));
                ctxPanel.dispatchEvent({ type: 'pointerenter', target: ctxPanel });
                await new Promise(r => setTimeout(r, 130));
                assert.equal(ctxPanel.hidden, false, '140ms bridge should keep panel open when cursor enters panel');

                // Click pins panel; 60% -> orange; 80% -> red
                currentTokensUsed = 60000;
                ctxBtn.click();
                assert.equal(ctxBtn.dataset.pinned, 'true');
                assert.equal(ctxBtn.dataset.contextLevel, 'orange');

                currentTokensUsed = 80000;
                perfBtn.dispatchEvent({ type: 'pointerenter', target: perfBtn });
                assert.equal(perfPanel.hidden, false);
                assert.equal(ctxPanel.hidden, true);

                ctxBtn.dispatchEvent({ type: 'pointerenter', target: ctxBtn });
                assert.equal(ctxBtn.dataset.contextLevel, 'red');
                assert.equal(ctxPanel.dataset.contextLevel, 'red');

                // Ctrl+Shift+N triggers openNewWindow when newWindowMenu is enabled, ignores repeat, and is ignored when disabled
                let prevented = false;
                let stopped = false;
                global.document.dispatchEvent({
                    type: 'keydown',
                    ctrlKey: true,
                    shiftKey: true,
                    altKey: false,
                    repeat: false,
                    code: 'KeyN',
                    key: 'N',
                    preventDefault() { prevented = true; },
                    stopPropagation() { stopped = true; }
                });
                assert.equal(prevented, true, 'Ctrl+Shift+N must prevent default when newWindowMenu is enabled');
                assert.equal(stopped, true, 'Ctrl+Shift+N must stop propagation when newWindowMenu is enabled');
                assert.equal(newWindowCalls, 1, 'Ctrl+Shift+N must invoke __agyPlusBridge.openNewWindow()');

                global.document.dispatchEvent({
                    type: 'keydown',
                    ctrlKey: true,
                    shiftKey: true,
                    altKey: false,
                    repeat: true,
                    code: 'KeyN',
                    key: 'N',
                    preventDefault() {},
                    stopPropagation() {}
                });
                assert.equal(newWindowCalls, 1, 'Key repeat on Ctrl+Shift+N must not spawn duplicate windows');

                // Escape stops propagation ONLY when a Plus popup is open, and passes through when all popups are closed
                global.window.__agyPlusUI.openSettingsPanel(true);
                let escStoppedOpen = false;
                global.document.dispatchEvent({
                    type: 'keydown',
                    key: 'Escape',
                    preventDefault() {},
                    stopPropagation() { escStoppedOpen = true; }
                });
                assert.equal(escStoppedOpen, true, 'Escape must stop propagation when closing an open Plus popup');
                let escStoppedClosed = false;
                global.document.dispatchEvent({
                    type: 'keydown',
                    key: 'Escape',
                    preventDefault() {},
                    stopPropagation() { escStoppedClosed = true; }
                });
                assert.equal(escStoppedClosed, false, 'Escape must not intercept when no Plus popup is open');

                global.window.__agyPlusUI.applyConfig({ features: { newWindowMenu: false } });
                let preventedWhenDisabled = false;
                global.document.dispatchEvent({
                    type: 'keydown',
                    ctrlKey: true,
                    shiftKey: true,
                    altKey: false,
                    code: 'KeyN',
                    key: 'N',
                    preventDefault() { preventedWhenDisabled = true; },
                    stopPropagation() {}
                });
                assert.equal(preventedWhenDisabled, false);
                assert.equal(newWindowCalls, 1, 'Ctrl+Shift+N must not fire when newWindowMenu is disabled');

                // Live toggle off contextRing hides button and panel immediately
                global.window.__agyPlusUI.applyConfig({ features: { contextRing: false } });
                assert.equal(ctxBtn.hidden, true);
                assert.equal(ctxPanel.hidden, true);

                // Interactive step-by-step feature tour: replay from settings panel, step navigation, keyboard & completion persistence
                global.window.__agyPlusUI.openSettingsPanel(true);
                const replayTourBtn = settingsPanel.querySelector('[data-testid="agy-plus-replay-tour"]');
                assert.ok(replayTourBtn, 'Settings panel must provide a replay-tour button');
                replayTourBtn.click();
                assert.equal(settingsPanel.hidden, true, 'Starting tour must close settings panel');
                let tourStatus = global.window.__agyPlusUI.status().tour;
                assert.equal(tourStatus.active, true);
                assert.equal(tourStatus.stepIndex, 0);
                assert.equal(tourStatus.totalSteps, 7);

                const tourCard = findAll(body, '#agy-plus-tour-card')[0];
                const tourSpotlight = findAll(body, '[data-testid="agy-plus-tour-spotlight"]')[0];
                assert.equal(tourCard.hidden, false);
                assert.equal(tourSpotlight.hidden, false, 'Step 1 must highlight the settings button with spotlight');

                // Next button & ArrowRight advance steps; ArrowLeft steps back
                tourCard.querySelector('[data-testid="agy-plus-tour-next"]').click();
                assert.equal(global.window.__agyPlusUI.status().tour.stepIndex, 1);
                global.document.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
                assert.equal(global.window.__agyPlusUI.status().tour.stepIndex, 2);
                global.document.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', preventDefault() {}, stopPropagation() {} });
                assert.equal(global.window.__agyPlusUI.status().tour.stepIndex, 1);

                // Jump to last step and complete -> persists onboarding.tourCompleted = true via bridge
                global.window.__agyPlusUI.startTour(6);
                assert.equal(global.window.__agyPlusUI.status().tour.stepIndex, 6);
                tourCard.querySelector('[data-testid="agy-plus-tour-next"]').click();
                await new Promise(r => setTimeout(r, 10));
                assert.equal(global.window.__agyPlusUI.status().tour.active, false);
                assert.equal(global.window.__agyPlusUI.status().tour.completed, true);
                assert.equal(tourCard.hidden, true);
                assert.ok(bridgePatches.some(p => p?.onboarding?.tourCompleted === true), 'Completing tour must persist onboarding.tourCompleted');

                // Replay again and Escape dismisses tour cleanly
                global.window.__agyPlusUI.startTour(0);
                assert.equal(global.window.__agyPlusUI.status().tour.active, true);
                let escStoppedTour = false;
                global.document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() { escStoppedTour = true; } });
                assert.equal(escStoppedTour, true);
                assert.equal(global.window.__agyPlusUI.status().tour.active, false);

                global.window.__agyPlusUI.dispose();
                assert.equal(tourCard.isConnected, false, 'dispose() must remove tour card DOM');
                assert.equal(tourSpotlight.isConnected, false, 'dispose() must remove tour spotlight DOM');
            } finally {
                global.window = origWin;
                global.document = origDoc;
                global.location = origLoc;
                global.MutationObserver = origMut;
                global.innerWidth = origIw;
                global.innerHeight = origIh;
            }
        });

        await step('11b. ui-core v10: foreground permission options with persistSuggestionType=1 and post-submit stability', async () => {
            const origWin = global.window;
            const origDoc = global.document;
            const origLoc = global.location;
            const origMut = global.MutationObserver;
            const origIw = global.innerWidth;
            const origIh = global.innerHeight;
            try {
                function matchNode(node, sel) {
                    if (!node || !sel) return false;
                    const tagOnly = /^[a-z]+$/i.test(sel);
                    if (tagOnly) return node.tagName === sel.toUpperCase();
                    if (sel.startsWith('#')) return node.id === sel.slice(1);
                    if (sel.startsWith('.')) return String(node.className || '').split(/\s+/).includes(sel.slice(1));
                    const mAttrVal = /^\[([a-z0-9_-]+)="([^"]+)"\]$/i.exec(sel);
                    if (mAttrVal) {
                        const k = mAttrVal[1];
                        const expected = mAttrVal[2];
                        if (k === 'data-testid' && node.dataset?.testid === expected) return true;
                        return node.getAttribute(k) === expected;
                    }
                    const mAttrPresent = /^\[([a-z0-9_-]+)\]$/i.exec(sel);
                    if (mAttrPresent) return node.getAttribute(mAttrPresent[1]) !== null;
                    return false;
                }
                function queryNodes(root, sel) {
                    if (sel === '[data-testid="agent-input-box"] [data-testid="permissions-selector-trigger"]') {
                        const ib = queryNodes(root, '[data-testid="agent-input-box"]')[0];
                        return ib ? queryNodes(ib, '[data-testid="permissions-selector-trigger"]') : [];
                    }
                    const out = [];
                    const walk = cur => {
                        for (const ch of cur.children || []) {
                            if (matchNode(ch, sel)) out.push(ch);
                            walk(ch);
                        }
                    };
                    walk(root);
                    return out;
                }
                function makeNode(tag, init = {}) {
                    const attrs = new Map();
                    const node = {
                        tagName: String(tag || 'div').toUpperCase(),
                        id: init.id || '',
                        className: init.className || '',
                        hidden: Boolean(init.hidden),
                        value: init.value,
                        disabled: Boolean(init.disabled),
                        textContent: init.textContent || '',
                        dataset: { ...(init.dataset || {}) },
                        children: [],
                        parentNode: null,
                        parentElement: null,
                        isConnected: Boolean(init.isConnected),
                        style: { setProperty() {}, getPropertyValue() { return ''; } },
                        setAttribute(k, v) { attrs.set(k, String(v)); },
                        getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
                        removeAttribute(k) { attrs.delete(k); },
                        addEventListener() {},
                        removeEventListener() {},
                        getClientRects() { return this.hidden ? [] : [{ width: 320, height: 120 }]; },
                        getBoundingClientRect() { return { left: 400, right: 428, top: 700, bottom: 728, width: 28, height: 28 }; },
                        append(...items) {
                            for (const it of items) {
                                if (!it) continue;
                                if (it.parentNode) it.remove();
                                it.parentNode = this;
                                it.parentElement = this;
                                this.children.push(it);
                            }
                        },
                        prepend(it) {
                            if (!it) return;
                            if (it.parentNode) it.remove();
                            it.parentNode = this;
                            it.parentElement = this;
                            this.children.unshift(it);
                        },
                        before(it) {
                            if (!it || !this.parentNode) return;
                            if (it.parentNode) it.remove();
                            const sibs = this.parentNode.children;
                            const idx = sibs.indexOf(this);
                            it.parentNode = this.parentNode;
                            it.parentElement = this.parentNode;
                            sibs.splice(Math.max(0, idx), 0, it);
                        },
                        replaceChildren(...items) { this.children = []; this.append(...items); },
                        remove() {
                            if (!this.parentNode) return;
                            const sibs = this.parentNode.children;
                            const idx = sibs.indexOf(this);
                            if (idx >= 0) sibs.splice(idx, 1);
                            this.parentNode = null;
                            this.parentElement = null;
                        },
                        get previousElementSibling() {
                            if (!this.parentNode) return null;
                            const sibs = this.parentNode.children;
                            const idx = sibs.indexOf(this);
                            return idx > 0 ? sibs[idx - 1] : null;
                        },
                        get firstElementChild() { return this.children[0] || null; },
                        contains(t) {
                            let cur = t;
                            while (cur) { if (cur === this) return true; cur = cur.parentNode; }
                            return false;
                        },
                        closest(sel) {
                            let cur = this;
                            while (cur) { if (matchNode(cur, sel)) return cur; cur = cur.parentNode; }
                            return null;
                        },
                        querySelector(sel) { return queryNodes(this, sel)[0] || null; },
                        querySelectorAll(sel) { return queryNodes(this, sel); }
                    };
                    let rawHtml = '';
                    Object.defineProperty(node, 'innerHTML', {
                        get() { return rawHtml; },
                        set(val) {
                            rawHtml = String(val);
                            if (rawHtml.includes('agy-plus-quota-split-ring')) {
                                const ring = makeNode('span', { className: 'agy-plus-quota-ring agy-plus-quota-split-ring' });
                                const arc5h = makeNode('path'); arc5h.setAttribute('data-arc', '5h');
                                const arcWk = makeNode('path'); arcWk.setAttribute('data-arc', 'weekly');
                                ring.append(arc5h, arcWk);
                                node.replaceChildren(ring);
                            } else if (rawHtml.includes('agy-plus-quota-ring')) {
                                node.replaceChildren(makeNode('span', { className: 'agy-plus-quota-ring' }));
                            }
                        }
                    });
                    return node;
                }

                const docEl = makeNode('html', { isConnected: true });
                const head = makeNode('head', { isConnected: true });
                const body = makeNode('body', { isConnected: true });
                const classes = new Set();
                body.classList = { add(...c) { c.forEach(x => classes.add(x)); }, remove(...c) { c.forEach(x => classes.delete(x)); }, contains: x => classes.has(x) };

                const nativeCalls = [];
                let stepsInSlice = [];
                const agentState = {
                    trajectorySlice: {
                        trajectoryId: 'traj-perm-1',
                        stepsSlice: { startIndex: 0 },
                        totalStepsLength: 2,
                        get stepsInSlice() { return stepsInSlice; }
                    }
                };
                const convId = 'conv-perm-1';
                const statesMap = new Map([[convId, { provider: { getState: () => agentState } }]]);
                const summariesRoot = { summaries: { [convId]: { summary: 'Push Repo Updates' } }, indexes: {} };
                const inputBox = makeNode('div', { dataset: { testid: 'agent-input-box' } });
                inputBox.append(makeNode('button', { dataset: { testid: 'permissions-selector-trigger' } }));
                inputBox.__reactFiber$perm = {
                    memoizedProps: {
                        value: {
                            conversationId: convId,
                            getAgentStates: () => statesMap,
                            handleCascadeUserInteraction: (cascadeId, payload) => {
                                nativeCalls.push({ cascadeId, payload });
                                return { ok: true };
                            },
                            get: name => (name === 'rawCommandDetails' ? { isEnabled: true } : null),
                            getBaseline: () => null
                        },
                        store: { getState: () => ({ trajectorySummaries: summariesRoot }) }
                    },
                    return: null
                };
                body.append(makeNode('aside', { className: 'bg-sidebar' }), inputBox);

                global.innerWidth = 1280;
                global.innerHeight = 800;
                global.location = { hostname: '127.0.0.1', pathname: `/c/${convId}`, origin: 'https://127.0.0.1' };
                global.MutationObserver = class { observe() {} disconnect() {} };
                global.document = {
                    documentElement: docEl,
                    head,
                    body,
                    hasFocus: () => true,
                    createElement: tag => makeNode(tag),
                    querySelector: sel => queryNodes(body, sel)[0] || null,
                    querySelectorAll: sel => (sel.includes(':is(') || sel.includes('[style*=') || sel === 'a[href]' ? [] : queryNodes(body, sel)),
                    addEventListener() {},
                    removeEventListener() {}
                };
                global.window = {
                    location: global.location,
                    crypto: crypto.webcrypto,
                    nativeStorage: { getItems: async () => ({}), updateItems: async () => {} },
                    setTimeout,
                    clearTimeout,
                    setInterval: () => 998,
                    clearInterval: () => {},
                    addEventListener: () => {},
                    removeEventListener: () => {}
                };

                installAgyPlusUI({ themeCss: '', widgetsCss: '', config: { features: { contextRing: false }, onboarding: { tourCompleted: true } } });

                let activeCard = null;
                function mountNativeCard(spec, editorText, optionTexts) {
                    if (activeCard) activeCard.remove();
                    const card = makeNode('div', { dataset: { testid: 'interaction-takeover-card' } });
                    card.__reactFiber$card = {
                        memoizedProps: {
                            cascadeId: convId,
                            trajectoryId: 'traj-perm-1',
                            stepIndex: 10,
                            permissionSpec: spec
                        },
                        return: null
                    };
                    if (editorText !== null) {
                        card.append(makeNode('textarea', {
                            dataset: { testid: 'permission-target-editor' },
                            value: editorText
                        }));
                    }
                    for (const txt of optionTexts) {
                        const opt = makeNode('label', { dataset: { testid: 'ask-question-option' } });
                        opt.append(makeNode('input'), makeNode('div', { dataset: { testid: 'ask-question-option-text' }, textContent: txt }));
                        card.append(opt);
                    }
                    card.append(makeNode('button', { dataset: { testid: 'interaction-skip-button' } }));
                    body.append(card);
                    activeCard = card;
                }

                // 1) Regression: persistSuggestionType=1 with suggestedPersistPattern must format real command/pattern (never 'true')
                //    so mounted foreground takeover cards keep Submit options instead of triggering native_options_mismatch.
                const pushCmd = 'git -C C:\\repo\\app push origin main';
                const cmdSpec = {
                    resource: { action: 'command', target: pushCmd },
                    persistSuggestionType: 1,
                    suggestedPersistPattern: 'git -C C:\\repo\\app push',
                    reason: 'Pushing to origin main',
                    actionDescription: 'Push repository updates'
                };
                stepsInSlice = [{
                    status: 9,
                    step: { case: 'generic', value: {} },
                    requestedInteraction: { interaction: { case: 'permission', value: cmdSpec } },
                    metadata: {
                        createdAt: { seconds: '1700000100' },
                        sourceTrajectoryStepInfo: { trajectoryId: 'traj-perm-1', stepIndex: 10 },
                        toolCall: { id: 'call-push-1', name: 'run_command', argumentsJson: JSON.stringify({ CommandLine: pushCmd }) }
                    }
                }];
                mountNativeCard(cmdSpec, pushCmd, [
                    'Yes, allow this time',
                    "Yes, and always allow 'git -C C:\\repo\\app push' in this conversation",
                    "Yes, and always allow 'git -C C:\\repo\\app push'"
                ]);

                const fgSync = await global.window.__agyPlusUI.syncToastState();
                assert.equal(global.window.__agyPlusUI.status().approvalDiag.lastPermissionDiag.status, 'ok');
                assert.equal(global.window.__agyPlusUI.status().approvalDiag.lastPermissionDiag.nativeMatched, 3);
                const fgCard = fgSync.completed[0];
                assert.equal(fgCard.questions.length, 1, 'Foreground takeover card must keep Submit questions');
                assert.deepEqual(fgCard.questions[0].options, [
                    'Yes, allow this time',
                    "Yes, and always allow 'git -C C:\\repo\\app push' in this conversation",
                    "Yes, and always allow 'git -C C:\\repo\\app push'",
                    'No (deny this request)'
                ]);

                // 2) Simulating optimistic card unmount before trueState leaves WAITING must produce identical approval options & key.
                activeCard.remove();
                activeCard = null;
                const optSync = await global.window.__agyPlusUI.syncToastState();
                assert.equal(global.window.__agyPlusUI.status().approvalDiag.lastPermissionDiag.nativeMatched, 0);
                assert.equal(optSync.completed[0].questions[0].nativeApprovalKey, fgCard.questions[0].nativeApprovalKey);
                assert.deepEqual(optSync.completed[0].questions[0].options, fgCard.questions[0].options);

                // 3) Edited target overrides suggestedPersistPattern and updates submitted payload cleanly.
                const editedCmd = 'git -C C:\\repo\\app push origin main --dry-run';
                mountNativeCard(cmdSpec, editedCmd, [
                    'Yes, allow this time',
                    `Yes, and always allow '${editedCmd}' in this conversation`,
                    `Yes, and always allow '${editedCmd}'`
                ]);
                const editSync = await global.window.__agyPlusUI.syncToastState();
                const editCard = editSync.completed[0];
                assert.equal(editCard.questions.length, 1);
                assert.deepEqual(editCard.questions[0].options, [
                    'Yes, allow this time',
                    `Yes, and always allow '${editedCmd}' in this conversation`,
                    `Yes, and always allow '${editedCmd}'`,
                    'No (deny this request)'
                ]);
                const editSubmit = await global.window.__agyPlusUI.submitAskQuestion(convId, [{
                    kind: 'native_permission',
                    key: editCard.questions[0].nativeApprovalKey,
                    requestKey: editCard.turnKey,
                    optionIndex: 1,
                    deny: false
                }]);
                assert.equal(editSubmit.submitted, true);
                assert.equal(nativeCalls[0].payload.interaction.value.editedTarget, editedCmd);
                assert.deepEqual(nativeCalls[0].payload.interaction.value.persistGrants.allow, [`command(${editedCmd})`]);

                // 4) Auto-expanded truncated target with isUnedited=true still preserves suggestedPersistPattern.
                const truncSpec = {
                    resource: { action: 'command', target: 'gh repo create ...' },
                    persistSuggestionType: 1,
                    suggestedPersistPattern: 'gh repo create'
                };
                stepsInSlice = [{
                    status: 9,
                    step: { case: 'generic', value: {} },
                    requestedInteraction: { interaction: { case: 'permission', value: truncSpec } },
                    metadata: {
                        createdAt: { seconds: '1700000200' },
                        sourceTrajectoryStepInfo: { trajectoryId: 'traj-perm-1', stepIndex: 10 },
                        toolCall: { id: 'call-gh-1', name: 'run_command', argumentsJson: JSON.stringify({ CommandLine: 'gh repo create derrickLL/demo --public' }) }
                    }
                }];
                mountNativeCard(truncSpec, 'gh repo create ...', [
                    'Yes, allow this time',
                    "Yes, and always allow 'gh repo create' in this conversation",
                    "Yes, and always allow 'gh repo create'"
                ]);
                const truncSync = await global.window.__agyPlusUI.syncToastState();
                assert.equal(global.window.__agyPlusUI.status().approvalDiag.lastPermissionDiag.status, 'ok');
                const truncCard = truncSync.completed[0];
                assert.equal(truncCard.questions.length, 1);
                const truncSubmit = await global.window.__agyPlusUI.submitAskQuestion(convId, [{
                    kind: 'native_permission',
                    key: truncCard.questions[0].nativeApprovalKey,
                    requestKey: truncCard.turnKey,
                    optionIndex: 2,
                    deny: false
                }]);
                assert.equal(truncSubmit.submitted, true);
                assert.equal(nativeCalls[1].payload.interaction.value.editedTarget, undefined);
                assert.deepEqual(nativeCalls[1].payload.interaction.value.persistGrants.allow, ['command(gh repo create)']);

                global.window.__agyPlusUI.dispose();
            } finally {
                global.window = origWin;
                global.document = origDoc;
                global.location = origLoc;
                global.MutationObserver = origMut;
                global.innerWidth = origIw;
                global.innerHeight = origIh;
            }
        });

        await step('12. thought-localization v7 & navigation-gestures v2: live toggles and route history', async () => {
            const origWin = global.window;
            const origDoc = global.document;
            const origLoc = global.location;
            const origHist = global.history;
            const origMut = global.MutationObserver;
            const origNf = global.NodeFilter;
            const origIw = global.innerWidth;
            const origIh = global.innerHeight;
            try {
                global.innerWidth = 1280;
                global.innerHeight = 800;
                global.NodeFilter = { SHOW_TEXT: 4 };
                global.MutationObserver = class { observe() {} disconnect() {} };
                global.location = { pathname: '/c/conv-alpha', search: '', origin: 'https://127.0.0.1' };
                global.history = { state: null, pushState(_s, _t, url) { global.location.pathname = String(url).split('?')[0]; }, replaceState() {} };

                const titleTextNode = {
                    nodeType: 3,
                    nodeValue: 'Refactor context window ring colors',
                    isConnected: true,
                    parentElement: null,
                    contains: () => false
                };
                const linkAttrs = new Map([['href', '/c/conv-alpha']]);
                const linkEl = {
                    nodeType: 1,
                    tagName: 'A',
                    href: 'https://127.0.0.1/c/conv-alpha',
                    isConnected: true,
                    parentElement: null,
                    hasAttribute: k => linkAttrs.has(k),
                    getAttribute: k => (linkAttrs.has(k) ? linkAttrs.get(k) : null),
                    setAttribute: (k, v) => { linkAttrs.set(k, String(v)); },
                    removeAttribute: k => { linkAttrs.delete(k); },
                    closest: () => null,
                    querySelector: () => null,
                    querySelectorAll: () => []
                };
                titleTextNode.parentElement = linkEl;

                global.document = {
                    head: { append() {} },
                    body: {},
                    documentElement: { appendChild() {} },
                    createElement: () => ({ id: '', textContent: '', dataset: {}, style: {}, append() {}, remove() {}, addEventListener() {}, removeAttribute() {}, querySelectorAll: () => [] }),
                    querySelector: () => null,
                    querySelectorAll: sel => (sel === 'a[href]' ? [linkEl] : []),
                    createTreeWalker: root => {
                        let yielded = false;
                        return {
                            nextNode() {
                                if (!yielded && root === linkEl) {
                                    yielded = true;
                                    return titleTextNode;
                                }
                                return null;
                            }
                        };
                    }
                };
                global.window = {
                    location: global.location,
                    sessionStorage: { getItem: () => null, setItem: () => {} },
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    setInterval: () => 888,
                    clearInterval: () => {}
                };

                const tStatus = installAgyPlusThoughtTranslations(
                    {},
                    { 'Refactor context window ring colors': '重构上下文窗口圆环配色' },
                    { thoughtTranslation: true, titleTranslation: true }
                );
                assert.equal(tStatus.version, 7);
                assert.equal(titleTextNode.nodeValue, '重构上下文窗口圆环配色');

                // Live disable titleTranslation -> restores original English title immediately
                global.window.__agyPlusThoughtUI.setFeatures({ titleTranslation: false });
                assert.equal(titleTextNode.nodeValue, 'Refactor context window ring colors');

                // Live re-enable titleTranslation -> re-applies cached Chinese title
                global.window.__agyPlusThoughtUI.setFeatures({ titleTranslation: true });
                assert.equal(titleTextNode.nodeValue, '重构上下文窗口圆环配色');

                const navStatus = installAgyPlusNavigationGestures({ enabled: true });
                assert.equal(navStatus.version, 2);
                assert.equal(navStatus.currentKey, '/c/conv-alpha');

                global.history.pushState(null, '', '/c/conv-beta');
                assert.equal(global.window.__agyPlusNavUI.canGoBack(), true);

                const disabledNav = global.window.__agyPlusNavUI.setEnabled(false);
                assert.equal(disabledNav.enabled, false);
                const blockedRes = await global.window.__agyPlusNavUI.navigate('back');
                assert.equal(blockedRes.navigated, false);
                assert.equal(blockedRes.reason, 'disabled');

                global.window.__agyPlusNavUI.dispose();
                global.window.__agyPlusThoughtUI.dispose();
            } finally {
                global.window = origWin;
                global.document = origDoc;
                global.location = origLoc;
                global.history = origHist;
                global.MutationObserver = origMut;
                global.NodeFilter = origNf;
                global.innerWidth = origIw;
                global.innerHeight = origIh;
            }
        });

        await step('13. zero-Node full round-trip: Install.ps1 -> Manage.ps1 -> Stop Hook -> Uninstall.ps1 on real Antigravity.exe', async () => {
            const realAgyDir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity');
            const realAgyExe = path.join(realAgyDir, 'Antigravity.exe');
            const realAsarSrc = fs.existsSync(path.join(realAgyDir, 'resources', 'app.real.asar'))
                ? path.join(realAgyDir, 'resources', 'app.real.asar')
                : path.join(realAgyDir, 'resources', 'app.asar');
            if (!fs.existsSync(realAgyExe) || !fs.existsSync(realAsarSrc)) {
                return;
            }

            const sandboxDir = path.join(tmpBase, 'zero-node-中文路径e2e');
            const mockAgyRoot = path.join(sandboxDir, 'Programs', 'antigravity');
            const mockResources = path.join(mockAgyRoot, 'resources');
            const mockInstallRoot = path.join(sandboxDir, 'AntigravityPlus');
            const mockGeminiCfg = path.join(sandboxDir, 'gemini-config');
            fs.mkdirSync(mockResources, { recursive: true });

            // Copy official ASAR (or build small mock ASAR) and hardlink/copy official Antigravity.exe + Electron runtime
            const asarBuf = buildMockAsarBuffer({
                'package.json': JSON.stringify({ name: 'antigravity', version: '2.35.1', main: 'dist/main.js' })
            });
            const targetAsar = path.join(mockResources, 'app.asar');
            fs.writeFileSync(targetAsar, asarBuf);
            const expectedSha = crypto.createHash('sha256').update(asarBuf).digest('hex');

            // Point receipt/fallback to real Antigravity.exe while isolating resourcesDir, InstallRoot & GeminiConfigDir
            const zeroNodeEnv = {
                ...process.env,
                AGY_FORCE_ELECTRON_NODE: '1',
                AGY_EXE_PATH: realAgyExe
            };
            delete zeroNodeEnv.PSModulePath;

            const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            const installRes = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', mockInstallRoot,
                '-AntigravityResourcesDir', mockResources,
                '-GeminiConfigDir', mockGeminiCfg,
                '-SkipRegistryRun',
                '-SkipScheduledTask',
                '-NoStartWatcher'
            ], { encoding: 'utf8', env: zeroNodeEnv, windowsHide: true, timeout: 45000 });
            assert.equal(installRes.status, 0, `Zero-Node Install.ps1 failed:\n${installRes.stdout}\n${installRes.stderr}`);
            assert.equal(fs.existsSync(path.join(mockResources, 'app.real.asar')), true);
            assert.equal(fs.existsSync(path.join(mockInstallRoot, 'bin', 'TaskToastHost.exe')), true);
            assert.equal(fs.existsSync(path.join(mockGeminiCfg, 'rules', 'agy-plus-chinese-execution.md')), true);

            // Manage.ps1 config readback under zero-Node mode (GUI subsystem Antigravity.exe)
            const manageRes = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(mockInstallRoot, 'scripts', 'Manage.ps1'),
                '-InstallRoot', mockInstallRoot,
                'config'
            ], { encoding: 'utf8', env: zeroNodeEnv, windowsHide: true, timeout: 15000 });
            assert.equal(manageRes.status, 0, `Zero-Node Manage.ps1 failed:\n${manageRes.stderr}`);
            const parsedCfg = JSON.parse(manageRes.stdout.trim());
            assert.equal(parsedCfg.config.features.contextRing, true);

            // Stop Hook hooks.json command execution under zero-Node mode (simulating language_server hook runner)
            const pluginDir = path.join(mockGeminiCfg, 'plugins', 'task-completion-toast');
            const rawCmdBytes = fs.readFileSync(path.join(pluginDir, 'run-on-stop.cmd'), 'utf8');
            assert.equal(/(?<!\r)\n/.test(rawCmdBytes), false, 'run-on-stop.cmd must use CRLF line endings for cmd.exe multibyte safety');
            const hooksCfg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks.json'), 'utf8'));
            const hookCmd = hooksCfg['task-completion-toast'].Stop[0].command;
            const hookRes = cp.spawnSync('cmd.exe', ['/d', '/c', hookCmd], {
                cwd: pluginDir,
                input: JSON.stringify({ hookEventName: 'PreToolUse' }),
                encoding: 'utf8',
                env: zeroNodeEnv,
                windowsHide: true,
                timeout: 15000
            });
            assert.equal(hookRes.status, 0, `Zero-Node Stop Hook failed:\n${hookRes.stderr}`);
            assert.match(hookRes.stdout, /"decision":"allow"/);

            // Uninstall.ps1 under zero-Node mode & verify byte-for-byte ASAR restoration
            const uninstallRes = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(mockInstallRoot, 'scripts', 'Uninstall.ps1'),
                '-InstallRoot', mockInstallRoot,
                '-AntigravityResourcesDir', mockResources,
                '-GeminiConfigDir', mockGeminiCfg,
                '-SkipSystemRegistration'
            ], { encoding: 'utf8', env: zeroNodeEnv, windowsHide: true, timeout: 30000 });
            assert.equal(uninstallRes.status, 0, `Zero-Node Uninstall.ps1 failed:\n${uninstallRes.stdout}\n${uninstallRes.stderr}`);
            assert.equal(fs.existsSync(targetAsar), true);
            assert.equal(fs.existsSync(path.join(mockResources, 'app')), false);
            const restoredSha = crypto.createHash('sha256').update(fs.readFileSync(targetAsar)).digest('hex');
            assert.equal(restoredSha, expectedSha, 'Restored app.asar SHA-256 must match pre-install archive');
        });

        await step('14. post-update-relaunch & patch safety: guard-first race zero-timeout & unknown shim protection', async () => {
            const raceInstall = path.join(tmpBase, 'race-install');
            const raceResources = path.join(tmpBase, 'race-resources');
            fs.mkdirSync(path.join(raceInstall, 'src', 'core'), { recursive: true });
            for (const f of ['config-manager.cjs', 'node-runner.cjs', 'patch-antigravity.cjs', 'post-update-relaunch.cjs', 'runtime.cjs']) {
                fs.copyFileSync(path.join(repoRoot, 'src', 'core', f), path.join(raceInstall, 'src', 'core', f));
            }
            fs.mkdirSync(raceResources, { recursive: true });
            const asarBuf = buildMockAsarBuffer({
                'package.json': JSON.stringify({ name: 'antigravity', version: '2.36.0', main: 'dist/main.js' })
            });
            fs.writeFileSync(path.join(raceResources, 'app.asar'), asarBuf);

            // Simulate scheduled guard completing the shim BEFORE post-update-relaunch checks app.asar
            patchManager.applyShim(raceResources, { installRoot: raceInstall });
            assert.equal(fs.existsSync(path.join(raceResources, 'app.asar')), false);

            const t0 = Date.now();
            const helperRes = cp.spawnSync(process.execPath, [
                path.join(raceInstall, 'src', 'core', 'post-update-relaunch.cjs'),
                '--parent-pid', '0',
                '--installer-pid', '0',
                '--skip-tasklist',
                '--relaunch', '0',
                '--timeout-ms', '8000',
                '--resources-dir', raceResources
            ], {
                encoding: 'utf8',
                env: { ...process.env, AGY_PLUS_ROOT: raceInstall },
                windowsHide: true,
                timeout: 10000
            });
            const elapsed = Date.now() - t0;
            assert.equal(helperRes.status, 0);
            assert.ok(elapsed < 4000, `post-update-relaunch should return immediately when guard already patched, took ${elapsed}ms`);

            // With --prev-version & --prev-real-snap matching the OLD pre-update app.real.asar,
            // post-update-relaunch must NOT treat the unchanged old shim as "alreadyPatchedByGuard"
            const oldRealStat = fs.statSync(path.join(raceResources, 'app.real.asar'));
            const oldRealSnap = `${oldRealStat.size}:${Math.floor(oldRealStat.mtimeMs)}`;
            const waitNewHelper = cp.spawnSync(process.execPath, [
                path.join(raceInstall, 'src', 'core', 'post-update-relaunch.cjs'),
                '--parent-pid', '0',
                '--installer-pid', '0',
                '--skip-tasklist',
                '--relaunch', '0',
                '--timeout-ms', '700',
                '--poll-ms', '150',
                '--prev-version', '2.36.0',
                '--prev-real-snap', oldRealSnap,
                '--resources-dir', raceResources
            ], {
                encoding: 'utf8',
                env: { ...process.env, AGY_PLUS_ROOT: raceInstall },
                windowsHide: true,
                timeout: 8000
            });
            assert.notEqual(waitNewHelper.status, 0, 'post-update-relaunch must NOT return 0 early when pre-update baseline matches unchanged old app.real.asar');

            // Unknown third-party resources/app/index.js should NOT be blindly overwritten without --force
            const foreignResources = path.join(tmpBase, 'foreign-resources');
            fs.mkdirSync(path.join(foreignResources, 'app'), { recursive: true });
            fs.writeFileSync(path.join(foreignResources, 'app.real.asar'), asarBuf);
            fs.writeFileSync(path.join(foreignResources, 'app', 'index.js'), '// OTHER_TOOL_SHIM\n', 'utf8');
            assert.throws(
                () => patchManager.applyShim(foreignResources, { installRoot: raceInstall }),
                /Refusing to overwrite unrecognized/i
            );
        });

        await step('15. fault-injection safety: preflight rollback, foreign file guard, staged ENOENT, >26k offline batch & cache isolation', async () => {
            const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            const cleanEnv = { ...process.env };
            delete cleanEnv.PSModulePath;

            // A) P0: Pre-flight rejection on legacy shim WITHOUT -CleanLegacy must NOT touch old hooks.json or write config.json
            const pfBase = path.join(tmpBase, 'preflight-guard');
            const pfResources = path.join(pfBase, 'resources');
            const pfInstall = path.join(pfBase, 'InstallTarget');
            const pfGemini = path.join(pfBase, 'gemini-cfg');
            const oldHookDir = path.join(pfGemini, 'plugins', 'task-completion-toast');
            fs.mkdirSync(path.join(pfResources, 'app'), { recursive: true });
            fs.mkdirSync(oldHookDir, { recursive: true });
            const asarBuf = buildMockAsarBuffer({
                'package.json': JSON.stringify({ name: 'antigravity', version: '2.35.1', main: 'dist/main.js' }),
                'dist/main.js': 'module.exports = { ok: "stock_entry" };'
            });
            fs.writeFileSync(path.join(pfResources, 'app.real.asar'), asarBuf);
            fs.writeFileSync(path.join(pfResources, 'app', 'index.js'), '/* ANTIGRAVITY_NATIVE_SHIM_V3 */\n', 'utf8');
            const sentinelHooks = '{"sentinel":"OLD_USER_HOOK_DO_NOT_OVERWRITE"}\n';
            fs.writeFileSync(path.join(oldHookDir, 'hooks.json'), sentinelHooks, 'utf8');

            const blockedInstall = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', pfInstall,
                '-AntigravityResourcesDir', pfResources,
                '-GeminiConfigDir', pfGemini,
                '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
            assert.notEqual(blockedInstall.status, 0, 'Install without -CleanLegacy must reject legacy shim');
            assert.equal(fs.readFileSync(path.join(oldHookDir, 'hooks.json'), 'utf8'), sentinelHooks, 'Old hooks.json must remain untouched');
            assert.equal(fs.existsSync(path.join(pfInstall, 'config.json')), false, 'config.json must not be written when preflight fails');
            assert.equal(fs.existsSync(path.join(pfInstall, 'install-receipt.json')), false, 'install-receipt.json must not exist');

            // B) P0: removeShim & Uninstall.ps1 must NEVER delete foreign files inside resources/app or non-Plus InstallRoot
            const unownedRes = path.join(tmpBase, 'unowned-res');
            const unownedInstall = path.join(tmpBase, 'unowned-install');
            fs.mkdirSync(unownedRes, { recursive: true });
            fs.mkdirSync(path.join(unownedInstall, 'src', 'core'), { recursive: true });
            fs.copyFileSync(path.join(repoRoot, 'src', 'core', 'runtime.cjs'), path.join(unownedInstall, 'src', 'core', 'runtime.cjs'));
            fs.writeFileSync(path.join(unownedRes, 'app.asar'), asarBuf);
            patchManager.applyShim(unownedRes, { installRoot: unownedInstall });
            const extraUserFile = path.join(unownedRes, 'app', 'user-extra.txt');
            fs.writeFileSync(extraUserFile, 'do not delete me', 'utf8');
            const refusedCode = patchManager.removeShim(unownedRes, unownedInstall);
            assert.equal(refusedCode, 2, 'removeShim must return code 2 when foreign files exist in resources/app');
            assert.equal(fs.existsSync(extraUserFile), true, 'Foreign file in resources/app must survive removeShim');

            const foreignFolder = path.join(tmpBase, 'user-precious-folder');
            fs.mkdirSync(foreignFolder, { recursive: true });
            fs.writeFileSync(path.join(foreignFolder, 'important.txt'), 'keep', 'utf8');
            const refusedUninstall = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Uninstall.ps1'),
                '-InstallRoot', foreignFolder,
                '-AntigravityResourcesDir', unownedRes,
                '-GeminiConfigDir', pfGemini,
                '-SkipSystemRegistration'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
            assert.notEqual(refusedUninstall.status, 0, 'Uninstall.ps1 must fail on unowned InstallRoot');
            assert.equal(fs.existsSync(path.join(foreignFolder, 'important.txt')), true);

            const siblingOfflineRepo = path.resolve(repoRoot, '..', 'antigravity-offline-translator');
            if (fs.existsSync(siblingOfflineRepo)) {
                const refusedOffUninstall = cp.spawnSync(psExe, [
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(siblingOfflineRepo, 'scripts', 'Uninstall.ps1'),
                    '-InstallDir', foreignFolder
                ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
                assert.notEqual(refusedOffUninstall.status, 0, 'Offline Uninstall.ps1 must fail on unowned InstallDir');
                assert.equal(fs.existsSync(path.join(foreignFolder, 'important.txt')), true);

                // Smoke test with explicit non-existent --install-dir must FAIL (no silent fallback)
                const badSmoke = cp.spawnSync(process.execPath, [
                    path.join(siblingOfflineRepo, 'tests', 'smoke-test.cjs'),
                    '--install-dir', path.join(tmpBase, 'definitely-missing-dir')
                ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
                assert.notEqual(badSmoke.status, 0, 'smoke-test.cjs must fail when explicit --install-dir is missing');

                // setup_model.py must reject fake plain-text model files instead of returning 0 with official SHA-256
                const venvPy = 'D:\\DevTools\\AntigravityTranslator\\venv\\Scripts\\python.exe';
                if (fs.existsSync(venvPy)) {
                    const fakeModelRoot = path.join(tmpBase, 'fake-model-dir');
                    const fakeInner = path.join(fakeModelRoot, 'model-package', 'fake', 'model');
                    fs.mkdirSync(fakeInner, { recursive: true });
                    fs.writeFileSync(path.join(fakeModelRoot, 'model-package', 'fake', 'sentencepiece.model'), 'plain text fake', 'utf8');
                    fs.writeFileSync(path.join(fakeInner, 'model.bin'), 'plain text fake bin', 'utf8');
                    // Verify both find_existing_model rejection AND full CLI non-zero exit when fake files exist and download fails
                    const pyVerify = cp.spawnSync(venvPy, [
                        '-B',
                        '-c',
                        [
                            `import sys, pathlib; sys.path.insert(0, ${JSON.stringify(path.join(siblingOfflineRepo, 'scripts'))});`,
                            `import setup_model;`,
                            `assert setup_model.find_existing_model(pathlib.Path(${JSON.stringify(path.join(fakeModelRoot, 'model-package'))})) is None;`,
                            `setup_model.MODEL_URL = 'http://127.0.0.1:1/nonexistent.argosmodel';`,
                            `sys.argv = ['setup_model.py', '--install-dir', ${JSON.stringify(fakeModelRoot)}, '--proxy', ''];`,
                            `ok = False`,
                            `try: setup_model.main()`,
                            `except Exception: ok = True`,
                            `assert ok, 'setup_model.main() must fail when existing files are fake'`
                        ].join('\n')
                    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
                    assert.equal(pyVerify.status, 0, `setup_model fake-file rejection failed: ${pyVerify.stderr}`);
                }
            }

            // C) P1: Staged shim startup when ONLY app.asar exists (no app.real.asar) + empty dir post-update-relaunch failure
            const stagedDir = path.join(tmpBase, 'staged-only-asar');
            fs.mkdirSync(path.join(stagedDir, 'app'), { recursive: true });
            const plainFolderAsar = path.join(stagedDir, 'app.asar');
            fs.mkdirSync(path.join(plainFolderAsar, 'dist'), { recursive: true });
            fs.writeFileSync(path.join(plainFolderAsar, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.35.1', main: 'dist/main.js' }), 'utf8');
            fs.writeFileSync(path.join(plainFolderAsar, 'dist', 'main.js'), 'module.exports = { bootedFromStaged: true };', 'utf8');
            fs.writeFileSync(path.join(stagedDir, 'app', 'index.js'), patchManager.buildShimIndexJs(path.join(tmpBase, 'non-existent-rt.cjs')), 'utf8');
            // Lock rename so it exercises the fallback to stock app.asar without ENOENT
            const loadedStaged = cp.spawnSync(process.execPath, [
                '-e',
                `const m = require(${JSON.stringify(path.join(stagedDir, 'app', 'index.js'))}); if (!m || !m.bootedFromStaged) process.exit(2);`
            ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
            assert.equal(loadedStaged.status, 0, `Staged shim index.js failed when only app.asar existed: ${loadedStaged.stderr}`);

            const emptyResDir = path.join(tmpBase, 'empty-resources-dir');
            fs.mkdirSync(emptyResDir, { recursive: true });
            const emptyUpdateInstall = path.join(tmpBase, 'empty-update-install');
            fs.mkdirSync(emptyUpdateInstall, { recursive: true });
            const badHelper = cp.spawnSync(process.execPath, [
                path.join(repoRoot, 'src', 'core', 'post-update-relaunch.cjs'),
                '--parent-pid', '0', '--installer-pid', '0', '--skip-tasklist', '--relaunch', '0',
                '--timeout-ms', '600', '--poll-ms', '150', '--resources-dir', emptyResDir
            ], {
                encoding: 'utf8',
                env: { ...cleanEnv, AGY_PLUS_ROOT: emptyUpdateInstall },
                windowsHide: true,
                timeout: 8000
            });
            assert.notEqual(badHelper.status, 0, 'post-update-relaunch must return non-zero when archive is missing');
            const patchLogPath = path.join(emptyUpdateInstall, 'logs', 'patch.log');
            if (fs.existsSync(patchLogPath)) {
                assert.equal(fs.readFileSync(patchLogPath, 'utf8').includes('Rebuilt shim'), false);
            }

            // D) P1: >26,460 chars offline batch chunking + hybrid->online cache isolation
            translator.resetCooldowns();
            translator.clearCache();
            const mockOffDir = path.join(tmpBase, 'mock-offline-pkg');
            fs.mkdirSync(mockOffDir, { recursive: true });
            const mockWorkerJs = path.join(mockOffDir, 'worker.cjs');
            fs.writeFileSync(mockWorkerJs, [
                "const rl = require('node:readline').createInterface({ input: process.stdin });",
                "rl.on('line', line => {",
                "  const req = JSON.parse(line);",
                "  const total = req.texts.reduce((s, t) => s + t.length, 0);",
                "  if (req.texts.length > 80 || total > 24000) {",
                "    console.log(JSON.stringify({ id: req.id, error: 'ValueError' }));",
                "    return;",
                "  }",
                "  console.log(JSON.stringify({ id: req.id, texts: req.texts.map(t => '离线译文:' + t.slice(0, 12)), elapsedMs: 5 }));",
                "});"
            ].join('\n'), 'utf8');
            const dummyModelDir = path.join(mockOffDir, 'model');
            fs.mkdirSync(dummyModelDir, { recursive: true });
            fs.writeFileSync(path.join(mockOffDir, 'deployment.json'), JSON.stringify({
                resourceHost: process.execPath,
                python: mockWorkerJs,
                worker: mockWorkerJs,
                modelRoot: dummyModelDir
            }), 'utf8');

            const hugeBatch = Array.from({ length: 60 }, (_, i) => ` Inspecting module ${i} with detailed configuration parameters ` + 'x'.repeat(400));
            const totalChars = hugeBatch.reduce((s, t) => s + t.length, 0);
            assert.ok(totalChars > 26460, 'Synthetic batch must exceed 26,460 chars');
            const hugeOut = await translator.translate(hugeBatch, {
                installRoot: mockOffDir,
                mode: 'offline',
                offlineRoot: mockOffDir
            });
            assert.equal(hugeOut.length, 60);
            assert.ok(hugeOut.every(x => x.trim().startsWith('离线译文:')));

            // Hybrid offline fallback -> switch to online must NOT hit offline cache
            const sampleSentence = 'Verifying cross-mode translation cache isolation behavior';
            const alwaysFailOnline = async () => { throw new Error('Simulated offline network'); };
            const hybOffOut = await translator.translate([sampleSentence], {
                installRoot: mockOffDir,
                mode: 'hybrid',
                offlineRoot: mockOffDir,
                requestFn: alwaysFailOnline
            });
            assert.match(hybOffOut[0], /^离线译文:/);

            translator.resetCooldowns();
            let onlineCalls = 0;
            const succeedOnline = async () => {
                onlineCalls++;
                return { status: 200, headers: {}, body: JSON.stringify(['在线高质量译文']) };
            };
            const onlineOut = await translator.translate([sampleSentence], {
                installRoot: mockOffDir,
                mode: 'online',
                offlineRoot: mockOffDir,
                requestFn: succeedOnline
            });
            assert.ok(onlineCalls > 0, 'Switching to online mode must issue real online request instead of reusing offline cache');
            assert.equal(onlineOut[0], '在线高质量译文');
            translator.dispose();
            translator.clearCache();
        });

        await step('16. cross-install binding, legacy backup restore, offline foreign-file guard, atomic reinstall, CN-path worker & hot-switch', async () => {
            const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            const cleanEnv = { ...process.env };
            delete cleanEnv.PSModulePath;
            const asarBuf = buildMockAsarBuffer({
                'package.json': JSON.stringify({ name: 'antigravity', version: '2.35.1', main: 'dist/main.js' }),
                'dist/main.js': 'module.exports = { ok: true };'
            });

            // A) P0: Wrong -InstallRoot (contains foreign src/) + empty -AntigravityResourcesDir must fail with 0 deletions
            const badBase = path.join(tmpBase, 'bad-install-paths');
            const foreignRootWithSrc = path.join(badBase, 'foreign-proj');
            const foreignSrcFile = path.join(foreignRootWithSrc, 'src', 'keep-me.txt');
            const emptyRes = path.join(badBase, 'empty-res');
            const validRes = path.join(badBase, 'valid-res');
            const freshRoot = path.join(badBase, 'fresh-root');
            const badGemini = path.join(badBase, 'gemini');
            fs.mkdirSync(path.dirname(foreignSrcFile), { recursive: true });
            fs.mkdirSync(emptyRes, { recursive: true });
            fs.mkdirSync(validRes, { recursive: true });
            fs.writeFileSync(foreignSrcFile, 'USER_PRECIOUS_SRC', 'utf8');
            fs.writeFileSync(path.join(validRes, 'app.asar'), asarBuf);

            // Case A1: foreign InstallRoot + empty resources
            const bad1 = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', foreignRootWithSrc,
                '-AntigravityResourcesDir', emptyRes,
                '-GeminiConfigDir', badGemini,
                '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
            assert.notEqual(bad1.status, 0, 'Install must fail on empty resources + foreign InstallRoot');
            assert.equal(fs.readFileSync(foreignSrcFile, 'utf8'), 'USER_PRECIOUS_SRC', 'Foreign src/ must survive failed install');
            assert.equal(fs.existsSync(path.join(foreignRootWithSrc, 'install-receipt.json')), false);

            // Case A2: fresh InstallRoot + empty resources must fail (no patchState=skipped exit 0)
            const bad2 = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', freshRoot,
                '-AntigravityResourcesDir', emptyRes,
                '-GeminiConfigDir', badGemini,
                '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
            assert.notEqual(bad2.status, 0, 'Install must reject empty AntigravityResourcesDir by default');
            assert.equal(fs.existsSync(path.join(freshRoot, 'install-receipt.json')), false);

            // Case A3: foreign InstallRoot + valid resources must also fail without deleting foreign src/
            const bad3 = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', foreignRootWithSrc,
                '-AntigravityResourcesDir', validRes,
                '-GeminiConfigDir', badGemini,
                '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
            assert.notEqual(bad3.status, 0, 'Install must refuse overwriting foreign non-empty InstallRoot');
            assert.equal(fs.readFileSync(foreignSrcFile, 'utf8'), 'USER_PRECIOUS_SRC', 'Foreign src/ must remain intact');

            // B) P0: Cross-installation A/B uninstall binding protection (Uninstall.ps1 + patch-antigravity.cjs)
            const dualBase = path.join(tmpBase, 'dual-install');
            const rootA = path.join(dualBase, 'plus-A');
            const resA = path.join(dualBase, 'res-A');
            const gemA = path.join(dualBase, 'gem-A');
            const rootB = path.join(dualBase, 'plus-B');
            const resB = path.join(dualBase, 'res-B');
            const gemB = path.join(dualBase, 'gem-B');
            fs.mkdirSync(resA, { recursive: true });
            fs.mkdirSync(resB, { recursive: true });
            fs.writeFileSync(path.join(resA, 'app.asar'), asarBuf);
            fs.writeFileSync(path.join(resB, 'app.asar'), asarBuf);

            for (const [r, res, gem] of [[rootA, resA, gemA], [rootB, resB, gemB]]) {
                const inst = cp.spawnSync(psExe, [
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                    '-InstallRoot', r,
                    '-AntigravityResourcesDir', res,
                    '-GeminiConfigDir', gem,
                    '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
                ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 45000 });
                assert.equal(inst.status, 0, `Dual install failed: ${inst.stdout}\n${inst.stderr}`);
            }

            // Passing InstallRoot A with ResourcesDir B must FAIL and leave both A and B intact
            const crossUninst = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(rootA, 'scripts', 'Uninstall.ps1'),
                '-InstallRoot', rootA,
                '-AntigravityResourcesDir', resB,
                '-GeminiConfigDir', gemA,
                '-SkipSystemRegistration'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
            assert.notEqual(crossUninst.status, 0, 'Cross-install Uninstall.ps1(A, resB) must be refused');
            assert.equal(fs.existsSync(path.join(rootA, 'install-receipt.json')), true, 'Install A runtime must stay intact');
            assert.equal(fs.existsSync(path.join(resA, 'app', 'index.js')), true, 'Install A shim must stay intact');
            assert.equal(fs.existsSync(path.join(resB, 'app.real.asar')), true, 'Install B archive must not be restored by A');
            assert.equal(fs.existsSync(path.join(resB, 'app', 'index.js')), true, 'Install B shim must not be removed by A');

            // Direct removeShim(resB, rootA) must also refuse with exit code 2
            assert.equal(patchManager.removeShim(resB, rootA), 2, 'patchManager.removeShim(resB, rootA) must refuse mismatched installRoot');
            assert.equal(fs.existsSync(path.join(resB, 'app', 'index.js')), true);

            // Properly uninstall A and B without passing explicit -AntigravityResourcesDir (auto-bound from receipt)
            for (const [r, res] of [[rootA, resA], [rootB, resB]]) {
                const okUn = cp.spawnSync(psExe, [
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(r, 'scripts', 'Uninstall.ps1'),
                    '-InstallRoot', r,
                    '-SkipSystemRegistration'
                ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 25000 });
                assert.equal(okUn.status, 0, `Matched uninstall failed: ${okUn.stdout}\n${okUn.stderr}`);
                assert.equal(fs.existsSync(path.join(res, 'app.asar')), true);
                assert.equal(fs.existsSync(path.join(res, 'app')), false);
                assert.equal(fs.existsSync(r), false, 'Empty InstallRoot must be completely removed after matched uninstall');
            }

            // C) P0: -CleanLegacy migration -> default Uninstall.ps1 must restore old plugin & rules AND keep backup/ + user files
            const legBase = path.join(tmpBase, 'legacy-roundtrip');
            const legInstall = path.join(legBase, 'AntigravityPlus');
            const legRes = path.join(legBase, 'resources');
            const legGem = path.join(legBase, 'gemini');
            const legPluginDir = path.join(legGem, 'plugins', 'task-completion-toast');
            const legRulesDir = path.join(legGem, 'rules');
            fs.mkdirSync(path.join(legRes, 'app'), { recursive: true });
            fs.mkdirSync(legPluginDir, { recursive: true });
            fs.mkdirSync(legRulesDir, { recursive: true });
            fs.writeFileSync(path.join(legRes, 'app.real.asar'), asarBuf);
            fs.writeFileSync(path.join(legRes, 'app', 'index.js'), '/* ANTIGRAVITY_NATIVE_SHIM_V3 */\n// legacy-shim-sentinel\n', 'utf8');
            fs.writeFileSync(path.join(legPluginDir, 'hooks.json'), '{"legacy":"TOAST_SENTINEL"}\n', 'utf8');
            fs.writeFileSync(path.join(legRulesDir, 'derrick-chinese-execution.md'), '# OLD_CHINESE_RULE\n', 'utf8');
            fs.writeFileSync(path.join(legRulesDir, 'workspace-local-scripts.md'), '# OLD_SCRIPTS_RULE\n', 'utf8');

            const legInst = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', legInstall,
                '-AntigravityResourcesDir', legRes,
                '-GeminiConfigDir', legGem,
                '-CleanLegacy',
                '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 45000 });
            assert.equal(legInst.status, 0, `-CleanLegacy install failed: ${legInst.stdout}\n${legInst.stderr}`);
            assert.equal(fs.existsSync(path.join(legInstall, 'backup', 'legacy-plugin-task-completion-toast', 'hooks.json')), true);
            assert.equal(fs.existsSync(path.join(legInstall, 'backup', 'legacy-rules', 'derrick-chinese-execution.md')), true);
            assert.equal(fs.existsSync(path.join(legInstall, 'backup', 'legacy-shim-app', 'index.js')), true);

            // Drop an unrelated user file inside legInstall to confirm default uninstall never deletes unknown user files
            const userFileInInstall = path.join(legInstall, 'my-personal-note.txt');
            fs.writeFileSync(userFileInInstall, 'KEEP_MY_NOTE', 'utf8');

            const legUninst = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(legInstall, 'scripts', 'Uninstall.ps1'),
                '-InstallRoot', legInstall,
                '-AntigravityResourcesDir', legRes,
                '-GeminiConfigDir', legGem,
                '-SkipSystemRegistration'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 25000 });
            assert.equal(legUninst.status, 0, `Default uninstall after -CleanLegacy failed: ${legUninst.stdout}\n${legUninst.stderr}`);
            assert.equal(fs.existsSync(path.join(legRes, 'app.asar')), true, 'Official app.asar must be restored');
            assert.equal(fs.existsSync(path.join(legRes, 'app')), false, 'Shim app dir must be removed');
            assert.equal(fs.readFileSync(path.join(legPluginDir, 'hooks.json'), 'utf8'), '{"legacy":"TOAST_SENTINEL"}\n', 'Old plugin must be automatically restored');
            assert.equal(fs.readFileSync(path.join(legRulesDir, 'derrick-chinese-execution.md'), 'utf8'), '# OLD_CHINESE_RULE\n', 'Old chinese rule must be automatically restored');
            assert.equal(fs.readFileSync(path.join(legRulesDir, 'workspace-local-scripts.md'), 'utf8'), '# OLD_SCRIPTS_RULE\n', 'Old scripts rule must be automatically restored');
            assert.equal(fs.existsSync(path.join(legInstall, 'backup', 'legacy-plugin-task-completion-toast', 'hooks.json')), true, 'Backup directory must survive default uninstall');
            assert.equal(fs.existsSync(path.join(legInstall, 'backup', 'legacy-shim-app', 'index.js')), true, 'Legacy shim backup must survive default uninstall');
            assert.equal(fs.readFileSync(userFileInInstall, 'utf8'), 'KEEP_MY_NOTE', 'Unrelated user file in InstallRoot must survive default uninstall');
            assert.equal(fs.existsSync(path.join(legInstall, 'src')), false, 'Plus runtime src/ must be cleaned');

            // D) P0: Offline Uninstall.ps1 with valid deployment.json must preserve unrelated user files inside the same directory
            const siblingOfflineRepo = path.resolve(repoRoot, '..', 'antigravity-offline-translator');
            if (fs.existsSync(siblingOfflineRepo)) {
                const offMixedDir = path.join(tmpBase, 'offline-with-user-files');
                fs.mkdirSync(path.join(offMixedDir, 'venv'), { recursive: true });
                fs.mkdirSync(path.join(offMixedDir, 'model-package'), { recursive: true });
                fs.mkdirSync(path.join(offMixedDir, 'my-user-folder'), { recursive: true });
                fs.writeFileSync(path.join(offMixedDir, 'deployment.json'), JSON.stringify({
                    worker: path.join(offMixedDir, 'translation-worker.py'),
                    resourceHost: path.join(offMixedDir, 'ResourceHost.exe'),
                    modelRoot: path.join(offMixedDir, 'model-package')
                }), 'utf8');
                fs.writeFileSync(path.join(offMixedDir, 'translation-worker.py'), '# mock\n', 'utf8');
                fs.writeFileSync(path.join(offMixedDir, 'user-unrelated.txt'), 'DO_NOT_DELETE', 'utf8');
                fs.writeFileSync(path.join(offMixedDir, 'my-user-folder', 'data.txt'), 'SAFE', 'utf8');

                const isolatedLocalAppData = path.join(tmpBase, 'isolated-localappdata-s16');
                fs.mkdirSync(isolatedLocalAppData, { recursive: true });
                const offUnEnv = { ...cleanEnv, LOCALAPPDATA: isolatedLocalAppData };
                delete offUnEnv.AGY_PLUS_ROOT;
                const offUn = cp.spawnSync(psExe, [
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(siblingOfflineRepo, 'scripts', 'Uninstall.ps1'),
                    '-InstallDir', offMixedDir
                ], { encoding: 'utf8', env: offUnEnv, windowsHide: true, timeout: 15000 });
                assert.equal(offUn.status, 0, `Offline uninstall failed: ${offUn.stdout}\n${offUn.stderr}`);
                assert.equal(fs.existsSync(path.join(offMixedDir, 'deployment.json')), false, 'deployment.json must be removed');
                assert.equal(fs.existsSync(path.join(offMixedDir, 'venv')), false, 'venv must be removed');
                assert.equal(fs.existsSync(path.join(offMixedDir, 'model-package')), false, 'model-package must be removed');
                assert.equal(fs.readFileSync(path.join(offMixedDir, 'user-unrelated.txt'), 'utf8'), 'DO_NOT_DELETE', 'Unrelated file in offline InstallDir must survive');
                assert.equal(fs.readFileSync(path.join(offMixedDir, 'my-user-folder', 'data.txt'), 'utf8'), 'SAFE', 'Unrelated subfolder in offline InstallDir must survive');

                // E) P1: setup_model.py failed re-download preserves existing real model + Chinese path verification & real worker inference
                const realVenvPy = 'D:\\DevTools\\AntigravityTranslator\\venv\\Scripts\\python.exe';
                const realModelPkg = 'D:\\DevTools\\AntigravityTranslator\\model-package';
                if (fs.existsSync(realVenvPy) && fs.existsSync(realModelPkg)) {
                    const cnOfflineRoot = path.join(tmpBase, '中文离线目录测试', '模型根');
                    const cnModelPkg = path.join(cnOfflineRoot, 'model-package');
                    fs.cpSync(realModelPkg, cnModelPkg, { recursive: true });
                    // Find model root containing sentencepiece.model
                    let cnModelSub = '';
                    for (const ent of fs.readdirSync(cnModelPkg, { withFileTypes: true })) {
                        const cand = path.join(cnModelPkg, ent.name);
                        if (ent.isDirectory() && fs.existsSync(path.join(cand, 'sentencepiece.model'))) {
                            cnModelSub = cand;
                            break;
                        }
                    }
                    assert.ok(cnModelSub, 'Copied real model must contain sentencepiece.model');

                    // 1. Force re-download failure must keep existing model-package intact
                    // 2. find_existing_model must succeed on Chinese path
                    const pyAtomicCheck = cp.spawnSync(realVenvPy, [
                        '-B',
                        '-c',
                        [
                            `import sys, pathlib; sys.path.insert(0, ${JSON.stringify(path.join(siblingOfflineRepo, 'scripts'))});`,
                            `import setup_model;`,
                            `found_before = setup_model.find_existing_model(pathlib.Path(${JSON.stringify(cnModelPkg)}))`,
                            `assert found_before is not None, 'find_existing_model must succeed on Chinese path'`,
                            `setup_model.MODEL_URL = 'http://127.0.0.1:1/unreachable.argosmodel'`,
                            `sys.argv = ['setup_model.py', '--install-dir', ${JSON.stringify(cnOfflineRoot)}, '--proxy', '', '--force-download']`,
                            `failed = False`,
                            `try: setup_model.main()`,
                            `except Exception: failed = True`,
                            `assert failed, 'force-download to unreachable URL must raise'`,
                            `found_after = setup_model.find_existing_model(pathlib.Path(${JSON.stringify(cnModelPkg)}))`,
                            `assert found_after is not None, 'existing working model must remain intact after failed reinstall'`
                        ].join('\n')
                    ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
                    assert.equal(pyAtomicCheck.status, 0, `Atomic reinstall / CN path check failed:\n${pyAtomicCheck.stderr}`);

                    // 3. Real translation-worker.py running directly on Chinese path modelRoot
                    const workerRes = cp.spawnSync(realVenvPy, [
                        '-B',
                        path.join(siblingOfflineRepo, 'src', 'translation-worker.py'),
                        cnModelSub
                    ], {
                        input: JSON.stringify({ id: 7, texts: ['Inspecting [C0] configuration on Chinese path.'] }) + '\n',
                        encoding: 'utf8',
                        env: { ...cleanEnv, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1' },
                        windowsHide: true,
                        timeout: 25000
                    });
                    assert.equal(workerRes.status, 0, `Chinese-path translation-worker.py failed:\n${workerRes.stderr}`);
                    const lines = workerRes.stdout.trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
                    const reply = lines.find(x => x.id === 7);
                    assert.ok(reply && Array.isArray(reply.texts) && /[\u3400-\u9fff]/.test(reply.texts[0]), `Unexpected worker reply: ${workerRes.stdout}`);
                }
            }

            // F) P1: Hot-switching offlineRoot A -> B without dispose() must restart child and use B immediately
            translator.dispose();
            translator.clearCache();
            const makeMockBackend = (name, prefix) => {
                const dir = path.join(tmpBase, `hot-switch-${name}`);
                fs.mkdirSync(dir, { recursive: true });
                const workerPath = path.join(dir, 'worker.cjs');
                fs.writeFileSync(workerPath, [
                    "const rl = require('node:readline').createInterface({ input: process.stdin });",
                    "rl.on('line', line => {",
                    "  const req = JSON.parse(line);",
                    `  console.log(JSON.stringify({ id: req.id, texts: req.texts.map(t => ${JSON.stringify(prefix)} + t), elapsedMs: 2 }));`,
                    "});"
                ].join('\n'), 'utf8');
                fs.writeFileSync(path.join(dir, 'deployment.json'), JSON.stringify({
                    resourceHost: process.execPath,
                    python: workerPath,
                    worker: workerPath,
                    modelRoot: dir
                }), 'utf8');
                return dir;
            };
            const dirA = makeMockBackend('A', '后端甲:');
            const dirB = makeMockBackend('B', '后端乙:');

            const outA = await translator.translate(['Testing offline engine hot switch first sentence'], {
                installRoot: dirA,
                mode: 'offline',
                offlineRoot: dirA,
                bypassCache: true
            });
            assert.match(outA[0], /^后端甲:/);

            // Switch immediately to B WITHOUT calling dispose() — both new sentence (bypassCache) AND same sentence (cache invalidation)
            const outBNew = await translator.translate(['Testing offline engine hot switch second sentence'], {
                installRoot: dirB,
                mode: 'offline',
                offlineRoot: dirB,
                bypassCache: true
            });
            assert.match(outBNew[0], /^后端乙:/, 'Hot-switching offlineRoot must stop old child A and spawn child B');

            const outBSame = await translator.translate(['Testing offline engine hot switch first sentence'], {
                installRoot: dirB,
                mode: 'offline',
                offlineRoot: dirB
            });
            assert.match(outBSame[0], /^后端乙:/, 'Switching offlineRoot must also invalidate stale offline cache from A');
            translator.dispose();
            translator.clearCache();
        });

        await step('17. CLI positional args, real PATH-empty Stop Hook, UTF-16LE VBS CN-path, required restore guard & offline cmd exit codes', async () => {
            const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            const cleanEnv = { ...process.env };
            delete cleanEnv.PSModulePath;
            const asarBuf = buildMockAsarBuffer({
                'package.json': JSON.stringify({ name: 'antigravity', version: '2.35.1', main: 'dist/main.js' }),
                'dist/main.js': 'module.exports = { ok: true };'
            });

            // A) Manage.ps1 & Manage.cmd WITHOUT -InstallRoot must execute CLI subcommands instead of falling into interactive menu
            const mgBase = path.join(tmpBase, 'manage-positional-中文');
            const mgInstall = path.join(mgBase, 'AntigravityPlus');
            const mgRes = path.join(mgBase, 'resources');
            const mgGem = path.join(mgBase, 'gemini');
            fs.mkdirSync(mgRes, { recursive: true });
            fs.writeFileSync(path.join(mgRes, 'app.asar'), asarBuf);
            const mgInstRes = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', mgInstall,
                '-AntigravityResourcesDir', mgRes,
                '-GeminiConfigDir', mgGem,
                '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 45000 });
            assert.equal(mgInstRes.status, 0, `Setup install for suite 17 failed: ${mgInstRes.stdout}\n${mgInstRes.stderr}`);

            // Invoke Manage.cmd directly with LOCALAPPDATA pointing to mgBase (no -InstallRoot flag!)
            const posEnv = { ...cleanEnv, LOCALAPPDATA: mgBase };
            const posCfg = cp.spawnSync('cmd.exe', ['/d', '/c', path.join(mgInstall, 'Manage.cmd'), 'config'], {
                encoding: 'utf8', env: posEnv, windowsHide: true, timeout: 15000
            });
            assert.equal(posCfg.status, 0, `Manage.cmd config failed:\n${posCfg.stdout}\n${posCfg.stderr}`);
            const parsedPos = JSON.parse(posCfg.stdout.trim());
            assert.equal(parsedPos.config.features.contextRing, true);

            const posSetOff = cp.spawnSync('cmd.exe', ['/d', '/c', path.join(mgInstall, 'Manage.cmd'), 'set-offline-root', 'D:\\CustomOfflineDir'], {
                encoding: 'utf8', env: posEnv, windowsHide: true, timeout: 15000
            });
            assert.equal(posSetOff.status, 0, `Manage.cmd set-offline-root failed:\n${posSetOff.stdout}\n${posSetOff.stderr}`);
            const afterSet = JSON.parse(posSetOff.stdout.trim());
            assert.equal(afterSet.config.translation.offlineRoot, 'D:\\CustomOfflineDir');

            const posInvalid = cp.spawnSync('cmd.exe', ['/d', '/c', path.join(mgInstall, 'Manage.cmd'), 'unknown-subcommand-xyz'], {
                encoding: 'utf8', env: posEnv, windowsHide: true, timeout: 15000
            });
            assert.notEqual(posInvalid.status, 0, 'Manage.cmd with unknown command must propagate non-zero exit code');

            // B) VBS files must be UTF-16 LE BOM (FF FE) + CRLF so wscript.exe handles Chinese paths without GBK corruption
            for (const vbsName of ['Start-Watcher.vbs', 'Ensure-Shim.vbs']) {
                const rawVbs = fs.readFileSync(path.join(mgInstall, 'bin', vbsName));
                assert.equal(rawVbs[0], 0xFF, `${vbsName} must start with UTF-16 LE BOM (0xFF)`);
                assert.equal(rawVbs[1], 0xFE, `${vbsName} must start with UTF-16 LE BOM (0xFE)`);
                const decodedVbs = rawVbs.slice(2).toString('utf16le');
                assert.ok(decodedVbs.includes('manage-positional-中文'), `${vbsName} must preserve Chinese install path cleanly`);
                assert.equal(/(?<!\r)\n/.test(decodedVbs), false, `${vbsName} must use CRLF line endings`);
            }

            // C) Real PATH-empty zero-Node execution of natively generated run-on-stop.cmd (WITHOUT AGY_FORCE_ELECTRON_NODE=1!)
            const realAgyExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'Antigravity.exe');
            if (fs.existsSync(realAgyExe)) {
                const pluginDir = path.join(mgGem, 'plugins', 'task-completion-toast');
                const cmdFile = path.join(pluginDir, 'run-on-stop.cmd');
                const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
                const strippedPathEnv = { ...cleanEnv, PATH: sys32, Path: sys32 };
                delete strippedPathEnv.AGY_FORCE_ELECTRON_NODE;
                const realNoNodeHook = cp.spawnSync(path.join(sys32, 'cmd.exe'), ['/d', '/c', cmdFile], {
                    cwd: pluginDir,
                    input: JSON.stringify({ hookEventName: 'PreToolUse' }),
                    encoding: 'utf8',
                    env: strippedPathEnv,
                    windowsHide: true,
                    timeout: 15000
                });
                assert.equal(realNoNodeHook.status, 0, `run-on-stop.cmd failed on real node-less PATH:\n${realNoNodeHook.stdout}\n${realNoNodeHook.stderr}`);
                assert.match(realNoNodeHook.stdout, /"decision":"allow"/);
            }

            // D) Uninstall.ps1 must fail non-zero (exit!=0) and keep files if patch-antigravity.cjs is missing (no silent exit 0!)
            const brokenPatchScript = path.join(mgInstall, 'src', 'core', 'patch-antigravity.cjs');
            const backupPatchContent = fs.readFileSync(brokenPatchScript);
            fs.unlinkSync(brokenPatchScript);
            try {
                const failUn = cp.spawnSync(psExe, [
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(mgInstall, 'scripts', 'Uninstall.ps1'),
                    '-InstallRoot', mgInstall,
                    '-AntigravityResourcesDir', mgRes,
                    '-GeminiConfigDir', mgGem,
                    '-SkipSystemRegistration'
                ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
                assert.notEqual(failUn.status, 0, 'Uninstall.ps1 must fail when patch-antigravity.cjs is missing');
                assert.equal(fs.existsSync(path.join(mgInstall, 'install-receipt.json')), true, 'InstallRoot must not be wiped when restore script is missing');
            } finally {
                fs.writeFileSync(brokenPatchScript, backupPatchContent);
            }

            // Clean up mgInstall via self-discovery (WITHOUT passing -InstallRoot while LOCALAPPDATA points elsewhere!)
            const unrelatedLocal = path.join(tmpBase, 'unrelated-localappdata');
            fs.mkdirSync(unrelatedLocal, { recursive: true });
            const selfManage = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(mgInstall, 'scripts', 'Manage.ps1'),
                'config'
            ], { encoding: 'utf8', env: { ...cleanEnv, LOCALAPPDATA: unrelatedLocal }, windowsHide: true, timeout: 15000 });
            assert.equal(selfManage.status, 0, `Self-discovered Manage.ps1 failed:\n${selfManage.stderr}`);
            assert.equal(
                path.resolve(JSON.parse(selfManage.stdout.trim()).installRoot).toLowerCase(),
                path.resolve(mgInstall).toLowerCase(),
                'Manage.ps1 inside custom install dir must auto-target its own installRoot'
            );

            const okClean = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(mgInstall, 'scripts', 'Uninstall.ps1'),
                '-SkipSystemRegistration'
            ], { encoding: 'utf8', env: { ...cleanEnv, LOCALAPPDATA: unrelatedLocal }, windowsHide: true, timeout: 20000 });
            assert.equal(okClean.status, 0, `Self-discovered Uninstall.ps1 failed:\n${okClean.stdout}\n${okClean.stderr}`);
            assert.equal(fs.existsSync(path.join(mgRes, 'app.asar')), true, 'Custom dir Uninstall.ps1 must restore its own app.asar without -InstallRoot');
            assert.equal(fs.existsSync(mgInstall), false, 'Custom install dir must be removed after self-discovered uninstall');

            // F) Zero-Node watch.cjs --once exits cleanly (no resident Antigravity.exe file lock) & VBS includes --once under zero-Node
            const onceInstall = path.join(tmpBase, 'watch-once-test');
            fs.mkdirSync(onceInstall, { recursive: true });
            configManager.saveConfig({ features: { taskToast: false } }, { installRoot: onceInstall, syncRules: false });
            const onceRes = cp.spawnSync(process.execPath, [path.join(repoRoot, 'src', 'main', 'watch.cjs'), '--once'], {
                encoding: 'utf8',
                env: { ...cleanEnv, AGY_PLUS_ROOT: onceInstall },
                windowsHide: true,
                timeout: 8000
            });
            assert.equal(onceRes.status, 0, 'watch.cjs --once must exit cleanly with code 0');

            // Verify zero-Node Start-Watcher.vbs generated by Install.ps1 includes --once
            const znVbsBase = path.join(tmpBase, 'zn-vbs-check');
            const znVbsInstall = path.join(znVbsBase, 'Plus');
            const znVbsRes = path.join(znVbsBase, 'res');
            const znVbsGem = path.join(znVbsBase, 'gem');
            fs.mkdirSync(znVbsRes, { recursive: true });
            fs.writeFileSync(path.join(znVbsRes, 'app.asar'), asarBuf);
            if (fs.existsSync(realAgyExe)) {
                const znInst = cp.spawnSync(psExe, [
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                    '-InstallRoot', znVbsInstall, '-AntigravityResourcesDir', znVbsRes, '-GeminiConfigDir', znVbsGem,
                    '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
                ], { encoding: 'utf8', env: { ...cleanEnv, AGY_FORCE_ELECTRON_NODE: '1', AGY_EXE_PATH: realAgyExe }, windowsHide: true, timeout: 45000 });
                assert.equal(znInst.status, 0, `Zero-Node Install for VBS check failed: ${znInst.stderr}`);
                const decodedWatcherVbs = fs.readFileSync(path.join(znVbsInstall, 'bin', 'Start-Watcher.vbs')).slice(2).toString('utf16le');
                assert.ok(decodedWatcherVbs.includes('--once'), 'Zero-Node Start-Watcher.vbs must pass --once so Antigravity.exe never stays resident');
                cp.spawnSync(psExe, [
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(znVbsInstall, 'scripts', 'Uninstall.ps1'),
                    '-SkipSystemRegistration'
                ], { encoding: 'utf8', env: { ...cleanEnv, AGY_FORCE_ELECTRON_NODE: '1', AGY_EXE_PATH: realAgyExe }, windowsHide: true, timeout: 20000 });
            }

            // G) Verify zero-Node updater PowerShell fallback never passes PID 0 (System Idle Process) to Get-Process -Id
            const rtSrc = fs.readFileSync(path.join(repoRoot, 'src', 'core', 'runtime.cjs'), 'utf8');
            assert.ok(rtSrc.includes('pid > 0') && !rtSrc.includes('Get-Process -Id $p,$i'), 'runtime.cjs must filter PIDs > 0 before Get-Process -Id');

            // H) Verify translation-worker.py works with Chinese input even WITHOUT PYTHONIOENCODING set
            const siblingOfflineRepo = path.resolve(repoRoot, '..', 'antigravity-offline-translator');
            const realVenvPy = 'D:\\DevTools\\AntigravityTranslator\\venv\\Scripts\\python.exe';
            const realModelPkg = 'D:\\DevTools\\AntigravityTranslator\\model-package';
            if (fs.existsSync(siblingOfflineRepo) && fs.existsSync(realVenvPy) && fs.existsSync(realModelPkg)) {
                let realModelSub = '';
                for (const ent of fs.readdirSync(realModelPkg, { withFileTypes: true })) {
                    const cand = path.join(realModelPkg, ent.name);
                    if (ent.isDirectory() && fs.existsSync(path.join(cand, 'sentencepiece.model'))) { realModelSub = cand; break; }
                }
                if (realModelSub) {
                    const noIoEnv = { ...cleanEnv, PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1' };
                    delete noIoEnv.PYTHONIOENCODING;
                    const noIoRes = cp.spawnSync(realVenvPy, ['-B', path.join(siblingOfflineRepo, 'src', 'translation-worker.py'), realModelSub], {
                        input: JSON.stringify({ id: 11, texts: ['中文直接透传测试', 'Testing UTF-8 without env var.'] }) + '\n',
                        encoding: 'utf8',
                        env: noIoEnv,
                        windowsHide: true,
                        timeout: 25000
                    });
                    assert.equal(noIoRes.status, 0, `Worker without PYTHONIOENCODING failed:\n${noIoRes.stderr}`);
                    const outLines = noIoRes.stdout.trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
                    const ans = outLines.find(x => x.id === 11);
                    assert.ok(ans && ans.texts[0] === '中文直接透传测试' && /[\u3400-\u9fff]/.test(ans.texts[1]), `Unexpected worker reply: ${noIoRes.stdout}`);
                }
            }

            // E) Offline Install.cmd & Uninstall.cmd with args must NOT pause and MUST preserve non-zero exit codes
            if (fs.existsSync(siblingOfflineRepo)) {
                const unownedDir = path.join(tmpBase, 'offline-cmd-unowned');
                fs.mkdirSync(unownedDir, { recursive: true });
                fs.writeFileSync(path.join(unownedDir, 'important.txt'), 'keep', 'utf8');

                const offInstCmd = cp.spawnSync('cmd.exe', ['/d', '/c', path.join(siblingOfflineRepo, 'Install.cmd'), '-InstallDir', unownedDir], {
                    encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000
                });
                assert.notEqual(offInstCmd.status, 0, 'Offline Install.cmd must preserve non-zero exit code and not hang on pause');

                const offUninstCmd = cp.spawnSync('cmd.exe', ['/d', '/c', path.join(siblingOfflineRepo, 'Uninstall.cmd'), '-InstallDir', unownedDir], {
                    encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000
                });
                assert.notEqual(offUninstCmd.status, 0, 'Offline Uninstall.cmd must preserve non-zero exit code and not hang on pause');
                assert.equal(fs.readFileSync(path.join(unownedDir, 'important.txt'), 'utf8'), 'keep');
            }

            // I) In-place upgrade while TaskToastHost.exe is actively running must cleanly stop old host and leave NO TaskToastHost.old.exe
            const upgBase = path.join(tmpBase, 'inplace-upgrade-toast');
            const upgInstall = path.join(upgBase, 'Plus');
            const upgRes = path.join(upgBase, 'resources');
            const upgGem = path.join(upgBase, 'gemini');
            fs.mkdirSync(upgRes, { recursive: true });
            fs.writeFileSync(path.join(upgRes, 'app.asar'), asarBuf);

            const firstUpgInst = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', upgInstall, '-AntigravityResourcesDir', upgRes, '-GeminiConfigDir', upgGem,
                '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 45000 });
            assert.equal(firstUpgInst.status, 0, `First install for upgrade test failed:\n${firstUpgInst.stdout}\n${firstUpgInst.stderr}`);

            const installedToastExe = path.join(upgInstall, 'bin', 'TaskToastHost.exe');
            const upgPipe = toastClient.defaultPipeName(upgInstall);
            const liveToastStatus = await toastClient.ensureToastHostRunning({
                installRoot: upgInstall,
                exePath: installedToastExe,
                pipeName: upgPipe,
                allowCurrentDesktop: true
            });
            assert.equal(liveToastStatus.running, true, 'Installed TaskToastHost.exe should be running prior to in-place upgrade');
            const oldPid = liveToastStatus.pid;

            const secondUpgInst = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', upgInstall, '-AntigravityResourcesDir', upgRes, '-GeminiConfigDir', upgGem,
                '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 45000 });
            assert.equal(secondUpgInst.status, 0, `Second in-place upgrade failed:\n${secondUpgInst.stdout}\n${secondUpgInst.stderr}`);
            assert.equal(fs.existsSync(path.join(upgInstall, 'bin', 'TaskToastHost.old.exe')), false, 'In-place upgrade must not leave locked TaskToastHost.old.exe');
            let oldStillAlive = false;
            try {
                const probe = await toastClient.sendToastRequest({ action: 'status' }, {
                    installRoot: upgInstall, exePath: installedToastExe, pipeName: upgPipe, ensureRunning: false, timeoutMs: 400
                });
                oldStillAlive = Boolean(probe && probe.running && (!oldPid || probe.pid === oldPid));
            } catch {}
            assert.equal(oldStillAlive, false, 'Old TaskToastHost.exe process must have been stopped cleanly during in-place upgrade');

            // Verify newly upgraded TaskToastHost.exe starts & shuts down cleanly, then uninstall
            const newToastStatus = await toastClient.ensureToastHostRunning({
                installRoot: upgInstall,
                exePath: installedToastExe,
                pipeName: upgPipe,
                allowCurrentDesktop: true
            });
            assert.equal(newToastStatus.running, true);
            await toastClient.sendToastRequest({ action: 'shutdown' }, {
                installRoot: upgInstall, exePath: installedToastExe, pipeName: upgPipe, ensureRunning: false
            });
            await new Promise(r => setTimeout(r, 200));

            const cleanUpg = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(upgInstall, 'scripts', 'Uninstall.ps1'),
                '-SkipSystemRegistration'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 25000 });
            assert.equal(cleanUpg.status, 0, `Upgrade test cleanup uninstall failed:\n${cleanUpg.stdout}\n${cleanUpg.stderr}`);

            // J) Install path with single-quote + trailing backslash, atomic enable-all/disable-all & settings-before.json cleanup
            const sqBase = path.join(tmpBase, "dir's test");
            const sqInstall = path.join(sqBase, "Plus's Dir");
            const sqRes = path.join(sqBase, 'resources');
            const sqGem = path.join(sqBase, 'gemini');
            fs.mkdirSync(sqRes, { recursive: true });
            fs.writeFileSync(path.join(sqRes, 'app.asar'), asarBuf);
            const sqInst = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repoRoot, 'scripts', 'Install.ps1'),
                '-InstallRoot', sqInstall + '\\',
                '-AntigravityResourcesDir', sqRes + '\\',
                '-GeminiConfigDir', sqGem + '\\',
                '-SkipRegistryRun', '-SkipScheduledTask', '-NoStartWatcher'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 45000 });
            assert.equal(sqInst.status, 0, `Single-quote/trailing-slash install failed:\n${sqInst.stdout}\n${sqInst.stderr}`);

            const sqOnStop = path.join(sqGem, 'plugins', 'task-completion-toast', 'on-stop.cjs');
            const sqSyntax = cp.spawnSync(process.execPath, ['--check', sqOnStop], { encoding: 'utf8', windowsHide: true });
            assert.equal(sqSyntax.status, 0, `Generated on-stop.cjs must be valid JS for single-quote paths:\n${sqSyntax.stderr}`);

            const sqVbs = fs.readFileSync(path.join(sqInstall, 'bin', 'Ensure-Shim.vbs')).slice(2).toString('utf16le');
            assert.equal(sqVbs.includes('\\"'), false, 'Ensure-Shim.vbs must not contain trailing backslash before quote');

            const disAllRes = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(sqInstall, 'scripts', 'Manage.ps1'),
                'disable-all'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
            assert.equal(disAllRes.status, 0, `Manage.ps1 disable-all failed:\n${disAllRes.stderr}`);
            const disAllCfg = JSON.parse(disAllRes.stdout.trim()).config.features;
            assert.equal(Object.values(disAllCfg).every(v => v === false), true, 'disable-all must disable every feature atomically');

            const enaAllRes = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(sqInstall, 'scripts', 'Manage.ps1'),
                'enable-all'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 15000 });
            assert.equal(enaAllRes.status, 0, `Manage.ps1 enable-all failed:\n${enaAllRes.stderr}`);
            const enaAllCfg = JSON.parse(enaAllRes.stdout.trim()).config.features;
            assert.equal(Object.values(enaAllCfg).every(v => v === true), true, 'enable-all must enable every feature atomically');

            fs.writeFileSync(path.join(sqInstall, 'settings-before.json'), '{"test":true}\n', 'utf8');
            const sqUninst = cp.spawnSync(psExe, [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(sqInstall, 'scripts', 'Uninstall.ps1'),
                '-SkipSystemRegistration'
            ], { encoding: 'utf8', env: cleanEnv, windowsHide: true, timeout: 25000 });
            assert.equal(sqUninst.status, 0, `Single-quote uninstall failed:\n${sqUninst.stdout}\n${sqUninst.stderr}`);
            assert.equal(fs.existsSync(sqInstall), false, 'settings-before.json and single-quote installRoot must be cleanly removed');

            // K) Offline repo: setup_model.py refuses forged SHA-256 without deployment.json + compiled TranslationResourceHost.cs must not deadlock when stderr is ignored
            if (fs.existsSync(siblingOfflineRepo)) {
                const pyExe = fs.existsSync(realVenvPy) ? realVenvPy : 'python';
                const fakeModelCheck = cp.spawnSync(pyExe, ['-B', '-c', [
                    'import importlib.util, pathlib, tempfile',
                    `p = pathlib.Path(${JSON.stringify(path.join(siblingOfflineRepo, 'scripts', 'setup_model.py'))})`,
                    'spec = importlib.util.spec_from_file_location("setup_model", p)',
                    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
                    `base = pathlib.Path(${JSON.stringify(path.join(tmpBase, 'setup-model-forged-check'))})`,
                    'm = base / "model-package" / "m"; m.mkdir(parents=True, exist_ok=True)',
                    '(m / "model.bin").write_bytes(b"0" * (16 * 1024 * 1024))',
                    '(m / "sentencepiece.model").write_bytes(b"1" * 2048)',
                    'assert mod.find_existing_model(base / "model-package", base) is None, "Must require matching deployment.json receipt"',
                    'print("OK_SETUP_GUARD")'
                ].join('\n')], {
                    encoding: 'utf8',
                    env: { ...cleanEnv, PYTHONDONTWRITEBYTECODE: '1' },
                    windowsHide: true,
                    timeout: 15000
                });
                assert.equal(fakeModelCheck.status, 0, `setup_model.py integrity check failed:\n${fakeModelCheck.stderr}`);
                assert.ok(fakeModelCheck.stdout.includes('OK_SETUP_GUARD'));

                const cscCandidates = [
                    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
                    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
                ];
                const cscExe = cscCandidates.find(p => fs.existsSync(p));
                if (cscExe) {
                    const compiledHost = path.join(tmpBase, 'TestResourceHost.exe');
                    const hostCs = path.join(siblingOfflineRepo, 'src', 'TranslationResourceHost.cs');
                    const cscRes = cp.spawnSync(cscExe, [
                        '/nologo', '/target:exe', '/optimize+', '/platform:anycpu',
                        `/out:${compiledHost}`, hostCs
                    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
                    assert.equal(cscRes.status, 0, `TranslationResourceHost.cs failed to compile:\n${cscRes.stdout}\n${cscRes.stderr}`);

                    // Run child through compiled TranslationResourceHost while parent intentionally ignores stderr
                    const noisyWorker = path.join(tmpBase, 'noisy-worker.cjs');
                    fs.writeFileSync(noisyWorker, [
                        "const rl = require('node:readline').createInterface({ input: process.stdin });",
                        "rl.on('line', line => {",
                        "  const req = JSON.parse(line);",
                        "  console.log(JSON.stringify({ id: req.id, ok: true }));",
                        "  process.exit(0);",
                        "});"
                    ].join('\n'), 'utf8');
                    const hostRun = await new Promise((resolve, reject) => {
                        const child = cp.spawn(compiledHost, [process.execPath, noisyWorker], {
                            stdio: ['pipe', 'pipe', 'pipe'],
                            windowsHide: true
                        });
                        // Deliberately do NOT attach a 'data' listener on child.stderr to simulate callers ignoring stderr
                        let out = '';
                        child.stdout.setEncoding('utf8');
                        child.stdout.on('data', d => { out += d; });
                        const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('ResourceHost deadlocked with unread stderr')); }, 8000);
                        child.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
                        child.on('error', err => { clearTimeout(timer); reject(err); });
                        setTimeout(() => {
                            try { child.stdin.write(JSON.stringify({ id: 99 }) + '\n'); } catch {}
                        }, 1800);
                    });
                    assert.equal(hostRun.code, 0, `Compiled TranslationResourceHost exited with ${hostRun.code}`);
                    assert.ok(hostRun.out.includes('"id":99'), `Unexpected ResourceHost stdout: ${hostRun.out}`);
                }
            }
        });

        await step('18. privacy, encoding & portability audit across repos', async () => {
            const skipDirs = new Set(['.git', '.tmp', 'bin', 'logs', 'cache', 'node_modules', '__pycache__']);
            const textExts = new Set(['.js', '.cjs', '.mjs', '.json', '.md', '.css', '.ps1', '.cmd', '.cs', '.svg', '.py']);
            const currentUsername = String(os.userInfo().username || '').trim();
            const forbidden = [
                ['credential', 'user', 'scope'].join('-'),
                ['repair', '20261104'].join('-')
            ];
            if (currentUsername && currentUsername.length >= 2 && !/^(admin|administrator|user|runner)$/i.test(currentUsername)) {
                forbidden.push(currentUsername);
            }

            const rootsToCheck = [repoRoot];
            const siblingOfflineRepo = path.resolve(repoRoot, '..', 'antigravity-offline-translator');
            if (fs.existsSync(siblingOfflineRepo)) {
                rootsToCheck.push(siblingOfflineRepo);
            }

            function walk(baseDir, dir) {
                for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (skipDirs.has(ent.name)) continue;
                    const full = path.join(dir, ent.name);
                    if (ent.isDirectory()) {
                        walk(baseDir, full);
                    } else if (textExts.has(path.extname(ent.name).toLowerCase())) {
                        const rawBuf = fs.readFileSync(full);
                        if (path.extname(ent.name).toLowerCase() === '.ps1') {
                            assert.equal(
                                rawBuf.length >= 3 && rawBuf[0] === 0xEF && rawBuf[1] === 0xBB && rawBuf[2] === 0xBF,
                                true,
                                `PowerShell 5.1 encoding audit: ${path.basename(baseDir)}/${path.relative(baseDir, full)} must have UTF-8 BOM`
                            );
                            assert.equal(
                                rawBuf.length >= 6 && rawBuf[3] === 0xEF && rawBuf[4] === 0xBB && rawBuf[5] === 0xBF,
                                false,
                                `PowerShell 5.1 encoding audit: ${path.basename(baseDir)}/${path.relative(baseDir, full)} must not have double UTF-8 BOM`
                            );
                        }
                        const content = rawBuf.toString('utf8');
                        if (path.extname(ent.name).toLowerCase() === '.cmd') {
                            assert.equal(
                                /(?<!\r)\n/.test(content),
                                false,
                                `Batch encoding audit: ${path.basename(baseDir)}/${path.relative(baseDir, full)} must use CRLF line endings`
                            );
                        }
                        for (const needle of forbidden) {
                            assert.equal(
                                content.includes(needle),
                                false,
                                `Privacy audit failed: found "${needle}" in ${path.basename(baseDir)}/${path.relative(baseDir, full)}`
                            );
                        }
                        const relUnix = path.relative(baseDir, full).replace(/\\/g, '/');
                        if (relUnix !== 'tests/run-all-tests.cjs') {
                            assert.equal(
                                /DevTools[\\/]+AntigravityTranslator/i.test(content),
                                false,
                                `Portability audit failed: hardcoded machine path DevTools\\AntigravityTranslator found in ${path.basename(baseDir)}/${relUnix}`
                            );
                        }
                    }
                }
            }

            for (const rootDir of rootsToCheck) {
                walk(rootDir, rootDir);
            }
            const installPs1 = fs.readFileSync(path.join(repoRoot, 'scripts', 'Install.ps1'), 'utf8');
            assert.ok(installPs1.includes('.runHook()'), 'Install.ps1 on-stop.cjs forwarder must invoke .runHook()');
        });

        console.log(`\nAll ${results.length} test suites passed!`);
    } finally {
        try { translator.dispose(); } catch {}
        try {
            fs.rmSync(tmpBase, { recursive: true, force: true });
            const tmpParent = path.join(repoRoot, '.tmp');
            if (fs.existsSync(tmpParent) && fs.readdirSync(tmpParent).length === 0) {
                fs.rmdirSync(tmpParent);
            }
        } catch {}
    }
}

runTests().catch(err => {
    console.error('\n[TEST FAILURE]', err);
    process.exitCode = 1;
});
