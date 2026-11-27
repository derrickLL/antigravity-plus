'use strict';
const {
    FEATURE_KEYS,
    defaultInstallRoot,
    loadConfig,
    updateConfig,
    resolveOfflineTranslatorRoot
} = require('../core/config-manager.cjs');
const { sendBridgeRequest } = require('./bridge-client.cjs');
const { sendToastRequest } = require('../toast/toast-client.cjs');

async function broadcastOrSavePatch(patch, installRoot) {
    try {
        const res = await sendBridgeRequest({ action: 'update_config', patch }, { installRoot, timeoutMs: 3000 });
        if (res && res.ok) return { liveBroadcast: true, ...res };
    } catch {}
    const saved = updateConfig(patch, { installRoot });
    if (saved.features.taskToast === false) {
        try { await sendToastRequest({ action: 'shutdown' }, { installRoot, ensureRunning: false }); } catch {}
    }
    return {
        ok: true,
        liveBroadcast: false,
        config: saved,
        runtimeMeta: { offlineAvailable: Boolean(resolveOfflineTranslatorRoot(saved.translation?.offlineRoot)) }
    };
}

async function main() {
    const installRoot = defaultInstallRoot();
    const cmd = (process.argv[2] || 'status').toLowerCase();

    if (cmd === 'config') {
        const cfg = loadConfig({ installRoot });
        console.log(JSON.stringify({
            installRoot,
            offlineRootResolved: resolveOfflineTranslatorRoot(cfg.translation?.offlineRoot),
            config: cfg
        }, null, 2));
        return;
    }

    if (cmd === 'enable-all' || cmd === 'disable-all') {
        const nextVal = cmd === 'enable-all';
        const features = {};
        for (const key of FEATURE_KEYS) features[key] = nextVal;
        const result = await broadcastOrSavePatch({ features }, installRoot);
        console.log(JSON.stringify({ allFeatures: nextVal, ...result }, null, 2));
        return;
    }

    if (cmd === 'enable' || cmd === 'disable' || cmd === 'toggle') {
        const key = process.argv[3];
        if (!FEATURE_KEYS.includes(key)) {
            throw new Error(`Unknown feature "${key}". Available features:\n  ${FEATURE_KEYS.join('\n  ')}`);
        }
        const current = loadConfig({ installRoot });
        const nextVal = cmd === 'enable' ? true : (cmd === 'disable' ? false : !current.features[key]);
        const result = await broadcastOrSavePatch({ features: { [key]: nextVal } }, installRoot);
        console.log(JSON.stringify({ feature: key, enabled: nextVal, ...result }, null, 2));
        return;
    }

    if (cmd === 'set-mode') {
        const mode = String(process.argv[3] || '').toLowerCase();
        if (!['hybrid', 'online', 'offline'].includes(mode)) {
            throw new Error('Mode must be one of: hybrid, online, offline');
        }
        const result = await broadcastOrSavePatch({ translation: { mode } }, installRoot);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (cmd === 'set-proxy') {
        const proxyUrl = String(process.argv[3] ?? '');
        const result = await broadcastOrSavePatch({ network: { proxyUrl } }, installRoot);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (cmd === 'set-browser') {
        const externalBrowserPath = String(process.argv[3] ?? '');
        const result = await broadcastOrSavePatch({ network: { externalBrowserPath } }, installRoot);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (cmd === 'set-offline-root') {
        const offlineRoot = String(process.argv[3] ?? '');
        const current = loadConfig({ installRoot });
        const patch = { translation: { offlineRoot } };
        if (!offlineRoot && current.translation?.mode === 'offline') {
            patch.translation.mode = 'hybrid';
        }
        const result = await broadcastOrSavePatch(patch, installRoot);
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (['status', 'apply', 'remove', 'translate', 'sync', 'tour'].includes(cmd)) {
        const actionMap = {
            status: 'status',
            apply: 'apply',
            remove: 'remove',
            translate: 'translate_now',
            sync: 'sync_now',
            tour: 'start_tour'
        };
        try {
            const res = await sendBridgeRequest({ action: actionMap[cmd] }, {
                installRoot,
                timeoutMs: cmd === 'translate' ? 15000 : 6000
            });
            console.log(JSON.stringify(res, null, 2));
            return;
        } catch (err) {
            if (cmd === 'status') {
                const cfg = loadConfig({ installRoot });
                console.log(JSON.stringify({
                    ok: true,
                    bridgeOnline: false,
                    note: 'Antigravity is not currently running with MainBridge active.',
                    installRoot,
                    config: cfg
                }, null, 2));
                return;
            }
            throw err;
        }
    }

    throw new Error('Usage: node cli.cjs <status|config|apply|remove|translate|tour|enable|disable|toggle|enable-all|disable-all|set-mode|set-proxy|set-browser|set-offline-root> [args]');
}

main().catch(err => {
    console.error('[AntigravityPlus CLI]', err.message);
    process.exitCode = 1;
});
