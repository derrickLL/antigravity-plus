'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { defaultInstallRoot } = require('../core/config-manager.cjs');
const { computeHash20 } = require('../main/bridge-client.cjs');

const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9._-]+$/;

function defaultPipeName(installRoot = defaultInstallRoot()) {
    return `AgyPlus-TaskToast-${computeHash20(installRoot)}`;
}

function defaultToastExePath(installRoot = defaultInstallRoot()) {
    const inBin = path.join(installRoot, 'bin', 'TaskToastHost.exe');
    if (fs.existsSync(inBin)) return inBin;
    return path.join(__dirname, 'TaskToastHost.exe');
}

function isValidConversationId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 128 &&
        SAFE_CONVERSATION_ID_RE.test(id) && !/^\.+$/.test(id);
}

function extractPromptText(raw, maxLength = 72) {
    if (typeof raw !== 'string' || !raw.trim()) return '';
    let body = raw;
    const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(body);
    if (reqMatch) {
        body = reqMatch[1];
    } else {
        body = body
            .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
            .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
            .replace(/<[^>]+>/g, ' ');
    }
    body = body
        .replace(/\[([^\]]+)\]\((?:file|https?|conversation|customization|sidecar):\/\/[^)]*\)/gi, '$1')
        .replace(/[`*_~#>]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!body) return '';
    if (body.length > maxLength) {
        return body.slice(0, maxLength - 1).trimEnd() + '…';
    }
    return body;
}

function extractWorkspaceName(workspacePaths, cwd) {
    const candidates = [];
    if (Array.isArray(workspacePaths)) candidates.push(...workspacePaths);
    if (typeof cwd === 'string' && cwd.trim()) candidates.push(cwd);
    for (const item of candidates) {
        if (typeof item !== 'string' || !item.trim()) continue;
        const clean = item.trim().replace(/[\\/]+$/, '');
        const base = path.basename(clean);
        if (base && base !== '.' && base !== '..') return base;
    }
    return 'Antigravity';
}

function inspectTranscriptFile(transcriptPath) {
    const info = {
        readable: false,
        isSubagent: false,
        firstPromptTitle: '',
        lastPromptTitle: '',
        turnKey: ''
    };
    if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return info;
    let content;
    try {
        if (!fs.existsSync(transcriptPath)) return info;
        const st = fs.statSync(transcriptPath);
        if (st.size <= 2 * 1024 * 1024) {
            content = fs.readFileSync(transcriptPath, 'utf8');
        } else {
            const fd = fs.openSync(transcriptPath, 'r');
            try {
                const headLen = Math.min(256 * 1024, st.size);
                const tailLen = Math.min(512 * 1024, st.size - headLen);
                const headBuf = Buffer.alloc(headLen);
                const tailBuf = Buffer.alloc(tailLen);
                fs.readSync(fd, headBuf, 0, headLen, 0);
                fs.readSync(fd, tailBuf, 0, tailLen, st.size - tailLen);
                const headStr = headBuf.toString('utf8');
                const tailStr = tailBuf.toString('utf8');
                const tailNl = tailStr.indexOf('\n');
                content = headStr + '\n' + (tailNl >= 0 ? tailStr.slice(tailNl + 1) : tailStr);
            } finally {
                fs.closeSync(fd);
            }
        }
    } catch {
        return info;
    }
    info.readable = true;
    const lines = content.split(/\r?\n/);
    let firstStepChecked = false;
    let lastUserStepKey = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let step;
        try { step = JSON.parse(line); } catch { continue; }
        if (!firstStepChecked) {
            firstStepChecked = true;
            const src = String(step?.source ?? '').toUpperCase();
            const text = typeof step?.content === 'string' ? step.content : '';
            if ((src === 'MODEL' || src === 'SYSTEM_SDK' || src === '2' || src === '6') && !/<USER_REQUEST>/i.test(text)) {
                info.isSubagent = true;
                return info;
            }
            if (src === 'SYSTEM' && !/<USER_REQUEST>/i.test(text) && step?.type !== 'USER_INPUT') {
                info.isSubagent = true;
                return info;
            }
        }
        if (step?.type === 'USER_INPUT') {
            const src = String(step?.source ?? '').toUpperCase();
            const isModelOrSystem = src === 'MODEL' || src === 'SYSTEM' || src === 'SYSTEM_SDK' ||
                src === '2' || src === '5' || src === '6';
            const text = typeof step?.content === 'string' ? step.content : '';
            if (!isModelOrSystem || /<USER_REQUEST>/i.test(text)) {
                const extracted = extractPromptText(text);
                if (extracted) {
                    if (!info.firstPromptTitle) info.firstPromptTitle = extracted;
                    info.lastPromptTitle = extracted;
                }
                lastUserStepKey = `step:${step.step_index ?? i}:${step.created_at ?? ''}`;
            }
        }
    }
    info.turnKey = lastUserStepKey;
    return info;
}

function shouldNotifyFromStopPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (!isValidConversationId(payload.conversationId)) return false;
    if (payload.fullyIdle === false) return false;
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) return false;
    const reason = String(payload.terminationReason || 'NO_TOOL_CALL').toUpperCase();
    if (reason === 'USER_CANCELED' || reason === 'ERROR' || reason === 'TERMINAL_CUSTOM_HOOK') {
        return false;
    }
    return reason === 'NO_TOOL_CALL' || reason === 'INJECTED_RESPONSE' || reason === 'TERMINAL_STEP_TYPE';
}

function sendRawPipeRequest(pipeName, message, timeoutMs = 3000) {
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = '';
        const decoder = new StringDecoder('utf8');
        const socket = net.createConnection(pipePath);
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new Error('TaskToast pipe request timed out'));
        }, timeoutMs);

        socket.on('connect', () => {
            socket.write(JSON.stringify(message) + '\n', 'utf8');
        });
        socket.on('data', chunk => {
            buffer += decoder.write(chunk);
            const nl = buffer.indexOf('\n');
            if (nl !== -1 && !settled) {
                settled = true;
                clearTimeout(timer);
                socket.end();
                const line = buffer.slice(0, nl).trim();
                try { resolve(JSON.parse(line)); } catch (err) { reject(err); }
            }
        });
        socket.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        socket.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            buffer += decoder.end();
            const line = buffer.trim();
            if (!line) {
                reject(new Error('Empty TaskToast pipe response'));
                return;
            }
            try { resolve(JSON.parse(line)); } catch (err) { reject(err); }
        });
    });
}

function buildToastHostArgs(installRoot, options = {}) {
    const args = ['--install-root', installRoot];
    if (options.pipeName) {
        args.push('--pipe-name', options.pipeName);
    }
    if (options.testForegroundAg !== undefined && options.testForegroundAg !== null) {
        args.push('--test-foreground-ag', String(options.testForegroundAg));
    }
    if (options.openLogPath) {
        args.push('--open-log', options.openLogPath);
    }
    if (options.submitLogPath) {
        args.push('--submit-log', options.submitLogPath);
    }
    if (options.allowCurrentDesktop) {
        args.push('--allow-current-desktop');
    }
    return args;
}

function isTestToastLaunch(options = {}) {
    const p = typeof options.pipeName === 'string' ? options.pipeName : '';
    const isTestPipe = p.startsWith('AgyPlus-TaskToast-Test-') || p.startsWith('Derrick-TaskToast-Test-');
    return isTestPipe || Boolean(options.openLogPath) || Boolean(options.submitLogPath) ||
        (options.testForegroundAg !== undefined && options.testForegroundAg !== null);
}

function cleanChildEnv(installRoot) {
    const env = { ...process.env, AGY_PLUS_ROOT: installRoot };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PSModulePath;
    return env;
}

function quoteWinArg(arg) {
    const text = String(arg ?? '').replace(/[\r\n]+/g, ' ');
    let out = '"';
    let slashes = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\') {
            slashes++;
            continue;
        }
        if (ch === '"') {
            out += '\\'.repeat(slashes * 2 + 1) + '"';
        } else {
            out += '\\'.repeat(slashes) + ch;
        }
        slashes = 0;
    }
    out += '\\'.repeat(slashes * 2) + '"';
    return out;
}

function spawnToastHostViaWmi(exePath, args, installRoot, env) {
    const fullCmdLine = [exePath, ...args].map(quoteWinArg).join(' ');
    const escPs = s => String(s).replace(/'/g, "''");
    const psScript = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escPs(fullCmdLine)}'; CurrentDirectory = '${escPs(installRoot)}' } | Out-Null`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    // Do NOT pass detached:true to powershell.exe: on Windows without an interactive console,
    // detached powershell.exe silently exits with code 0 before running commands.
    const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-EncodedCommand',
        encoded
    ], {
        cwd: installRoot,
        detached: false,
        windowsHide: true,
        stdio: 'ignore',
        env
    });
    ps.unref();
    return ps.pid;
}

function spawnToastHost(options = {}) {
    const installRoot = options.installRoot || defaultInstallRoot();
    const exePath = options.exePath || defaultToastExePath(installRoot);
    if (!fs.existsSync(exePath)) {
        throw new Error(`TaskToastHost executable not found: ${exePath}`);
    }
    const args = buildToastHostArgs(installRoot, options);
    const env = cleanChildEnv(installRoot);

    if (options.launchMethod === 'wmi' && !isTestToastLaunch(options)) {
        return spawnToastHostViaWmi(exePath, args, installRoot, env);
    }

    // Launch the WinExe host directly (~100ms startup, zero PowerShell dependency).
    // When spawned from a non-interactive/isolated desktop (e.g., exebox-*), TaskToastHost.exe
    // detects its desktop name via Win32 and self-relaunches onto WinSta0\Default via WMI.
    const child = spawn(exePath, args, {
        cwd: installRoot,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env
    });
    child.unref();
    return child.pid;
}

async function ensureToastHostRunning(options = {}) {
    const installRoot = options.installRoot || defaultInstallRoot();
    const pipeName = options.pipeName || defaultPipeName(installRoot);
    try {
        const status = await sendRawPipeRequest(pipeName, { action: 'status' }, 800);
        if (status?.running) return status;
    } catch {}

    const launchOpts = { ...options, installRoot, pipeName };
    const isTest = isTestToastLaunch(launchOpts);
    const totalTimeoutMs = options.startupTimeoutMs || (isTest ? 5000 : 8000);
    const startAt = Date.now();
    const deadline = startAt + totalTimeoutMs;

    spawnToastHost(launchOpts);
    let wmiFallbackTriggered = false;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 90));
        try {
            const status = await sendRawPipeRequest(pipeName, { action: 'status' }, 800);
            if (status?.running) return status;
        } catch {}
        if (!isTest && !wmiFallbackTriggered && (Date.now() - startAt) >= 1800) {
            wmiFallbackTriggered = true;
            try {
                spawnToastHost({ ...launchOpts, launchMethod: 'wmi' });
            } catch {}
        }
    }
    throw new Error('TaskToastHost did not become ready in time');
}

async function sendToastRequest(message, options = {}) {
    const installRoot = options.installRoot || defaultInstallRoot();
    const pipeName = options.pipeName || defaultPipeName(installRoot);
    const ensureRunning = options.ensureRunning !== false;
    const reqTimeout = options.timeoutMs || 3500;
    try {
        return await sendRawPipeRequest(pipeName, message, reqTimeout);
    } catch (firstErr) {
        if (!ensureRunning) throw firstErr;
        await ensureToastHostRunning({ ...options, installRoot, pipeName });
        return await sendRawPipeRequest(pipeName, message, reqTimeout);
    }
}

if (require.main === module) {
    const cmd = process.argv[2] || 'status';
    const actionMap = {
        status: { action: 'status' },
        'dismiss-all': { action: 'dismiss_all' },
        shutdown: { action: 'shutdown' }
    };
    const msg = actionMap[cmd];
    if (!msg) {
        console.error('Usage: node toast-client.cjs <status|dismiss-all|shutdown>');
        process.exit(1);
    }
    sendToastRequest(msg, { ensureRunning: cmd === 'status' })
        .then(res => console.log(JSON.stringify(res, null, 2)))
        .catch(err => {
            console.log(JSON.stringify({ running: false, error: err.message }, null, 2));
            if (cmd === 'status') process.exitCode = 1;
        });
}

module.exports = {
    defaultPipeName,
    defaultToastExePath,
    isValidConversationId,
    extractPromptText,
    extractWorkspaceName,
    inspectTranscriptFile,
    shouldNotifyFromStopPayload,
    ensureToastHostRunning,
    sendToastRequest
};
