import glob
import hashlib
import json
import os
import random

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULES_DIR = os.path.join(BASE_DIR, "data", "modules")
SHUFFLED_DIR = os.path.join(BASE_DIR, "data", "modules_shuffled")
PROMPTS_DIR = os.path.join(BASE_DIR, "data", "prompts")
LABELS = ["A", "B", "C", "D"]


def main():
    os.makedirs(SHUFFLED_DIR, exist_ok=True)
    os.makedirs(PROMPTS_DIR, exist_ok=True)

    module_files = sorted(glob.glob(os.path.join(MODULES_DIR, "m*.json")))
    total = 0

    for path in module_files:
        with open(path, "r", encoding="utf-8") as f:
            mod = json.load(f)

        shuffled_questions = []
        prompt_lines = [
            f"Ты эксперт по промышленной безопасности (Промбез) и БиОТ Республики Казахстан (для АО «Интергаз Центральная Азия»).",
            f"Проверь все {len(mod['questions'])} вопросов строго по действующему законодательству РК (НЕ РФ!).",
            "Ответь ТОЛЬКО компактным JSON-объектом вида {\"1\":\"A\",\"2\":\"C\",...} без пояснений и лишнего текста.",
            ""
        ]

        for idx, q in enumerate(mod["questions"], start=1):
            options = list(q["options"])
            correct_text = q["correctAnswer"]
            assert options[q["correctIndex"]] == correct_text, f"Mismatch in {q['id']}"

            seed = int(hashlib.sha256(q["id"].encode("utf-8")).hexdigest(), 16)
            rng = random.Random(seed)
            indices = list(range(len(options)))
            rng.shuffle(indices)

            new_options = [options[i] for i in indices]
            new_correct_idx = new_options.index(correct_text)

            q_copy = dict(q)
            q_copy["category"] = mod["category"]
            q_copy["topic"] = mod["topic"]
            q_copy["options"] = new_options
            q_copy["correctIndex"] = new_correct_idx
            shuffled_questions.append(q_copy)

            prompt_lines.append(f"{idx}. {q['question']}")
            for opt_i, opt_text in enumerate(new_options):
                prompt_lines.append(f"  {LABELS[opt_i]}) {opt_text}")

        mod_out = {
            "moduleId": mod["moduleId"],
            "category": mod["category"],
            "topic": mod["topic"],
            "questions": shuffled_questions,
        }
        out_name = os.path.basename(path)
        with open(os.path.join(SHUFFLED_DIR, out_name), "w", encoding="utf-8") as f:
            json.dump(mod_out, f, ensure_ascii=False, indent=2)

        prompt_name = f"{mod['moduleId']}.txt"
        with open(os.path.join(PROMPTS_DIR, prompt_name), "w", encoding="utf-8") as f:
            f.write("\n".join(prompt_lines))

        total += len(shuffled_questions)
        print(f"{mod['moduleId']}: {len(shuffled_questions)} questions shuffled & prompt generated")

    print(f"TOTAL QUESTIONS: {total}")


if __name__ == "__main__":
    main()
