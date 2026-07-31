(function () {
    'use strict';

    const STORAGE_KEY = 'flowAutoCreateEnabled';
    const SIGNIN_ATTEMPTS_KEY = 'flowAutoSignInAttempts';
    const ACCOUNT_PICK_ATTEMPTS_KEY = 'flowAutoAccountPickAttempts';

    // The sign-in page is reached again on every failed OAuth round trip, and each
    // round trip reloads the page. Without a persisted counter the automation would
    // bounce between labs.google and accounts.google.com forever.
    const SIGNIN_MAX_ATTEMPTS = 3;
    const SIGNIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

    const TARGETS = [
        {
            name: 'createWithFlow',
            appliesTo: () => location.pathname.includes('/tools/flow'),
            labels: [
                'create with google flow',
                'criar com o google flow',
                'criar com google flow',
                'crear con google flow'
            ]
        },
        {
            name: 'signInWithGoogle',
            appliesTo: () => location.pathname.includes('/api/auth/signin'),
            labels: [
                'sign in with google',
                'fazer login com o google',
                'entrar com o google',
                'continuar com o google',
                'iniciar sesión con google',
                'different account',
                'outra conta'
            ],
            limited: true
        },
        {
            name: 'backToProjects',
            appliesTo: () => location.pathname.includes('/tools/flow/project'),
            labels: [
                'voltar aos projetos',
                'back to projects',
                'volver a los proyectos'
            ]
        }
    ];

    const POLL_INTERVAL_MS = 1000;
    const RECLICK_COOLDOWN_MS = 3000;

    let enabled = true;
    let clickedElements = new WeakSet();
    let lastClickAt = 0;
    let currentUrl = location.href;
    let pollTimer = null;
    let isRunning = false;

    function getStored(key) {
        return new Promise((resolve) => {
            chrome.storage.local.get(key, (data) => resolve(data[key]));
        });
    }

    function setStored(key, value) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [key]: value }, resolve);
        });
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

    function activeTarget() {
        if (location.hostname !== 'labs.google') return null;
        return TARGETS.find((target) => target.appliesTo()) || null;
    }

    function findButton(target) {
        const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span')).filter(el => {
            if (clickedElements.has(el)) return false;
            if (!isVisible(el)) return false;
            const text = normalize(el.textContent);
            return target.labels.some(label => text.includes(label));
        });

        if (candidates.length === 0) return null;

        // Sort by text length to find the most deeply nested element
        candidates.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
        
        // Find the actual interactive button wrapping this element
        const targetBtn = candidates[0];
        return targetBtn.closest('button, a, [role="button"]') || targetBtn;
    }

    function clickElement(el, target) {
        console.log('[FlowAutoCreate] Clicking "' + target.name + '" button:', el);

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

    // Returns false when the sign-in retry budget is spent, so a broken login
    // stops bouncing and leaves the page usable by hand.
    async function consumeSignInAttempt() {
        const now = Date.now();
        const stored = await getStored(SIGNIN_ATTEMPTS_KEY);
        const withinWindow = stored && now - stored.firstAt < SIGNIN_ATTEMPT_WINDOW_MS;
        const state = withinWindow ? stored : { count: 0, firstAt: now };

        if (state.count >= SIGNIN_MAX_ATTEMPTS) {
            console.warn(
                '[FlowAutoCreate] Sign-in retried ' + state.count + ' times without success. ' +
                'Automation paused - sign in manually, or reset it with ' +
                'chrome.storage.local.remove("' + SIGNIN_ATTEMPTS_KEY + '").'
            );
            return false;
        }

        await setStored(SIGNIN_ATTEMPTS_KEY, { count: state.count + 1, firstAt: state.firstAt });
        return true;
    }

    async function run() {
        if (!enabled || isRunning) return;

        if (location.href !== currentUrl) {
            // Single page app navigation: allow the button to be clicked again.
            currentUrl = location.href;
            clickedElements = new WeakSet();
            lastClickAt = 0;
        }

        const target = activeTarget();
        if (!target) return;

        // Reaching Flow itself means the login worked, so the retry budgets are fresh.
        if (target.name === 'createWithFlow') {
            chrome.storage.local.remove([SIGNIN_ATTEMPTS_KEY, ACCOUNT_PICK_ATTEMPTS_KEY]);
        }

        if (Date.now() - lastClickAt < RECLICK_COOLDOWN_MS) return;

        const button = findButton(target);
        if (!button) return;

        isRunning = true;
        try {
            if (target.limited && !(await consumeSignInAttempt())) {
                clickedElements.add(button);
                return;
            }

            clickedElements.add(button);
            lastClickAt = Date.now();
            clickElement(button, target);
        } finally {
            isRunning = false;
        }
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
