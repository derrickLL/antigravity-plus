'use strict';

/**
 * Antigravity Plus Non-Destructive Native Shim Manager (V3)
 *
 * Moves `resources/app.asar` to `resources/app.real.asar` (0 bytes modified in official archive)
 * and creates a lightweight `resources/app/index.js` bootstrapper that loads `src/core/runtime.cjs`
 * before delegating to `../app.real.asar/dist/main.js`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { defaultInstallRoot } = require('./config-manager.cjs');

process.noAsar = true;

const SHIM_VERSION_TAG = 'ANTIGRAVITY_PLUS_SHIM_V3';
const REAL_ASAR_FILENAME = 'app.real.asar';

const DEFAULT_RESOURCES_DIR = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Programs',
    'antigravity',
    'resources'
);

function buildShimIndexJs(runtimeScriptPath) {
    return `"use strict";
/* ${SHIM_VERSION_TAG} */
const fs = require("fs");
const path = require("path");
let electron = null;
try { electron = require("electron"); } catch (_) {}

const realCandidate = path.join(__dirname, "..", ${JSON.stringify(REAL_ASAR_FILENAME)});
const stockCandidate = path.join(__dirname, "..", "app.asar");
let realAsarPath = realCandidate;
if (!fs.existsSync(realCandidate) && fs.existsSync(stockCandidate)) {
    try {
        fs.renameSync(stockCandidate, realCandidate);
        realAsarPath = realCandidate;
    } catch (_) {
        realAsarPath = stockCandidate;
    }
}
const realPkgPath = path.join(realAsarPath, "package.json");
const realPkg = JSON.parse(fs.readFileSync(realPkgPath, "utf8"));

const runtimePath = ${JSON.stringify(runtimeScriptPath)};
try {
    if (fs.existsSync(runtimePath)) {
        const runtime = require(runtimePath);
        if (runtime && typeof runtime.bootstrap === "function") {
            runtime.bootstrap({
                appDir: __dirname,
                realAsarPath,
                realPkg,
                electron,
            });
        }
    }
} catch (err) {
    try {
        console.error("[AntigravityPlus] Bootstrap error:", err);
    } catch (_) {}
}

module.exports = require(path.join(realAsarPath, realPkg.main || "dist/main.js"));
`;
}

function resolvePaths(installRoot = defaultInstallRoot()) {
    const root = path.resolve(installRoot);
    return {
        installRoot: root,
        runtimeScript: path.join(root, 'src', 'core', 'runtime.cjs'),
        stateFile: path.join(root, 'patch_state.json'),
        runtimeStateFile: path.join(root, 'runtime_state.json'),
        logFile: path.join(root, 'logs', 'patch.log')
    };
}

function appendLog(logFile, msg) {
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch {}
}

function parseArgs(argv) {
    const opts = {
        resourcesDir: DEFAULT_RESOURCES_DIR,
        installRoot: defaultInstallRoot(),
        checkOnly: false,
        restore: false,
        updateShimFilesOnly: false,
        allowLegacyShim: false,
        force: false,
        verbose: false
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--target' && argv[i + 1]) {
            const p = path.resolve(argv[++i]);
            opts.resourcesDir = p.toLowerCase().endsWith('.asar') ? path.dirname(p) : p;
        } else if (a === '--install-root' && argv[i + 1]) {
            opts.installRoot = path.resolve(argv[++i]);
        } else if (a === '--check') {
            opts.checkOnly = true;
            opts.verbose = true;
        } else if (a === '--restore') {
            opts.restore = true;
            opts.verbose = true;
        } else if (a === '--shim-files-only') {
            opts.updateShimFilesOnly = true;
        } else if (a === '--allow-legacy-shim') {
            opts.allowLegacyShim = true;
        } else if (a === '--force') {
            opts.force = true;
        } else if (a === '--verbose' || a === '-v') {
            opts.verbose = true;
        }
    }
    return opts;
}

function readPackageJsonFromAsar(asarPath) {
    const fd = fs.openSync(asarPath, 'r');
    try {
        const prefix = Buffer.alloc(16);
        if (fs.readSync(fd, prefix, 0, 16, 0) < 16) {
            throw new Error('Invalid ASAR header');
        }
        const headerSize = prefix.readUInt32LE(4);
        const jsonByteLength = prefix.readUInt32LE(12);
        if (headerSize < 8 || headerSize > 16 * 1024 * 1024 || jsonByteLength === 0 || jsonByteLength > 16 * 1024 * 1024) {
            throw new Error('ASAR header size out of bounds');
        }
        const baseOffset = 8 + headerSize;
        const jsonBuf = Buffer.alloc(jsonByteLength);
        if (fs.readSync(fd, jsonBuf, 0, jsonByteLength, 16) < jsonByteLength) {
            throw new Error('Truncated ASAR header JSON');
        }
        const tree = JSON.parse(jsonBuf.toString('utf8'));
        const pkgNode = tree && tree.files && tree.files['package.json'];
        if (!pkgNode || pkgNode.unpacked) {
            throw new Error('package.json not found inside ASAR');
        }
        const offset = Number(pkgNode.offset);
        const size = Number(pkgNode.size);
        if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(size) || size <= 0 || size > 4 * 1024 * 1024) {
            throw new Error('Invalid package.json slice in ASAR');
        }
        const contentBuf = Buffer.alloc(size);
        if (fs.readSync(fd, contentBuf, 0, size, baseOffset + offset) < size) {
            throw new Error('Truncated package.json inside ASAR');
        }
        return JSON.parse(contentBuf.toString('utf8'));
    } finally {
        fs.closeSync(fd);
    }
}

function cleanupTempArtifacts(resourcesDir) {
    let entries = [];
    try {
        entries = fs.readdirSync(resourcesDir);
    } catch {
        return;
    }
    for (const name of entries) {
        if (name.startsWith('app.asar.new-') || name.startsWith('app.asar.old-') || name.startsWith('app.real.asar.old-')) {
            try { fs.unlinkSync(path.join(resourcesDir, name)); } catch {}
        }
    }
}

function inspectStatus(resourcesDir, installRoot = defaultInstallRoot()) {
    const paths = resolvePaths(installRoot);
    const origAsarPath = path.join(resourcesDir, 'app.asar');
    const realAsarPath = path.join(resourcesDir, REAL_ASAR_FILENAME);
    const appDir = path.join(resourcesDir, 'app');
    const shimPkgPath = path.join(appDir, 'package.json');
    const shimIndexPath = path.join(appDir, 'index.js');

    const origAsarExists = fs.existsSync(origAsarPath);
    const realAsarExists = fs.existsSync(realAsarPath);
    const sourceAsarPath = origAsarExists ? origAsarPath : (realAsarExists ? realAsarPath : null);
    const realPkg = sourceAsarPath ? readPackageJsonFromAsar(sourceAsarPath) : {};

    let shimFilesValid = false;
    let shimVersion = null;
    const runtimeExists = fs.existsSync(paths.runtimeScript);

    if (fs.existsSync(shimPkgPath) && fs.existsSync(shimIndexPath)) {
        try {
            const shimPkg = JSON.parse(fs.readFileSync(shimPkgPath, 'utf8'));
            const shimIndex = fs.readFileSync(shimIndexPath, 'utf8');
            shimVersion = shimPkg.version || null;
            shimFilesValid =
                shimIndex.includes(SHIM_VERSION_TAG) &&
                shimIndex.includes(REAL_ASAR_FILENAME) &&
                shimIndex.includes(JSON.stringify(paths.runtimeScript)) &&
                shimPkg.main === 'index.js' &&
                runtimeExists;
        } catch {
            shimFilesValid = false;
        }
    }

    const active = !origAsarExists && realAsarExists && shimFilesValid && shimVersion === realPkg.version;
    let lastRuntime = null;
    try {
        if (fs.existsSync(paths.runtimeStateFile)) {
            lastRuntime = JSON.parse(fs.readFileSync(paths.runtimeStateFile, 'utf8'));
        }
    } catch {}

    return {
        resourcesDir,
        installRoot: paths.installRoot,
        appVersion: realPkg.version || 'unknown',
        shimTag: SHIM_VERSION_TAG,
        origAsarExists,
        realAsarExists,
        shimVersion,
        versionSynced: shimVersion === realPkg.version,
        runtimeScript: paths.runtimeScript,
        runtimeExists,
        patched: active,
        lastRuntime
    };
}

function isFastPathUnchanged(resourcesDir, installRoot = defaultInstallRoot()) {
    try {
        const paths = resolvePaths(installRoot);
        const origAsarPath = path.join(resourcesDir, 'app.asar');
        const realAsarPath = path.join(resourcesDir, REAL_ASAR_FILENAME);
        const shimIndexPath = path.join(resourcesDir, 'app', 'index.js');
        const shimPkgPath = path.join(resourcesDir, 'app', 'package.json');
        if (
            fs.existsSync(origAsarPath) ||
            !fs.existsSync(realAsarPath) ||
            !fs.existsSync(paths.stateFile) ||
            !fs.existsSync(shimIndexPath) ||
            !fs.existsSync(shimPkgPath) ||
            !fs.existsSync(paths.runtimeScript)
        ) {
            return false;
        }
        const saved = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
        if (!saved || saved.resourcesDir !== resourcesDir || saved.tag !== SHIM_VERSION_TAG || saved.runtimeScript !== paths.runtimeScript) {
            return false;
        }
        const st = fs.statSync(realAsarPath);
        return st.size === saved.asarSize && Math.abs(st.mtimeMs - saved.asarMtimeMs) < 1;
    } catch {
        return false;
    }
}

function saveState(resourcesDir, appVersion, paths) {
    try {
        const realAsarPath = path.join(resourcesDir, REAL_ASAR_FILENAME);
        if (!fs.existsSync(realAsarPath)) return;
        const st = fs.statSync(realAsarPath);
        const state = {
            resourcesDir,
            installRoot: paths.installRoot,
            runtimeScript: paths.runtimeScript,
            asarSize: st.size,
            asarMtimeMs: st.mtimeMs,
            appVersion,
            tag: SHIM_VERSION_TAG,
            updatedAt: new Date().toISOString()
        };
        fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
        fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch {}
}

function isLockError(err) {
    return Boolean(err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES'));
}

function applyShim(resourcesDir, options = {}) {
    const installRoot = options.installRoot || defaultInstallRoot();
    const verbose = Boolean(options.verbose);
    const updateShimFilesOnly = Boolean(options.updateShimFilesOnly);
    const paths = resolvePaths(installRoot);

    if (!fs.existsSync(paths.runtimeScript)) {
        throw new Error(`Missing runtime script: ${paths.runtimeScript}`);
    }

    const origAsarPath = path.join(resourcesDir, 'app.asar');
    const realAsarPath = path.join(resourcesDir, REAL_ASAR_FILENAME);
    cleanupTempArtifacts(resourcesDir);

    const origExists = fs.existsSync(origAsarPath);
    const realExists = fs.existsSync(realAsarPath);
    if (!origExists && !realExists) {
        throw new Error(`Neither app.asar nor ${REAL_ASAR_FILENAME} exists in ${resourcesDir}`);
    }

    const sourceAsarPath = origExists ? origAsarPath : realAsarPath;
    const realPkg = readPackageJsonFromAsar(sourceAsarPath);
    const appVersion = realPkg.version || 'unknown';
    const appDir = path.join(resourcesDir, 'app');
    const shimPkgPath = path.join(appDir, 'package.json');
    const shimIndexPath = path.join(appDir, 'index.js');

    const desiredIndexJs = buildShimIndexJs(paths.runtimeScript);
    new vm.Script(desiredIndexJs, { filename: 'index.js' });

    const desiredPkg = Object.assign({}, realPkg, { main: 'index.js' });
    delete desiredPkg.dependencies;
    delete desiredPkg.devDependencies;
    const desiredPkgJson = JSON.stringify(desiredPkg, null, 2) + '\n';

    if (fs.existsSync(appDir) && !options.force) {
        if (!fs.existsSync(shimIndexPath)) {
            const existingEntries = fs.readdirSync(appDir);
            if (existingEntries.length > 0) {
                throw new Error(`Refusing to overwrite non-empty unrecognized resources/app directory in ${appDir} (use --force if intentional).`);
            }
        } else {
            const existingIndex = fs.readFileSync(shimIndexPath, 'utf8');
            const isOurShim = existingIndex.includes(SHIM_VERSION_TAG);
            const isKnownLegacyShim = existingIndex.includes('ANTIGRAVITY_NATIVE_SHIM_V3');
            if (!isOurShim && !(isKnownLegacyShim && options.allowLegacyShim)) {
                throw new Error(
                    isKnownLegacyShim
                        ? `Detected legacy ANTIGRAVITY_NATIVE_SHIM_V3 in ${shimIndexPath}. Pass -CleanLegacy (or --allow-legacy-shim / --force) to take over.`
                        : `Refusing to overwrite unrecognized resources/app/index.js in ${appDir} (use --force if intentional).`
                );
            }
        }
    }

    fs.mkdirSync(appDir, { recursive: true });
    let wroteShimFiles = false;
    let needsShimWrite = true;
    const prevShimPkgContent = fs.existsSync(shimPkgPath) ? fs.readFileSync(shimPkgPath, 'utf8') : null;
    if (prevShimPkgContent !== null && fs.existsSync(shimIndexPath)) {
        try {
            if (prevShimPkgContent === desiredPkgJson &&
                fs.readFileSync(shimIndexPath, 'utf8') === desiredIndexJs) {
                needsShimWrite = false;
            }
        } catch {}
    }
    if (needsShimWrite) {
        fs.writeFileSync(shimPkgPath, desiredPkgJson, 'utf8');
        fs.writeFileSync(shimIndexPath, desiredIndexJs, 'utf8');
        wroteShimFiles = true;
    }

    if (updateShimFilesOnly && origExists) {
        appendLog(paths.logFile, `Staged shim files for v${appVersion} while app.asar is still present.`);
        return { stagedOnly: true, appVersion };
    }

    let movedAsar = false;
    if (origExists) {
        let backupOldReal = null;
        try {
            if (realExists) {
                backupOldReal = path.join(resourcesDir, `app.real.asar.old-${Date.now()}`);
                fs.renameSync(realAsarPath, backupOldReal);
            }
            fs.renameSync(origAsarPath, realAsarPath);
            movedAsar = true;
            if (backupOldReal) {
                try { fs.unlinkSync(backupOldReal); } catch {}
            }
        } catch (err) {
            if (backupOldReal && fs.existsSync(backupOldReal) && !fs.existsSync(realAsarPath)) {
                try { fs.renameSync(backupOldReal, realAsarPath); } catch {}
            }
            if (wroteShimFiles && realExists && prevShimPkgContent !== null && fs.existsSync(realAsarPath)) {
                try { fs.writeFileSync(shimPkgPath, prevShimPkgContent, 'utf8'); } catch {}
            }
            if (isLockError(err)) {
                const lockMsg = `Antigravity 正在运行并锁定了 app.asar (${err.code})。引导文件已预置，关闭或重启 Antigravity 后将由守护任务自动激活。`;
                appendLog(paths.logFile, `LOCKED in ${resourcesDir}: ${err.code} while renaming app.asar -> ${REAL_ASAR_FILENAME}`);
                if (verbose) console.warn(`[Locked] ${lockMsg}`);
                const lockErr = new Error(lockMsg);
                lockErr.exitCode = 3;
                throw lockErr;
            }
            throw err;
        }
    }

    const verify = inspectStatus(resourcesDir, installRoot);
    if (!verify.patched || !verify.versionSynced) {
        throw new Error(`Post-write verification failed: ${JSON.stringify(verify)}`);
    }

    saveState(resourcesDir, appVersion, paths);
    if (movedAsar || wroteShimFiles) {
        appendLog(paths.logFile, `Activated ${SHIM_VERSION_TAG} for Antigravity v${appVersion} in ${resourcesDir}`);
        if (verbose) {
            console.log(`[Success] Activated Antigravity Plus Shim V3 for v${appVersion} (${appDir} -> ${REAL_ASAR_FILENAME}).`);
        }
        return { activated: true, changed: true, appVersion };
    }

    if (verbose) {
        console.log(`[Check] Antigravity Plus Shim V3 for v${appVersion} is already active.`);
    }
    return { activated: true, changed: false, appVersion };
}

function extractShimRuntimePath(indexContent) {
    const m = /const\s+runtimePath\s*=\s*("(?:\\.|[^"\\])*")\s*;/.exec(String(indexContent || ''));
    if (!m) return '';
    try {
        return JSON.parse(m[1]);
    } catch {
        return '';
    }
}

function normalizePathKey(p) {
    return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function verifyShimOwnershipForRemoval(appDir, expectedRuntimeScript = '') {
    if (!fs.existsSync(appDir)) return { owned: true, empty: true };
    const entries = fs.readdirSync(appDir);
    if (entries.length === 0) return { owned: true, empty: true };
    const allowed = new Set(['index.js', 'package.json']);
    const unexpected = entries.filter(name => !allowed.has(name));
    if (unexpected.length > 0) {
        return {
            owned: false,
            reason: `Refusing to delete ${appDir}: contains unexpected files (${unexpected.join(', ')})`
        };
    }
    const indexPath = path.join(appDir, 'index.js');
    if (!fs.existsSync(indexPath)) {
        return {
            owned: false,
            reason: `Refusing to delete ${appDir}: missing index.js ownership marker`
        };
    }
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    if (!indexContent.includes(SHIM_VERSION_TAG)) {
        return {
            owned: false,
            reason: `Refusing to delete ${appDir}: index.js does not belong to ${SHIM_VERSION_TAG}`
        };
    }
    if (expectedRuntimeScript) {
        const boundRuntime = extractShimRuntimePath(indexContent);
        if (!boundRuntime || normalizePathKey(boundRuntime) !== normalizePathKey(expectedRuntimeScript)) {
            return {
                owned: false,
                reason: `Refusing to delete ${appDir}: shim belongs to another installRoot (${boundRuntime || 'unknown'}), expected ${expectedRuntimeScript}`
            };
        }
    }
    return { owned: true, empty: false };
}

function removeShim(resourcesDir, installRoot = defaultInstallRoot()) {
    const paths = resolvePaths(installRoot);
    cleanupTempArtifacts(resourcesDir);
    const origAsarPath = path.join(resourcesDir, 'app.asar');
    const realAsarPath = path.join(resourcesDir, REAL_ASAR_FILENAME);
    const appDir = path.join(resourcesDir, 'app');

    const ownership = verifyShimOwnershipForRemoval(appDir, paths.runtimeScript);
    if (!ownership.owned) {
        console.error(`[Refused] ${ownership.reason}`);
        appendLog(paths.logFile, `REFUSED restore in ${resourcesDir}: ${ownership.reason}`);
        return 2;
    }
    if (ownership.empty && fs.existsSync(realAsarPath)) {
        let stateMatches = false;
        if (fs.existsSync(paths.stateFile)) {
            try {
                const st = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
                if (st && st.resourcesDir && normalizePathKey(st.resourcesDir) === normalizePathKey(resourcesDir)) {
                    stateMatches = true;
                }
            } catch {}
        }
        if (!stateMatches) {
            const msg = `Refusing to touch ${realAsarPath}: no matching ${SHIM_VERSION_TAG} shim or bound patch_state.json found for ${resourcesDir}`;
            console.error(`[Refused] ${msg}`);
            appendLog(paths.logFile, msg);
            return 2;
        }
    }

    if (fs.existsSync(realAsarPath)) {
        if (!fs.existsSync(origAsarPath)) {
            try {
                fs.renameSync(realAsarPath, origAsarPath);
                appendLog(paths.logFile, `Restored ${REAL_ASAR_FILENAME} -> app.asar in ${resourcesDir}`);
                console.log(`[Restore] Restored ${REAL_ASAR_FILENAME} -> app.asar.`);
            } catch (err) {
                if (isLockError(err)) {
                    console.error(`[Locked] Antigravity is running and locking ${REAL_ASAR_FILENAME} (${err.code}). Exit Antigravity first.`);
                    return 3;
                }
                throw err;
            }
        } else {
            try {
                fs.unlinkSync(realAsarPath);
                appendLog(paths.logFile, `Removed stale ${REAL_ASAR_FILENAME} while keeping existing app.asar`);
            } catch (err) {
                if (isLockError(err)) {
                    console.error(`[Locked] Cannot remove ${REAL_ASAR_FILENAME} (${err.code}). Exit Antigravity first.`);
                    return 3;
                }
                throw err;
            }
        }
    }

    if (fs.existsSync(appDir)) {
        fs.rmSync(appDir, { recursive: true, force: true });
        appendLog(paths.logFile, `Removed shim directory ${appDir}`);
        console.log(`[Restore] Removed shim directory (${appDir}); pure stock loading restored.`);
    }

    if (fs.existsSync(paths.stateFile)) {
        try { fs.unlinkSync(paths.stateFile); } catch {}
    }
    return 0;
}

function main() {
    const opts = parseArgs(process.argv);
    const origAsarPath = path.join(opts.resourcesDir, 'app.asar');
    const realAsarPath = path.join(opts.resourcesDir, REAL_ASAR_FILENAME);
    if (!fs.existsSync(origAsarPath) && !fs.existsSync(realAsarPath)) {
        if (opts.restore) {
            const paths = resolvePaths(opts.installRoot);
            const appDir = path.join(opts.resourcesDir, 'app');
            const own = verifyShimOwnershipForRemoval(appDir, paths.runtimeScript);
            if (!own.owned) {
                console.error(`[Refused] ${own.reason}`);
                process.exit(2);
            }
            if (fs.existsSync(appDir)) {
                fs.rmSync(appDir, { recursive: true, force: true });
            }
            process.exit(0);
        }
        if (opts.verbose) {
            console.error(`[Error] Neither app.asar nor ${REAL_ASAR_FILENAME} found in: ${opts.resourcesDir}`);
        }
        process.exit(2);
    }

    if (opts.checkOnly) {
        const info = inspectStatus(opts.resourcesDir, opts.installRoot);
        console.log(JSON.stringify(info, null, 2));
        process.exit(info.patched ? 0 : 2);
    }

    if (opts.restore) {
        process.exit(removeShim(opts.resourcesDir, opts.installRoot));
    }

    if (!opts.force && !opts.verbose && !opts.updateShimFilesOnly && isFastPathUnchanged(opts.resourcesDir, opts.installRoot)) {
        process.exit(0);
    }

    try {
        applyShim(opts.resourcesDir, opts);
    } catch (err) {
        if (err && err.exitCode === 3) {
            process.exit(3);
        }
        const paths = resolvePaths(opts.installRoot);
        appendLog(paths.logFile, `ERROR in ${opts.resourcesDir}: ${err && err.stack ? err.stack : err}`);
        if (opts.verbose) console.error('[Error]', err);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    SHIM_VERSION_TAG,
    REAL_ASAR_FILENAME,
    buildShimIndexJs,
    inspectStatus,
    applyShim,
    removeShim
};
