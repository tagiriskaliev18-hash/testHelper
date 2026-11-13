import base64
import difflib
import io
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional
from PIL import Image, ImageEnhance, ImageOps

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("mind_testhelper")

CURRENT_DIR = Path(__file__).resolve().parent
BASE_DIR = CURRENT_DIR if (CURRENT_DIR / "data").exists() else CURRENT_DIR.parent
STATIC_DIR = CURRENT_DIR / "static" if (CURRENT_DIR / "static").exists() else (BASE_DIR / "web" / "static" if (BASE_DIR / "web" / "static").exists() else CURRENT_DIR)
ENV_FILE = BASE_DIR / ".env"

# Load .env
env_vars: Dict[str, str] = {}
if ENV_FILE.exists():
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env_vars[k.strip()] = v.strip().strip("\"'")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or env_vars.get("GEMINI_API_KEY", "")
PORT = int(os.environ.get("PORT") or env_vars.get("PORT", "8000"))
HOST = os.environ.get("HOST") or env_vars.get("HOST", "0.0.0.0")

# High-speed vision models in priority order
VISION_MODELS = [
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-3-flash-preview"
]

# In-memory question bank for instant 100% corporate/ICA answers
question_bank: List[Dict[str, Any]] = []

def normalize_text(text: str) -> str:
    """Normalize text for fuzzy matching."""
    if not text:
        return ""
    t = text.lower()
    t = re.sub(r"[^\w\s\d]", " ", t, flags=re.UNICODE)
    t = re.sub(r"\s+", " ", t).strip()
    return t

def get_tokens(text: str) -> set:
    norm = normalize_text(text)
    return set(w for w in norm.split() if len(w) > 2)

def load_question_bank():
    global question_bank
    loaded = 0
    corp_file = BASE_DIR / "data" / "corporate_ica_bank.json"
    if corp_file.exists():
        try:
            data = json.loads(corp_file.read_text(encoding="utf-8"))
            if isinstance(data, list):
                for item in data:
                    q_text = item.get("question", "")
                    if q_text:
                        question_bank.append({
                            "id": item.get("id"),
                            "raw_question": q_text,
                            "norm_question": normalize_text(q_text),
                            "tokens": get_tokens(q_text),
                            "options": item.get("options", []),
                            "correct_answer": item.get("correctAnswer", ""),
                            "npa_ref": item.get("npaRef", ""),
                            "category": item.get("category", "Промышленная безопасность ИЦА"),
                            "source": "corporate_ica_bank"
                        })
                        loaded += 1
        except Exception as e:
            logger.warning(f"Error loading corporate_ica_bank: {e}")

    mod_dir = BASE_DIR / "data" / "modules"
    if mod_dir.exists():
        for mod_file in mod_dir.glob("*.json"):
            try:
                m_data = json.loads(mod_file.read_text(encoding="utf-8"))
                items = m_data if isinstance(m_data, list) else m_data.get("questions", [])
                for item in items:
                    q_text = item.get("question", "")
                    if q_text:
                        question_bank.append({
                            "id": item.get("id"),
                            "raw_question": q_text,
                            "norm_question": normalize_text(q_text),
                            "tokens": get_tokens(q_text),
                            "options": item.get("options", []),
                            "correct_answer": item.get("correctAnswer") or item.get("answer", ""),
                            "npa_ref": item.get("npaRef", "") or item.get("source", ""),
                            "category": mod_file.stem,
                            "source": f"module_{mod_file.stem}"
                        })
                        loaded += 1
            except Exception as e:
                logger.warning(f"Error loading {mod_file}: {e}")

    logger.info(f"Loaded {loaded} questions into memory bank.")

load_question_bank()

def match_in_bank(question_text: str, threshold: float = 0.72) -> Optional[Dict[str, Any]]:
    """Match recognized question text against local bank for 100% ground-truth."""
    if not question_text or not question_bank:
        return None
    norm_q = normalize_text(question_text)
    q_tokens = get_tokens(question_text)
    if len(norm_q) < 8 or not q_tokens:
        return None

    best_match = None
    best_score = 0.0

    for item in question_bank:
        b_tokens = item["tokens"]
        if not b_tokens:
            continue

        # Fast Jaccard token overlap
        intersection = len(q_tokens & b_tokens)
        if intersection == 0:
            continue
        union = len(q_tokens | b_tokens)
        jaccard = intersection / union

        # String similarity
        bank_q = item["norm_question"]
        if norm_q in bank_q or bank_q in norm_q:
            seq_score = 0.90
        else:
            seq_score = difflib.SequenceMatcher(None, norm_q, bank_q).ratio()

        score = (jaccard * 0.5) + (seq_score * 0.5)

        if score > best_score and score >= threshold:
            best_score = score
            best_match = item

    if best_match:
        res = dict(best_match)
        res.pop("tokens", None)
        res["match_score"] = round(best_score, 3)
        return res
    return None

app = FastAPI(title="Mind TestHelper Live API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SolveRequest(BaseModel):
    image: str
    options_count: Optional[int] = 4

@app.get("/api/status")
async def get_status():
    return {
        "status": "online",
        "has_api_key": bool(GEMINI_API_KEY),
        "primary_model": VISION_MODELS[0],
        "question_bank_size": len(question_bank),
        "timestamp": int(time.time()),
        "brand": "Mind Ecosystem"
    }

@app.get("/api/samples")
async def get_samples():
    """Return 6 representative sample questions from the verified bank for test mode."""
    samples = []
    # Pick a few diverse questions with complete options & answer
    for q in question_bank:
        if q.get("options") and len(q["options"]) >= 3 and q.get("correct_answer"):
            samples.append({
                "category": q.get("category", "Промышленная безопасность РК"),
                "question": q["raw_question"],
                "options": q["options"],
                "correct_answer": q["correct_answer"],
                "npa_ref": q.get("npa_ref", "")
            })
            if len(samples) >= 6:
                break
    return samples

SYSTEM_PROMPT = """You are a world-class AI exam and test solver (specializing in Russian and English tests, exams, and official certifications).
Analyze the provided camera photograph of a question ticket, paper document, or screen.

Tasks:
1. Examine the image carefully. Even if the photo is taken at a slight angle or shows part of a sheet, find and transcribe the question and its options.
   Only if the image is completely blank, solid black, completely blurred beyond recognition, or contains absolutely no test question or readable text, respond with:
   {"found": false, "reason": "Наведите камеру на текст вопроса"}

2. If a test question is found:
   - "question": full transcribed question text (clean up minor OCR noise/perspective artifacts, accurately preserve formulas, numbers, terms, and punctuation).
   - "options": array of all option strings visible in the image (e.g. ["A) ...", "B) ...", ...]). If it is an open question without options, return [].
   - "correct_answer": the exact winning answer string. If options are present, provide the exact matching option text (including letter/number prefix if present).
   - "correct_index": 0-based integer index of the correct option in "options" (-1 if open question).
   - "explanation": a concise (1-2 sentences) direct explanation proving why this answer is correct according to official laws, technical safety rules (ПБ/БИОТ/ТК/ПУЭ), or scientific standards.
   - "confidence": confidence float between 0.85 and 1.0.
   - "language": "ru" or "en".

Strictly output valid JSON matching this schema."""

def enhance_image_for_recognition(b64_image: str) -> str:
    """Preprocess and enhance image contrast & sharpness for optimal vision OCR."""
    try:
        raw_b64 = b64_image.split(",", 1)[1] if "," in b64_image else b64_image
        raw_bytes = base64.b64decode(raw_b64)
        im = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
        w, h = im.size

        # Keep high resolution for reading fine printed text, capped at 1920px max dimension
        max_dim = 1920
        if max(w, h) > max_dim:
            im.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)

        # Autocontrast to eliminate greyish cast or phone screen glare
        im = ImageOps.autocontrast(im, cutoff=0.5)

        # Gentle unsharp mask / sharpness boost for crisp font edges
        enhancer = ImageEnhance.Sharpness(im)
        im = enhancer.enhance(1.22)

        out_buf = io.BytesIO()
        im.save(out_buf, format="JPEG", quality=94)
        return base64.b64encode(out_buf.getvalue()).decode("utf-8")
    except Exception as e:
        logger.warning(f"Image enhancement fallback to original: {e}")
        return b64_image.split(",", 1)[1] if "," in b64_image else b64_image

def call_gemini_vision(b64_image: str) -> Dict[str, Any]:
    if not GEMINI_API_KEY:
        raise ValueError("GEMINI_API_KEY is not configured in backend")

    # Preprocess image for crisp OCR
    b64_data = enhance_image_for_recognition(b64_image)

    payload = {
        "contents": [{
            "parts": [
                {"text": SYSTEM_PROMPT},
                {
                    "inline_data": {
                        "mime_type": "image/jpeg",
                        "data": b64_data
                    }
                }
            ]
        }],
        "generationConfig": {
            "response_mime_type": "application/json",
            "temperature": 0.1,
            "maxOutputTokens": 800
        }
    }
    encoded_payload = json.dumps(payload).encode("utf-8")

    last_error = ""
    for model_name in VISION_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={GEMINI_API_KEY}"
        req = urllib.request.Request(
            url,
            data=encoded_payload,
            headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                candidates = data.get("candidates", [])
                if not candidates:
                    continue
                part_text = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                if part_text:
                    cleaned_text = re.sub(r"^```(?:json)?\s*", "", part_text.strip(), flags=re.MULTILINE)
                    cleaned_text = re.sub(r"\s*```$", "", cleaned_text.strip(), flags=re.MULTILINE)
                    parsed = json.loads(cleaned_text)
                    if isinstance(parsed, list):
                        parsed = parsed[0] if parsed and isinstance(parsed[0], dict) else {}
                    if not isinstance(parsed, dict):
                        parsed = {"found": False, "reason": "Не удалось разобрать ответ модели"}
                    parsed["model_used"] = model_name
                    return parsed
        except urllib.error.HTTPError as e:
            err_msg = e.read().decode("utf-8", errors="ignore")
            logger.warning(f"Model {model_name} HTTP {e.code}: {err_msg[:100]}")
            last_error = f"{model_name} HTTP {e.code}"
            continue
        except Exception as e:
            logger.warning(f"Model {model_name} error: {e}")
            last_error = str(e)
            continue

    raise RuntimeError(f"All vision models failed. Last error: {last_error}")

@app.post("/api/solve")
async def solve_frame(req: SolveRequest):
    t0 = time.time()
    if not req.image or len(req.image) < 100:
        raise HTTPException(status_code=400, detail="Invalid image payload")

    try:
        ai_res = call_gemini_vision(req.image)
    except Exception as e:
        logger.error(f"Vision solve failed: {e}")
        return JSONResponse({
            "status": "error",
            "found": False,
            "error": str(e),
            "latency_ms": round((time.time() - t0) * 1000)
        }, status_code=500)

    if not ai_res.get("found", False):
        return {
            "status": "not_found",
            "found": False,
            "reason": ai_res.get("reason", "Вопрос не обнаружен на кадре"),
            "latency_ms": round((time.time() - t0) * 1000)
        }

    question_text = ai_res.get("question", "")
    bank_match = match_in_bank(question_text)

    response_data = {
        "status": "success",
        "found": True,
        "question": question_text,
        "options": ai_res.get("options", []),
        "correct_answer": ai_res.get("correct_answer", ""),
        "correct_index": ai_res.get("correct_index", -1),
        "explanation": ai_res.get("explanation", ""),
        "confidence": ai_res.get("confidence", 0.95),
        "model_used": ai_res.get("model_used", VISION_MODELS[0]),
        "language": ai_res.get("language", "ru"),
        "latency_ms": round((time.time() - t0) * 1000)
    }

    if bank_match:
        response_data["bank_match"] = {
            "verified": True,
            "source": bank_match.get("source"),
            "correct_answer": bank_match.get("correct_answer"),
            "npa_ref": bank_match.get("npa_ref"),
            "category": bank_match.get("category"),
            "match_score": bank_match.get("match_score")
        }
        if bank_match.get("correct_answer"):
            response_data["correct_answer"] = bank_match.get("correct_answer")
            if bank_match.get("npa_ref"):
                response_data["explanation"] = f"НПА: {bank_match['npa_ref']}. {response_data['explanation']}"

    return response_data

# Mount static files
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/")
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse({"status": "ready", "message": "Index not found"})

if __name__ == "__main__":
    logger.info(f"Starting Mind TestHelper Live Server on {HOST}:{PORT}")
    while True:
        try:
            uvicorn.run(app, host=HOST, port=PORT, log_level="info")
        except (KeyboardInterrupt, SystemExit):
            logger.info("Server stopped by user.")
            break
        except Exception as e:
            logger.error(f"Uvicorn error: {e}. Restarting in 2s...")
            time.sleep(2)
