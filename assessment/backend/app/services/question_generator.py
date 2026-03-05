import json
import random
import re
from typing import Any

from huggingface_hub import InferenceClient

from ..config import settings


STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "will",
    "you",
    "your",
    "our",
    "are",
    "has",
    "into",
    "using",
    "must",
    "able",
    "work",
}


def _extract_keywords(text: str, top_n: int = 20) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9+#._-]{2,}", text.lower())
    scores: dict[str, int] = {}
    for word in words:
        if word in STOPWORDS:
            continue
        scores[word] = scores.get(word, 0) + 1
    ordered = sorted(scores.items(), key=lambda pair: (-pair[1], pair[0]))
    return [w for w, _ in ordered[:top_n]]


def _default_questions(job: dict[str, Any], question_count: int, difficulty: str) -> list[dict[str, Any]]:
    description = job.get("description", "")
    skills = (job.get("skills_required") or []) + (job.get("additional_skills") or [])
    keywords = list(dict.fromkeys([*skills, *_extract_keywords(description)]))
    if len(keywords) < 4:
        keywords += ["communication", "problem solving", "team collaboration", "debugging"]

    random.shuffle(keywords)
    questions: list[dict[str, Any]] = []

    for index in range(question_count):
        core = keywords[index % len(keywords)]
        distractors = random.sample(keywords, k=min(3, len(keywords)))
        if core not in distractors:
            distractors[0] = core
        random.shuffle(distractors)

        question = {
            "id": index + 1,
            "question": f"({difficulty.title()}) Which option is most relevant to this job role regarding '{core}'?",
            "options": distractors,
            "answer": core,
        }
        questions.append(question)

    return questions


def _hf_generate(job: dict[str, Any], question_count: int, difficulty: str) -> list[dict[str, Any]]:
    if not settings.hf_api_token:
        raise ValueError("HF_API_TOKEN missing")

    prompt = (
        "Generate multiple-choice interview exam questions as JSON array. "
        f"Need {question_count} questions at {difficulty} difficulty. "
        "Each item must include id, question, options(4), answer. "
        f"Job title: {job.get('title', '')}. "
        f"Job description: {job.get('description', '')[:1500]}"
    )

    client = InferenceClient(model=settings.hf_model, token=settings.hf_api_token)
    output = client.text_generation(prompt, max_new_tokens=900, temperature=0.3)

    parsed = re.search(r"\[.*\]", output, flags=re.DOTALL)
    if not parsed:
        raise ValueError("No JSON array found in HF response")

    data = json.loads(parsed.group(0))
    normalized = []
    for idx, item in enumerate(data[:question_count]):
        options = item.get("options") or []
        if len(options) < 4:
            continue
        normalized.append(
            {
                "id": idx + 1,
                "question": str(item.get("question", "")).strip(),
                "options": [str(opt).strip() for opt in options[:4]],
                "answer": str(item.get("answer", options[0])).strip(),
            }
        )

    if len(normalized) < max(3, question_count // 2):
        raise ValueError("HF result quality too low")

    return normalized


def generate_questions(job: dict[str, Any], question_count: int, difficulty: str) -> list[dict[str, Any]]:
    if settings.use_hf_llm:
        try:
            return _hf_generate(job, question_count, difficulty)
        except Exception:
            return _default_questions(job, question_count, difficulty)
    return _default_questions(job, question_count, difficulty)
