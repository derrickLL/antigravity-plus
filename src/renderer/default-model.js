function installAgyPlusDefaultModel(initialConfig) {
    'use strict';
    const VERSION = 2;
    const previous = window.__agyPlusDefaultModel;
    if (previous && typeof previous.dispose === 'function') {
        try { previous.dispose(); } catch {}
    }

    const DEFAULT_CONFIG = {
        enabled: true,
        strategy: 'highest_gemini',
        preferredModelHint: '',
        preferredEffortHint: ''
    };

    const config = {
        enabled: initialConfig?.enabled !== false,
        strategy: typeof initialConfig?.strategy === 'string' && initialConfig.strategy.trim()
            ? initialConfig.strategy.trim()
            : DEFAULT_CONFIG.strategy,
        preferredModelHint: typeof initialConfig?.preferredModelHint === 'string'
            ? initialConfig.preferredModelHint.trim()
            : '',
        preferredEffortHint: typeof initialConfig?.preferredEffortHint === 'string'
            ? initialConfig.preferredEffortHint.trim()
            : ''
    };

    const EFFORT_RANK = {
        none: 1, off: 1, minimal: 1,
        low: 2, standard: 2,
        medium: 3, balanced: 3,
        high: 4, extended: 4,
        xhigh: 5, extra: 5, 'very high': 5,
        max: 6, maximum: 6, ultra: 6, extreme: 6
    };

    const EFFORT_LABEL_RE = /^(.*?)\s*\((none|off|minimal|low|standard|medium|balanced|high|extended|xhigh|extra|very\s+high|max|maximum|ultra|extreme)(?:\s+thinking)?\)\s*$/i;
    const EFFORT_ID_RE = /(?:^|[-_\s])(minimal|low|medium|high|xhigh|extra|max|maximum|extreme)$/i;
    const MAX_APPLIES_PER_SESSION = 4;
    const CONVERGENCE_WINDOW_MS = 12000;
    const MANUAL_INTERACTION_WINDOW_MS = 15000;

    let disposed = false;
    let zeroSessionSeq = 0;
    let wasInZeroState = false;
    let activeZeroSessionKey = '';
    let activeZeroSessionEnteredAt = 0;
    let applyCountInSession = 0;
    let manualOverrideSessionKey = '';
    let lastSelectedSignature = '';
    let lastSyntheticSetAt = 0;
    let lastSyntheticTargetSig = '';
    let lastUserPickerInteractionAt = 0;
    let lastMenuOpenSeen = false;
    let checkTimer = null;
    let pollTimer = null;

    const status = {
        installed: true,
        version: VERSION,
        config,
        state: 'idle',
        selectedLabel: '',
        selectedModelId: '',
        targetLabel: '',
        targetModelId: '',
        availableCount: 0,
        manualOverridden: false,
        appliedCount: 0,
        lastCheckedAt: 0,
        lastAppliedAt: 0,
        route: ''
    };

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function escapeRegExp(str) {
        return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function isVisibleElement(el) {
        if (!el) return false;
        if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
        try {
            const style = window.getComputedStyle?.(el);
            if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        } catch {}
        if (typeof el.getBoundingClientRect === 'function') {
            const rect = el.getBoundingClientRect();
            if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
        }
        return true;
    }

    function modelSignature(model) {
        if (!model) return '';
        return `${String(model.value ?? '')}|${String(model.modelId ?? '')}|${normalizeText(model.label)}`;
    }

    function findModelSelectorContext() {
        const anchors = [
            document.querySelector('[data-testid="model-selector-trigger"]'),
            document.querySelector('[data-testid="agent-input-box"]')
        ].filter(Boolean);

        for (const anchor of anchors) {
            const fiberKey = Object.keys(anchor).find(name => name.startsWith('__reactFiber$'));
            let fiber = fiberKey ? anchor[fiberKey] : null;
            for (let depth = 0; fiber && depth < 600; depth++, fiber = fiber.return) {
                const value = fiber.memoizedProps?.value;
                if (value && typeof value === 'object' && Array.isArray(value.modelOptions) && typeof value.setSelectedModel === 'function') {
                    return value;
                }
            }
        }
        return null;
    }

    function buildRecommendedOrderMap(modelSorts) {
        const orderMap = new Map();
        if (!Array.isArray(modelSorts)) return orderMap;
        const recommendedSort =
            modelSorts.find(s => typeof s?.name === 'string' && s.name.toLowerCase() === 'recommended') ||
            modelSorts[0];
        if (!recommendedSort || !Array.isArray(recommendedSort.groups)) return orderMap;
        let idx = 0;
        for (const group of recommendedSort.groups) {
            for (const opt of group?.options || []) {
                const sig = modelSignature(opt);
                if (sig && !orderMap.has(sig)) orderMap.set(sig, idx++);
            }
        }
        return orderMap;
    }

    function buildReverseEffortLookup(effortIndex) {
        const lookup = new Map();
        if (!effortIndex || typeof effortIndex.entries !== 'function') return lookup;
        for (const [baseName, byEffort] of effortIndex.entries()) {
            if (!byEffort || typeof byEffort.entries !== 'function') continue;
            for (const [effortKey, opt] of byEffort.entries()) {
                const sig = modelSignature(opt);
                if (sig) {
                    lookup.set(sig, {
                        base: normalizeText(baseName),
                        effort: normalizeText(effortKey).toLowerCase()
                    });
                }
            }
        }
        return lookup;
    }

    function parseModelEffort(option, reverseEffortLookup) {
        const sig = modelSignature(option);
        const fromIndex = reverseEffortLookup.get(sig);
        if (fromIndex) {
            return {
                base: fromIndex.base,
                effort: fromIndex.effort,
                effortRank: EFFORT_RANK[fromIndex.effort] ?? 4.5
            };
        }
        const label = normalizeText(option?.label);
        const labelMatch = EFFORT_LABEL_RE.exec(label);
        if (labelMatch) {
            const effort = labelMatch[2].toLowerCase().replace(/\s+/g, ' ');
            return {
                base: normalizeText(labelMatch[1]),
                effort,
                effortRank: EFFORT_RANK[effort] ?? 0
            };
        }
        const modelId = normalizeText(option?.modelId).toLowerCase();
        const idMatch = EFFORT_ID_RE.exec(modelId);
        if (idMatch) {
            const effort = idMatch[1].toLowerCase();
            return { base: label, effort, effortRank: EFFORT_RANK[effort] ?? 0 };
        }
        return { base: label, effort: '', effortRank: 0 };
    }

    function isGeminiOption(option) {
        const combined = `${normalizeText(option?.label)} ${normalizeText(option?.modelId)}`.toLowerCase();
        return /\bgemini\b/i.test(combined);
    }

    function isExcludedUtilityOption(option) {
        const label = normalizeText(option?.label).toLowerCase();
        if (!label) return true;
        if (/^(?:auto|自动|自动选择)$/i.test(label)) return true;
        if (/\bdeep\s*research\b|深度研究/i.test(label)) return true;
        return false;
    }

    function extractGeneration(baseName, modelId) {
        const combined = `${normalizeText(baseName)} ${normalizeText(modelId)}`.toLowerCase();
        const gemMatch = combined.match(/\bgemini[-_\s]*(\d+(?:\.\d+)?)\b/i);
        if (gemMatch) {
            const v = parseFloat(gemMatch[1]);
            if (Number.isFinite(v)) return v;
        }
        const genericMatch = combined.match(/\b(\d+(?:\.\d+)?)\b/);
        if (genericMatch) {
            const v = parseFloat(genericMatch[1]);
            if (Number.isFinite(v) && v >= 1 && v <= 99) return v;
        }
        return 0;
    }

    function classifyFamily(baseName, modelId) {
        const combined = `${normalizeText(baseName)} ${normalizeText(modelId)}`.toLowerCase();
        const isLightweight =
            /\b(?:nano|flash[-_\s]*lite|lite|flash|fast|mini)\b/i.test(combined) &&
            !/\b(?:pro|ultra|argon|carbon|neon)\b/i.test(combined);

        if (isLightweight) {
            let tier = 3.0;
            if (/\bnano\b/i.test(combined)) tier = 1.0;
            else if (/\bflash[-_\s]*lite\b|\blite\b|\bmini\b/i.test(combined)) tier = 2.0;
            return { flagshipBucket: 0, codenameTier: tier, isKnownCodename: true };
        }

        let codenameTier = null;
        if (/\bpro\b/i.test(combined)) codenameTier = 4.0;
        if (/\bultra\b/i.test(combined)) codenameTier = Math.max(codenameTier ?? 0, 5.0);
        if (/\bargon\b/i.test(combined)) codenameTier = Math.max(codenameTier ?? 0, 6.0);
        if (/\bcarbon\b/i.test(combined)) codenameTier = Math.max(codenameTier ?? 0, 6.5);
        if (/\bneon\b/i.test(combined)) codenameTier = Math.max(codenameTier ?? 0, 7.0);

        if (codenameTier !== null) {
            return { flagshipBucket: 2, codenameTier, isKnownCodename: true };
        }
        return { flagshipBucket: 2, codenameTier: 7.2, isKnownCodename: false };
    }

    function selectBestModelOption(ctx, activeConfig = config) {
        const rawOptions = Array.isArray(ctx?.modelOptions) ? ctx.modelOptions : [];
        const usable = rawOptions.filter(opt => opt && !opt.disabled && !isExcludedUtilityOption(opt));
        if (usable.length === 0) return null;

        let pool = usable;
        if (activeConfig.preferredModelHint) {
            const hintRe = new RegExp(escapeRegExp(activeConfig.preferredModelHint), 'i');
            const hinted = usable.filter(opt => hintRe.test(`${normalizeText(opt.label)} ${normalizeText(opt.modelId)}`));
            if (hinted.length > 0) pool = hinted;
        } else if (activeConfig.strategy !== 'highest_any') {
            const nonCustom = usable.filter(opt => !opt.isCustom);
            const geminiPool = (nonCustom.length > 0 ? nonCustom : usable).filter(isGeminiOption);
            if (geminiPool.length > 0) pool = geminiPool;
        }

        const recommendedOrder = buildRecommendedOrderMap(ctx?.modelSorts);
        const reverseEffortLookup = buildReverseEffortLookup(ctx?.effortIndex);

        const enriched = pool.map((option, originalIndex) => {
            const parsed = parseModelEffort(option, reverseEffortLookup);
            const sig = modelSignature(option);
            const recIdx = recommendedOrder.has(sig) ? recommendedOrder.get(sig) : 999999;
            const family = classifyFamily(parsed.base, option.modelId);
            const generation = extractGeneration(parsed.base, option.modelId);
            return {
                option,
                originalIndex,
                baseKey: parsed.base.toLowerCase(),
                base: parsed.base,
                effort: parsed.effort,
                effortRank: parsed.effortRank,
                recommendedIndex: recIdx,
                generation,
                flagshipBucket: family.flagshipBucket,
                codenameTier: family.codenameTier,
                isKnownCodename: family.isKnownCodename
            };
        });

        const baseStats = new Map();
        for (const item of enriched) {
            const prev = baseStats.get(item.baseKey) || { maxEffortRank: -1, bestRecommendedIndex: 999999 };
            if (item.effortRank > prev.maxEffortRank) prev.maxEffortRank = item.effortRank;
            if (item.recommendedIndex < prev.bestRecommendedIndex) prev.bestRecommendedIndex = item.recommendedIndex;
            baseStats.set(item.baseKey, prev);
        }

        let candidates = enriched;
        if (activeConfig.preferredEffortHint) {
            const hintLower = activeConfig.preferredEffortHint.toLowerCase();
            const wordRe = new RegExp(`(?:^|[^a-z])${escapeRegExp(hintLower)}(?:$|[^a-z])`, 'i');
            const exactEff = enriched.filter(item => item.effort === hintLower);
            const wordMatched = exactEff.length > 0
                ? exactEff
                : enriched.filter(item => wordRe.test(item.effort) || wordRe.test(normalizeText(item.option.label)));
            if (wordMatched.length > 0) {
                candidates = wordMatched;
            } else {
                const looseRe = new RegExp(escapeRegExp(hintLower), 'i');
                const looseMatched = enriched.filter(item =>
                    looseRe.test(item.effort) || looseRe.test(normalizeText(item.option.label))
                );
                if (looseMatched.length > 0) candidates = looseMatched;
            }
        }

        // Strict weak ordering (total, transitive): compute a deterministic scalar tier per baseKey.
        // Unknown codenames in the recommended list are ranked between Pro (20) and Ultra (30) by their
        // recommended order so a future flagship codename can beat Pro while never forming a cycle.
        const baseEffectiveTier = new Map();
        for (const item of candidates) {
            if (baseEffectiveTier.has(item.baseKey)) continue;
            const stat = baseStats.get(item.baseKey);
            const effectiveTier = item.isKnownCodename
                ? item.codenameTier
                : (stat.bestRecommendedIndex < 999999 ? 25 : item.codenameTier);
            baseEffectiveTier.set(item.baseKey, effectiveTier);
        }

        const ranked = candidates.slice().sort((a, b) => {
            if (b.flagshipBucket !== a.flagshipBucket) return b.flagshipBucket - a.flagshipBucket;
            if (b.generation !== a.generation) return b.generation - a.generation;
            const statA = baseStats.get(a.baseKey);
            const statB = baseStats.get(b.baseKey);
            if (statB.maxEffortRank !== statA.maxEffortRank) return statB.maxEffortRank - statA.maxEffortRank;
            if (a.baseKey !== b.baseKey) {
                const tierA = baseEffectiveTier.get(a.baseKey);
                const tierB = baseEffectiveTier.get(b.baseKey);
                if (tierB !== tierA) return tierB - tierA;
                if (statA.bestRecommendedIndex !== statB.bestRecommendedIndex) {
                    return statA.bestRecommendedIndex - statB.bestRecommendedIndex;
                }
            }
            if (b.effortRank !== a.effortRank) return b.effortRank - a.effortRank;
            if (a.recommendedIndex !== b.recommendedIndex) return a.recommendedIndex - b.recommendedIndex;
            return a.originalIndex - b.originalIndex;
        });

        return ranked[0]?.option || null;
    }

    function hasExistingMessagesInDom() {
        const bubbles = document.querySelectorAll?.('[data-testid="user-message-bubble"]');
        if (!bubbles || bubbles.length === 0) return false;
        for (const node of bubbles) {
            if (isVisibleElement(node)) return true;
        }
        return false;
    }

    function isBlankNewConversationRoute() {
        const pathname = String(window.location?.pathname || '/');
        if (/^\/c\/(?!new(?:\/|$))[^/?#]+/i.test(pathname)) return false;
        if (/^\/(?:settings|skills|scheduled|plugins|mcp|extensions|account)\b/i.test(pathname)) return false;
        return /^\/(?:new\/?|c\/new\/?|chat\/?)?$/i.test(pathname);
    }

    function isEligibleBlankSession() {
        if (!isBlankNewConversationRoute() || hasExistingMessagesInDom()) return false;
        const trigger = document.querySelector?.('[data-testid="model-selector-trigger"]');
        return Boolean(trigger && isVisibleElement(trigger));
    }

    function trackManualModelChange(ctx) {
        const currentSig = modelSignature(ctx?.selectedModel);
        const now = Date.now();
        const menuOpenNow = Boolean(ctx?.open);
        if (menuOpenNow) lastUserPickerInteractionAt = now;
        if (activeZeroSessionKey && lastSelectedSignature && currentSig && currentSig !== lastSelectedSignature) {
            const interactedAfterSynthetic = lastUserPickerInteractionAt > lastSyntheticSetAt;
            const isMatchingSyntheticEcho = currentSig === lastSyntheticTargetSig && (now - lastSyntheticSetAt < 1200);
            const recentlyInteracted = menuOpenNow || lastMenuOpenSeen || (now - lastUserPickerInteractionAt < MANUAL_INTERACTION_WINDOW_MS);
            if (!isMatchingSyntheticEcho && (interactedAfterSynthetic || recentlyInteracted)) {
                manualOverrideSessionKey = activeZeroSessionKey;
                status.manualOverridden = true;
                status.state = 'manual_override';
            }
        }
        lastMenuOpenSeen = menuOpenNow;
        if (currentSig) lastSelectedSignature = currentSig;
    }

    function evaluateOnce() {
        if (disposed) return status;
        status.lastCheckedAt = Date.now();
        status.route = String(window.location?.pathname || '/');

        if (!config.enabled) {
            status.state = 'disabled';
            return status;
        }

        if (!isEligibleBlankSession()) {
            if (wasInZeroState) {
                wasInZeroState = false;
                activeZeroSessionKey = '';
                manualOverrideSessionKey = '';
                lastSelectedSignature = '';
                status.manualOverridden = false;
            }
            status.state = /^\/c\//i.test(status.route) ? 'skipped_existing_conversation' : 'skipped_not_blank';
            return status;
        }

        if (!wasInZeroState) {
            wasInZeroState = true;
            zeroSessionSeq += 1;
            activeZeroSessionKey = `${status.route}::${zeroSessionSeq}`;
            activeZeroSessionEnteredAt = Date.now();
            applyCountInSession = 0;
            manualOverrideSessionKey = '';
            lastSelectedSignature = '';
            status.manualOverridden = false;
        }

        const ctx = findModelSelectorContext();
        if (!ctx) {
            status.state = 'waiting_provider';
            return status;
        }

        status.availableCount = Array.isArray(ctx.modelOptions) ? ctx.modelOptions.length : 0;
        if (ctx.selectedModel) {
            status.selectedLabel = normalizeText(ctx.selectedModel.label);
            status.selectedModelId = normalizeText(ctx.selectedModel.modelId);
        }

        trackManualModelChange(ctx);
        if (manualOverrideSessionKey && manualOverrideSessionKey === activeZeroSessionKey) {
            status.manualOverridden = true;
            status.state = 'manual_override';
            return status;
        }
        if (ctx.isModelListLoading || status.availableCount === 0) {
            status.state = 'waiting_models';
            return status;
        }
        if (ctx.bestOfNConfig?.isBestOfNEnabled) {
            status.state = 'skipped_best_of_n';
            return status;
        }
        if (ctx.open) {
            status.state = 'menu_open_deferred';
            return status;
        }

        const best = selectBestModelOption(ctx, config);
        if (!best) {
            status.state = 'no_candidate';
            return status;
        }

        status.targetLabel = normalizeText(best.label);
        status.targetModelId = normalizeText(best.modelId);

        const currentSig = modelSignature(ctx.selectedModel);
        const targetSig = modelSignature(best);
        if (currentSig === targetSig) {
            lastSelectedSignature = targetSig;
            status.state = 'already_highest';
            return status;
        }
        if (applyCountInSession >= MAX_APPLIES_PER_SESSION) {
            status.state = 'max_applies_reached';
            return status;
        }
        if (applyCountInSession > 0 && Date.now() - activeZeroSessionEnteredAt > CONVERGENCE_WINDOW_MS) {
            status.state = 'convergence_window_closed';
            return status;
        }

        try {
            lastSyntheticSetAt = Date.now();
            lastSyntheticTargetSig = targetSig;
            applyCountInSession += 1;
            ctx.setSelectedModel(best);
            lastSelectedSignature = targetSig;
            status.selectedLabel = status.targetLabel;
            status.selectedModelId = status.targetModelId;
            status.appliedCount += 1;
            status.lastAppliedAt = Date.now();
            status.state = 'applied';
        } catch (err) {
            status.state = `error:${err && err.message ? err.message : String(err)}`;
        }
        return status;
    }

    function scheduleCheck(delayMs = 80) {
        if (disposed) return;
        if (checkTimer) clearTimeout(checkTimer);
        checkTimer = setTimeout(() => {
            checkTimer = null;
            evaluateOnce();
        }, delayMs);
    }

    function onUserPointerOrClick(event) {
        if (disposed || !config.enabled || !event || !event.isTrusted) return;
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;

        const isExplicitModelControl = Boolean(target.closest('[data-testid="model-selector-trigger"], [data-model-label]'));
        const inMenuContainer = !isExplicitModelControl && Boolean(target.closest(
            '[role="listbox"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [data-radix-popper-content-wrapper]'
        ));
        if (isExplicitModelControl || (inMenuContainer && isBlankNewConversationRoute() && Boolean(findModelSelectorContext()?.open))) {
            lastUserPickerInteractionAt = Date.now();
            scheduleCheck(120);
            return;
        }

        const newConvoBtn = target.closest(
            '[data-testid="extension-new-conversation"], [aria-label*="New Conversation" i], [data-testid*="new-conversation" i]'
        );
        const sidebarBtn = !newConvoBtn && target.closest('.bg-sidebar button, .bg-sidebar a');
        const isSidebarNewConvo = Boolean(sidebarBtn && /^new\s+conversation$/i.test(normalizeText(sidebarBtn.textContent)));
        if ((newConvoBtn || isSidebarNewConvo) && isBlankNewConversationRoute()) {
            wasInZeroState = false;
            manualOverrideSessionKey = '';
            status.manualOverridden = false;
            scheduleCheck(120);
        }
    }

    function onKeyDown(event) {
        if (disposed || !config.enabled || !event || !event.isTrusted) return;
        if (!isBlankNewConversationRoute()) return;
        const target = event.target;
        const nearSelector = Boolean(lastMenuOpenSeen || target?.closest?.('[data-testid="model-selector-trigger"], [data-model-label], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
        if (!nearSelector) return;
        const ctx = findModelSelectorContext();
        if (ctx?.open) {
            lastUserPickerInteractionAt = Date.now();
            scheduleCheck(120);
        }
    }

    const onPopState = () => scheduleCheck(60);
    const observer = typeof MutationObserver === 'function'
        ? new MutationObserver(() => { if (!disposed) scheduleCheck(120); })
        : null;

    document.addEventListener('pointerdown', onUserPointerOrClick, true);
    document.addEventListener('click', onUserPointerOrClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('popstate', onPopState);
    if (observer && document.body) observer.observe(document.body, { childList: true, subtree: true });
    pollTimer = window.setInterval(() => { if (!disposed) evaluateOnce(); }, 600);

    const api = {
        version: VERSION,
        status: () => ({ ...status, config: { ...config } }),
        recheck: () => evaluateOnce(),
        setConfig(nextCfg) {
            if (!nextCfg || typeof nextCfg !== 'object') return status;
            const wasEnabled = config.enabled;
            if (typeof nextCfg.enabled === 'boolean') config.enabled = nextCfg.enabled;
            if (typeof nextCfg.strategy === 'string' && nextCfg.strategy.trim()) config.strategy = nextCfg.strategy.trim();
            if (typeof nextCfg.preferredModelHint === 'string') config.preferredModelHint = nextCfg.preferredModelHint.trim();
            if (typeof nextCfg.preferredEffortHint === 'string') config.preferredEffortHint = nextCfg.preferredEffortHint.trim();
            if (!wasEnabled && config.enabled) {
                wasInZeroState = false;
                applyCountInSession = 0;
            }
            return evaluateOnce();
        },
        selectBestModelOption,
        dispose() {
            if (disposed) return;
            disposed = true;
            if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (observer) { try { observer.disconnect(); } catch {} }
            document.removeEventListener('pointerdown', onUserPointerOrClick, true);
            document.removeEventListener('click', onUserPointerOrClick, true);
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('popstate', onPopState);
            if (window.__agyPlusDefaultModel === api) {
                delete window.__agyPlusDefaultModel;
            }
        }
    };

    window.__agyPlusDefaultModel = api;
    evaluateOnce();
    scheduleCheck(250);
    return api.status();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { installAgyPlusDefaultModel };
}
