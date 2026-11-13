/**
 * Service Worker (Manifest V3)
 * Промбез и БИОТ РК — Помощник ИЦА
 */

const DEFAULT_SETTINGS = Object.freeze({
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
  migration_v101_liveai: true,
  lastObservation: null
});

/**
 * Returns current settings merged with defaults from chrome.storage.local
 */
async function getStoredSettings() {
  try {
    const data = await chrome.storage.local.get(null);
    // One-time upgrade from v1.0.0 so Live AI is permanently active by default
    if (data.migration_v101_liveai !== true) {
      const upgraded = {
        liveAiEnabled: true,
        aiMode: "auto",
        pollinationsEndpoint: DEFAULT_SETTINGS.pollinationsEndpoint,
        migration_v101_liveai: true
      };
      await chrome.storage.local.set(upgraded);
      return { ...DEFAULT_SETTINGS, ...data, ...upgraded };
    }
    return { ...DEFAULT_SETTINGS, ...data };
  } catch (err) {
    console.error("[SW] Error reading storage:", err);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Updates extension action badge based on recognition state
 */
async function syncBadge(enabled) {
  try {
    const text = enabled ? "ON" : "";
    await chrome.action.setBadgeText({ text });
    if (enabled) {
      await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
    }
  } catch (err) {
    console.warn("[SW] Failed to sync badge:", err);
  }
}

/**
 * Injects content scripts into a tab if not already present
 */
async function ensureContentScriptsInjected(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["content/content.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [
        "content/matcher.js",
        "content/dom-scanner.js",
        "content/content.js"
      ]
    });
    return true;
  } catch (err) {
    console.warn(`[SW] Could not inject content scripts into tab ${tabId}:`, err.message);
    return false;
  }
}

function isInjectableUrl(url) {
  return typeof url === "string" && /^(https?|file):\/\//i.test(url);
}

/**
 * Sends a message to a specific tab, attempting script injection if needed
 */
async function sendMessageToTab(tabId, message, allowInject = true) {
  if (!tabId) return { success: false, reason: "Missing tabId" };

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !isInjectableUrl(tab.url)) {
      return { success: false, reason: "Restricted or non-injectable tab" };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return { success: true, response, tabId };
  } catch (sendErr) {
    if (!allowInject) {
      return { success: false, error: sendErr.message, tabId };
    }
    const injected = await ensureContentScriptsInjected(tabId);
    if (injected) {
      await new Promise((resolve) => setTimeout(resolve, 90));
      try {
        const retryResponse = await chrome.tabs.sendMessage(tabId, message);
        return { success: true, response: retryResponse, tabId };
      } catch (retryErr) {
        return { success: false, error: retryErr.message, tabId };
      }
    }
    return { success: false, error: sendErr.message, tabId };
  }
}

/**
 * Pushes current recognition settings cleanly to a given tab
 */
async function syncTabState(tabId, stateOverride = null) {
  const settings = stateOverride || (await getStoredSettings());
  return sendMessageToTab(
    tabId,
    {
      type: "SET_RECOGNITION_STATE",
      enabled: Boolean(settings.recognitionEnabled),
      markerStyle: settings.markerStyle || "subtle",
      liveAiEnabled: settings.liveAiEnabled !== false,
      autoScanDynamic: settings.autoScanDynamic !== false
    },
    Boolean(settings.recognitionEnabled)
  );
}

/**
 * Syncs recognition settings across all currently open web/file tabs
 */
async function syncAllOpenTabs(stateOverride = null, excludeTabId = null) {
  const settings = stateOverride || (await getStoredSettings());
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id || t.id === excludeTabId || !isInjectableUrl(t.url)) continue;
      syncTabState(t.id, settings).catch(() => {});
    }
  } catch (_) {}
}

/**
 * Sends a message to the active tab, attempting script injection if disconnected
 */
async function sendMessageToActiveTab(message) {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.id || !isInjectableUrl(activeTab.url)) {
      return { success: false, reason: "No accessible active tab" };
    }
    return sendMessageToTab(activeTab.id, message, true);
  } catch (err) {
    console.error("[SW] sendMessageToActiveTab error:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Simple deterministic string hash for cache keys
 */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return "h_" + Math.abs(hash).toString(36);
}

/**
 * Extracts JSON object cleanly from LLM response text (strips <think> and markdown fences)
 */
function extractJsonFromLlmText(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const cleaned = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/gim, "")
    .replace(/```$/gim, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const match =
    cleaned.match(/\{[\s\S]*?"matchedOptionIndic(?:es|ex)"[\s\S]*?\}/) ||
    cleaned.match(/\{[\s\S]*?"matchedOptionIndex"[\s\S]*?\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (_) {}
  }
  return null;
}

/**
 * Normalizes LLM answer choice(s) and cross-checks matchedOptionText
 */
function normalizeLlmChoice(parsed, options, sourceTag, consensusLabel) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(options) || options.length === 0) {
    return null;
  }

  const indices = [];
  if (Array.isArray(parsed.matchedOptionIndices)) {
    for (const raw of parsed.matchedOptionIndices) {
      const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      if (Number.isInteger(n) && n >= 0 && n < options.length && !indices.includes(n)) {
        indices.push(n);
      }
    }
  }

  let idx = typeof parsed.matchedOptionIndex === "number"
    ? parsed.matchedOptionIndex
    : (typeof parsed.matchedOptionIndex === "string" ? parseInt(parsed.matchedOptionIndex, 10) : -1);

  const declaredText = String(parsed.matchedOptionText || "").trim().toLowerCase();
  if (declaredText) {
    const exactMatchIdx = options.findIndex((o) => String(o).trim().toLowerCase() === declaredText);
    if (exactMatchIdx >= 0) idx = exactMatchIdx;
  }

  if (Number.isInteger(idx) && idx >= 0 && idx < options.length && !indices.includes(idx)) {
    indices.unshift(idx);
  }

  if (indices.length === 0) {
    return null;
  }

  const primaryIdx = indices[0];
  const rawConf = typeof parsed.confidence === "number" ? parsed.confidence : 0.88;
  return {
    matchedOptionIndex: primaryIdx,
    matchedOptionIndices: indices,
    matchedOptionText: indices.map((i) => options[i]).join("; "),
    confidence: Math.round(Math.max(0.55, Math.min(0.99, rawConf)) * 100) / 100,
    consensus: consensusLabel,
    npaRef: String(parsed.npaRef || "Законодательство РК"),
    explanation: String(parsed.explanation || ""),
    source: sourceTag
  };
}

const RF_PAGE_RE = /(?:^|[^а-яa-z0-9])(пб\s*115(?:\.\d+)?|116[\s-]*фз|99[\s-]*фз|225[\s-]*фз|322[\s-]*фз|ростехнадзор[а-я]*|фнп|гк\s+рф|градостроительн[а-я]*\s+кодекс[а-я]*\s+рф|коап\s+рф|пп\s+рф|минтруд[а-я]*\s+рф|мчс\s+россии|российск[а-я]*\s+федерац[а-я]*|федеральн[а-я]*\s+(?:государственн[а-я]*\s+строительн|закон[а-я]*\s+от)|tests24|тесты\s*24|olimpoks|олимпокс|рубл(?:ей|я|ь)|[аб]\.\d+(?:\.\d+)?\s*\(\s*пб)(?![а-яa-z0-9])/i;
const RK_PAGE_RE = /(?:^|[^а-яa-z0-9])(188[\s-]*v|202[\s-]*v|закон[а-я]*\s+рк|тк\s+рк|коап\s+рк|мчс\s+рк|мтсзн\s+рк|республик[а-я]*\s+казахстан[а-я]*|bilim\.qg\.kz|qazaqgaz|интергаз|тенге|казахстан[а-я]*|(?<![а-яa-z0-9])рк)(?![а-яa-z0-9])/i;

function resolveJurisdiction({ pageTitle = "", pageUrl = "", question = "", options = [], jurisdiction = "" } = {}) {
  if (jurisdiction === "RF" || jurisdiction === "RK") return jurisdiction;
  const titleUrl = `${pageTitle} ${pageUrl}`.toLowerCase().replace(/ё/g, "е");
  const qOpts = `${question} ${(options || []).join(" ")}`.toLowerCase().replace(/ё/g, "е");
  if (RF_PAGE_RE.test(titleUrl) && !RK_PAGE_RE.test(titleUrl)) return "RF";
  if (RK_PAGE_RE.test(titleUrl) && !RF_PAGE_RE.test(titleUrl)) return "RK";
  if (RF_PAGE_RE.test(qOpts) && !RK_PAGE_RE.test(qOpts)) return "RF";
  return "RK";
}

/**
 * Queries Local Multi-Model Bridge Server (127.0.0.1:8765)
 */
async function queryBridge(bridgeUrl, question, options, pageTitle, pageUrl = "", isMultiChoice = false, jurisdiction = "") {
  const url = `${(bridgeUrl || DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/, "")}/solve`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        options,
        pageTitle,
        pageUrl,
        isMultiChoice: Boolean(isMultiChoice),
        jurisdiction: jurisdiction || undefined
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      throw new Error(`Bridge HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const indices = Array.isArray(data.matchedOptionIndices)
      ? data.matchedOptionIndices.filter((n) => Number.isInteger(n) && n >= 0 && n < options.length)
      : [];
    const primaryIdx = indices.length > 0 ? indices[0] : data.matchedOptionIndex;

    if (typeof primaryIdx !== "number" || primaryIdx < 0 || primaryIdx >= options.length) {
      throw new Error(data.error || "Мост не вернул подходящий индекс ответа");
    }
    return {
      matchedOptionIndex: primaryIdx,
      matchedOptionIndices: indices.length > 0 ? indices : [primaryIdx],
      matchedOptionText: data.matchedOptionText || options[primaryIdx] || "",
      confidence: typeof data.confidence === "number" ? data.confidence : 0.9,
      consensus: data.consensus || "Live ИИ (Мост)",
      npaRef: data.npaRef || "",
      source: data.source || "live-ai-bridge"
    };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Queries Local Bridge batch endpoint (/solve_batch) for fast multi-question solving
 */
async function queryBridgeBatch(bridgeUrl, items, pageTitle = "", pageUrl = "", jurisdiction = "") {
  const url = `${(bridgeUrl || DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/, "")}/solve_batch`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 75000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageTitle,
        pageUrl,
        jurisdiction: jurisdiction || undefined,
        items: items.map((it, idx) => ({
          id: it.id ?? idx,
          question: it.question,
          options: it.options,
          isMultiChoice: Boolean(it.isMultiChoice)
        }))
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      throw new Error(`Bridge HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!data || !Array.isArray(data.results)) {
      throw new Error("Некорректный ответ /solve_batch");
    }
    return data.results;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Rate-paces zero-key Pollinations requests only if local bridge is down
let pollinationsQueuePromise = Promise.resolve();
let lastPollinationsCallAt = 0;

function schedulePollinationsCall(fn) {
  const run = pollinationsQueuePromise.then(async () => {
    const elapsed = Date.now() - lastPollinationsCallAt;
    if (elapsed < 1200) {
      await new Promise((r) => setTimeout(r, 1200 - elapsed));
    }
    try {
      return await fn();
    } finally {
      lastPollinationsCallAt = Date.now();
    }
  });
  pollinationsQueuePromise = run.catch(() => {});
  return run;
}

/**
 * Queries OpenAI-compatible or zero-key Pollinations endpoint
 */
async function queryOpenAiCompatible({ endpoint, apiKey, model, question, options, pageTitle = "", jurisdiction = "RK", sourceTag, consensusLabel, useResponseFormat = true, isMultiChoice = false }) {
  const multiRule = isMultiChoice
    ? 'Если в вопросе требуются несколько верных вариантов, верни все верные 0-based индексы в "matchedOptionIndices": [<индексы>] и первый индекс в "matchedOptionIndex".'
    : "Выбери строго один правильный вариант ответа (0-based index).";

  const domainDesc = jurisdiction === "RF"
    ? "Ты эксперт по промышленной безопасности и охране труда РФ (116-ФЗ, 225-ФЗ в ред. 322-ФЗ, 99-ФЗ, ГрК РФ, КоАП РФ, ПП РФ № 1437, ПП РФ № 1365/13, ПП РФ № 1477/1540, ФНП и Приказы Ростехнадзора, А.1 ПБ 115.27). Отвечай строго по нормам РФ."
    : "Ты эксперт по промышленной безопасности (Промбез), БиОТ и законодательству РК (Закон РК «О гражданской защите» № 188-V, Трудовой кодекс РК, Закон РК «О разрешениях и уведомлениях» № 202-V, правила МЧС/МИР/МТСЗН/Минэнерго РК, стандарты АО «ИЦА»). Отвечай строго по нормам РК.";

  const systemPrompt =
    domainDesc + " " +
    multiRule + " " +
    "Ответь СТРОГО валидным JSON без markdown (сначала краткая норма права в law): " +
    `{"law": "<НПА и ключевой факт>", "matchedOptionIndex": <0..${Math.max(options.length - 1, 0)}>, "matchedOptionIndices": [<индексы>], "matchedOptionText": "<точный текст>", "confidence": <0.7-0.99>, "npaRef": "<НПА и статья>", "explanation": "<краткое обоснование>"}`;

  const userPrompt = `${pageTitle ? `Контекст (${jurisdiction}): ${pageTitle}\n` : ""}Вопрос: ${question}\nВарианты:\n${options.map((opt, idx) => `${idx}: ${opt}`).join("\n")}`;

  const bodyObj = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1
  };
  if (useResponseFormat) {
    bodyObj.response_format = { type: "json_object" };
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyObj),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const contentStr = data.choices?.[0]?.message?.content || "";
    const parsed = extractJsonFromLlmText(contentStr);
    const normalized = normalizeLlmChoice(parsed, options, sourceTag, consensusLabel);
    if (!normalized) {
      throw new Error("Некорректный JSON-ответ ИИ");
    }
    return normalized;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

let pollinationsCooldownUntil = 0;

function makeAiCacheHash(question, options, isMultiChoice, jurisdiction) {
  const cachePrefix = `v2|${jurisdiction}|${isMultiChoice ? "M" : "S"}||`;
  return hashString(
    cachePrefix +
      String(question || "").trim().toLowerCase() +
      "||" +
      (options || []).map((o) => String(o).trim().toLowerCase()).join("|")
  );
}

async function saveAiCacheEntries(entries) {
  if (!entries.length) return;
  try {
    const sessMap = {};
    for (const { hash, result } of entries) {
      sessMap[`ai_cache_${hash}`] = result;
    }
    await chrome.storage.session.set(sessMap);
  } catch (_) {}

  try {
    const stored = await chrome.storage.local.get(["aiAnswerCache"]);
    const pCache = stored?.aiAnswerCache || {};
    for (const { hash, result } of entries) {
      pCache[hash] = result;
    }
    const keys = Object.keys(pCache);
    if (keys.length > 600) {
      for (const oldKey of keys.slice(0, keys.length - 600)) {
        delete pCache[oldKey];
      }
    }
    await chrome.storage.local.set({ aiAnswerCache: pCache });
  } catch (_) {}
}

/**
 * Handles Live AI request with resilient cascade & persistent cache
 */
async function handleAskLiveAi(payload) {
  const { question, options = [], pageTitle = "", pageUrl = "", isMultiChoice = false, jurisdiction: explicitJur = "" } = payload;
  if (!question || typeof question !== "string" || !Array.isArray(options) || options.length === 0) {
    throw new Error("Missing or invalid question/options");
  }
  if (options.length > 20) {
    return { error: "Слишком много вариантов ответа для отдельного вопроса" };
  }

  const settings = await getStoredSettings();
  if (!settings.liveAiEnabled) {
    return { error: "Live AI отключен в настройках" };
  }

  const jur = resolveJurisdiction({ pageTitle, pageUrl, question, options, jurisdiction: explicitJur });
  const cacheHash = makeAiCacheHash(question, options, isMultiChoice, jur);
  const sessionKey = `ai_cache_${cacheHash}`;

  // 1. Check ephemeral session cache
  try {
    const cached = await chrome.storage.session.get([sessionKey]);
    if (cached && cached[sessionKey] && cached[sessionKey].matchedOptionIndex >= 0 && cached[sessionKey].matchedOptionIndex < options.length) {
      return { ...cached[sessionKey], source: "session-cache" };
    }
  } catch (_) {}

  // 2. Check persistent local cache
  try {
    const stored = await chrome.storage.local.get(["aiAnswerCache"]);
    const pCache = stored?.aiAnswerCache || {};
    const hit = pCache[cacheHash];
    if (hit && hit.matchedOptionIndex >= 0 && hit.matchedOptionIndex < options.length) {
      return { ...hit, source: "local-cache" };
    }
  } catch (_) {}

  const mode = settings.aiMode || "auto";
  const errors = [];
  let aiResult = null;

  // Cascade depending on configured mode
  if (mode === "bridge" || mode === "auto") {
    try {
      aiResult = await queryBridge(settings.bridgeUrl, question, options, pageTitle, pageUrl, isMultiChoice, jur);
    } catch (err) {
      errors.push(`Мост: ${err.message}`);
      if (mode === "bridge") {
        throw new Error(`Мост недоступен (${err.message})`);
      }
    }
  }

  if (!aiResult && (mode === "openai" || mode === "gemini" || (mode === "auto" && settings.apiKey))) {
    if (!settings.apiKey) {
      if (mode === "openai" || mode === "gemini") {
        throw new Error("API-ключ не задан в настройках");
      }
    } else {
      const endpoint = mode === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        : (settings.apiEndpoint || DEFAULT_SETTINGS.apiEndpoint);
      const model = mode === "gemini" && (!settings.apiModel || settings.apiModel === "gpt-4o-mini")
        ? "gemini-2.5-flash"
        : (settings.apiModel || "gpt-4o-mini");

      try {
        aiResult = await queryOpenAiCompatible({
          endpoint,
          apiKey: settings.apiKey,
          model,
          question,
          options,
          pageTitle,
          jurisdiction: jur,
          sourceTag: "live-ai-api",
          consensusLabel: mode === "gemini" ? "Live ИИ (Gemini)" : "Live ИИ (API)",
          isMultiChoice
        });
      } catch (err) {
        errors.push(`API: ${err.message}`);
        if (mode === "openai" || mode === "gemini") {
          throw new Error(`Ошибка AI API: ${err.message}`);
        }
      }
    }
  }

  if (!aiResult && (mode === "pollinations" || mode === "auto") && Date.now() >= pollinationsCooldownUntil) {
    const endpoint = settings.pollinationsEndpoint || DEFAULT_SETTINGS.pollinationsEndpoint;
    try {
      aiResult = await schedulePollinationsCall(() =>
        queryOpenAiCompatible({
          endpoint,
          apiKey: "",
          model: "openai-fast",
          question,
          options,
          pageTitle,
          jurisdiction: jur,
          sourceTag: "live-ai-cloud",
          consensusLabel: "Live ИИ (GPT-OSS-20B)",
          useResponseFormat: false,
          isMultiChoice
        })
      );
    } catch (err) {
      if (/402|429/.test(err.message || "")) {
        pollinationsCooldownUntil = Date.now() + 600000;
      }
      errors.push(`Облако ИИ: ${err.message}`);
    }
  }

  if (!aiResult || aiResult.matchedOptionIndex < 0) {
    throw new Error(errors.join("; ") || "Live ИИ не смог определить ответ");
  }

  await saveAiCacheEntries([{ hash: cacheHash, result: aiResult }]);
  return aiResult;
}

/**
 * Handles batched Live AI solving cleanly via /solve_batch with per-item cache and fallback
 */
async function handleAskLiveAiBatch(payload) {
  const { items = [], pageTitle = "", pageUrl = "", jurisdiction: explicitJur = "" } = payload || {};
  if (!Array.isArray(items) || items.length === 0) {
    return { results: [] };
  }

  const settings = await getStoredSettings();
  if (!settings.liveAiEnabled) {
    return { results: items.map(() => ({ error: "Live AI отключен в настройках" })) };
  }

  const combinedQ = items.map((i) => i.question || "").slice(0, 8).join(" ");
  const jur = resolveJurisdiction({ pageTitle, pageUrl, question: combinedQ, jurisdiction: explicitJur });

  const localStored = await chrome.storage.local.get(["aiAnswerCache"]).catch(() => ({}));
  const pCache = localStored?.aiAnswerCache || {};

  const outResults = new Array(items.length).fill(null);
  const unresolved = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const opts = Array.isArray(it.options) ? it.options : [];
    if (!it.question || opts.length === 0 || opts.length > 20) {
      outResults[i] = { error: "Некорректный вопрос или число вариантов" };
      continue;
    }
    const cacheHash = makeAiCacheHash(it.question, opts, Boolean(it.isMultiChoice), jur);
    const hit = pCache[cacheHash];
    if (hit && hit.matchedOptionIndex >= 0 && hit.matchedOptionIndex < opts.length) {
      outResults[i] = { ...hit, source: "local-cache" };
      continue;
    }
    unresolved.push({ pos: i, hash: cacheHash, ...it });
  }

  if (unresolved.length === 0) {
    return { jurisdiction: jur, results: outResults };
  }

  const mode = settings.aiMode || "auto";
  const toCache = [];

  if (mode === "bridge" || mode === "auto") {
    try {
      const batchRes = await queryBridgeBatch(settings.bridgeUrl, unresolved, pageTitle, pageUrl, jur);
      for (let k = 0; k < unresolved.length; k++) {
        const u = unresolved[k];
        const r = batchRes[k];
        if (r && !r.error && typeof r.matchedOptionIndex === "number" && r.matchedOptionIndex >= 0 && r.matchedOptionIndex < u.options.length) {
          outResults[u.pos] = r;
          toCache.push({ hash: u.hash, result: r });
        }
      }
    } catch (err) {
      if (mode === "bridge") {
        for (const u of unresolved) {
          if (!outResults[u.pos]) outResults[u.pos] = { error: `Мост недоступен (${err.message})` };
        }
        return { jurisdiction: jur, results: outResults };
      }
    }
  }

  if (toCache.length > 0) {
    await saveAiCacheEntries(toCache);
  }

  // Per-item fallback ONLY for anything still unresolved when bridge was down or skipped a question
  for (const u of unresolved) {
    if (outResults[u.pos]) continue;
    try {
      outResults[u.pos] = await handleAskLiveAi({
        question: u.question,
        options: u.options,
        pageTitle,
        pageUrl,
        isMultiChoice: Boolean(u.isMultiChoice),
        jurisdiction: jur
      });
    } catch (err) {
      outResults[u.pos] = { error: err?.message || "Ошибка Live ИИ" };
    }
  }

  return { jurisdiction: jur, results: outResults };
}

// Lifecycle listeners
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const existing = await chrome.storage.local.get(null);
    const toSave = {};
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
      if (existing[key] === undefined) {
        toSave[key] = val;
      }
    }
    if (existing.migration_v101_liveai !== true) {
      toSave.liveAiEnabled = true;
      toSave.aiMode = "auto";
      toSave.pollinationsEndpoint = DEFAULT_SETTINGS.pollinationsEndpoint;
      toSave.migration_v101_liveai = true;
    }
    if (existing.migration_v104_clean_cache !== true) {
      toSave.aiAnswerCache = {};
      toSave.migration_v104_clean_cache = true;
    }
    if (Object.keys(toSave).length > 0) {
      await chrome.storage.local.set(toSave);
    }
    const current = await getStoredSettings();
    await syncBadge(current.recognitionEnabled);
    if (current.recognitionEnabled) {
      await syncAllOpenTabs(current);
    }
  } catch (err) {
    console.error("[SW] onInstalled error:", err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    const current = await getStoredSettings();
    await syncBadge(current.recognitionEnabled);
    if (current.recognitionEnabled) {
      await syncAllOpenTabs(current);
    }
  } catch (err) {
    console.error("[SW] onStartup error:", err);
  }
});

// Automatically sync recognition & Monitor across tab switches without reopening popup
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const obsKey = `tab_${tabId}_obs`;
    const stored = await chrome.storage.session.get([obsKey]);
    if (stored && stored[obsKey]) {
      await chrome.storage.local.set({ lastObservation: stored[obsKey] });
    } else {
      await chrome.storage.local.set({
        lastObservation: {
          url: tab?.url || "",
          pageTitle: tab?.title || "",
          timestamp: Date.now(),
          detectedCount: 0,
          matchedCount: 0,
          items: []
        }
      });
    }

    const current = await getStoredSettings();
    if (current.recognitionEnabled && isInjectableUrl(tab?.url)) {
      await syncTabState(tabId, current);
    }
  } catch (_) {}
});

// Automatically trigger/restore recognition on navigation, reloads & SPA URL transitions
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status !== "complete" && !changeInfo.url) return;
    const targetUrl = changeInfo.url || tab?.url || "";
    if (!isInjectableUrl(targetUrl)) return;

    const current = await getStoredSettings();
    if (!current.recognitionEnabled) return;
    await syncTabState(tabId, current);
  } catch (_) {}
});

// Keyboard command listener (Alt+Shift+T)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-recognition") {
    try {
      const current = await getStoredSettings();
      const newEnabled = !current.recognitionEnabled;
      const nextSettings = { ...current, recognitionEnabled: newEnabled };
      await chrome.storage.local.set({ recognitionEnabled: newEnabled });
      if (!newEnabled) {
        await chrome.storage.local.set({
          lastObservation: {
            url: "",
            pageTitle: "",
            timestamp: Date.now(),
            detectedCount: 0,
            matchedCount: 0,
            items: []
          }
        });
      }
      await syncBadge(newEnabled);

      const activeRes = await sendMessageToActiveTab({
        type: "SET_RECOGNITION_STATE",
        enabled: newEnabled,
        markerStyle: current.markerStyle,
        liveAiEnabled: current.liveAiEnabled,
        autoScanDynamic: current.autoScanDynamic
      });
      syncAllOpenTabs(nextSettings, activeRes?.tabId).catch(() => {});
    } catch (err) {
      console.error("[SW] onCommand error:", err);
    }
  }
});

// Main message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Always handle via async IIFE and return true
  (async () => {
    try {
      const type = message?.type || message?.action;
      switch (type) {
        case "GET_STATE": {
          const state = await getStoredSettings();
          sendResponse({ success: true, state });
          break;
        }

        case "TOGGLE_RECOGNITION": {
          const current = await getStoredSettings();
          const newEnabled =
            typeof message.enabled === "boolean" ? message.enabled : !current.recognitionEnabled;
          const nextSettings = { ...current, recognitionEnabled: newEnabled };

          await chrome.storage.local.set({ recognitionEnabled: newEnabled });
          if (!newEnabled) {
            await chrome.storage.local.set({
              lastObservation: {
                url: "",
                pageTitle: "",
                timestamp: Date.now(),
                detectedCount: 0,
                matchedCount: 0,
                items: []
              }
            });
          }
          await syncBadge(newEnabled);

          const tabResult = await sendMessageToActiveTab({
            type: "SET_RECOGNITION_STATE",
            enabled: newEnabled,
            markerStyle: current.markerStyle,
            liveAiEnabled: current.liveAiEnabled,
            autoScanDynamic: current.autoScanDynamic
          });
          syncAllOpenTabs(nextSettings, tabResult?.tabId).catch(() => {});

          sendResponse({
            success: true,
            enabled: newEnabled,
            tabNotified: tabResult.success
          });
          break;
        }

        case "RESCAN_ACTIVE_TAB": {
          const res = await sendMessageToActiveTab({ type: "SCAN_NOW" });
          sendResponse({ success: res.success, error: res.error });
          break;
        }

        case "UPDATE_SETTINGS": {
          const newSettings = message.settings || {};
          await chrome.storage.local.set(newSettings);

          const updated = await getStoredSettings();
          if (newSettings.recognitionEnabled !== undefined) {
            await syncBadge(updated.recognitionEnabled);
          }

          // Broadcast to active tab & keep remaining tabs synchronized
          const activeRes = await sendMessageToActiveTab({
            type: "SET_RECOGNITION_STATE",
            enabled: updated.recognitionEnabled,
            markerStyle: updated.markerStyle,
            liveAiEnabled: updated.liveAiEnabled,
            autoScanDynamic: updated.autoScanDynamic
          });

          if (newSettings.markerStyle) {
            await sendMessageToActiveTab({
              type: "APPLY_MARKER_STYLE",
              markerStyle: newSettings.markerStyle
            });
          }
          syncAllOpenTabs(updated, activeRes?.tabId).catch(() => {});

          sendResponse({ success: true, settings: updated });
          break;
        }

        case "CONTENT_READY": {
          const current = await getStoredSettings();
          sendResponse({
            recognitionEnabled: current.recognitionEnabled,
            markerStyle: current.markerStyle,
            liveAiEnabled: current.liveAiEnabled,
            autoScanDynamic: current.autoScanDynamic
          });
          break;
        }

        case "REPORT_OBSERVATION": {
          const observation = message.observation || null;
          const isTopFrame = !sender.frameId || sender.frameId === 0;
          const frameKey = String(sender.frameId || 0);
          const tabId = sender.tab?.id;

          let mergedObservation = observation;

          if (tabId && observation) {
            const framesKey = `tab_${tabId}_frames`;
            try {
              const stored = await chrome.storage.session.get([framesKey]);
              const framesMap = stored?.[framesKey] || {};

              // Reset frame cache on top-frame URL change
              if (isTopFrame && framesMap["0"]?.url && framesMap["0"].url !== observation.url) {
                for (const k of Object.keys(framesMap)) {
                  if (k !== "0") delete framesMap[k];
                }
              }

              framesMap[frameKey] = observation;
              await chrome.storage.session.set({ [framesKey]: framesMap });

              const allItems = [];
              let detectedTotal = 0;
              let matchedTotal = 0;
              for (const frameObs of Object.values(framesMap)) {
                if (frameObs && Array.isArray(frameObs.items)) {
                  allItems.push(...frameObs.items);
                  detectedTotal += frameObs.detectedCount ?? frameObs.items.length;
                  matchedTotal += frameObs.matchedCount ?? frameObs.items.filter((i) => i.matched).length;
                }
              }

              mergedObservation = {
                url: observation.url || framesMap["0"]?.url || "",
                pageTitle: framesMap["0"]?.pageTitle || observation.pageTitle || "",
                timestamp: Date.now(),
                detectedCount: detectedTotal,
                matchedCount: matchedTotal,
                items: allItems
              };

              await chrome.storage.session.set({ [`tab_${tabId}_obs`]: mergedObservation });
            } catch (sessErr) {
              console.warn("[SW] Could not save session observation:", sessErr);
            }
          }

          if (!sender.tab || sender.tab.active) {
            await chrome.storage.local.set({ lastObservation: mergedObservation });
          }

          sendResponse({ success: true });
          break;
        }

        case "ASK_LIVE_AI": {
          const result = await handleAskLiveAi(message);
          sendResponse(result);
          break;
        }

        case "ASK_LIVE_AI_BATCH": {
          const result = await handleAskLiveAiBatch(message);
          sendResponse(result);
          break;
        }

        default:
          sendResponse({ error: `Unknown message type: ${type}` });
          break;
      }
    } catch (err) {
      console.error("[SW] Message processing error:", err);
      sendResponse({ error: err.message });
    }
  })();

  return true; // asynchronous response guarantee
});
