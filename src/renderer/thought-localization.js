function installAgyPlusThoughtTranslations(translations, initialTitleTranslations, initialFeatures) {
    'use strict';
    window.__agyPlusThoughtUI?.dispose?.();
    try { window.__derrickThoughtUI?.dispose?.(); } catch {}

    const entries = new Map();
    const seen = new Map();
    const failures = new Map();
    const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
    const dictionary = new Map(
        Object.entries(translations || {}).map(([source, target]) => [normalize(source), target])
    );

    let thoughtEnabled = initialFeatures?.thoughtTranslation !== false;
    let titleEnabled = initialFeatures?.titleTranslation !== false;

    const titleDictionary = new Map();
    if (initialTitleTranslations && typeof initialTitleTranslations === 'object') {
        for (const [source, target] of Object.entries(initialTitleTranslations)) {
            const key = normalize(source);
            if (!key) continue;
            if (typeof target === 'string' && target.trim()) {
                titleDictionary.set(key, { masked: key, translated: target.trim() });
            } else if (target && typeof target === 'object' && typeof target.translated === 'string' && target.translated.trim()) {
                titleDictionary.set(key, {
                    masked: typeof target.masked === 'string' ? target.masked : key,
                    translated: target.translated.trim()
                });
            }
        }
    }
    const titleFailures = new Map();
    const titleBindings = new Map();
    const titleOriginals = new Set(titleDictionary.keys());

    const style = document.createElement('style');
    style.id = 'agy-plus-thought-style';
    style.textContent =
        '[data-agy-plus-thought-source="translated"]{display:none!important}' +
        '.agy-plus-thought-language-button{display:block;border:0;background:transparent;color:var(--muted-foreground,#7a7a7a);font:inherit;font-size:11px;line-height:1.5;padding:4px 0;cursor:pointer}' +
        '.agy-plus-thought-language-button:hover{color:var(--foreground,#111111)}' +
        '.agy-plus-thought-streaming-tail{opacity:0.65}';
    document.head.append(style);

    let pending = 0;
    let disposed = false;

    const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, ul, ol, blockquote';
    const NESTED_BLOCK_SELECTOR = 'ul, ol, pre, table, blockquote, style, script';
    const ATOMIC_INLINE_SELECTOR = 'code, pre, kbd, samp, var, a[href], math, .katex, svg, img, button, input';
    const CODE_LITERAL_RE = /(?:[A-Za-z]:\\|\/(?:Users|root|home|tmp|var|etc|opt)\/)[^\s"'<>()[\]，。；：]+|\b(?:torch|np|tf|nn|F)\.[A-Za-z_][\w.]*\b|\b[A-Za-z0-9_][\w.-]*\.(?:cjs|mjs|js|ts|tsx|jsx|py|cs|ps1|sh|cmd|bat|json|jsonl|yaml|yml|toml|md|css|html|exe|dll|asar|onnx|pt|pth|safetensors|cu|cpp|hpp|rs|go)\b|(?:^|(?<=\s))--[A-Za-z0-9][\w-]*(?:=[^\s"'<>()[\]]+)?/g;
    const RELATIVE_TIME_RE = /^\d+\s*(?:s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks|mo|mos|y|yr|yrs)(?:\s+ago)?$/i;
    const NON_TITLE_LABEL_RE = /^(?:new\s+conversation|new\s+chat|today|yesterday|older|pinned|recent|inbox|workspaces?|projects?|settings|more|delete|rename|archive|cancel|save|done|just\s+now)$/i;

    function discoverThoughtContainers() {
        const result = [];
        const seenContainers = new Set();
        const addContainer = (container, activeHint) => {
            if (!container || seenContainers.has(container)) return;
            if (container.hasAttribute('data-agy-plus-thought-translation') ||
                container.closest?.('[data-agy-plus-thought-translation]')) return;
            seenContainers.add(container);
            let active = Boolean(activeHint);
            if (!active) {
                let parent = container.parentElement;
                for (let depth = 0; parent && depth < 10; depth++, parent = parent.parentElement) {
                    const toggle = parent.querySelector(':scope > [data-testid="thinking-collapsible-trigger"]');
                    if (toggle) {
                        active = /^Thinking\b/i.test(toggle.textContent.trim());
                        break;
                    }
                }
            }
            result.push({ container, active });
        };

        const coveredPanels = new WeakSet();
        for (const container of document.querySelectorAll('[data-testid="conversation-view"] .cursor-edit .md-divider-spacing')) {
            addContainer(container, false);
            let p = container.parentElement;
            for (let d = 0; p && d < 8; d++, p = p.parentElement) coveredPanels.add(p);
        }

        for (const trigger of document.querySelectorAll('[data-testid="conversation-view"] [data-testid="thinking-collapsible-trigger"]')) {
            const panel = trigger.parentElement;
            if (!panel || coveredPanels.has(panel) || panel.querySelectorAll('[data-testid="thinking-collapsible-trigger"]').length !== 1) continue;
            const isThinking = /^Thinking\b/i.test((trigger.textContent || '').trim());
            const semantic = Array.from(panel.querySelectorAll('.md-divider-spacing, .prose, .markdown')).find(el =>
                !trigger.contains(el) && !el.hasAttribute('data-agy-plus-thought-translation') && !el.closest('[data-agy-plus-thought-translation]')
            );
            if (semantic) {
                addContainer(semantic, isThinking);
                coveredPanels.add(panel);
                continue;
            }
            let sibling = trigger.nextElementSibling;
            while (sibling) {
                if (!sibling.hasAttribute('data-agy-plus-thought-translation') &&
                    sibling.tagName !== 'BUTTON' &&
                    (sibling.textContent || '').trim().length > 0) {
                    addContainer(sibling, isThinking);
                    coveredPanels.add(panel);
                    break;
                }
                sibling = sibling.nextElementSibling;
            }
        }
        return result;
    }

    function thoughtBlocksWithMeta({ measureBounds = true } = {}) {
        const items = [];
        for (const { container, active } of discoverThoughtContainers()) {
            let containerNearViewport = true;
            if (measureBounds) {
                const containerBounds = container.getBoundingClientRect();
                containerNearViewport = containerBounds.height > 0 &&
                    containerBounds.bottom > -600 &&
                    containerBounds.top < innerHeight + 600;
            }
            const children = Array.from(container.children).filter(node =>
                !node.hasAttribute('data-agy-plus-thought-translation') && node.matches(BLOCK_SELECTOR));
            const list = children.length ? children : [container];
            list.forEach((root, idx) => {
                items.push({
                    root,
                    active,
                    isActiveTail: active && idx === list.length - 1,
                    containerNearViewport
                });
            });
        }
        return items;
    }

    function unitTargets(root) {
        if (root.matches('ul, ol, blockquote')) {
            const leaves = Array.from(root.querySelectorAll('p, li, h1, h2, h3, h4')).filter(el => {
                if (el.closest('pre, code, script, style')) return false;
                if (el.tagName === 'LI' && el.querySelector(':scope > p')) return false;
                return true;
            });
            if (leaves.length) return leaves;
        }
        return [root];
    }

    function inlineSlices(target) {
        const slices = [];
        let current = [];
        for (const child of Array.from(target.childNodes)) {
            if (child.nodeType === 1 && child.matches(NESTED_BLOCK_SELECTOR)) {
                if (current.length) {
                    slices.push({ parent: target, nodes: current, before: child });
                    current = [];
                }
                continue;
            }
            current.push(child);
        }
        if (current.length) slices.push({ parent: target, nodes: current, before: null });
        return slices;
    }

    function maskPlainLiterals(raw, tokens) {
        return raw.replace(CODE_LITERAL_RE, match => {
            const id = tokens.length;
            tokens.push({ type: 'text', value: match });
            return `[C${id}]`;
        });
    }

    function restorePlainLiterals(translatedText, tokens) {
        return String(translatedText || '').replace(/\[\s*C(\d+)\s*\]|【\s*C(\d+)\s*】/gi, (full, a, b) => {
            const idx = Number(a ?? b);
            const token = tokens[idx];
            return token && token.type === 'text' ? token.value : full;
        });
    }

    function collectInlineText(node, tokens) {
        if (node.nodeType === 3) {
            return maskPlainLiterals(node.nodeValue || '', tokens);
        }
        if (node.nodeType !== 1) return '';
        if (node.matches('script, style')) return '';
        if (node.matches(ATOMIC_INLINE_SELECTOR)) {
            const id = tokens.length;
            tokens.push({ type: 'node', node });
            return `[C${id}]`;
        }
        if (node.tagName === 'BR') return '\n';
        let buffer = '';
        for (const child of node.childNodes) buffer += collectInlineText(child, tokens);
        return buffer;
    }

    function extractUnits(root) {
        const units = [];
        for (const target of unitTargets(root)) {
            for (const slice of inlineSlices(target)) {
                const tokens = [];
                let raw = '';
                for (const node of slice.nodes) raw += collectInlineText(node, tokens);
                const masked = normalize(raw);
                if (!masked) continue;
                const prose = masked.replace(/\[C\d+\]/g, ' ');
                if (!/[A-Za-z]{2}/.test(prose)) continue;
                units.push({ ...slice, tokens, masked, prose });
            }
        }
        return units;
    }

    function renderSliceFragment(translatedText, tokens) {
        const fragment = document.createDocumentFragment();
        const used = new Set();
        const pattern = /\[\s*C(\d+)\s*\]|【\s*C(\d+)\s*】/gi;
        let lastIndex = 0;
        let match;
        while ((match = pattern.exec(translatedText)) !== null) {
            if (match.index > lastIndex) {
                fragment.append(document.createTextNode(translatedText.slice(lastIndex, match.index)));
            }
            const idx = Number(match[1] ?? match[2]);
            const token = tokens[idx];
            if (token) {
                used.add(idx);
                if (token.type === 'node') {
                    const clone = token.node.cloneNode(true);
                    clone.removeAttribute?.('id');
                    for (const sub of clone.querySelectorAll?.('[id]') || []) sub.removeAttribute('id');
                    fragment.append(clone);
                } else {
                    fragment.append(document.createTextNode(token.value));
                }
            } else {
                fragment.append(document.createTextNode(match[0]));
            }
            lastIndex = pattern.lastIndex;
        }
        if (lastIndex < translatedText.length) {
            fragment.append(document.createTextNode(translatedText.slice(lastIndex)));
        }
        tokens.forEach((token, idx) => {
            if (!used.has(idx) && token.type === 'node') {
                fragment.append(document.createTextNode(' '));
                const clone = token.node.cloneNode(true);
                clone.removeAttribute?.('id');
                for (const sub of clone.querySelectorAll?.('[id]') || []) sub.removeAttribute('id');
                fragment.append(clone);
            }
        });
        return fragment;
    }

    function buildTranslatedBody(root, source, translation) {
        const automatic = typeof translation === 'object' && translation !== null;
        if (automatic) {
            const body = root.cloneNode(true);
            body.removeAttribute('id');
            body.removeAttribute('data-agy-plus-thought-source');
            body.dataset.agyPlusThoughtTranslation = 'true';
            const clonedUnits = extractUnits(body);
            if (clonedUnits.length !== translation.originals.length ||
                clonedUnits.some((u, idx) => u.masked !== translation.originals[idx])) {
                dictionary.delete(source);
                return null;
            }
            for (let idx = 0; idx < clonedUnits.length; idx++) {
                const unit = clonedUnits[idx];
                const fragment = renderSliceFragment(translation.translated[idx], unit.tokens);
                for (const oldNode of unit.nodes) oldNode.remove();
                unit.parent.insertBefore(fragment, unit.before);
            }
            for (const el of body.querySelectorAll('style, script')) el.remove();
            for (const el of body.querySelectorAll('[id]')) el.removeAttribute('id');
            return { body, automatic: true };
        }
        const body = root.tagName === 'P' ? document.createElement('div') : root.cloneNode(false);
        body.removeAttribute('id');
        body.removeAttribute('data-agy-plus-thought-source');
        body.dataset.agyPlusThoughtTranslation = 'true';
        const paragraph = document.createElement('p');
        const parts = String(translation).split(/(`[^`]+`)/g);
        for (const part of parts) {
            if (part.startsWith('`') && part.endsWith('`')) {
                const code = document.createElement('code');
                code.textContent = part.slice(1, -1);
                paragraph.append(code);
            } else {
                paragraph.append(document.createTextNode(part));
            }
        }
        body.append(paragraph);
        return { body, automatic: false };
    }

    function attachStreamingTail(body, deltaText) {
        for (const old of body.querySelectorAll('.agy-plus-thought-streaming-tail')) old.remove();
        if (!deltaText) return;
        const tail = document.createElement('span');
        tail.className = 'agy-plus-thought-streaming-tail';
        tail.textContent = ' ' + deltaText;
        const targets = body.querySelectorAll('p, li, h1, h2, h3, h4');
        const host = targets.length ? targets[targets.length - 1] : body;
        host.append(tail);
    }

    function isTranslatableConversationTitle(raw) {
        const clean = normalize(raw);
        if (!clean || clean.length < 3 || clean.length > 200) return false;
        if (RELATIVE_TIME_RE.test(clean) || NON_TITLE_LABEL_RE.test(clean)) return false;
        const tokens = [];
        const masked = maskPlainLiterals(clean, tokens);
        const prose = masked.replace(/\[C\d+\]/g, ' ');
        const english = (prose.match(/[A-Za-z]/g) || []).length;
        const chinese = (prose.match(/[\u3400-\u9fff]/g) || []).length;
        if (english < 3 || !/[A-Za-z]{3}/.test(prose)) return false;
        if (chinese > 0) return false;
        return true;
    }

    function maskConversationTitle(raw) {
        const tokens = [];
        const masked = normalize(maskPlainLiterals(raw, tokens));
        return { masked, tokens };
    }

    function collectTextNodes(root, excludedNode) {
        const nodes = [];
        if (!root) return nodes;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode()) !== null) {
            if (excludedNode && (node === excludedNode || excludedNode.contains(node))) continue;
            const parent = node.parentElement;
            if (!parent) continue;
            if (parent.closest('script, style, svg, button, input, textarea, [contenteditable="true"], [data-agy-plus-thought-translation]')) continue;
            const text = normalize(node.nodeValue || '');
            if (!text || RELATIVE_TIME_RE.test(text)) continue;
            nodes.push(node);
        }
        return nodes;
    }

    function parseConversationHrefPath(link) {
        const rawAttr = (link.getAttribute('href') || '').trim();
        if (rawAttr.startsWith('/')) {
            return rawAttr.split(/[?#]/)[0];
        }
        try {
            const base = location && location.origin && location.origin !== 'null' ? location.origin : 'https://127.0.0.1';
            return new URL(link.href || rawAttr, base).pathname;
        } catch {
            return '';
        }
    }

    function findSidebarTitleTextNodes() {
        const found = [];
        const seenNodes = new Set();
        const links = document.querySelectorAll('a[href]');
        for (const link of links) {
            const pathname = parseConversationHrefPath(link);
            if (!/^\/c\/[A-Za-z0-9._-]+$/.test(pathname)) continue;
            const row = link.parentElement;
            if (row && row.querySelector('input, textarea, [contenteditable="true"]')) continue;

            let candidates = collectTextNodes(link, null);
            if (!candidates.length && row) {
                const siblingLinks = row.querySelectorAll('a[href]').length;
                if (siblingLinks === 1) {
                    candidates = collectTextNodes(row, link);
                }
            }
            if (!candidates.length) continue;
            let best = candidates[0];
            let bestLen = normalize(best.nodeValue || '').length;
            for (let i = 1; i < candidates.length; i++) {
                const len = normalize(candidates[i].nodeValue || '').length;
                if (len > bestLen) {
                    best = candidates[i];
                    bestLen = len;
                }
            }
            if (best && !seenNodes.has(best)) {
                seenNodes.add(best);
                found.push(best);
            }
        }
        return found;
    }

    function findHeaderTitleTextNodes() {
        const found = [];
        if (titleOriginals.size === 0) return found;
        const headerRoots = document.querySelectorAll('header, [data-testid="conversation-header"], [data-testid="chat-header"], nav, main > div:first-child');
        const seenNodes = new Set();
        const EXCLUDE_SEL = '[data-testid="conversation-view"], [data-testid="agent-input-box"], .bg-sidebar, input, textarea, [contenteditable="true"], script, style, svg';
        const SHOW_MASK = (NodeFilter.SHOW_ELEMENT || 1) | (NodeFilter.SHOW_TEXT || 4);
        for (const root of headerRoots) {
            if (!root || root.closest(EXCLUDE_SEL)) continue;
            const walker = document.createTreeWalker(root, SHOW_MASK, {
                acceptNode(n) {
                    if (n.nodeType === 1) {
                        if (n.matches?.(EXCLUDE_SEL)) return NodeFilter.FILTER_REJECT || 2;
                        return NodeFilter.FILTER_SKIP || 3;
                    }
                    return NodeFilter.FILTER_ACCEPT || 1;
                }
            });
            let node;
            while ((node = walker.nextNode()) !== null) {
                if (node.nodeType !== 3 || seenNodes.has(node)) continue;
                const parent = node.parentElement;
                if (!parent) continue;
                const binding = titleBindings.get(node);
                const text = normalize(node.nodeValue || '');
                if (!text) continue;
                if (binding || titleOriginals.has(text)) {
                    seenNodes.add(node);
                    found.push(node);
                }
            }
        }
        return found;
    }

    function restoreTitleBinding(textNode, binding) {
        if (!binding) return;
        try {
            if (textNode.isConnected && textNode.nodeValue === binding.displayed) {
                textNode.nodeValue = binding.originalRaw;
            }
            if (binding.parentEl && binding.parentEl.isConnected) {
                binding.parentEl.removeAttribute('data-agy-plus-title-translated');
                binding.parentEl.removeAttribute('data-agy-plus-title-original');
                if (binding.touchedTitleAttr) {
                    if (binding.hadTitleAttr) binding.parentEl.setAttribute('title', binding.prevTitleAttr);
                    else binding.parentEl.removeAttribute('title');
                }
            }
        } catch {}
        titleBindings.delete(textNode);
    }

    function restoreAllTitles() {
        for (const [textNode, binding] of Array.from(titleBindings.entries())) {
            restoreTitleBinding(textNode, binding);
        }
    }

    function applyConversationTitleTranslations() {
        if (!titleEnabled) {
            if (titleBindings.size > 0) restoreAllTitles();
            return;
        }
        for (const [textNode, binding] of Array.from(titleBindings.entries())) {
            if (!textNode.isConnected) {
                if (binding.parentEl && binding.parentEl.isConnected) {
                    try {
                        binding.parentEl.removeAttribute('data-agy-plus-title-translated');
                        binding.parentEl.removeAttribute('data-agy-plus-title-original');
                        if (binding.touchedTitleAttr) {
                            if (binding.hadTitleAttr) binding.parentEl.setAttribute('title', binding.prevTitleAttr);
                            else binding.parentEl.removeAttribute('title');
                        }
                    } catch {}
                }
                titleBindings.delete(textNode);
                continue;
            }
            const currentRaw = textNode.nodeValue || '';
            const currentNorm = normalize(currentRaw);
            if (currentRaw === binding.displayed) continue;
            if (currentNorm === binding.original) {
                const cached = titleDictionary.get(binding.original);
                if (cached) {
                    const { tokens } = maskConversationTitle(currentNorm);
                    const leading = currentRaw.slice(0, currentRaw.length - currentRaw.trimStart().length);
                    const trailing = currentRaw.slice(currentRaw.trimEnd().length);
                    const rendered = leading + restorePlainLiterals(cached.translated, tokens) + trailing;
                    binding.originalRaw = currentRaw;
                    binding.displayed = rendered;
                    textNode.nodeValue = rendered;
                    continue;
                }
            }
            if (binding.parentEl && binding.parentEl.isConnected) {
                binding.parentEl.removeAttribute('data-agy-plus-title-translated');
                binding.parentEl.removeAttribute('data-agy-plus-title-original');
                if (binding.touchedTitleAttr) {
                    if (binding.hadTitleAttr) binding.parentEl.setAttribute('title', binding.prevTitleAttr);
                    else binding.parentEl.removeAttribute('title');
                }
            }
            titleBindings.delete(textNode);
        }

        const bindNodes = nodesList => {
            for (const textNode of nodesList) {
                if (titleBindings.has(textNode)) continue;
                const raw = textNode.nodeValue || '';
                const norm = normalize(raw);
                if (!norm) continue;
                if (isTranslatableConversationTitle(norm)) {
                    titleOriginals.add(norm);
                }
                const cached = titleDictionary.get(norm);
                if (!cached) continue;
                const { tokens } = maskConversationTitle(norm);
                const leading = raw.slice(0, raw.length - raw.trimStart().length);
                const trailing = raw.slice(raw.trimEnd().length);
                const translatedText = restorePlainLiterals(cached.translated, tokens);
                if (!translatedText || normalize(translatedText) === norm) continue;
                const displayed = leading + translatedText + trailing;
                const parentEl = textNode.parentElement;
                const hadTitleAttr = Boolean(parentEl && parentEl.hasAttribute('title'));
                const prevTitleAttr = hadTitleAttr ? parentEl.getAttribute('title') : null;
                let touchedTitleAttr = false;
                textNode.nodeValue = displayed;
                if (parentEl) {
                    parentEl.setAttribute('data-agy-plus-title-translated', 'true');
                    parentEl.setAttribute('data-agy-plus-title-original', norm);
                    if (!hadTitleAttr || normalize(prevTitleAttr || '') === norm) {
                        parentEl.setAttribute('title', `${translatedText}\n${norm}`);
                        touchedTitleAttr = true;
                    }
                }
                titleBindings.set(textNode, {
                    original: norm,
                    originalRaw: raw,
                    displayed,
                    parentEl,
                    hadTitleAttr,
                    prevTitleAttr,
                    touchedTitleAttr
                });
            }
        };

        bindNodes(findSidebarTitleTextNodes());
        bindNodes(findHeaderTitleTextNodes());
    }

    function pendingTitleTranslations() {
        if (disposed || !titleEnabled) return [];
        const now = Date.now();
        const requests = [];
        const queued = new Set();
        for (const textNode of findSidebarTitleTextNodes()) {
            if (titleBindings.has(textNode)) continue;
            const norm = normalize(textNode.nodeValue || '');
            if (!norm || queued.has(norm)) continue;
            if (titleDictionary.has(norm) || (titleFailures.get(norm) || 0) > now) continue;
            if (!isTranslatableConversationTitle(norm)) continue;
            titleOriginals.add(norm);
            const { masked } = maskConversationTitle(norm);
            if (!masked) continue;
            queued.add(norm);
            requests.push({ original: norm, masked });
            if (requests.length >= 24) break;
        }
        return requests;
    }

    function pendingTranslations() {
        if (disposed || !thoughtEnabled) return [];
        const candidates = [];
        const now = Date.now();
        for (const { root, isActiveTail, containerNearViewport } of thoughtBlocksWithMeta()) {
            if (root.hasAttribute('data-agy-plus-thought-translation')) continue;
            const source = normalize(root.textContent);
            if (!source || dictionary.has(source) || (failures.get(source) || 0) > now) continue;
            if (source.length > 16000) continue;

            const existing = entries.get(root);
            if (existing && existing.source === source) continue;
            const bounds = (existing ? existing.wrapper : root).getBoundingClientRect();
            if (bounds.height <= 0 || !containerNearViewport) continue;

            const units = extractUnits(root);
            if (!units.length || units.length > 60) continue;
            const prose = units.map(u => u.prose).join(' ');
            const english = (prose.match(/[A-Za-z]/g) || []).length;
            const chinese = (prose.match(/[\u3400-\u9fff]/g) || []).length;
            if (english < 16 || chinese > english * 0.25) continue;

            let state = seen.get(root);
            if (!state) {
                state = { firstAt: now, changedAt: now, source };
                seen.set(root, state);
            } else if (state.source !== source) {
                state.source = source;
                state.changedAt = now;
            }

            if (isActiveTail) {
                const idleMs = now - state.changedAt;
                if (existing) {
                    const delta = source.startsWith(existing.source) ? source.slice(existing.source.length) : source;
                    const sinceLast = now - existing.translatedAt;
                    const readyRefresh = idleMs >= 240 ||
                        (sinceLast >= 650 && (delta.length >= 32 || /[.!?](\s|$)/.test(delta)));
                    if (!readyRefresh) continue;
                } else {
                    const ageMs = now - state.firstAt;
                    const hasCompleteSentence = /[.!?]["')\]]?(?:\s+[A-Z"`(\[]|\s*$)/.test(source);
                    const readyInitial = idleMs >= 240 ||
                        (hasCompleteSentence && ageMs >= 220) ||
                        (english >= 60 && ageMs >= 520);
                    if (!readyInitial) continue;
                }
            }

            const directlyVisible = bounds.bottom > -200 && bounds.top < innerHeight + 200;
            candidates.push({ source, texts: units.map(u => u.masked), priority: directlyVisible ? 0 : 1 });
        }
        candidates.sort((a, b) => a.priority - b.priority);
        const requests = [];
        let totalUnits = 0;
        for (const item of candidates) {
            if (requests.length > 0 && totalUnits + item.texts.length > 36) break;
            requests.push({ source: item.source, texts: item.texts });
            totalUnits += item.texts.length;
            if (requests.length >= 8) break;
        }
        return requests;
    }

    function restore(root, entry) {
        if (entry.previous === null) root.removeAttribute('data-agy-plus-thought-source');
        else root.setAttribute('data-agy-plus-thought-source', entry.previous);
        entry.wrapper.remove();
        entries.delete(root);
    }

    function restoreAllThoughts() {
        for (const [root, entry] of Array.from(entries.entries())) {
            restore(root, entry);
        }
    }

    function update() {
        if (disposed) return;
        clearTimeout(pending);
        pending = 0;
        observer.disconnect();

        if (!thoughtEnabled) {
            if (entries.size > 0) restoreAllThoughts();
        } else {
            const now = Date.now();
            const currentBlocks = thoughtBlocksWithMeta({ measureBounds: false });
            for (const { root } of currentBlocks) {
                const currentText = normalize(root.textContent);
                if (!currentText) continue;
                const prevSeen = seen.get(root);
                if (!prevSeen) seen.set(root, { firstAt: now, changedAt: now, source: currentText });
                else if (prevSeen.source !== currentText) { prevSeen.source = currentText; prevSeen.changedAt = now; }
            }
            for (const [root, entry] of Array.from(entries.entries())) {
                if (!root.isConnected) {
                    restore(root, entry);
                    continue;
                }
                const currentSource = normalize(root.textContent);
                if (currentSource === entry.source) continue;
                const updatedTranslation = dictionary.get(currentSource);
                if (updatedTranslation) {
                    const built = buildTranslatedBody(root, currentSource, updatedTranslation);
                    if (built) {
                        built.body.hidden = !entry.translated;
                        entry.body.replaceWith(built.body);
                        entry.body = built.body;
                        entry.source = currentSource;
                        entry.translatedAt = Date.now();
                        continue;
                    }
                }
                if (currentSource.startsWith(entry.source)) {
                    const delta = currentSource.slice(entry.source.length).trim();
                    attachStreamingTail(entry.body, delta);
                    continue;
                }
                restore(root, entry);
            }
            for (const root of Array.from(seen.keys())) {
                if (!root.isConnected) seen.delete(root);
            }
            for (const { root } of currentBlocks) {
                if (!root.isConnected || root.hasAttribute('data-agy-plus-thought-translation') || entries.has(root)) continue;
                const source = normalize(root.textContent);
                const translation = dictionary.get(source);
                if (!translation) continue;
                const built = buildTranslatedBody(root, source, translation);
                if (!built) continue;
                const { body, automatic } = built;
                const wrapper = document.createElement('div');
                wrapper.dataset.agyPlusThoughtTranslation = 'true';
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'agy-plus-thought-language-button';
                const caption = automatic ? 'Chinese translation' : 'Chinese summary';
                button.textContent = `${caption} · Show original`;
                wrapper.append(body, button);
                const entry = {
                    source,
                    wrapper,
                    body,
                    previous: root.getAttribute('data-agy-plus-thought-source'),
                    translated: true,
                    translatedAt: Date.now()
                };
                button.addEventListener('click', () => {
                    entry.translated = !entry.translated;
                    root.setAttribute('data-agy-plus-thought-source', entry.translated ? 'translated' : 'original');
                    entry.body.hidden = !entry.translated;
                    button.textContent = entry.translated ? `${caption} · Show original` : `Show ${caption.toLowerCase()}`;
                });
                root.setAttribute('data-agy-plus-thought-source', 'translated');
                root.after(wrapper);
                entries.set(root, entry);
            }
            if (failures.size > 512) {
                for (const [k, exp] of Array.from(failures.entries())) {
                    if (exp <= now || failures.size > 512) failures.delete(k);
                }
            }
        }

        applyConversationTitleTranslations();

        if (thoughtEnabled || titleEnabled) {
            observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        }
    }

    function storeEntry(source, originals, translated) {
        if (!Array.isArray(originals) || !Array.isArray(translated) || originals.length !== translated.length ||
            !originals.every(value => typeof value === 'string') || !translated.every(value => typeof value === 'string')) {
            return false;
        }
        dictionary.set(source, { originals, translated });
        while (dictionary.size > 384) dictionary.delete(dictionary.keys().next().value);
        failures.delete(source);
        return true;
    }

    function storeTitleEntry(original, masked, translated) {
        const key = normalize(original || '');
        const cleanTarget = normalize(translated || '');
        if (!key || !cleanTarget) return false;
        titleOriginals.add(key);
        titleDictionary.set(key, {
            masked: typeof masked === 'string' && masked.trim() ? masked.trim() : key,
            translated: cleanTarget
        });
        while (titleDictionary.size > 2048) {
            const oldest = titleDictionary.keys().next().value;
            titleDictionary.delete(oldest);
            titleOriginals.delete(oldest);
        }
        titleFailures.delete(key);
        if (titleFailures.size > 512) {
            const now = Date.now();
            for (const [k, exp] of Array.from(titleFailures.entries())) {
                if (exp <= now || titleFailures.size > 512) titleFailures.delete(k);
            }
        }
        return true;
    }

    const observer = new MutationObserver(() => {
        if (!pending) pending = setTimeout(update, 60);
    });

    window.__agyPlusThoughtUI = {
        version: 7,
        status: () => ({
            installed: true,
            version: 7,
            thoughtEnabled,
            titleEnabled,
            translatedCount: entries.size,
            cachedSummaries: dictionary.size,
            translatedTitleCount: titleBindings.size,
            cachedTitleCount: titleDictionary.size,
            triggers: document.querySelectorAll('[data-testid="conversation-view"] [data-testid="thinking-collapsible-trigger"]').length,
            containers: discoverThoughtContainers().length
        }),
        pending: pendingTranslations,
        pendingTitles: pendingTitleTranslations,
        accept(source, originals, translated) {
            if (disposed || !storeEntry(source, originals, translated)) return false;
            update();
            return true;
        },
        acceptBatch(items) {
            if (disposed || !Array.isArray(items)) return 0;
            let accepted = 0;
            for (const item of items) {
                if (item && storeEntry(item.source, item.originals, item.translated)) accepted++;
            }
            if (accepted > 0) update();
            return accepted;
        },
        acceptTitles(items) {
            if (disposed || !Array.isArray(items)) return 0;
            let accepted = 0;
            for (const item of items) {
                if (item && storeTitleEntry(item.original, item.masked, item.translated)) accepted++;
            }
            if (accepted > 0) update();
            return accepted;
        },
        setFeatures(nextFeatures) {
            if (disposed || !nextFeatures || typeof nextFeatures !== 'object') return false;
            let changed = false;
            if (typeof nextFeatures.thoughtTranslation === 'boolean' && nextFeatures.thoughtTranslation !== thoughtEnabled) {
                thoughtEnabled = nextFeatures.thoughtTranslation;
                changed = true;
            }
            if (typeof nextFeatures.titleTranslation === 'boolean' && nextFeatures.titleTranslation !== titleEnabled) {
                titleEnabled = nextFeatures.titleTranslation;
                changed = true;
            }
            if (changed) update();
            return true;
        },
        failed(source) {
            failures.set(source, Date.now() + 20000);
        },
        failedTitle(original) {
            const key = normalize(original || '');
            if (key) titleFailures.set(key, Date.now() + 20000);
        },
        dispose() {
            disposed = true;
            observer.disconnect();
            clearTimeout(pending);
            restoreAllThoughts();
            restoreAllTitles();
            style.remove();
            delete window.__agyPlusThoughtUI;
        }
    };

    update();
    return window.__agyPlusThoughtUI.status();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { installAgyPlusThoughtTranslations };
}
