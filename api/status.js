import fs from 'node:fs';
import path from 'node:path';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

  let bankCount = 0;
  try {
    const bankPath = path.join(process.cwd(), 'data', 'corporate_ica_bank.json');
    if (fs.existsSync(bankPath)) {
      const data = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
      bankCount = Array.isArray(data) ? data.length : 0;
    }
  } catch (e) {}

  res.status(200).json({
    status: 'online',
    has_api_key: Boolean(process.env.GEMINI_API_KEY),
    service: 'Vercel Serverless Function',
    primary_model: 'gemini-3.1-flash-lite',
    question_bank_size: bankCount,
    timestamp: Date.now(),
    brand: 'Mind Ecosystem'
  });
}
