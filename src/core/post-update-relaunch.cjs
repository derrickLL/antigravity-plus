'use strict';

/**
 * Antigravity Plus Post-Update Relaunch Helper
 *
 * Spawned detached outside the Antigravity installation directory when an NSIS updater
 * is triggered. Waits for the old app and installer to exit, rebuilds the V3 shim once
 * `app.asar` stabilizes, and relaunches `Antigravity.exe` if `--relaunch 1` was requested.
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { defaultInstallRoot } = require('./config-manager.cjs');
const { resolveJsRunner } = require('./node-runner.cjs');
const patchManager = require('./patch-antigravity.cjs');

const INSTALL_ROOT = defaultInstallRoot();
const LOG_FILE = path.join(INSTALL_ROOT, 'logs', 'patch.log');
const PATCH_SCRIPT = path.join(__dirname, 'patch-antigravity.cjs');

function appendLog(msg) {
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [PostUpdate] ${msg}\n`, 'utf8');
    } catch {}
}

function parseArgs(argv) {
    const opts = {
        parentPid: 0,
        installerPid: 0,
        relaunch: false,
        relaunchArgs: [],
        exePath: '',
        resourcesDir: '',
        patchScript: PATCH_SCRIPT,
        timeoutMs: 180000,
        stableMs: 1500,
        pollMs: 500,
        skipTasklist: false,
        prevVersion: '',
        prevRealSnap: ''
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = argv[i + 1];
        if (a === '--parent-pid' && next !== undefined) opts.parentPid = Number(argv[++i]) || 0;
        else if (a === '--installer-pid' && next !== undefined) opts.installerPid = Number(argv[++i]) || 0;
        else if (a === '--relaunch' && next !== undefined) {
            const v = String(argv[++i]).toLowerCase();
            opts.relaunch = v === '1' || v === 'true';
        } else if (a === '--relaunch-arg' && next !== undefined) opts.relaunchArgs.push(argv[++i]);
        else if (a === '--exe' && next !== undefined) opts.exePath = path.resolve(argv[++i]);
        else if (a === '--resources-dir' && next !== undefined) opts.resourcesDir = path.resolve(argv[++i]);
        else if (a === '--patch-script' && next !== undefined) opts.patchScript = path.resolve(argv[++i]);
        else if (a === '--timeout-ms' && next !== undefined) opts.timeoutMs = Number(argv[++i]) || 180000;
        else if (a === '--stable-ms' && next !== undefined) opts.stableMs = Number(argv[++i]) || 1500;
        else if (a === '--poll-ms' && next !== undefined) opts.pollMs = Number(argv[++i]) || 500;
        else if (a === '--prev-version' && next !== undefined) opts.prevVersion = String(argv[++i] || '').trim();
        else if (a === '--prev-real-snap' && next !== undefined) opts.prevRealSnap = String(argv[++i] || '').trim();
        else if (a === '--skip-tasklist') opts.skipTasklist = true;
    }
    if (!opts.resourcesDir && opts.exePath) {
        opts.resourcesDir = path.join(path.dirname(opts.exePath), 'resources');
    }
    return opts;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return Boolean(err && err.code === 'EPERM');
    }
}

function listRunningUpdaterImages() {
    if (process.platform !== 'win32') return [];
    try {
        const out = cp.execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
            timeout: 3000,
            windowsHide: true
        });
        const hits = [];
        for (const line of out.split(/\r?\n/)) {
            const m = /^"([^"]+)"/.exec(line.trim());
            if (!m) continue;
            const img = m[1];
            if (/^Antigravity-x64\.exe$/i.test(img) || /^Au_\.exe$/i.test(img) || /^Uninstall Antigravity\.exe$/i.test(img)) {
                hits.push(img);
            }
        }
        return hits;
    } catch {
        return [];
    }
}

function snapshotFiles(paths) {
    const snaps = [];
    for (const p of paths) {
        try {
            const st = fs.statSync(p);
            if (!st.isFile() || st.size <= 0) return null;
            snaps.push(`${st.size}:${Math.floor(st.mtimeMs)}`);
        } catch {
            return null;
        }
    }
    return snaps.join('|');
}

async function waitUntil(checkFn, deadline, pollMs) {
    while (Date.now() < deadline) {
        if (await checkFn()) return true;
        await sleep(pollMs);
    }
    return false;
}

async function main() {
    const opts = parseArgs(process.argv);
    const deadline = Date.now() + opts.timeoutMs;
    appendLog(`Started post-update watcher: parentPid=${opts.parentPid}, installerPid=${opts.installerPid}, relaunch=${opts.relaunch}`);

    if (opts.parentPid > 0) {
        await waitUntil(() => !isPidAlive(opts.parentPid), deadline, opts.pollMs);
    }
    if (opts.installerPid > 0) {
        await waitUntil(() => !isPidAlive(opts.installerPid), deadline, opts.pollMs);
    }
    if (!opts.skipTasklist) {
        let quietRounds = 0;
        await waitUntil(() => {
            const active = listRunningUpdaterImages();
            if (active.length === 0) {
                quietRounds += 1;
                return quietRounds >= 2;
            }
            quietRounds = 0;
            return false;
        }, deadline, opts.pollMs);
    }

    const asarPath = path.join(opts.resourcesDir, 'app.asar');
    const realAsarPath = path.join(opts.resourcesDir, patchManager.REAL_ASAR_FILENAME);
    const watchTargets = opts.exePath ? [opts.exePath, asarPath] : [asarPath];
    let lastSnap = null;
    let stableSince = 0;
    let alreadyPatchedByGuard = false;
    const hasPreUpdateBaseline = Boolean(opts.prevVersion || opts.prevRealSnap);
    const archiveReady = await waitUntil(() => {
        if (!fs.existsSync(asarPath)) {
            try {
                const st = patchManager.inspectStatus(opts.resourcesDir, INSTALL_ROOT);
                if (st && st.patched && st.versionSynced) {
                    if (!hasPreUpdateBaseline) {
                        alreadyPatchedByGuard = true;
                        return true;
                    }
                    const currentRealSnap = snapshotFiles([realAsarPath]) || '';
                    const versionChanged = Boolean(opts.prevVersion && st.appVersion && st.appVersion !== 'unknown' && st.appVersion !== opts.prevVersion);
                    const snapChanged = Boolean(opts.prevRealSnap && currentRealSnap && currentRealSnap !== opts.prevRealSnap);
                    if (versionChanged || snapChanged) {
                        alreadyPatchedByGuard = true;
                        return true;
                    }
                }
            } catch {}
        }
        const snap = snapshotFiles(watchTargets);
        if (!snap) {
            lastSnap = null;
            stableSince = 0;
            return false;
        }
        if (snap === lastSnap) {
            return Date.now() - stableSince >= opts.stableMs;
        }
        lastSnap = snap;
        stableSince = Date.now();
        return false;
    }, deadline, opts.pollMs);

    if (!archiveReady && !alreadyPatchedByGuard) {
        appendLog(`ERROR: Timed out waiting for valid Antigravity archive in ${opts.resourcesDir}`);
        process.exitCode = 1;
        return;
    }

    const runner = resolveJsRunner(process.env, opts.exePath);
    let patched = alreadyPatchedByGuard;
    if (alreadyPatchedByGuard) {
        appendLog('Shim already active and version-synced (rebuilt concurrently by guard).');
    }
    for (let attempt = 1; !patched && attempt <= 5 && runner; attempt++) {
        try {
            const res = cp.spawnSync(
                runner.command,
                [opts.patchScript, '--verbose', '--target', opts.resourcesDir, '--install-root', INSTALL_ROOT],
                {
                    cwd: INSTALL_ROOT,
                    env: runner.env,
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 15000
                }
            );
            if (res.status === 0) {
                const check = patchManager.inspectStatus(opts.resourcesDir, INSTALL_ROOT);
                if (check && check.patched && check.versionSynced) {
                    patched = true;
                    appendLog(`Rebuilt shim on attempt ${attempt}`);
                    break;
                }
            }
            appendLog(`Attempt ${attempt} failed (exit=${res.status}): ${(res.stderr || res.stdout || '').trim()}`);
        } catch (err) {
            appendLog(`Attempt ${attempt} error: ${err && err.message ? err.message : err}`);
        }
        await sleep(1000);
    }

    if (!patched) {
        appendLog(`ERROR: Unable to activate shim in ${opts.resourcesDir}`);
        process.exitCode = 1;
    }

    if (opts.relaunch && opts.exePath && fs.existsSync(opts.exePath)) {
        try {
            const launchEnv = { ...process.env };
            delete launchEnv.ELECTRON_RUN_AS_NODE;
            delete launchEnv.NODE_OPTIONS;
            delete launchEnv.HTTP_PROXY;
            delete launchEnv.HTTPS_PROXY;
            delete launchEnv.NO_PROXY;
            delete launchEnv.ALL_PROXY;
            const child = cp.spawn(opts.exePath, opts.relaunchArgs, {
                cwd: path.dirname(opts.exePath),
                env: launchEnv,
                detached: true,
                stdio: 'ignore',
                windowsHide: false
            });
            child.unref();
            appendLog(`Relaunched native Antigravity.exe (PID=${child.pid || 'unknown'}, patched=${patched}).`);
        } catch (err) {
            appendLog(`ERROR relaunching ${opts.exePath}: ${err && err.stack ? err.stack : err}`);
            process.exitCode = 1;
        }
    }
}

main().catch(err => {
    appendLog(`Fatal error: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
});
