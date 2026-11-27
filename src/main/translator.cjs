'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const tls = require('node:tls');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const os = require('node:os');
const { defaultInstallRoot, loadConfig, resolveOfflineTranslatorRoot } = require('../core/config-manager.cjs');
const { validateLoopbackHttpProxy, resolveProxyUrl } = require('../core/runtime.cjs');

let child;
let activeOfflineRoot = '';
let lastOfflineCacheRoot = '';
let sequence = 0;
let idleTimer;
const pending = new Map();
let limits;
const measurements = { peakCpuPercent: 0, peakWorkingSetBytes: 0, peakCommitBytes: 0 };

const onlineSentenceCache = new Map();
const offlineSentenceCache = new Map();
const CACHE_LIMIT = 512;

const directAgent = new https.Agent({ keepAlive: true, maxSockets: 6, timeout: 15000 });
let cachedProxyUrl = '';
let cachedProxyAt = 0;
let proxyAgent = null;

const cooldownUntil = {
    googleClients5: 0,
    alibaba: 0,
    googleGtx: 0
};

let alibabaAuth = {
    token: '',
    headerName: '',
    cookie: '',
    expiresAt: 0
};

const PROTECTED_TERMS = [
    /\bAntigravity\b/g,
    /\bONNX\s+Runtime\b/gi,
    /\bPyTorch\b/g,
    /\bTensorRT(?:-LLM)?\b/g,
    /\bvLLM\b/g,
    /\bFlashAttention(?:-2|-3)?\b/g,
    /\bDeepSpeed\b/g,
    /\bMegatron-LM\b/g,
    /\bTorchScript\b/g,
    /\bHugging\s+Face\b/g,
    /\bCTranslate2\b/g,
    /\bSentencePiece\b/g,
    /\bOpenNMT\b/g,
    /\bPlaywright\b/g
];

const AI_CONTEXT_RE = /\b(DDP|AMP|PyTorch|torch|CUDA|GPU|ONNX|TensorRT|model|neural|network|epoch|batch|gradient|loss|fine-?tun\w*|pre-?train\w*|checkpoint|policy|RL|VLA|inference|dataset|compiler|compile|quantiz\w*)\b/i;

class ProxyHttpsAgent extends https.Agent {
    constructor(proxyUrl) {
        super({ keepAlive: true, maxSockets: 6, timeout: 15000 });
        this.proxy = new URL(proxyUrl);
    }
    createConnection(options, callback) {
        let settled = false;
        const done = (err, sock) => {
            if (settled) {
                if (sock && !sock.destroyed) try { sock.destroy(); } catch {}
                return;
            }
            settled = true;
            callback(err, sock);
        };
        const proxyPort = this.proxy.port
            ? Number(this.proxy.port)
            : (this.proxy.protocol === 'https:' ? 443 : 80);
        const req = http.request({
            host: this.proxy.hostname,
            port: proxyPort,
            method: 'CONNECT',
            path: `${options.host}:${options.port || 443}`,
            timeout: 1800
        });
        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                done(new Error(`Proxy CONNECT ${res.statusCode}`));
                return;
            }
            const tlsSocket = tls.connect({
                socket,
                servername: options.servername || options.host,
                ALPNProtocols: ['http/1.1']
            });
            const tlsTimer = setTimeout(() => {
                tlsSocket.destroy(new Error('Proxy TLS handshake timeout'));
            }, 3000);
            tlsTimer.unref?.();
            tlsSocket.once('secureConnect', () => {
                clearTimeout(tlsTimer);
                done(null, tlsSocket);
            });
            tlsSocket.once('error', err => {
                clearTimeout(tlsTimer);
                done(err);
            });
        });
        req.once('timeout', () => req.destroy(new Error('Proxy CONNECT timeout')));
        req.once('error', err => done(err));
        req.end();
    }
}

let lastUsageRecordAt = 0;

function record(installRoot, values, { throttleUsage = false } = {}) {
    if (throttleUsage) {
        const now = Date.now();
        if (now - lastUsageRecordAt < 10000) return;
        lastUsageRecordAt = now;
    }
    try {
        const logPath = path.join(installRoot || defaultInstallRoot(), 'logs', 'last-translation.json');
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const report = { checkedAt: new Date().toISOString(), limits, ...measurements, ...values };
        fs.writeFileSync(logPath, JSON.stringify(report, null, 2));
    } catch {}
}

let lastConfigProxySig = '';

function resolveProxyAgent(config) {
    if (config?.features?.localProxy === false) {
        proxyAgent?.destroy();
        proxyAgent = null;
        cachedProxyUrl = '';
        cachedProxyAt = Date.now();
        lastConfigProxySig = 'disabled';
        return null;
    }
    const cfgProxyRaw = String(config?.network?.proxyUrl || '').trim();
    const sig = `enabled:${cfgProxyRaw}`;
    const now = Date.now();
    if (sig === lastConfigProxySig && cachedProxyAt && now - cachedProxyAt < 120000) {
        return proxyAgent;
    }
    lastConfigProxySig = sig;

    let chosen = '';
    if (cfgProxyRaw) {
        chosen = validateLoopbackHttpProxy(cfgProxyRaw) || '';
    } else if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
        chosen = validateLoopbackHttpProxy(String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY).trim()) || '';
    } else {
        chosen = resolveProxyUrl(config).url || '';
    }
    if (!chosen) {
        proxyAgent?.destroy();
        proxyAgent = null;
        cachedProxyUrl = '';
        cachedProxyAt = now;
        return null;
    }
    if (chosen !== cachedProxyUrl || !proxyAgent) {
        proxyAgent?.destroy();
        try {
            proxyAgent = new ProxyHttpsAgent(chosen);
            cachedProxyUrl = chosen;
        } catch {
            proxyAgent = null;
            cachedProxyUrl = '';
        }
    }
    cachedProxyAt = now;
    return proxyAgent;
}

const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

function httpsRequest(urlStr, { method = 'GET', headers = {}, body = null, agent = directAgent, timeoutMs = 2200, _redirects = 0 } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const u = new URL(urlStr);
        const hdrs = { ...headers };
        if (body) hdrs['Content-Length'] = Buffer.byteLength(body);

        const finish = (err, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimer);
            if (err) reject(err);
            else resolve(val);
        };

        const req = https.request(u, { method, headers: hdrs, agent: agent || directAgent, timeout: timeoutMs }, res => {
            const status = res.statusCode || 0;
            if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
                res.headers?.location && _redirects < 3) {
                res.resume();
                let nextUrl;
                try {
                    nextUrl = new URL(res.headers.location, u);
                } catch (err) {
                    finish(err);
                    return;
                }
                if (nextUrl.protocol !== 'https:') {
                    finish(new Error('Refusing non-HTTPS redirect'));
                    return;
                }
                const nextMethod = status === 303 ? 'GET' : method;
                const nextBody = status === 303 ? null : body;
                httpsRequest(nextUrl.href, {
                    method: nextMethod,
                    headers,
                    body: nextBody,
                    agent,
                    timeoutMs,
                    _redirects: _redirects + 1
                }).then(val => finish(null, val), err => finish(err));
                return;
            }
            const chunks = [];
            let totalBytes = 0;
            res.on('data', chunk => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_HTTP_RESPONSE_BYTES) {
                    req.destroy(new Error('HTTP response exceeds 4 MiB limit'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => finish(null, {
                status,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
            res.on('error', err => finish(err));
        });

        const hardTimer = setTimeout(() => {
            req.destroy(new Error('HTTP timeout'));
        }, timeoutMs + 400);
        hardTimer.unref?.();

        req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
        req.on('error', err => finish(err));
        if (body) req.write(body);
        req.end();
    });
}

function protectTerms(text) {
    const terms = [];
    let masked = text;
    for (const pattern of PROTECTED_TERMS) {
        masked = masked.replace(pattern, match => {
            const id = terms.length;
            terms.push(match);
            return `[P${id}]`;
        });
    }
    return { masked, terms };
}

function restoreAndPolish(original, translated, terms) {
    let out = String(translated ?? '').replace(/\[\s*P(\d+)\s*\]|【\s*P(\d+)\s*】/gi, (full, a, b) => {
        const idx = Number(a ?? b);
        return idx < terms.length ? terms[idx] : full;
    });
    out = out
        .replace(/图形编译|图表汇编|图汇编|图形汇编|graphcompilation/gi, '图编译')
        .replace(/自动混合精准/g, '自动混合精度')
        .replace(/混合精准/g, '混合精度')
        .replace(/运行时间\s*(推理|推论)/g, '运行时推理')
        .replace(/(运行时)?\s*推论\s*(部署|加速|引擎|延迟|吞吐|服务|阶段|性能|框架|速度)/g, '$1推理$2');
    if (AI_CONTEXT_RE.test(original)) {
        out = out.replace(/培训/g, '训练');
    } else {
        out = out.replace(/(DDP|分布式|模型|预|微调|混合精度|强化学习|神经网络|深度学习)\s*培训/g, '$1训练');
    }
    if (/\bAntigravity\b/.test(original)) {
        out = out.replace(/反重力/g, 'Antigravity');
    }
    return out.replace(/\s+/g, ' ').trim();
}

function needsTranslation(text) {
    const prose = text.replace(/\[(?:C|P)\d+\]/g, ' ');
    return /[A-Za-z]{3}/.test(prose) && !/[\u3400-\u9fff]/.test(prose);
}

function markProviderFailure(key, err) {
    const msg = String(err && err.message ? err.message : err);
    const durationMs = /\b429\b/.test(msg) ? 120000 : 45000;
    cooldownUntil[key] = Date.now() + durationMs;
}

function extractClients5Item(item) {
    if (typeof item === 'string') return item;
    if (Array.isArray(item)) {
        if (typeof item[0] === 'string') return item[0];
        if (Array.isArray(item[0])) {
            return item.map(seg => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
        }
    }
    return null;
}

async function translateViaGoogleClients5(texts, config, requestFn = httpsRequest) {
    if (Date.now() < cooldownUntil.googleClients5) throw new Error('GoogleClients5 cooldown');
    try {
        const agent = resolveProxyAgent(config) || directAgent;
        const results = new Array(texts.length);
        const batches = [];
        let currentIdx = [];
        let currentLen = 0;
        for (let i = 0; i < texts.length; i++) {
            if (currentIdx.length > 0 && (currentLen + texts[i].length > 3600 || currentIdx.length >= 16)) {
                batches.push(currentIdx);
                currentIdx = [];
                currentLen = 0;
            }
            currentIdx.push(i);
            currentLen += texts[i].length;
        }
        if (currentIdx.length) batches.push(currentIdx);

        await Promise.all(batches.map(async indices => {
            const formBody = indices.map(i => 'q=' + encodeURIComponent(texts[i])).join('&');
            const url = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN';
            const headers = {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
            };
            const res = await requestFn(url, { method: 'POST', headers, body: formBody, agent, timeoutMs: 2200 });
            if (res.status !== 200) throw new Error(`GoogleClients5 HTTP ${res.status}`);
            const parsed = JSON.parse(res.body);
            if (!Array.isArray(parsed) || parsed.length !== indices.length) {
                throw new Error('GoogleClients5 batch length mismatch');
            }
            indices.forEach((origIdx, j) => {
                const extracted = extractClients5Item(parsed[j]);
                if (typeof extracted !== 'string' || !extracted.trim()) {
                    throw new Error('GoogleClients5 empty item');
                }
                results[origIdx] = extracted;
            });
        }));
        return results;
    } catch (err) {
        markProviderFailure('googleClients5', err);
        throw err;
    }
}

let alibabaAuthInFlight = null;

async function ensureAlibabaAuth(forceRefresh = false, requestFn = httpsRequest, agent = directAgent) {
    const now = Date.now();
    if (!forceRefresh && alibabaAuth.token && now < alibabaAuth.expiresAt) {
        return alibabaAuth;
    }
    if (alibabaAuthInFlight) {
        return alibabaAuthInFlight;
    }
    alibabaAuthInFlight = (async () => {
        const csrfRes = await requestFn('https://translate.alibaba.com/api/translate/csrftoken', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            agent,
            timeoutMs: 1800
        });
        if (csrfRes.status !== 200) throw new Error(`Alibaba CSRF HTTP ${csrfRes.status}`);
        const data = JSON.parse(csrfRes.body);
        if (!data || !data.token) throw new Error('Alibaba CSRF token missing');
        const rawCookies = csrfRes.headers && Array.isArray(csrfRes.headers['set-cookie'])
            ? csrfRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ')
            : '';
        alibabaAuth = {
            token: data.token,
            headerName: data.headerName || 'X-CSRF-TOKEN',
            cookie: rawCookies,
            expiresAt: Date.now() + 480000
        };
        return alibabaAuth;
    })();
    try {
        return await alibabaAuthInFlight;
    } finally {
        alibabaAuthInFlight = null;
    }
}

async function translateSingleAlibaba(text, auth, requestFn = httpsRequest, agent = directAgent) {
    const form = new URLSearchParams({
        srcLang: 'en',
        tgtLang: 'zh',
        domain: 'general',
        query: text,
        _csrf: auth.token
    }).toString();
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        [auth.headerName]: auth.token
    };
    if (auth.cookie) headers.Cookie = auth.cookie;

    const res = await requestFn('https://translate.alibaba.com/api/translate/text', {
        method: 'POST',
        headers,
        body: form,
        agent,
        timeoutMs: 2200
    });
    if (res.status !== 200) throw new Error(`Alibaba HTTP ${res.status}`);
    const payload = JSON.parse(res.body);
    const out = payload?.data?.translateText;
    if (!payload?.success || typeof out !== 'string' || !out.trim()) {
        throw new Error('Alibaba invalid payload');
    }
    return out;
}

async function translateViaAlibaba(texts, config, requestFn = httpsRequest) {
    if (Date.now() < cooldownUntil.alibaba) throw new Error('Alibaba cooldown');
    const proxyFallback = resolveProxyAgent(config);
    const agents = proxyFallback ? [directAgent, proxyFallback] : [directAgent];
    let lastErr = null;
    for (const agent of agents) {
        try {
            let auth = await ensureAlibabaAuth(false, requestFn, agent);
            const results = new Array(texts.length);
            let cursor = 0;
            const concurrency = Math.min(6, texts.length);

            async function worker() {
                while (cursor < texts.length) {
                    const index = cursor++;
                    try {
                        results[index] = await translateSingleAlibaba(texts[index], auth, requestFn, agent);
                    } catch (firstErr) {
                        if (/HTTP 403|invalid payload/i.test(firstErr.message)) {
                            auth = await ensureAlibabaAuth(true, requestFn, agent);
                            results[index] = await translateSingleAlibaba(texts[index], auth, requestFn, agent);
                        } else {
                            throw firstErr;
                        }
                    }
                }
            }

            await Promise.all(Array.from({ length: concurrency }, () => worker()));
            return results;
        } catch (err) {
            lastErr = err;
            alibabaAuth.expiresAt = 0;
        }
    }
    markProviderFailure('alibaba', lastErr);
    throw lastErr;
}

async function translateViaGoogleGtx(texts, config, requestFn = httpsRequest) {
    if (Date.now() < cooldownUntil.googleGtx) throw new Error('GoogleGtx cooldown');
    try {
        const agent = resolveProxyAgent(config) || directAgent;
        const results = new Array(texts.length);
        const batches = [];
        let currentIdx = [];
        let currentLen = 0;
        for (let i = 0; i < texts.length; i++) {
            if (currentIdx.length > 0 && (currentLen + texts[i].length > 1400 || currentIdx.length >= 6)) {
                batches.push(currentIdx);
                currentIdx = [];
                currentLen = 0;
            }
            currentIdx.push(i);
            currentLen += texts[i].length;
        }
        if (currentIdx.length) batches.push(currentIdx);

        await Promise.all(batches.map(async indices => {
            const joined = indices.map(i => texts[i]).join('\n\n[[[9821]]]\n\n');
            const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(joined);
            const res = await requestFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, agent, timeoutMs: 2000 });
            if (res.status !== 200) throw new Error(`GoogleGtx HTTP ${res.status}`);
            const parsed = JSON.parse(res.body);
            if (!Array.isArray(parsed?.[0])) throw new Error('GoogleGtx invalid payload');
            const full = parsed[0].map(part => (Array.isArray(part) ? String(part[0] || '') : '')).join('');
            const split = full.split(/\s*[\[\【]{2,3}\s*9821\s*[\]\】]{2,3}\s*/);
            if (split.length !== indices.length) throw new Error('GoogleGtx batch split mismatch');
            indices.forEach((origIdx, j) => { results[origIdx] = split[j]; });
        }));
        return results;
    } catch (err) {
        markProviderFailure('googleGtx', err);
        throw err;
    }
}

function normalizeOfflineRoot(rootPath) {
    if (!rootPath) return '';
    return path.resolve(String(rootPath)).replace(/[\\/]+$/, '').toLowerCase();
}

function stopOffline() {
    clearTimeout(idleTimer);
    const current = child;
    child = undefined;
    activeOfflineRoot = '';
    for (const operation of pending.values()) {
        clearTimeout(operation.timer);
        operation.reject(new Error('Offline translator stopped'));
    }
    pending.clear();
    current?.kill();
}

function startOffline(offlineRoot, installRoot) {
    const normalizedRoot = normalizeOfflineRoot(offlineRoot);
    if (child && activeOfflineRoot === normalizedRoot) return;
    if (child && activeOfflineRoot !== normalizedRoot) {
        stopOffline();
    }
    const deployPath = path.join(offlineRoot, 'deployment.json');
    if (!offlineRoot || !fs.existsSync(deployPath)) {
        throw new Error('Offline translator package is not installed');
    }
    const deployment = JSON.parse(fs.readFileSync(deployPath, 'utf8'));
    const environment = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        HF_HUB_OFFLINE: '1'
    };
    delete environment.NODE_OPTIONS;
    delete environment.ELECTRON_RUN_AS_NODE;
    const process_ = spawn(deployment.resourceHost, [deployment.python, deployment.worker, deployment.modelRoot], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: environment
    });
    child = process_;
    activeOfflineRoot = normalizedRoot;
    process_.stdin?.on('error', () => {});
    let diagnostic = '';
    const isElectronMain = Boolean(process.versions && process.versions.electron);
    let previousUsage = process.cpuUsage();
    let previousTime = Date.now();
    readline.createInterface({ input: process_.stderr }).on('line', line => {
        try {
            const value = JSON.parse(line);
            if (value.type === 'limits') { limits = value; record(installRoot, { hostPid: process_.pid }); }
            if (value.type === 'usage') {
                const now = Date.now();
                const delta = process.cpuUsage(previousUsage);
                const nodeCpu = isElectronMain ? 0 : (delta.user + delta.system) / Math.max(1, now - previousTime) / 1000 / os.cpus().length * 100;
                previousUsage = process.cpuUsage();
                previousTime = now;
                measurements.peakCpuPercent = Math.max(measurements.peakCpuPercent, value.cpuPercent + nodeCpu);
                const residentBytes = isElectronMain ? value.workingSetBytes : (value.workingSetBytes + process.memoryUsage().rss);
                measurements.peakWorkingSetBytes = Math.max(measurements.peakWorkingSetBytes, residentBytes);
                measurements.peakCommitBytes = Math.max(measurements.peakCommitBytes, value.peakCommitBytes);
                record(installRoot, { hostPid: process_.pid }, { throttleUsage: true });
                const maxResident = Math.max(os.totalmem() * 0.06, 900 * 1024 * 1024);
                if (residentBytes > maxResident) stopOffline();
            }
        } catch { diagnostic = line.slice(0, 500); }
    });
    readline.createInterface({ input: process_.stdout }).on('line', line => {
        let value;
        try { value = JSON.parse(line); } catch { return; }
        const operation = pending.get(value.id);
        if (!operation) return;
        clearTimeout(operation.timer);
        pending.delete(value.id);
        if (value.error) operation.reject(new Error(value.error));
        else operation.resolve(value.texts);
        record(installRoot, { provider: 'offline', hostPid: process_.pid, elapsedMs: value.elapsedMs, segments: value.texts?.length, error: value.error });
        if (!pending.size) idleTimer = setTimeout(stopOffline, 180000).unref();
    });
    function exited(code) {
        if (child !== process_) return;
        child = undefined;
        activeOfflineRoot = '';
        for (const operation of pending.values()) {
            clearTimeout(operation.timer);
            operation.reject(new Error(diagnostic || 'Offline translator stopped within its resource budget'));
        }
        pending.clear();
        record(installRoot, { hostPid: process_.pid, exitCode: typeof code === 'number' ? code : null, error: diagnostic || undefined });
    }
    process_.on('error', exited);
    process_.on('exit', exited);
    process_.unref?.();
    process_.stdin?.unref?.();
    process_.stdout?.unref?.();
    process_.stderr?.unref?.();
}

const OFFLINE_MAX_BATCH_ITEMS = 48;
const OFFLINE_MAX_BATCH_CHARS = 12000;
const OFFLINE_MAX_SINGLE_CHARS = 6000;

function sendOfflineBatch(batchTexts, offlineRoot, installRoot) {
    clearTimeout(idleTimer);
    startOffline(offlineRoot, installRoot);
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('Offline translation timed out'));
            stopOffline();
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, texts: batchTexts }) + '\n', error => {
            if (!error || !pending.has(id)) return;
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
        });
    });
}

function splitOversizedSegment(text) {
    if (text.length <= OFFLINE_MAX_SINGLE_CHARS) return [text];
    const parts = [];
    let cursor = 0;
    while (cursor < text.length) {
        if (text.length - cursor <= OFFLINE_MAX_SINGLE_CHARS) {
            parts.push(text.slice(cursor));
            break;
        }
        const windowEnd = cursor + OFFLINE_MAX_SINGLE_CHARS;
        let cut = -1;
        for (const sep of ['\n', '. ', '! ', '? ', '; ', ', ', ' ']) {
            const idx = text.lastIndexOf(sep, windowEnd);
            if (idx > cursor + 1024) {
                cut = idx + sep.length;
                break;
            }
        }
        if (cut <= cursor) cut = windowEnd;
        parts.push(text.slice(cursor, cut));
        cursor = cut;
    }
    return parts;
}

async function translateViaOffline(texts, offlineRoot, installRoot) {
    if (!texts.length) return [];
    const subSegments = [];
    const mapping = [];
    for (let i = 0; i < texts.length; i++) {
        const chunks = splitOversizedSegment(String(texts[i] ?? ''));
        const start = subSegments.length;
        subSegments.push(...chunks);
        mapping.push({ start, count: chunks.length });
    }

    const translatedSubs = new Array(subSegments.length);
    let batch = [];
    let batchIndices = [];
    let batchChars = 0;

    async function flushBatch() {
        if (!batch.length) return;
        const out = await sendOfflineBatch(batch, offlineRoot, installRoot);
        if (!Array.isArray(out) || out.length !== batchIndices.length) {
            throw new Error('Offline translator returned mismatched batch length');
        }
        for (let k = 0; k < batchIndices.length; k++) {
            translatedSubs[batchIndices[k]] = String(out[k] ?? '');
        }
        batch = [];
        batchIndices = [];
        batchChars = 0;
    }

    for (let s = 0; s < subSegments.length; s++) {
        const seg = subSegments[s];
        if (batch.length > 0 && (batch.length >= OFFLINE_MAX_BATCH_ITEMS || batchChars + seg.length > OFFLINE_MAX_BATCH_CHARS)) {
            await flushBatch();
        }
        batch.push(seg);
        batchIndices.push(s);
        batchChars += seg.length;
    }
    await flushBatch();

    return mapping.map(({ start, count }) => translatedSubs.slice(start, start + count).join(''));
}

function lruGet(map, key) {
    if (!map.has(key)) return undefined;
    const val = map.get(key);
    map.delete(key);
    map.set(key, val);
    return val;
}

function lruSet(map, key, val) {
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    while (map.size > CACHE_LIMIT) {
        map.delete(map.keys().next().value);
    }
}

async function translate(texts, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const installRoot = options.installRoot || defaultInstallRoot();
    const config = options.config || loadConfig({ installRoot });
    const requestFn = options.requestFn || httpsRequest;
    const mode = options.mode || process.env.AGY_PLUS_TRANSLATOR_MODE || config.translation?.mode || 'hybrid';
    const preResolvedOfflineRoot = mode === 'offline'
        ? resolveOfflineTranslatorRoot(
            options.offlineRoot ?? config.translation?.offlineRoot,
            { allowAutoDetect: options.allowAutoDetect !== false }
        )
        : '';
    if (mode === 'offline' && preResolvedOfflineRoot) {
        const normPre = normalizeOfflineRoot(preResolvedOfflineRoot);
        if (lastOfflineCacheRoot && normPre !== lastOfflineCacheRoot) {
            offlineSentenceCache.clear();
        }
        lastOfflineCacheRoot = normPre;
    }
    const started = Date.now();
    const output = new Array(texts.length);
    const missIndices = [];
    const missMasked = [];
    const missMeta = [];

    for (let i = 0; i < texts.length; i++) {
        const raw = String(texts[i] ?? '');
        if (!needsTranslation(raw)) {
            output[i] = raw;
            continue;
        }
        if (!options.bypassCache) {
            const primaryCache = mode === 'offline' ? offlineSentenceCache : onlineSentenceCache;
            const hit = lruGet(primaryCache, raw);
            if (hit !== undefined) {
                output[i] = hit;
                continue;
            }
        }
        const { masked, terms } = protectTerms(raw);
        missIndices.push(i);
        missMasked.push(masked);
        missMeta.push({ raw, terms });
    }

    if (missIndices.length === 0) {
        record(installRoot, { provider: 'cache', elapsedMs: Date.now() - started, segments: texts.length });
        return output;
    }

    let rawTranslated = null;
    let provider = '';
    const errors = [];

    if (mode !== 'offline') {
        const onlineProviders = [
            { name: 'google-clients5', run: () => translateViaGoogleClients5(missMasked, config, requestFn) },
            { name: 'alibaba', run: () => translateViaAlibaba(missMasked, config, requestFn) },
            { name: 'google-gtx', run: () => translateViaGoogleGtx(missMasked, config, requestFn) }
        ];
        for (const candidate of onlineProviders) {
            try {
                rawTranslated = await candidate.run();
                provider = candidate.name;
                break;
            } catch (err) {
                errors.push(`${candidate.name}:${err.message}`);
            }
        }
    }

    if (!rawTranslated) {
        if (mode === 'online') {
            throw new Error(`Online translation failed (${errors.join('; ')})`);
        }
        const offlineRoot = preResolvedOfflineRoot || resolveOfflineTranslatorRoot(
            options.offlineRoot ?? config.translation?.offlineRoot,
            { allowAutoDetect: options.allowAutoDetect !== false }
        );
        if (!offlineRoot) {
            if (offlineSentenceCache.size > 0) offlineSentenceCache.clear();
            lastOfflineCacheRoot = '';
            throw new Error(`Translation unavailable (${errors.length ? errors.join('; ') : 'offline package not installed'})`);
        }
        const normOff = normalizeOfflineRoot(offlineRoot);
        if (lastOfflineCacheRoot && normOff !== lastOfflineCacheRoot) {
            offlineSentenceCache.clear();
        }
        lastOfflineCacheRoot = normOff;
        // In hybrid fallback, reuse offlineSentenceCache hits before invoking offline worker
        const remainingMasked = [];
        const remainingPos = [];
        const resolvedOfflinePolished = new Array(missIndices.length);
        for (let j = 0; j < missIndices.length; j++) {
            const hitOff = !options.bypassCache ? lruGet(offlineSentenceCache, missMeta[j].raw) : undefined;
            if (hitOff !== undefined) {
                resolvedOfflinePolished[j] = hitOff;
            } else {
                remainingPos.push(j);
                remainingMasked.push(missMasked[j]);
            }
        }
        if (remainingMasked.length > 0) {
            const subTranslated = await translateViaOffline(remainingMasked, offlineRoot, installRoot);
            for (let k = 0; k < remainingPos.length; k++) {
                const j = remainingPos[k];
                const { raw, terms } = missMeta[j];
                const leading = raw.slice(0, raw.length - raw.trimStart().length);
                const trailing = raw.slice(raw.trimEnd().length);
                const polished = leading + restoreAndPolish(raw, subTranslated[k], terms) + trailing;
                resolvedOfflinePolished[j] = polished;
                if (!options.bypassCache) {
                    lruSet(offlineSentenceCache, raw, polished);
                }
            }
        }
        for (let j = 0; j < missIndices.length; j++) {
            output[missIndices[j]] = resolvedOfflinePolished[j];
        }
        provider = 'offline';
        record(installRoot, {
            provider,
            elapsedMs: Date.now() - started,
            segments: texts.length,
            translatedSegments: remainingMasked.length,
            fallbackErrors: errors.length ? errors : undefined
        });
        return output;
    }

    for (let j = 0; j < missIndices.length; j++) {
        const { raw, terms } = missMeta[j];
        const leading = raw.slice(0, raw.length - raw.trimStart().length);
        const trailing = raw.slice(raw.trimEnd().length);
        const polished = leading + restoreAndPolish(raw, rawTranslated[j], terms) + trailing;
        output[missIndices[j]] = polished;
        if (!options.bypassCache) {
            lruSet(onlineSentenceCache, raw, polished);
        }
    }

    record(installRoot, {
        provider,
        elapsedMs: Date.now() - started,
        segments: texts.length,
        translatedSegments: missIndices.length,
        fallbackErrors: errors.length ? errors : undefined
    });
    return output;
}

function clearCache() {
    onlineSentenceCache.clear();
    offlineSentenceCache.clear();
    lastOfflineCacheRoot = '';
}

function resetCooldowns() {
    cooldownUntil.googleClients5 = 0;
    cooldownUntil.alibaba = 0;
    cooldownUntil.googleGtx = 0;
    alibabaAuth = { token: '', headerName: '', cookie: '', expiresAt: 0 };
}

function getCooldownState() {
    return { ...cooldownUntil };
}

function dispose() {
    stopOffline();
    lastOfflineCacheRoot = '';
    directAgent.destroy();
    proxyAgent?.destroy();
    proxyAgent = null;
    cachedProxyUrl = '';
    cachedProxyAt = 0;
}

module.exports = { translate, dispose, resetCooldowns, getCooldownState, clearCache };
