'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultInstallRoot, readJsonSafe } = require('./config-manager.cjs');

function resolveConfiguredAntigravityExe(installRoot = defaultInstallRoot()) {
    try {
        const receipt = readJsonSafe(path.join(installRoot, 'install-receipt.json'));
        if (receipt && typeof receipt.antigravityExePath === 'string' && receipt.antigravityExePath.trim()) {
            return receipt.antigravityExePath.trim();
        }
        if (receipt && typeof receipt.antigravityResourcesDir === 'string' && receipt.antigravityResourcesDir.trim()) {
            return path.join(path.dirname(path.resolve(receipt.antigravityResourcesDir.trim())), 'Antigravity.exe');
        }
        const rtState = readJsonSafe(path.join(installRoot, 'runtime_state.json'));
        if (rtState && typeof rtState.AppExe === 'string' && rtState.AppExe.trim()) {
            return rtState.AppExe.trim();
        }
    } catch {}
    return '';
}

function resolveAntigravityExe(explicitPath = '', installRoot = defaultInstallRoot()) {
    const candidates = [
        explicitPath,
        process.env.AGY_EXE_PATH || '',
        resolveConfiguredAntigravityExe(installRoot),
        path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'Antigravity.exe'),
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Antigravity', 'Antigravity.exe')
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            const resolved = path.resolve(candidate);
            if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                return resolved;
            }
        } catch {}
    }
    return null;
}

function resolveSystemNode() {
    if (process.env.AGY_FORCE_ELECTRON_NODE === '1') {
        return null;
    }
    const candidates = [];
    if (process.env.AGY_SYSTEM_NODE) {
        candidates.push(process.env.AGY_SYSTEM_NODE);
    }
    const pathEnv = process.env.PATH || process.env.Path || '';
    for (const dir of pathEnv.split(path.delimiter)) {
        const cleaned = dir.trim().replace(/^"|"$/g, '');
        if (cleaned) {
            candidates.push(path.join(cleaned, process.platform === 'win32' ? 'node.exe' : 'node'));
        }
    }
    if (process.platform === 'win32') {
        candidates.push(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'nodejs', 'node.exe'));
        candidates.push('D:\\Program Files\\nodejs\\node.exe');
    }

    const currentExe = path.resolve(process.execPath || '').toLowerCase();
    const isElectronHost = !/[/\\]node(\.exe)?$/i.test(currentExe);

    for (const candidate of candidates) {
        try {
            const resolved = path.resolve(candidate);
            const lower = resolved.toLowerCase();
            if (isElectronHost && lower === currentExe) continue;
            if (lower.includes('\\programs\\antigravity\\')) continue;
            if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                return resolved;
            }
        } catch {}
    }
    return null;
}

/**
 * Returns { command, env, usesElectronNode } capable of running any .cjs/.js script,
 * even on clean Windows machines where standalone Node.js is not installed.
 */
function resolveJsRunner(baseEnv = process.env, explicitAgyExe = '') {
    const env = { ...baseEnv };
    delete env.NODE_OPTIONS;

    const sysNode = resolveSystemNode();
    if (sysNode) {
        delete env.ELECTRON_RUN_AS_NODE;
        return { command: sysNode, env, usesElectronNode: false };
    }

    const agyExe = resolveAntigravityExe(explicitAgyExe);
    if (agyExe) {
        env.ELECTRON_RUN_AS_NODE = '1';
        return { command: agyExe, env, usesElectronNode: true };
    }

    return null;
}

module.exports = {
    resolveAntigravityExe,
    resolveSystemNode,
    resolveJsRunner
};
