import json
import random
import re
from typing import Any

import httpx
from loguru import logger

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


def _azure_generate(job: dict[str, Any], question_count: int, difficulty: str, resume_skills: list[str] | None = None) -> list[dict[str, Any]]:
    endpoint = (settings.azure_openai_endpoint or "").strip().rstrip("/")
    api_key = (settings.azure_openai_api_key or "").strip()
    deployment = (settings.azure_openai_deployment or "").strip()

    if not endpoint or not api_key or not deployment:
        raise ValueError(f"Azure OpenAI not configured (endpoint={bool(endpoint)}, key={bool(api_key)}, deployment={bool(deployment)})")

    url = (
        f"{endpoint}/openai/deployments/{deployment}/chat/completions"
        f"?api-version={settings.azure_openai_api_version}"
    )
    logger.info("Azure OpenAI request URL: {}", url)

    skills_text = ""
    if resume_skills:
        skills_text = f"\nCandidate's resume skills: {', '.join(resume_skills[:20])}"

    job_skills = (job.get("skills_required") or []) + (job.get("additional_skills") or [])
    job_skills_text = f"\nJob required skills: {', '.join(job_skills[:20])}" if job_skills else ""

    system_prompt = (
        "You are a senior technical interviewer creating a challenging assessment exam. "
        "Generate multiple-choice questions that test deep understanding, not surface knowledge. "
        "Questions should be scenario-based, problem-solving oriented, and tricky. "
        "Avoid trivially easy questions. Each question must have exactly 4 options with one correct answer. "
        "Return ONLY a valid JSON array, no markdown, no explanation."
    )

    user_prompt = (
        f"Generate exactly {question_count} challenging multiple-choice questions for the following job role.\n"
        f"Difficulty: {difficulty}\n"
        f"Job Title: {job.get('title', 'Software Engineer')}\n"
        f"Job Description: {job.get('description', '')[:2000]}\n"
        f"{job_skills_text}"
        f"{skills_text}\n\n"
        f"Requirements:\n"
        f"- Questions must be {difficulty} difficulty (make them genuinely challenging)\n"
        f"- Test applied knowledge, not definitions\n"
        f"- Include code snippets, scenario-based, and analytical questions where applicable\n"
        f"- Each question object must have: id (integer starting from 1), question (string), options (array of exactly 4 strings), answer (string matching one of the options exactly)\n"
        f"- Return ONLY a JSON array of {question_count} question objects"
    )

    headers = {"api-key": api_key, "Content-Type": "application/json"}
    payload = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_completion_tokens": 8000,
    }

    response = httpx.post(url, headers=headers, json=payload, timeout=60.0)

    if response.status_code >= 400:
        logger.warning("Azure OpenAI error {}: {}", response.status_code, response.text[:500])
        raise ValueError(f"Azure OpenAI request failed: {response.status_code}")

    data = response.json()
    logger.debug("Azure response keys: {}", list(data.keys()))

    choices = data.get("choices") or []
    if not choices:
        logger.warning("Azure response has no choices. Full response:\n{}", json.dumps(data, indent=2)[:2000])
        raise ValueError("Azure response contained no choices")

    content = choices[0].get("message", {}).get("content") or ""
    finish_reason = choices[0].get("finish_reason", "unknown")
    logger.debug("Azure finish_reason: {}, content length: {}", finish_reason, len(content))
    logger.debug("Azure raw content (first 500 chars): {}", content[:500])

    # Strip markdown code fences if present
    cleaned = re.sub(r"```(?:json)?\s*", "", content).strip()

    # Extract JSON array from response
    parsed = re.search(r"\[.*\]", cleaned, flags=re.DOTALL)
    if not parsed:
        logger.warning("No JSON array found in Azure response. Full content:\n{}", content[:2000])
        raise ValueError("No JSON array found in Azure response")

    questions_raw = json.loads(parsed.group(0))
    normalized: list[dict[str, Any]] = []
    for idx, item in enumerate(questions_raw[:question_count]):
        options = item.get("options") or []
        if len(options) < 4:
            continue
        answer = str(item.get("answer", options[0])).strip()
        # Ensure answer is one of the options
        if answer not in [str(o).strip() for o in options[:4]]:
            answer = str(options[0]).strip()
        normalized.append(
            {
                "id": idx + 1,
                "question": str(item.get("question", "")).strip(),
                "options": [str(opt).strip() for opt in options[:4]],
                "answer": answer,
            }
        )

    if len(normalized) < max(3, question_count // 2):
        raise ValueError("Azure result quality too low")

    return normalized


def _hf_generate(job: dict[str, Any], question_count: int, difficulty: str) -> list[dict[str, Any]]:
    from huggingface_hub import InferenceClient

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


def generate_questions(job: dict[str, Any], question_count: int, difficulty: str, resume_skills: list[str] | None = None) -> list[dict[str, Any]]:
    # Try Azure OpenAI first if configured
    if settings.use_azure_openai:
        try:
            result = _azure_generate(job, question_count, difficulty, resume_skills)
            logger.info("Generated {} questions via Azure OpenAI", len(result))
            return result
        except Exception as exc:
            logger.error("Azure question generation failed: {!r}", exc)
            logger.error("Check Azure endpoint, API key, and deployment name in .env")

    # Try HuggingFace
    if settings.use_hf_llm:
        try:
            return _hf_generate(job, question_count, difficulty)
        except Exception:
            return _default_questions(job, question_count, difficulty)

    return _default_questions(job, question_count, difficulty)
