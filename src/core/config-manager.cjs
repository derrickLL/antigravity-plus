'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEFAULT_CONFIG = {
    features: {
        codexTheme: true,
        contextRing: true,
        performancePill: true,
        quotaSplitRing: true,
        autoHighestModel: true,
        navigationGestures: true,
        newWindowMenu: true,
        thoughtTranslation: true,
        titleTranslation: true,
        taskToast: true,
        externalBrowser: true,
        localProxy: true,
        fastpushFix: true,
        chineseExecutionRule: true,
        workspaceScriptsRule: true
    },
    network: {
        proxyUrl: '',
        externalBrowserPath: ''
    },
    model: {
        strategy: 'highest_gemini',
        preferredModelHint: '',
        preferredEffortHint: ''
    },
    translation: {
        mode: 'hybrid',
        offlineRoot: ''
    }
};

const FEATURE_KEYS = Object.keys(DEFAULT_CONFIG.features);

const RULE_FILES = {
    chineseExecutionRule: 'agy-plus-chinese-execution.md',
    workspaceScriptsRule: 'agy-plus-workspace-local-scripts.md'
};

function defaultInstallRoot() {
    if (process.env.AGY_PLUS_ROOT) {
        return path.resolve(process.env.AGY_PLUS_ROOT);
    }
    return path.resolve(__dirname, '..', '..');
}

function defaultConfigPath(installRoot = defaultInstallRoot()) {
    return path.join(installRoot, 'config.json');
}

function readJsonSafe(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function writeJsonAtomic(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = JSON.stringify(data, null, 2) + '\n';
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, payload, 'utf8');
    try {
        fs.renameSync(tmp, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
            fs.writeFileSync(filePath, payload, 'utf8');
            return;
        }
        throw err;
    }
}

function normalizeConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const features = {};
    for (const key of FEATURE_KEYS) {
        features[key] = typeof src.features?.[key] === 'boolean'
            ? src.features[key]
            : DEFAULT_CONFIG.features[key];
    }
    const modeRaw = String(src.translation?.mode ?? DEFAULT_CONFIG.translation.mode).trim().toLowerCase();
    const validMode = ['hybrid', 'online', 'offline'].includes(modeRaw) ? modeRaw : 'hybrid';
    const stratRaw = String(src.model?.strategy ?? DEFAULT_CONFIG.model.strategy).trim();

    return {
        features,
        network: {
            proxyUrl: typeof src.network?.proxyUrl === 'string' ? src.network.proxyUrl.trim() : '',
            externalBrowserPath: typeof src.network?.externalBrowserPath === 'string' ? src.network.externalBrowserPath.trim() : ''
        },
        model: {
            strategy: stratRaw || DEFAULT_CONFIG.model.strategy,
            preferredModelHint: typeof src.model?.preferredModelHint === 'string' ? src.model.preferredModelHint.trim() : '',
            preferredEffortHint: typeof src.model?.preferredEffortHint === 'string' ? src.model.preferredEffortHint.trim() : ''
        },
        translation: {
            mode: validMode,
            offlineRoot: typeof src.translation?.offlineRoot === 'string' ? src.translation.offlineRoot.trim() : ''
        }
    };
}

function mergeConfigPatch(current, patch) {
    const base = normalizeConfig(current);
    if (!patch || typeof patch !== 'object') return base;

    const next = {
        features: { ...base.features },
        network: { ...base.network },
        model: { ...base.model },
        translation: { ...base.translation }
    };

    if (patch.features && typeof patch.features === 'object') {
        for (const key of FEATURE_KEYS) {
            if (typeof patch.features[key] === 'boolean') {
                next.features[key] = patch.features[key];
            }
        }
    }
    if (patch.network && typeof patch.network === 'object') {
        if (typeof patch.network.proxyUrl === 'string') next.network.proxyUrl = patch.network.proxyUrl.trim();
        if (typeof patch.network.externalBrowserPath === 'string') next.network.externalBrowserPath = patch.network.externalBrowserPath.trim();
    }
    if (patch.model && typeof patch.model === 'object') {
        if (typeof patch.model.strategy === 'string' && patch.model.strategy.trim()) next.model.strategy = patch.model.strategy.trim();
        if (typeof patch.model.preferredModelHint === 'string') next.model.preferredModelHint = patch.model.preferredModelHint.trim();
        if (typeof patch.model.preferredEffortHint === 'string') next.model.preferredEffortHint = patch.model.preferredEffortHint.trim();
    }
    if (patch.translation && typeof patch.translation === 'object') {
        if (typeof patch.translation.mode === 'string') {
            const m = patch.translation.mode.trim().toLowerCase();
            if (['hybrid', 'online', 'offline'].includes(m)) next.translation.mode = m;
        }
        if (typeof patch.translation.offlineRoot === 'string') {
            next.translation.offlineRoot = patch.translation.offlineRoot.trim();
        }
    }
    return normalizeConfig(next);
}

function loadConfig(options = {}) {
    const installRoot = options.installRoot || defaultInstallRoot();
    const configPath = options.configPath || defaultConfigPath(installRoot);
    const saved = readJsonSafe(configPath);
    if (saved) return normalizeConfig(saved);
    const templatePath = path.join(installRoot, 'config', 'config.default.json');
    const template = readJsonSafe(templatePath);
    return normalizeConfig(template);
}

function saveConfig(config, options = {}) {
    const installRoot = options.installRoot || defaultInstallRoot();
    const configPath = options.configPath || defaultConfigPath(installRoot);
    const normalized = normalizeConfig(config);
    writeJsonAtomic(configPath, normalized);
    if (options.syncRules !== false) {
        syncGlobalRules(normalized, { installRoot, rulesDir: options.rulesDir });
    }
    return normalized;
}

function updateConfig(patch, options = {}) {
    const current = loadConfig(options);
    const merged = mergeConfigPatch(current, patch);
    return saveConfig(merged, options);
}

function syncGlobalRules(config, options = {}) {
    const installRoot = options.installRoot || defaultInstallRoot();
    const rulesDir = options.rulesDir || process.env.AGY_PLUS_RULES_DIR || path.join(os.homedir(), '.gemini', 'config', 'rules');
    const templatesDir = path.join(installRoot, 'integrations', 'rules');
    const results = {};

    for (const [featureKey, fileName] of Object.entries(RULE_FILES)) {
        const enabled = config?.features?.[featureKey] !== false;
        const targetPath = path.join(rulesDir, fileName);
        const srcPath = path.join(templatesDir, fileName);
        try {
            if (enabled) {
                if (fs.existsSync(srcPath)) {
                    fs.mkdirSync(rulesDir, { recursive: true });
                    const desired = fs.readFileSync(srcPath, 'utf8');
                    const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
                    if (current !== desired) {
                        fs.writeFileSync(targetPath, desired, 'utf8');
                    }
                    results[featureKey] = 'installed';
                } else {
                    results[featureKey] = 'template_missing';
                }
            } else {
                if (fs.existsSync(targetPath)) {
                    fs.unlinkSync(targetPath);
                }
                results[featureKey] = 'removed';
            }
        } catch (err) {
            results[featureKey] = `error:${err && err.message ? err.message : String(err)}`;
        }
    }
    return results;
}

let cachedChromePath = null;
let cachedChromeAt = 0;

function detectChromePath(options = {}) {
    const now = Date.now();
    if (!options.bypassCache && cachedChromePath !== null && (now - cachedChromeAt) < 60000) {
        if (!cachedChromePath) return '';
        try {
            if (fs.existsSync(cachedChromePath) && fs.statSync(cachedChromePath).isFile()) {
                return cachedChromePath;
            }
        } catch {}
    }
    const candidates = [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
    for (const candidate of candidates) {
        try {
            if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                cachedChromePath = candidate;
                cachedChromeAt = now;
                return candidate;
            }
        } catch {}
    }
    if (process.platform === 'win32') {
        for (const regKey of [
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
            'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'
        ]) {
            try {
                const out = cp.execFileSync('reg.exe', ['query', regKey, '/ve'], {
                    encoding: 'utf8',
                    timeout: 1200,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'ignore']
                });
                const m = /REG_SZ\s+([^\r\n]+)/i.exec(out);
                if (m) {
                    const p = m[1].trim().replace(/^"|"$/g, '');
                    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
                        cachedChromePath = p;
                        cachedChromeAt = now;
                        return p;
                    }
                }
            } catch {}
        }
    }
    cachedChromePath = '';
    cachedChromeAt = now;
    return '';
}

function resolveOfflineTranslatorRoot(configuredRoot = '', options = {}) {
    const allowAutoDetect = options.allowAutoDetect !== false;
    const rawCandidates = [configuredRoot];
    if (allowAutoDetect) {
        rawCandidates.push(
            process.env.AGY_OFFLINE_TRANSLATOR_DIR || '',
            path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AntigravityOfflineTranslator')
        );
    }
    const candidates = rawCandidates.map(x => String(x || '').trim()).filter(Boolean);

    for (const dir of candidates) {
        try {
            const deployPath = path.join(dir, 'deployment.json');
            if (!fs.existsSync(deployPath)) continue;
            const deploy = readJsonSafe(deployPath);
            if (deploy && deploy.resourceHost && fs.existsSync(deploy.resourceHost) &&
                deploy.python && fs.existsSync(deploy.python) &&
                deploy.worker && fs.existsSync(deploy.worker) &&
                deploy.modelRoot && fs.existsSync(deploy.modelRoot)) {
                return path.resolve(dir);
            }
        } catch {}
    }
    return '';
}

module.exports = {
    DEFAULT_CONFIG,
    FEATURE_KEYS,
    RULE_FILES,
    defaultInstallRoot,
    defaultConfigPath,
    readJsonSafe,
    writeJsonAtomic,
    normalizeConfig,
    mergeConfigPatch,
    loadConfig,
    saveConfig,
    updateConfig,
    syncGlobalRules,
    detectChromePath,
    resolveOfflineTranslatorRoot
};
