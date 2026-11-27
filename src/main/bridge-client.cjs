'use strict';
const net = require('node:net');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { defaultInstallRoot } = require('../core/config-manager.cjs');

function computeHash20(text) {
    return crypto.createHash('sha256').update(String(text).toLowerCase(), 'utf8').digest('hex').slice(0, 20);
}

function defaultBridgePipeName(installRoot = defaultInstallRoot()) {
    return `AgyPlus-MainBridge-${computeHash20(installRoot)}`;
}

function bridgePipePath(pipeName) {
    if (typeof pipeName === 'string' && pipeName.startsWith('\\\\.\\pipe\\')) {
        return pipeName;
    }
    return `\\\\.\\pipe\\${pipeName || defaultBridgePipeName()}`;
}

function sendSinglePipeRequest(pipeName, message, timeoutMs = 6000) {
    const pipePath = bridgePipePath(pipeName);
    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = '';
        const decoder = new StringDecoder('utf8');
        const socket = net.createConnection(pipePath);
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new Error('MainBridge pipe request timed out'));
        }, timeoutMs);

        const finish = (err, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve(value);
        };

        socket.on('connect', () => {
            try {
                socket.write(JSON.stringify(message) + '\n', 'utf8');
            } catch (err) {
                socket.destroy();
                finish(err);
            }
        });

        socket.on('data', chunk => {
            buffer += decoder.write(chunk);
            const nl = buffer.indexOf('\n');
            if (nl !== -1 && !settled) {
                const line = buffer.slice(0, nl).trim();
                socket.end();
                try {
                    finish(null, JSON.parse(line));
                } catch (err) {
                    finish(err);
                }
            }
        });

        socket.on('error', err => finish(err));

        socket.on('end', () => {
            if (settled) return;
            buffer += decoder.end();
            const line = buffer.trim();
            if (!line) {
                finish(new Error('Empty MainBridge pipe response'));
                return;
            }
            try {
                finish(null, JSON.parse(line));
            } catch (err) {
                finish(err);
            }
        });
    });
}

async function sendBridgeRequest(message, options = {}) {
    const installRoot = options.installRoot || defaultInstallRoot();
    const primaryPipe = options.pipeName || defaultBridgePipeName(installRoot);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
    try {
        return await sendSinglePipeRequest(primaryPipe, message, timeoutMs);
    } catch (primaryErr) {
        if (options.fallbackPipeName) {
            return await sendSinglePipeRequest(options.fallbackPipeName, message, timeoutMs);
        }
        throw primaryErr;
    }
}

async function isBridgeAlive(options = {}) {
    try {
        const res = await sendBridgeRequest({ action: 'ping' }, {
            ...options,
            timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 500
        });
        return Boolean(res && res.ok);
    } catch {
        return false;
    }
}

module.exports = {
    computeHash20,
    defaultBridgePipeName,
    bridgePipePath,
    sendBridgeRequest,
    isBridgeAlive
};
