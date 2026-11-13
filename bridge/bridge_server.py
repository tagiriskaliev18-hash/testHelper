#!/usr/bin/env python3
"""
Local Multi-Model Live AI Bridge Server for 'Промбез & БИОТ РК — Помощник ИЦА'.
Listens on 127.0.0.1:8765 using pure Python stdlib (no pip dependencies).

Resolution order:
  1. Verified 400-question RK database exact/fuzzy match
  2. Deterministic RK legislation regex knowledge rules
  3. Configured external API keys (OPENAI_API_KEY / GEMINI_API_KEY)
  4. Concurrent Multi-Model AI (Pollinations GPT-OSS-20B + Local Ollama Qwen3/MindAI)
"""

from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn

HOST = "127.0.0.1"
PORT = 8765
BRIDGE_DIR = Path(__file__).resolve().parent
DB_PATH = BRIDGE_DIR.parent / "data" / "questions_db.json"
CACHE_PATH = BRIDGE_DIR / "ai_cache.json"
LOG_PATH = BRIDGE_DIR / "bridge.log"
CACHE_VERSION = "v2"

POLLINATIONS_URL = "https://text.pollinations.ai/openai"
OLLAMA_BASE_URL = "http://127.0.0.1:11434"
CLAUDE_BIN = shutil.which("claude")
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

RF_MARKER_RE = re.compile(
    r"(?<![а-яa-z0-9])("
    r"пб\s*115(?:\.\d+)?|116[\s-]*фз|99[\s-]*фз|225[\s-]*фз|322[\s-]*фз|"
    r"ростехнадзор[а-я]*|фнп|гк\s+рф|градостроительн[а-я]*\s+кодекс[а-я]*\s+рф|"
    r"коап\s+рф|пп\s+рф|минтруд[а-я]*\s+рф|мчс\s+россии|российск[а-я]*\s+федерац[а-я]*|"
    r"федеральн[а-я]*\s+(?:государственн[а-я]*\s+строительн|закон[а-я]*\s+от)|"
    r"tests24|тесты\s*24|olimpoks|олимпокс|рубл(?:ей|я|ь)|[аб]\.\d+(?:\.\d+)?\s*\(\s*пб"
    r")(?![а-яa-z0-9])",
    re.IGNORECASE,
)
RK_MARKER_RE = re.compile(
    r"(?<![а-яa-z0-9])("
    r"188[\s-]*v|202[\s-]*v|закон[а-я]*\s+рк|тк\s+рк|коап\s+рк|мчс\s+рк|мтсзн\s+рк|"
    r"республик[а-я]*\s+казахстан[а-я]*|bilim\.qg\.kz|qazaqgaz|интергаз|тенге|казахстан[а-я]*|рк"
    r")(?![а-яa-z0-9])",
    re.IGNORECASE,
)


def detect_jurisdiction(
    question: str = "",
    options: list[str] | None = None,
    page_title: str = "",
    page_url: str = "",
    explicit: str | None = None,
) -> str:
    if explicit in ("RF", "RK"):
        return explicit
    title_url = f"{page_title} {page_url}".lower().replace("ё", "е")
    q_opts = f"{question} {' '.join(options or [])}".lower().replace("ё", "е")
    if RF_MARKER_RE.search(title_url) and not RK_MARKER_RE.search(title_url):
        return "RF"
    if RK_MARKER_RE.search(title_url) and not RF_MARKER_RE.search(title_url):
        return "RK"
    if RF_MARKER_RE.search(q_opts) and not RK_MARKER_RE.search(q_opts):
        return "RF"
    return "RK"

handlers = [logging.StreamHandler()]
try:
    handlers.append(logging.FileHandler(LOG_PATH, encoding="utf-8"))
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=handlers,
)
logger = logging.getLogger("BridgeServer")


def _load_db_questions() -> list[dict]:
    if not DB_PATH.exists():
        return []
    try:
        data = json.loads(DB_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else data.get("questions", [])
    except Exception as e:
        logger.warning(f"Failed to load questions_db.json: {e}")
        return []


def _load_disk_cache() -> dict[str, dict]:
    if not CACHE_PATH.exists():
        return {}
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_disk_cache(cache: dict[str, dict]):
    try:
        # Cap persistent cache at 1000 solved entries
        if len(cache) > 1000:
            trimmed = dict(list(cache.items())[-1000:])
        else:
            trimmed = cache
        CACHE_PATH.write_text(json.dumps(trimmed, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning(f"Failed to persist cache: {e}")


DB_QUESTIONS = _load_db_questions()
SOLVE_CACHE_LOCK = threading.Lock()
SOLVE_CACHE: dict[str, dict] = _load_disk_cache()
POLLINATIONS_LOCK = threading.Lock()
POLLINATIONS_COOLDOWN_UNTIL = 0.0


KNOWLEDGE_RULES = [
    {
        "patterns": [r"авари[яиеей]", r"разрушени[ея]", r"неконтролируем[а-я]+ взрыв", r"выброс"],
        "negative": [r"инцидент"],
        "answer_pattern": r"разрушени[ея].*сооружени[йя]|неконтролируем[а-я]+ взрыв|выброс опасных веществ",
        "npa": "Закон РК «О гражданской защите» № 188-V, ст. 1 п. 1",
        "explanation": "Авария — разрушение зданий, сооружений и (или) технических устройств на ОПО, неконтролируемые взрыв и (или) выброс опасных веществ."
    },
    {
        "patterns": [r"инцидент"],
        "negative": [r"авари[яиеей]"],
        "answer_pattern": r"отказ или повреждение|отклонение от режима технологического процесса",
        "npa": "Закон РК «О гражданской защите» № 188-V, ст. 1 п. 29",
        "explanation": "Инцидент — отказ или повреждение технических устройств, отклонение от параметров технологического процесса без перехода в аварию."
    },
    {
        "patterns": [r"расследовани[ея].*несчастн[а-я]+ случа[яеи]", r"срок.*расследовани[яе]"],
        "negative": [r"продлен"],
        "answer_pattern": r"10\s*рабочих\s*дней|десять\s*рабочих\s*дней",
        "npa": "Трудовой кодекс РК, статья 189 п. 1",
        "explanation": "Расследование несчастного случая проводится комиссией в течение 10 рабочих дней со дня ее создания."
    },
    {
        "patterns": [r"работ[а-я]* на высоте", r"высот[а-я]*.*свыше|от каков[а-я]+ высот[а-я]*|с каков[а-я]+ высот"],
        "negative": [],
        "answer_pattern": r"1[,.]3\s*м|1[,.]3\s*метр|ограждени[а-я]* менее 1[,.]1\s*м",
        "npa": "Приказ МТСЗН РК № 109 (Правила работы на высоте)",
        "explanation": "Работы на высоте в РК начинаются при нахождении работника на высоте 1,3 м и более на расстоянии менее 2 м от перепада по высоте."
    },
    {
        "patterns": [r"охранн[а-я]+ зон[а-я].*магистральн[а-я]+ газопровод", r"охранн[а-я]+ зон[а-я].*газопровод[а-я]*"],
        "negative": [r"суг", r"сжиженн", r"конденсат", r"сельскохоз"],
        "answer_pattern": r"50\s*м|50\s*метр|25\s*м.*кабел",
        "npa": "Закон РК «О магистральном трубопроводе», ст. 14",
        "explanation": "Охранная зона магистрального газопровода — 50 м от оси трубопровода с каждой стороны (25 м на землях сельхозназначения)."
    },
    {
        "patterns": [r"сердечно-легочн[а-я]+ реанимаци[яие]|слр", r"компресси[а-я]*.*вдох|надавливан.*вдох"],
        "negative": [],
        "answer_pattern": r"30\s*[:кк]\s*2|30\s*компрессий.*2\s*вдоха|30\s*надавливан.*2\s*вдох",
        "npa": "Базовый алгоритм СЛР (BLS / Минздрав РК)",
        "explanation": "Соотношение надавливаний на грудину и вдохов при СЛР взрослому — 30:2."
    },
    {
        "patterns": [r"проверк[а-я]* знани[йя].*(?:итр|руководител[а-я]* и специалист[а-я]*)"],
        "negative": [r"рабочи[а-я]*"],
        "answer_pattern": r"1 раз в 3 года|раз в 3 года|один раз в три года|не реже одного раза в 3 года",
        "npa": "Закон РК «О гражданской защите» № 188-V, ст. 79 п. 4",
        "explanation": "Проверка знаний по промбезопасности технических руководителей, специалистов и ИТР проводится раз в 3 года."
    },
    {
        "patterns": [r"проверк[а-я]* знани[йя].*рабочи[а-я]*|производственн[а-я]+ персонал"],
        "negative": [r"итр", r"руководител"],
        "answer_pattern": r"1 раз в год|ежегодно|один раз в год",
        "npa": "Закон РК «О гражданской защите» № 188-V, ст. 79 п. 5",
        "explanation": "Проверка знаний рабочих ОПО проводится ежегодно."
    }
]


def _norm_tokens(text: str) -> set[str]:
    cleaned = re.sub(r"[^a-zа-яё0-9\s]", " ", text.lower().replace("ё", "е"))
    return {t for t in cleaned.split() if len(t) >= 2}


def solve_with_db(question: str, options: list[str], jurisdiction: str = "RK", is_multi_choice: bool = False) -> dict | None:
    if not DB_QUESTIONS or is_multi_choice:
        return None
    # Bundled DB covers RK legislation & ICA standards; never leak RK-only answers into RF tests
    if jurisdiction == "RF":
        return None
    q_tokens = _norm_tokens(question)
    if not q_tokens:
        return None

    best_entry = None
    best_q_score = 0.0
    for entry in DB_QUESTIONS:
        if entry.get("multiChoice"):
            continue
        candidates = [entry.get("question", "")] + (entry.get("questionVariants") or [])
        for cand in candidates:
            c_tokens = _norm_tokens(cand)
            if not c_tokens:
                continue
            dice = (2.0 * len(q_tokens & c_tokens)) / (len(q_tokens) + len(c_tokens))
            if dice > best_q_score:
                best_q_score = dice
                best_entry = entry

    if not best_entry or best_q_score < 0.70:
        return None

    candidate_answers = [best_entry.get("correctAnswer", "")] + list(best_entry.get("answerAliases") or [])
    candidate_answers = [a for a in candidate_answers if a]
    best_idx = -1
    best_opt_score = 0.0
    for target_ans in candidate_answers:
        ans_tokens = _norm_tokens(target_ans)
        if not ans_tokens:
            continue
        cur_idx = -1
        cur_score = 0.0
        for idx, opt in enumerate(options):
            o_tokens = _norm_tokens(opt)
            if not o_tokens:
                continue
            opt_dice = (2.0 * len(ans_tokens & o_tokens)) / (len(ans_tokens) + len(o_tokens))
            if opt_dice > cur_score:
                cur_score = opt_dice
                cur_idx = idx
        if cur_idx >= 0 and cur_score >= 0.62:
            best_idx = cur_idx
            best_opt_score = cur_score
            break

    if best_idx >= 0 and best_opt_score >= 0.62:
        return {
            "matchedOptionIndex": best_idx,
            "matchedOptionIndices": [best_idx],
            "matchedOptionText": options[best_idx],
            "confidence": round(min(0.99, 0.55 * best_q_score + 0.45 * best_opt_score), 2),
            "consensus": best_entry.get("consensus", "Верифицировано НПА РК"),
            "npaRef": best_entry.get("npaRef", ""),
            "explanation": best_entry.get("npaRef", ""),
            "source": "live-ai-bridge"
        }
    return None


def solve_with_rules(question: str, options: list[str], jurisdiction: str = "RK") -> dict | None:
    if jurisdiction == "RF":
        return None
    q_lower = question.lower()
    for rule in KNOWLEDGE_RULES:
        if not all(re.search(pat, q_lower) for pat in rule["patterns"]):
            continue
        if any(re.search(neg, q_lower) for neg in rule["negative"]):
            continue
        ans_regex = re.compile(rule["answer_pattern"], re.IGNORECASE)
        for idx, opt in enumerate(options):
            if ans_regex.search(opt):
                return {
                    "matchedOptionIndex": idx,
                    "matchedOptionIndices": [idx],
                    "matchedOptionText": opt,
                    "confidence": 0.96,
                    "consensus": "Норма РК (Правила моста)",
                    "npaRef": rule["npa"],
                    "explanation": rule["explanation"],
                    "source": "live-ai-bridge"
                }
    return None


def _jurisdiction_expert_header(jurisdiction: str) -> str:
    if jurisdiction == "RF":
        return (
            "Ты ведущий эксперт по промышленной безопасности и охране труда Российской Федерации "
            "(116-ФЗ «О промышленной безопасности ОПО», 225-ФЗ «Об обязательном страховании...» в ред. 322-ФЗ, "
            "99-ФЗ «О лицензировании», Градостроительный кодекс РФ, КоАП РФ, ПП РФ № 1437, ПП РФ № 1365 / № 13, "
            "ПП РФ № 1477 / № 1540, Приказы и ФНП Ростехнадзора № 503, № 536, экзамен А.1 ПБ 115.27). "
            "Отвечай СТРОГО по законодательству РФ, НЕ ссылайся на законы РК. "
            "Внимательно проверяй точные числа, сроки, органы надзора (Ростехнадзор) и количество верных вариантов."
        )
    return (
        "Ты ведущий эксперт по промышленной безопасности (Промбез) и БиОТ Республики Казахстан "
        "(Закон РК «О гражданской защите» № 188-V, Трудовой кодекс РК, Закон РК «О разрешениях и уведомлениях» № 202-V, "
        "Правила МЧС/МИР/МТСЗН/Минэнерго РК, стандарты АО «Интергаз Центральная Азия» / QazaqGaz). "
        "Отвечай СТРОГО по действующему законодательству РК. Внимательно различай точные термины "
        "(поверка манометра vs проверка контрольным манометром, ИТР раз в 3 года vs рабочие ежегодно, приостановление vs лишение лицензии)."
    )


def _build_llm_prompts(
    question: str,
    options: list[str],
    page_title: str = "",
    is_multi_choice: bool = False,
    jurisdiction: str = "RK",
) -> tuple[str, str]:
    multi_instr = (
        'Если вопрос требует несколько верных ответов (чекбоксы или указано «выберите два/три/несколько/все»), '
        'верни ВСЕ верные 0-based индексы в "matchedOptionIndices": [<индексы>] и первый в "matchedOptionIndex". '
        'Никогда не оставляй массив пустым.'
        if is_multi_choice
        else "Выбери строго ОДИН наиболее точный 0-based индекс правильного варианта ответа (никогда не оставляй пустым)."
    )
    system_prompt = (
        f"{_jurisdiction_expert_header(jurisdiction)} "
        f"{multi_instr} "
        "Ответь СТРОГО валидным JSON без markdown-обрамления (сначала краткая точная норма права в law, затем индексы): "
        '{"law": "<НПА, статья и ключевое число/факт>", '
        '"matchedOptionIndex": <целое число 0..' + str(max(len(options) - 1, 0)) + '>, '
        '"matchedOptionIndices": [<индексы>], '
        '"matchedOptionText": "<точный текст выбранного варианта>", '
        '"confidence": <число 0.7..0.99>, '
        '"npaRef": "<НПА / статья>", '
        '"explanation": "<краткое обоснование>"}'
    )
    opts_block = "\n".join(f"{i}: {opt}" for i, opt in enumerate(options))
    ctx = f"Контекст страницы ({jurisdiction}): {page_title}\n" if page_title else f"Юрисдикция: {jurisdiction}\n"
    user_prompt = f"{ctx}Вопрос: {question}\n\nВарианты ответов:\n{opts_block}"
    return system_prompt, user_prompt


def _build_batch_llm_prompts(
    items: list[dict],
    page_title: str = "",
    jurisdiction: str = "RK",
) -> tuple[str, str]:
    system_prompt = (
        f"{_jurisdiction_expert_header(jurisdiction)} "
        "Реши ВСЕ вопросы ниже. Для каждого вопроса с multi=true верни ВСЕ верные 0-based индексы в matchedOptionIndices "
        "(если в тексте вопроса сказано «два» или «три», верни ровно столько индексов). Для multi=false верни ровно 1 индекс. "
        "Никогда не оставляй matchedOptionIndices пустым — выбирай лучший вариант из предложенных. "
        "Ответь СТРОГО валидным JSON-массивом без markdown, с кратким полем law ПЕРЕД индексами: "
        '[{"id": <int>, "law": "<НПА и ключевая норма>", "matchedOptionIndices": [<0-based ints>], "confidence": 0.92, "npaRef": "<НПА / статья>"}]'
    )
    payload = [
        {
            "id": it["id"],
            "multi": bool(it.get("isMultiChoice", False)),
            "q": it["question"],
            "opts": it["options"],
        }
        for it in items
    ]
    ctx = f"Контекст ({jurisdiction}): {page_title}\n" if page_title else f"Юрисдикция: {jurisdiction}\n"
    user_prompt = ctx + "Вопросы:\n" + json.dumps(payload, ensure_ascii=False)
    return system_prompt, user_prompt


def _extract_json_array(raw_text: str) -> list[dict] | None:
    if not raw_text:
        return None
    cleaned = re.sub(r"<think>.*?</think>", "", raw_text, flags=re.DOTALL | re.IGNORECASE).strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE | re.MULTILINE).strip()
    try:
        arr = json.loads(cleaned)
        if isinstance(arr, list):
            return [x for x in arr if isinstance(x, dict)]
    except Exception:
        pass
    decoder = json.JSONDecoder()
    for i, ch in enumerate(cleaned):
        if ch == "[":
            try:
                arr, _ = decoder.raw_decode(cleaned[i:])
                if isinstance(arr, list):
                    return [x for x in arr if isinstance(x, dict)]
            except Exception:
                continue
    return None


def _extract_json_object(raw_text: str) -> dict | None:
    if not raw_text:
        return None
    cleaned = re.sub(r"<think>.*?</think>", "", raw_text, flags=re.DOTALL | re.IGNORECASE).strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE | re.MULTILINE).strip()
    try:
        obj = json.loads(cleaned)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    decoder = json.JSONDecoder()
    for i, ch in enumerate(cleaned):
        if ch == "{":
            try:
                obj, _ = decoder.raw_decode(cleaned[i:])
                if isinstance(obj, dict) and ("matchedOptionIndex" in obj or "matchedOptionIndices" in obj):
                    return obj
            except Exception:
                continue
    return None


def _normalize_llm_choice(
    parsed: dict,
    options: list[str],
    model_label: str,
    is_multi_choice: bool = False,
    jurisdiction: str = "RK",
) -> dict | None:
    if not parsed or not options:
        return None

    indices: list[int] = []
    raw_indices = parsed.get("matchedOptionIndices")
    if isinstance(raw_indices, list) and (is_multi_choice or parsed.get("matchedOptionIndex") is None):
        for item in raw_indices:
            try:
                n = int(item)
                if 0 <= n < len(options) and n not in indices:
                    indices.append(n)
            except Exception:
                continue

    idx = parsed.get("matchedOptionIndex")
    if isinstance(idx, str) and idx.strip().lstrip("-").isdigit():
        idx = int(idx.strip())

    # Cross-check matchedOptionText in case a model returned a 1-based index
    declared_text = str(parsed.get("matchedOptionText") or "").strip().lower()
    if declared_text and not is_multi_choice:
        for i, opt in enumerate(options):
            if opt.strip().lower() == declared_text:
                idx = i
                break

    if isinstance(idx, int) and 0 <= idx < len(options) and idx not in indices:
        indices.insert(0, idx)

    if not indices:
        return None

    if not is_multi_choice:
        indices = [indices[0]]

    primary_idx = indices[0]
    conf = parsed.get("confidence", 0.90)
    try:
        conf = max(0.55, min(0.99, float(conf)))
    except Exception:
        conf = 0.90

    default_npa = "Законодательство РФ" if jurisdiction == "RF" else "Законодательство РК"
    npa_val = str(parsed.get("npaRef") or parsed.get("law") or default_npa)

    return {
        "matchedOptionIndex": primary_idx,
        "matchedOptionIndices": indices,
        "matchedOptionText": "; ".join(options[i] for i in indices) if is_multi_choice else options[primary_idx],
        "confidence": round(conf, 2),
        "consensus": model_label,
        "npaRef": npa_val,
        "explanation": str(parsed.get("explanation") or parsed.get("law") or ""),
        "source": "live-ai-bridge"
    }


def call_openai_compatible_api(
    endpoint: str,
    api_key: str | None,
    model: str,
    question: str,
    options: list[str],
    page_title: str = "",
    label: str = "Live ИИ",
    timeout: int = 20,
    use_response_format: bool = True,
    is_multi_choice: bool = False,
    jurisdiction: str = "RK",
) -> dict | None:
    system_prompt, user_prompt = _build_llm_prompts(question, options, page_title, is_multi_choice, jurisdiction)
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
    }
    if use_response_format:
        body["response_format"] = {"type": "json_object"}

    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ICA-TestHelper/1.0.4",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = urllib.request.Request(endpoint, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            parsed = _extract_json_object(content)
            return _normalize_llm_choice(parsed, options, label, is_multi_choice, jurisdiction)
    except urllib.error.HTTPError as e:
        if endpoint == POLLINATIONS_URL and e.code in (402, 429):
            with POLLINATIONS_LOCK:
                global POLLINATIONS_COOLDOWN_UNTIL
                POLLINATIONS_COOLDOWN_UNTIL = time.time() + 600.0
        logger.warning(f"{label} HTTP error {e.code}: {e.reason}")
        return None
    except Exception as e:
        logger.warning(f"{label} request failed: {e}")
        return None


def call_pollinations_api(
    question: str,
    options: list[str],
    page_title: str = "",
    is_multi_choice: bool = False,
    jurisdiction: str = "RK",
) -> dict | None:
    with POLLINATIONS_LOCK:
        if time.time() < POLLINATIONS_COOLDOWN_UNTIL:
            return None
    return call_openai_compatible_api(
        POLLINATIONS_URL, None, "openai-fast", question, options, page_title,
        "Live ИИ (GPT-OSS-20B)", 12, False, is_multi_choice, jurisdiction
    )


def call_claude_cli(
    question: str,
    options: list[str],
    page_title: str = "",
    is_multi_choice: bool = False,
    jurisdiction: str = "RK",
) -> dict | None:
    if not CLAUDE_BIN:
        return None
    system_prompt, user_prompt = _build_llm_prompts(question, options, page_title, is_multi_choice, jurisdiction)
    full_prompt = f"{system_prompt}\n\n{user_prompt}"
    try:
        res = subprocess.run(
            [
                CLAUDE_BIN, "-p",
                "--model", "sonnet",
                "--tools", "",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--effort", "low",
                full_prompt,
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=25,
            encoding="utf-8",
            errors="replace",
            creationflags=CREATE_NO_WINDOW,
        )
        if res.returncode == 0 and res.stdout:
            parsed = _extract_json_object(res.stdout)
            return _normalize_llm_choice(parsed, options, f"Live ИИ (Claude • {jurisdiction})", is_multi_choice, jurisdiction)
        logger.warning(f"Claude CLI rc={res.returncode}: {res.stderr.strip()[:160]}")
    except Exception as e:
        logger.warning(f"Claude CLI failed: {e}")
    return None


def call_claude_cli_batch(
    items: list[dict],
    page_title: str = "",
    jurisdiction: str = "RK",
) -> dict[int, dict]:
    if not CLAUDE_BIN or not items:
        return {}
    system_prompt, user_prompt = _build_batch_llm_prompts(items, page_title, jurisdiction)
    full_prompt = f"{system_prompt}\n\n{user_prompt}"
    by_id = {it["id"]: it for it in items}
    out: dict[int, dict] = {}
    try:
        res = subprocess.run(
            [
                CLAUDE_BIN, "-p",
                "--model", "sonnet",
                "--tools", "",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--effort", "low",
                full_prompt,
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=35,
            encoding="utf-8",
            errors="replace",
            creationflags=CREATE_NO_WINDOW,
        )
        if res.returncode == 0 and res.stdout:
            parsed_arr = _extract_json_array(res.stdout) or []
            for entry in parsed_arr:
                eid = entry.get("id")
                if isinstance(eid, str) and eid.isdigit():
                    eid = int(eid)
                item = by_id.get(eid)
                if not item:
                    continue
                norm = _normalize_llm_choice(
                    entry,
                    item["options"],
                    f"Live ИИ (Claude • {jurisdiction})",
                    bool(item.get("isMultiChoice", False)),
                    jurisdiction,
                )
                if norm:
                    out[eid] = norm
        else:
            logger.warning(f"Claude CLI batch rc={res.returncode}: {res.stderr.strip()[:160]}")
    except Exception as e:
        logger.warning(f"Claude CLI batch failed: {e}")
    return out


def _detect_ollama_model() -> str | None:
    try:
        with urllib.request.urlopen(f"{OLLAMA_BASE_URL}/api/tags", timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            models = [m.get("name") for m in data.get("models", []) if m.get("name")]
            if not models:
                return None
            # Prefer smaller/faster models first on CPU systems
            for preferred in ("mindai", "qwen2.5:1.5b", "qwen3", "llama", "mistral", "gemma"):
                for name in models:
                    if preferred in name.lower():
                        return name
            return models[0]
    except Exception:
        return None


OLLAMA_LOCK = threading.Lock()


def call_ollama_api(
    question: str,
    options: list[str],
    page_title: str = "",
    is_multi_choice: bool = False,
    jurisdiction: str = "RK",
) -> dict | None:
    model_name = _detect_ollama_model()
    if not model_name:
        return None

    system_prompt, user_prompt = _build_llm_prompts(question, options, page_title, is_multi_choice, jurisdiction)
    payload = json.dumps({
        "model": model_name,
        "stream": False,
        "think": False,
        "format": "json",
        "keep_alive": "20m",
        "options": {"temperature": 0.1, "num_ctx": 2048, "num_predict": 220},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{OLLAMA_BASE_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with OLLAMA_LOCK:
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                content = data.get("message", {}).get("content", "")
                parsed = _extract_json_object(content)
                short_name = model_name.split(":")[0].split("/")[-1]
                return _normalize_llm_choice(parsed, options, f"Live ИИ ({short_name})", is_multi_choice, jurisdiction)
        except Exception as e:
            logger.warning(f"Ollama ({model_name}) failed: {e}")
            return None


def _make_cache_key(question: str, options: list[str], is_multi_choice: bool, jurisdiction: str) -> str:
    mode_tag = "M" if is_multi_choice else "S"
    opts_norm = "|".join(o.strip().lower() for o in options)
    return f"{CACHE_VERSION}|{jurisdiction}|{mode_tag}||{question.strip().lower()}||{opts_norm}"


def _store_cached_answer(cache_key: str, res: dict):
    with SOLVE_CACHE_LOCK:
        SOLVE_CACHE[cache_key] = dict(res)
        _save_disk_cache(SOLVE_CACHE)


def _lookup_fast_or_cached(
    question: str,
    options: list[str],
    is_multi_choice: bool,
    jurisdiction: str,
) -> tuple[str, dict | None]:
    cache_key = _make_cache_key(question, options, is_multi_choice, jurisdiction)
    db_result = solve_with_db(question, options, jurisdiction=jurisdiction, is_multi_choice=is_multi_choice)
    if db_result:
        return cache_key, db_result

    if not is_multi_choice:
        rule_result = solve_with_rules(question, options, jurisdiction=jurisdiction)
        if rule_result:
            return cache_key, rule_result

    with SOLVE_CACHE_LOCK:
        hit = SOLVE_CACHE.get(cache_key)
        if hit:
            cached = dict(hit)
            base_cons = str(cached.get("consensus", "Live ИИ"))
            if "(кэш)" not in base_cons:
                cached["consensus"] = f"{base_cons} (кэш)"
            return cache_key, cached

    return cache_key, None


def solve_question(
    question: str,
    options: list[str],
    page_title: str = "",
    page_url: str = "",
    is_multi_choice: bool = False,
    jurisdiction: str | None = None,
) -> dict:
    """Multi-tier Live AI solver: Jurisdiction -> DB -> Rules -> v2 Cache -> Keys / Claude CLI -> Ollama / Cloud fallback."""
    if not question or not options:
        return {
            "matchedOptionIndex": -1,
            "matchedOptionText": "",
            "confidence": 0.0,
            "consensus": "Ошибка: пустой вопрос или варианты",
            "npaRef": "",
            "explanation": "Не удалось распознать вопрос или варианты ответов"
        }

    if len(options) > 20:
        logger.info(f"Skipping non-question oversized payload (options={len(options)})")
        return {
            "matchedOptionIndex": -1,
            "matchedOptionText": "",
            "confidence": 0.0,
            "consensus": "Пропущено (меню/список)",
            "npaRef": "",
            "error": "Слишком много элементов на странице для одного вопроса",
            "explanation": "Элемент не является тестовым вопросом"
        }

    jur = detect_jurisdiction(question, options, page_title, page_url, jurisdiction)
    cache_key, fast_res = _lookup_fast_or_cached(question, options, is_multi_choice, jur)
    if fast_res:
        logger.info(f"Solved fast/cache ({jur}): index={fast_res.get('matchedOptionIndices')}")
        return fast_res

    openai_key = os.environ.get("OPENAI_API_KEY")
    gemini_key = os.environ.get("GEMINI_API_KEY")

    if openai_key:
        res = call_openai_compatible_api(
            "https://api.openai.com/v1/chat/completions",
            openai_key, "gpt-4o-mini", question, options, page_title, f"Live ИИ (OpenAI • {jur})",
            is_multi_choice=is_multi_choice, jurisdiction=jur,
        )
        if res:
            _store_cached_answer(cache_key, res)
            return res

    if gemini_key:
        res = call_openai_compatible_api(
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            gemini_key, "gemini-2.5-flash", question, options, page_title, f"Live ИИ (Gemini • {jur})",
            is_multi_choice=is_multi_choice, jurisdiction=jur,
        )
        if res:
            _store_cached_answer(cache_key, res)
            return res

    # Fast primary solver: Claude CLI with strict-mcp-config & low effort (~4-6s)
    chosen = call_claude_cli(question, options, page_title, is_multi_choice, jur)

    # Offline / backup fallbacks ONLY when Claude CLI failed
    if not chosen:
        chosen = call_ollama_api(question, options, page_title, is_multi_choice, jur)
    if not chosen:
        chosen = call_pollinations_api(question, options, page_title, is_multi_choice, jur)

    if chosen:
        logger.info(f"Solved via {chosen['consensus']}: indices={chosen['matchedOptionIndices']} ({chosen['npaRef']})")
        _store_cached_answer(cache_key, chosen)
        return chosen

    logger.warning("All Live AI providers failed to return a valid answer")
    return {
        "matchedOptionIndex": -1,
        "matchedOptionText": "",
        "confidence": 0.0,
        "consensus": "Live ИИ недоступен",
        "npaRef": "",
        "error": "Нет ответа от Live ИИ (проверьте интернет или Claude/Ollama)",
        "explanation": "Не удалось получить ответ от Claude, облачного ИИ и локальной Ollama."
    }


def solve_batch(
    items: list[dict],
    page_title: str = "",
    page_url: str = "",
    jurisdiction: str | None = None,
) -> dict:
    if not isinstance(items, list) or not items:
        return {"jurisdiction": "RK", "results": []}

    combined_q = " ".join(str(it.get("question") or "") for it in items[:8])
    jur = detect_jurisdiction(combined_q, [], page_title, page_url, jurisdiction)
    results: dict[int, dict] = {}
    pending_for_llm: list[dict] = []

    for pos, raw in enumerate(items):
        q = str(raw.get("question") or "").strip()
        opts = [str(o) for o in (raw.get("options") or [])]
        is_multi = bool(raw.get("isMultiChoice", False))
        item_id = raw.get("id", pos)
        if not q or len(opts) < 2 or len(opts) > 20:
            results[pos] = {"error": "Некорректный вопрос или число вариантов", "matchedOptionIndex": -1}
            continue
        cache_key, fast_res = _lookup_fast_or_cached(q, opts, is_multi, jur)
        if fast_res:
            results[pos] = fast_res
        else:
            pending_for_llm.append({
                "pos": pos,
                "id": pos,
                "clientId": item_id,
                "question": q,
                "options": opts,
                "isMultiChoice": is_multi,
                "cacheKey": cache_key,
            })

    if pending_for_llm:
        chunks = [pending_for_llm[i:i + 6] for i in range(0, len(pending_for_llm), 6)]
        with ThreadPoolExecutor(max_workers=min(2, len(chunks))) as pool:
            batch_maps = list(pool.map(lambda ch: call_claude_cli_batch(ch, page_title, jur), chunks))

        solved_by_pos: dict[int, dict] = {}
        for bm in batch_maps:
            solved_by_pos.update(bm)

        for p_item in pending_for_llm:
            pos = p_item["pos"]
            ans = solved_by_pos.get(pos)
            if not ans:
                # Single-question fallback only for items missed in batch output
                ans = solve_question(
                    p_item["question"],
                    p_item["options"],
                    page_title,
                    page_url,
                    is_multi_choice=p_item["isMultiChoice"],
                    jurisdiction=jur,
                )
            else:
                _store_cached_answer(p_item["cacheKey"], ans)
            results[pos] = ans

    ordered = [results.get(i, {"error": "Не решено", "matchedOptionIndex": -1}) for i in range(len(items))]
    return {"jurisdiction": jur, "results": ordered}


class BridgeRequestHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _send_json(self, status_code: int, payload: dict):
        try:
            self.send_response(status_code)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            ollama_model = _detect_ollama_model()
            self._send_json(200, {
                "ok": True,
                "service": "ica-test-helper-bridge",
                "version": "1.0.4",
                "status": "ready",
                "rules_loaded": len(KNOWLEDGE_RULES),
                "db_questions_loaded": len(DB_QUESTIONS),
                "claude_cli": bool(CLAUDE_BIN),
                "ollama_model": ollama_model,
                "cloud_fallback": "pollinations-gpt-oss-20b"
            })
        else:
            self._send_json(404, {"error": "Not Found"})

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0:
            self._send_json(400, {"error": "Empty body"})
            return

        raw_body = self.rfile.read(content_length)
        try:
            data = json.loads(raw_body.decode("utf-8"))
        except Exception as e:
            self._send_json(400, {"error": f"Invalid JSON: {e}"})
            return

        if self.path == "/solve":
            question = data.get("question", "").strip()
            options = data.get("options", [])
            page_title = data.get("pageTitle", "")
            page_url = data.get("pageUrl", "")
            is_multi_choice = bool(data.get("isMultiChoice", False))
            jurisdiction = data.get("jurisdiction")

            logger.info(f"POST /solve: question='{question[:60]}...' (options: {len(options)}, multi={is_multi_choice})")
            result = solve_question(
                question, options, page_title, page_url,
                is_multi_choice=is_multi_choice, jurisdiction=jurisdiction
            )
            self._send_json(200, result)
        elif self.path == "/solve_batch":
            items = data.get("items", [])
            page_title = data.get("pageTitle", "")
            page_url = data.get("pageUrl", "")
            jurisdiction = data.get("jurisdiction")
            logger.info(f"POST /solve_batch: count={len(items)} title='{page_title[:45]}'")
            result = solve_batch(items, page_title, page_url, jurisdiction=jurisdiction)
            self._send_json(200, result)
        else:
            self._send_json(404, {"error": "Endpoint not found"})

    def log_message(self, format, *args):
        logger.debug("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), format % args))


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run_server():
    server_address = (HOST, PORT)
    try:
        httpd = ThreadedHTTPServer(server_address, BridgeRequestHandler)
    except OSError as exc:
        logger.info(f"Мост уже запущен на http://{HOST}:{PORT} ({exc}). Завершаем дублирующий процесс.")
        return

    ollama_model = _detect_ollama_model()
    print("=" * 66)
    print("   АО «Интергаз Центральная Азия» — Live AI Bridge Server v1.0.2")
    print("   Промбез & БИОТ РК • БД 400 + GPT-OSS-20B + Ollama")
    print("=" * 66)
    print(f" [OK] Сервер:         http://{HOST}:{PORT}")
    print(f" [OK] БД вопросов:    {len(DB_QUESTIONS)} | Правил РК: {len(KNOWLEDGE_RULES)}")
    print(f" [OK] Локальная LLM:  {ollama_model or 'не найдена (работает облако)'}")
    print(f" [OK] Облачный ИИ:    Pollinations (GPT-OSS-20B, без ключа)")
    print("=" * 66)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logger.info("Остановка сервера по сигналу пользователя...")
    finally:
        httpd.server_close()
        logger.info("Сервер корректно остановлен.")


if __name__ == "__main__":
    run_server()
