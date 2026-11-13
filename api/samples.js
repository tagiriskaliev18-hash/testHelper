import fs from 'node:fs';
import path from 'node:path';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

  try {
    const bankPath = path.join(process.cwd(), 'data', 'corporate_ica_bank.json');
    if (fs.existsSync(bankPath)) {
      const data = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
      const samples = data
        .filter(q => q.options && q.options.length >= 3 && q.correctAnswer)
        .slice(0, 6)
        .map(q => ({
          category: q.category || 'Промышленная безопасность РК (ИЦА)',
          question: q.question,
          options: q.options,
          correct_answer: q.correctAnswer,
          npa_ref: q.npaRef || ''
        }));
      return res.status(200).json(samples);
    }
  } catch (e) {}

  return res.status(200).json([]);
}
