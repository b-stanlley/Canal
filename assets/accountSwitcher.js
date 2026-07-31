(function () {
  'use strict';

  const STORAGE_KEY = 'flowAccountSwitcher';

  async function getState() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        resolve(data[STORAGE_KEY] || null);
      });
    });
  }

  async function setState(state) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
    });
  }

  function findAccountElements() {
    const all = Array.from(document.querySelectorAll('*'));
    const emails = all.filter(el => {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') return false;
      if (el.children.length > 2) return false;
      // must be visible
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
      return /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/.test(el.textContent);
    });

    const accounts = [];
    const seen = new Set();
    
    for (const el of emails) {
      const match = el.textContent.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
      if (match) {
        const email = match[0].toLowerCase();
        if (!seen.has(email)) {
          seen.add(email);
          const clickable = el.closest('[role="link"], [role="button"], li, div[data-identifier]') || el;
          accounts.push(clickable);
        }
      }
    }
    
    return accounts;
  }

  function clickElement(el) {
    if (!el) return;
    console.log('[FlowAutoSwitch] Clicking target account element:', el);

    try {
      const mouseDown = new MouseEvent('mousedown', { view: window, bubbles: true, cancelable: true, buttons: 1 });
      const mouseUp = new MouseEvent('mouseup', { view: window, bubbles: true, cancelable: true, buttons: 1 });
      const click = new MouseEvent('click', { view: window, bubbles: true, cancelable: true, buttons: 1 });
      
      el.dispatchEvent(mouseDown);
      el.dispatchEvent(mouseUp);
      el.dispatchEvent(click);
    } catch (e) {
      console.error('[FlowAutoSwitch] Error clicking:', e);
    }
  }

  let isExecuting = false;

  async function run() {
    if (isExecuting) return;
    isExecuting = true;

    try {
      const state = await getState();
      console.log('[FlowAutoSwitch] Current state:', state); if (!state || !state.switching) {
        isExecuting = false;
        return;
      }

      console.log('[FlowAutoSwitch] Account Switcher checking page for accounts...');

      const accountElements = findAccountElements();
      if (accountElements.length === 0) {
        console.log('[FlowAutoSwitch] No account elements found yet on page.');
        isExecuting = false;
        return;
      }

      const totalAccounts = accountElements.length;
      console.log('FlowAutoSwitch] Found ' + totalAccounts + ' accounts on page.');

      const triedAccounts = state.triedAccounts || [];
      const currentAccountIndex = state.currentAccountIndex || 0;

      let nextIndex = -1;
      for (let i = 0; i < totalAccounts; i++) {
        const candidateIndex = (currentAccountIndex + 1 + i) % totalAccounts;
        if (!triedAccounts.includes(candidateIndex)) {
          nextIndex = candidateIndex;
          break;
        }
      }

      if (nextIndex === -1) {
        console.log('[FlowAutoSwitch] All accounts have been tried.');
        await setState({
          ...state,
          switching: false,
          allExhausted: true,
          totalAccountsFound: totalAccounts
        });
        chrome.runtime.sendMessage({
          type: 'ACCOUNT_SWITCH_ALL_EXHAUSTED',
          totalAccounts: totalAccounts,
          triedAccounts: triedAccounts
        });
        isExecuting = false;
        return;
      }

      const newTriedAccounts = [...triedAccounts, nextIndex];
      await setState({
        ...state,
        currentAccountIndex: nextIndex,
        triedAccounts: newTriedAccounts,
        totalAccountsFound: totalAccounts,
        switching: true,
        allExhausted: false
      });

      const targetAccount = accountElements[nextIndex];
      console.log('[FlowAutoSwitch] Attempting to click account #' + nextIndex);

      clickElement(targetAccount);
    } catch (e) {
      console.error('[FlowAutoSwitch] Error in run:', e);
    } finally {
      isExecuting = false;
    }
  }

  if (window.location.hostname === 'accounts.google.com' || window.location.hostname.endsWith('.google.com')) {
    run();
    document.addEventListener('DOMContentLoaded', run);
    window.addEventListener('load', run);
    setInterval(run, 1000);
  }
})();