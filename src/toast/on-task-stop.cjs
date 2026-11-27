'use strict';
const { defaultInstallRoot, loadConfig } = require('../core/config-manager.cjs');
const { sendBridgeRequest } = require('../main/bridge-client.cjs');
const {
    extractPromptText,
    extractWorkspaceName,
    inspectTranscriptFile,
    shouldNotifyFromStopPayload,
    sendToastRequest
} = require('./toast-client.cjs');

function readStdin(timeoutMs = 3000) {
    return new Promise(resolve => {
        const chunks = [];
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            try { process.stdin.destroy(); } catch {}
            finish(Buffer.concat(chunks).toString('utf8'));
        }, timeoutMs);
        timer.unref?.();
        process.stdin.on('data', chunk => chunks.push(chunk));
        process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', () => finish(''));
    });
}

async function queryRendererSnapshot(conversationId, timeoutMs = 300, options = {}) {
    try {
        const res = await sendBridgeRequest({
            action: 'renderer_snapshot',
            conversationId
        }, {
            pipeName: options.bridgePipeName,
            installRoot: options.installRoot,
            timeoutMs
        });
        if (res && res.ok) {
            return {
                activeConversationId: res.activeConversationId || '',
                uiTitle: res.uiTitle || '',
                windowFocused: res.windowFocused
            };
        }
    } catch {}
    return null;
}

async function processStopPayload(payload, options = {}) {
    if (payload?.hookEventName === 'PreToolUse' || payload?.toolCall) {
        return { skipped: 'native_interaction' };
    }
    const installRoot = options.installRoot || defaultInstallRoot();
    const cfg = loadConfig({ installRoot });
    if (cfg.features.taskToast === false) {
        return { skipped: 'disabled' };
    }
    if (!shouldNotifyFromStopPayload(payload)) {
        return { skipped: 'not_eligible' };
    }

    const transcript = inspectTranscriptFile(payload.transcriptPath);
    if (transcript.isSubagent) return { skipped: 'subagent' };

    const conversationId = payload.conversationId;
    const snapshot = options.rendererSnapshot !== undefined
        ? options.rendererSnapshot
        : await queryRendererSnapshot(conversationId, options.rendererTimeoutMs ?? 300, { ...options, installRoot });

    const promptTitle = transcript.firstPromptTitle ||
        extractPromptText(payload.lastUserInput) ||
        transcript.lastPromptTitle;
    const title = (snapshot?.uiTitle && snapshot.uiTitle.trim()) ||
        promptTitle ||
        `Conversation ${conversationId.slice(0, 8)}`;
    const workspace = extractWorkspaceName(payload.workspacePaths, payload.cwd);
    const turnKey = transcript.turnKey ||
        (payload.lastUserInput ? `input:${extractPromptText(payload.lastUserInput, 120)}:${payload.executionNum ?? 0}` : '');

    const request = {
        action: 'notify',
        kind: 'completed',
        statusLabel: 'Task completed',
        conversationId,
        title,
        workspace,
        turnKey
    };
    if (snapshot && snapshot.windowFocused === true && typeof snapshot.activeConversationId === 'string') {
        request.activeConversationId = snapshot.activeConversationId;
    }

    return await sendToastRequest(request, {
        installRoot,
        pipeName: options.pipeName,
        exePath: options.exePath,
        ensureRunning: options.ensureRunning !== false
    });
}

async function runHook(options = {}) {
    let response = '{}';
    try {
        const raw = await readStdin();
        if (raw.trim()) {
            const payload = JSON.parse(raw);
            if (payload?.hookEventName === 'PreToolUse' || payload?.toolCall) {
                response = '{"decision":"allow"}';
            } else {
                await processStopPayload(payload, options);
            }
        }
    } catch {}
    process.stdout.write(response + '\n');
}

if (require.main === module) {
    void runHook();
}

module.exports = { processStopPayload, queryRendererSnapshot, runHook };
