/**
 * DOM Scanner for RK Industrial Safety Test Engines (Промбез и БИОТ РК)
 * Detects questions and options across Moodle, iSpring, SCORM, Google Forms,
 * OnlineTestPad, and generic corporate test portals without modifying innerHTML.
 */

(function () {
  "use strict";

  /**
   * Checks if an element is visible to the user
   */
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    try {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 || el.offsetParent !== null;
    } catch (e) {
      return true;
    }
  }

  /**
   * Safely extracts text from an element while ignoring scripts, styles, and hidden elements
   */
  function getCleanText(el) {
    if (!el || !(el instanceof Element)) return "";

    const clone = el.cloneNode(true);
    const ignored = clone.querySelectorAll(
      "script, style, noscript, svg, [aria-hidden='true'], .accesshide, .sr-only"
    );
    ignored.forEach((node) => node.remove());

    const raw = clone.innerText || clone.textContent || "";
    return raw
      .replace(/\r\n|\r|\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Resolves the cleanest visual container for highlighting an option
   * (label, list item, row div, or button) without wrapping or altering DOM.
   */
  function resolveHighlightTarget(optionEl, blockEl) {
    if (!optionEl || !(optionEl instanceof Element)) return optionEl;

    // 1. If it's an <input> (radio/checkbox)
    if (optionEl.tagName === "INPUT") {
      const id = optionEl.getAttribute("id");
      if (id) {
        const root = blockEl || document;
        const forLabel = root.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (forLabel && isVisible(forLabel)) {
          return forLabel;
        }
      }

      const parentLabel = optionEl.closest("label");
      if (parentLabel && isVisible(parentLabel)) {
        return parentLabel;
      }

      const rowWrapper = optionEl.closest(
        ".r0, .r1, .answer > div, [class*='choice'], [class*='option']:not([class*='options']), [class*='answer-item'], [class*='variant'], li, tr"
      );
      if (rowWrapper && isVisible(rowWrapper) && (!blockEl || blockEl.contains(rowWrapper))) {
        return rowWrapper;
      }

      // Walk up at most 4 levels to find a visible wrapper holding text and only this single input
      let curr = optionEl.parentElement;
      for (let depth = 0; depth < 4 && curr && curr !== document.body && curr !== blockEl; depth++) {
        const inputsInside = curr.querySelectorAll("input[type='radio'], input[type='checkbox']");
        if (inputsInside.length <= 1 && isVisible(curr) && getCleanText(curr).length > 0) {
          return curr;
        }
        curr = curr.parentElement;
      }

      return optionEl.parentElement || optionEl;
    }

    // 2. If it's a <label> or Moodle 4.x data-region='answer-label'
    if (optionEl.tagName === "LABEL" || optionEl.getAttribute("data-region") === "answer-label") {
      const rowWrapper = optionEl.closest(".r0, .r1, .answer > div, li");
      if (rowWrapper && rowWrapper !== blockEl && isVisible(rowWrapper)) {
        return rowWrapper;
      }
      return optionEl;
    }

    // 3. If element is already a choice/option/item container
    return optionEl;
  }

  /**
   * Sanitizes option text by removing leading letters/numbers ("А)", "1.", "Б)")
   */
  function cleanOptionText(text) {
    if (!text) return "";
    return text
      .replace(/^[ \t]*(?:[a-zа-я]|\d+)\s*[\.\)\-–—]\s*/i, "")
      .trim();
  }

  const MAX_OPTIONS_PER_QUESTION = 15;

  /**
   * Deduplicates question blocks ensuring no overlaps or nested duplicate captures
   */
  function deduplicateBlocks(blocks) {
    const capturedBlocks = [];
    const result = [];

    for (const b of blocks) {
      if (!b.blockEl) continue;
      if (!b.questionText || b.questionText.length < 5) continue;
      if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > MAX_OPTIONS_PER_QUESTION) continue;

      const overlaps = capturedBlocks.some(
        (prev) => prev === b.blockEl || prev.contains(b.blockEl) || b.blockEl.contains(prev)
      );
      if (overlaps) continue;

      b.isMultiChoice =
        Boolean(b.isMultiChoice) ||
        b.options.some((o) => o.el?.type === "checkbox" || o.el?.getAttribute?.("role") === "checkbox") ||
        /(?:выберите|укажите|отметьте)\s+(?:несколько|все|(?:два|двух|три|трех|четыре|четырех|пять|\d+)\s+(?:правильн|верн)|правильные\s+(?:варианты|ответы)|верные\s+(?:варианты|ответы))/i.test(
          b.questionText
        );

      capturedBlocks.push(b.blockEl);
      result.push(b);
    }

    return result;
  }

  /**
   * Checks whether text is UI noise (counters, timers, nav buttons) rather than a question
   */
  function isUiNoiseText(txt) {
    if (!txt || txt.length < 4) return true;
    const low = txt.trim().toLowerCase();
    if (/^\d+(?:\s*из\s*\d+)?$/.test(low)) return true;
    if (/^(?:вопрос|тест|шаг|задание)?\s*\d+\s*(?:из|\/)\s*\d+$/.test(low)) return true;
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(low)) return true;
    if (/^(?:далее|назад|завершить|ответить|пропустить|ок|отмена|проверить)$/.test(low)) return true;
    return false;
  }

  /**
   * Extracts question text associated with an option group while strictly excluding
   * elements that contain or overlap any answer option.
   */
  function extractQuestionTextOutsideOptions(containerEl, optionsList = []) {
    const optionEls = optionsList
      .flatMap((o) => [o.highlightTargetEl, o.el])
      .filter((el) => el && el instanceof Element);
    const optionTextsSet = new Set(optionsList.map((o) => cleanOptionText(o.text).toLowerCase()));

    const overlapsOption = (cand) => {
      if (!cand || !(cand instanceof Element)) return true;
      if (cand.querySelector("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']")) {
        return true;
      }
      return optionEls.some((optEl) => optEl === cand || optEl.contains(cand) || cand.contains(optEl));
    };

    const isValidQuestionCandidate = (cand) => {
      if (!cand || !isVisible(cand) || overlapsOption(cand)) return "";
      const txt = getCleanText(cand);
      if (isUiNoiseText(txt)) return "";
      const cleaned = cleanOptionText(txt).toLowerCase();
      if (optionTextsSet.has(cleaned) || optionTextsSet.has(txt.toLowerCase())) return "";
      return txt;
    };

    // 0. Check ARIA labelledby on container
    const labelledBy = containerEl?.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const refEl = document.getElementById(id);
        const txt = isValidQuestionCandidate(refEl);
        if (txt) return txt;
      }
    }

    const qSelectors = [
      "[class*='qtext']",
      "[class*='question-text']",
      "[class*='question_text']",
      "[class*='question-title']",
      "[class*='q-title']",
      "[class*='label-title']",
      "[data-testid*='title']",
      "[role='heading']",
      "legend",
      "h1", "h2", "h3", "h4", "h5",
      ".question", ".title", "strong", "b", "p"
    ].join(", ");

    // 1. Look inside containerEl for a non-option heading preceding the first option
    const firstOptionEl = optionEls[0] || null;
    if (containerEl) {
      const innerCandidates = Array.from(containerEl.querySelectorAll(qSelectors));
      for (const cand of innerCandidates) {
        if (firstOptionEl && (firstOptionEl.compareDocumentPosition(cand) & Node.DOCUMENT_POSITION_PRECEDING) === 0) {
          continue;
        }
        const txt = isValidQuestionCandidate(cand);
        if (txt) return txt;
      }
      // Fallback inside containerEl regardless of order if none preceded
      for (const cand of innerCandidates) {
        const txt = isValidQuestionCandidate(cand);
        if (txt) return txt;
      }
    }

    // 2. Walk up ancestors (up to 4 levels) checking preceding siblings and headers
    let curr = containerEl;
    for (let depth = 0; depth < 4 && curr && curr !== document.body; depth++) {
      let prev = curr.previousElementSibling;
      while (prev) {
        if (!prev.querySelector("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']")) {
          const directTxt = isValidQuestionCandidate(prev);
          if (directTxt) return directTxt;

          const subCands = prev.querySelectorAll(qSelectors);
          for (const sub of subCands) {
            const subTxt = isValidQuestionCandidate(sub);
            if (subTxt) return subTxt;
          }
        }
        prev = prev.previousElementSibling;
      }
      curr = curr.parentElement;
    }

    return "";
  }

  /**
   * Extracts clean option label text from a Moodle 3.x / 4.x option row,
   * removing Moodle numbering spans (.answernumber) and inline feedback.
   */
  function extractMoodleOptionText(row) {
    const labelEl = row.querySelector("label, [data-region='answer-label'], .flex-fill") || row;
    const clone = labelEl.cloneNode(true);
    const noise = clone.querySelectorAll(
      ".answernumber, .specificfeedback, .feedback, .validationerror, input"
    );
    noise.forEach((n) => n.remove());
    return cleanOptionText(getCleanText(clone));
  }

  /**
   * 1. Moodle Quiz Engine Scanner (supports Moodle 3.x & Moodle 4.x Boost/Classic, e.g. bilim.qg.kz)
   */
  function scanMoodle(root) {
    const questions = [];
    const queElements = root.querySelectorAll(".que");

    for (const que of queElements) {
      if (!isVisible(que)) continue;

      // Extract question text
      const qtextEl = que.querySelector(".qtext, .formulation .content, .formulation");
      if (!qtextEl) continue;

      // Ensure we don't include answer blocks, prompts, or feedback inside question text
      const qtextClone = qtextEl.cloneNode(true);
      const innerAnswers = qtextClone.querySelectorAll(".answer, .ablock, .prompt, .specificfeedback, .im-controls");
      innerAnswers.forEach((a) => a.remove());
      const questionText = getCleanText(qtextClone);

      // Prefer canonical Moodle .r0/.r1 rows first so wrapper divs don't duplicate options
      let optionRows = Array.from(que.querySelectorAll(".answer .r0, .answer .r1"));
      if (optionRows.length === 0) {
        optionRows = Array.from(que.querySelectorAll(".answer > div, .answer li"));
      }

      const seenRows = [];
      const options = [];
      let index = 0;

      for (const row of optionRows) {
        if (!isVisible(row)) continue;
        // Skip Moodle "Clear my choice" ("Очистить выбор") and feedback/control containers
        if (
          row.classList.contains("qtype_multichoice_clearchoice") ||
          row.closest(".qtype_multichoice_clearchoice, [data-action='clearchoice']") ||
          row.classList.contains("specificfeedback") ||
          row.classList.contains("feedback") ||
          row.classList.contains("im-controls") ||
          row.classList.contains("validationerror")
        ) {
          continue;
        }
        // Prevent nested container overlap inside .answer
        if (seenRows.some((prev) => prev === row || prev.contains(row) || row.contains(prev))) {
          continue;
        }

        const input = row.querySelector("input[type='radio'], input[type='checkbox']");
        if (input && input.value === "-1") continue; // Moodle clear-choice radio
        if (!input && !row.querySelector("[data-region='answer-label'], .answernumber, label")) {
          continue;
        }

        const text = extractMoodleOptionText(row);
        if (text) {
          seenRows.push(row);
          options.push({
            el: input || row,
            highlightTargetEl: resolveHighlightTarget(input || row, que),
            text,
            index: index++
          });
        }
      }

      if (questionText && options.length >= 2) {
        const promptText = getCleanText(que.querySelector(".ablock .prompt, .prompt"));
        const isMultiPrompt =
          options.some((o) => o.el?.type === "checkbox") ||
          /(?:несколько|все\s+верн|не\s+менее\s+\d)/i.test(promptText);
        questions.push({
          blockEl: que,
          questionText,
          options,
          isMultiChoice: isMultiPrompt
        });
      }
    }

    return questions;
  }

  /**
   * 2. iSpring / SCORM / Modern Quiz Engines
   */
  function scanISpringSCORM(root) {
    const questions = [];
    const selectors = [
      "[class*='quiz-question']",
      "[class*='quiz_question']",
      "[class*='question-container']",
      "[class*='question-block']",
      "[class*='question_block']",
      "[class*='question-card']",
      "[class*='ispring-question']",
      "[data-question-id]"
    ];

    const cards = root.querySelectorAll(selectors.join(", "));
    for (const card of cards) {
      if (!isVisible(card)) continue;

      // Ensure we don't accidentally pick an element inside an answer row
      const choiceEls = card.querySelectorAll(
        "[class*='choice-item'], [class*='choice'], [class*='option-item'], [class*='option']:not([class*='options']), [class*='answer-item'], [class*='answer_item'], [class*='variant'], label.custom-control"
      );

      const options = [];
      let index = 0;
      for (const choice of choiceEls) {
        const input = choice.querySelector("input[type='radio'], input[type='checkbox']");
        const target = resolveHighlightTarget(input || choice, card);
        if (!isVisible(choice) && !isVisible(target)) continue;
        const text = cleanOptionText(getCleanText(choice) || getCleanText(target));
        if (text) {
          options.push({
            el: input || choice,
            highlightTargetEl: target,
            text,
            index: index++
          });
        }
      }

      if (options.length < 2) continue;

      let questionText = "";
      const titleEl = card.querySelector(
        "[class*='question-text'], [class*='question_text'], [class*='question-title'], [class*='label-title'], [class*='title'], h2, h3, h4, .text"
      );
      if (titleEl && !options.some((o) => o.highlightTargetEl === titleEl || o.highlightTargetEl?.contains(titleEl) || titleEl.contains(o.highlightTargetEl))) {
        const candidate = getCleanText(titleEl);
        if (!isUiNoiseText(candidate)) {
          questionText = candidate;
        }
      }
      if (!questionText) {
        questionText = extractQuestionTextOutsideOptions(card, options);
      }

      if (questionText && options.length >= 2) {
        questions.push({
          blockEl: card,
          questionText,
          options
        });
      }
    }

    return questions;
  }

  /**
   * 3. Google Forms, OnlineTestPad, Quizizz, Wayground (ARIA & data-testid)
   */
  function scanRoleAndTestId(root) {
    const questions = [];
    const containers = root.querySelectorAll(
      "[role='listitem'], [role='radiogroup'], [data-testid*='question'], .q-container"
    );

    for (const c of containers) {
      const optionEls = c.querySelectorAll(
        "[role='radio'], [role='checkbox'], [data-testid*='option'], .q-answer, label"
      );

      const options = [];
      let index = 0;
      for (const opt of optionEls) {
        const input = opt.querySelector("input") || (opt.tagName === "INPUT" ? opt : null);
        const target = resolveHighlightTarget(input || opt, c);
        if (!isVisible(opt) && !isVisible(target)) continue;
        const text = cleanOptionText(getCleanText(opt) || getCleanText(target));
        if (text && !options.some((o) => o.text === text)) {
          options.push({
            el: input || opt,
            highlightTargetEl: target,
            text,
            index: index++
          });
        }
      }

      if (options.length < 2) continue;

      const questionText = extractQuestionTextOutsideOptions(c, options);

      if (questionText && options.length >= 2) {
        questions.push({
          blockEl: c,
          questionText,
          options
        });
      }
    }

    return questions;
  }

  /**
   * 4. Fieldsets & Generic HTML Form Groups
   */
  function scanFieldsetsAndForms(root) {
    const questions = [];
    const fieldsets = root.querySelectorAll("fieldset");

    for (const fs of fieldsets) {
      if (!isVisible(fs)) continue;

      const inputs = fs.querySelectorAll("input[type='radio'], input[type='checkbox']");
      if (inputs.length < 2) continue;

      const options = [];
      let index = 0;
      for (const input of inputs) {
        const target = resolveHighlightTarget(input, fs);
        if (!isVisible(input) && !isVisible(target)) continue;
        const text = cleanOptionText(getCleanText(target));
        if (text) {
          options.push({
            el: input,
            highlightTargetEl: target,
            text,
            index: index++
          });
        }
      }

      if (options.length < 2) continue;

      const legend = fs.querySelector("legend") || fs.querySelector("h2, h3, h4, .legend");
      let questionText = "";
      if (legend && !options.some((o) => o.highlightTargetEl?.contains(legend))) {
        const lText = getCleanText(legend);
        if (!isUiNoiseText(lText)) questionText = lText;
      }
      if (!questionText) {
        questionText = extractQuestionTextOutsideOptions(fs, options);
      }

      if (questionText && options.length >= 2) {
        questions.push({
          blockEl: fs,
          questionText,
          options
        });
      }
    }

    return questions;
  }

  /**
   * 5. Radio / Checkbox Groups grouped by input name or enclosing question container
   */
  function scanRadioGroups(root) {
    const questions = [];
    const inputs = root.querySelectorAll("input[type='radio'], input[type='checkbox']");
    const nameGroups = new Map();
    const ungroupedInputs = [];

    for (const input of inputs) {
      const target = resolveHighlightTarget(input, null);
      if (!isVisible(input) && !isVisible(target)) continue;
      const rawName = (input.getAttribute("name") || "").trim();

      if (rawName) {
        if (!nameGroups.has(rawName)) {
          nameGroups.set(rawName, []);
        }
        nameGroups.get(rawName).push(input);
      } else {
        ungroupedInputs.push(input);
      }
    }

    const candidateGroups = [];
    for (const groupInputs of nameGroups.values()) {
      if (groupInputs.length >= 2 && groupInputs.length <= MAX_OPTIONS_PER_QUESTION) {
        candidateGroups.push(groupInputs);
      } else if (groupInputs.length === 1) {
        // Multi-choice checkbox questions often assign a distinct name per checkbox
        ungroupedInputs.push(groupInputs[0]);
      }
    }

    // Cluster unnamed or single-name inputs (e.g. per-option named checkboxes inside a multi-question <form>)
    // without ever jumping up to a page-wide <form> holding > MAX_OPTIONS_PER_QUESTION inputs.
    const countInputsIn = (el) =>
      el ? el.querySelectorAll("input[type='radio'], input[type='checkbox']").length : 0;

    const findTightQuestionContainer = (input) => {
      const preferredSelector =
        "fieldset, [role='radiogroup'], .que, .q-container, [data-question-id], [class*='question'], [class*='quiz'], [class*='ticket'], [class*='bilet'], [class*='task'], .card, .panel, li";
      let curr = input.parentElement;
      let highestValid = null;
      let preferredMatch = null;

      for (let depth = 0; depth < 8 && curr && curr !== document.body && curr !== document.documentElement; depth++) {
        const cnt = countInputsIn(curr);
        if (cnt > MAX_OPTIONS_PER_QUESTION) {
          break;
        }
        if (cnt >= 2) {
          highestValid = curr;
          if (!preferredMatch && curr.matches?.(preferredSelector)) {
            preferredMatch = curr;
          }
        }
        curr = curr.parentElement;
      }

      return preferredMatch || highestValid || input.parentElement?.parentElement;
    };

    const containerGroups = new Map();
    for (const input of ungroupedInputs) {
      const container = findTightQuestionContainer(input);
      if (!container || container === document.body || container === document.documentElement) continue;
      if (countInputsIn(container) > MAX_OPTIONS_PER_QUESTION) continue;
      if (!containerGroups.has(container)) {
        containerGroups.set(container, []);
      }
      containerGroups.get(container).push(input);
    }
    for (const groupInputs of containerGroups.values()) {
      if (groupInputs.length >= 2 && groupInputs.length <= MAX_OPTIONS_PER_QUESTION) {
        candidateGroups.push(groupInputs);
      }
    }

    for (const groupInputs of candidateGroups) {
      // Find tightest common ancestor
      let commonAncestor = groupInputs[0].parentElement;
      while (commonAncestor && commonAncestor !== document.body && commonAncestor !== document.documentElement) {
        if (groupInputs.every((inp) => commonAncestor.contains(inp))) {
          break;
        }
        commonAncestor = commonAncestor.parentElement;
      }

      if (!commonAncestor) continue;

      const options = [];
      let index = 0;
      for (const inp of groupInputs) {
        const target = resolveHighlightTarget(inp, commonAncestor);
        if (!isVisible(inp) && !isVisible(target)) continue;
        const text = cleanOptionText(getCleanText(target));
        if (text) {
          options.push({
            el: inp,
            highlightTargetEl: target,
            text,
            index: index++
          });
        }
      }

      if (options.length < 2 || options.length > MAX_OPTIONS_PER_QUESTION) continue;

      // Extract question strictly outside any option element/text
      const questionText = extractQuestionTextOutsideOptions(commonAncestor, options);

      if (questionText && options.length >= 2) {
        questions.push({
          blockEl: commonAncestor,
          questionText,
          options
        });
      }
    }

    return questions;
  }

  /**
   * 6. Fallback Single-Question Page Detector
   */
  function scanSingleQuestionFallback(root) {
    const allInputs = Array.from(root.querySelectorAll("input[type='radio'], input[type='checkbox']"));
    const options = [];
    let index = 0;

    for (const inp of allInputs) {
      const target = resolveHighlightTarget(inp, null);
      if (!isVisible(inp) && !isVisible(target)) continue;
      const text = cleanOptionText(getCleanText(target));
      if (text) {
        options.push({
          el: inp,
          highlightTargetEl: target,
          text,
          index: index++
        });
      }
      if (options.length > 12) {
        // Too many inputs on page without question containers (likely a catalog/menu, not a single question)
        return [];
      }
    }

    if (options.length < 2) return [];

    const firstTarget = options[0].highlightTargetEl || options[0].el;
    let candidateQuestion = extractQuestionTextOutsideOptions(document.body, options);

    if (!candidateQuestion) {
      const headings = root.querySelectorAll("h1, h2, h3, h4, .page-title, [class*='question'], .content p");
      const optSet = new Set(options.map((o) => cleanOptionText(o.text).toLowerCase()));
      for (const h of headings) {
        if (!isVisible(h)) continue;
        if (options.some((o) => o.highlightTargetEl?.contains(h) || h.contains(o.highlightTargetEl))) continue;
        const txt = getCleanText(h);
        if (isUiNoiseText(txt)) continue;
        if (optSet.has(cleanOptionText(txt).toLowerCase())) continue;
        if (
          txt.length >= 10 &&
          (!firstTarget || (firstTarget.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) !== 0)
        ) {
          candidateQuestion = txt;
          break;
        }
      }
    }

    if (!candidateQuestion || candidateQuestion.length < 6) return [];

    return [{
      blockEl: (firstTarget && firstTarget.parentElement) || document.body,
      questionText: candidateQuestion,
      options
    }];
  }

  /**
   * Main scan function
   */
  function scan(root = document) {
    if (!root) return [];

    const questions = [
      ...scanMoodle(root),
      ...scanISpringSCORM(root),
      ...scanRoleAndTestId(root),
      ...scanFieldsetsAndForms(root),
      ...scanRadioGroups(root)
    ];

    const deduped = deduplicateBlocks(questions);
    if (deduped.length > 0) {
      return deduped;
    }

    // Fallback only when no structured question blocks were found
    return deduplicateBlocks(scanSingleQuestionFallback(root));
  }

  const domScanner = {
    scan,
    scanQuestions: scan,
    isVisible,
    getCleanText,
    resolveHighlightTarget
  };

  if (typeof window !== "undefined") {
    window.ICA_DomScanner = domScanner;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = domScanner;
  }
})();
