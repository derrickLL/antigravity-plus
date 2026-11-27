'use strict';

/**
 * Antigravity Plus Lightweight Logon Guardian
 *
 * Ensures `TaskToastHost.exe` stays ready according to `config.features.taskToast`
 * and exits duplicate instances cleanly via named-pipe lock.
 */

const net = require('node:net');
const { defaultInstallRoot, loadConfig } = require('../core/config-manager.cjs');
const { computeHash20, isBridgeAlive } = require('./bridge-client.cjs');
const { ensureToastHostRunning, sendToastRequest } = require('../toast/toast-client.cjs');

const installRoot = defaultInstallRoot();
const runOnce = process.argv.includes('--once');
const hash = computeHash20(installRoot);
const lockPipe = `\\\\.\\pipe\\AgyPlus-Watcher-${hash}`;

const lock = net.createServer(socket => socket.end());
let checking = false;
let toastBackoffUntil = 0;

async function tick() {
    if (checking) return;
    checking = true;
    try {
        const cfg = loadConfig({ installRoot });
        if (cfg.features.taskToast === false) {
            toastBackoffUntil = 0;
            try { await sendToastRequest({ action: 'shutdown' }, { installRoot, ensureRunning: false }); } catch {}
        } else {
            const now = Date.now();
            if (now >= toastBackoffUntil) {
                const bridgeUp = await isBridgeAlive({ installRoot, timeoutMs: 400 });
                if (!bridgeUp) {
                    try {
                        await ensureToastHostRunning({ installRoot });
                    } catch {
                        toastBackoffUntil = now + 30000;
                    }
                }
            }
        }
    } catch {} finally {
        checking = false;
    }
}

if (runOnce) {
    // One-shot warm-up mode used on zero-Node machines so Antigravity.exe never stays resident
    // holding binary file locks across NSIS auto-updates or uninstalls.
    tick().finally(() => { process.exit(0); });
} else {
    lock.on('error', err => {
        process.exitCode = err && err.code === 'EADDRINUSE' ? 0 : 1;
    });

    lock.listen(lockPipe, () => {
        const timer = setInterval(tick, 4000);
        timer.unref?.();
        void tick();
    });
}
