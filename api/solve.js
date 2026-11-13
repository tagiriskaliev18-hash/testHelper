import fs from 'node:fs';
import path from 'node:path';

// Pre-load corporate questions bank if available
let questionBank = [];
try {
  const bankPath = path.join(process.cwd(), 'data', 'corporate_ica_bank.json');
  if (fs.existsSync(bankPath)) {
    questionBank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
  }
} catch (e) {
  console.warn('Bank load warning:', e);
}

function normalize(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^\w\s\dа-яё]/gi, ' ').replace(/\s+/g, ' ').trim();
}

function matchInBank(qText) {
  if (!qText || questionBank.length === 0) return null;
  const normQ = normalize(qText);
  if (normQ.length < 10) return null;

  for (const item of questionBank) {
    const bankQ = normalize(item.question || '');
    if (bankQ && (normQ.includes(bankQ) || bankQ.includes(normQ))) {
      return {
        verified: true,
        correct_answer: item.correctAnswer,
        npa_ref: item.npaRef,
        category: item.category
      };
    }
  }
  return null;
}

const SYSTEM_PROMPT = `You are a high-speed AI exam and test solver (supporting Russian and English).
Analyze the provided camera frame carefully.

Tasks:
1. Detect if there is a legible multiple-choice or open test question in the image.
   If the image is completely empty, blurry, unreadable, or does not contain a question, respond with:
   {"found": false, "reason": "Наведите камеру на текст вопроса"}

2. If a question is visible:
   - "question": full transcribed question text (clean up typos from perspective, preserve math/special terms).
   - "options": list of all option strings present in the image (e.g. ["A) Марс", "B) Земля", ...]). If it is an open question without options, return an empty array [].
   - "correct_answer": the exact winning answer text.
   - "correct_index": 0-based integer index of the correct option in "options" (or -1 if open question).
   - "explanation": a concise (1-2 sentences) direct explanation proving why this answer is correct according to official science, law, or standards.
   - "confidence": confidence float between 0.80 and 1.0.
   - "language": "ru" or "en".

Strictly output valid JSON matching this schema.`;

const VISION_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const t0 = Date.now();
  const { image } = req.body || {};
  if (!image) {
    return res.status(400).json({ error: 'Image payload required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not set in hosting secrets.' });
  }

  const base64Data = image.includes(',') ? image.split(',')[1] : image;

  const payload = {
    contents: [{
      parts: [
        { text: SYSTEM_PROMPT },
        { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
      ]
    }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 800
    }
  };

  let lastError = null;
  for (const model of VISION_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000)
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.warn(`Model ${model} failed with ${resp.status}:`, errText.slice(0, 100));
        lastError = `${model} HTTP ${resp.status}`;
        continue;
      }

      const data = await resp.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) continue;

      const parsed = JSON.parse(rawText);
      if (!parsed.found) {
        return res.status(200).json({
          status: 'not_found',
          found: false,
          reason: parsed.reason || 'Вопрос не найден на кадре',
          latency_ms: Date.now() - t0
        });
      }

      const bankMatch = matchInBank(parsed.question);
      const responseData = {
        status: 'success',
        found: true,
        question: parsed.question,
        options: parsed.options || [],
        correct_answer: parsed.correct_answer,
        correct_index: parsed.correct_index ?? -1,
        explanation: parsed.explanation || '',
        confidence: parsed.confidence || 0.95,
        model_used: model,
        language: parsed.language || 'ru',
        latency_ms: Date.now() - t0
      };

      if (bankMatch) {
        responseData.bank_match = bankMatch;
        if (bankMatch.correct_answer) {
          responseData.correct_answer = bankMatch.correct_answer;
          if (bankMatch.npa_ref) {
            responseData.explanation = `НПА: ${bankMatch.npa_ref}. ${responseData.explanation}`;
          }
        }
      }

      return res.status(200).json(responseData);
    } catch (err) {
      console.warn(`Model ${model} error:`, err.message);
      lastError = err.message;
    }
  }

  return res.status(500).json({
    status: 'error',
    error: `All models failed: ${lastError}`,
    latency_ms: Date.now() - t0
  });
}
