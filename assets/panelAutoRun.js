/* Auto-Run do painel lateral.
   Roda dentro da pagina do side panel (nao e content script, por isso alcanca
   o DOM do painel) e clica no botao "Run" quando a pagina do Flow (re)carrega
   e a fila nao voltou a rodar sozinha. */
(function () {
  "use strict";

  const TAG = "[FlowPanelAutoRun]";

  /* Ajustes rapidos */
  const AUTO_RUN_ON_PAGE_LOAD = true;   // false = so clica apos troca de conta
  const SETTLE_MS = 20000;              // espera apos o load antes de decidir
  const CLICK_COOLDOWN_MS = 30000;      // intervalo minimo entre dois cliques
  const CLICK_RETRY_MS = 3000;          // reteste enquanto o botao esta desabilitado
  const CLICK_MAX_RETRIES = 10;
  const MAX_CLICKS_WITHOUT_PROGRESS = 3;

  /* rotulos do botao em todos os idiomas do painel */
  const RUN_LABELS = /^(run|executar|ejecutar|exécuter|démarrer|lancer|starten|ausführen|avvia|esegui|jalankan|patakbuhin|uitvoeren|çalıştır|chạy|실행|実行|运行|เริ่ม|रन|चलाएं|تشغيل|запустить)$/i;

  let epochStartedAt = 0;        // quando a tela atual "chegou"
  let clickedInEpoch = false;    // no maximo um clique automatico por chegada
  let lastQueueActivityAt = 0;   // ultimo PROMPT_GROUP_STATUS ativo
  let lastClickAt = 0;
  let clicksWithoutProgress = 0;
  let settleTimer = null;
  let retryTimer = null;
  let retries = 0;

  function norm(t) {
    return (t || "").replace(/\s+/g, " ").trim();
  }

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    const cls = el.className || "";
    return typeof cls === "string" && /(^|\s)(p-disabled|p-button-loading)(\s|$)/.test(cls);
  }

  function findRunButton() {
    const buttons = document.querySelectorAll("button");
    for (let i = 0; i < buttons.length; i++) {
      const el = buttons[i];
      if (!el.offsetWidth && !el.offsetHeight) continue;   // aba escondida
      if (!RUN_LABELS.test(norm(el.innerText || el.textContent))) continue;
      return el;
    }
    return null;
  }

  function clickRun() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

    const btn = findRunButton();
    if (!btn) {
      console.log(TAG, "Run button not found in the panel");
      return;
    }
    if (isDisabled(btn)) {
      if (retries++ < CLICK_MAX_RETRIES) {
        console.log(TAG, "Run is disabled, retrying in " + CLICK_RETRY_MS / 1000 + "s");
        retryTimer = setTimeout(clickRun, CLICK_RETRY_MS);
      } else {
        console.warn(TAG, "Run stayed disabled, giving up for this page load");
      }
      return;
    }

    lastClickAt = Date.now();
    clickedInEpoch = true;
    clicksWithoutProgress++;
    console.log(TAG, "Clicking Run (attempt " + clicksWithoutProgress + " without queue progress)");
    btn.click();
  }

  /* Chamado quando a tela do Flow (re)carrega ou uma troca de conta termina. */
  function startEpoch(reason, settleMs) {
    if (!AUTO_RUN_ON_PAGE_LOAD && reason !== "account switch") return;

    if (clicksWithoutProgress >= MAX_CLICKS_WITHOUT_PROGRESS) {
      console.warn(TAG, "Already clicked Run " + clicksWithoutProgress + "x without the queue making progress - not clicking again until something runs");
      return;
    }

    epochStartedAt = Date.now();
    clickedInEpoch = false;
    retries = 0;
    const wait = typeof settleMs === "number" && settleMs > 0 ? settleMs : SETTLE_MS;

    if (settleTimer) clearTimeout(settleTimer);
    console.log(TAG, "Flow page ready (" + reason + ") - checking in " + Math.round(wait / 1000) + "s whether the queue resumed by itself");

    settleTimer = setTimeout(function () {
      settleTimer = null;
      if (clickedInEpoch) return;

      /* a fila voltou sozinha (o content script restaurou os pendentes) */
      if (lastQueueActivityAt > epochStartedAt) {
        console.log(TAG, "Queue resumed on its own, no need to click Run");
        return;
      }
      if (Date.now() - lastClickAt < CLICK_COOLDOWN_MS) {
        console.log(TAG, "Skipping: Run was clicked less than " + CLICK_COOLDOWN_MS / 1000 + "s ago");
        return;
      }
      clickRun();
    }, wait);
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !msg.type) return;

    if (msg.type === "PROMPT_GROUP_STATUS") {
      const d = msg.data || {};
      if (d.status === "running" || d.status === "queued") lastQueueActivityAt = Date.now();
      /* progresso de verdade: algum prompt foi processado */
      if (d.processedCount > 0 && clicksWithoutProgress > 0) {
        console.log(TAG, "Queue is making progress, auto-run counter reset");
        clicksWithoutProgress = 0;
      }
      return;
    }

    /* troca de conta concluida: o service worker avisa e manda quanto esperar */
    if (msg.type === "FLOW_SWITCH_COMPLETED") {
      startEpoch("account switch", msg.delayMs);
      return;
    }

    /* clique imediato, sob demanda */
    if (msg.type === "FLOW_AUTO_RUN") {
      retries = 0;
      clickRun();
      return;
    }

    /* o content script recarregou na pagina do Flow */
    if (msg.type === "CONTENT_SCRIPT_RESET") {
      startEpoch("content script reload");
    }
  });

  /* Sinal independente do content script e do service worker: a propria aba do
     Flow terminou de carregar. Cobre o caso de a mensagem acima se perder. */
  try {
    if (chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (changeInfo.status !== "complete") return;
        const url = (tab && tab.url) || "";
        if (url.indexOf("labs.google") === -1) return;
        startEpoch("tab load");
      });
    }
  } catch (e) {}

  console.log(TAG, "ready - auto-run on page load is " + (AUTO_RUN_ON_PAGE_LOAD ? "ON" : "OFF"));
})();
