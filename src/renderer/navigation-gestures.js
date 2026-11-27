function installAgyPlusNavigationGestures(initialOptions) {
    'use strict';
    const VERSION = 2;
    const previous = window.__agyPlusNavUI;
    if (previous && typeof previous.dispose === 'function') {
        try { previous.dispose(); } catch {}
    }

    const STORAGE_KEY = 'agy_plus_nav_history_v1';
    const MAX_HISTORY = 60;
    const GESTURE_THRESHOLD = 60;
    const GESTURE_RATIO = 1.35;
    const GESTURE_EXPIRY_MS = 15000;
    const SUPPRESS_MENU_MS = 380;
    const NAV_DEDUPE_MS = 160;
    const ACTIONS = { L: 'back', R: 'forward', U: 'top', D: 'bottom' };
    const LABELS = {
        back: '← 返回',
        forward: '→ 前进',
        top: '↑ 到顶部',
        bottom: '↓ 到底部',
        cancel: '取消手势'
    };
    const SAFE_CONV_ID_RE = /^[A-Za-z0-9._-]+$/;

    let enabled = initialOptions?.enabled !== false;
    let disposed = false;
    let historyState = loadPersistedHistory();
    let internalNavDepth = 0;
    let lastNavAt = 0;
    let lastNavDir = '';
    let lastRecordedHref = '';

    let gesture = null;
    let suppressMenuUntil = 0;
    let expiryTimer = null;

    let overlay = null;
    let lineEl = null;
    let labelEl = null;
    let trailPoints = [];
    let hideOverlayTimer = null;

    const origPushState = typeof history?.pushState === 'function' ? history.pushState : null;
    const origReplaceState = typeof history?.replaceState === 'function' ? history.replaceState : null;
    let routePollTimer = null;

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function truncateTitle(title, maxLen = 28) {
        const clean = normalizeText(title);
        if (!clean) return '';
        return clean.length > maxLen ? clean.slice(0, maxLen - 1).trimEnd() + '…' : clean;
    }

    function normalizeRouteFromLocation(loc = window.location) {
        const pathname = String(loc?.pathname || '/').replace(/\/+$/, '') || '/';
        const search = String(loc?.search || '');
        const params = new URLSearchParams(search);
        const project = params.get('project') || '';

        const convMatch = /^\/c\/([A-Za-z0-9._-]+)$/.exec(pathname);
        if (convMatch) {
            const conversationId = convMatch[1];
            const cleanHref = project
                ? `/c/${conversationId}?project=${encodeURIComponent(project)}`
                : `/c/${conversationId}`;
            return { key: `/c/${conversationId}`, kind: 'conversation', conversationId, project, href: cleanHref };
        }

        if (pathname === '/' || pathname === '/new' || pathname === '/c/new') {
            const cleanHref = project ? `/?project=${encodeURIComponent(project)}` : '/';
            return { key: '/', kind: 'home', conversationId: '', project, href: cleanHref };
        }

        return {
            key: pathname,
            kind: 'page',
            conversationId: '',
            project,
            href: pathname + (project ? `?project=${encodeURIComponent(project)}` : '')
        };
    }

    function resolveRouteTitle(route) {
        if (!route) return '';
        if (route.kind === 'conversation' && route.conversationId) {
            const uiTitle = window.__agyPlusUI?.conversationTitle?.(route.conversationId) || '';
            if (uiTitle) return truncateTitle(uiTitle);
            const links = document.querySelectorAll?.('a[href]') || [];
            for (const link of links) {
                try {
                    if (new URL(link.href, window.location.origin).pathname === route.key) {
                        const t = normalizeText(link.getAttribute('title') || link.textContent || '');
                        if (t) return truncateTitle(t);
                    }
                } catch {}
            }
            return '';
        }
        if (route.kind === 'home') return '新对话';
        const seg = route.key.replace(/^\//, '').split('/')[0] || '';
        return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : '';
    }

    function loadPersistedHistory() {
        try {
            const raw = window.sessionStorage?.getItem?.(STORAGE_KEY) || window.sessionStorage?.getItem?.('derrick_agy_nav_history_v1');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.entries) && parsed.entries.length > 0 &&
                    Number.isInteger(parsed.index) && parsed.index >= 0 && parsed.index < parsed.entries.length) {
                    return parsed;
                }
            }
        } catch {}
        return { entries: [], index: -1 };
    }

    function persistHistory() {
        try { window.sessionStorage?.setItem?.(STORAGE_KEY, JSON.stringify(historyState)); } catch {}
    }

    function recordCurrentRoute(mode = 'push') {
        if (disposed) return;
        const route = normalizeRouteFromLocation();
        const title = resolveRouteTitle(route);
        const now = Date.now();
        const current = historyState.entries[historyState.index];

        if (current && current.key === route.key) {
            current.href = route.href;
            current.project = route.project;
            if (title) current.title = title;
            current.visitedAt = now;
            persistHistory();
            lastRecordedHref = `${window.location.pathname}${window.location.search}`;
            return;
        }
        if (internalNavDepth > 0) {
            lastRecordedHref = `${window.location.pathname}${window.location.search}`;
            return;
        }

        const entry = {
            key: route.key,
            kind: route.kind,
            conversationId: route.conversationId,
            project: route.project,
            href: route.href,
            title,
            visitedAt: now
        };

        if (mode === 'replace' && historyState.index >= 0 && historyState.entries.length > 0) {
            historyState.entries[historyState.index] = entry;
        } else {
            const nextEntries = historyState.entries.slice(0, historyState.index + 1);
            nextEntries.push(entry);
            if (nextEntries.length > MAX_HISTORY) nextEntries.splice(0, nextEntries.length - MAX_HISTORY);
            historyState = { entries: nextEntries, index: nextEntries.length - 1 };
        }
        persistHistory();
        lastRecordedHref = `${window.location.pathname}${window.location.search}`;
    }

    function canGoBack() { return historyState.index > 0; }
    function canGoForward() { return historyState.index >= 0 && historyState.index < historyState.entries.length - 1; }

    async function navigateToEntry(entry) {
        if (!entry) return false;
        const targetPath = entry.key;
        const targetHref = entry.href || entry.key;

        if (entry.kind === 'conversation' && SAFE_CONV_ID_RE.test(entry.conversationId)) {
            if (typeof window.__agyPlusUI?.openConversation === 'function') {
                const res = await window.__agyPlusUI.openConversation(entry.conversationId);
                if (res?.navigated) return true;
            }
        }

        const links = Array.from(document.querySelectorAll?.('a[href]') || []);
        const exactLink = links.find(a => {
            try {
                const u = new URL(a.href, window.location.origin);
                return (u.pathname.replace(/\/+$/, '') || '/') === targetPath;
            } catch { return false; }
        });
        if (exactLink && typeof exactLink.click === 'function') {
            exactLink.click();
            await new Promise(resolve => setTimeout(resolve, 60));
            if (normalizeRouteFromLocation().key === targetPath) return true;
        }

        if (typeof MouseEvent === 'function' && document.body) {
            const tempLink = document.createElement('a');
            tempLink.href = targetHref;
            tempLink.style.display = 'none';
            (document.querySelector('.bg-sidebar') || document.body).appendChild(tempLink);
            try {
                tempLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 }));
            } catch {} finally { tempLink.remove(); }
            await new Promise(resolve => setTimeout(resolve, 60));
            if (normalizeRouteFromLocation().key === targetPath) return true;
        }

        if (origPushState) origPushState.call(history, history.state, '', targetHref);
        else history.pushState(history.state, '', targetHref);
        if (typeof PopStateEvent === 'function') {
            window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        }
        return true;
    }

    function removeOverlay() {
        clearTimeout(hideOverlayTimer);
        hideOverlayTimer = null;
        overlay?.remove();
        overlay = null;
        lineEl = null;
        labelEl = null;
        trailPoints = [];
    }

    function ensureOverlay(startX, startY, withTrail) {
        if (overlay || !document.documentElement) return;
        overlay = document.createElement('div');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.dataset.agyPlusGestureOverlay = 'true';
        overlay.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
        const root = overlay.attachShadow({ mode: 'closed' });

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;';
        lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        lineEl.setAttribute('fill', 'none');
        lineEl.setAttribute('stroke', '#8ab4f8');
        lineEl.setAttribute('stroke-width', '3');
        lineEl.setAttribute('stroke-linecap', 'round');
        lineEl.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(lineEl);

        labelEl = document.createElement('div');
        labelEl.style.cssText = 'position:absolute;bottom:36px;left:50%;transform:translateX(-50%);padding:9px 17px;border-radius:18px;background:#202124ed;color:#e8f0fe;font:14px "Segoe UI Variable","Microsoft YaHei UI",sans-serif;box-shadow:0 2px 12px #0006;white-space:nowrap;max-width:72vw;overflow:hidden;text-overflow:ellipsis;';
        root.append(svg, labelEl);
        document.documentElement.appendChild(overlay);
        trailPoints = withTrail && Number.isFinite(startX) && Number.isFinite(startY) ? [[startX, startY]] : [];
    }

    function showToastPill(text, durationMs = 650) {
        clearTimeout(hideOverlayTimer);
        ensureOverlay(0, 0, false);
        if (!labelEl) return;
        labelEl.textContent = text;
        hideOverlayTimer = setTimeout(removeOverlay, durationMs);
    }

    let navSeq = 0;
    let navInFlight = false;
    let suppressNextContextMenu = false;
    const internalNavTimers = new Set();

    async function navigate(direction, source = 'api') {
        if (disposed || !enabled) return { navigated: false, reason: disposed ? 'disposed' : 'disabled' };
        if (direction !== 'back' && direction !== 'forward') return { navigated: false, reason: 'invalid_direction' };
        const now = Date.now();
        const dedupeWindow = source === 'app-command' ? 400 : NAV_DEDUPE_MS;
        if (now - lastNavAt < dedupeWindow && lastNavDir === direction) {
            return { navigated: false, deduped: true };
        }
        if (navInFlight) {
            return { navigated: false, deduped: true, reason: 'in_flight' };
        }
        lastNavAt = now;
        lastNavDir = direction;
        recordCurrentRoute('replace');

        const delta = direction === 'back' ? -1 : 1;
        const prevIndex = historyState.index;
        const targetIndex = prevIndex + delta;
        if (targetIndex < 0 || targetIndex >= historyState.entries.length) {
            showToastPill(direction === 'back' ? '没有可返回的对话' : '没有可前进的对话', 600);
            return { navigated: false, available: false, direction, source };
        }

        const target = historyState.entries[targetIndex];
        const seq = ++navSeq;
        navInFlight = true;
        historyState.index = targetIndex;
        persistHistory();

        const titleSuffix = target.title ? ` · ${truncateTitle(target.title, 26)}` : '';
        showToastPill(`${LABELS[direction]}${titleSuffix}`, 650);

        internalNavDepth += 1;
        try {
            await navigateToEntry(target);
            if (disposed || seq !== navSeq) {
                return { navigated: false, stale: true };
            }
            const refreshedTitle = resolveRouteTitle(target);
            if (refreshedTitle) {
                target.title = refreshedTitle;
                persistHistory();
            }
            lastRecordedHref = `${window.location.pathname}${window.location.search}`;
            return {
                navigated: true,
                available: true,
                direction,
                source,
                target: { ...target },
                index: historyState.index,
                length: historyState.entries.length
            };
        } catch (err) {
            if (seq === navSeq) {
                historyState.index = prevIndex;
                persistHistory();
            }
            throw err;
        } finally {
            if (seq === navSeq) navInFlight = false;
            const t = setTimeout(() => {
                internalNavTimers.delete(t);
                internalNavDepth = Math.max(0, internalNavDepth - 1);
            }, 260);
            internalNavTimers.add(t);
        }
    }

    function isScrollableY(el) {
        if (!el || el === document.documentElement) return false;
        try {
            const overflowY = window.getComputedStyle(el).overflowY;
            return /^(auto|scroll|overlay)$/.test(overflowY) && el.scrollHeight > el.clientHeight + 2;
        } catch { return false; }
    }

    function findPrimaryConversationScroller() {
        const roots = [
            document.querySelector('[data-testid="conversation-view"]'),
            document.querySelector('main'),
            document.body
        ].filter(Boolean);
        let best = null;
        let bestArea = 0;
        const scrollSelector = '[class*="overflow-y-auto"], [class*="overflow-y-scroll"], [class*="overflow-auto"], [style*="overflow"]';
        for (const root of roots) {
            const fastList = [root, ...Array.from(root.querySelectorAll(scrollSelector))];
            for (const el of fastList) {
                if (el.closest?.('.bg-sidebar') || !isScrollableY(el)) continue;
                const rect = el.getBoundingClientRect?.();
                const area = rect ? rect.width * rect.height : 0;
                if (area > bestArea) { bestArea = area; best = el; }
            }
            if (best) return best;
            const fallbackList = Array.from(root.querySelectorAll('div, section, main')).slice(0, 200);
            for (const el of fallbackList) {
                if (el.closest?.('.bg-sidebar') || !isScrollableY(el)) continue;
                const rect = el.getBoundingClientRect?.();
                const area = rect ? rect.width * rect.height : 0;
                if (area > bestArea) { bestArea = area; best = el; }
            }
            if (best) return best;
        }
        return document.scrollingElement || document.documentElement;
    }

    function scrollAtPoint(startX, startY, action) {
        let element = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(startX, startY) : null;
        while (element && element !== document.documentElement) {
            if (isScrollableY(element)) break;
            element = element.parentElement;
        }
        if (!element || element === document.documentElement) element = findPrimaryConversationScroller();
        if (!element || typeof element.scrollTo !== 'function') return false;
        element.scrollTo({ top: action === 'top' ? 0 : element.scrollHeight, behavior: 'smooth' });
        return true;
    }

    function cancelGesture() {
        clearTimeout(expiryTimer);
        expiryTimer = null;
        if (gesture?.moved) removeOverlay();
        gesture = null;
    }

    function sampleGesture(x, y) {
        if (!gesture) return;
        const dx = x - gesture.anchorX;
        const dy = y - gesture.anchorY;
        const horizontal = Math.abs(dx);
        const vertical = Math.abs(dy);
        if (!gesture.moved && Math.hypot(x - gesture.startX, y - gesture.startY) >= GESTURE_THRESHOLD) gesture.moved = true;
        if (Math.max(horizontal, vertical) < GESTURE_THRESHOLD) return;
        let dir = '';
        if (horizontal >= vertical * GESTURE_RATIO) dir = dx < 0 ? 'L' : 'R';
        else if (vertical >= horizontal * GESTURE_RATIO) dir = dy < 0 ? 'U' : 'D';
        else return;

        if (!gesture.path.endsWith(dir)) {
            gesture.path = gesture.path.length < 4 ? gesture.path + dir : 'invalid';
        }
        gesture.anchorX = x;
        gesture.anchorY = y;
    }

    function onMouseDown(event) {
        if (disposed || !enabled || !event) return;
        if (event.button === 3 || event.button === 4) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }
        cancelGesture();
        if (event.button !== 2 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
        gesture = {
            startX: event.clientX,
            startY: event.clientY,
            anchorX: event.clientX,
            anchorY: event.clientY,
            path: '',
            moved: false,
            lastPaint: 0
        };
        expiryTimer = setTimeout(cancelGesture, GESTURE_EXPIRY_MS);
    }

    function onMouseMove(event) {
        if (disposed || !enabled || !gesture || !event) return;
        if (typeof event.buttons === 'number' && (event.buttons & 2) === 0) {
            cancelGesture();
            return;
        }
        sampleGesture(event.clientX, event.clientY);
        const now = Date.now();
        if (gesture.moved && now - gesture.lastPaint >= 16) {
            gesture.lastPaint = now;
            clearTimeout(hideOverlayTimer);
            ensureOverlay(gesture.startX, gesture.startY, true);
            if (!overlay || !lineEl || !labelEl) return;
            trailPoints.push([event.clientX, event.clientY]);
            if (trailPoints.length > 256) trailPoints.splice(1, 1);
            lineEl.setAttribute('points', trailPoints.map(p => p.join(',')).join(' '));
            const action = ACTIONS[gesture.path] || 'cancel';
            labelEl.textContent = LABELS[action] || LABELS.cancel;
        }
    }

    function onMouseUp(event) {
        if (disposed || !enabled || !event) return;
        if (event.button === 3 || event.button === 4) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            void navigate(event.button === 3 ? 'back' : 'forward', 'mouse-side-button');
            return;
        }
        if (event.button === 2 && suppressNextContextMenu) {
            suppressNextContextMenu = false;
            suppressMenuUntil = Date.now() + SUPPRESS_MENU_MS;
        }
        if (!gesture || event.button !== 2) return;
        sampleGesture(event.clientX, event.clientY);
        const completed = gesture;
        clearTimeout(expiryTimer);
        expiryTimer = null;
        gesture = null;
        if (!completed.moved) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        suppressMenuUntil = Date.now() + SUPPRESS_MENU_MS;

        const action = ACTIONS[completed.path] || 'cancel';
        if (action === 'back' || action === 'forward') {
            void navigate(action, 'right-gesture');
            return;
        }
        if (action === 'top' || action === 'bottom') {
            ensureOverlay(completed.startX, completed.startY, true);
            if (labelEl) labelEl.textContent = LABELS[action];
            scrollAtPoint(completed.startX, completed.startY, action);
            hideOverlayTimer = setTimeout(removeOverlay, 600);
            return;
        }
        ensureOverlay(completed.startX, completed.startY, true);
        if (labelEl) labelEl.textContent = LABELS.cancel;
        hideOverlayTimer = setTimeout(removeOverlay, 450);
    }

    function onAuxClick(event) {
        if (disposed || !enabled || !event) return;
        if (event.button === 3 || event.button === 4) {
            // onMouseUp already triggered navigate() for mouse side buttons; suppress native auxclick only.
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    }

    function onContextMenu(event) {
        if (disposed || !enabled || !event) return;
        if (gesture?.moved || suppressNextContextMenu || Date.now() < suppressMenuUntil) {
            suppressNextContextMenu = false;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    }

    function onKeyDown(event) {
        if (disposed || !enabled || !event) return;
        if (event.key === 'Escape' && gesture) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            suppressNextContextMenu = true;
            suppressMenuUntil = Date.now() + SUPPRESS_MENU_MS;
            cancelGesture();
        }
    }

    const onBlur = () => {
        suppressNextContextMenu = false;
        cancelGesture();
    };
    const onPopState = () => recordCurrentRoute('push');

    let patchedPushState = null;
    let patchedReplaceState = null;
    if (origPushState) {
        patchedPushState = function agyPlusPatchedPushState(...args) {
            const ret = origPushState.apply(this, args);
            recordCurrentRoute('push');
            return ret;
        };
        history.pushState = patchedPushState;
    }
    if (origReplaceState) {
        patchedReplaceState = function agyPlusPatchedReplaceState(...args) {
            const ret = origReplaceState.apply(this, args);
            recordCurrentRoute('replace');
            return ret;
        };
        history.replaceState = patchedReplaceState;
    }

    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('auxclick', onAuxClick, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('popstate', onPopState);

    routePollTimer = window.setInterval(() => {
        if (disposed) return;
        const href = `${window.location.pathname}${window.location.search}`;
        if (href !== lastRecordedHref) recordCurrentRoute('push');
    }, 300);

    recordCurrentRoute('push');

    const api = {
        version: VERSION,
        navigate,
        canGoBack,
        canGoForward,
        setEnabled(nextEnabled) {
            enabled = Boolean(nextEnabled);
            if (!enabled) {
                suppressNextContextMenu = false;
                cancelGesture();
                removeOverlay();
            }
            return api.status();
        },
        scroll: (action, x = window.innerWidth / 2, y = window.innerHeight / 2) => scrollAtPoint(x, y, action),
        getHistory: () => ({ index: historyState.index, entries: historyState.entries.map(e => ({ ...e })) }),
        status: () => ({
            installed: true,
            version: VERSION,
            enabled,
            gestures: ['L:back', 'R:forward', 'U:top', 'D:bottom'],
            historyIndex: historyState.index,
            historyLength: historyState.entries.length,
            canGoBack: canGoBack(),
            canGoForward: canGoForward(),
            currentKey: historyState.entries[historyState.index]?.key || ''
        }),
        dispose() {
            if (disposed) return;
            disposed = true;
            suppressNextContextMenu = false;
            navSeq++;
            navInFlight = false;
            for (const t of internalNavTimers) clearTimeout(t);
            internalNavTimers.clear();
            cancelGesture();
            removeOverlay();
            if (routePollTimer) { clearInterval(routePollTimer); routePollTimer = null; }
            if (origPushState && history.pushState === patchedPushState) history.pushState = origPushState;
            if (origReplaceState && history.replaceState === patchedReplaceState) history.replaceState = origReplaceState;
            window.removeEventListener('mousedown', onMouseDown, true);
            window.removeEventListener('mousemove', onMouseMove, true);
            window.removeEventListener('mouseup', onMouseUp, true);
            window.removeEventListener('auxclick', onAuxClick, true);
            window.removeEventListener('contextmenu', onContextMenu, true);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('popstate', onPopState);
            if (window.__agyPlusNavUI === api) {
                delete window.__agyPlusNavUI;
            }
        }
    };

    window.__agyPlusNavUI = api;
    return api.status();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { installAgyPlusNavigationGestures };
}
