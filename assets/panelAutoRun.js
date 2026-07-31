/* Auto-Run do painel lateral.
   Roda dentro da pagina do side panel (nao e content script) e clica no botao
   "Run" depois de uma troca de conta, quando a fila nao voltou a rodar sozinha. */
(function () {
  "use strict";

  const TAG = "[FlowPanelAutoRun]";
  const SWITCHER_KEY = "flowAccountSwitcher";
  const DEFAULT_DELAY_MS = 45000;   // espera padrao antes de conferir se a fila voltou
  const CLICK_RETRY_MS = 3000;      // reteste quando o botao ainda esta desabilitado
  const CLICK_MAX_RETRIES = 10;

  /* rotulos do botao em todos os idiomas do painel */
  const RUN_LABELS = /^(run|executar|ejecutar|exécuter|démarrer|lancer|starten|ausführen|avvia|esegui|jalankan|patakbuhin|uitvoeren|çalıştır|chạy|실행|実行|运行|เริ่ม|रन|चलाएं|تشغيل|запустить)$/i;

  let lastQueueActivityAt = 0;
  let pendingTimer = null;
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
    const btn = findRunButton();
    if (!btn) {
      console.log(TAG, "Run button not found in the panel");
      return false;
    }
    if (isDisabled(btn)) {
      if (retries++ < CLICK_MAX_RETRIES) {
        console.log(TAG, "Run button is disabled, retrying in " + CLICK_RETRY_MS / 1000 + "s");
        pendingTimer = setTimeout(clickRun, CLICK_RETRY_MS);
      } else {
        console.warn(TAG, "Run button stayed disabled, giving up");
      }
      return false;
    }
    console.log(TAG, "Clicking Run to resume the queue");
    btn.click();
    return true;
  }

  /* So clica se a fila NAO tiver voltado a rodar sozinha: quando o content
     script consegue restaurar os prompts pendentes, ele reenfileira o grupo e
     o painel recebe PROMPT_GROUP_STATUS - nesse caso clicar duplicaria o job. */
  function scheduleAutoRun(delayMs) {
    const delay = typeof delayMs === "number" && delayMs > 0 ? delayMs : DEFAULT_DELAY_MS;
    if (pendingTimer) clearTimeout(pendingTimer);
    retries = 0;
    const armedAt = Date.now();
    console.log(TAG, "Account switch finished - checking in " + Math.round(delay / 1000) + "s whether the queue resumed by itself");
    pendingTimer = setTimeout(function () {
      pendingTimer = null;
      if (lastQueueActivityAt > armedAt) {
        console.log(TAG, "Queue resumed on its own, no need to click Run");
        return;
      }
      clickRun();
    }, delay);
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !msg.type) return;

    if (msg.type === "PROMPT_GROUP_STATUS") {
      const st = msg.data && msg.data.status;
      if (st === "running" || st === "queued") lastQueueActivityAt = Date.now();
      return;
    }

    if (msg.type === "FLOW_SWITCH_COMPLETED") {
      scheduleAutoRun(msg.delayMs);
      return;
    }

    if (msg.type === "FLOW_AUTO_RUN") {
      retries = 0;
      clickRun();
      return;
    }

    /* Rede de seguranca: a pagina do Flow recarregou. Se o estado no storage
       indica que isso veio de uma troca de conta, agenda a conferencia mesmo
       que a mensagem do service worker tenha se perdido. Em recarga normal o
       estado nao tem marca de troca e nada acontece. */
    if (msg.type === "CONTENT_SCRIPT_RESET") {
      try {
        chrome.storage.local.get(SWITCHER_KEY, function (data) {
          const st = data && data[SWITCHER_KEY];
          if (st && (st.justSwitched || st.switching)) scheduleAutoRun();
        });
      } catch (e) {}
    }
  });

  console.log(TAG, "ready");
})();
