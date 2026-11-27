'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { detectChromePath } = require('./config-manager.cjs');

const CHROMIUM_BROWSER_RE = /^(chrome|msedge|brave|vivaldi|opera|arc|chromium|centbrowser|thorium)\.exe$/i;
const FIREFOX_BROWSER_RE = /^(firefox|librewolf|waterfox|zen|floorp)\.exe$/i;

function buildBrowserLaunchArgs(browserPath, href) {
    const base = path.basename(String(browserPath || '')).toLowerCase();
    if (CHROMIUM_BROWSER_RE.test(base)) return ['--new-tab', href];
    if (FIREFOX_BROWSER_RE.test(base)) return ['-new-tab', href];
    return [href];
}

/**
 * Dynamically routes HTTP/HTTPS external links to the configured browser when
 * `features.externalBrowser` is enabled, and falls back to the OS default browser
 * immediately when toggled off (no app restart required).
 */
function install({ shell, spawn, getConfig, receiptPath }) {
    if (!shell || typeof shell.openExternal !== 'function') {
        return { installed: false, reason: 'shell_unavailable' };
    }
    if (shell.__agyPlusExternalBrowserInstalled) {
        return { installed: true, alreadyInstalled: true };
    }

    const original = shell.openExternal.bind(shell);

    function resolveActiveBrowserPath() {
        const cfg = typeof getConfig === 'function' ? getConfig() : null;
        if (cfg && cfg.features && cfg.features.externalBrowser === false) {
            return '';
        }
        const configured = String(cfg?.network?.externalBrowserPath || '').trim();
        const candidate = configured || detectChromePath();
        if (!candidate) return '';
        if (process.platform === 'win32' && !/\.exe$/i.test(candidate)) {
            return '';
        }
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {}
        return '';
    }

    shell.openExternal = function openExternalWithAgyPlus(url, options) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            return original(url, options);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return original(url, options);
        }

        const browserPath = resolveActiveBrowserPath();
        if (!browserPath) {
            return original(url, options);
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let child;
            try {
                child = spawn(browserPath, buildBrowserLaunchArgs(browserPath, parsed.href), {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true,
                    shell: false
                });
            } catch {
                resolve(original(url, options));
                return;
            }
            child.once('error', () => {
                if (settled) return;
                settled = true;
                resolve(original(url, options));
            });
            child.once('spawn', () => {
                if (settled) return;
                settled = true;
                try {
                    if (receiptPath) {
                        fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
                        fs.writeFileSync(receiptPath, JSON.stringify({
                            CheckedAt: new Date().toISOString(),
                            AppPid: process.pid,
                            BrowserPath: browserPath,
                            BrowserPid: child.pid,
                            Scheme: parsed.protocol,
                            ExplicitBrowserLaunch: true
                        }, null, 2));
                    }
                } catch {}
                try { child.unref(); } catch {}
                resolve();
            });
        });
    };

    Object.defineProperty(shell, '__agyPlusExternalBrowserInstalled', {
        value: true,
        enumerable: false,
        configurable: true
    });

    const initialBrowser = resolveActiveBrowserPath();
    return {
        installed: true,
        configured: Boolean(initialBrowser),
        browserPath: initialBrowser || null
    };
}

module.exports = { install };
