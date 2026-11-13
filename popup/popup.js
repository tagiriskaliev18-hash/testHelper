/**
 * Промбез & БИОТ РК — Помощник АО «Интергаз Центральная Азия»
 * Popup Script (Manifest V3 CSP Compliant, zero-inline-scripts)
 */

"use strict";

// Default configuration constants
const DEFAULTS = Object.freeze({
  recognitionEnabled: false,
  markerStyle: "subtle",
  liveAiEnabled: true,
  aiMode: "auto",
  bridgeUrl: "http://127.0.0.1:8765",
  pollinationsEndpoint: "https://text.pollinations.ai/openai",
  apiEndpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  apiModel: "gpt-4o-mini",
  autoScanDynamic: true,
  lastObservation: null
});

// Category mapping for Russian safety test domains
const CATEGORY_MAP = {
  prombez: ["промбез", "гражданск", "188-v", "опо", "авари", "инцидент", "деклараци"],
  biot: ["биот", "трудовой", "тк рк", "несчастн", "акт н-1", "проверк", "обучен", "1019"],
  mg: ["магистральн", "газопровод", "компрессорн", "охранн", "кс", "грс", "давлен"],
  gas_fire: ["газоопасн", "огнев", "наряд-допуск", "загазованност", "сизод", "нкпр"],
  pressure: ["сосуд", "давлен", "манометр", "баллон", "котел", "предохранител"],
  gpm: ["гпм", "кран", "строп", "таль", "подъемн", "грузоподъемн"],
  electro: ["электро", "заземлен", "напряжен", "допуск", "групп", "защит", "шагов"],
  fire: ["пожарн", "огнетушител", "эвакуаци", "сигнализаци", "гидрант"],
  height: ["высот", "лестниц", "пояс", "страховочн", "огражден", "сиз"],
  med: ["первая помощь", "пмп", "реанимаци", "слр", "жгут", "кровотечен", "ожог", "перелом"],
  ica: ["интергаз", "золотые правила", "qazaqgaz", "ица", "остановк", "loto", "пнб", "жизненно важн", "нулев", "уровн"]
};

// State store
let questionsCache = [];
let currentState = { ...DEFAULTS };
let cachedEmptyMonitorHtml = null;

/**
 * Safe chrome.runtime.sendMessage wrapper
 */
async function sendBackgroundMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    console.warn("[Popup] Background message failed:", err.message);
    return null;
  }
}

/**
 * Retrieves settings from chrome.storage.local
 */
async function getStoredSettings() {
  try {
    const data = await chrome.storage.local.get(null);
    return { ...DEFAULTS, ...data };
  } catch (err) {
    console.warn("[Popup] Storage read failed:", err);
    return { ...DEFAULTS };
  }
}

/**
 * Initializes popup UI on DOMContentLoaded
 */
document.addEventListener("DOMContentLoaded", async () => {
  await loadStateAndSyncUI();
  setupTabNavigation();
  setupMainActionHandlers();
  setupMarkerSelectors();
  setupDatabaseTab();
  setupSettingsTab();
  setupStorageListeners();
  await refreshActiveTabTitle();
});

/**
 * Loads current settings and syncs all UI elements
 */
async function loadStateAndSyncUI() {
  currentState = await getStoredSettings();

  // Try to query background for live state if available
  const bgResp = await sendBackgroundMessage({ type: "GET_STATE" });
  if (bgResp && bgResp.state) {
    currentState = { ...currentState, ...bgResp.state };
  }

  updateToggleBtnUI(currentState.recognitionEnabled);
  updateLiveAiQuickBtnUI(currentState.liveAiEnabled !== false);
  updateMarkerPillsUI(currentState.markerStyle);
  updateMonitorUI(currentState.lastObservation);
  populateSettingsFields(currentState);
}

/**
 * Updates quick Live AI pill button in Hero
 */
function updateLiveAiQuickBtnUI(enabled) {
  const btn = document.getElementById("liveAiQuickBtn");
  if (!btn) return;
  btn.classList.toggle("active", !!enabled);
  const span = btn.querySelector("span");
  if (span) {
    span.textContent = enabled ? "Live-ИИ: Вкл" : "Live-ИИ: Выкл";
  }
}

/**
 * Updates hero toggle button visual state
 */
function updateToggleBtnUI(enabled) {
  const btn = document.getElementById("toggleRecognitionBtn");
  const label = document.getElementById("toggleBtnLabel");
  const pill = document.getElementById("recognitionStatusPill");

  if (!btn || !label || !pill) return;

  btn.setAttribute("aria-pressed", enabled ? "true" : "false");

  if (enabled) {
    btn.classList.add("active");
    label.textContent = "Распознавание включено";
    pill.textContent = "Вкл";
    pill.classList.remove("off");
    pill.classList.add("on");
  } else {
    btn.classList.remove("active");
    label.textContent = "Включить распознавание";
    pill.textContent = "Выкл";
    pill.classList.remove("on");
    pill.classList.add("off");
  }
}

/**
 * Updates marker subtlety pills visual selection
 */
function updateMarkerPillsUI(style) {
  const pills = document.querySelectorAll(".marker-pill");
  pills.forEach((p) => {
    const match = p.dataset.style === style;
    p.classList.toggle("active", match);
    p.setAttribute("aria-checked", match ? "true" : "false");
  });
}

/**
 * Refreshes the active browser tab title in the Monitor view
 */
async function refreshActiveTabTitle() {
  const titleEl = document.getElementById("monitorTabTitle");
  if (!titleEl) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.title) {
      titleEl.textContent = tab.title;
      titleEl.setAttribute("title", tab.url || tab.title);
    } else {
      titleEl.textContent = "Страница не определена";
    }
  } catch (err) {
    titleEl.textContent = "Активная страница";
  }
}

/**
 * Setup main buttons (Toggle Recognition & Rescan)
 */
function setupMainActionHandlers() {
  const toggleBtn = document.getElementById("toggleRecognitionBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", async () => {
      const newEnabled = !currentState.recognitionEnabled;
      currentState.recognitionEnabled = newEnabled;
      updateToggleBtnUI(newEnabled);

      await chrome.storage.local.set({ recognitionEnabled: newEnabled });
      await sendBackgroundMessage({
        type: "TOGGLE_RECOGNITION",
        enabled: newEnabled
      });
    });
  }

  const liveAiQuickBtn = document.getElementById("liveAiQuickBtn");
  if (liveAiQuickBtn) {
    liveAiQuickBtn.addEventListener("click", async () => {
      const nextLiveAi = !(currentState.liveAiEnabled !== false);
      currentState.liveAiEnabled = nextLiveAi;
      updateLiveAiQuickBtnUI(nextLiveAi);
      const liveAiEl = document.getElementById("liveAiEnabled");
      if (liveAiEl) liveAiEl.checked = nextLiveAi;

      await chrome.storage.local.set({ liveAiEnabled: nextLiveAi });
      await sendBackgroundMessage({
        type: "UPDATE_SETTINGS",
        settings: { liveAiEnabled: nextLiveAi }
      });
    });
  }

  const rescanBtn = document.getElementById("rescanBtn");
  if (rescanBtn) {
    rescanBtn.addEventListener("click", async () => {
      rescanBtn.disabled = true;
      const originalText = rescanBtn.querySelector("span")?.textContent || "Пересканировать";
      if (rescanBtn.querySelector("span")) {
        rescanBtn.querySelector("span").textContent = "Сканирую...";
      }

      await sendBackgroundMessage({ type: "RESCAN_ACTIVE_TAB" });

      setTimeout(async () => {
        const fresh = await getStoredSettings();
        updateMonitorUI(fresh.lastObservation);
        rescanBtn.disabled = false;
        if (rescanBtn.querySelector("span")) {
          rescanBtn.querySelector("span").textContent = originalText;
        }
      }, 350);
    });
  }
}

/**
 * Setup marker subtlety radio pills
 */
function setupMarkerSelectors() {
  const pills = document.querySelectorAll(".marker-pill");
  pills.forEach((pill) => {
    pill.addEventListener("click", async () => {
      const selectedStyle = pill.dataset.style || "subtle";
      currentState.markerStyle = selectedStyle;
      updateMarkerPillsUI(selectedStyle);

      await chrome.storage.local.set({ markerStyle: selectedStyle });
      await sendBackgroundMessage({
        type: "UPDATE_SETTINGS",
        settings: { markerStyle: selectedStyle }
      });
    });
  });
}

/**
 * Setup tab switching navigation
 */
function setupTabNavigation() {
  const tabButtons = document.querySelectorAll(".tab-btn");
  const panes = document.querySelectorAll(".tab-pane");

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetPaneId = btn.dataset.tab;

      tabButtons.forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-selected", isActive ? "true" : "false");
      });

      panes.forEach((p) => {
        p.classList.toggle("active", p.id === targetPaneId);
      });

      // Lazy load database if switching to DB tab
      if (targetPaneId === "tab-db" && questionsCache.length === 0) {
        loadDatabaseContent();
      }
    });
  });
}

/**
 * Updates Monitor tab with observations sent from content script
 */
function updateMonitorUI(observation) {
  const foundEl = document.getElementById("foundQuestionsCount");
  const highlightedEl = document.getElementById("highlightedAnswersCount");
  const itemsBadge = document.getElementById("monitorItemsBadge");
  const listEl = document.getElementById("detectedQuestionsList");
  const existingEmptyEl = document.getElementById("monitorEmptyState");

  if (existingEmptyEl && !cachedEmptyMonitorHtml) {
    cachedEmptyMonitorHtml = existingEmptyEl.outerHTML;
  }

  if (!foundEl || !highlightedEl || !listEl) return;

  const rawItems = Array.isArray(observation?.items)
    ? observation.items
    : (Array.isArray(observation?.questions) ? observation.questions : []);

  if (rawItems.length === 0) {
    foundEl.textContent = "0";
    highlightedEl.textContent = "0";
    if (itemsBadge) itemsBadge.textContent = "0";
    if (cachedEmptyMonitorHtml) {
      listEl.innerHTML = cachedEmptyMonitorHtml;
    } else {
      listEl.innerHTML = "";
    }
    return;
  }

  const count = rawItems.length;
  let matchedCount = 0;

  listEl.innerHTML = "";

  rawItems.forEach((q) => {
    const qText = q.question || q.questionText || "Вопрос без текста";
    const ansList = Array.isArray(q.matchedOptionTexts) && q.matchedOptionTexts.length > 0
      ? q.matchedOptionTexts
      : (Array.isArray(q.matchedAnswers) && q.matchedAnswers.length > 0
        ? q.matchedAnswers
        : (q.matchedAnswer ? [q.matchedAnswer] : []));
    const isMatched = Boolean(q.matched || ansList.length > 0);
    if (isMatched) {
      matchedCount++;
    }

    const card = document.createElement("div");
    card.className = "detected-card";

    const titleEl = document.createElement("div");
    titleEl.className = "detected-q-text";
    titleEl.textContent = qText;
    card.appendChild(titleEl);

    // Answer box
    let ansText = "Ответ не найден в локальной базе";
    let boxClass = "detected-ans-box";
    if (ansList.length > 0) {
      ansText = ansList.join("; ");
    } else if (q.aiStatus === "pending") {
      ansText = "Live-ИИ анализирует вопрос...";
      boxClass += " pending";
    } else if (q.aiStatus === "error") {
      ansText = q.aiError || "Live-ИИ временно недоступен";
      boxClass += " error";
    } else if (currentState.liveAiEnabled !== false) {
      ansText = "Ожидает анализа Live-ИИ...";
      boxClass += " pending";
    }

    const ansBox = document.createElement("div");
    ansBox.className = boxClass;
    ansBox.innerHTML = `
      <svg class="ans-check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="${isMatched ? "20 6 9 17 4 12" : (q.aiStatus === "pending" ? "12 6 12 12 16 14" : "18 6 6 18")}"/>
      </svg>
      <span class="detected-ans-text">${escapeHtml(ansText)}</span>
    `;
    card.appendChild(ansBox);

    // Metadata row
    const metaRow = document.createElement("div");
    metaRow.className = "detected-meta-row";

    const isLiveAiSource =
      q.source === "live-ai-bridge" ||
      q.source === "live-ai-api" ||
      q.source === "live-ai-cloud" ||
      q.source === "live-ai" ||
      q.source === "session-cache" ||
      q.source === "local-cache";

    const sourceTag = document.createElement("span");
    sourceTag.className = "tag-source";
    if (isLiveAiSource) {
      sourceTag.textContent = q.consensus || "Live ИИ";
    } else if (isMatched) {
      sourceTag.textContent = `База (${q.consensus || "5/5"})`;
    } else if (q.aiStatus === "pending") {
      sourceTag.textContent = "Live ИИ ⏳";
    } else if (q.aiStatus === "error") {
      sourceTag.textContent = "Ошибка ИИ";
    } else {
      sourceTag.textContent = "Нет в базе";
    }

    const confTag = document.createElement("span");
    confTag.className = "tag-confidence";
    if (isMatched && typeof q.confidence === "number") {
      confTag.textContent = `${Math.round(q.confidence * 100)}% точность`;
    } else if (q.aiStatus === "pending") {
      confTag.textContent = "Запрос к ИИ";
    } else if (q.aiStatus === "error") {
      confTag.textContent = "Автоповтор через ~15с";
    } else {
      confTag.textContent = isMatched ? "Подтверждено" : (currentState.liveAiEnabled === false ? "Live-ИИ выкл" : "В очереди");
    }

    const npaTag = document.createElement("span");
    npaTag.className = "tag-npa";
    npaTag.textContent = q.npaRef || (isMatched ? "НПА РК / Стандарты ИЦА" : "");
    npaTag.setAttribute("title", q.npaRef || "");

    metaRow.appendChild(sourceTag);
    metaRow.appendChild(confTag);
    metaRow.appendChild(npaTag);
    card.appendChild(metaRow);

    listEl.appendChild(card);
  });

  foundEl.textContent = String(observation?.detectedCount ?? count);
  highlightedEl.textContent = String(observation?.matchedCount ?? observation?.answersMatched ?? matchedCount);
  if (itemsBadge) itemsBadge.textContent = String(count);
}

/**
 * Escapes HTML characters for safe text insertion
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Loads database questions from data/questions_db.json or bundled modules
 */
async function loadDatabaseContent() {
  const statsEl = document.getElementById("dbResultsStats");
  if (statsEl) statsEl.textContent = "Загрузка проверенной базы...";

  try {
    // 1. Try questions_db.json first
    let res = await fetch(chrome.runtime.getURL("data/questions_db.json"));
    if (res.ok) {
      const dbData = await res.json();
      questionsCache = Array.isArray(dbData) ? dbData : (dbData.questions || []);
    } else {
      // 2. Try loading individual modules in data/modules/
      const modules = [
        "data/modules/m01_zakon_gz.json",
        "data/modules/m02_biot_tk.json",
        "data/modules/m03_biot_edu.json",
        "data/modules/m04_prombez_mg.json",
        "data/modules/m05_gas_fire_works.json",
        "data/modules/m06_vessels_pressure.json",
        "data/modules/m07_gpm_cranes.json",
        "data/modules/m08_electrical_safety.json",
        "data/modules/m09_fire_gas_supply.json",
        "data/modules/m10_height_firstaid_ica.json"
      ];
      let collected = [];
      for (const m of modules) {
        try {
          const mRes = await fetch(chrome.runtime.getURL(m));
          if (mRes.ok) {
            const mData = await mRes.json();
            const list = Array.isArray(mData) ? mData : (mData.questions || []);
            collected = collected.concat(list);
          }
        } catch (_) {}
      }
      if (collected.length > 0) {
        questionsCache = collected;
      }
    }

    const totalEl = document.getElementById("dbTotalQuestionsCount");
    if (totalEl) {
      totalEl.textContent = `${questionsCache.length} вопросов верифицировано`;
    }

    // Try reading verification report for consensus details
    try {
      const repRes = await fetch(chrome.runtime.getURL("data/verification_report.json"));
      if (repRes.ok) {
        const report = await repRes.json();
        const total = report.total_questions || report.totalQuestions || questionsCache.length;
        if (totalEl) {
          totalEl.textContent = `${total} вопросов верифицировано`;
        }
      }
    } catch (_) {}

    renderDatabaseResults();
  } catch (err) {
    console.warn("[Popup] Could not fetch questions DB:", err);
    if (statsEl) statsEl.textContent = "Не удалось загрузить базу вопросов";
  }
}

/**
 * Renders filtered question cards in the DB tab
 */
function renderDatabaseResults() {
  const listEl = document.getElementById("dbResultsList");
  const statsEl = document.getElementById("dbResultsStats");
  const searchInput = document.getElementById("dbSearchInput");
  const categorySelect = document.getElementById("dbCategorySelect");

  if (!listEl) return;

  const query = (searchInput?.value || "").trim().toLowerCase();
  const category = categorySelect?.value || "all";

  let filtered = questionsCache;

  // Filter by category keywords
  if (category !== "all" && CATEGORY_MAP[category]) {
    const kws = CATEGORY_MAP[category];
    filtered = filtered.filter((q) => {
      const textToScan = `${q.question || ""} ${q.category || ""} ${q.npaRef || ""} ${q.tag || ""}`.toLowerCase();
      return kws.some((kw) => textToScan.includes(kw));
    });
  }

  // Filter by search text
  if (query) {
    filtered = filtered.filter((q) => {
      const qText = (q.question || "").toLowerCase();
      const ansText = (q.correctAnswer || (q.options ? q.options.join(" ") : "")).toLowerCase();
      const npaText = (q.npaRef || "").toLowerCase();
      return qText.includes(query) || ansText.includes(query) || npaText.includes(query);
    });
  }

  if (statsEl) {
    statsEl.textContent = `Показано ${filtered.length} из ${questionsCache.length} вопросов`;
  }

  listEl.innerHTML = "";

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <p class="empty-title">Вопросы не найдены</p>
      <p class="empty-desc">Попробуйте изменить поисковый запрос или выбрать другую категорию тестов.</p>
    `;
    listEl.appendChild(empty);
    return;
  }

  // Render cards (limit to first 60 for snappy DOM rendering)
  const toRender = filtered.slice(0, 60);

  toRender.forEach((item) => {
    const card = document.createElement("div");
    card.className = "db-card";

    // Header with category & verified badge
    const header = document.createElement("div");
    header.className = "db-card-header";

    const catTag = document.createElement("span");
    catTag.className = "db-category-tag";
    catTag.textContent = item.category || "Промбез & БиОТ";

    const verBadge = document.createElement("span");
    verBadge.className = "db-verified-pill";
    const consensusLabel = item.consensus || "5/5 НПА РК";
    verBadge.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      ${escapeHtml(consensusLabel)}
    `;

    header.appendChild(catTag);
    header.appendChild(verBadge);
    card.appendChild(header);

    // Question text
    const qEl = document.createElement("div");
    qEl.className = "db-q-text";
    qEl.textContent = item.question || "Текст вопроса";
    card.appendChild(qEl);

    // Correct Answer box
    const ansBox = document.createElement("div");
    ansBox.className = "db-ans-box";
    const answerStr = item.correctAnswer || (Array.isArray(item.options) && typeof item.correctIndex === "number" ? item.options[item.correctIndex] : "");
    ansBox.innerHTML = `
      <span class="db-ans-label">Ответ:</span>
      <span class="db-ans-text">${escapeHtml(answerStr || "Верифицированный ответ")}</span>
    `;
    card.appendChild(ansBox);

    // Citation
    if (item.npaRef) {
      const cite = document.createElement("div");
      cite.className = "db-citation";
      cite.textContent = item.npaRef;
      card.appendChild(cite);
    }

    listEl.appendChild(card);
  });
}

/**
 * Setup search and filter inputs for Database tab
 */
function setupDatabaseTab() {
  const searchInput = document.getElementById("dbSearchInput");
  const clearBtn = document.getElementById("dbClearSearchBtn");
  const categorySelect = document.getElementById("dbCategorySelect");

  if (searchInput) {
    let debounceTimer = null;
    searchInput.addEventListener("input", () => {
      if (clearBtn) {
        clearBtn.style.display = searchInput.value ? "block" : "none";
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        renderDatabaseResults();
      }, 150);
    });
  }

  if (clearBtn && searchInput) {
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      clearBtn.style.display = "none";
      renderDatabaseResults();
    });
  }

  if (categorySelect) {
    categorySelect.addEventListener("change", () => {
      renderDatabaseResults();
    });
  }
}

/**
 * Populate settings fields from current state
 */
function populateSettingsFields(settings) {
  const liveAiEl = document.getElementById("liveAiEnabled");
  const autoScanEl = document.getElementById("autoScanDynamic");
  const aiModeEl = document.getElementById("aiModeSelect");
  const bridgeUrlEl = document.getElementById("bridgeUrlInput");
  const apiEndpointEl = document.getElementById("apiEndpointInput");
  const apiModelEl = document.getElementById("apiModelInput");
  const apiKeyEl = document.getElementById("apiKeyInput");

  if (liveAiEl) liveAiEl.checked = settings.liveAiEnabled !== false;
  if (autoScanEl) autoScanEl.checked = settings.autoScanDynamic !== false;
  if (aiModeEl) aiModeEl.value = settings.aiMode || "auto";
  if (bridgeUrlEl) bridgeUrlEl.value = settings.bridgeUrl || DEFAULTS.bridgeUrl;
  if (apiEndpointEl) apiEndpointEl.value = settings.apiEndpoint || DEFAULTS.apiEndpoint;
  if (apiModelEl) apiModelEl.value = settings.apiModel || DEFAULTS.apiModel;
  if (apiKeyEl) apiKeyEl.value = settings.apiKey || "";

  syncAiFieldsVisibility(settings.aiMode || "auto");
}

/**
 * Toggles visibility of bridge vs remote API input fields
 */
function syncAiFieldsVisibility(mode) {
  const bridgeGroup = document.getElementById("bridgeUrlGroup");
  const apiGroup = document.getElementById("apiFieldsGroup");

  if (mode === "bridge" || mode === "auto") {
    if (bridgeGroup) bridgeGroup.style.display = "flex";
    if (apiGroup) apiGroup.style.display = "none";
  } else if (mode === "pollinations") {
    if (bridgeGroup) bridgeGroup.style.display = "none";
    if (apiGroup) apiGroup.style.display = "none";
  } else {
    if (bridgeGroup) bridgeGroup.style.display = "none";
    if (apiGroup) apiGroup.style.display = "block";
  }
}

/**
 * Shows temporary feedback message in settings status alert
 */
function showSettingsStatus(type, message) {
  const el = document.getElementById("settingsStatus");
  if (!el) return;

  el.className = `status-alert ${type}`;
  el.textContent = message;
  el.style.display = "block";

  if (type === "success") {
    setTimeout(() => {
      if (el.className.includes("success")) {
        el.style.display = "none";
      }
    }, 4000);
  }
}

/**
 * Setup settings form actions (Save & Test Connection)
 */
function setupSettingsTab() {
  const form = document.getElementById("settingsForm");
  if (form) {
    form.addEventListener("submit", (e) => e.preventDefault());
  }

  const aiModeEl = document.getElementById("aiModeSelect");
  if (aiModeEl) {
    aiModeEl.addEventListener("change", () => {
      syncAiFieldsVisibility(aiModeEl.value);
      const endpointEl = document.getElementById("apiEndpointInput");
      const modelEl = document.getElementById("apiModelInput");
      if (aiModeEl.value === "gemini") {
        if (endpointEl && (!endpointEl.value || endpointEl.value.includes("api.openai.com"))) {
          endpointEl.value = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
        }
        if (modelEl && (!modelEl.value || modelEl.value === "gpt-4o-mini")) {
          modelEl.value = "gemini-2.5-flash";
        }
      } else if (aiModeEl.value === "openai") {
        if (endpointEl && (!endpointEl.value || endpointEl.value.includes("generativelanguage.googleapis.com"))) {
          endpointEl.value = DEFAULTS.apiEndpoint;
        }
        if (modelEl && (!modelEl.value || modelEl.value.startsWith("gemini"))) {
          modelEl.value = DEFAULTS.apiModel;
        }
      }
    });
  }

  // Toggle password visibility
  const toggleKeyBtn = document.getElementById("toggleKeyVisibilityBtn");
  const apiKeyEl = document.getElementById("apiKeyInput");
  if (toggleKeyBtn && apiKeyEl) {
    toggleKeyBtn.addEventListener("click", () => {
      apiKeyEl.type = apiKeyEl.type === "password" ? "text" : "password";
    });
  }

  // Save Settings Button
  const saveBtn = document.getElementById("saveSettingsBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const newSettings = {
        liveAiEnabled: document.getElementById("liveAiEnabled")?.checked !== false,
        autoScanDynamic: document.getElementById("autoScanDynamic")?.checked !== false,
        aiMode: document.getElementById("aiModeSelect")?.value || "auto",
        bridgeUrl: document.getElementById("bridgeUrlInput")?.value.trim() || DEFAULTS.bridgeUrl,
        apiEndpoint: document.getElementById("apiEndpointInput")?.value.trim() || DEFAULTS.apiEndpoint,
        apiModel: document.getElementById("apiModelInput")?.value.trim() || DEFAULTS.apiModel,
        apiKey: document.getElementById("apiKeyInput")?.value.trim() || ""
      };

      currentState = { ...currentState, ...newSettings };
      updateLiveAiQuickBtnUI(newSettings.liveAiEnabled);
      await chrome.storage.local.set(newSettings);
      await sendBackgroundMessage({
        type: "UPDATE_SETTINGS",
        settings: newSettings
      });

      showSettingsStatus("success", "Настройки успешно сохранены!");
    });
  }

  // Test Connection Button
  const testBtn = document.getElementById("testConnectionBtn");
  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      const mode = document.getElementById("aiModeSelect")?.value || "auto";
      showSettingsStatus("loading", "Проверка каналов Live-ИИ...");

      if (mode === "auto" || mode === "bridge") {
        const url = (document.getElementById("bridgeUrlInput")?.value.trim() || DEFAULTS.bridgeUrl).replace(/\/+$/, "") + "/health";
        let bridgeOkMsg = "";
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3000);
          const resp = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (resp.ok) {
            const data = await resp.json();
            const extras = [
              data.claude_cli ? "Claude" : "",
              data.ollama_model ? `Ollama: ${data.ollama_model}` : ""
            ].filter(Boolean).join(", ");
            bridgeOkMsg = `Мост активен (${data.db_questions_loaded ?? questionsCache.length} в БД${extras ? `, ${extras}` : ""})`;
          }
        } catch (_) {}

        if (mode === "bridge") {
          if (bridgeOkMsg) {
            showSettingsStatus("success", bridgeOkMsg);
          } else {
            showSettingsStatus("error", "Локальный мост не запущен (127.0.0.1:8765). В режиме «Авто» работает встроенный облачный ИИ!");
          }
          return;
        }

        // In "auto" mode also verify cloud fallback
        let cloudOk = false;
        try {
          const cCtrl = new AbortController();
          const cTimer = setTimeout(() => cCtrl.abort(), 7000);
          const cResp = await fetch(DEFAULTS.pollinationsEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "openai-fast", messages: [{ role: "user", content: "OK" }], max_tokens: 3 }),
            signal: cCtrl.signal
          });
          clearTimeout(cTimer);
          cloudOk = cResp.ok;
        } catch (_) {}

        if (bridgeOkMsg && cloudOk) {
          showSettingsStatus("success", `${bridgeOkMsg} + Облачный ИИ активен!`);
        } else if (bridgeOkMsg) {
          showSettingsStatus("success", `${bridgeOkMsg} (облако недоступно, работает локально)`);
        } else if (cloudOk) {
          showSettingsStatus("success", "Встроенный облачный Live-ИИ активен! (мост не запущен, но расширение работает автономно)");
        } else {
          showSettingsStatus("error", "Ни локальный мост, ни облачный ИИ не отвечают. Проверьте интернет или запустите Start-Bridge.bat.");
        }
      } else if (mode === "pollinations") {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const resp = await fetch(DEFAULTS.pollinationsEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "openai-fast", messages: [{ role: "user", content: "OK" }], max_tokens: 3 }),
            signal: controller.signal
          });
          clearTimeout(timer);
          if (resp.ok) {
            showSettingsStatus("success", "Облачный Live-ИИ (Pollinations GPT-OSS-20B) отвечает!");
          } else {
            showSettingsStatus("error", `Облачный ИИ вернул HTTP ${resp.status}`);
          }
        } catch (err) {
          showSettingsStatus("error", `Ошибка облачного ИИ: ${err.message}`);
        }
      } else {
        // Test remote OpenAI/Gemini API endpoint
        const endpoint = document.getElementById("apiEndpointInput")?.value.trim() || "";
        const key = document.getElementById("apiKeyInput")?.value.trim() || "";

        if (!key) {
          showSettingsStatus("error", "Введите API-ключ перед проверкой!");
          return;
        }

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`
            },
            body: JSON.stringify({
              model: document.getElementById("apiModelInput")?.value.trim() || "gpt-4o-mini",
              messages: [{ role: "user", content: "ping" }],
              max_tokens: 1
            }),
            signal: controller.signal
          });
          clearTimeout(timer);

          if (resp.ok) {
            showSettingsStatus("success", "Соединение с AI API успешно установлено!");
          } else {
            showSettingsStatus("error", `API вернул HTTP ${resp.status}`);
          }
        } catch (err) {
          showSettingsStatus("error", `Ошибка сети при обращении к API: ${err.message}`);
        }
      }
    });
  }
}

/**
 * Listens for live changes from background/content script
 */
function setupStorageListeners() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.recognitionEnabled) {
      currentState.recognitionEnabled = changes.recognitionEnabled.newValue;
      updateToggleBtnUI(currentState.recognitionEnabled);
    }
    if (changes.liveAiEnabled) {
      currentState.liveAiEnabled = changes.liveAiEnabled.newValue;
      updateLiveAiQuickBtnUI(currentState.liveAiEnabled !== false);
      const liveAiEl = document.getElementById("liveAiEnabled");
      if (liveAiEl) liveAiEl.checked = currentState.liveAiEnabled !== false;
    }
    if (changes.markerStyle) {
      currentState.markerStyle = changes.markerStyle.newValue;
      updateMarkerPillsUI(currentState.markerStyle);
    }
    if (changes.lastObservation) {
      currentState.lastObservation = changes.lastObservation.newValue;
      updateMonitorUI(currentState.lastObservation);
    }
  });
}
