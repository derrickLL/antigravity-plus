function installAgyPlusUI(initOptions) {
    'use strict';
    const opts = typeof initOptions === 'string' ? { themeCss: initOptions, widgetsCss: '' } : (initOptions || {});
    const themeCssText = String(opts.themeCss || '');
    const widgetsCssText = String(opts.widgetsCss || '');

    window.__agyPlusUI?.dispose?.();
    try { window.__derrickUI?.dispose?.(); } catch {}

    const allowedHost = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(location.hostname || '').toLowerCase());
    if (!window.nativeStorage || !allowedHost) return { installed: false };

    const defaultFeatures = {
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
    };

    function cloneConfig(raw) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const features = {};
        for (const k of Object.keys(defaultFeatures)) {
            features[k] = typeof src.features?.[k] === 'boolean' ? src.features[k] : defaultFeatures[k];
        }
        const rawMode = String(src.translation?.mode || 'hybrid').trim().toLowerCase();
        return {
            features,
            network: {
                proxyUrl: String(src.network?.proxyUrl || ''),
                externalBrowserPath: String(src.network?.externalBrowserPath || '')
            },
            model: {
                strategy: String(src.model?.strategy || 'highest_gemini'),
                preferredModelHint: String(src.model?.preferredModelHint || ''),
                preferredEffortHint: String(src.model?.preferredEffortHint || '')
            },
            translation: {
                mode: ['hybrid', 'online', 'offline'].includes(rawMode) ? rawMode : 'hybrid',
                offlineRoot: String(src.translation?.offlineRoot || '')
            },
            onboarding: {
                tourCompleted: Boolean(src.onboarding?.tourCompleted)
            }
        };
    }

    let currentConfig = cloneConfig(opts.config);
    let currentRuntimeMeta = opts.runtimeMeta && typeof opts.runtimeMeta === 'object'
        ? { ...opts.runtimeMeta }
        : { offlineAvailable: false, offlineRoot: '' };
    const pendingConfigPatches = [];

    const widgetsStyle = document.createElement('style');
    widgetsStyle.id = 'agy-plus-widgets-style';
    widgetsStyle.textContent = widgetsCssText;
    document.head.append(widgetsStyle);

    const themeStyle = document.createElement('style');
    themeStyle.id = 'agy-plus-theme-style';
    document.head.append(themeStyle);

    const footerLeft = document.createElement('div');
    footerLeft.className = 'agy-plus-footer-left';

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'agy-plus-icon-btn';
    badge.dataset.testid = 'agy-plus-quota-indicator';
    badge.innerHTML =
        '<span class="agy-plus-quota-ring agy-plus-quota-split-ring" aria-hidden="true">' +
        '<svg class="agy-plus-quota-svg" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path class="agy-plus-quota-arc-track" data-track="5h" data-half="5h" d="M 2.34 9.41 A 10 10 0 0 1 21.66 9.41"></path>' +
        '<path class="agy-plus-quota-arc-track" data-track="weekly" data-half="weekly" d="M 2.34 14.59 A 10 10 0 0 0 21.66 14.59"></path>' +
        '<path class="agy-plus-quota-arc-fill" data-arc="5h" data-half="5h" pathLength="100" d="M 2.34 9.41 A 10 10 0 0 1 21.66 9.41"></path>' +
        '<path class="agy-plus-quota-arc-fill" data-arc="weekly" data-half="weekly" pathLength="100" d="M 2.34 14.59 A 10 10 0 0 0 21.66 14.59"></path>' +
        '<path class="agy-plus-quota-arc-hit" data-hit="5h" data-half="5h" d="M 2.34 9.41 A 10 10 0 0 1 21.66 9.41"></path>' +
        '<path class="agy-plus-quota-arc-hit" data-hit="weekly" data-half="weekly" d="M 2.34 14.59 A 10 10 0 0 0 21.66 14.59"></path>' +
        '</svg></span><span class="agy-plus-quota-diamond" aria-hidden="true"></span>';

    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'agy-plus-icon-btn';
    settingsButton.dataset.testid = 'agy-plus-settings-button';
    settingsButton.setAttribute('aria-label', 'Antigravity Plus 功能开关面板 (Ctrl+Shift+,)');
    settingsButton.title = 'Antigravity Plus 功能开关 (Ctrl+Shift+,)';
    settingsButton.innerHTML =
        '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<line x1="2.5" y1="4.5" x2="13.5" y2="4.5"></line><circle cx="6" cy="4.5" r="1.6" fill="var(--agp-card,#1c1c1c)"></circle>' +
        '<line x1="2.5" y1="8.5" x2="13.5" y2="8.5"></line><circle cx="10.5" cy="8.5" r="1.6" fill="var(--agp-card,#1c1c1c)"></circle>' +
        '<line x1="2.5" y1="12.5" x2="13.5" y2="12.5"></line><circle cx="5.5" cy="12.5" r="1.6" fill="var(--agp-card,#1c1c1c)"></circle>' +
        '</svg>';

    footerLeft.append(badge, settingsButton);

    const pendingContext = document.createElement('button');
    pendingContext.type = 'button';
    pendingContext.className = 'agy-plus-icon-btn agy-plus-context-pending';
    pendingContext.dataset.testid = 'agy-plus-context-pending';
    pendingContext.innerHTML = '<span class="agy-plus-quota-ring" aria-hidden="true"></span>';

    const contextPanel = document.createElement('div');
    contextPanel.id = 'agy-plus-context-panel';
    contextPanel.className = 'agy-plus-popup-panel';
    contextPanel.setAttribute('role', 'region');
    contextPanel.setAttribute('aria-label', 'Context usage details');
    contextPanel.hidden = true;
    pendingContext.setAttribute('aria-controls', contextPanel.id);
    pendingContext.setAttribute('aria-expanded', 'false');
    document.body.append(contextPanel);

    const performanceBadge = document.createElement('button');
    performanceBadge.type = 'button';
    performanceBadge.className = 'agy-plus-performance-button';
    performanceBadge.dataset.testid = 'agy-plus-performance-indicator';

    const performancePanel = document.createElement('div');
    performancePanel.id = 'agy-plus-performance-panel';
    performancePanel.className = 'agy-plus-popup-panel';
    performancePanel.setAttribute('role', 'region');
    performancePanel.setAttribute('aria-label', 'Model performance details');
    performancePanel.hidden = true;
    performanceBadge.setAttribute('aria-controls', performancePanel.id);
    performanceBadge.setAttribute('aria-expanded', 'false');
    document.body.append(performancePanel);

    const panel = document.createElement('div');
    panel.id = 'agy-plus-quota-panel';
    panel.className = 'agy-plus-popup-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Remaining quota details');
    panel.hidden = true;
    document.body.append(panel);
    badge.setAttribute('aria-controls', panel.id);
    badge.setAttribute('aria-expanded', 'false');

    const quotaTooltip = document.createElement('div');
    quotaTooltip.id = 'agy-plus-quota-tooltip';
    quotaTooltip.className = 'agy-plus-popup-panel agy-plus-quota-tooltip';
    quotaTooltip.dataset.testid = 'agy-plus-quota-tooltip';
    quotaTooltip.setAttribute('role', 'tooltip');
    quotaTooltip.hidden = true;
    document.body.append(quotaTooltip);

    const settingsPanel = document.createElement('div');
    settingsPanel.id = 'agy-plus-settings-panel';
    settingsPanel.className = 'agy-plus-popup-panel';
    settingsPanel.dataset.testid = 'agy-plus-settings-panel';
    settingsPanel.setAttribute('role', 'dialog');
    settingsPanel.setAttribute('aria-label', 'Antigravity Plus 功能开关');
    settingsPanel.hidden = true;
    settingsButton.setAttribute('aria-controls', settingsPanel.id);
    settingsButton.setAttribute('aria-expanded', 'false');
    document.body.append(settingsPanel);

    const marked = new Map();
    let groups = [];
    let refreshedAt = 0;
    let error = '';
    let inFlight = false;
    let disposed = false;
    let scheduled = 0;
    let modelGroup = '';
    let contextUsage;
    let quotaPercent = '—';
    let fiveHourPercent = '—';
    let weeklyPercent = '—';
    let hoveredHalf = '';
    let contextPanelKey = '';
    let contextBreakdownExpanded = false;
    let contextBreakdownToggle = null;
    let contextBreakdownList = null;
    let quotaPanelKey = '';
    let performanceKey = '';
    let performanceMetrics;
    let lastPermissionDiag = null;

    const HOVER_CLOSE_DELAY_MS = 140;
    let contextPinned = false;
    let performancePinned = false;
    let contextHoverTimer = 0;
    let performanceHoverTimer = 0;

    const readPerf = typeof readAgyPlusPerformance === 'function'
        ? readAgyPlusPerformance
        : () => ({ phase: 'No data', userStartMs: null, modelCalls: 0, outputTokens: null, responseTokens: null, thinkingTokens: null, inputTokens: null, elapsedSeconds: null, modelSeconds: null, averageTokensPerSecond: null });
    const formatDur = typeof formatAgyPlusDuration === 'function'
        ? formatAgyPlusDuration
        : s => (s == null ? '—' : `${Math.round(s)}s`);

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function heading(title, subtitle, value) {
        const row = element('div', 'agy-plus-panel-heading');
        const label = element('div', '');
        label.append(element('h3', 'agy-plus-panel-title', title), element('div', 'agy-plus-panel-subtitle', subtitle));
        row.append(label, element('span', 'agy-plus-panel-value', value));
        return row;
    }

    function progress(fraction, label) {
        const track = element('div', 'agy-plus-limit-track');
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', label);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        const bounded = Math.max(0, Math.min(1, fraction));
        track.setAttribute('aria-valuenow', String(Math.round(bounded * 100)));
        const fill = element('div', 'agy-plus-limit-fill');
        fill.style.width = `${bounded * 100}%`;
        track.append(fill);
        return track;
    }

    function positionPanel(popup, anchor, alignLeft = false) {
        if (popup.hidden) return;
        if (!anchor || !anchor.isConnected || anchor.hidden) {
            const left = Math.max(12, Math.round((innerWidth - popup.offsetWidth) / 2));
            const top = Math.max(16, Math.round((innerHeight - popup.offsetHeight) / 2));
            popup.style.left = `${left}px`;
            popup.style.top = `${top}px`;
            popup.style.right = 'auto';
            popup.style.bottom = 'auto';
            return;
        }
        const bounds = anchor.getBoundingClientRect();
        const rawLeft = alignLeft ? bounds.left : (bounds.right - popup.offsetWidth);
        const left = Math.max(12, Math.min(rawLeft, innerWidth - popup.offsetWidth - 12));
        const top = Math.max(12, Math.min(bounds.top - popup.offsetHeight - 9, innerHeight - popup.offsetHeight - 12));
        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
        popup.style.right = 'auto';
        popup.style.bottom = 'auto';
    }

    function mark(node, name, value = '') {
        if (!marked.has(node)) marked.set(node, new Map());
        const attributes = marked.get(node);
        if (!attributes.has(name)) attributes.set(name, node.getAttribute(name));
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }

    function unmark(node, name) {
        const attributes = marked.get(node);
        if (!attributes || !attributes.has(name)) return;
        const previousValue = attributes.get(name);
        if (previousValue === null) node.removeAttribute(name);
        else node.setAttribute(name, previousValue);
        attributes.delete(name);
        if (attributes.size === 0) marked.delete(node);
    }

    function clearThemeMarks() {
        for (const [node, attributes] of Array.from(marked.entries())) {
            for (const name of ['lang', 'data-agy-plus-prose', 'data-agy-plus-chat-column']) {
                if (attributes.has(name)) unmark(node, name);
            }
        }
    }

    function clearContextHoverTimer() {
        if (contextHoverTimer) {
            window.clearTimeout(contextHoverTimer);
            contextHoverTimer = 0;
        }
    }

    function clearPerformanceHoverTimer() {
        if (performanceHoverTimer) {
            window.clearTimeout(performanceHoverTimer);
            performanceHoverTimer = 0;
        }
    }

    function setContextPinned(pinned) {
        contextPinned = pinned;
        if (pinned) pendingContext.dataset.pinned = 'true';
        else delete pendingContext.dataset.pinned;
    }

    function setPerformancePinned(pinned) {
        performancePinned = pinned;
        if (pinned) performanceBadge.dataset.pinned = 'true';
        else delete performanceBadge.dataset.pinned;
    }

    function hideContextPanel() {
        clearContextHoverTimer();
        setContextPinned(false);
        contextPanel.hidden = true;
        contextBreakdownExpanded = false;
        syncContextBreakdownUi(false);
        pendingContext.setAttribute('aria-expanded', 'false');
    }

    function hidePerformancePanel() {
        clearPerformanceHoverTimer();
        setPerformancePinned(false);
        performancePanel.hidden = true;
        performanceBadge.setAttribute('aria-expanded', 'false');
    }

    function hideQuotaPanels() {
        panel.hidden = true;
        quotaTooltip.hidden = true;
        badge.setAttribute('aria-expanded', 'false');
    }

    function hideSettingsPanel() {
        settingsPanel.hidden = true;
        settingsButton.setAttribute('aria-expanded', 'false');
    }

    function closeAllPopups() {
        hideQuotaPanels();
        hideContextPanel();
        hidePerformancePanel();
        hideSettingsPanel();
    }

    // ---- Feature Control Panel ----

    const SETTINGS_SECTIONS = [
        {
            title: '界面与实时状态微件',
            items: [
                { key: 'codexTheme', label: 'Codex 极简桌面排版主题', desc: '优化字体对比度、输入框阴影与 900px 宽屏阅读列' },
                { key: 'contextRing', label: '上下文窗口三色圆环', desc: '0–59% 绿 / 60–79% 橙 / ≥80% 红，支持悬停预览与点击固定' },
                { key: 'performancePill', label: '任务耗时与速率胶囊', desc: '实时阶段计时与 Avg tok/s 速率，支持免点击悬停查看明细' },
                { key: 'quotaSplitRing', label: '5 小时 / 周高对比双半环配额', desc: '侧边栏左下角加粗双半环剩余额度与重置时间悬停提示' }
            ]
        },
        {
            title: '交互增强与模型默认策略',
            items: [
                { key: 'autoHighestModel', label: '空白新对话自动锁定最高模型', desc: '仅在空白新对话自动选最高阶旗舰模型与最高推理档位' },
                { key: 'navigationGestures', label: '鼠标侧键与右键四向手势', desc: '支持侧键前进/后退及按住右键拖拽切换页面与上下滚动' },
                { key: 'newWindowMenu', label: 'Window 菜单新建独立窗口', desc: '在顶部 Window 下拉菜单提供 New Window (Ctrl+Shift+N)' }
            ]
        },
        {
            title: '实时流式中文化',
            items: [
                { key: 'thoughtTranslation', label: 'Thinking 思考过程实时中文化', desc: '展开思考块时保留代码路径字面量，自动流式双语对照' },
                { key: 'titleTranslation', label: '侧边栏与顶栏英文标题中文化', desc: '自动将英文对话标题译为中文，悬停显示中英双语' }
            ],
            hasTranslationMode: true
        },
        {
            title: '任务弹窗与网络浏览器修复',
            items: [
                { key: 'taskToast', label: '右下角无抢焦交互式任务弹窗', desc: '后台完成提醒、单选/多选问答提交与一键权限审批' },
                { key: 'externalBrowser', label: '优先使用外部浏览器打开链接', desc: '拦截外部 http/https 链接并用已配置的 Chrome 或系统浏览器打开' },
                { key: 'localProxy', label: '进程级本地代理与残留清理', desc: '自动注入本地代理并清理损坏的系统环境变量（下次启动生效）' },
                { key: 'fastpushFix', label: 'language_server 断连修复', desc: '注入 --remote_agent_fastpush_override=false 防流式断连（下次启动生效）' }
            ]
        },
        {
            title: '全局工作流规则 (~/.gemini/config/rules)',
            items: [
                { key: 'chineseExecutionRule', label: '默认简体中文执行与回复规则', desc: '同步 agy-plus-chinese-execution.md，让模型默认使用中文沟通' },
                { key: 'workspaceScriptsRule', label: '禁止 C 盘临时目录脚本规则', desc: '同步 agy-plus-workspace-local-scripts.md，脚本统一放项目目录' }
            ]
        }
    ];

    let settingsPanelMounted = false;
    let lastAppliedSignature = '';

    function emitConfigPatch(patch) {
        if (patch.features) {
            currentConfig.features = { ...currentConfig.features, ...patch.features };
        }
        if (patch.translation) {
            currentConfig.translation = { ...currentConfig.translation, ...patch.translation };
        }
        if (patch.onboarding) {
            currentConfig.onboarding = { ...currentConfig.onboarding, ...patch.onboarding };
        }
        applyConfigInternal(currentConfig, currentRuntimeMeta, true);

        try {
            window.__agyPlusThoughtUI?.setFeatures?.({
                thoughtTranslation: currentConfig.features.thoughtTranslation !== false,
                titleTranslation: currentConfig.features.titleTranslation !== false
            });
            window.__agyPlusDefaultModel?.setConfig?.({
                enabled: currentConfig.features.autoHighestModel !== false,
                strategy: currentConfig.model.strategy,
                preferredModelHint: currentConfig.model.preferredModelHint,
                preferredEffortHint: currentConfig.model.preferredEffortHint
            });
            window.__agyPlusNavUI?.setEnabled?.(currentConfig.features.navigationGestures !== false);
        } catch {}

        const bridge = window.__agyPlusBridge;
        if (bridge && typeof bridge.updateConfig === 'function') {
            Promise.resolve()
                .then(() => bridge.updateConfig(patch))
                .then(res => {
                    if (!res || !res.ok) pendingConfigPatches.push(patch);
                })
                .catch(() => {
                    pendingConfigPatches.push(patch);
                });
        } else {
            pendingConfigPatches.push(patch);
        }
    }

    function syncSettingsPanelState() {
        if (!settingsPanelMounted) return;
        for (const sw of settingsPanel.querySelectorAll('[data-feature-key]')) {
            const k = sw.dataset?.featureKey || sw.getAttribute('data-feature-key');
            if (k) sw.setAttribute('aria-checked', String(currentConfig.features[k] !== false));
        }
        for (const segBtn of settingsPanel.querySelectorAll('[data-translation-mode]')) {
            const m = segBtn.dataset?.translationMode || segBtn.getAttribute('data-translation-mode');
            if (m) segBtn.setAttribute('aria-pressed', String(currentConfig.translation.mode === m));
        }
        const hintNode = settingsPanel.querySelector('[data-testid="agy-plus-offline-hint"]');
        if (hintNode) {
            hintNode.textContent = currentRuntimeMeta.offlineAvailable
                ? '已检测到本地 CTranslate2 离线模型包'
                : '未安装可选离线模型包（仅离线模式下将保持英文原文）';
        }
    }

    function renderSettingsPanel() {
        if (settingsPanelMounted) {
            syncSettingsPanelState();
            if (!settingsPanel.hidden) {
                positionPanel(settingsPanel, settingsButton, true);
            }
            return;
        }
        const header = element('div', 'agy-plus-settings-header');
        const titleWrap = element('div', '');
        titleWrap.append(
            element('h3', 'agy-plus-panel-title', 'Antigravity Plus 功能控制中心'),
            element('div', 'agy-plus-panel-subtitle', '所有开关即时同步并持久化到本地 config.json')
        );
        const closeBtn = element('button', 'agy-plus-settings-close', '×');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', '关闭面板');
        closeBtn.addEventListener('click', hideSettingsPanel);
        header.append(titleWrap, closeBtn);

        const nodes = [header];

        for (const sectionDef of SETTINGS_SECTIONS) {
            const sec = element('section', 'agy-plus-settings-section');
            sec.append(element('h4', 'agy-plus-settings-section-title', sectionDef.title));

            for (const item of sectionDef.items) {
                const row = element('div', 'agy-plus-toggle-row');
                const meta = element('div', 'agy-plus-toggle-meta');
                meta.append(
                    element('div', 'agy-plus-toggle-label', item.label),
                    element('div', 'agy-plus-toggle-desc', item.desc)
                );
                const enabled = currentConfig.features[item.key] !== false;
                const toggleBtn = element('button', 'agy-plus-switch');
                toggleBtn.type = 'button';
                toggleBtn.setAttribute('role', 'switch');
                toggleBtn.dataset.featureKey = item.key;
                toggleBtn.setAttribute('data-feature-key', item.key);
                toggleBtn.setAttribute('aria-label', item.label);
                toggleBtn.setAttribute('aria-checked', String(enabled));
                toggleBtn.append(element('span', 'agy-plus-switch-thumb'));
                toggleBtn.addEventListener('click', () => {
                    const nextVal = currentConfig.features[item.key] === false;
                    emitConfigPatch({ features: { [item.key]: nextVal } });
                });
                row.append(meta, toggleBtn);
                sec.append(row);
            }

            if (sectionDef.hasTranslationMode) {
                const modeRow = element('div', 'agy-plus-toggle-row');
                const modeMeta = element('div', 'agy-plus-toggle-meta');
                const offlineHint = currentRuntimeMeta.offlineAvailable
                    ? '已检测到本地 CTranslate2 离线模型包'
                    : '未安装可选离线模型包（仅离线模式下将保持英文原文）';
                const offlineDescEl = element('div', 'agy-plus-toggle-desc', offlineHint);
                offlineDescEl.dataset.testid = 'agy-plus-offline-hint';
                modeMeta.append(
                    element('div', 'agy-plus-toggle-label', '翻译引擎模式'),
                    offlineDescEl
                );
                const seg = element('div', 'agy-plus-segmented');
                for (const [modeKey, modeLabel] of [
                    ['hybrid', '混合加速'],
                    ['online', '仅在线'],
                    ['offline', '仅离线']
                ]) {
                    const b = element('button', 'agy-plus-seg-btn', modeLabel);
                    b.type = 'button';
                    b.dataset.translationMode = modeKey;
                    b.setAttribute('data-translation-mode', modeKey);
                    b.setAttribute('aria-pressed', String(currentConfig.translation.mode === modeKey));
                    b.addEventListener('click', () => {
                        if (currentConfig.translation.mode === modeKey) return;
                        emitConfigPatch({ translation: { mode: modeKey } });
                    });
                    seg.append(b);
                }
                modeRow.append(modeMeta, seg);
                sec.append(modeRow);
            }

            nodes.push(sec);
        }

        const footer = element('div', 'agy-plus-settings-footer');
        const replayTourBtn = element('button', 'agy-plus-action-link', '功能导览');
        replayTourBtn.type = 'button';
        replayTourBtn.dataset.testid = 'agy-plus-replay-tour';
        replayTourBtn.addEventListener('click', () => {
            startTour(0, { auto: false });
        });

        const enableAllBtn = element('button', 'agy-plus-action-link', '全部开启');
        enableAllBtn.type = 'button';
        enableAllBtn.dataset.testid = 'agy-plus-enable-all';
        enableAllBtn.addEventListener('click', () => {
            const allOn = {};
            for (const k of Object.keys(defaultFeatures)) allOn[k] = true;
            emitConfigPatch({ features: allOn });
        });

        const disableAllBtn = element('button', 'agy-plus-action-link', '全部关闭（原版模式）');
        disableAllBtn.type = 'button';
        disableAllBtn.dataset.testid = 'agy-plus-disable-all';
        disableAllBtn.addEventListener('click', () => {
            const allOff = {};
            for (const k of Object.keys(defaultFeatures)) allOff[k] = false;
            emitConfigPatch({ features: allOff });
        });

        footer.append(replayTourBtn, enableAllBtn, disableAllBtn);
        nodes.push(footer);

        settingsPanel.replaceChildren(...nodes);
        settingsPanelMounted = true;
        if (!settingsPanel.hidden) {
            positionPanel(settingsPanel, settingsButton, true);
        }
    }

    function applyConfigInternal(nextConfig, nextRuntimeMeta, forceApply = false) {
        if (disposed) return;
        const normalizedNext = cloneConfig(nextConfig);
        const mergedMeta = nextRuntimeMeta && typeof nextRuntimeMeta === 'object'
            ? { ...currentRuntimeMeta, ...nextRuntimeMeta }
            : currentRuntimeMeta;
        const nextSig = JSON.stringify([normalizedNext, mergedMeta]);
        if (!forceApply && nextSig === lastAppliedSignature) {
            return;
        }
        lastAppliedSignature = nextSig;
        currentConfig = normalizedNext;
        currentRuntimeMeta = mergedMeta;

        const f = currentConfig.features;
        if (f.codexTheme !== false) {
            if (themeStyle.textContent !== themeCssText) themeStyle.textContent = themeCssText;
            document.body.classList.add('agy-plus-codex-ui');
        } else {
            themeStyle.textContent = '';
            document.body.classList.remove('agy-plus-codex-ui');
            clearThemeMarks();
        }

        if (f.contextRing !== false) {
            document.body.classList.add('agy-plus-context-ring-active');
            pendingContext.hidden = false;
            try {
                Promise.resolve(window.nativeStorage?.getItems?.()).then(s => {
                    if (s && s.contextUsageIndicatorEnabled !== 'true') {
                        void window.nativeStorage?.updateItems?.({ contextUsageIndicatorEnabled: 'true' });
                    }
                }).catch(() => {});
            } catch {}
        } else {
            document.body.classList.remove('agy-plus-context-ring-active');
            pendingContext.hidden = true;
            hideContextPanel();
        }

        if (f.performancePill !== false) {
            performanceBadge.hidden = false;
        } else {
            performanceBadge.hidden = true;
            hidePerformancePanel();
        }

        if (f.quotaSplitRing !== false) {
            const wasHidden = badge.hidden;
            badge.hidden = false;
            if (wasHidden && Date.now() - refreshedAt > 15000) {
                void refreshQuota();
            }
        } else {
            badge.hidden = true;
            hideQuotaPanels();
        }

        if (document.documentElement) {
            document.documentElement.setAttribute(
                'data-agy-plus-new-window-menu',
                f.newWindowMenu !== false ? 'true' : 'false'
            );
            try { globalThis.__agyPlusMenuController?.sync?.(); } catch {}
        }

        if (currentConfig.onboarding?.tourCompleted && tourActive && tourOpenedAutomatically) {
            stopTour({ markCompleted: false });
        }

        renderSettingsPanel();
        update();
    }

    // ---- Task Transitions, Interactive Toast & Native Approval ----

    const turnStarts = new Map();
    const conversationTitles = new Map();
    const trackedTaskStates = new Map();
    const pendingCompletions = [];
    const resolvedActionIds = new Map();
    const safeConversationIdRe = /^[A-Za-z0-9._-]+$/;

    function cleanConversationTitle(raw, maxLen = 72) {
        if (typeof raw !== 'string' || !raw.trim()) return '';
        let text = raw;
        const req = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(text);
        if (req) text = req[1];
        else {
            text = text
                .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
                .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
        }
        text = text.replace(/\s+/g, ' ').trim();
        if (!text) return '';
        return text.length > maxLen ? text.slice(0, maxLen - 1).trimEnd() + '…' : text;
    }

    let cachedAgentCtx = null;
    let cachedAgentCtxAt = 0;
    let cachedAgentCtxPath = '';

    function readAgentContext(forceFresh = false) {
        const now = Date.now();
        const curPath = String(location.pathname || '');
        if (!forceFresh && cachedAgentCtx && curPath === cachedAgentCtxPath && (now - cachedAgentCtxAt) < 120) {
            return {
                ...cachedAgentCtx,
                state: cachedAgentCtx.states?.get?.(cachedAgentCtx.conversationId)?.provider?.getState?.()
            };
        }
        const anchors = [
            document.querySelector('[data-testid="agent-input-box"]'),
            document.querySelector('[data-testid="interaction-takeover-card"]'),
            document.querySelector('[data-testid="conversation-view"]'),
            document.querySelector('[data-testid="sidebar-navigation-items"]'),
            document.querySelector('.bg-sidebar'),
            document.querySelector('[data-testid="title-menu-bar"]'),
            document.querySelector('#root > *'),
            document.body?.firstElementChild
        ].filter(Boolean);
        let conversationId = location.pathname.split('/')[2] || '';
        let states = null;
        let summaries = null;
        let agentService = null;
        let features = null;
        for (const anchor of anchors) {
            const key = Object.keys(anchor).find(name => name.startsWith('__reactFiber$'));
            let fiber = key && anchor[key];
            for (let depth = 0; fiber && depth < 600; depth++, fiber = fiber.return) {
                const props = fiber.memoizedProps;
                const value = props?.value;
                if (!agentService && typeof value?.handleCascadeUserInteraction === 'function') agentService = value;
                if (!features && typeof value?.get === 'function' && typeof value?.getBaseline === 'function') features = value;
                if (value?.conversationId && !conversationId) conversationId = value.conversationId;
                if (!states && typeof value?.getAgentStates === 'function') {
                    states = value.getAgentStates();
                }
                if (!summaries) {
                    const store = props?.store || value?.store;
                    if (typeof store?.getState === 'function') {
                        try {
                            const rootState = store.getState();
                            if (rootState?.trajectorySummaries) summaries = rootState.trajectorySummaries;
                        } catch {}
                    }
                }
                if (states && summaries && agentService && features) break;
            }
            if (states && summaries && agentService && features) break;
        }
        const ctx = {
            conversationId: conversationId || '',
            state: states?.get?.(conversationId)?.provider?.getState?.(),
            states,
            summaries,
            agentService,
            features
        };
        cachedAgentCtx = ctx;
        cachedAgentCtxAt = now;
        cachedAgentCtxPath = curPath;
        return ctx;
    }

    function readAgentEntry() {
        const ctx = readAgentContext();
        return { conversationId: ctx.conversationId, state: ctx.state };
    }

    function extractTitleFromState(state) {
        if (!state) return '';
        if (typeof state.title === 'string' && state.title.trim()) return cleanConversationTitle(state.title);
        if (typeof state.summary === 'string' && state.summary.trim()) return cleanConversationTitle(state.summary);
        const steps = state.trajectorySlice?.stepsInSlice || [];
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (step?.step?.case !== 'userInput') continue;
            const raw = step.step.value?.userResponse || step.step.value?.items?.map(x => x?.text || '').join(' ') || '';
            const cleaned = cleanConversationTitle(raw);
            if (cleaned) return cleaned;
        }
        return '';
    }

    function extractSidebarRowTitle(link) {
        const origAttr = link.getAttribute('data-agy-plus-title-original') ||
            link.parentElement?.getAttribute?.('data-agy-plus-title-original') || '';
        const directAttr = link.getAttribute('title') || link.getAttribute('aria-label') || '';
        if (directAttr.trim()) return directAttr.split('\n')[0];
        if (origAttr.trim()) return origAttr;
        const ownText = (link.textContent || '').trim();
        if (ownText) return ownText.replace(/\s+\d+(?:s|m|h|d|w|mo|y)$/i, '');
        const row = link.parentElement;
        if (!row) return '';
        const titledChild = row.querySelector?.('[title]');
        if (titledChild) {
            const t = (titledChild.getAttribute('title') || '').split('\n')[0];
            if (t.trim()) return t;
        }
        const parts = [];
        for (const child of row.children || []) {
            if (child === link) continue;
            const txt = (child.textContent || '').replace(/\s+/g, ' ').trim();
            if (!txt || /^\d+(?:s|m|h|d|w|mo|y)$/i.test(txt)) continue;
            parts.push(txt.replace(/\s+\d+(?:s|m|h|d|w|mo|y)$/i, ''));
            break;
        }
        if (parts.length > 0) return parts[0];
        return (row.textContent || '').replace(/\s+\d+(?:s|m|h|d|w|mo|y)$/i, '');
    }

    function scanConversationTitles() {
        for (const link of document.querySelectorAll('a[href]')) {
            let pathname = '';
            try { pathname = new URL(link.href, location.origin || 'https://127.0.0.1').pathname; } catch { continue; }
            const match = /^\/c\/([A-Za-z0-9._-]+)$/.exec(pathname);
            if (!match) continue;
            const id = match[1];
            const label = cleanConversationTitle(extractSidebarRowTitle(link), 96);
            if (label) conversationTitles.set(id, label);
        }
    }

    function isWaitingStepStatus(st) {
        return st === 9 || (typeof st === 'string' && /^WAITING$/i.test(st));
    }

    function extractQuestionsArrayFromObject(obj) {
        if (!obj) return null;
        if (Array.isArray(obj)) return obj;
        if (typeof obj === 'string') {
            try { return extractQuestionsArrayFromObject(JSON.parse(obj)); } catch { return null; }
        }
        if (typeof obj !== 'object') return null;
        const raw = obj.questions ?? obj.Questions ?? obj.Arguments ?? obj.ArgumentsJson ?? obj.arguments ?? obj.argumentsJson;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            try { return extractQuestionsArrayFromObject(JSON.parse(raw)); } catch { return null; }
        }
        if (raw && typeof raw === 'object' && Array.isArray(raw.questions)) return raw.questions;
        return null;
    }

    function fullText(value) {
        return typeof value === 'string' ? value : '';
    }

    function parseToolArgsObject(call) {
        if (!call) return null;
        const args = call.argumentsJson ?? call.args ?? call.arguments;
        if (args && typeof args === 'object') return args;
        if (typeof args === 'string') {
            try { return JSON.parse(args); } catch {}
        }
        return null;
    }

    function findPlannerToolArgs(steps, toolCallId, target = '') {
        for (let i = steps.length - 1; i >= 0; i--) {
            const preceding = steps[i];
            if (preceding?.step?.case === 'userInput') break;
            if (preceding?.step?.case !== 'plannerResponse') continue;
            const calls = preceding.step.value?.toolCalls || [];
            if (toolCallId) {
                const call = calls.find(c => (c?.id || c?.toolCallId) === toolCallId);
                if (call) return parseToolArgsObject(call);
                continue;
            }
            if (!target) return null;
            const prefix = target.replace(/(?:…|\.\.\.)$/, '');
            const args = calls.map(parseToolArgsObject).filter(a => a && Object.values(a).some(v =>
                typeof v === 'string' && (v === target || (prefix !== target && v.startsWith(prefix)))));
            return args.length === 1 ? args[0] : null;
        }
        return null;
    }

    function extractStructuredQuestionsFromStep(step, precedingSteps) {
        const val = step?.step?.value;
        const toolCall = step?.metadata?.toolCall || val?.toolCall;
        const req = step.requestedInteraction?.interaction ?? step.metadata?.requestedInteraction?.interaction;
        const qs = extractQuestionsArrayFromObject(val) ||
            extractQuestionsArrayFromObject(req?.value) ||
            extractQuestionsArrayFromObject(parseToolArgsObject(toolCall)) ||
            extractQuestionsArrayFromObject(findPlannerToolArgs(precedingSteps, toolCall?.id || val?.toolCallId));
        if (!Array.isArray(qs)) return [];
        return qs.map(q => {
            const raw = q?.options ?? q?.Options ?? q?.choices;
            const options = (Array.isArray(raw) ? raw : []).map(opt => ({
                text: fullText(typeof opt === 'string' ? opt : (opt?.text ?? opt?.Text ?? opt?.label ?? opt?.title ?? opt?.value ?? opt?.id)),
                id: fullText(opt?.id)
            })).filter(opt => opt.text.trim());
            return {
                question: fullText(q?.question ?? q?.Question ?? q?.prompt ?? q?.title),
                isMultiSelect: Boolean(q?.isMultiSelect ?? q?.is_multi_select ?? q?.IsMultiSelect ?? q?.multiSelect),
                options: options.map(opt => opt.text),
                optionIds: options.map(opt => opt.id)
            };
        }).filter(q => q.question.trim() && q.options.length);
    }

    function fileDisplayPath(p) {
        if (!/^file:\/\//i.test(p)) return p;
        try {
            const uri = new URL(p);
            const pathname = decodeURIComponent(uri.pathname);
            if (uri.hostname && uri.hostname !== 'localhost') return '\\\\' + uri.hostname + pathname.replace(/\//g, '\\');
            if (/^\/[a-z]:\//i.test(pathname)) return pathname.slice(1).replace(/\//g, '\\');
            return pathname;
        } catch { return p; }
    }

    const approvalLabels = {
        read_file: 'Allow read access to this path?',
        write_file: 'Allow write access to this path?',
        command: 'Allow running this command?',
        unsandboxed: 'Allow running this command outside the sandbox?',
        read_url: 'Allow reading this URL?',
        execute_url: 'Allow executing actions on this URL?',
        download_url: 'Allow the browser agent to download a file?',
        mcp: 'Allow using this MCP tool?',
        escalate_admin: 'Allow a one-time administrator (UAC) elevation?',
        custom: 'Allow access to this resource?'
    };

    function expandPermissionTarget(step, precedingSteps, interaction, explicitTarget) {
        const value = step?.step?.value;
        const call = step?.metadata?.toolCall || value?.toolCall;
        const action = interaction?.value?.resource?.action;
        const isCommand = action === 'command' || action === 'unsandboxed';
        const nativeTarget = explicitTarget !== undefined
            ? fullText(explicitTarget)
            : fullText(interaction?.value?.resource?.target ?? interaction?.value?.absolutePathUri);
        if (!nativeTarget || explicitTarget !== undefined || !/(?:…|\.\.\.)$/.test(nativeTarget)) {
            return nativeTarget;
        }
        const parsed = parseToolArgsObject(call);
        const planner = findPlannerToolArgs(precedingSteps || [], call?.id || value?.toolCallId, nativeTarget);
        const arg = (args, keys) => Object.entries(args || {}).find(([key, val]) =>
            keys.includes(key.toLowerCase()) && typeof val === 'string')?.[1];
        const keys = isCommand
            ? ['commandline', 'command']
            : ['path', 'absolutepath', 'filepath', 'file_path', 'targetfile', 'directorypath', 'searchpath', 'targetpath', 'url'];
        const prefix = nativeTarget.replace(/(?:…|\.\.\.)$/, '').replace(/^"/, '');
        return [arg(parsed, keys), arg(planner, keys), isCommand ? value?.commandLine : (value?.path ?? value?.url)]
            .filter(v => typeof v === 'string').map(v => {
                if (v.startsWith('"') && v.endsWith('"')) {
                    try { return JSON.parse(v); } catch {}
                }
                return v;
            }).find(v => typeof v === 'string' && v.startsWith(prefix) && !/(?:…|\.\.\.)$/.test(v)) || nativeTarget;
    }

    function formatPermissionVerb(action, saveRule, actionDescription) {
        const desc = fullText(actionDescription).trim();
        if (desc && (action === 'command' || action === 'unsandboxed' || action === 'custom')) {
            let normalized = desc.charAt(0).toLowerCase() + desc.slice(1);
            if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
            return saveRule ? `Save rule to always allow ${normalized}?` : `Allow ${normalized}?`;
        }
        if (action === 'download_url' && !saveRule) return 'Allow the browser agent to download a file?';
        if (Object.prototype.hasOwnProperty.call(approvalLabels, action)) return approvalLabels[action];
        return saveRule ? 'Save rule to always allow access to this resource?' : 'Allow access to this resource?';
    }

    function permissionDetail(step, precedingSteps, interaction, target, subagentLabel = '') {
        const value = step?.step?.value;
        const call = step?.metadata?.toolCall || value?.toolCall;
        const action = interaction?.value?.resource?.action;
        const isCommand = action === 'command' || action === 'unsandboxed';
        const isFile = action === 'read_file' || action === 'write_file' || interaction?.case === 'filePermission';
        const fullTarget = expandPermissionTarget(step, precedingSteps, interaction, target);
        const parsed = parseToolArgsObject(call);
        const arg = (args, keys) => Object.entries(args || {}).find(([key, val]) =>
            keys.includes(key.toLowerCase()) && typeof val === 'string')?.[1];
        const summary = fullText(step?.metadata?.toolSummary || value?.toolSummary || arg(parsed, ['toolsummary']))
            .replace(/^"(.*)"$/, '$1');
        const rawToolName = String(step?.metadata?.toolCall?.name ?? value?.name ?? value?.toolName ?? '').split(':').pop();
        const saveRule = rawToolName === 'ask_permission' || rawToolName === 'ask_custom_permission';
        const description = fullText(interaction?.value?.actionDescription);
        const verb = action ? formatPermissionVerb(action, saveRule, description) : (isFile ? 'File access approval' : 'Permission approval');
        const reason = fullText(interaction?.value?.reason);
        const cwd = isCommand && arg(parsed, ['cwd', 'workingdirectory']);
        const subPrefix = subagentLabel ? `Subagent: ${subagentLabel}` : '';
        return [subPrefix, verb, isFile ? fileDisplayPath(fullTarget) : fullTarget, summary, description, reason, cwd ? 'Working directory\n' + cwd : '']
            .filter((line, i, all) => line && all.indexOf(line) === i).join('\n');
    }

    function genericInteractionDetail(step, precedingSteps, interaction, toolName, subagentLabel = '') {
        const caseName = fullText(interaction?.case);
        if (caseName === 'filePermission') {
            return permissionDetail(step, precedingSteps, interaction, undefined, subagentLabel);
        }
        const val = interaction?.value || {};
        const call = step?.metadata?.toolCall || step?.step?.value?.toolCall;
        const parsed = parseToolArgsObject(call);
        const arg = (args, keys) => Object.entries(args || {}).find(([key, v]) =>
            keys.includes(key.toLowerCase()) && typeof v === 'string')?.[1];
        const target = fullText(
            val?.url ?? val?.targetUrl ?? val?.origin ?? val?.commandLine ?? val?.command ??
            val?.serverName ?? val?.toolName ?? val?.title ?? val?.prompt ?? val?.message ??
            arg(parsed, ['url', 'commandline', 'command', 'path', 'query'])
        );
        const desc = fullText(val?.description ?? val?.actionDescription ?? val?.reason ?? step?.metadata?.toolSummary);
        const friendlyCase = caseName
            ? caseName.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim()
            : (toolName || 'Confirmation required');
        const subPrefix = subagentLabel ? `Subagent: ${subagentLabel}` : '';
        return [subPrefix, friendlyCase, target, desc]
            .filter((line, i, all) => line && all.indexOf(line) === i).join('\n') || 'Open Antigravity to review and confirm this action.';
    }

    function detectWaitingActionInSteps(steps, sliceTrajectoryId = '', actionCascadeId = '', subagentLabel = '') {
        let waitingPermission = null;
        let waitingOther = null;
        for (let i = 0; i < steps.length; i++) {
            const entry = steps[i];
            const step = entry?.step?.step ? entry.step : entry;
            const explicitStepIndex = typeof entry?.stepIndex === 'number' ? entry.stepIndex : undefined;
            if (!step || !isWaitingStepStatus(step.status ?? step.metadata?.status)) continue;
            const meta = step.metadata;
            const interaction = step.requestedInteraction?.interaction ?? meta?.requestedInteraction?.interaction;
            const stepIndex = meta?.sourceTrajectoryStepInfo?.stepIndex ?? explicitStepIndex;
            const trajectoryId = String(meta?.sourceTrajectoryStepInfo?.trajectoryId || sliceTrajectoryId || '');
            const anchor = (actionCascadeId ? actionCascadeId + ':' : '') + trajectoryId + ':' + (stepIndex ?? i) + ':' +
                (meta?.createdAt?.seconds ?? '') + ':' + (meta?.toolCall?.id ?? '');
            const toolName = String(meta?.toolCall?.name ?? step.step?.value?.name ?? step.step?.value?.toolName ?? '').split(':').pop();
            const precede = steps.slice(0, i).map(x => x?.step?.step ? x.step : x);
            const isAsk = interaction?.case === 'askQuestion' || (!interaction &&
                (step.step?.case === 'askQuestion' || step.step?.case === 'askUserQuestion' || toolName === 'ask_question'));
            if (isAsk) {
                const questions = extractStructuredQuestionsFromStep(step, precede);
                return {
                    type: 'ask',
                    title: 'Input needed',
                    questions,
                    detail: questions.length ? (subagentLabel ? `Subagent: ${subagentLabel}` : '') : 'Answer the question in Antigravity',
                    waitKey: 'ask:' + anchor,
                    trajectoryId,
                    stepIndex,
                    actionCascadeId
                };
            }
            if (!waitingPermission && interaction?.case === 'permission') {
                waitingPermission = {
                    type: 'permission',
                    title: 'Approval needed',
                    waitKey: 'wait:' + anchor,
                    step,
                    precedingSteps: precede,
                    interaction,
                    toolName,
                    trajectoryId,
                    stepIndex,
                    actionCascadeId,
                    subagentLabel
                };
            } else if (!waitingOther && interaction?.case) {
                waitingOther = {
                    type: 'other_interaction',
                    title: 'Approval needed',
                    waitKey: 'wait:' + anchor,
                    detail: genericInteractionDetail(step, precede, interaction, toolName, subagentLabel),
                    questions: [],
                    trajectoryId,
                    stepIndex,
                    actionCascadeId
                };
            }
        }
        return waitingPermission || waitingOther;
    }

    function detectWaitingActionInState(state, actionCascadeId = '', subagentLabel = '') {
        const slice = state?.trajectorySlice;
        const steps = slice?.stepsInSlice || [];
        return detectWaitingActionInSteps(steps, String(slice?.trajectoryId ?? ''), actionCascadeId, subagentLabel);
    }

    function detectWaitingFromSummary(summaryObj, cascadeId = '', subagentLabel = '') {
        if (!summaryObj || summaryObj.killed || !Array.isArray(summaryObj.waitingSteps) || !summaryObj.waitingSteps.length) {
            return null;
        }
        const sorted = summaryObj.waitingSteps
            .filter(ws => ws && ws.step)
            .slice()
            .sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));
        if (!sorted.length) return null;
        return detectWaitingActionInSteps(sorted, String(summaryObj.trajectoryId ?? ''), cascadeId, subagentLabel);
    }

    function buildSubagentIndex(summariesRoot) {
        const parentByChild = new Map();
        const childrenByParent = new Map();
        const byParent = summariesRoot?.indexes?.byParent;
        if (byParent && typeof byParent === 'object') {
            for (const [pId, childMap] of Object.entries(byParent)) {
                if (!safeConversationIdRe.test(pId) || !childMap || typeof childMap !== 'object') continue;
                const kids = Object.keys(childMap).filter(k => safeConversationIdRe.test(k));
                if (!kids.length) continue;
                childrenByParent.set(pId, kids);
                for (const cId of kids) {
                    if (!parentByChild.has(cId)) parentByChild.set(cId, pId);
                }
            }
        }
        const rootOf = id => {
            let cur = id;
            const visited = new Set([cur]);
            while (parentByChild.has(cur) && visited.size < 16) {
                const next = parentByChild.get(cur);
                if (!next || visited.has(next)) break;
                visited.add(next);
                cur = next;
            }
            return cur;
        };
        const descendantsOf = rootId => {
            const out = [];
            const seen = new Set([rootId]);
            const queue = [rootId];
            while (queue.length > 0 && out.length < 64) {
                const cur = queue.shift();
                for (const child of childrenByParent.get(cur) || []) {
                    if (seen.has(child)) continue;
                    seen.add(child);
                    out.push(child);
                    queue.push(child);
                }
            }
            return out;
        };
        const isSubagent = id => parentByChild.has(id) || Boolean(summariesRoot?.summaries?.[id]?.trajectoryMetadata?.subagentSpec);
        const subagentDisplayLabel = summaryObj => {
            const spec = summaryObj?.trajectoryMetadata?.subagentSpec;
            return fullText(spec?.role || spec?.typeName).trim();
        };
        return { parentByChild, childrenByParent, rootOf, descendantsOf, isSubagent, subagentDisplayLabel };
    }

    function detectConversationWaiting(conversationId, states, summariesRoot, subIndex) {
        const state = states?.get?.(conversationId)?.provider?.getState?.();
        const summaryObj = summariesRoot?.summaries?.[conversationId];
        const direct = detectWaitingActionInState(state, conversationId) ||
            detectWaitingFromSummary(summaryObj, conversationId);
        if (direct) return direct;
        if (!subIndex) return null;
        for (const childId of subIndex.descendantsOf(conversationId)) {
            const childSummary = summariesRoot?.summaries?.[childId];
            if (childSummary?.killed) continue;
            const label = subIndex.subagentDisplayLabel(childSummary) || 'Subagent';
            const childState = states?.get?.(childId)?.provider?.getState?.();
            const childWait = detectWaitingActionInState(childState, childId, label) ||
                detectWaitingFromSummary(childSummary, childId, label);
            if (childWait) return childWait;
        }
        return null;
    }

    const takeoverSelector = '[data-testid="interaction-takeover-card"]';
    const continueSelector = '[data-testid="interaction-continue-button"]';
    const skipSelector = '[data-testid="interaction-skip-button"]';
    const optionSelector = '[data-testid="ask-question-option"]';
    const optionTextSelector = '[data-testid="ask-question-option-text"]';
    const approvalScopes = { once: 1, conversation: 2, global: 4, project: 5 };
    const customPermissionPlugins = new Map();
    const nativeSubmissions = new Map();

    function matchingNativeCard(conversationId, waiting) {
        if (waiting.stepIndex == null) return null;
        const expectedCascadeId = waiting.actionCascadeId || conversationId;
        const matches = [];
        for (const card of document.querySelectorAll(takeoverSelector)) {
            if (card.hidden || card.getClientRects?.().length === 0) continue;
            const probeNodes = [
                card.querySelector(continueSelector),
                card.querySelector(optionSelector),
                card.firstElementChild,
                card
            ].filter(Boolean);
            let cardMatched = false;
            for (const probe of probeNodes) {
                if (cardMatched) break;
                const fiberKey = Object.keys(probe).find(k => k.startsWith('__reactFiber$'));
                let fiber = fiberKey && probe[fiberKey];
                for (let depth = 0; fiber && depth < 120; depth++, fiber = fiber.return) {
                    const props = fiber.memoizedProps;
                    if (!props || typeof props !== 'object') continue;
                    if (props.cascadeId !== expectedCascadeId || props.stepIndex !== waiting.stepIndex) continue;
                    if (waiting.trajectoryId && props.trajectoryId && props.trajectoryId !== waiting.trajectoryId) continue;
                    if (waiting.type === 'ask' && props.questions?.length) {
                        matches.push(card);
                        cardMatched = true;
                        break;
                    }
                    const resource = waiting.interaction?.value?.resource;
                    if (resource && props.permissionSpec?.resource?.action === resource.action &&
                        props.permissionSpec.resource.target === resource.target) {
                        matches.push(card);
                        cardMatched = true;
                        break;
                    }
                }
            }
        }
        return matches.length === 1 ? matches[0] : null;
    }

    function readNativeOptions(card) {
        return Array.from(card.querySelectorAll(optionSelector), label => ({
            label,
            input: label.querySelector('input'),
            text: label.querySelector(optionTextSelector)?.textContent || ''
        })).filter(o => o.text.trim() && o.input);
    }

    function backgroundApprovalOptions(waiting, target, rawCommandDetails, pluginGrant) {
        const spec = waiting.interaction.value || {};
        const action = spec.resource?.action || '';
        const saveRule = waiting.toolName === 'ask_permission' || waiting.toolName === 'ask_custom_permission';
        const isCustom = action === 'custom';
        const isEscalate = action === 'escalate_admin';
        const isExecUrl = action === 'execute_url';
        const isDownloadUrl = action === 'download_url';
        const scopes = Array.isArray(spec.approvalScopeFilter) ? spec.approvalScopeFilter : [];
        const onceOnlyDownload = isDownloadUrl && scopes.length > 0 && scopes.every(s => s === approvalScopes.once);
        const urlTarget = isExecUrl || isDownloadUrl ? target : '';
        const edited = target !== spec.resource.target;
        const suggested = spec.persistSuggestionType === 1 && spec.suggestedPersistPattern && !edited;
        const command = action === 'command' || action === 'unsandboxed';
        const rule = !command || rawCommandDetails ? (suggested || (edited ? target : '')) : '';
        const limited = spec.triggerSource?.type === 6 ||
            (spec.triggerSource?.type === 1 && Boolean(spec.triggerSource.detail));
        const options = [];
        const add = (text, scope) => options.push({ text, scope, disabled: limited && scope !== approvalScopes.once });
        if (pluginGrant) {
            for (const [scope, label] of [
                [approvalScopes.conversation, 'Yes, allow in this conversation'],
                [approvalScopes.project, 'Yes, always allow in this project'],
                [approvalScopes.global, 'Yes, always allow']
            ]) {
                if (scopes.includes(scope)) add(label, scope);
            }
            return options;
        }
        if (!saveRule) {
            let label = 'Yes, allow this time';
            if (isEscalate) label = 'Yes, allow';
            else if (onceOnlyDownload) label = 'Yes, allow this download';
            else if (isDownloadUrl && urlTarget) label = `Yes, allow downloads from ${urlTarget} for this run`;
            else if (isCustom && spec.onceCoversTask) label = 'Yes, allow for this task';
            add(label, approvalScopes.once);
        }
        if (spec.persistSuggestionType !== 2 && !isEscalate) {
            if (!isCustom && (!scopes.length || scopes.includes(approvalScopes.conversation))) {
                const convLabel = saveRule
                    ? (rule ? `Yes, save rule for '${rule}' in this conversation` : 'Yes, save rule in this conversation')
                    : isDownloadUrl && urlTarget
                        ? `Yes, allow downloads from ${urlTarget} in this conversation`
                        : isExecUrl && urlTarget
                            ? `Yes, allow ${urlTarget} in this conversation`
                            : (rule ? `Yes, and always allow '${rule}' in this conversation` : 'Yes, and always allow in this conversation');
                add(convLabel, approvalScopes.conversation);
            }
            if (!scopes.length || scopes.includes(approvalScopes.global)) {
                const globalLabel = isCustom && spec.persistMatchesConversation
                    ? 'Yes, allow for this conversation'
                    : saveRule
                        ? (rule ? `Yes, save rule for '${rule}' globally` : 'Yes, save rule globally')
                        : isDownloadUrl && urlTarget
                            ? `Yes, always allow downloads from ${urlTarget}`
                            : isExecUrl && urlTarget
                                ? `Yes, always allow ${urlTarget}`
                                : (rule ? `Yes, and always allow '${rule}'` : 'Yes, and always allow');
                add(globalLabel, approvalScopes.global);
            }
        }
        return options;
    }

    function customPermissionPlugin(waiting, agentService) {
        const { resource, shellName } = waiting.interaction.value;
        if (resource.action !== 'custom') return false;
        const name = /^([^(]+)\(.*\)$/s.exec(resource.target)?.[1];
        const dot = name?.lastIndexOf('.') ?? -1;
        if (dot <= 0) return false;
        if (typeof agentService?.resolveCommandPlugin !== 'function') return undefined;
        const key = JSON.stringify([waiting.actionCascadeId, name.slice(0, dot), shellName]);
        if (!customPermissionPlugins.has(key)) {
            if (customPermissionPlugins.size >= 32) customPermissionPlugins.delete(customPermissionPlugins.keys().next().value);
            customPermissionPlugins.set(key, undefined);
            void agentService.resolveCommandPlugin({
                cascadeId: waiting.actionCascadeId, commandLine: name.slice(0, dot), shellName, customGrant: true
            }).then(result => {
                customPermissionPlugins.set(key, Boolean(result?.plugin));
            }, () => {
                customPermissionPlugins.set(key, false);
            });
        }
        return customPermissionPlugins.get(key);
    }

    function validNativeStep(waiting) {
        return Boolean(waiting?.trajectoryId && safeConversationIdRe.test(waiting.actionCascadeId) &&
            Number.isSafeInteger(waiting.stepIndex) && waiting.stepIndex >= 0);
    }

    function permissionPrompt(conversationId, waiting, ctx) {
        const { interaction, step, precedingSteps, waitKey, subagentLabel } = waiting;
        const spec = interaction.value;
        const resource = spec?.resource;
        const expandedDefault = expandPermissionTarget(step, precedingSteps, interaction);
        const defaultDetail = permissionDetail(step, precedingSteps, interaction, undefined, subagentLabel);
        if (!resource?.action || !fullText(expandedDefault) || !validNativeStep(waiting)) {
            lastPermissionDiag = {
                status: 'invalid_step',
                action: resource?.action || '',
                hasTarget: Boolean(fullText(expandedDefault)),
                validStep: validNativeStep(waiting)
            };
            return { detail: defaultDetail };
        }

        const card = matchingNativeCard(conversationId, waiting);
        const editor = card?.querySelector('[data-testid="permission-target-editor"]');
        const edited = editor?.value ?? resource.target;
        const action = resource.action;
        const isUrlAction = action === 'execute_url' || action === 'download_url';
        const target = isUrlAction ? fullText(edited).trim() : fullText(edited);
        const rawResourceTarget = isUrlAction ? fullText(resource.target).trim() : fullText(resource.target);
        const isUnedited = edited === resource.target || target === rawResourceTarget;
        const displayedTarget = isUnedited ? expandedDefault : target;
        const detail = permissionDetail(step, precedingSteps, interaction, displayedTarget, subagentLabel);
        const pluginGrant = customPermissionPlugin(waiting, ctx.agentService);
        if (pluginGrant === undefined || !displayedTarget.trim() || /(?:…|\.\.\.)$/.test(displayedTarget)) {
            lastPermissionDiag = {
                status: pluginGrant === undefined ? 'plugin_pending' : 'truncated_or_empty_target',
                action,
                targetTail: displayedTarget.slice(-24)
            };
            return { detail };
        }

        const rawCommandDetails = ctx.features?.get('rawCommandDetails')?.isEnabled ?? true;
        const choices = backgroundApprovalOptions(waiting, displayedTarget, rawCommandDetails, pluginGrant);
        const normOpt = text => fullText(text).replace(/\s+/g, ' ').trim();
        const nativeOptions = card ? readNativeOptions(card) : [];
        if (nativeOptions.length && (nativeOptions.length !== choices.length ||
            nativeOptions.some((option, i) => normOpt(option.text) !== normOpt(choices[i].text)))) {
            lastPermissionDiag = {
                status: 'native_options_mismatch',
                action,
                persistSuggestionType: spec.persistSuggestionType ?? null,
                suggestedPersistPattern: spec.suggestedPersistPattern ?? '',
                approvalScopeFilter: Array.isArray(spec.approvalScopeFilter) ? spec.approvalScopeFilter : [],
                triggerType: spec.triggerSource?.type ?? null,
                nativeTexts: nativeOptions.map(o => normOpt(o.text)),
                choiceTexts: choices.map(c => normOpt(c.text))
            };
            return { detail };
        }
        for (let i = 0; i < nativeOptions.length; i++) {
            choices[i].disabled ||= nativeOptions[i].input.disabled;
        }
        const skip = card?.querySelector(skipSelector);
        const allowDeny = !nativeOptions.length || (skip && !skip.disabled);
        const denyIndex = allowDeny ? choices.length : -1;
        if (allowDeny) choices.push({ text: 'No (deny this request)', scope: approvalScopes.once });
        if (!choices.some(c => !c.disabled)) {
            lastPermissionDiag = { status: 'no_enabled_choice', action };
            return { detail };
        }

        lastPermissionDiag = { status: 'ok', action, optionCount: choices.length, nativeMatched: nativeOptions.length };
        const fields = [conversationId, waitKey, detail, String(denyIndex), ...choices.flatMap(c => [c.text, c.disabled ? '1' : '0'])];
        const signature = fields.map(value => value.length + ':' + value).join('');
        return { detail, choices, denyIndex, signature, target, displayedTarget, isUnedited };
    }

    async function approvalDigest(signature) {
        const bytes = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature));
        return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function preparePermission(conversationId, waiting, ctx) {
        const { detail, signature, choices, denyIndex } = permissionPrompt(conversationId, waiting, ctx);
        if (!signature || !window.crypto?.subtle) return { detail, questions: [] };
        return {
            detail,
            questions: [{
                question: 'Choose an option',
                isMultiSelect: false,
                options: choices.map(c => c.text),
                disabledOptionIndices: choices.flatMap((c, i) => c.disabled ? [i] : []),
                nativeApprovalKey: await approvalDigest(signature),
                nativeDenyIndex: denyIndex
            }]
        };
    }

    function currentWaiting(conversationId, ctx) {
        return detectConversationWaiting(conversationId, ctx.states, ctx.summaries, buildSubagentIndex(ctx.summaries));
    }

    async function monitorTaskTransitions() {
        const ctx = readAgentContext();
        const { states, summaries } = ctx;
        const waitingCards = [];
        const hasStates = states && typeof states.entries === 'function';
        const summariesMap = summaries?.summaries && typeof summaries.summaries === 'object' ? summaries.summaries : null;
        if (!hasStates && !summariesMap) return waitingCards;
        const subIndex = buildSubagentIndex(summaries);
        const candidateIds = new Set();
        if (hasStates) {
            for (const id of states.keys()) {
                if (typeof id !== 'string' || !safeConversationIdRe.test(id)) continue;
                const rootId = subIndex.isSubagent(id) ? subIndex.rootOf(id) : id;
                if (safeConversationIdRe.test(rootId) && (!subIndex.isSubagent(rootId) || rootId !== id)) {
                    candidateIds.add(rootId);
                } else if (!subIndex.isSubagent(id)) {
                    candidateIds.add(id);
                }
            }
        }
        if (summariesMap) {
            for (const [id, sumObj] of Object.entries(summariesMap)) {
                if (!safeConversationIdRe.test(id) || !sumObj || sumObj.killed) continue;
                if (!Array.isArray(sumObj.waitingSteps) || sumObj.waitingSteps.length === 0) continue;
                const rootId = subIndex.isSubagent(id) ? subIndex.rootOf(id) : id;
                if (safeConversationIdRe.test(rootId)) candidateIds.add(rootId);
            }
        }
        for (const [trackedId, prevState] of trackedTaskStates.entries()) {
            if (prevState?.waitKey && safeConversationIdRe.test(trackedId)) {
                candidateIds.add(trackedId);
            }
        }

        const now = Date.now();
        for (const id of candidateIds) {
            const state = hasStates ? states.get(id)?.provider?.getState?.() : undefined;
            const summaryObj = summariesMap ? summariesMap[id] : undefined;
            const fallbackTitle = extractTitleFromState(state) || cleanConversationTitle(summaryObj?.summary || '');
            if (fallbackTitle && !conversationTitles.has(id)) conversationTitles.set(id, fallbackTitle);
            const title = conversationTitles.get(id) || fallbackTitle || 'Conversation ' + id.slice(0, 8);
            const metrics = state ? readPerf(state, now, turnStarts.get(id) ?? null) : null;
            if (metrics && metrics.userStartMs !== null) turnStarts.set(id, metrics.userStartMs);
            const running = Boolean(metrics && ['Waiting', 'Thinking', 'Generating', 'Executing'].includes(metrics.phase));
            const waiting = detectConversationWaiting(id, hasStates ? states : null, summaries, subIndex);
            const prev = trackedTaskStates.get(id);
            if (prev?.waitKey && prev.waitKey !== waiting?.waitKey) {
                const key = id + '|' + prev.waitKey;
                nativeSubmissions.delete(key);
                resolvedActionIds.set(key, { conversationId: id, turnKey: prev.waitKey, at: now });
            }
            let notifiedTurnKey = prev?.notifiedTurnKey || '';
            if (waiting) {
                const contents = waiting.type === 'permission'
                    ? await preparePermission(id, waiting, ctx)
                    : waiting;
                const latestWaiting = currentWaiting(id, readAgentContext());
                if (latestWaiting?.waitKey === waiting.waitKey) {
                    waitingCards.push({
                        conversationId: id,
                        kind: 'action_required',
                        statusLabel: waiting.title,
                        detail: contents.detail,
                        questions: contents.questions,
                        title,
                        turnKey: waiting.waitKey
                    });
                }
            } else if (state && metrics && prev?.wasRunning && !running && metrics.phase === 'Completed' && state.fullyIdle === true) {
                const turnKey = metrics.userStartMs !== null ? 'ui-start:' + Math.round(metrics.userStartMs) : '';
                if (!turnKey || notifiedTurnKey !== turnKey) {
                    pendingCompletions.push({
                        conversationId: id,
                        kind: 'completed',
                        statusLabel: 'Task completed',
                        detail: '',
                        title,
                        turnKey
                    });
                    notifiedTurnKey = turnKey;
                }
            }
            if (state || waiting || prev) {
                trackedTaskStates.set(id, { wasRunning: running || Boolean(waiting), waitKey: waiting?.waitKey || '', notifiedTurnKey });
            }
        }
        for (const [key, value] of resolvedActionIds) {
            if (now - value.at > 60000) resolvedActionIds.delete(key);
        }
        return waitingCards;
    }

    function findOpenLinkTarget() {
        const input = document.querySelector('[data-testid="agent-input-box"]');
        const key = input && Object.keys(input).find(name => name.startsWith('__reactFiber$'));
        let fiber = key && input[key];
        for (let depth = 0; fiber && depth < 600; depth++, fiber = fiber.return) {
            const fn = fiber.memoizedProps?.value?.openLinkTarget;
            if (typeof fn === 'function') return fn;
        }
        return null;
    }

    async function openConversation(conversationId) {
        if (typeof conversationId !== 'string' || !safeConversationIdRe.test(conversationId)) {
            return { navigated: false, error: 'invalid_conversation_id' };
        }
        const targetPath = `/c/${conversationId}`;
        if (location.pathname === targetPath) {
            return { navigated: true, method: 'already_open' };
        }
        const sidebarLink = Array.from(document.querySelectorAll('a[href]')).find(a => {
            try { return new URL(a.href, location.origin || 'https://127.0.0.1').pathname === targetPath; } catch { return false; }
        });
        if (sidebarLink) {
            sidebarLink.click();
            await new Promise(resolve => window.setTimeout(resolve, 80));
            if (location.pathname === targetPath) {
                return { navigated: true, method: 'sidebar_link' };
            }
        }
        if (typeof MouseEvent === 'function') {
            const tempLink = document.createElement('a');
            tempLink.href = targetPath;
            tempLink.style.display = 'none';
            (document.querySelector('.bg-sidebar') || document.body).append(tempLink);
            try {
                tempLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 }));
            } catch {} finally {
                tempLink.remove();
            }
            await new Promise(resolve => window.setTimeout(resolve, 80));
            if (location.pathname === targetPath) {
                return { navigated: true, method: 'synthetic_link' };
            }
        }
        const openLinkTarget = findOpenLinkTarget();
        if (openLinkTarget) {
            try {
                await Promise.resolve(openLinkTarget(`conversation://${conversationId}`));
                await new Promise(resolve => window.setTimeout(resolve, 80));
                if (location.pathname === targetPath || readAgentEntry().conversationId === conversationId) {
                    return { navigated: true, method: 'open_link_target' };
                }
            } catch {}
        }
        history.pushState(history.state, '', targetPath);
        window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        return { navigated: true, method: 'history_popstate' };
    }

    async function submitNativeInteraction(conversationId, waiting, agentService, interaction) {
        if (disposed || !validNativeStep(waiting) || !agentService) {
            return { submitted: false, error: 'native_submit_unavailable' };
        }
        const key = conversationId + '|' + waiting.waitKey;
        if (nativeSubmissions.has(key)) return nativeSubmissions.get(key);
        let response;
        try {
            response = agentService.handleCascadeUserInteraction(waiting.actionCascadeId, {
                trajectoryId: waiting.trajectoryId, stepIndex: waiting.stepIndex, interaction
            });
        } catch {
            return { submitted: false, error: 'native_submit_rejected' };
        }
        const operation = Promise.resolve(response).then(res => {
            if (res && typeof res === 'object' && (res.ok === false || res.accepted === false || res.error)) {
                nativeSubmissions.delete(key);
                return { submitted: false, error: 'native_submit_rejected' };
            }
            return { submitted: true };
        }, () => {
            nativeSubmissions.delete(key);
            return { submitted: false, error: 'native_submit_rejected' };
        });
        nativeSubmissions.set(key, operation);
        while (nativeSubmissions.size > 128) {
            nativeSubmissions.delete(nativeSubmissions.keys().next().value);
        }
        return operation;
    }

    async function submitPermission(conversationId, decision) {
        const { key, requestKey, optionIndex, deny } = decision;
        if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) ||
            !Number.isSafeInteger(optionIndex) || optionIndex < 0 || typeof deny !== 'boolean' || !window.crypto?.subtle) {
            return { submitted: false, error: 'invalid_permission_selection' };
        }
        const initialCtx = readAgentContext();
        const initial = currentWaiting(conversationId, initialCtx);
        if (initial?.type !== 'permission' || initial.waitKey !== requestKey) {
            return { submitted: false, error: 'stale_permission' };
        }
        const { signature } = permissionPrompt(conversationId, initial, initialCtx);
        if (!signature || await approvalDigest(signature) !== key) {
            return { submitted: false, error: 'permission_changed' };
        }
        const ctx = readAgentContext();
        const waiting = currentWaiting(conversationId, ctx);
        if (waiting?.type !== 'permission' || waiting.waitKey !== requestKey) {
            return { submitted: false, error: 'stale_permission' };
        }
        const prompt = permissionPrompt(conversationId, waiting, ctx);
        const choice = prompt.choices?.[optionIndex];
        if (prompt.signature !== signature || !choice || choice.disabled || deny !== (optionIndex === prompt.denyIndex)) {
            return { submitted: false, error: 'permission_changed' };
        }

        const spec = waiting.interaction.value;
        const editedTarget = !prompt.isUnedited ? prompt.target : undefined;
        const verifiedTarget = prompt.displayedTarget || prompt.target;
        const persistTarget = spec.persistSuggestionType === 1 && spec.suggestedPersistPattern && editedTarget === undefined
            ? spec.suggestedPersistPattern : verifiedTarget;
        const value = { allow: !deny, scope: choice.scope, userDenyInstruction: '', editedTarget };
        if (!deny && choice.scope !== approvalScopes.once) {
            if (!persistTarget || /(?:…|\.\.\.)$/.test(persistTarget)) {
                return { submitted: false, error: 'truncated_persist_target' };
            }
            value.persistGrants = { allow: [spec.resource.action + '(' + persistTarget + ')'] };
        }
        return submitNativeInteraction(conversationId, waiting, ctx.agentService, { case: 'permission', value });
    }

    async function submitAskQuestion(conversationId, selections) {
        if (typeof conversationId !== 'string' || !safeConversationIdRe.test(conversationId)) {
            return { submitted: false, error: 'invalid_conversation_id' };
        }
        if (Array.isArray(selections) && selections.length === 1 && selections[0]?.kind === 'native_permission') {
            return submitPermission(conversationId, selections[0]);
        }

        const ctx = readAgentContext();
        const waiting = currentWaiting(conversationId, ctx);
        if (waiting?.type !== 'ask') return { submitted: false, error: 'not_an_ask_question_step' };
        if (!Array.isArray(selections) || selections.length !== waiting.questions.length || !selections.length) {
            return { submitted: false, error: 'incomplete_selections' };
        }
        const responses = [];
        for (let i = 0; i < waiting.questions.length; i++) {
            const question = waiting.questions[i];
            const answers = selections[i];
            if (!Array.isArray(answers) || !answers.length || (!question.isMultiSelect && answers.length !== 1)) {
                return { submitted: false, error: 'incomplete_selections' };
            }
            const selectedOptionIds = new Set();
            for (const answer of answers) {
                let index;
                if (typeof answer === 'string') {
                    index = question.options.indexOf(answer);
                    if (question.options.lastIndexOf(answer) !== index) return { submitted: false, error: 'stale_question' };
                } else {
                    index = answer?.index;
                    if (answer?.requestKey !== waiting.waitKey || !Number.isSafeInteger(index) ||
                        question.options[index] !== answer.text) return { submitted: false, error: 'stale_question' };
                }
                const id = question.optionIds[index];
                if (!id || question.optionIds.indexOf(id) !== question.optionIds.lastIndexOf(id) || selectedOptionIds.has(id)) {
                    return { submitted: false, error: 'stale_question' };
                }
                selectedOptionIds.add(id);
            }
            responses.push({
                question: question.question,
                isMultiSelect: question.isMultiSelect,
                options: question.options.map((text, j) => ({ id: question.optionIds[j], text })),
                selectedOptionIds: [...selectedOptionIds],
                writeInResponse: '',
                skipped: false
            });
        }
        return submitNativeInteraction(conversationId, waiting, ctx.agentService, {
            case: 'askQuestion', value: { responses, cancelled: false }
        });
    }

    function handleIncomingDeepLink(url) {
        if (typeof url !== 'string') return;
        const match = /^antigravity:\/\/(?:agy-plus|derrick)-open-conversation\/([A-Za-z0-9._-]+)/i.exec(url.trim());
        if (match) void openConversation(match[1]);
    }

    // ---- Telemetry Widgets (v10: 3-Stage Color Ring + Hover/Pin + High-Contrast Split Ring) ----

    function readAgentState() {
        return readAgentEntry().state;
    }

    function syncContextBreakdownUi(repositionNow = false) {
        if (contextBreakdownToggle) contextBreakdownToggle.setAttribute('aria-expanded', String(contextBreakdownExpanded));
        if (contextBreakdownList) contextBreakdownList.hidden = !contextBreakdownExpanded;
        if (repositionNow) positionPanel(contextPanel, pendingContext);
    }

    function contextLevel(fraction) {
        if (fraction === undefined) return '';
        const pct = Math.round(fraction * 100);
        if (pct >= 80) return 'red';
        if (pct >= 60) return 'orange';
        return 'green';
    }

    function contextRingColor(level) {
        if (level === 'red') return 'var(--agp-ctx-red)';
        if (level === 'orange') return 'var(--agp-ctx-orange)';
        if (level === 'green') return 'var(--agp-ctx-green)';
        return 'var(--agp-ring-track)';
    }

    function renderContext() {
        if (currentConfig.features.contextRing === false) return;
        contextUsage = readAgentState()?.contextWindowUsage;
        const used = contextUsage?.estimatedTokensUsed;
        const maximum = contextUsage?.maxContextTokens;
        const known = Number.isFinite(used) && used >= 0 && Number.isFinite(maximum) && maximum > 0;
        const fraction = known ? Math.min(1, Math.max(0, used / maximum)) : undefined;
        const percent = known ? `${Math.round(fraction * 100)}%` : '—';
        const level = contextLevel(fraction);
        const ring = pendingContext.querySelector('.agy-plus-quota-ring');
        const ringPct = !known ? 0 : (used > 0 ? Math.max(4, fraction * 100) : 0);
        ring.style.setProperty('--agp-ring-progress', `${ringPct}%`);
        ring.style.setProperty('--agp-ring-color', contextRingColor(level));
        if (level) {
            pendingContext.dataset.contextLevel = level;
            contextPanel.dataset.contextLevel = level;
        } else {
            delete pendingContext.dataset.contextLevel;
            delete contextPanel.dataset.contextLevel;
        }
        const fallbackNote = 'Context usage will be available after a model response.';
        pendingContext.removeAttribute('title');
        pendingContext.setAttribute('aria-label', `Context ${percent} used. Hover or click for details.`);
        const breakdownGroups = (contextUsage?.tokenGroups || []).filter(group => Number.isFinite(group?.numTokens) && group.numTokens > 0);
        const key = [used, maximum, JSON.stringify(breakdownGroups.map(group => [group.name, group.numTokens]))].join('|');
        if (key !== contextPanelKey) {
            contextPanelKey = key;
            contextBreakdownToggle = null;
            contextBreakdownList = null;
            contextPanel.replaceChildren(heading('Context window', 'Current conversation', percent));
            if (known) {
                contextPanel.append(
                    element('div', 'agy-plus-context-tokens', `${used.toLocaleString('en-US')} / ${maximum.toLocaleString('en-US')} tokens`),
                    progress(fraction, 'Context used')
                );
                if (breakdownGroups.length > 0) {
                    const section = element('div', 'agy-plus-context-breakdown-section');
                    const toggle = element('button', 'agy-plus-context-breakdown-toggle');
                    toggle.type = 'button';
                    toggle.dataset.testid = 'agy-plus-context-breakdown-toggle';
                    toggle.setAttribute('aria-controls', 'agy-plus-context-breakdown-list');
                    toggle.setAttribute('aria-expanded', String(contextBreakdownExpanded));
                    const label = element('span', 'agy-plus-context-breakdown-label', 'Token breakdown');
                    const chevron = element('span', 'agy-plus-context-chevron');
                    chevron.setAttribute('aria-hidden', 'true');
                    chevron.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"></path></svg>';
                    toggle.append(label, chevron);
                    const list = element('div', 'agy-plus-context-breakdown-list');
                    list.id = 'agy-plus-context-breakdown-list';
                    list.dataset.testid = 'agy-plus-context-breakdown-list';
                    list.hidden = !contextBreakdownExpanded;
                    for (const group of breakdownGroups) {
                        const row = element('div', 'agy-plus-context-breakdown');
                        row.append(element('span', '', group.name), element('span', '', group.numTokens.toLocaleString('en-US')));
                        list.append(row);
                    }
                    toggle.addEventListener('click', () => {
                        contextBreakdownExpanded = !contextBreakdownExpanded;
                        syncContextBreakdownUi(true);
                    });
                    contextBreakdownToggle = toggle;
                    contextBreakdownList = list;
                    section.append(toggle, list);
                    contextPanel.append(section);
                }
            } else {
                contextPanel.append(element('p', 'agy-plus-panel-note', fallbackNote));
            }
            positionPanel(contextPanel, pendingContext);
        }
    }

    function renderPerformance() {
        if (currentConfig.features.performancePill === false) return;
        const { conversationId, state } = readAgentEntry();
        const savedStart = turnStarts.get(conversationId) ?? null;
        performanceMetrics = readPerf(state, Date.now(), savedStart);
        const metrics = performanceMetrics;
        if (metrics.userStartMs !== null) turnStarts.set(conversationId, metrics.userStartMs);
        else if (metrics.phase === 'No data') turnStarts.delete(conversationId);
        const active = metrics.phase === 'Waiting' || metrics.phase === 'Thinking' ||
            metrics.phase === 'Generating' || metrics.phase === 'Executing';
        const totalTime = formatDur(metrics.elapsedSeconds, active);
        const count = value => value === null ? '—' : value.toLocaleString('en-US');
        const rate = metrics.averageTokensPerSecond === null ? '—' : metrics.averageTokensPerSecond.toFixed(1);
        const primary = active ? `${metrics.phase} · ${totalTime}` : `Avg ${rate} tok/s`;
        const secondaryText = active
            ? (metrics.averageTokensPerSecond === null ? '' : ` · Avg ${rate} tok/s`)
            : ` · ${totalTime}`;
        const key = JSON.stringify([metrics.phase, totalTime, rate, metrics.modelCalls,
            metrics.outputTokens, metrics.responseTokens, metrics.thinkingTokens, metrics.inputTokens]);
        if (key === performanceKey) return;
        performanceKey = key;
        const secondarySpan = element('span', 'agy-plus-performance-latency', secondaryText);
        if (!secondaryText) secondarySpan.hidden = true;
        performanceBadge.replaceChildren(element('span', '', primary), secondarySpan);
        performanceBadge.removeAttribute('title');
        performanceBadge.setAttribute('aria-label', `${primary}${secondaryText ? `.${secondaryText.replace(/^ ·/, '')}` : ''}. Hover or click for performance details.`);
        performancePanel.replaceChildren(heading('Model performance', 'Current task in this conversation', metrics.phase));
        const rows = [
            ['Average output rate', `${rate} tok/s`],
            ['Total time', totalTime],
            ['Output tokens', count(metrics.outputTokens)],
            ['Response tokens', count(metrics.responseTokens)],
            ['Thinking tokens', count(metrics.thinkingTokens)],
            ['Input tokens', count(metrics.inputTokens)]
        ];
        for (const [label, value] of rows) {
            const row = element('div', 'agy-plus-context-breakdown');
            row.append(element('span', '', label), element('span', '', value));
            performancePanel.append(row);
        }
        positionPanel(performancePanel, performanceBadge);
    }

    function quotaService() {
        const input = document.querySelector('[data-testid="agent-input-box"]');
        const key = input && Object.keys(input).find(name => name.startsWith('__reactFiber$'));
        let fiber = key && input[key];
        for (let depth = 0; fiber && depth < 600; depth++, fiber = fiber.return) {
            const service = fiber.memoizedProps?.value?.core?.cloudCodeService;
            if (typeof service?.retrieveUserQuotaSummary === 'function') return service;
        }
    }

    function activeGroup() {
        const input = document.querySelector('[data-testid="agent-input-box"]');
        const labels = input?.querySelector('[data-testid="model-selector-trigger"]')?.textContent || '';
        if (/claude|gpt/i.test(labels)) return groups.find(group => /claude|gpt/i.test(group.displayName));
        if (/gemini/i.test(labels)) return groups.find(group => /gemini/i.test(group.displayName));
        return groups.length === 1 ? groups[0] : undefined;
    }

    function buckets(group) {
        const order = { '5h': 0, daily: 1, weekly: 2 };
        return (group?.buckets || []).filter(bucket => !bucket.disabled &&
            bucket.remaining?.case === 'remainingFraction' && Number.isFinite(bucket.remaining.value))
            .slice()
            .sort((a, b) => (order[a.window] ?? 9) - (order[b.window] ?? 9));
    }

    function windowName(bucket) {
        return ({ weekly: 'Weekly limit', daily: 'Daily limit', '5h': '5-hour limit' })[bucket.window] || bucket.displayName;
    }

    function ringColor(fraction) {
        if (fraction === undefined) return 'var(--agp-quota-fill)';
        return fraction < 0.1
            ? 'var(--agp-quota-danger)'
            : fraction < 0.25
                ? 'var(--agp-quota-warn)'
                : 'var(--agp-quota-fill)';
    }

    function updateArc(arc, fraction) {
        if (!arc) return;
        const pct = fraction === undefined ? 0 : Math.max(0, Math.min(100, fraction * 100));
        arc.style.strokeDasharray = `${pct} 100`;
        arc.style.stroke = ringColor(fraction);
        arc.style.opacity = pct > 0 ? '1' : '0';
    }

    function renderQuotaTooltip() {
        if (currentConfig.features.quotaSplitRing === false || !hoveredHalf || !panel.hidden || !badge.isConnected || badge.hidden) {
            quotaTooltip.hidden = true;
            return;
        }
        const group = activeGroup();
        const stale = Date.now() - refreshedAt > 180000;
        const activeBuckets = !stale ? buckets(group) : [];
        const bucket = activeBuckets.find(item => item.window === hoveredHalf);
        const labelText = hoveredHalf === '5h' ? '5-hour limit' : 'Weekly limit';
        const fraction = bucket ? Math.max(0, Math.min(1, bucket.remaining.value)) : undefined;
        const valueText = fraction === undefined ? '—' : `${Math.round(fraction * 100)}% left`;
        const seconds = Number(bucket?.resetTime?.seconds || 0);
        const resetText = seconds > 0
            ? `Resets ${new Date(seconds * 1000).toLocaleString('en-US', { hour12: false })}`
            : (error || (stale && refreshedAt ? 'Quota data is out of date' : 'Resets —'));
        const row = element('div', 'agy-plus-limit-heading agy-plus-tooltip-heading');
        row.append(element('span', 'agy-plus-tooltip-title', labelText), element('span', 'agy-plus-tooltip-value', valueText));
        quotaTooltip.replaceChildren(row, element('div', 'agy-plus-limit-reset', resetText));
        quotaTooltip.dataset.half = hoveredHalf;
        quotaTooltip.hidden = false;
        positionPanel(quotaTooltip, badge, true);
    }

    function renderQuota() {
        if (currentConfig.features.quotaSplitRing === false) return;
        const group = activeGroup();
        modelGroup = group?.displayName || '';
        const available = buckets(group);
        const stale = Date.now() - refreshedAt > 180000;
        const activeBuckets = !stale ? available : [];
        const fiveHourBucket = activeBuckets.find(bucket => bucket.window === '5h');
        const weeklyBucket = activeBuckets.find(bucket => bucket.window === 'weekly');
        const fiveHourFraction = fiveHourBucket ? Math.max(0, Math.min(1, fiveHourBucket.remaining.value)) : undefined;
        const weeklyFraction = weeklyBucket ? Math.max(0, Math.min(1, weeklyBucket.remaining.value)) : undefined;
        const fraction = activeBuckets.length ? Math.max(0, Math.min(1, Math.min(...activeBuckets.map(bucket => bucket.remaining.value)))) : undefined;
        const percent = fraction === undefined ? '—' : `${Math.round(fraction * 100)}%`;
        fiveHourPercent = fiveHourFraction === undefined ? '—' : `${Math.round(fiveHourFraction * 100)}%`;
        weeklyPercent = weeklyFraction === undefined ? '—' : `${Math.round(weeklyFraction * 100)}%`;
        quotaPercent = percent;
        const ring = badge.querySelector('.agy-plus-quota-ring');
        ring.style.setProperty('--agp-top-progress', fiveHourFraction === undefined ? '0%' : `${fiveHourFraction * 100}%`);
        ring.style.setProperty('--agp-bottom-progress', weeklyFraction === undefined ? '0%' : `${weeklyFraction * 100}%`);
        ring.style.setProperty('--agp-top-color', ringColor(fiveHourFraction));
        ring.style.setProperty('--agp-bottom-color', ringColor(weeklyFraction));
        updateArc(ring.querySelector('[data-arc="5h"]'), fiveHourFraction);
        updateArc(ring.querySelector('[data-arc="weekly"]'), weeklyFraction);
        badge.removeAttribute('title');
        badge.setAttribute('aria-label', `${group?.displayName || 'Model'} quota: 5-hour ${fiveHourPercent}, weekly ${weeklyPercent} remaining. Click for details.`);
        renderQuotaTooltip();
        const key = [modelGroup, quotaPercent, fiveHourPercent, weeklyPercent, refreshedAt, error, stale].join('|');
        if (key !== quotaPanelKey) {
            quotaPanelKey = key;
            panel.replaceChildren(heading('Model usage', 'Top arc: 5-hour limit · Bottom arc: weekly limit', percent));
            for (const item of groups) {
                const section = element('section', 'agy-plus-quota-group');
                const title = element('div', 'agy-plus-quota-group-title');
                const name = item.displayName;
                title.append(element('span', '', name));
                if (item === group) title.append(element('span', 'agy-plus-current-model', 'Selected'));
                section.append(title);
                for (const bucket of buckets(item)) {
                    const row = element('div', 'agy-plus-limit');
                    const label = element('div', 'agy-plus-limit-heading');
                    const value = Math.round(Math.max(0, Math.min(1, bucket.remaining.value)) * 100);
                    label.append(element('span', '', windowName(bucket)), element('span', '', `${value}%`));
                    row.append(label, progress(bucket.remaining.value, `${name} ${windowName(bucket)} remaining`));
                    const seconds = Number(bucket.resetTime?.seconds || 0);
                    if (seconds > 0) row.append(element('div', 'agy-plus-limit-reset', `Resets ${new Date(seconds * 1000).toLocaleString('en-US', { hour12: false })}`));
                    section.append(row);
                }
                panel.append(section);
            }
            const note = error || (stale && refreshedAt ? 'Quota data is out of date. Waiting for an update.' : refreshedAt ? `Updated ${new Date(refreshedAt).toLocaleTimeString('en-US', { hour12: false })}` : 'Loading quota…');
            panel.append(element('p', 'agy-plus-panel-note', note));
            positionPanel(panel, badge, true);
        }
    }

    async function refreshQuota() {
        if (inFlight || disposed || currentConfig.features.quotaSplitRing === false) return;
        const service = quotaService();
        if (!service) { error = 'The quota service is temporarily unavailable.'; renderQuota(); return; }
        inFlight = true;
        try {
            const response = await service.retrieveUserQuotaSummary(undefined, false);
            if (disposed) return;
            groups = response?.response?.groups || [];
            refreshedAt = Date.now();
            error = groups.length ? '' : 'No quota data is available yet.';
        } catch {
            groups = [];
            error = 'Unable to refresh quota. Please try again later.';
        } finally {
            inFlight = false;
            if (!disposed) renderQuota();
        }
    }

    function openContextPanel({ pin = false } = {}) {
        if (currentConfig.features.contextRing === false) return;
        clearContextHoverTimer();
        hidePerformancePanel();
        hideQuotaPanels();
        hideSettingsPanel();
        const wasHidden = contextPanel.hidden;
        if (wasHidden) contextBreakdownExpanded = false;
        if (pin) setContextPinned(true);
        renderContext();
        contextPanel.hidden = false;
        pendingContext.setAttribute('aria-expanded', 'true');
        syncContextBreakdownUi(false);
        positionPanel(contextPanel, pendingContext);
    }

    function scheduleHideContextPanel() {
        clearContextHoverTimer();
        if (contextPinned || contextPanel.hidden) return;
        contextHoverTimer = window.setTimeout(() => {
            contextHoverTimer = 0;
            if (!contextPinned) hideContextPanel();
        }, HOVER_CLOSE_DELAY_MS);
    }

    function openPerformancePanel({ pin = false } = {}) {
        if (currentConfig.features.performancePill === false) return;
        clearPerformanceHoverTimer();
        hideContextPanel();
        hideQuotaPanels();
        hideSettingsPanel();
        if (pin) setPerformancePinned(true);
        renderPerformance();
        performancePanel.hidden = false;
        performanceBadge.setAttribute('aria-expanded', 'true');
        positionPanel(performancePanel, performanceBadge);
    }

    function scheduleHidePerformancePanel() {
        clearPerformanceHoverTimer();
        if (performancePinned || performancePanel.hidden) return;
        performanceHoverTimer = window.setTimeout(() => {
            performanceHoverTimer = 0;
            if (!performancePinned) hidePerformancePanel();
        }, HOVER_CLOSE_DELAY_MS);
    }

    // ---- Interactive Step-by-Step Onboarding Tour ----

    const TOUR_STORAGE_KEY = 'agy_plus_tour_completed_v1';
    const TOUR_STEPS = [
        {
            id: 'control-center',
            title: '欢迎使用 Antigravity Plus',
            desc: '全部 15 项增强功能均可在这里随时独立开关（0ms 实时生效，无需重启）。平时也可通过顶部 Window 菜单或快捷键 Ctrl+Shift+, 打开设置面板。',
            selectors: ['[data-testid="agy-plus-settings-button"]'],
            mode: 'first',
            fallbackHint: '提示：侧边栏左下角的调节滑块图标会常驻保留，随时可点击打开控制中心。',
            preferredSide: 'right'
        },
        {
            id: 'quota-ring',
            title: '5 小时 / 周高对比双半环配额',
            desc: '上半环显示 5 小时剩余额度，下半环显示周剩余额度。鼠标悬停对应半环即可查看重置倒计时，点击可展开完整额度面板。',
            selectors: ['[data-testid="agy-plus-quota-indicator"]'],
            mode: 'first',
            fallbackHint: '提示：若你已关闭双半环配额开关，可在设置面板随时重新开启。',
            preferredSide: 'right'
        },
        {
            id: 'context-and-perf',
            title: '实时速率胶囊与上下文三色圆环',
            desc: '左侧胶囊实时追踪阶段耗时与 Avg tok/s 输出速率；右侧圆环随上下文占比自动变绿 / 橙 / 红（0–59% / 60–79% / ≥80%），悬停即可预览明细，点击可固定面板。',
            selectors: ['[data-testid="agy-plus-performance-indicator"]', '[data-testid="agy-plus-context-pending"]'],
            mode: 'union',
            fallbackHint: '提示：打开任意对话输入框后，这两项微件会自动显示在输入框右下角。',
            preferredSide: 'top'
        },
        {
            id: 'default-model',
            title: '新对话自动锁定最高旗舰模型',
            desc: '创建空白新对话时自动选定最高阶旗舰模型与最高推理档位；若你在当前对话中手动切换其他模型，当次会话绝不强行覆盖。',
            selectors: ['[data-testid="model-selector-trigger"]'],
            mode: 'first',
            fallbackHint: '提示：可在输入框左下角模型选择器位置看到自动切换效果。',
            preferredSide: 'top'
        },
        {
            id: 'translation',
            title: 'Thinking 思考与会话标题流式中文化',
            desc: '自动将英文思考过程与侧边栏会话标题实时译为简体中文，完整保护代码路径与命令参数字面量；展开思考块时可随时点击「Show original」对照原文。',
            selectors: ['[data-testid="thinking-collapsible-trigger"]', '[data-testid="sidebar-navigation-items"]'],
            mode: 'first',
            fallbackHint: '提示：支持在设置面板即时切换「混合加速 / 仅在线 / 仅离线」三种翻译模式。',
            preferredSide: 'right'
        },
        {
            id: 'window-and-gestures',
            title: 'Window 多窗口与右键四向手势',
            desc: '在顶部 Window 菜单或按 Ctrl+Shift+N 可新建独立窗口；在界面中按住鼠标右键向 ← / → / ↑ / ↓ 拖拽（或按鼠标侧键）可快速返回、前进、回顶或到底，按 Esc 取消不误弹菜单。',
            selectors: ['[data-testid="title-menu-bar"]'],
            mode: 'first',
            fallbackHint: '提示：右键手势与侧键导航均支持在控制中心独立开关。',
            preferredSide: 'bottom'
        },
        {
            id: 'toast-center',
            title: '右下角无抢焦原生交互弹窗',
            desc: '当你切到其他软件处理工作时，任务完成提醒、单选/多选问答与命令权限审批都会在桌面右下角弹出原生卡片，支持直接提交审批或点击跳回原窗口。',
            selectors: [],
            mode: 'none',
            anchorCorner: 'bottom-right',
            fallbackHint: '提示：随时可在左下角设置面板点击「功能导览」或运行 Manage.cmd tour 重新查看本向导。'
        }
    ];

    const tourBackdrop = element('div', 'agy-plus-tour-backdrop');
    tourBackdrop.dataset.testid = 'agy-plus-tour-backdrop';
    tourBackdrop.hidden = true;

    const tourClickShield = element('div', 'agy-plus-tour-click-shield');
    tourClickShield.hidden = true;

    const tourSpotlight = element('div', 'agy-plus-tour-spotlight');
    tourSpotlight.dataset.testid = 'agy-plus-tour-spotlight';
    tourSpotlight.hidden = true;

    const tourCard = element('div', 'agy-plus-tour-card');
    tourCard.id = 'agy-plus-tour-card';
    tourCard.dataset.testid = 'agy-plus-tour-card';
    tourCard.setAttribute('role', 'dialog');
    tourCard.setAttribute('aria-modal', 'true');
    tourCard.setAttribute('aria-label', 'Antigravity Plus 功能导览');
    tourCard.hidden = true;

    document.body.append(tourBackdrop, tourClickShield, tourSpotlight, tourCard);

    let tourActive = false;
    let tourStepIndex = 0;
    let tourOpenedAutomatically = false;
    let autoTourTimer = 0;

    function readLocalTourCompleted() {
        try {
            return window.localStorage?.getItem?.(TOUR_STORAGE_KEY) === '1';
        } catch {
            return false;
        }
    }

    function writeLocalTourCompleted() {
        try {
            window.localStorage?.setItem?.(TOUR_STORAGE_KEY, '1');
        } catch {}
    }

    function isTourCompleted() {
        return Boolean(currentConfig.onboarding?.tourCompleted) || readLocalTourCompleted();
    }

    function getVisibleRect(el) {
        if (!el || !el.isConnected || el.hidden) return null;
        try {
            const r = el.getBoundingClientRect();
            if (!r || r.width < 2 || r.height < 2) return null;
            if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        } catch {
            return null;
        }
    }

    function resolveTourTargetRect(step) {
        if (!step || !Array.isArray(step.selectors) || step.selectors.length === 0 || step.mode === 'none') {
            return null;
        }
        if (step.mode === 'union') {
            const rects = [];
            for (const sel of step.selectors) {
                const r = getVisibleRect(document.querySelector(sel));
                if (r) rects.push(r);
            }
            if (!rects.length) return null;
            const left = Math.min(...rects.map(r => r.left));
            const top = Math.min(...rects.map(r => r.top));
            const right = Math.max(...rects.map(r => r.right));
            const bottom = Math.max(...rects.map(r => r.bottom));
            return { left, top, right, bottom, width: right - left, height: bottom - top };
        }
        for (const sel of step.selectors) {
            const r = getVisibleRect(document.querySelector(sel));
            if (r) return r;
        }
        return null;
    }

    function positionTourCard(targetRect, step) {
        const vw = Math.max(320, Number(window.innerWidth) || 1280);
        const vh = Math.max(240, Number(window.innerHeight) || 760);
        const cw = Math.min(372, vw - 24);
        const ch = Math.max(170, tourCard.offsetHeight || 210);
        const margin = 14;

        if (!targetRect) {
            if (step?.anchorCorner === 'bottom-right') {
                tourCard.style.left = `${Math.max(margin, vw - cw - 24)}px`;
                tourCard.style.top = `${Math.max(margin, vh - ch - 28)}px`;
                return;
            }
            tourCard.style.left = `${Math.max(margin, Math.round((vw - cw) / 2))}px`;
            tourCard.style.top = `${Math.max(margin, Math.round((vh - ch) / 2))}px`;
            return;
        }

        const gap = 16;
        const pad = 6;
        const box = {
            left: Math.max(6, targetRect.left - pad),
            top: Math.max(6, targetRect.top - pad),
            right: Math.min(vw - 6, targetRect.right + pad),
            bottom: Math.min(vh - 6, targetRect.bottom + pad)
        };

        const spaceTop = box.top - margin;
        const spaceBottom = vh - box.bottom - margin;
        const spaceRight = vw - box.right - margin;
        const spaceLeft = box.left - margin;

        let side = step?.preferredSide || 'bottom';
        const fits = s => {
            if (s === 'top') return spaceTop >= ch + gap;
            if (s === 'bottom') return spaceBottom >= ch + gap;
            if (s === 'right') return spaceRight >= cw + gap;
            if (s === 'left') return spaceLeft >= cw + gap;
            return false;
        };
        if (!fits(side)) {
            const order = ['top', 'bottom', 'right', 'left'];
            const best = order.find(fits);
            if (best) side = best;
        }

        let left = Math.round((vw - cw) / 2);
        let top = Math.round((vh - ch) / 2);
        if (side === 'top') {
            left = box.left + ((box.right - box.left) - cw) / 2;
            top = box.top - ch - gap;
        } else if (side === 'bottom') {
            left = box.left + ((box.right - box.left) - cw) / 2;
            top = box.bottom + gap;
        } else if (side === 'right') {
            left = box.right + gap;
            top = box.top + ((box.bottom - box.top) - ch) / 2;
        } else if (side === 'left') {
            left = box.left - cw - gap;
            top = box.top + ((box.bottom - box.top) - ch) / 2;
        }

        left = Math.max(margin, Math.min(Math.round(left), vw - cw - margin));
        top = Math.max(margin, Math.min(Math.round(top), vh - ch - margin));
        tourCard.style.left = `${left}px`;
        tourCard.style.top = `${top}px`;
    }

    function renderTourStep() {
        if (!tourActive || disposed) return;
        const step = TOUR_STEPS[tourStepIndex] || TOUR_STEPS[0];
        const targetRect = resolveTourTargetRect(step);
        const total = TOUR_STEPS.length;
        const isFirst = tourStepIndex === 0;
        const isLast = tourStepIndex === total - 1;

        const header = element('div', 'agy-plus-tour-header');
        header.append(element('span', 'agy-plus-tour-step-badge', `步骤 ${tourStepIndex + 1} / ${total}`));
        const closeBtn = element('button', 'agy-plus-settings-close', '×');
        closeBtn.type = 'button';
        closeBtn.dataset.testid = 'agy-plus-tour-close';
        closeBtn.setAttribute('aria-label', '跳过引导');
        closeBtn.addEventListener('click', () => stopTour({ markCompleted: true }));
        header.append(closeBtn);

        const title = element('h3', 'agy-plus-tour-title', step.title);
        const desc = element('p', 'agy-plus-tour-desc', step.desc);

        const hintText = !targetRect && step.mode !== 'none'
            ? (step.fallbackHint || '当前界面暂未显示该元素，可在对应场景下查看效果。')
            : (step.mode === 'none' ? step.fallbackHint : '');
        const hint = element('div', 'agy-plus-tour-hint', hintText);
        if (!hintText) hint.hidden = true;

        const footer = element('div', 'agy-plus-tour-footer');
        const dots = element('div', 'agy-plus-tour-dots');
        for (let i = 0; i < total; i++) {
            const dot = element('span', 'agy-plus-tour-dot');
            if (i === tourStepIndex) dot.dataset.active = 'true';
            dots.append(dot);
        }

        const actions = element('div', 'agy-plus-tour-actions');
        const skipBtn = element('button', 'agy-plus-tour-btn', '跳过');
        skipBtn.type = 'button';
        skipBtn.dataset.testid = 'agy-plus-tour-skip';
        skipBtn.addEventListener('click', () => stopTour({ markCompleted: true }));

        const prevBtn = element('button', 'agy-plus-tour-btn', '上一步');
        prevBtn.type = 'button';
        prevBtn.dataset.testid = 'agy-plus-tour-prev';
        if (isFirst) prevBtn.hidden = true;
        prevBtn.addEventListener('click', prevTourStep);

        const nextBtn = element('button', 'agy-plus-tour-btn agy-plus-tour-btn-primary', isLast ? '完成导览' : '下一步');
        nextBtn.type = 'button';
        nextBtn.dataset.testid = 'agy-plus-tour-next';
        nextBtn.addEventListener('click', nextTourStep);

        actions.append(skipBtn, prevBtn, nextBtn);
        footer.append(dots, actions);

        tourCard.replaceChildren(header, title, desc, hint, footer);
        tourCard.hidden = false;

        if (targetRect) {
            const pad = 6;
            const vw = Math.max(320, Number(window.innerWidth) || 1280);
            const vh = Math.max(240, Number(window.innerHeight) || 760);
            const left = Math.max(4, Math.round(targetRect.left - pad));
            const top = Math.max(4, Math.round(targetRect.top - pad));
            const width = Math.max(24, Math.min(vw - left - 4, Math.round(targetRect.width + pad * 2)));
            const height = Math.max(24, Math.min(vh - top - 4, Math.round(targetRect.height + pad * 2)));
            tourSpotlight.style.left = `${left}px`;
            tourSpotlight.style.top = `${top}px`;
            tourSpotlight.style.width = `${width}px`;
            tourSpotlight.style.height = `${height}px`;
            tourSpotlight.hidden = false;
            tourClickShield.hidden = false;
            tourBackdrop.hidden = true;
        } else {
            tourSpotlight.hidden = true;
            tourClickShield.hidden = true;
            tourBackdrop.hidden = false;
        }

        positionTourCard(targetRect, step);
    }

    function startTour(stepIndex = 0, options = {}) {
        if (disposed) return false;
        clearTimeout(autoTourTimer);
        autoTourTimer = 0;
        closeAllPopups();
        tourActive = true;
        tourOpenedAutomatically = Boolean(options?.auto);
        const clamped = Number.isInteger(stepIndex)
            ? Math.max(0, Math.min(TOUR_STEPS.length - 1, stepIndex))
            : 0;
        tourStepIndex = clamped;
        renderTourStep();
        return true;
    }

    function stopTour({ markCompleted = true } = {}) {
        clearTimeout(autoTourTimer);
        autoTourTimer = 0;
        tourActive = false;
        tourOpenedAutomatically = false;
        tourBackdrop.hidden = true;
        tourClickShield.hidden = true;
        tourSpotlight.hidden = true;
        tourCard.hidden = true;
        if (markCompleted) {
            writeLocalTourCompleted();
            if (!currentConfig.onboarding?.tourCompleted) {
                emitConfigPatch({ onboarding: { tourCompleted: true } });
            }
        }
        return true;
    }

    function nextTourStep() {
        if (!tourActive || disposed) return false;
        if (tourStepIndex >= TOUR_STEPS.length - 1) {
            stopTour({ markCompleted: true });
            return true;
        }
        tourStepIndex += 1;
        renderTourStep();
        return true;
    }

    function prevTourStep() {
        if (!tourActive || disposed) return false;
        if (tourStepIndex <= 0) return false;
        tourStepIndex -= 1;
        renderTourStep();
        return true;
    }

    function repositionTour() {
        if (!tourActive || disposed) return;
        const step = TOUR_STEPS[tourStepIndex] || TOUR_STEPS[0];
        const targetRect = resolveTourTargetRect(step);
        if (targetRect) {
            const pad = 6;
            const vw = Math.max(320, Number(window.innerWidth) || 1280);
            const vh = Math.max(240, Number(window.innerHeight) || 760);
            const left = Math.max(4, Math.round(targetRect.left - pad));
            const top = Math.max(4, Math.round(targetRect.top - pad));
            const width = Math.max(24, Math.min(vw - left - 4, Math.round(targetRect.width + pad * 2)));
            const height = Math.max(24, Math.min(vh - top - 4, Math.round(targetRect.height + pad * 2)));
            tourSpotlight.style.left = `${left}px`;
            tourSpotlight.style.top = `${top}px`;
            tourSpotlight.style.width = `${width}px`;
            tourSpotlight.style.height = `${height}px`;
        }
        positionTourCard(targetRect, step);
    }

    tourBackdrop.addEventListener('click', () => stopTour({ markCompleted: true }));
    tourClickShield.addEventListener('click', () => stopTour({ markCompleted: true }));

    function scheduleAutoTourIfNeeded() {
        if (disposed || tourActive || isTourCompleted()) return;
        clearTimeout(autoTourTimer);
        autoTourTimer = window.setTimeout(() => {
            autoTourTimer = 0;
            if (disposed || tourActive || isTourCompleted()) return;
            const hasOpenPopup = !panel.hidden || !contextPanel.hidden || !performancePanel.hidden || !settingsPanel.hidden;
            if (hasOpenPopup) return;
            const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
            if (!focused) return;
            if (!settingsButton.isConnected && !pendingContext.isConnected) return;
            startTour(0, { auto: true });
        }, 1400);
    }

    function openSettingsPanel(forceOpen) {
        const opening = typeof forceOpen === 'boolean' ? forceOpen : settingsPanel.hidden;
        if (tourActive) stopTour({ markCompleted: false });
        closeAllPopups();
        if (!opening) return false;
        renderSettingsPanel();
        settingsPanel.hidden = false;
        settingsButton.setAttribute('aria-expanded', 'true');
        positionPanel(settingsPanel, settingsButton, true);
        return true;
    }

    function update() {
        scheduled = 0;
        if (disposed) return;
        observer.disconnect();

        const permissions = document.querySelector('[data-testid="agent-input-box"] [data-testid="permissions-selector-trigger"]');
        if (permissions) {
            if (permissions.previousElementSibling !== pendingContext) permissions.before(pendingContext);
            if (pendingContext.previousElementSibling !== performanceBadge) pendingContext.before(performanceBadge);
        } else {
            pendingContext.remove();
            performanceBadge.remove();
        }

        const sidebar = document.querySelector('[data-testid="sidebar-navigation-items"]')?.closest('.bg-sidebar');
        const footer = sidebar?.lastElementChild;
        if (footer) {
            mark(footer, 'data-agy-plus-sidebar-footer');
            if (footer.firstElementChild !== footerLeft) footer.prepend(footerLeft);
        } else {
            footerLeft.remove();
        }

        if (currentConfig.features.codexTheme !== false) {
            if (document.documentElement) mark(document.documentElement, 'lang', 'zh-CN');
            const convView = document.querySelector('[data-testid="conversation-view"]');
            if (convView) {
                for (const node of convView.querySelectorAll(':is(.md-divider-spacing, [data-testid="agent-response"] .select-text)')) {
                    mark(node, 'data-agy-plus-prose', node.closest('.cursor-edit') ? 'detail' : 'body');
                }
            }
            const columnRoot = convView || document.querySelector('main') || document.body;
            for (const node of columnRoot.querySelectorAll('[style*="--max-conversation-width"]')) {
                mark(node, 'data-agy-plus-chat-column');
            }
        }

        for (const node of Array.from(marked.keys())) {
            if (!node.isConnected) marked.delete(node);
        }

        renderQuota();
        renderContext();
        renderPerformance();
        scanConversationTitles();
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    }

    const observer = new MutationObserver(() => {
        if (!scheduled) scheduled = window.setTimeout(update, 200);
    });

    const handlePointerDownOutside = event => {
        const t = event.target;
        if (badge.contains(t) || panel.contains(t) ||
            pendingContext.contains(t) || contextPanel.contains(t) ||
            performanceBadge.contains(t) || performancePanel.contains(t) ||
            settingsButton.contains(t) || settingsPanel.contains(t)) {
            return;
        }
        closeAllPopups();
    };

    const handleGlobalKeyDown = event => {
        if (disposed || !event || event.defaultPrevented || event.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && (event.key === ',' || event.code === 'Comma')) {
            if (event.repeat) return;
            event.preventDefault();
            event.stopPropagation();
            openSettingsPanel();
            return;
        }
        if (currentConfig.features.newWindowMenu !== false &&
            (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey &&
            (event.code === 'KeyN' || String(event.key || '').toLowerCase() === 'n')) {
            if (event.repeat) return;
            if (typeof window.__agyPlusBridge?.openNewWindow !== 'function') return;
            event.preventDefault();
            event.stopPropagation();
            try {
                void Promise.resolve(window.__agyPlusBridge.openNewWindow()).catch(() => {});
            } catch {}
            return;
        }
        if (tourActive) {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                stopTour({ markCompleted: true });
                return;
            }
            if (event.key === 'ArrowRight' || event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                nextTourStep();
                return;
            }
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                event.stopPropagation();
                prevTourStep();
                return;
            }
        }
        if (event.key === 'Escape') {
            const hasOpenPopup = !panel.hidden || !contextPanel.hidden || !performancePanel.hidden || !settingsPanel.hidden;
            if (hasOpenPopup) {
                event.preventDefault();
                event.stopPropagation();
                closeAllPopups();
            }
        }
    };

    const handleOpenSettingsEvent = () => {
        openSettingsPanel(true);
    };

    const handleBadgeHover = event => {
        if (currentConfig.features.quotaSplitRing === false) return;
        const explicit = event.target?.closest?.('[data-half]')?.getAttribute('data-half');
        let nextHalf = explicit === '5h' || explicit === 'weekly' ? explicit : '';
        if (!nextHalf) {
            const bounds = badge.getBoundingClientRect();
            const dy = event.clientY - (bounds.top + bounds.height / 2);
            if (dy < -1) nextHalf = '5h';
            else if (dy > 1) nextHalf = 'weekly';
            else nextHalf = hoveredHalf || '5h';
        }
        if (nextHalf !== hoveredHalf || quotaTooltip.hidden) {
            hoveredHalf = nextHalf;
            badge.dataset.hoveredHalf = hoveredHalf;
            renderQuotaTooltip();
        }
    };

    const handleBadgeLeave = () => {
        hoveredHalf = '';
        delete badge.dataset.hoveredHalf;
        quotaTooltip.hidden = true;
    };

    badge.addEventListener('pointerenter', handleBadgeHover);
    badge.addEventListener('pointermove', handleBadgeHover);
    badge.addEventListener('pointerleave', handleBadgeLeave);
    badge.addEventListener('click', () => {
        if (currentConfig.features.quotaSplitRing === false) return;
        const opening = panel.hidden;
        closeAllPopups();
        if (!opening) return;
        panel.hidden = false;
        badge.setAttribute('aria-expanded', 'true');
        positionPanel(panel, badge, true);
        if (Date.now() - refreshedAt > 5000) void refreshQuota();
    });

    settingsButton.addEventListener('click', () => {
        openSettingsPanel();
    });

    pendingContext.addEventListener('pointerenter', () => openContextPanel({ pin: false }));
    pendingContext.addEventListener('pointerleave', scheduleHideContextPanel);
    contextPanel.addEventListener('pointerenter', clearContextHoverTimer);
    contextPanel.addEventListener('pointerleave', scheduleHideContextPanel);
    pendingContext.addEventListener('click', () => {
        if (currentConfig.features.contextRing === false) return;
        if (!contextPanel.hidden && contextPinned) {
            hideContextPanel();
            return;
        }
        openContextPanel({ pin: true });
    });

    performanceBadge.addEventListener('pointerenter', () => openPerformancePanel({ pin: false }));
    performanceBadge.addEventListener('pointerleave', scheduleHidePerformancePanel);
    performancePanel.addEventListener('pointerenter', clearPerformanceHoverTimer);
    performancePanel.addEventListener('pointerleave', scheduleHidePerformancePanel);
    performanceBadge.addEventListener('click', () => {
        if (currentConfig.features.performancePill === false) return;
        if (!performancePanel.hidden && performancePinned) {
            hidePerformancePanel();
            return;
        }
        openPerformancePanel({ pin: true });
    });

    const reposition = () => {
        positionPanel(panel, badge, true);
        positionPanel(quotaTooltip, badge, true);
        positionPanel(contextPanel, pendingContext);
        positionPanel(performancePanel, performanceBadge);
        positionPanel(settingsPanel, settingsButton, true);
        repositionTour();
    };

    window.addEventListener('resize', reposition);
    document.addEventListener('pointerdown', handlePointerDownOutside, true);
    document.addEventListener('keydown', handleGlobalKeyDown, true);
    document.addEventListener('agy-plus:open-settings-panel', handleOpenSettingsEvent);

    const interval = window.setInterval(refreshQuota, 60000);
    const contextInterval = window.setInterval(() => {
        if (disposed) return;
        renderContext();
        renderPerformance();
    }, 1000);
    const unsubscribeDeepLink = typeof window.deepLink?.onDeepLink === 'function'
        ? window.deepLink.onDeepLink(url => { if (!disposed) handleIncomingDeepLink(url); })
        : null;
    if (typeof window.deepLink?.getStoredDeepLink === 'function') {
        void Promise.resolve(window.deepLink.getStoredDeepLink()).then(url => { if (!disposed) handleIncomingDeepLink(url); }).catch(() => {});
    }

    let syncToastInFlight = false;
    function trimMapLimit(map, limit) {
        while (map.size > limit) map.delete(map.keys().next().value);
    }

    window.__agyPlusUI = {
        version: 10,
        applyConfig: applyConfigInternal,
        drainPendingConfigPatches() {
            return pendingConfigPatches.splice(0, pendingConfigPatches.length);
        },
        openSettingsPanel,
        startTour,
        stopTour,
        nextTourStep,
        prevTourStep,
        conversationTitle: id => conversationTitles.get(id) || '',
        openConversation,
        submitAskQuestion,
        syncToastState: async () => {
            if (disposed || currentConfig.features.taskToast === false) {
                return { activeConversationId: '', windowFocused: true, titles: {}, resolvedActionIds: [], completed: [] };
            }
            if (syncToastInFlight) {
                return null;
            }
            syncToastInFlight = true;
            try {
                scanConversationTitles();
                trimMapLimit(conversationTitles, 256);
                trimMapLimit(turnStarts, 256);
                trimMapLimit(trackedTaskStates, 256);
                const waitingCards = await monitorTaskTransitions();
                if (disposed) return null;
                const match = /^\/c\/([A-Za-z0-9._-]+)/.exec(location.pathname || '');
                const activeConversationId = match ? match[1] : (readAgentEntry().conversationId || '');
                const completed = [...waitingCards, ...pendingCompletions.splice(0, pendingCompletions.length)];
                const resolved = Array.from(resolvedActionIds.values(), ({ conversationId, turnKey }) => ({ conversationId, turnKey }));
                const windowFocused = typeof document.hasFocus === 'function' ? Boolean(document.hasFocus()) : true;
                return {
                    activeConversationId: safeConversationIdRe.test(activeConversationId) ? activeConversationId : '',
                    windowFocused,
                    titles: Object.fromEntries(conversationTitles),
                    resolvedActionIds: resolved,
                    completed
                };
            } finally {
                syncToastInFlight = false;
            }
        },
        status: () => ({
            installed: true,
            version: 10,
            features: { ...currentConfig.features },
            translationMode: currentConfig.translation.mode,
            context: pendingContext.isConnected && !pendingContext.hidden,
            contextUsage: contextUsage ? {
                used: contextUsage.estimatedTokensUsed,
                maximum: contextUsage.maxContextTokens,
                level: pendingContext.dataset.contextLevel || null
            } : null,
            quota: quotaPercent,
            quotaWindows: { fiveHour: fiveHourPercent, weekly: weeklyPercent },
            modelGroup,
            refreshedAt,
            error,
            performance: performanceMetrics,
            approvalDiag: {
                backgroundSubmitReady: Boolean(readAgentContext().agentService),
                lastPermissionDiag
            },
            tour: {
                active: tourActive,
                stepIndex: tourStepIndex,
                totalSteps: TOUR_STEPS.length,
                completed: isTourCompleted()
            }
        }),
        dispose() {
            disposed = true;
            observer.disconnect();
            clearTimeout(scheduled);
            clearTimeout(autoTourTimer);
            clearContextHoverTimer();
            clearPerformanceHoverTimer();
            clearInterval(interval);
            clearInterval(contextInterval);
            if (typeof unsubscribeDeepLink === 'function') {
                try { unsubscribeDeepLink(); } catch {}
            }
            document.removeEventListener('pointerdown', handlePointerDownOutside, true);
            document.removeEventListener('keydown', handleGlobalKeyDown, true);
            document.removeEventListener('agy-plus:open-settings-panel', handleOpenSettingsEvent);
            window.removeEventListener('resize', reposition);
            for (const [node, attributes] of marked) {
                for (const [name, previousValue] of attributes) {
                    if (previousValue === null) node.removeAttribute(name);
                    else node.setAttribute(name, previousValue);
                }
            }
            footerLeft.remove();
            pendingContext.remove();
            contextPanel.remove();
            panel.remove();
            quotaTooltip.remove();
            settingsPanel.remove();
            tourBackdrop.remove();
            tourClickShield.remove();
            tourSpotlight.remove();
            tourCard.remove();
            performanceBadge.remove();
            performancePanel.remove();
            themeStyle.remove();
            widgetsStyle.remove();
            document.body.classList.remove('agy-plus-codex-ui', 'agy-plus-context-ring-active');
            document.documentElement?.removeAttribute?.('data-agy-plus-new-window-menu');
            delete window.__agyPlusUI;
        }
    };

    applyConfigInternal(currentConfig, currentRuntimeMeta);
    scheduleAutoTourIfNeeded();
    void refreshQuota();
    return window.__agyPlusUI.status();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { installAgyPlusUI };
}
