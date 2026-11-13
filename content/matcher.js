/**
 * Question & Option Matcher for RK Industrial Safety (Промбез и БИОТ РК)
 * Supports browser environment (window.ICA_TestMatcher) and Node.js testing.
 */

(function () {
  "use strict";

  // Common Russian stop-words
  const RU_STOP_WORDS = new Set([
    "и", "в", "во", "на", "по", "с", "со", "к", "ко", "о", "об", "обо",
    "из", "для", "при", "не", "или", "что", "как", "а", "да", "но", "за",
    "до", "от", "у", "же", "ли", "бы", "то", "под", "над", "чем", "где",
    "когда", "кто", "это", "этот", "эта", "эти", "все", "всех", "всем",
    "так", "его", "ее", "их", "мы", "вы", "он", "она", "они", "быть",
    "был", "была", "были", "является", "являются"
  ]);

  // Key RK Industrial Safety & Labor Protection acronyms and full phrases
  const ACRONYM_PAIRS = [
    { short: "опо", full: "опасный производственный объект" },
    { short: "биот", full: "безопасность и охрана труда" },
    { short: "мг", full: "магистральный газопровод" },
    { short: "кс", full: "компрессорная станция" },
    { short: "грс", full: "газораспределительная станция" },
    { short: "гпм", full: "грузоподъемный механизм" },
    { short: "сиз", full: "средства индивидуальной защиты" },
    { short: "сизод", full: "средства индивидуальной защиты органов дыхания" },
    { short: "нкпр", full: "нижний концентрационный предел распространения пламени" },
    { short: "пдк", full: "предельно допустимая концентрация" },
    { short: "чс", full: "чрезвычайная ситуация" },
    { short: "тк рк", full: "трудовой кодекс республики казахстан" },
    { short: "итр", full: "инженерно технический работник" },
    { short: "слр", full: "сердечно легочная реанимация" },
    { short: "чп", full: "несчастный случай" },
    { short: "нс", full: "несчастный случай" },
    { short: "пто", full: "полное техническое освидетельствование" },
    { short: "что", full: "частичное техническое освидетельствование", upperOnly: true }
  ];

  // Number words normalization with Unicode word boundaries
  const NUMBER_WORD_REPLACEMENTS = [
    [/(?<![а-яёa-z0-9])ежегодно(?![а-яёa-z0-9])/gi, "1 раз в год"],
    [/(?<![а-яёa-z0-9])ежегодн(?:ая|ый|ое)(?![а-яёa-z0-9])/gi, "1 раз в год"],
    [/(?<![а-яёa-z0-9])ежемесячно(?![а-яёa-z0-9])/gi, "1 раз в месяц"],
    [/(?<![а-яёa-z0-9])ежеквартально(?![а-яёa-z0-9])/gi, "1 раз в квартал"],
    [/(?<![а-яёa-z0-9])(полгода|полугодие)(?![а-яёa-z0-9])/gi, "6 месяцев"],
    [/(?<![а-яёa-z0-9])(\d+)-(?:ти|х|го|и|ой|ый|ым|ого|ому)(?![а-яёa-z0-9])/gi, "$1"],
    [/(?<![а-яёa-z0-9])(один|одна|одно|одного|одному|одним|одной)(?![а-яёa-z0-9])/gi, "1"],
    [/(?<![а-яёa-z0-9])(два|две|двух|двум|двумя)(?![а-яёa-z0-9])/gi, "2"],
    [/(?<![а-яёa-z0-9])(три|трех|трем|тремя)(?![а-яёa-z0-9])/gi, "3"],
    [/(?<![а-яёa-z0-9])(четыре|четырех|четырем|четырьмя)(?![а-яёa-z0-9])/gi, "4"],
    [/(?<![а-яёa-z0-9])(пять|пяти|пятью)(?![а-яёa-z0-9])/gi, "5"],
    [/(?<![а-яёa-z0-9])(шесть|шести|шестью)(?![а-яёa-z0-9])/gi, "6"],
    [/(?<![а-яёa-z0-9])(семь|семи|семью)(?![а-яёa-z0-9])/gi, "7"],
    [/(?<![а-яёa-z0-9])(восемь|восьми|восемью)(?![а-яёa-z0-9])/gi, "8"],
    [/(?<![а-яёa-z0-9])(девять|девяти|девятью)(?![а-яёa-z0-9])/gi, "9"],
    [/(?<![а-яёa-z0-9])(десять|десяти|десятью)(?![а-яёa-z0-9])/gi, "10"],
    [/(?<![а-яёa-z0-9])(двенадцать|двенадцати)(?![а-яёa-z0-9])/gi, "12"],
    [/(?<![а-яёa-z0-9])(пятнадцать|пятнадцати)(?![а-яёa-z0-9])/gi, "15"],
    [/(?<![а-яёa-z0-9])(двадцать|двадцати)(?![а-яёa-z0-9])/gi, "20"],
    [/(?<![а-яёa-z0-9])(двадцать\s+четыре|двадцати\s+четырех)(?![а-яёa-z0-9])/gi, "24"],
    [/(?<![а-яёa-z0-9])(тридцать|тридцати)(?![а-яёa-z0-9])/gi, "30"],
    [/(?<![а-яёa-z0-9])в\s+течении(?![а-яёa-z0-9])/gi, "в течение"],
    [/(?<![а-яёa-z0-9])(\d+)\s+раз(?:а)?\s+(?:в\s+)?12\s+месяц[а-я]*(?![а-яёa-z0-9])/gi, "$1 раз в год"]
  ];

  // Canonical meta-option classes common on Moodle / НТЦ quizzes
  const META_ALL_CORRECT_RE = /^(?:все\s+(?:ответы|варианты|способы|утверждения|пункты)\s+верны|верны\s+все\s+(?:ответы|варианты|перечисленн\S*)|(?:проверяется\s+)?все\s+(?:выше\s*)?перечисленное)$/i;
  const META_NONE_CORRECT_RE = /^(?:нет\s+(?:правильного|правильных|верного|верных)\s+ответ(?:а|ов)|ни\s+од(?:ин|ного)\s+из\s+(?:выше\s*)?(?:перечисленных|вариантов)|ничего\s+из\s+(?:выше\s*)?перечисленного)$/i;

  /**
   * Normalizes raw text:
   * - lowercases
   * - replaces ё -> е
   * - applies number words to digits mapping
   * - strips option/question numbering prefixes ("1.", "А)", "a)", "1)", "1 -", etc.)
   * - strips punctuation, collapses whitespace
   */
  function normalizeText(str) {
    if (!str || typeof str !== "string") return "";

    let text = str.toLowerCase();
    text = text.replace(/ё/g, "е");

    // Apply number words replacement (e.g. "три года" -> "3 года", "ежегодно" -> "1 раз в год")
    for (const [pattern, replacement] of NUMBER_WORD_REPLACEMENTS) {
      text = text.replace(pattern, replacement);
    }

    // 1. Protect decimal numbers ("1,3" or "1.3" -> "1_DEC_3") before stripping punctuation
    text = text.replace(/(\d+)[,.](\d+)/g, "$1_DEC_$2");

    // 2. Normalize units often written abbreviated vs full
    text = text.replace(/(\d+(?:_DEC_\d+)?)\s*(?:метр(?:а|ов)?|м\.?)(?![а-яёa-z0-9])/gi, "$1 м");

    // Strip leading numbering prefixes like "1.", "1)", "a)", "а.", "Вопрос 1:", "SPA Вопрос 2:"
    text = text.replace(/^[ \t]*(?:(?:spa|тест|билет|задание)?\s*(?:вопрос|билет)\s*\d*[\s:.-]*|№\s*\d+[\s:.-]*|(?:\d+|[a-zа-я])\s*[\.\)\-–—]\s*)/i, "");

    // Remove punctuation, retain letters, digits, _DEC_ marker and whitespace
    text = text.replace(/_DEC_/g, ".");
    text = text.replace(/[^a-zа-я0-9.\s]/gi, " ");
    // Drop dots that are not between two digits (keep decimals like 1.3)
    text = text.replace(/(?<!\d)\.|\.(?!\d)/g, " ");

    // Collapse whitespace
    return text.replace(/\s+/g, " ").trim();
  }

  /**
   * Lightweight Russian Snowball-like suffix stripper.
   * Operates safely for words with length >= 4, leaving stem of at least 3 chars.
   */
  function stemRu(word) {
    if (!word || typeof word !== "string") return "";
    word = word.toLowerCase().replace(/ё/g, "е");
    if (word.length < 4) return word;

    // Reflexive endings
    word = word.replace(/(?:ся|сь)$/, "");
    if (word.length < 4) return word;

    const suffixes = [
      // 6 chars
      "остями", "ениями",
      // 5 chars
      "остях", "остью", "ениях", "ением", "вшись", "вшийся",
      // 4 chars
      "ости", "ость", "ения", "ение", "ению", "ений", "ами", "ями", "ыми", "ими", "ому", "ему",
      "вшую", "вшем", "вших", "вшие", "ться",
      // 3 chars
      "ого", "его", "ах", "ях", "ов", "ев", "ей", "ой", "ый", "ий",
      "ая", "яя", "ое", "ее", "ые", "ие", "ия", "ию", "ом", "ем", "ам", "ям",
      "ать", "ять", "ить", "еть", "уть", "ной", "ное", "ных", "ным", "ная", "ный",
      // 2 chars
      "ть", "ти", "ла", "на", "ли", "ло", "но", "ет", "ут", "ит", "ят", "те", "ны",
      // 1 char
      "а", "е", "и", "й", "о", "у", "ы", "ь", "я"
    ];

    for (const s of suffixes) {
      if (word.endsWith(s) && word.length - s.length >= 3) {
        return word.slice(0, -s.length);
      }
    }

    return word;
  }

  /**
   * Expands key RK industrial safety acronyms & synonyms bidirectionally.
   * If acronym is found, appends full phrase; if full phrase is found, appends acronym.
   */
  function expandAbbreviations(text) {
    if (!text || typeof text !== "string") return "";

    let expanded = text.toLowerCase().replace(/ё/g, "е");

    for (const pair of ACRONYM_PAIRS) {
      let hasShort = false;
      if (pair.upperOnly) {
        const upperRegex = new RegExp(`(?<![А-ЯЁA-Z0-9])${pair.short.toUpperCase()}(?![А-ЯЁA-Z0-9])`);
        hasShort = upperRegex.test(text);
      } else {
        const shortPattern = "(?<![а-яёa-z0-9])" + pair.short.replace(/\s+/g, "\\s+") + "(?![а-яёa-z0-9])";
        const shortRegex = new RegExp(shortPattern, "i");
        hasShort = shortRegex.test(expanded);
      }

      const contentWords = pair.full.split(/\s+/).filter((w) => w.length >= 3);
      const fullPattern = contentWords.map((w) => w.slice(0, 4)).join(".{1,25}");
      const fullRegex = new RegExp(fullPattern, "i");

      const hasFull = fullRegex.test(expanded);

      if (hasShort && !hasFull) {
        expanded += " " + pair.full;
      } else if (hasFull && !hasShort) {
        expanded += " " + pair.short;
      }
    }

    return expanded;
  }

  /**
   * Tokenizes string into stemmed content tokens.
   */
  function tokenize(str) {
    if (!str || typeof str !== "string") return [];

    const expanded = expandAbbreviations(str);
    const normalized = normalizeText(expanded);
    const words = normalized.split(/\s+/).filter(Boolean);

    const tokens = [];
    for (const w of words) {
      if (/^\d+(?:\.\d+)?$/.test(w)) {
        tokens.push(w);
      } else if (/^(?:[a-f]|iv|v|iii|ii|i)$/.test(w)) {
        // Keep fire/hazard class letters (A-F) and Roman numerals (I-V) intact
        tokens.push(w);
      } else if (!RU_STOP_WORDS.has(w) && w.length >= 2) {
        tokens.push(stemRu(w));
      } else if (
        tokens.length > 0 &&
        /^[а-д]$/.test(w) &&
        (tokens[tokens.length - 1].startsWith("категор") || tokens[tokens.length - 1].startsWith("класс"))
      ) {
        tokens.push(w);
      }
    }

    return tokens;
  }

  /**
   * Computes token bigram Dice coefficient to preserve word pairing order
   */
  function bigramDice(tokensA, tokensB) {
    if (tokensA.length < 2 || tokensB.length < 2) {
      return tokenDice(tokensA, tokensB);
    }
    const mapA = new Map();
    for (let i = 0; i < tokensA.length - 1; i++) {
      const bi = tokensA[i] + "_" + tokensA[i + 1];
      mapA.set(bi, (mapA.get(bi) || 0) + 1);
    }
    const mapB = new Map();
    for (let i = 0; i < tokensB.length - 1; i++) {
      const bi = tokensB[i] + "_" + tokensB[i + 1];
      mapB.set(bi, (mapB.get(bi) || 0) + 1);
    }
    let intersection = 0;
    for (const [bi, countA] of mapA.entries()) {
      if (mapB.has(bi)) {
        intersection += Math.min(countA, mapB.get(bi));
      }
    }
    const totalA = tokensA.length - 1;
    const totalB = tokensB.length - 1;
    return (2 * intersection) / (totalA + totalB);
  }

  /**
   * Extracts key numeric codes, Roman numerals (I-V), and class/category letters (A-F, А-Д)
   */
  function extractDiscriminators(normText) {
    const nums = (normText.match(/\d+(?:\.\d+)?/g) || []).filter((n) => n !== "1");
    const romans = normText.match(/(?<![a-zа-я0-9])(?:iii|ii|iv|i|v)(?![a-zа-я0-9])/gi) || [];
    const classes = [];
    const classRegex = /(?:класс[а-я]*|категор[а-я]*)\s+([a-fа-д]\d?)(?![a-zа-я0-9])/gi;
    let m;
    while ((m = classRegex.exec(normText)) !== null) {
      classes.push(m[1].toLowerCase());
    }
    return {
      nums,
      romans: romans.map((r) => r.toLowerCase()),
      classes
    };
  }

  /**
   * Calculates character 3-gram Dice coefficient
   */
  function charTrigramDice(strA, strB) {
    const a = normalizeText(strA);
    const b = normalizeText(strB);
    if (!a || !b) return 0;
    if (a === b) return 1;

    const getTrigrams = (s) => {
      const set = new Map();
      for (let i = 0; i <= s.length - 3; i++) {
        const tri = s.slice(i, i + 3);
        set.set(tri, (set.get(tri) || 0) + 1);
      }
      return set;
    };

    const mapA = getTrigrams(a);
    const mapB = getTrigrams(b);
    if (mapA.size === 0 || mapB.size === 0) {
      return a === b ? 1 : 0;
    }

    let intersection = 0;
    let totalA = 0;
    for (const [tri, countA] of mapA.entries()) {
      totalA += countA;
      if (mapB.has(tri)) {
        intersection += Math.min(countA, mapB.get(tri));
      }
    }

    let totalB = 0;
    for (const countB of mapB.values()) {
      totalB += countB;
    }

    return (2 * intersection) / (totalA + totalB);
  }

  /**
   * Token Dice similarity between two token arrays
   */
  function tokenDice(tokensA, tokensB) {
    if (!tokensA.length || !tokensB.length) return 0;

    const setB = new Set(tokensB);
    let common = 0;
    for (const t of new Set(tokensA)) {
      if (setB.has(t)) common++;
    }

    return (2 * common) / (new Set(tokensA).size + setB.size);
  }

  /**
   * Calculates similarity between a candidate option text and a target correct answer.
   */
  function scoreOptionMatch(optionText, targetAnswer, targetKeywords = []) {
    const normOpt = normalizeText(optionText);
    const normTarget = normalizeText(targetAnswer);

    if (!normOpt || !normTarget) return 0;
    if (normOpt === normTarget) return 1.0;

    // Canonical meta-option equivalence ("Все ответы верны" <-> "Все перечисленное"; never cross-match with "Нет правильного ответа")
    const optIsAll = META_ALL_CORRECT_RE.test(normOpt);
    const targetIsAll = META_ALL_CORRECT_RE.test(normTarget);
    const optIsNone = META_NONE_CORRECT_RE.test(normOpt);
    const targetIsNone = META_NONE_CORRECT_RE.test(normTarget);
    if (optIsAll && targetIsAll) return 0.94;
    if (optIsNone && targetIsNone) return 0.94;
    if ((optIsAll && targetIsNone) || (optIsNone && targetIsAll)) return 0.01;
    if (optIsAll !== targetIsAll || optIsNone !== targetIsNone) return 0.05;

    const optDisc = extractDiscriminators(normOpt);
    const targetDisc = extractDiscriminators(normTarget);

    // Strict Roman numeral consistency check (I, II, III, IV, V)
    if (targetDisc.romans.length > 0) {
      if (optDisc.romans.length === 0) return 0.05;
      if (!targetDisc.romans.some((r) => optDisc.romans.includes(r))) return 0.05;
    } else if (optDisc.romans.length > 0 && targetDisc.romans.length === 0) {
      return 0.08;
    }

    // Strict Class / Category letter consistency check (Класс A/B/C/D/E, Категория А/Б/В/Г/Д)
    if (targetDisc.classes.length > 0 && optDisc.classes.length > 0) {
      if (!targetDisc.classes.some((c) => optDisc.classes.includes(c))) {
        return 0.05;
      }
    }

    // Strict number consistency check (ignoring standalone "1" from "1 раз", keeping decimals like "1.3")
    const optKeyNums = optDisc.nums;
    const targetKeyNums = targetDisc.nums;

    if (targetKeyNums.length > 0 && optKeyNums.length === 0) return 0.05;
    if (targetKeyNums.length === 0 && optKeyNums.length > 0) return 0.05;
    if (targetKeyNums.length > 0 && optKeyNums.length > 0) {
      if (!targetKeyNums.some((n) => optKeyNums.includes(n))) {
        return 0.05;
      }
    }

    // Check number order reversal (e.g. "2 : 30" vs "30 : 2")
    let reversedOrderPenalty = 1.0;
    if (optKeyNums.length >= 2 && targetKeyNums.length >= 2) {
      const sameSetReversed =
        optKeyNums[0] !== targetKeyNums[0] &&
        optKeyNums.slice(0, 2).every((n) => targetKeyNums.slice(0, 2).includes(n));
      if (sameSetReversed) {
        reversedOrderPenalty = 0.25;
      }
    }

    // Exact multi-char substring inclusion (after verifying discriminators agree)
    if (normTarget.includes(normOpt) || normOpt.includes(normTarget)) {
      const lenRatio = Math.min(normOpt.length, normTarget.length) / Math.max(normOpt.length, normTarget.length);
      if (reversedOrderPenalty === 1.0 && lenRatio >= 0.45) {
        return Math.min(1.0, 0.72 + 0.28 * lenRatio);
      }
    }

    // Stemmed token Dice, character trigram Dice, and token bigram Dice (captures word pairings)
    const optTokens = tokenize(normOpt);
    const targetTokens = tokenize(normTarget);
    const tokScore = tokenDice(optTokens, targetTokens);
    const triScore = charTrigramDice(normOpt, normTarget);
    const biScore = bigramDice(optTokens, targetTokens);

    let score = 0.35 * triScore + 0.45 * tokScore + 0.20 * biScore;

    // Check token containment weighted by length ratio & bigram support (prevents short/swapped subset hitting 1.0)
    if (optTokens.length > 0 && targetTokens.length > 0) {
      const targetTokenSet = new Set(targetTokens);
      const containedCount = optTokens.filter((t) => targetTokenSet.has(t)).length;
      const containmentRatio = containedCount / optTokens.length;
      const lenRatio = Math.min(optTokens.length, targetTokens.length) / Math.max(optTokens.length, targetTokens.length);
      if (containmentRatio >= 0.75 && (biScore > 0 || optTokens.length === 1 || lenRatio >= 0.6)) {
        const containmentBoost = 0.52 + 0.24 * containmentRatio + 0.16 * lenRatio;
        score = Math.max(score, containmentBoost);
      }
    }

    // Keyword boost (requires matching multiple keywords when several exist so single shared word doesn't saturate)
    if (Array.isArray(targetKeywords) && targetKeywords.length > 0) {
      let kwMatches = 0;
      for (const kw of targetKeywords) {
        const normKw = normalizeText(kw);
        if (normKw && (normOpt.includes(normKw) || normKw.includes(normOpt))) {
          kwMatches++;
        }
      }
      if (kwMatches > 0) {
        const kwRatio = kwMatches / targetKeywords.length;
        const kwBoost = targetKeywords.length === 1 ? 0.80 : (0.58 + 0.24 * kwRatio);
        score = Math.max(score, kwBoost);
      }
    }

    score *= reversedOrderPenalty;
    return Math.min(1.0, score);
  }

  const dbEntryPrepCache = typeof WeakMap !== "undefined" ? new WeakMap() : null;

  function getPreparedDbEntry(dbEntry) {
    if (dbEntryPrepCache) {
      const existing = dbEntryPrepCache.get(dbEntry);
      if (existing && existing.rawQ === dbEntry.question && existing.rawA === dbEntry.correctAnswer) {
        return existing;
      }
    }

    const qStr = dbEntry.question || "";
    const variants = Array.isArray(dbEntry.questionVariants) ? dbEntry.questionVariants : [];
    const targetAnswers = [];
    const isMultiChoiceEntry =
      Boolean(dbEntry.multiChoice) ||
      (Array.isArray(dbEntry.correctAnswers) && dbEntry.correctAnswers.length > 1);
    if (Array.isArray(dbEntry.correctAnswers) && dbEntry.correctAnswers.length > 0) {
      for (const a of dbEntry.correctAnswers) {
        if (!targetAnswers.includes(a)) targetAnswers.push(a);
      }
    } else if (dbEntry.correctAnswer) {
      targetAnswers.push(dbEntry.correctAnswer);
    }
    const answerAliases = Array.isArray(dbEntry.answerAliases)
      ? dbEntry.answerAliases.filter((a) => a && !targetAnswers.includes(a))
      : [];

    const prep = {
      rawQ: dbEntry.question,
      rawA: dbEntry.correctAnswer,
      qStr,
      qTokens: tokenize(qStr),
      qTextNorm: normalizeText(expandAbbreviations(qStr)),
      variants: variants.map((v) => ({ text: v, tokens: tokenize(v) })),
      targetAnswers,
      answerAliases,
      isMultiChoiceEntry,
      correctKeywords: Array.isArray(dbEntry.correctKeywords) ? dbEntry.correctKeywords : [],
      dbOptionsNorm: Array.isArray(dbEntry.options) ? dbEntry.options.map((o) => normalizeText(o)) : []
    };

    if (dbEntryPrepCache) {
      dbEntryPrepCache.set(dbEntry, prep);
    }
    return prep;
  }

  /**
   * Scores question match combining question text similarity and option alignment.
   * Differentiates subtle variations (e.g., "для ИТР" vs "для рабочих").
   */
  function scoreQuestionMatch(pageQuestion, pageOptions = [], dbEntry, pagePrep = null) {
    if (!pageQuestion || !dbEntry) {
      return { totalScore: 0, questionScore: 0, optionScore: 0, matchedIndices: [] };
    }

    const prep = getPreparedDbEntry(dbEntry);
    const pageTokens = pagePrep ? pagePrep.tokens : tokenize(pageQuestion);

    // 1. Question text similarity against dbEntry.question
    const qTokScore = tokenDice(pageTokens, prep.qTokens);
    const qTriScore = charTrigramDice(pageQuestion, prep.qStr);
    let bestQuestionScore = 0.55 * qTokScore + 0.45 * qTriScore;

    // Also compare against questionVariants if available
    for (const variant of prep.variants) {
      const vTokScore = tokenDice(pageTokens, variant.tokens);
      const vTriScore = charTrigramDice(pageQuestion, variant.text);
      const vScore = 0.55 * vTokScore + 0.45 * vTriScore;
      if (vScore > bestQuestionScore) {
        bestQuestionScore = vScore;
      }
    }

    // Specific discriminator penalties (e.g. ИТР vs Рабочие, Первичный vs Повторный, Инцидент vs Авария, Уровни 1-7)
    const discriminators = [
      ["итр", "руковод"],
      ["рабоч", "професс"],
      ["первичн"],
      ["повторн"],
      ["внеочередн"],
      ["целев"],
      ["вводн"],
      ["стажировк"],
      ["наряд", "допуск"],
      ["инцидент"],
      ["авари"],
      ["внутренн"],
      ["обществен"],
      ["декларац"],
      ["экспертиз"],
      ["утвержд"],
      ["согласов"],
      ["1 уровн"],
      ["2 уровн"],
      ["3 уровн"],
      ["4 уровн"],
      ["5 уровн"],
      ["6 уровн"],
      ["7 уровн"]
    ];

    const pageTextNorm = pagePrep ? pagePrep.textNorm : normalizeText(expandAbbreviations(pageQuestion));
    const dbTextNorm = prep.qTextNorm;

    for (const group of discriminators) {
      const inPage = group.some((w) => pageTextNorm.includes(w));
      const inDb = group.some((w) => dbTextNorm.includes(w));
      if (inPage !== inDb) {
        bestQuestionScore *= 0.65;
      }
    }

    // Fast bailout before expensive option comparisons if question similarity is too low
    if (bestQuestionScore < 0.22) {
      return { totalScore: bestQuestionScore * 0.4, questionScore: bestQuestionScore, optionScore: 0, matchedIndices: [] };
    }

    // 2. Option alignment score & matched correct option detection
    const matchedIndices = [];
    let bestOptionAlignment = 0;

    if (Array.isArray(pageOptions) && pageOptions.length > 0) {
      const pageOptsNorm = pagePrep ? pagePrep.optsNorm : pageOptions.map((o) => normalizeText(o));

      // Find matching option for each primary target answer
      for (const targetAns of prep.targetAnswers) {
        let bestScoreForAnswer = 0;
        let bestIndexForAnswer = -1;

        for (let i = 0; i < pageOptions.length; i++) {
          const s = scoreOptionMatch(pageOptions[i], targetAns, prep.correctKeywords);
          if (s > bestScoreForAnswer) {
            bestScoreForAnswer = s;
            bestIndexForAnswer = i;
          }
        }

        if (bestScoreForAnswer >= 0.52 && bestIndexForAnswer >= 0) {
          if (!matchedIndices.includes(bestIndexForAnswer)) {
            matchedIndices.push(bestIndexForAnswer);
          }
          if (bestScoreForAnswer > bestOptionAlignment) {
            bestOptionAlignment = bestScoreForAnswer;
          }
        }
      }

      // Single-choice fallback: if primary target did not match any option on the page,
      // evaluate alternate valid formulations (answerAliases) and keep ONLY the single best option.
      if (matchedIndices.length === 0 && !prep.isMultiChoiceEntry && prep.answerAliases.length > 0) {
        let bestAliasScore = 0;
        let bestAliasIndex = -1;
        for (const aliasAns of prep.answerAliases) {
          for (let i = 0; i < pageOptions.length; i++) {
            const s = scoreOptionMatch(pageOptions[i], aliasAns, prep.correctKeywords);
            if (s > bestAliasScore) {
              bestAliasScore = s;
              bestAliasIndex = i;
            }
          }
        }
        if (bestAliasScore >= 0.55 && bestAliasIndex >= 0) {
          matchedIndices.push(bestAliasIndex);
          bestOptionAlignment = bestAliasScore;
        }
      }

      // Check general options overlap between page and DB entry
      if (prep.dbOptionsNorm.length > 0) {
        let generalOverlapCount = 0;
        for (const dbOptNorm of prep.dbOptionsNorm) {
          if (pageOptsNorm.some((pOptNorm) => charTrigramDice(pOptNorm, dbOptNorm) >= 0.55)) {
            generalOverlapCount++;
          }
        }
        const overlapRatio = generalOverlapCount / prep.dbOptionsNorm.length;
        bestOptionAlignment = 0.7 * bestOptionAlignment + 0.3 * overlapRatio;
      }
    }

    // 3. Combined score
    let totalScore = 0;
    if (matchedIndices.length > 0) {
      totalScore = 0.58 * bestQuestionScore + 0.42 * bestOptionAlignment;
    } else {
      totalScore = bestQuestionScore * 0.40;
    }

    return {
      totalScore: Math.min(1.0, totalScore),
      questionScore: bestQuestionScore,
      optionScore: bestOptionAlignment,
      matchedIndices
    };
  }

  const RF_MARKER_RE = /(?:^|[^а-яa-z0-9])(пб\s*115(?:\.\d+)?|116[\s-]*фз|99[\s-]*фз|225[\s-]*фз|322[\s-]*фз|ростехнадзор[а-я]*|фнп|гк\s+рф|градостроительн[а-я]*\s+кодекс[а-я]*\s+рф|коап\s+рф|пп\s+рф|минтруд[а-я]*\s+рф|мчс\s+россии|российск[а-я]*\s+федерац[а-я]*|федеральн[а-я]*\s+(?:государственн[а-я]*\s+строительн|закон[а-я]*\s+от)|tests24|тесты\s*24|olimpoks|олимпокс|рубл(?:ей|я|ь)|[аб]\.\d+(?:\.\d+)?\s*\(\s*пб)(?![а-яa-z0-9])/i;
  const RK_MARKER_RE = /(?:^|[^а-яa-z0-9])(188[\s-]*v|202[\s-]*v|закон[а-я]*\s+рк|тк\s+рк|коап\s+рк|мчс\s+рк|мтсзн\s+рк|республик[а-я]*\s+казахстан[а-я]*|bilim\.qg\.kz|qazaqgaz|интергаз|тенге|казахстан[а-я]*|(?<![а-яa-z0-9])рк)(?![а-яa-z0-9])/i;
  const ENTRY_RK_NPA_RE = /(?:рк|казахстан|188-v|202-v|ица|мтсзн|мир|qazaqgaz|интергаз)/i;

  /**
   * Detects test jurisdiction ("RF" vs "RK") from page title, URL, question, and options.
   */
  function detectJurisdiction(context = {}) {
    const titleAndUrl = `${context.pageTitle || ""} ${context.pageUrl || ""}`.toLowerCase().replace(/ё/g, "е");
    const qAndOpts = `${context.questionText || ""} ${Array.isArray(context.optionTexts) ? context.optionTexts.join(" ") : ""} ${context.allText || ""}`
      .toLowerCase()
      .replace(/ё/g, "е");

    const titleRf = RF_MARKER_RE.test(titleAndUrl);
    const titleRk = RK_MARKER_RE.test(titleAndUrl);
    if (titleRf && !titleRk) return "RF";
    if (titleRk && !titleRf) return "RK";

    const qRf = RF_MARKER_RE.test(qAndOpts);
    const qRk = RK_MARKER_RE.test(qAndOpts);
    if (qRf && !qRk) return "RF";

    return "RK";
  }

  /**
   * Searches the database for the best matching question entry.
   *
   * @param {string} pageQuestion - Question text detected on page
   * @param {string[]} pageOptions - Array of detected option texts
   * @param {Object[]} dbQuestions - Database questions array
   * @param {Object} [context] - Optional page context ({ pageTitle, pageUrl, jurisdiction, allText })
   * @returns {Object|null} Match result or null
   */
  function findBestMatch(pageQuestion, pageOptions = [], dbQuestions = [], context = {}) {
    if (!pageQuestion || !Array.isArray(dbQuestions) || dbQuestions.length === 0) {
      return null;
    }

    const jurisdiction =
      context.jurisdiction ||
      detectJurisdiction({
        pageTitle: context.pageTitle,
        pageUrl: context.pageUrl,
        questionText: pageQuestion,
        optionTexts: pageOptions,
        allText: context.allText
      });

    let bestEntry = null;
    let bestScore = 0;
    let bestQScore = 0;
    let bestMatchedIndices = [];

    const pagePrep = {
      tokens: tokenize(pageQuestion),
      textNorm: normalizeText(expandAbbreviations(pageQuestion)),
      optsNorm: Array.isArray(pageOptions) ? pageOptions.map((o) => normalizeText(o)) : []
    };

    for (const entry of dbQuestions) {
      if (jurisdiction === "RF") {
        const entryJur = entry.jurisdiction || (ENTRY_RK_NPA_RE.test(entry.npaRef || "") ? "RK" : "GENERIC");
        if (entryJur === "RK") {
          continue;
        }
      }

      const { totalScore, questionScore, matchedIndices } = scoreQuestionMatch(pageQuestion, pageOptions, entry, pagePrep);

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestQScore = questionScore;
        bestEntry = entry;
        bestMatchedIndices = matchedIndices;
      }
    }

    // Strict threshold: prevent weak partial matches (~48%) from masking Live-AI or wrong-question hits
    const minTotalScore = jurisdiction === "RF" ? 0.72 : 0.56;
    const minQuestionScore = jurisdiction === "RF" ? 0.65 : 0.44;
    if (bestScore >= minTotalScore && bestQScore >= minQuestionScore && bestMatchedIndices.length > 0) {
      const matchedTexts = bestMatchedIndices.map((idx) => pageOptions[idx] || "");
      const confidence = Math.round(bestScore * 100) / 100;

      return {
        entry: bestEntry,
        jurisdiction,
        score: bestScore,
        confidence,
        confidenceLevel: bestScore >= 0.75 ? "high" : (bestScore >= 0.55 ? "medium" : "low"),
        matchedOptionIndices: bestMatchedIndices,
        matchedOptionTexts: matchedTexts
      };
    }

    return null;
  }

  const matcher = {
    normalizeText,
    stemRu,
    expandAbbreviations,
    tokenize,
    charTrigramDice,
    tokenDice,
    scoreOptionMatch,
    scoreQuestionMatch,
    detectJurisdiction,
    findBestMatch
  };

  // Export to browser window
  if (typeof window !== "undefined") {
    window.ICA_TestMatcher = matcher;
  }

  // Export to CommonJS / Node.js
  if (typeof module !== "undefined" && module.exports) {
    module.exports = matcher;
  }
})();
