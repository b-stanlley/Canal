(function () {
    'use strict';

    const STORAGE_KEY = 'flowAutoCreateEnabled';

    // Labels used by the "Create with Google Flow" call-to-action, per locale.
    const BUTTON_LABELS = [
        'create with google flow',
        'criar com o google flow',
        'criar com google flow',
        'crear con google flow'
    ];

    const POLL_INTERVAL_MS = 1000;
    const RECLICK_COOLDOWN_MS = 3000;

    let enabled = true;
    let clickedElements = new WeakSet();
    let lastClickAt = 0;
    let currentUrl = location.href;
    let pollTimer = null;

    function isFlowPage() {
        return location.hostname === 'labs.google' && location.pathname.includes('/tools/flow');
    }

    function normalize(text) {
        return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function isVisible(el) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    }

    function findCreateButton() {
        const candidates = document.querySelectorAll('button, a, [role="button"]');
        for (const el of candidates) {
            if (clickedElements.has(el)) continue;
            if (!BUTTON_LABELS.includes(normalize(el.textContent))) continue;
            if (!isVisible(el)) continue;
            return el;
        }
        return null;
    }

    function clickElement(el) {
        console.log('[FlowAutoCreate] Clicking "Create with Google Flow" button:', el);

        try {
            const options = { view: window, bubbles: true, cancelable: true, buttons: 1 };
            el.dispatchEvent(new MouseEvent('mousedown', options));
            el.dispatchEvent(new MouseEvent('mouseup', options));
            el.dispatchEvent(new MouseEvent('click', options));
            if (typeof el.click === 'function') el.click();
        } catch (e) {
            console.error('[FlowAutoCreate] Error clicking:', e);
        }
    }

    function run() {
        if (!enabled || !isFlowPage()) return;

        if (location.href !== currentUrl) {
            // Single page app navigation: allow the button to be clicked again.
            currentUrl = location.href;
            clickedElements = new WeakSet();
            lastClickAt = 0;
        }

        if (Date.now() - lastClickAt < RECLICK_COOLDOWN_MS) return;

        const button = findCreateButton();
        if (!button) return;

        clickedElements.add(button);
        lastClickAt = Date.now();
        clickElement(button);
    }

    function start() {
        if (pollTimer !== null) return;
        run();
        pollTimer = setInterval(run, POLL_INTERVAL_MS);
        new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('load', run);
    }

    chrome.storage.local.get(STORAGE_KEY, (data) => {
        // Enabled by default; only an explicit `false` turns the automation off.
        enabled = data[STORAGE_KEY] !== false;
        console.log('[FlowAutoCreate] Auto click enabled:', enabled);
        start();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_KEY]) return;
        enabled = changes[STORAGE_KEY].newValue !== false;
        console.log('[FlowAutoCreate] Auto click enabled:', enabled);
    });
})();