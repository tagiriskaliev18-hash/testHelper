/**
 * Matcher Test Suite for 'Промбез & БИОТ РК — Помощник ИЦА'
 * Uses Node.js built-in test runner (node:test) and strict assertions (node:assert/strict).
 *
 * Run with: node --test tests/matcher.test.mjs
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const require = createRequire(import.meta.url);

// 1. Verify matcher can be loaded via Node createRequire
const matcherPath = path.join(projectRoot, "content", "matcher.js");
const matcher = require(matcherPath);

// Verify exports
const {
  normalizeText,
  stemRu,
  expandAbbreviations,
  tokenize,
  charTrigramDice,
  tokenDice,
  scoreOptionMatch,
  scoreQuestionMatch,
  findBestMatch
} = matcher;

// 2. Load questions DB (from questions_db.json, data/modules/*.json, or fallback benchmark)
let dbQuestions = [];

function loadDatabase() {
  const dbFile = path.join(projectRoot, "data", "questions_db.json");
  const modulesDir = path.join(projectRoot, "data", "modules");

  if (fs.existsSync(dbFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(dbFile, "utf-8"));
      dbQuestions = Array.isArray(data) ? data : (data.questions || []);
      if (dbQuestions.length > 0) return;
    } catch (_) {}
  }

  if (fs.existsSync(modulesDir)) {
    try {
      const files = fs.readdirSync(modulesDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const modData = JSON.parse(fs.readFileSync(path.join(modulesDir, f), "utf-8"));
        const items = Array.isArray(modData) ? modData : (modData.questions || []);
        dbQuestions.push(...items);
      }
      if (dbQuestions.length > 0) return;
    } catch (_) {}
  }

  // Self-contained reference benchmark for RK Industrial Safety
  dbQuestions = [
    {
      id: "pb-gz-002",
      question: "Что согласно Закону РК «О гражданской защите» понимается под аварией на опасном производственном объекте?",
      questionVariants: ["Дайте определение понятию «авария» по Закону РК «О гражданской защите»"],
      options: [
        "Разрушение зданий, сооружений и (или) технических устройств, неконтролируемые взрыв и (или) выброс опасных веществ",
        "Кратковременный отказ прибора учета газа без выхода вещества",
        "Любая плановая остановка технологического процесса на ремонт",
        "Нарушение работником правил внутреннего трудового распорядка"
      ],
      correctIndex: 0,
      correctAnswer: "Разрушение зданий, сооружений и (или) технических устройств, неконтролируемые взрыв и (или) выброс опасных веществ",
      correctKeywords: ["разрушение зданий", "неконтролируемые взрыв", "выброс опасных веществ"],
      npaRef: "Закон РК «О гражданской защите» № 188-V, ст. 1"
    },
    {
      id: "pb-gz-003",
      question: "Что понимается под термином «инцидент» согласно Закону РК «О гражданской защите»?",
      questionVariants: ["Определение понятия «инцидент» в области промышленной безопасности РК"],
      options: [
        "Отказ или повреждение технических устройств, применяемых на опасном производственном объекте, отклонение от режима технологического процесса",
        "Полное разрушение производственного здания с человеческими жертвами",
        "Неконтролируемый взрыв и выброс опасных веществ в атмосферу",
        "Умышленное повреждение оборудования третьими лицами"
      ],
      correctIndex: 0,
      correctAnswer: "Отказ или повреждение технических устройств, применяемых на опасном производственном объекте, отклонение от режима технологического процесса",
      correctKeywords: ["отказ или повреждение технических устройств", "отклонение от режима технологического процесса"],
      npaRef: "Закон РК «О гражданской защите» № 188-V, ст. 1"
    },
    {
      id: "pb-tk-004",
      question: "В какой срок комиссия обязана провести расследование несчастного случая на производстве по Трудовому кодексу Республики Казахстан?",
      questionVariants: ["Каков установленный ТК РК срок расследования несчастного случая на производстве?"],
      options: [
        "В течение 3 календарных дней",
        "В течение 10 рабочих дней со дня создания комиссии",
        "В течение 30 календарных дней",
        "Срок определяется исключительно работодателем"
      ],
      correctIndex: 1,
      correctAnswer: "В течение 10 рабочих дней со дня создания комиссии",
      correctKeywords: ["10 рабочих дней", "со дня создания комиссии"],
      npaRef: "Трудовой кодекс РК, ст. 188"
    },
    {
      id: "pb-gz-005",
      question: "Какова периодичность проверки знаний (подготовки и переподготовки) по вопросам промышленной безопасности для технических руководителей, специалистов и ИТР?",
      questionVariants: ["С какой периодичностью руководители и специалисты (ИТР) проходят проверку знаний по промбезопасности?"],
      options: [
        "Один раз в три года",
        "Ежегодно (один раз в год)",
        "Один раз в пять лет",
        "Один раз в шесть месяцев"
      ],
      correctIndex: 0,
      correctAnswer: "Один раз в три года",
      correctKeywords: ["один раз в три года", "раз в 3 года"],
      npaRef: "Закон РК «О гражданской защите» № 188-V, ст. 79 п. 4"
    },
    {
      id: "pb-gz-006",
      question: "Какова периодичность проверки знаний по промышленной безопасности для работников (рабочего персонала), непосредственно занятых на опасных производственных объектах?",
      options: [
        "Ежегодно (не реже одного раза в год)",
        "Один раз в три года",
        "Один раз в пять лет",
        "Только при приеме на работу"
      ],
      correctIndex: 0,
      correctAnswer: "Ежегодно (не реже одного раза в год)",
      correctKeywords: ["ежегодно", "одного раза в год"],
      npaRef: "Закон РК «О гражданской защите» № 188-V, ст. 79 п. 5"
    }
  ];
}

before(() => {
  loadDatabase();
});

describe("1. Dual Environment Export Support (Node.js & Browser window)", () => {
  test("matcher exports all required functions in Node.js environment", () => {
    assert.equal(typeof normalizeText, "function");
    assert.equal(typeof stemRu, "function");
    assert.equal(typeof expandAbbreviations, "function");
    assert.equal(typeof tokenize, "function");
    assert.equal(typeof charTrigramDice, "function");
    assert.equal(typeof tokenDice, "function");
    assert.equal(typeof scoreOptionMatch, "function");
    assert.equal(typeof scoreQuestionMatch, "function");
    assert.equal(typeof findBestMatch, "function");
  });

  test("matcher attaches to globalThis.window.ICA_TestMatcher if window is present", () => {
    const fakeWindow = {};
    const code = fs.readFileSync(matcherPath, "utf-8");
    const runInContext = new Function("window", "module", code);
    const mockModule = { exports: {} };
    runInContext(fakeWindow, mockModule);

    assert.ok(fakeWindow.ICA_TestMatcher);
    assert.equal(typeof fakeWindow.ICA_TestMatcher.findBestMatch, "function");
    assert.equal(typeof mockModule.exports.findBestMatch, "function");
  });
});

describe("2. Normalization, Stemming & Linguistic Equivalence", () => {
  test("normalizes 'ё' to 'е', strips punctuation, and handles prefixes", () => {
    const raw1 = "  1. Что является «ОПО» по Закону РК?!  ";
    assert.equal(normalizeText(raw1), "что является опо по закону рк");

    const raw2 = "  Вопрос 12: Каковы требования Промбезопасности?  ";
    assert.equal(normalizeText(raw2), "каковы требования промбезопасности");
  });

  test("converts Russian number words into numeric strings", () => {
    assert.equal(normalizeText("три года"), "3 года");
    assert.equal(normalizeText("десять рабочих дней"), "10 рабочих дней");
    assert.equal(normalizeText("ежегодно"), "1 раз в год");
  });

  test("stems Russian grammatical inflections correctly", () => {
    const stem1 = stemRu("трудовой");
    const stem2 = stemRu("трудовая");
    const stem3 = stemRu("трудовые");
    assert.equal(stem1, stem2);
    assert.equal(stem2, stem3);

    const stemP1 = stemRu("промышленный");
    const stemP2 = stemRu("промышленная");
    assert.equal(stemP1, stemP2);
  });

  test("expands RK safety acronyms bidirectionally", () => {
    const exp1 = expandAbbreviations("Правила эксплуатации ОПО");
    assert.ok(exp1.includes("опасный производственный объект"));

    const exp2 = expandAbbreviations("Магистральный газопровод высокого давления");
    assert.ok(exp2.includes("мг"));

    const exp3 = expandAbbreviations("Требования БиОТ на предприятии");
    assert.ok(exp3.includes("безопасность и охрана труда"));
  });
});

describe("3. Exact Question Matching", () => {
  test("finds exact match for Civil Protection Law accident definition", () => {
    const pageQ = "Что согласно Закону РК «О гражданской защите» понимается под аварией на опасном производственном объекте?";
    const pageOpts = [
      "Разрушение зданий, сооружений и (или) технических устройств, неконтролируемые взрыв и (или) выброс опасных веществ",
      "Кратковременный отказ прибора учета газа без выхода вещества",
      "Любая плановая остановка технологического процесса на ремонт",
      "Нарушение работником правил внутреннего трудового распорядка"
    ];

    const match = findBestMatch(pageQ, pageOpts, dbQuestions);
    assert.ok(match, "Match must not be null");
    assert.equal(match.confidenceLevel, "high");
    assert.ok(match.confidence >= 0.85);
    assert.deepEqual(match.matchedOptionIndices, [0]);
  });

  test("finds exact match for labor code accident investigation timeframe", () => {
    const pageQ = "В какой срок комиссия обязана провести расследование несчастного случая на производстве по Трудовому кодексу Республики Казахстан?";
    const pageOpts = [
      "В течение 3 календарных дней",
      "В течение 10 рабочих дней со дня создания комиссии",
      "В течение 30 календарных дней",
      "Срок определяется исключительно работодателем"
    ];

    const match = findBestMatch(pageQ, pageOpts, dbQuestions);
    assert.ok(match);
    assert.deepEqual(match.matchedOptionIndices, [1]);
    assert.ok(match.matchedOptionTexts[0].includes("10 рабочих дней"));
  });
});

describe("4. Paraphrased and Inflected Russian Question Matching", () => {
  test("matches paraphrased question with different word order and case endings", () => {
    const pageQ = "По Закону О гражданской защите РК дайте определение термину авария на ОПО?";
    const pageOpts = [
      "1) Разрушение зданий, сооружений, неконтролируемый взрыв либо выброс опасного вещества",
      "2) Любая поломка насоса",
      "3) Плановое ТО компрессора",
      "4) Опоздание на смену"
    ];

    const match = findBestMatch(pageQ, pageOpts, dbQuestions);
    assert.ok(match, "Must match paraphrased question");
    assert.deepEqual(match.matchedOptionIndices, [0]);
  });

  test("matches question containing acronym ОПО instead of full words", () => {
    const pageQ = "Что понимается под термином инцидент на ОПО согласно Закону РК О гражданской защите?";
    const pageOpts = [
      "А. Отказ или повреждение технических устройств на ОПО, отклонение от технологического режима",
      "Б. Полная гибель людей",
      "В. Взрыв резервуара с газом"
    ];

    const match = findBestMatch(pageQ, pageOpts, dbQuestions);
    assert.ok(match);
    assert.deepEqual(match.matchedOptionIndices, [0]);
  });
});

describe("5. Disambiguating Similar Questions via Option Alignment", () => {
  test("correctly selects 3 years for ИТР question and 1 year for workers question", () => {
    const qITR = "С какой периодичностью проводится проверка знаний по промышленной безопасности руководящих работников и специалистов (ИТР)?";
    const qWorkers = "С какой периодичностью рабочие и производственный персонал опасных производственных объектов проходят проверку знаний по безопасности и охране труда?";

    const commonOptions = [
      "Один раз в три года",
      "Ежегодно (один раз в год)",
      "Один раз в пять лет"
    ];

    // 1. For ITR: MUST match Option 0 ("Один раз в три года")
    const matchITR = findBestMatch(qITR, commonOptions, dbQuestions);
    assert.ok(matchITR, "ITR question must match");
    assert.deepEqual(matchITR.matchedOptionIndices, [0]);
    assert.ok(matchITR.matchedOptionTexts[0].includes("три года") || matchITR.matchedOptionTexts[0].includes("3 года"));

    // 2. For Workers: MUST match Option 1 ("Ежегодно (один раз в год)")
    const matchWorkers = findBestMatch(qWorkers, commonOptions, dbQuestions);
    assert.ok(matchWorkers, "Workers question must match");
    assert.deepEqual(matchWorkers.matchedOptionIndices, [1]);
    assert.ok(matchWorkers.matchedOptionTexts[0].includes("Ежегодно") || matchWorkers.matchedOptionTexts[0].includes("год"));
  });

  test("disambiguates between 'Авария' and 'Инцидент' based on specific definitions", () => {
    const qAvariya = "Что согласно Закону РК «О гражданской защите» понимается под аварией на опасном производственном объекте?";
    const qIncident = "Что понимается под термином «инцидент» согласно Закону РК «О гражданской защите»?";

    const sharedOptions = [
      "Разрушение зданий, сооружений и технических устройств, неконтролируемые взрыв и выброс опасных веществ",
      "Отказ или повреждение технических устройств, применяемых на опасном производственном объекте, отклонение от режима технологического процесса",
      "Плановый текущий ремонт запорной арматуры"
    ];

    const matchAvariya = findBestMatch(qAvariya, sharedOptions, dbQuestions);
    assert.ok(matchAvariya);
    assert.deepEqual(matchAvariya.matchedOptionIndices, [0], "Авария must match разрушение/взрыв");

    const matchIncident = findBestMatch(qIncident, sharedOptions, dbQuestions);
    assert.ok(matchIncident);
    assert.deepEqual(matchIncident.matchedOptionIndices, [1], "Инцидент must match отказ устройств/отклонение");
  });
});

describe("6. Numeric and Word Equivalence in Questions & Options", () => {
  test("equates verbal numbers 'десять рабочих дней' with numeric '10 рабочих дней'", () => {
    const target = "В течение 10 рабочих дней со дня создания комиссии";
    const candidate = "В течение десяти рабочих дней";
    const score = scoreOptionMatch(candidate, target, ["10 рабочих дней"]);
    assert.ok(score >= 0.75, `Expected score >= 0.75, got ${score}`);
  });

  test("equates '30 к 2' with '30 компрессий к двум вдохам'", () => {
    const target = "30 компрессий к 2 вдохам (30:2)";
    const candidate = "30 компрессий к двум вдохам";
    const score = scoreOptionMatch(candidate, target, ["30 компрессий", "2 вдоха"]);
    assert.ok(score >= 0.75, `Expected score >= 0.75, got ${score}`);
  });

  test("penalizes conflicting numbers (e.g. 5 лет vs 3 года)", () => {
    const target = "Не реже 1 раза в 3 года";
    const candidateWrong = "Не реже 1 раза в 5 лет";
    const candidateRight = "Не реже 1 раза в 3 года";

    const scoreWrong = scoreOptionMatch(candidateWrong, target);
    const scoreRight = scoreOptionMatch(candidateRight, target);

    assert.ok(scoreRight > scoreWrong * 2, `Right (${scoreRight}) must be much higher than wrong (${scoreWrong})`);
  });
});

describe("7. Zero False Positives on Unrelated Questions", () => {
  test("returns null for completely unrelated culinary question", () => {
    const unrelatedQ = "Какая оптимальная температура варки классического украинского борща?";
    const unrelatedOpts = [
      "100 градусов Цельсия на медленном огне",
      "250 градусов под давлением",
      "Борщ не варят, а настаивают в холодильнике"
    ];

    const match = findBestMatch(unrelatedQ, unrelatedOpts, dbQuestions);
    assert.equal(match, null, "Unrelated question MUST NOT produce a match");
  });

  test("returns null for general astronomy question", () => {
    const unrelatedQ = "Какое расстояние от планеты Земля до естественного спутника Луны?";
    const unrelatedOpts = [
      "Примерно 384 400 километров",
      "50 метров от оси",
      "10 рабочих дней"
    ];

    const match = findBestMatch(unrelatedQ, unrelatedOpts, dbQuestions);
    assert.equal(match, null, "Must not false positive on numerical fragments");
  });

  test("returns null when options contain no matching answer to the question", () => {
    const q = "С какой высоты начинаются работы на высоте по нормам РК?";
    const wrongOpts = [
      "С глубины 5 метров",
      "Только при погружении под воду",
      "При полетах на самолете"
    ];

    const match = findBestMatch(q, wrongOpts, dbQuestions);
    assert.equal(match, null, "Must return null when valid answers are missing");
  });
});

describe("8. Corporate ИЦА / НТЦ QazaqGaz (bilim.qg.kz) Quiz Patterns & Safeguards", () => {
  test("matches frequency '1 раз в 12 месяцев' against 'ежегодно' / '1 раз в год'", () => {
    const score = scoreOptionMatch("не реже 1 раза в 12 месяцев", "ежегодно");
    assert.ok(score >= 0.80, `Expected score >= 0.80, got ${score}`);
  });

  test("equates 'Все ответы верны' <-> 'Все перечисленное' without crossing 'Нет правильного ответа'", () => {
    assert.ok(scoreOptionMatch("Все перечисленное", "Все ответы верны") >= 0.90);
    assert.ok(scoreOptionMatch("Ничего из перечисленного", "Нет правильного ответа") >= 0.90);
    assert.ok(scoreOptionMatch("Нет правильного ответа", "Все ответы верны") <= 0.05);
  });

  test("discriminates ICA production control levels (1-го vs 4-го уровня)", () => {
    const qLevel1 = "Сроки проведения проверки состояния промышленной безопасности 1-го уровня контроля в Обществе согласно требованиям Положения о производственном контроле?";
    const qLevel4 = "Сроки проведения проверки состояния промышленной безопасности 4-го уровня контроля в Обществе согласно требованиям Положения о производственном контроле?";
    const opts = ["один раз в неделю", "один раз в квартал", "один раз в полугодие", "один раз в год"];

    const m1 = findBestMatch(qLevel1, opts, dbQuestions);
    assert.ok(m1, "Level 1 control question must match");
    assert.deepEqual(m1.matchedOptionIndices, [0]);

    const m4 = findBestMatch(qLevel4, opts, dbQuestions);
    assert.ok(m4, "Level 4 control question must match");
    assert.deepEqual(m4.matchedOptionIndices, [2]);
  });

  test("matches answerAliases fallback for legacy vs 2024 accident investigation deadline", () => {
    const q = "Каков срок проведения расследования аварии?";
    const legacyOpts = [
      "не позднее десяти рабочих дней с даты его назначения",
      "не позднее пятнадцати календарных дней с даты его назначения",
      "не позднее пятнадцати рабочих дней с даты его назначения",
      "не позднее трех рабочих дней с даты его назначения"
    ];
    const currentOpts = [
      "не позднее десяти рабочих дней с даты его назначения",
      "не позднее тридцати календарных дней с даты назначения комиссии по расследованию аварии",
      "не позднее пятнадцати рабочих дней с даты его назначения"
    ];

    const mLegacy = findBestMatch(q, legacyOpts, dbQuestions);
    assert.ok(mLegacy, "Legacy option set must match via answerAliases");
    assert.deepEqual(mLegacy.matchedOptionIndices, [2]);

    const mCurrent = findBestMatch(q, currentOpts, dbQuestions);
    assert.ok(mCurrent, "2024 option set must prefer primary 30 calendar days");
    assert.deepEqual(mCurrent.matchedOptionIndices, [1]);
  });

  test("matches ICA '9 Жизненно важных правил' and 'Нет правильного ответа' traps", () => {
    const qRules = "9 Жизненно важных правил «Обход мер безопасности»?";
    const optsRules = [
      "Я использую Критическое оборудование для безопасности и процедуры, относящиеся к выполняемой задаче",
      "Я работаю без оформления наряда-допуска в экстренных ситуациях",
      "Я отключаю блокировки только по устному разрешению"
    ];
    const mRules = findBestMatch(qRules, optsRules, dbQuestions);
    assert.ok(mRules, "9 Жизненно важных правил must match");
    assert.deepEqual(mRules.matchedOptionIndices, [0]);

    const qTrap = "Какие организации проводят экспертизу декларации промышленной безопасности опасного производственного объекта?";
    const optsTrap = [
      "Аттестованные экспертные организации",
      "Территориальное подразделение уполномоченного органа",
      "Нет правильного ответа",
      "Профессиональная аварийно-спасательная служба"
    ];
    const mTrap = findBestMatch(qTrap, optsTrap, dbQuestions);
    assert.ok(mTrap, "Trap question must match");
    assert.deepEqual(mTrap.matchedOptionIndices, [2]);
  });
});

describe("9. Jurisdiction Isolation & False-Positive Prevention (RF ПБ 115.27 vs RK)", () => {
  test("detects RF jurisdiction from ПБ 115.27 / Тесты 24 / Ростехнадзор context", () => {
    assert.equal(typeof matcher.detectJurisdiction, "function");
    assert.equal(
      matcher.detectJurisdiction({
        pageTitle: "Тест: А.1 (ПБ 115.27) Основы промышленной безопасности / Тесты 24",
        pageUrl: "https://tests24.ru/test/199"
      }),
      "RF"
    );
    assert.equal(
      matcher.detectJurisdiction({
        pageTitle: "Промышленная безопасность РК",
        pageUrl: "https://bilim.qg.kz/mod/quiz/attempt.php"
      }),
      "RK"
    );
  });

  test("rejects low-confidence RK DB false match (48%) on RF incident commission question", () => {
    const qRfIncident =
      "1) На основании какого распорядительного акта создается комиссия для технического расследования причин инцидентов? Выберите правильный вариант ответа.";
    const optsRfIncident = [
      "Распорядительного акта технического руководителя организации, эксплуатирующей объект",
      "Распорядительного акта руководителя аварийно-спасательного формирования",
      "Распорядительного акта руководителя организации, эксплуатирующей объект",
      "Распорядительного акта территориального органа Ростехнадзора"
    ];

    const matchWithCtx = findBestMatch(qRfIncident, optsRfIncident, dbQuestions, {
      pageTitle: "Тест: А.1 (ПБ 115.27) Основы промышленной безопасности / Тесты 24"
    });
    assert.equal(matchWithCtx, null, "Must NOT return an RK DB match for RF test");

    const matchWithoutCtx = findBestMatch(qRfIncident, optsRfIncident, dbQuestions);
    assert.equal(matchWithoutCtx, null, "Must NOT return weak 48% match even without pageTitle");
  });
});
