'use strict';
const fs = require('node:fs');
const { defaultInstallRoot } = require('../core/config-manager.cjs');
const { isValidConversationId } = require('./toast-client.cjs');
const { sendBridgeRequest } = require('../main/bridge-client.cjs');

async function submitQuestionAnswers(conversationId, selections, options = {}) {
    if (!isValidConversationId(conversationId)) {
        throw new Error('Invalid conversation ID');
    }
    if (!Array.isArray(selections)) {
        throw new Error('Invalid selections payload');
    }
    const installRoot = options.installRoot || defaultInstallRoot();
    const res = await sendBridgeRequest({
        action: 'submit_question',
        conversationId,
        selections
    }, {
        pipeName: options.bridgePipeName,
        installRoot,
        timeoutMs: 9000
    });
    if (res && res.ok) {
        if (res.submitted) {
            try {
                await sendBridgeRequest({ action: 'sync_now' }, {
                    pipeName: options.bridgePipeName,
                    installRoot,
                    timeoutMs: 1200
                });
            } catch {}
        }
        return res;
    }
    return { submitted: false, error: res?.error || 'bridge_failed' };
}

if (require.main === module) {
    const conversationId = process.argv[2] || '';
    let selections = [];
    try {
        const input = process.argv[3] === '--stdin' ? fs.readFileSync(0, 'utf8') : process.argv[3];
        selections = JSON.parse(input || '[]');
    } catch {
        process.exitCode = 1;
    }
    if (process.exitCode !== 1) {
        submitQuestionAnswers(conversationId, selections)
            .then(res => {
                if (!res?.submitted) process.exitCode = 2;
            })
            .catch(() => {
                process.exitCode = 1;
            });
    }
}

module.exports = { submitQuestionAnswers };
