(function () {
  'use strict';

  const STORAGE_KEY = 'flowAutoCreateEnabled';
  const SWITCHER_KEY = 'flowAccountSwitcher';
  const ACCOUNT_KEY = 'flowAutoSignInAccount';
  const ATTEMPTS_KEY = 'flowAutoAccountPickAttempts';

  // The chooser reappears on every failed OAuth round trip, and each one reloads
  // the page, so the retry budget has to survive outside of memory.
  const MAX_ATTEMPTS = 3;
  const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

  const POLL_INTERVAL_MS = 1000;
  const RECLICK_COOLDOWN_MS = 10000;
  const EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/;

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

  function isChooserPage() {
    return location.hostname === 'accounts.google.com' &&
      /(oauth|signin|accountchooser|servicelogin)/i.test(location.pathname);
  }

  function isVisible(el) {
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  // Rows are matched by the email they show, which also skips the "Use another
  // account" entry - it carries no address.
  function findAccountRows() {
    const rows = [];
    const seen = new Set();

    for (const el of document.querySelectorAll('*')) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue;
      if (el.children.length > 2) continue;
      if (!isVisible(el)) continue;

      const match = (el.textContent || '').match(EMAIL_PATTERN);
      if (!match) continue;

      const email = match[0].toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);

      const clickable = el.closest('[role="link"], [role="button"], li, div[data-identifier]') || el;
      rows.push({ email, element: clickable });
    }

    return rows;
  }

  function clickElement(el) {
    try {
      const options = { view: window, bubbles: true, cancelable: true, buttons: 1 };
      el.dispatchEvent(new MouseEvent('mousedown', options));
      el.dispatchEvent(new MouseEvent('mouseup', options));
      el.dispatchEvent(new MouseEvent('click', options));
      if (typeof el.click === 'function') el.click();
    } catch (e) {
      console.error('[FlowAutoPick] Error clicking:', e);
    }
  }

  const ACCOUNT_INDEX_KEY = 'flowAutoPickCurrentIndex';

  async function run() {
    if (!enabled || isRunning || !isChooserPage()) return;

    if (location.href !== currentUrl) {
      currentUrl = location.href;
      clickedElements = new WeakSet();
      lastClickAt = 0;
    }

    if (Date.now() - lastClickAt < RECLICK_COOLDOWN_MS) return;

    // The extension's own account switcher drives this page while it runs;
    // two clickers on the same list would fight over the selection.
    const switcher = await getStored(SWITCHER_KEY);
    if (switcher && switcher.switching) return;

    const rows = findAccountRows();
    if (rows.length === 0) return;

    // Get the current account index to try
    const storedIndex = (await getStored(ACCOUNT_INDEX_KEY)) || 0;
    const accountIndex = storedIndex % rows.length;

    // If we've cycled through ALL accounts, stop
    if (storedIndex >= rows.length) {
      console.warn(
        '[FlowAutoPick] Tried all ' + rows.length + ' accounts without success. ' +
        'Automation paused. Reset with: chrome.storage.local.remove("' + ACCOUNT_INDEX_KEY + '")'
      );
      return;
    }

    const chosen = rows[accountIndex];

    isRunning = true;
    try {
      // Advance the index for next time (in case this account fails)
      await setStored(ACCOUNT_INDEX_KEY, storedIndex + 1);

      clickedElements.add(chosen.element);
      lastClickAt = Date.now();
      console.log('[FlowAutoPick] Choosing account ' + (accountIndex + 1) + '/' + rows.length + ': ' + chosen.email);

      // Signal the content script on Flow to auto-click "Run" after login
      await setStored('flowAutoRunAfterLogin', true);

      clickElement(chosen.element);
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
    enabled = data[STORAGE_KEY] !== false;
    console.log('[FlowAutoPick] Auto pick enabled:', enabled);
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    enabled = changes[STORAGE_KEY].newValue !== false;
    console.log('[FlowAutoPick] Auto pick enabled:', enabled);
  });
})();
