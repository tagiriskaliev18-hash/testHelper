/**
 * Content Script (Manifest V3)
 * Промбез и БИОТ РК — Помощник ИЦА
 * Orchestrates DOM scanning, question matching, delicate answer highlighting,
 * dynamic mutation observation, and communication with the Service Worker.
 */

(function () {
  "use strict";

  // Prevent multiple injections in the same execution context
  if (window.__ICA_CONTENT_SCRIPT_INITIALIZED__) {
    return;
  }
  window.__ICA_CONTENT_SCRIPT_INITIALIZED__ = true;

  // Runtime State
  let isEnabled = false;
  let currentMarkerStyle = "subtle";
  let liveAiEnabled = true;
  let autoScanDynamic = true;

  let dbQuestions = null;
  let isScanning = false;
  let rescanRequested = false;
  let observer = null;
  let watchdogTimer = null;
  let debounceTimer = null;
  let globalListenersBound = false;

  let lastDomSignature = "";
  let lastKnownUrl = window.location.href;
  let expectedHighlightedTargets = [];

  // Decoupled persistent DB & Live AI caches, queue and retry tracking
  const dbMatchCache = new Map();
  const aiSolvedCache = new Map();
  const aiPendingKeys = new Set();
  const aiJobQueue = [];
  const aiErrorMap = new Map();
  let activeAiWorkers = 0;
  let aiSessionEpoch = 0;
  const MAX_AI_QUEUE_ITEMS = 80;
  const MAX_BATCH_SIZE = 6;
  const AI_CONCURRENCY = 2;
  const MAX_AUTO_RETRIES = 4;

  /**
   * Fast deterministic 32-bit FNV-1a hash in base-36 for collision-free keys
   */
  function fnvHash(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * Deterministic collision-free key for question + options + jurisdiction deduplication
   */
  function makeQuestionKey(questionText, optionTexts, jurisdiction = "RK", isMultiChoice = false) {
    const normQ = String(questionText || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    const normOpts = (Array.isArray(optionTexts) ? optionTexts : [])
      .map((o) => String(o || "").trim().toLowerCase().replace(/\s+/g, " "))
      .join("\u001f");
    return `${jurisdiction}|${isMultiChoice ? "M" : "S"}|${normQ.length}_${fnvHash(normQ)}|${optionTexts.length}_${fnvHash(normOpts)}`;
  }

  /**
   * Computes lightweight structural signature for detected DOM question blocks
   */
  function computeBlocksSignature(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return "0";
    return blocks
      .map((b) => {
        const optsSig = (b.options || []).map((o) => fnvHash(o.text || "")).join(",");
        return `${fnvHash(b.questionText || "")}:${optsSig}`;
      })
      .join("|");
  }

  /**
   * Loads verified database from packaged extension data
   */
  async function loadDatabase() {
    if (dbQuestions !== null) return dbQuestions;
    try {
      const url = chrome.runtime.getURL("data/questions_db.json");
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        dbQuestions = Array.isArray(data) ? data : data.questions || [];
      } else {
        dbQuestions = [];
      }
    } catch (err) {
      console.warn("[ICA] Could not load questions_db.json:", err.message);
      dbQuestions = [];
    }
    return dbQuestions;
  }

  /**
   * Applies highlight marker classes synchronously (safe if frameworks re-render)
   */
  function highlightOptionElement(targetEl, markerStyle) {
    if (!isEnabled || !targetEl || !(targetEl instanceof Element)) return;

    const styleClass = `ica-th-style-${markerStyle || "subtle"}`;
    const needsUpdate =
      !targetEl.classList.contains("ica-th-answer") ||
      !targetEl.classList.contains(styleClass) ||
      targetEl.getAttribute("data-ica-th-marked") !== "true";

    if (!needsUpdate) return;

    targetEl.classList.add("ica-th-answer");
    targetEl.classList.remove("ica-th-style-subtle", "ica-th-style-ultra", "ica-th-style-clear");
    targetEl.classList.add(styleClass);
    targetEl.setAttribute("data-ica-th-marked", "true");
  }

  /**
   * Clears all highlights and styling from the page
   */
  function clearAllHighlights() {
    expectedHighlightedTargets = [];
    const elements = document.querySelectorAll(".ica-th-answer, [data-ica-th-marked]");
    for (const el of elements) {
      el.classList.remove(
        "ica-th-answer",
        "ica-th-style-subtle",
        "ica-th-style-ultra",
        "ica-th-style-clear"
      );
      el.removeAttribute("data-ica-th-marked");
    }
  }

  /**
   * Switches the active marker style class on currently highlighted elements
   */
  function switchMarkerStyle(newStyle) {
    currentMarkerStyle = newStyle || "subtle";
    const styleClass = `ica-th-style-${currentMarkerStyle}`;
    for (const item of expectedHighlightedTargets) {
      item.style = currentMarkerStyle;
    }
    const elements = document.querySelectorAll(".ica-th-answer");
    for (const el of elements) {
      el.classList.remove("ica-th-style-subtle", "ica-th-style-ultra", "ica-th-style-clear");
      el.classList.add(styleClass);
    }
  }

  /**
   * Sends observation report to Service Worker
   */
  async function reportObservation(detectedBlocks, observationsList) {
    const isTopFrame = window.top === window.self;
    if (detectedBlocks.length === 0 && !isTopFrame) {
      return;
    }

    try {
      await chrome.runtime.sendMessage({
        type: "REPORT_OBSERVATION",
        observation: {
          url: window.location.href,
          pageTitle: document.title,
          isIframe: !isTopFrame,
          timestamp: Date.now(),
          detectedCount: detectedBlocks.length,
          matchedCount: observationsList.filter((o) => o.matched).length,
          items: observationsList
        }
      });
    } catch (err) {
      // Ignore disconnected port errors during navigation
    }
  }

  /**
   * Schedules a coalesced scan cleanly without dropping triggers
   */
  function scheduleScan(delayMs = 150) {
    if (!isEnabled) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (isEnabled) {
        runScan();
      }
    }, Math.max(0, delayMs));
  }

  /**
   * Normalizes validated indices from a Live AI response
   */
  function extractValidAiIndices(aiResp, optionsCount) {
    const out = [];
    if (aiResp && Array.isArray(aiResp.matchedOptionIndices)) {
      for (const raw of aiResp.matchedOptionIndices) {
        const idx = typeof raw === "number" ? raw : parseInt(String(raw), 10);
        if (Number.isInteger(idx) && idx >= 0 && idx < optionsCount && !out.includes(idx)) {
          out.push(idx);
        }
      }
    }
    if (out.length === 0 && aiResp && typeof aiResp.matchedOptionIndex === "number") {
      if (aiResp.matchedOptionIndex >= 0 && aiResp.matchedOptionIndex < optionsCount) {
        out.push(aiResp.matchedOptionIndex);
      }
    }
    return out;
  }

  /**
   * Enqueues a question for background Live AI solving if not already queued/pending
   */
  function enqueueAiJob(job) {
    if (!isEnabled || !liveAiEnabled) return;
    if (aiPendingKeys.has(job.qKey) || aiSolvedCache.has(job.qKey)) return;
    if (aiPendingKeys.size >= MAX_AI_QUEUE_ITEMS) return;

    aiPendingKeys.add(job.qKey);
    aiJobQueue.push(job);
  }

  /**
   * Records a failed Live AI attempt for bounded backoff retries
   */
  function recordAiFailure(qKey, errorMsg) {
    const prev = aiErrorMap.get(qKey);
    const attempts = (prev?.attempts || 0) + 1;
    aiErrorMap.set(qKey, {
      message: errorMsg || "ИИ не смог определить вариант ответа",
      attempts,
      nextRetryAt: Date.now() + Math.min(20000, attempts * 5000)
    });
  }

  /**
   * Executes a single Live AI question or a batch of up to MAX_BATCH_SIZE questions
   */
  async function processAiBatch(jobs, jobEpoch) {
    if (!jobs || jobs.length === 0) return;
    activeAiWorkers++;
    try {
      if (jobs.length === 1) {
        const job = jobs[0];
        const aiResp = await chrome.runtime.sendMessage({
          type: "ASK_LIVE_AI",
          question: job.questionText,
          options: job.optionTexts,
          pageTitle: job.pageTitle,
          pageUrl: job.pageUrl,
          jurisdiction: job.jurisdiction,
          isMultiChoice: Boolean(job.isMultiChoice)
        });
        const validIndices = extractValidAiIndices(aiResp, job.optionTexts.length);
        if (aiResp && !aiResp.error && validIndices.length > 0) {
          aiSolvedCache.set(job.qKey, {
            ...aiResp,
            matchedOptionIndex: validIndices[0],
            matchedOptionIndices: validIndices
          });
          aiErrorMap.delete(job.qKey);
        } else {
          recordAiFailure(job.qKey, aiResp?.error);
        }
      } else {
        const first = jobs[0];
        const batchResp = await chrome.runtime.sendMessage({
          type: "ASK_LIVE_AI_BATCH",
          pageTitle: first.pageTitle,
          pageUrl: first.pageUrl,
          jurisdiction: first.jurisdiction,
          items: jobs.map((j, idx) => ({
            id: idx,
            question: j.questionText,
            options: j.optionTexts,
            isMultiChoice: Boolean(j.isMultiChoice)
          }))
        });

        const results = Array.isArray(batchResp?.results) ? batchResp.results : [];
        jobs.forEach((job, idx) => {
          const r = results[idx];
          const validIndices = extractValidAiIndices(r, job.optionTexts.length);
          if (r && !r.error && validIndices.length > 0) {
            aiSolvedCache.set(job.qKey, {
              ...r,
              matchedOptionIndex: validIndices[0],
              matchedOptionIndices: validIndices
            });
            aiErrorMap.delete(job.qKey);
          } else {
            recordAiFailure(job.qKey, r?.error || batchResp?.error);
          }
        });
      }
    } catch (aiErr) {
      for (const job of jobs) {
        recordAiFailure(job.qKey, aiErr?.message || "Ошибка обращения к Live ИИ");
      }
    } finally {
      for (const job of jobs) {
        aiPendingKeys.delete(job.qKey);
      }
      activeAiWorkers = Math.max(0, activeAiWorkers - 1);

      if (isEnabled && jobEpoch === aiSessionEpoch) {
        scheduleScan(15);
        pumpAiQueue();
      }
    }
  }

  /**
   * Maintains bounded concurrent Live AI batch workers across page scans
   */
  function pumpAiQueue() {
    if (!isEnabled || !liveAiEnabled) return;
    const myEpoch = aiSessionEpoch;
    while (activeAiWorkers < AI_CONCURRENCY && aiJobQueue.length > 0) {
      const batch = [];
      while (batch.length < MAX_BATCH_SIZE && aiJobQueue.length > 0) {
        const job = aiJobQueue.shift();
        if (!job) continue;
        if (aiSolvedCache.has(job.qKey)) {
          aiPendingKeys.delete(job.qKey);
          continue;
        }
        batch.push(job);
      }
      if (batch.length > 0) {
        processAiBatch(batch, myEpoch);
      }
    }
  }

  /**
   * Performs complete scan & match cycle and schedules persistent Live AI batch jobs
   */
  async function runScan() {
    if (!isEnabled) return;
    if (isScanning) {
      rescanRequested = true;
      return;
    }
    if (!window.ICA_DomScanner || !window.ICA_TestMatcher) {
      console.warn("[ICA] Scanner or Matcher not available");
      return;
    }

    isScanning = true;
    const now = Date.now();

    try {
      if (window.location.href !== lastKnownUrl) {
        lastKnownUrl = window.location.href;
        aiErrorMap.clear();
      }

      const questionsDb = await loadDatabase();
      const detectedBlocks = window.ICA_DomScanner.scan(document);
      lastDomSignature = computeBlocksSignature(detectedBlocks);

      const pageSampleText = detectedBlocks
        .slice(0, 6)
        .map((b) => `${b.questionText} ${(b.options || []).map((o) => o.text).join(" ")}`)
        .join(" ");
      const pageJurisdiction = typeof window.ICA_TestMatcher.detectJurisdiction === "function"
        ? window.ICA_TestMatcher.detectJurisdiction({
            pageTitle: document.title,
            pageUrl: window.location.href,
            allText: pageSampleText
          })
        : "RK";

      const observationsList = new Array(detectedBlocks.length);
      const nextExpectedTargets = [];

      detectedBlocks.forEach((block, blockIdx) => {
        const optionTexts = block.options.map((opt) => opt.text);
        const isMulti = Boolean(block.isMultiChoice);
        const qKey = makeQuestionKey(block.questionText, optionTexts, pageJurisdiction, isMulti);

        let match;
        if (dbMatchCache.has(qKey)) {
          match = dbMatchCache.get(qKey);
        } else {
          match = window.ICA_TestMatcher.findBestMatch(
            block.questionText,
            optionTexts,
            questionsDb,
            {
              pageTitle: document.title,
              pageUrl: window.location.href,
              jurisdiction: pageJurisdiction
            }
          );
          dbMatchCache.set(qKey, match || null);
        }

        if (match && match.matchedOptionIndices && match.matchedOptionIndices.length > 0) {
          for (const idx of match.matchedOptionIndices) {
            const targetOption = block.options[idx];
            if (targetOption && targetOption.highlightTargetEl) {
              highlightOptionElement(targetOption.highlightTargetEl, currentMarkerStyle);
              nextExpectedTargets.push({ el: targetOption.highlightTargetEl, style: currentMarkerStyle });
            }
          }

          observationsList[blockIdx] = {
            question: block.questionText,
            matched: true,
            source: "database",
            confidence: match.confidence,
            confidenceLevel: match.confidenceLevel,
            matchedOptionIndices: match.matchedOptionIndices,
            matchedOptionTexts: match.matchedOptionTexts,
            npaRef: match.entry?.npaRef || "",
            consensus: match.entry?.consensus || "5/5"
          };
          return;
        }

        const cachedAi = aiSolvedCache.get(qKey);
        const validCachedIndices = extractValidAiIndices(cachedAi, block.options.length);

        if (cachedAi && validCachedIndices.length > 0) {
          const matchedTexts = [];
          for (const idx of validCachedIndices) {
            const targetOption = block.options[idx];
            if (targetOption && targetOption.highlightTargetEl) {
              highlightOptionElement(targetOption.highlightTargetEl, currentMarkerStyle);
              nextExpectedTargets.push({ el: targetOption.highlightTargetEl, style: currentMarkerStyle });
              matchedTexts.push(targetOption.text);
            }
          }

          observationsList[blockIdx] = {
            question: block.questionText,
            matched: true,
            aiStatus: "solved",
            source: cachedAi.source || "live-ai",
            confidence: cachedAi.confidence || 0.88,
            confidenceLevel: (cachedAi.confidence || 0.88) >= 0.75 ? "high" : "medium",
            matchedOptionIndices: validCachedIndices,
            matchedOptionTexts: matchedTexts,
            npaRef: cachedAi.npaRef || (pageJurisdiction === "RF" ? "Законодательство РФ" : "Законодательство РК"),
            consensus: cachedAi.consensus || "Live ИИ"
          };
          return;
        }

        if (!liveAiEnabled) {
          observationsList[blockIdx] = {
            question: block.questionText,
            matched: false,
            aiStatus: "disabled",
            source: "none",
            options: optionTexts
          };
          return;
        }

        const errInfo = aiErrorMap.get(qKey);
        if (errInfo && errInfo.attempts < MAX_AUTO_RETRIES && now >= errInfo.nextRetryAt) {
          aiErrorMap.delete(qKey);
        }

        const activeErr = aiErrorMap.get(qKey);
        if (!activeErr && !aiPendingKeys.has(qKey)) {
          enqueueAiJob({
            qKey,
            questionText: block.questionText,
            optionTexts,
            pageTitle: document.title,
            pageUrl: window.location.href,
            jurisdiction: pageJurisdiction,
            isMultiChoice: isMulti
          });
        }

        const stillErrored = aiErrorMap.get(qKey);
        observationsList[blockIdx] = {
          question: block.questionText,
          matched: false,
          aiStatus: stillErrored && !aiPendingKeys.has(qKey) ? "error" : "pending",
          aiError: stillErrored?.message || "",
          source: stillErrored && !aiPendingKeys.has(qKey) ? "live-ai-error" : "live-ai-pending",
          options: optionTexts
        };
      });

      expectedHighlightedTargets = nextExpectedTargets;
      await reportObservation(detectedBlocks, observationsList);
      pumpAiQueue();
    } catch (err) {
      console.error("[ICA] runScan error:", err);
    } finally {
      isScanning = false;
      if (rescanRequested && isEnabled) {
        rescanRequested = false;
        scheduleScan(60);
      }
    }
  }

  /**
   * Returns true if a node belongs to extension markers or ticking countdown timers
   */
  function isIgnoredMutationNode(node) {
    if (!node) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement;
    if (!el) return false;

    if (el.hasAttribute("data-ica-th-marked") || el.classList.contains("ica-th-answer")) {
      return true;
    }

    if (el.closest?.("[class*='timer'], [id*='timer'], [class*='clock'], [class*='countdown']")) {
      return true;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const txt = (node.textContent || "").trim();
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(txt)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Sets up or tears down dynamic MutationObserver for SPAs & dynamic forms
   */
  function setupObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (!autoScanDynamic || !isEnabled) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      let isRelevant = false;
      for (const m of mutations) {
        if (m.type === "childList") {
          if (isIgnoredMutationNode(m.target)) continue;
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = /** @type {Element} */ (node);
              if (!el.classList.contains("ica-th-answer") && !el.hasAttribute("data-ica-th-marked") && !isIgnoredMutationNode(el)) {
                isRelevant = true;
                break;
              }
            } else if (node.nodeType === Node.TEXT_NODE && !isIgnoredMutationNode(node)) {
              isRelevant = true;
              break;
            }
          }
          if (!isRelevant && m.removedNodes.length > 0 && !isIgnoredMutationNode(m.target)) {
            isRelevant = true;
          }
        } else if (m.type === "characterData") {
          if (!isIgnoredMutationNode(m.target)) {
            isRelevant = true;
          }
        } else if (m.type === "attributes") {
          if (m.attributeName === "data-ica-th-marked") continue;
          if (m.attributeName === "class" && isIgnoredMutationNode(m.target)) continue;
          if (!isIgnoredMutationNode(m.target)) {
            isRelevant = true;
          }
        }
        if (isRelevant) break;
      }

      if (!isRelevant) return;
      scheduleScan(280);
    });

    const targetNode = document.body || document.documentElement;
    if (targetNode) {
      observer.observe(targetNode, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["id", "class", "role", "style", "hidden", "aria-hidden"]
      });
    }
  }

  /**
   * Self-healing 1s watchdog: detects SPA URL changes, hidden/scrolled reveals,
   * framework class strips, and auto-retry cooldown expirations with zero user action.
   */
  function startWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (!isEnabled || !autoScanDynamic) return;

    watchdogTimer = setInterval(() => {
      if (!isEnabled || document.hidden || isScanning) return;

      // 1. Detect SPA navigation (history.pushState / replaceState in page context)
      if (window.location.href !== lastKnownUrl) {
        lastKnownUrl = window.location.href;
        aiErrorMap.clear();
        runScan();
        return;
      }

      // 2. Re-apply marker classes if SPA framework re-rendered node attributes
      let anyTargetDetached = false;
      for (const item of expectedHighlightedTargets) {
        if (!item.el || !item.el.isConnected) {
          anyTargetDetached = true;
          break;
        }
        highlightOptionElement(item.el, item.style || currentMarkerStyle);
      }
      if (anyTargetDetached) {
        runScan();
        return;
      }

      // 3. Detect structural changes or visible new questions missed by observer
      if (window.ICA_DomScanner) {
        const blocks = window.ICA_DomScanner.scan(document);
        const currentSig = computeBlocksSignature(blocks);
        if (currentSig !== lastDomSignature) {
          runScan();
          return;
        }
      }

      // 4. Auto-retry eligible failed Live AI questions without user intervention
      const now = Date.now();
      for (const errInfo of aiErrorMap.values()) {
        if (errInfo.attempts < MAX_AUTO_RETRIES && now >= errInfo.nextRetryAt) {
          runScan();
          return;
        }
      }

      if (aiJobQueue.length > 0 && activeAiWorkers < AI_CONCURRENCY) {
        pumpAiQueue();
      }
    }, 1000);
  }

  function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  /**
   * Binds SPA navigation, focus, visibility, and interaction hooks once
   */
  function bindGlobalAutoListeners() {
    if (globalListenersBound) return;
    globalListenersBound = true;

    const triggerSoon = () => {
      if (isEnabled && autoScanDynamic) {
        scheduleScan(160);
      }
    };

    window.addEventListener("popstate", triggerSoon);
    window.addEventListener("hashchange", triggerSoon);
    window.addEventListener("pageshow", triggerSoon);
    window.addEventListener("focus", triggerSoon);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && isEnabled && autoScanDynamic) {
        scheduleScan(100);
      }
    });

    document.addEventListener(
      "click",
      (ev) => {
        if (!isEnabled || !autoScanDynamic) return;
        const t = ev.target instanceof Element ? ev.target : null;
        if (t && isIgnoredMutationNode(t)) return;
        scheduleScan(240);
      },
      true
    );

    document.addEventListener(
      "change",
      () => {
        if (isEnabled && autoScanDynamic) {
          scheduleScan(220);
        }
      },
      true
    );
  }

  /**
   * Updates runtime recognition state
   */
  function setRecognitionState(state) {
    const wasEnabled = isEnabled;
    const wasLiveAi = liveAiEnabled;
    isEnabled = Boolean(state.enabled);

    if (state.markerStyle) {
      currentMarkerStyle = state.markerStyle;
    }
    if (state.liveAiEnabled !== undefined) {
      liveAiEnabled = Boolean(state.liveAiEnabled);
    }
    if (state.autoScanDynamic !== undefined) {
      autoScanDynamic = Boolean(state.autoScanDynamic);
    }

    if (isEnabled) {
      bindGlobalAutoListeners();
      if (!wasEnabled || (!wasLiveAi && liveAiEnabled)) {
        aiErrorMap.clear();
      }
      setupObserver();
      startWatchdog();
      runScan();
    } else {
      aiSessionEpoch++;
      aiJobQueue.length = 0;
      aiPendingKeys.clear();
      aiErrorMap.clear();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      stopWatchdog();
      clearAllHighlights();
    }
  }

  // Listen for messages from Service Worker & Popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        const type = message?.type || message?.action;
        switch (type) {
          case "SET_RECOGNITION_STATE": {
            setRecognitionState({
              enabled: message.enabled,
              markerStyle: message.markerStyle,
              liveAiEnabled: message.liveAiEnabled,
              autoScanDynamic: message.autoScanDynamic
            });
            sendResponse({ success: true, isEnabled });
            break;
          }

          case "APPLY_MARKER_STYLE": {
            switchMarkerStyle(message.markerStyle);
            sendResponse({ success: true, markerStyle: currentMarkerStyle });
            break;
          }

          case "SCAN_NOW": {
            aiErrorMap.clear();
            if (isEnabled) {
              await runScan();
            }
            sendResponse({ success: true, isEnabled });
            break;
          }

          case "CLEAR_HIGHLIGHTS": {
            clearAllHighlights();
            sendResponse({ success: true });
            break;
          }

          default:
            sendResponse({ error: `Unknown content message type: ${type}` });
            break;
        }
      } catch (err) {
        console.error("[ICA] Content onMessage error:", err);
        sendResponse({ error: err.message });
      }
    })();

    return true; // asynchronous response guarantee
  });

  /**
   * Initializes content script by fetching initial state from Service Worker
   */
  async function init() {
    bindGlobalAutoListeners();
    try {
      const response = await chrome.runtime.sendMessage({ type: "CONTENT_READY" });
      if (response) {
        setRecognitionState({
          enabled: response.recognitionEnabled,
          markerStyle: response.markerStyle || "subtle",
          liveAiEnabled: response.liveAiEnabled !== false,
          autoScanDynamic: response.autoScanDynamic !== false
        });
      }
    } catch (err) {
      // Service worker may be asleep or initializing
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
