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

  const PROGRESS_KEY = "flowAutoRunProgress";
  const PROGRESS_MAX_AGE_MS = 12 * 60 * 60 * 1000;   // progresso mais velho que isso e ignorado

  let progress = null;           // {lastDone, total, updatedAt} - ultima cena gerada E baixada
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

  /* Os dois campos numericos (Start / End) ficam no popover que aparece no
     hover do Run. Estao sempre no DOM (v-show), entao da para ajusta-los mesmo
     com o popover fechado. Em ordem de documento: primeiro Start, depois End. */
  function findRangeInputs(runBtn) {
    let node = runBtn;
    for (let up = 0; up < 4 && node; up++) {
      const inputs = node.querySelectorAll ? node.querySelectorAll('input[type="number"]') : [];
      if (inputs.length === 2) return { start: inputs[0], end: inputs[1] };
      node = node.parentElement;
    }
    return null;
  }

  /* v-model do Vue escuta o evento "input", entao nao basta setar .value */
  function setInputValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* Posiciona o Start na cena seguinte a ultima que foi gerada E baixada.
     Devolve false quando nao ha mais nada a executar. */
  function applyResumePoint(runBtn) {
    if (!progress || !(progress.lastDone > 0)) return true;
    if (Date.now() - (progress.updatedAt || 0) > PROGRESS_MAX_AGE_MS) {
      console.log(TAG, "Saved progress is too old, running the panel range as is");
      return true;
    }

    const range = findRangeInputs(runBtn);
    if (!range) {
      console.warn(TAG, "Start/End fields not found - running the panel range as is");
      return true;
    }

    const total = Number(range.end.getAttribute("max")) || 0;
    if (progress.total && total && progress.total !== total) {
      console.log(TAG, "Prompt list changed (" + progress.total + " -> " + total + "), ignoring saved progress");
      return true;
    }

    const resumeAt = progress.lastDone + 1;
    if (total && resumeAt > total) {
      console.log(TAG, "Scene " + progress.lastDone + " was the last one - nothing left to run");
      return false;
    }
    if (Number(range.start.value) === resumeAt) return true;

    console.log(TAG, "Resuming at scene " + resumeAt + " (scene " + progress.lastDone + " was generated and downloaded)");
    setInputValue(range.start, resumeAt);
    return true;
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

    if (!applyResumePoint(btn)) return;

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

  function readTotalPrompts() {
    const btn = findRunButton();
    if (!btn) return 0;
    const range = findRangeInputs(btn);
    return range ? Number(range.end.getAttribute("max")) || 0 : 0;
  }

  /* Guarda a maior cena que foi gerada E baixada. E dela que a proxima conta
     retoma. Um grupo novo comecando na cena 1 significa que o usuario
     recomecou do zero, entao o progresso anterior e descartado. */
  function recordProgress(data) {
    const results = data && data.results;
    if (!Array.isArray(results) || results.length === 0) return;

    const indices = Array.isArray(data.promptIndices) ? data.promptIndices.filter(function (n) { return typeof n === "number"; }) : [];
    const firstOfGroup = indices.length ? Math.min.apply(null, indices) : 0;
    if (progress && firstOfGroup === 1 && progress.lastDone > 1 && progress.groupId !== data.id) {
      console.log(TAG, "New run starting from scene 1 - discarding saved progress");
      progress = null;
      chrome.storage.local.remove(PROGRESS_KEY);
    }

    let maxDone = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.success && r.downloadComplete && typeof r.promptIndex === "number" && r.promptIndex > maxDone) {
        maxDone = r.promptIndex;
      }
    }
    if (maxDone <= 0) return;
    if (progress && progress.lastDone >= maxDone) return;

    progress = {
      lastDone: maxDone,
      total: readTotalPrompts() || (progress && progress.total) || 0,
      groupId: data.id,
      updatedAt: Date.now()
    };
    try { chrome.storage.local.set({ [PROGRESS_KEY]: progress }); } catch (e) {}
    console.log(TAG, "Scene " + maxDone + " generated and downloaded - next account resumes at " + (maxDone + 1));
  }

  try {
    chrome.storage.local.get(PROGRESS_KEY, function (data) {
      const saved = data && data[PROGRESS_KEY];
      if (saved && saved.lastDone > 0) {
        progress = saved;
        console.log(TAG, "Saved progress: last finished scene is " + saved.lastDone);
      }
    });
  } catch (e) {}

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !msg.type) return;

    if (msg.type === "PROMPT_GROUP_STATUS") {
      const d = msg.data || {};
      if (d.status === "running" || d.status === "queued") lastQueueActivityAt = Date.now();
      recordProgress(d);
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
