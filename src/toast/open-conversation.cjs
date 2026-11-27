'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { defaultInstallRoot } = require('../core/config-manager.cjs');
const { resolveAntigravityExe } = require('../core/node-runner.cjs');
const { isValidConversationId } = require('./toast-client.cjs');
const { sendBridgeRequest } = require('../main/bridge-client.cjs');

function launchDeepLink(conversationId, installRoot = defaultInstallRoot()) {
    const exe = resolveAntigravityExe('', installRoot);
    if (!exe) return false;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, [`antigravity://agy-plus-open-conversation/${conversationId}`], {
        cwd: path.dirname(exe),
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env
    });
    child.unref();
    return true;
}

async function tryOpenViaBridge(conversationId, { waitReady = false, bringToFront = true, bridgePipeName, installRoot } = {}) {
    const res = await sendBridgeRequest({
        action: 'open_conversation',
        conversationId,
        waitReady,
        bringToFront
    }, {
        pipeName: bridgePipeName,
        installRoot,
        timeoutMs: waitReady ? 8000 : 3000
    });
    if (res && res.ok && res.navigated) {
        return { ok: true, navigatedViaBridge: true, method: res.method || '' };
    }
    return null;
}

async function openConversation(conversationId, options = {}) {
    if (!isValidConversationId(conversationId)) {
        throw new Error('Invalid conversation ID');
    }
    const installRoot = options.installRoot || defaultInstallRoot();
    const bridgeOpts = { bridgePipeName: options.bridgePipeName, installRoot };

    try {
        const direct = await tryOpenViaBridge(conversationId, {
            ...bridgeOpts,
            waitReady: false,
            bringToFront: true
        });
        if (direct) return direct;
    } catch {}

    const launched = launchDeepLink(conversationId, installRoot);
    if (!launched) {
        return { ok: false, navigatedViaBridge: false, error: 'antigravity_exe_not_found' };
    }
    const deadline = Date.now() + 14000;
    while (Date.now() < deadline) {
        try {
            const viaBridge = await tryOpenViaBridge(conversationId, {
                ...bridgeOpts,
                waitReady: true,
                bringToFront: true
            });
            if (viaBridge) return viaBridge;
        } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    return { ok: false, navigatedViaBridge: false, error: 'open_timeout' };
}

if (require.main === module) {
    const conversationId = process.argv[2] || '';
    const windowActivated = process.argv.includes('--window-activated');
    const windowForegrounded = process.argv.includes('--window-foregrounded');
    openConversation(conversationId, { windowActivated, windowForegrounded })
        .then(res => {
            if (!res || res.ok === false) process.exitCode = 1;
        })
        .catch(() => {
            process.exitCode = 1;
        });
}

module.exports = { openConversation };
