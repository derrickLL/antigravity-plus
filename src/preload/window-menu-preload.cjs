'use strict';

/**
 * Antigravity Plus Isolated Renderer Preload
 *
 * 1. Injects "New Window" (respecting `data-agy-plus-new-window-menu="false"` live toggle)
 *    and "Antigravity Plus Settings…" into the top `Window` dropdown menu.
 * 2. Bridges safe config update events (`CustomEvent('agy-plus:config-patch')`) from the
 *    sandboxed Hub renderer to the main process via `ipcRenderer.invoke('agy-plus:update-config')`
 *    without exposing raw Node/Electron APIs to `window`.
 */

(function () {
    const NEW_WINDOW_IPC_CHANNEL = 'agy-plus:new-window';
    const CONFIG_UPDATE_IPC_CHANNEL = 'agy-plus:update-config';
    const MENU_BAR_SELECTOR = '[data-testid="title-menu-bar"]';
    const MENU_ITEM_SELECTOR = '[data-testid="title-menu-bar-item"]';
    const MENU_OPTION_SELECTOR = '[data-testid="title-menu-bar-option"]';
    const WRAPPER_ATTR = 'data-agy-plus-menu-items';
    const NEW_WIN_BTN_ATTR = 'data-agy-plus-new-window-button';
    const SETTINGS_BTN_ATTR = 'data-agy-plus-settings-menu-button';
    const DEFAULT_BUTTON_CLASS =
        'w-full px-3 py-1.5 text-left transition-colors flex justify-between items-center duration-100 select-none outline-none cursor-default hover:bg-secondary';
    const DEFAULT_SHORTCUT_CLASS = 'ml-4 text-sm opacity-50 font-sans';

    function isAllowedHubLocation(loc) {
        if (!loc || typeof loc !== 'object') return false;
        const protocol = String(loc.protocol || '').toLowerCase();
        if (protocol !== 'https:' && protocol !== 'http:') return false;
        const host = String(loc.hostname || '').toLowerCase();
        return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    }

    function getNewWindowShortcut(platformHint) {
        const raw = typeof platformHint === 'string'
            ? platformHint
            : (typeof navigator !== 'undefined' && navigator?.platform) || '';
        return /mac/i.test(raw) ? '\u21e7\u2318N' : 'Ctrl+Shift+N';
    }

    function getSettingsShortcut(platformHint) {
        const raw = typeof platformHint === 'string'
            ? platformHint
            : (typeof navigator !== 'undefined' && navigator?.platform) || '';
        return /mac/i.test(raw) ? '\u21e7\u2318,' : 'Ctrl+Shift+,';
    }

    function normalizeText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function findWindowMenuRoot(menuBar) {
        if (!menuBar || typeof menuBar.querySelectorAll !== 'function') return null;
        const triggers = menuBar.querySelectorAll(MENU_ITEM_SELECTOR);
        for (let i = 0; i < triggers.length; i++) {
            const trigger = triggers[i];
            if (normalizeText(trigger.textContent) === 'window') {
                const parent = trigger.parentElement;
                if (parent && parent !== menuBar) return parent;
            }
        }
        return null;
    }

    function findDropdownContainer(menuRoot) {
        if (!menuRoot || !menuRoot.children) return null;
        for (let i = 0; i < menuRoot.children.length; i++) {
            const child = menuRoot.children[i];
            if (child.getAttribute?.('data-browser-occluder') === 'true') return child;
        }
        for (let i = 0; i < menuRoot.children.length; i++) {
            const child = menuRoot.children[i];
            if (child.getAttribute?.('data-testid') === 'title-menu-bar-item') continue;
            if (child.querySelector?.(MENU_OPTION_SELECTOR)) return child;
        }
        return null;
    }

    function hasNativeNewWindowOption(dropdown) {
        if (!dropdown || typeof dropdown.querySelectorAll !== 'function') return false;
        const options = dropdown.querySelectorAll(MENU_OPTION_SELECTOR);
        for (let i = 0; i < options.length; i++) {
            const btn = options[i];
            if (btn.getAttribute?.(NEW_WIN_BTN_ATTR) === 'true' || btn.getAttribute?.(SETTINGS_BTN_ATTR) === 'true') {
                continue;
            }
            const firstSpan = btn.querySelector?.('span') || null;
            const label = normalizeText(firstSpan ? firstSpan.textContent : btn.textContent);
            if (label === 'new window') return true;
        }
        return false;
    }

    function closeDropdown(doc, menuRoot, dropdown) {
        const trigger = menuRoot?.querySelector?.(MENU_ITEM_SELECTOR);
        try { trigger?.click?.(); } catch {}
        const schedule = doc?.defaultView?.requestAnimationFrame || (fn => setTimeout(fn, 16));
        try {
            schedule(() => {
                if (!dropdown || !dropdown.isConnected) return;
                try {
                    const KeyEventCtor = doc?.defaultView?.KeyboardEvent || (typeof KeyboardEvent !== 'undefined' ? KeyboardEvent : null);
                    if (KeyEventCtor) {
                        dropdown.dispatchEvent(new KeyEventCtor('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
                    }
                } catch {}
            });
        } catch {}
    }

    function resolveButtonClass(dropdown) {
        if (dropdown && typeof dropdown.querySelectorAll === 'function') {
            const options = dropdown.querySelectorAll(MENU_OPTION_SELECTOR);
            for (let i = 0; i < options.length; i++) {
                const btn = options[i];
                if (btn.getAttribute?.(NEW_WIN_BTN_ATTR) === 'true' || btn.getAttribute?.(SETTINGS_BTN_ATTR) === 'true') continue;
                const cls = typeof btn.className === 'string' ? btn.className.trim() : '';
                if (cls && !cls.includes('pointer-events-none')) return cls;
            }
        }
        return DEFAULT_BUTTON_CLASS;
    }

    function createOptionButton(doc, dropdown, label, shortcut, attrName, onClick) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.setAttribute('data-testid', 'title-menu-bar-option');
        button.setAttribute(attrName, 'true');
        button.className = resolveButtonClass(dropdown);

        const labelSpan = doc.createElement('span');
        labelSpan.textContent = label;
        button.appendChild(labelSpan);

        if (shortcut) {
            const shortcutSpan = doc.createElement('span');
            shortcutSpan.className = DEFAULT_SHORTCUT_CLASS;
            shortcutSpan.textContent = shortcut;
            button.appendChild(shortcutSpan);
        }

        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    function syncWindowDropdown(doc, menuBar, options = {}) {
        const menuRoot = findWindowMenuRoot(menuBar);
        if (!menuRoot) return false;
        const dropdown = findDropdownContainer(menuRoot);
        if (!dropdown) return false;

        const newWindowEnabled = doc.documentElement?.getAttribute?.('data-agy-plus-new-window-menu') !== 'false';
        const showNewWindow = newWindowEnabled && !hasNativeNewWindowOption(dropdown);
        const desiredMode = showNewWindow ? 'with-new-window' : 'settings-only';

        const existing = dropdown.querySelector(`[${WRAPPER_ATTR}="true"]`);
        if (existing) {
            if (existing.getAttribute('data-agy-plus-menu-mode') === desiredMode) {
                if (dropdown.firstElementChild !== existing) dropdown.prepend(existing);
                return true;
            }
            existing.remove();
        }

        const wrapper = doc.createElement('div');
        wrapper.setAttribute(WRAPPER_ATTR, 'true');
        wrapper.setAttribute('data-agy-plus-menu-mode', desiredMode);

        if (showNewWindow) {
            const newWinBtn = createOptionButton(
                doc,
                dropdown,
                'New Window',
                options.shortcutLabel ?? getNewWindowShortcut(options.platform),
                NEW_WIN_BTN_ATTR,
                () => {
                    closeDropdown(doc, menuRoot, dropdown);
                    try { Promise.resolve(options.onNewWindow?.()).catch(() => {}); } catch {}
                }
            );
            wrapper.appendChild(newWinBtn);
        }

        const settingsBtn = createOptionButton(
            doc,
            dropdown,
            'Antigravity Plus Settings…',
            options.settingsShortcutLabel ?? getSettingsShortcut(options.platform),
            SETTINGS_BTN_ATTR,
            () => {
                closeDropdown(doc, menuRoot, dropdown);
                try {
                    const EvCtor = doc?.defaultView?.CustomEvent || CustomEvent;
                    doc.dispatchEvent(new EvCtor('agy-plus:open-settings-panel'));
                } catch {}
            }
        );
        wrapper.appendChild(settingsBtn);

        const separator = doc.createElement('div');
        separator.setAttribute('role', 'separator');
        separator.style.cssText = 'height:1px;margin:4px 0;background:var(--border,rgba(128,128,128,0.28));pointer-events:none;';
        wrapper.appendChild(separator);

        dropdown.prepend(wrapper);
        return true;
    }

    function installWindowMenuNewWindow(doc, options = {}) {
        const ObserverCtor = options.MutationObserver || doc?.defaultView?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
        let disposed = false;
        let currentMenuBar = null;
        let rootObserver = null;
        let barObserver = null;
        let attrObserver = null;
        let scanTimer = null;

        function disconnectBar() {
            try { barObserver?.disconnect(); } catch {}
            barObserver = null;
            currentMenuBar = null;
        }

        function disconnectRoot() {
            try { rootObserver?.disconnect(); } catch {}
            rootObserver = null;
            if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
        }

        function attachToMenuBar(menuBar) {
            if (disposed || !menuBar) return;
            if (currentMenuBar === menuBar && menuBar.isConnected) {
                syncWindowDropdown(doc, menuBar, options);
                return;
            }
            disconnectRoot();
            disconnectBar();
            currentMenuBar = menuBar;
            syncWindowDropdown(doc, menuBar, options);

            if (ObserverCtor) {
                barObserver = new ObserverCtor(() => {
                    if (disposed) return;
                    if (!currentMenuBar || !currentMenuBar.isConnected) {
                        disconnectBar();
                        watchForMenuBar();
                        return;
                    }
                    syncWindowDropdown(doc, currentMenuBar, options);
                });
                barObserver.observe(menuBar, { childList: true, subtree: true });
            }
        }

        function tryLocateAndAttach() {
            if (disposed || !doc?.querySelector) return false;
            const menuBar = doc.querySelector(MENU_BAR_SELECTOR);
            if (menuBar) {
                attachToMenuBar(menuBar);
                return true;
            }
            return false;
        }

        function watchForMenuBar() {
            if (disposed || tryLocateAndAttach() || !ObserverCtor || rootObserver) return;
            const rootTarget = doc.body || doc.documentElement;
            if (!rootTarget) return;
            rootObserver = new ObserverCtor(() => {
                if (disposed || scanTimer) return;
                scanTimer = setTimeout(() => {
                    scanTimer = null;
                    if (!disposed) tryLocateAndAttach();
                }, 40);
            });
            rootObserver.observe(rootTarget, { childList: true, subtree: true });
        }

        const onDocumentClick = () => {
            if (disposed) return;
            if (!currentMenuBar || !currentMenuBar.isConnected) {
                if (!tryLocateAndAttach()) {
                    disconnectBar();
                    watchForMenuBar();
                }
            }
        };
        doc?.addEventListener?.('click', onDocumentClick, true);
        if (ObserverCtor && doc?.documentElement) {
            attrObserver = new ObserverCtor(() => {
                if (!disposed && currentMenuBar && currentMenuBar.isConnected) {
                    syncWindowDropdown(doc, currentMenuBar, options);
                }
            });
            attrObserver.observe(doc.documentElement, {
                attributes: true,
                attributeFilter: ['data-agy-plus-new-window-menu']
            });
        }
        watchForMenuBar();

        return {
            sync: () => (!disposed && tryLocateAndAttach() && currentMenuBar ? syncWindowDropdown(doc, currentMenuBar, options) : false),
            dispose() {
                if (disposed) return;
                disposed = true;
                doc?.removeEventListener?.('click', onDocumentClick, true);
                try { attrObserver?.disconnect(); } catch {}
                attrObserver = null;
                disconnectRoot();
                disconnectBar();
                const injected = doc?.querySelectorAll?.(`[${WRAPPER_ATTR}="true"]`) || [];
                for (let i = 0; i < injected.length; i++) {
                    try { injected[i].remove(); } catch {}
                }
            }
        };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            NEW_WINDOW_IPC_CHANNEL,
            CONFIG_UPDATE_IPC_CHANNEL,
            WRAPPER_ATTR,
            NEW_WIN_BTN_ATTR,
            SETTINGS_BTN_ATTR,
            isAllowedHubLocation,
            syncWindowDropdown,
            installWindowMenuNewWindow
        };
    }

    if (typeof process !== 'undefined' && process?.type === 'renderer' && typeof window !== 'undefined' && typeof document !== 'undefined') {
        try {
            if (window !== window.top || !isAllowedHubLocation(window.location)) return;
            if (globalThis.__agyPlusPreloadMounted) return;
            globalThis.__agyPlusPreloadMounted = true;

            const electron = typeof require === 'function' ? require('electron') : null;
            const ipcRenderer = electron && electron.ipcRenderer;
            if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return;

            const contextBridge = electron && electron.contextBridge;
            if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
                try {
                    contextBridge.exposeInMainWorld('__agyPlusBridge', {
                        updateConfig: patch => {
                            if (!patch || typeof patch !== 'object') return Promise.resolve({ ok: false });
                            return ipcRenderer.invoke(CONFIG_UPDATE_IPC_CHANNEL, patch);
                        },
                        openNewWindow: () => ipcRenderer.invoke(NEW_WINDOW_IPC_CHANNEL)
                    });
                } catch {}
            }

            const mount = () => {
                globalThis.__agyPlusMenuController = installWindowMenuNewWindow(document, {
                    onNewWindow: () => ipcRenderer.invoke(NEW_WINDOW_IPC_CHANNEL)
                });
            };

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', mount, { once: true });
            } else {
                mount();
            }
        } catch {}
    }
})();
