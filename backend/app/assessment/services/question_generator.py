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

SKILL_QUESTION_BANK: dict[str, list[dict[str, Any]]] = {
    "python": [
        {
            "question": "In Python, which approach best avoids blocking I/O when calling multiple external APIs?",
            "options": [
                "Use asyncio with async HTTP clients and await gathered tasks",
                "Use a for-loop with synchronous requests and time.sleep between calls",
                "Use global variables so requests can share state faster",
                "Call each API sequentially to preserve interpreter stability",
            ],
            "answer": "Use asyncio with async HTTP clients and await gathered tasks",
        },
        {
            "question": "What is the strongest reason to use virtual environments in Python projects?",
            "options": [
                "To isolate dependencies per project and avoid version conflicts",
                "To make Python code run without installing the interpreter",
                "To remove the need for requirements files",
                "To automatically optimize CPU-intensive loops",
            ],
            "answer": "To isolate dependencies per project and avoid version conflicts",
        },
    ],
    "react": [
        {
            "question": "In React, what is the most reliable way to avoid unnecessary re-renders for expensive child components?",
            "options": [
                "Memoize the child and pass stable props via useMemo/useCallback",
                "Move all state into local variables inside render",
                "Trigger setState in every effect to keep values fresh",
                "Use inline object literals for all props",
            ],
            "answer": "Memoize the child and pass stable props via useMemo/useCallback",
        },
        {
            "question": "Which pattern best handles API loading, success, and error states in a React view?",
            "options": [
                "Model explicit status states and render conditionally for each status",
                "Only render data once and ignore loading/error transitions",
                "Use a single boolean and infer every state from it",
                "Store all API responses in window globals",
            ],
            "answer": "Model explicit status states and render conditionally for each status",
        },
    ],
    "javascript": [
        {
            "question": "What is the key behavioral difference between == and === in JavaScript?",
            "options": [
                "=== checks type and value; == can coerce types before comparison",
                "== is faster and always safer for primitives",
                "=== only works for numbers",
                "There is no difference in modern JavaScript",
            ],
            "answer": "=== checks type and value; == can coerce types before comparison",
        }
    ],
    "sql": [
        {
            "question": "For a frequently filtered SQL column, what usually improves query performance first?",
            "options": [
                "Create an index on the filter column used in WHERE clauses",
                "Duplicate the table into multiple schemas",
                "Replace joins with subqueries in all cases",
                "Store all values as text for flexibility",
            ],
            "answer": "Create an index on the filter column used in WHERE clauses",
        },
        {
            "question": "Which SQL join returns all rows from the left table and matching rows from the right table?",
            "options": [
                "LEFT JOIN",
                "INNER JOIN",
                "CROSS JOIN",
                "SELF JOIN",
            ],
            "answer": "LEFT JOIN",
        },
    ],
    "api": [
        {
            "question": "Which API design choice best supports backward compatibility over time?",
            "options": [
                "Version endpoints and avoid breaking existing response fields",
                "Rename fields frequently to match new client naming",
                "Return different shapes for the same endpoint per request",
                "Depend on undocumented response ordering",
            ],
            "answer": "Version endpoints and avoid breaking existing response fields",
        }
    ],
    "node": [
        {
            "question": "In Node.js services, what prevents the event loop from being blocked by CPU-heavy work?",
            "options": [
                "Move CPU-heavy tasks to worker threads or background workers",
                "Run CPU-heavy loops directly in request handlers",
                "Disable async/await to reduce scheduling overhead",
                "Use setTimeout around all expensive operations",
            ],
            "answer": "Move CPU-heavy tasks to worker threads or background workers",
        }
    ],
    "docker": [
        {
            "question": "What is the main production benefit of a small Docker image?",
            "options": [
                "Faster pull/deploy times and reduced attack surface",
                "Automatic horizontal scaling without orchestration",
                "No need for dependency management in CI/CD",
                "Guaranteed zero cold starts",
            ],
            "answer": "Faster pull/deploy times and reduced attack surface",
        }
    ],
    "aws": [
        {
            "question": "For stateless web services on AWS, which setup most directly enables autoscaling?",
            "options": [
                "Run services behind a load balancer with an autoscaling group",
                "Store session state only in local instance memory",
                "Use one large instance with manual restart scripts",
                "Disable health checks to avoid replacement churn",
            ],
            "answer": "Run services behind a load balancer with an autoscaling group",
        }
    ],
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
    title = str(job.get("title") or "this role").strip()
    description = str(job.get("description") or "")
    skills = [str(item).strip() for item in ((job.get("skills_required") or []) + (job.get("additional_skills") or [])) if str(item).strip()]
    keywords = list(dict.fromkeys([*skills, *_extract_keywords(description, top_n=24)]))
    if len(keywords) < 4:
        keywords += ["api design", "data modeling", "debugging", "testing"]

    scenario_stems = [
        "({difficulty}) For the {title} role, a production issue is tied to {topic}. What is the best first action?",
        "({difficulty}) In a {title} assessment, which approach to {topic} is most reliable in real systems?",
        "({difficulty}) A teammate asks for guidance on {topic}. Which recommendation reflects strong engineering judgement?",
    ]
    correct_templates = [
        "Define measurable requirements, implement with tests, and validate with monitoring.",
        "Use a design that is observable, resilient to failure, and documented for maintenance.",
        "Start with constraints, choose a maintainable approach, and verify with production-like checks.",
    ]
    distractor_templates = [
        "Prioritize speed only and skip validation to deliver quickly.",
        "Choose the most complex design by default to future-proof everything.",
        "Rely on assumptions without tests or operational metrics.",
        "Defer ownership and avoid documenting trade-offs.",
        "Treat every incident as user error instead of investigating root causes.",
    ]

    used_questions: set[str] = set()
    questions: list[dict[str, Any]] = []
    for index in range(question_count):
        topic = str(keywords[index % len(keywords)] or "engineering fundamentals").strip()
        topic_l = topic.lower()
        bank_items: list[dict[str, Any]] = []
        for key, entries in SKILL_QUESTION_BANK.items():
            if key in topic_l or topic_l in key:
                bank_items.extend(entries)

        selected_item = None
        for candidate in random.sample(bank_items, len(bank_items)) if bank_items else []:
            q = str(candidate.get("question", "")).strip()
            if q and q not in used_questions:
                selected_item = candidate
                break

        if selected_item is not None:
            q_text = str(selected_item.get("question", "")).strip()
            options = [str(opt).strip() for opt in (selected_item.get("options") or [])[:4]]
            answer = str(selected_item.get("answer", "")).strip()
            if answer not in options and options:
                answer = options[0]
            while len(options) < 4:
                options.append(f"Placeholder option {len(options) + 1}")
        else:
            stem = random.choice(scenario_stems).format(
                difficulty=difficulty.title(),
                title=title,
                topic=topic,
            )
            q_text = stem
            correct = random.choice(correct_templates)
            distractors = random.sample(distractor_templates, k=3)
            options = distractors + [correct]
            random.shuffle(options)
            answer = correct

        used_questions.add(q_text)
        questions.append(
            {
                "id": index + 1,
                "question": q_text,
                "options": options,
                "answer": answer,
            }
        )

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
    job_skills_text = f"\nRequired skills: {', '.join(job_skills[:20])}" if job_skills else ""

    extra_context = ""
    if job.get("education"):
        extra_context += f"\nEducation requirement: {job['education']}"
    if job.get("years_experience") is not None:
        extra_context += f"\nExperience level: {job['years_experience']}+ years"
    if job.get("employment_type"):
        extra_context += f"\nEmployment type: {job['employment_type']}"
    if job.get("location"):
        extra_context += f"\nLocation: {job['location']}"

    system_prompt = (
        "You are a senior interviewer creating a standardized role-aligned assessment. "
        "Generate practical interview-style MCQs based on the job title, description, required skills, "
        "and experience level. Each question should test relevant fundamentals and applied judgement, "
        "not obscure trivia. Use professional interview language and keep all options plausible. "
        "Each question must have exactly 4 options and exactly 1 correct answer. "
        "Return ONLY a valid JSON array, no markdown or commentary."
    )

    user_prompt = (
        f"Generate exactly {question_count} multiple-choice interview questions for the role below.\n"
        f"Difficulty: {difficulty}\n"
        f"Job Title: {job.get('title', 'Software Engineer')}\n"
        f"Job Description: {job.get('description', '')[:2000]}"
        f"{job_skills_text}"
        f"{extra_context}"
        f"{skills_text}\n\n"
        f"Requirements:\n"
        f"- Questions must be {difficulty} difficulty and directly relevant to this specific role\n"
        f"- Prioritise topics from the required skills list above all else\n"
        f"- Match the experience level: {'entry/junior level' if (job.get('years_experience') or 0) <= 1 else 'mid level' if (job.get('years_experience') or 0) <= 3 else 'senior level'} questions\n"
        f"- Prefer practical scenarios and decision making over pure definitions\n"
        f"- Avoid generic questions that could apply to any role\n"
        f"- Each question object must have: id (integer starting from 1), question (string), options (array of exactly 4 strings), answer (string matching one of the options exactly)\n"
        f"- Return ONLY a JSON array of {question_count} question objects"
    )

    headers = {"api-key": api_key, "Content-Type": "application/json"}
    payload = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_completion_tokens": 4096,
    }

    _verify_ssl = not bool(settings.hf_disable_ssl_verify)
    response = httpx.post(url, headers=headers, json=payload, timeout=90.0, verify=_verify_ssl)

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
    seen_questions: set[str] = set()
    for idx, item in enumerate(questions_raw[:question_count]):
        options = item.get("options") or []
        if len(options) < 4:
            continue
        question_text = re.sub(r"^\s*\d+[\).:-]?\s*", "", str(item.get("question", "")).strip())
        if len(question_text) < 18:
            continue
        if question_text.lower() in seen_questions:
            continue

        cleaned_options: list[str] = []
        for opt in options:
            value = str(opt).strip()
            if not value:
                continue
            if value in cleaned_options:
                continue
            cleaned_options.append(value)
            if len(cleaned_options) >= 4:
                break
        if len(cleaned_options) < 4:
            continue

        answer = str(item.get("answer", options[0])).strip()
        # Ensure answer is one of the options
        if answer not in cleaned_options:
            answer = cleaned_options[0]

        seen_questions.add(question_text.lower())
        normalized.append(
            {
                "id": idx + 1,
                "question": question_text,
                "options": cleaned_options,
                "answer": answer,
            }
        )

    if len(normalized) < max(3, question_count // 2):
        raise ValueError("Azure result quality too low")

    return normalized


def _build_llm_prompt(job: dict[str, Any], question_count: int, difficulty: str, resume_skills: list[str] | None = None) -> tuple[str, str]:
    """Build (system_prompt, user_prompt) shared by Groq and Cerebras generators."""
    job_skills = (job.get("skills_required") or []) + (job.get("additional_skills") or [])
    job_skills_text = f"\nRequired skills: {', '.join(job_skills[:20])}" if job_skills else ""
    skills_text = f"\nCandidate's resume skills: {', '.join((resume_skills or [])[:20])}" if resume_skills else ""
    extra_context = ""
    if job.get("education"):
        extra_context += f"\nEducation requirement: {job['education']}"
    if job.get("years_experience") is not None:
        extra_context += f"\nExperience level: {job['years_experience']}+ years"
    if job.get("employment_type"):
        extra_context += f"\nEmployment type: {job['employment_type']}"

    exp_years = job.get("years_experience") or 0
    level_label = "entry/junior level" if exp_years <= 1 else "mid level" if exp_years <= 3 else "senior level"

    system_prompt = (
        "You are a senior interviewer creating a standardized role-aligned assessment. "
        "Generate practical interview-style MCQs based on the job title, description, required skills, "
        "and experience level. Each question must have exactly 4 options and exactly 1 correct answer. "
        "Return ONLY a valid JSON array, no markdown or commentary."
    )
    user_prompt = (
        f"Generate exactly {question_count} multiple-choice interview questions for the role below.\n"
        f"Difficulty: {difficulty}\n"
        f"Job Title: {job.get('title', 'Software Engineer')}\n"
        f"Job Description: {job.get('description', '')[:1500]}"
        f"{job_skills_text}"
        f"{extra_context}"
        f"{skills_text}\n\n"
        f"Requirements:\n"
        f"- Questions must be {difficulty} difficulty and directly relevant to this specific role\n"
        f"- Prioritise topics from the required skills list\n"
        f"- Match experience level: {level_label}\n"
        f"- Avoid generic questions that could apply to any role\n"
        f"- Each object: id (int from 1), question (str), options (array of 4 str), answer (str matching one option)\n"
        f"- Return ONLY a JSON array of {question_count} question objects"
    )
    return system_prompt, user_prompt


def _parse_llm_questions(content: str, question_count: int) -> list[dict[str, Any]]:
    """Parse and normalise a JSON array of questions from any LLM response."""
    cleaned = re.sub(r"```(?:json)?\s*", "", content).strip()
    parsed = re.search(r"\[.*\]", cleaned, flags=re.DOTALL)
    if not parsed:
        raise ValueError("No JSON array found in LLM response")
    questions_raw = json.loads(parsed.group(0))
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for idx, item in enumerate(questions_raw[:question_count]):
        options = [str(o).strip() for o in (item.get("options") or []) if str(o).strip()]
        if len(options) < 4:
            continue
        options = options[:4]
        q_text = re.sub(r"^\s*\d+[\).:-]?\s*", "", str(item.get("question", "")).strip())
        if len(q_text) < 10 or q_text.lower() in seen:
            continue
        answer = str(item.get("answer", options[0])).strip()
        if answer not in options:
            answer = options[0]
        seen.add(q_text.lower())
        normalized.append({"id": idx + 1, "question": q_text, "options": options, "answer": answer})
    if len(normalized) < max(3, question_count // 2):
        raise ValueError("LLM result quality too low")
    return normalized


def _groq_generate(job: dict[str, Any], question_count: int, difficulty: str, resume_skills: list[str] | None = None) -> list[dict[str, Any]]:
    api_key = (settings.groq_api_key or "").strip()
    if not api_key:
        raise ValueError("GROQ_API_KEY is missing")
    system_prompt, user_prompt = _build_llm_prompt(job, question_count, difficulty, resume_skills)
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": settings.groq_model,
        "temperature": 0.3,
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
    }
    _verify_ssl = not bool(settings.hf_disable_ssl_verify)
    response = httpx.post(url, headers=headers, json=payload, timeout=45.0, verify=_verify_ssl)
    if response.status_code >= 400:
        raise ValueError(f"Groq request failed: {response.status_code}")
    content = response.json()["choices"][0]["message"]["content"]
    result = _parse_llm_questions(content, question_count)
    logger.info("Generated {} questions via Groq", len(result))
    return result


def _cerebras_generate(job: dict[str, Any], question_count: int, difficulty: str, resume_skills: list[str] | None = None) -> list[dict[str, Any]]:
    api_key = (settings.cerebras_api_key or "").strip()
    if not api_key:
        raise ValueError("CEREBRAS_API_KEY is missing")
    system_prompt, user_prompt = _build_llm_prompt(job, question_count, difficulty, resume_skills)
    url = "https://api.cerebras.ai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": settings.cerebras_model,
        "temperature": 0.3,
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
    }
    _verify_ssl = not bool(settings.hf_disable_ssl_verify)
    response = httpx.post(url, headers=headers, json=payload, timeout=45.0, verify=_verify_ssl)
    if response.status_code >= 400:
        raise ValueError(f"Cerebras request failed: {response.status_code}")
    content = response.json()["choices"][0]["message"]["content"]
    result = _parse_llm_questions(content, question_count)
    logger.info("Generated {} questions via Cerebras", len(result))
    return result


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


def generate_questions(
    job: dict[str, Any],
    question_count: int,
    difficulty: str,
    resume_skills: list[str] | None = None,
    generation_mode: str = "auto",
) -> list[dict[str, Any]]:
    mode = (generation_mode or "auto").strip().lower()
    if mode == "fast":
        result = _default_questions(job, question_count, difficulty)
        logger.info("Generated {} questions via fast mode (default generator)", len(result))
        return result

    # Fallback chain: Azure OpenAI → Groq → Cerebras → HuggingFace → static bank
    if settings.use_azure_openai:
        try:
            return _azure_generate(job, question_count, difficulty, resume_skills)
        except Exception as exc:
            logger.warning("Azure question generation failed, trying Groq: {!r}", exc)

    if settings.use_groq and (settings.groq_api_key or "").strip():
        try:
            return _groq_generate(job, question_count, difficulty, resume_skills)
        except Exception as exc:
            logger.warning("Groq question generation failed, trying Cerebras: {!r}", exc)

    if settings.use_cerebras and (settings.cerebras_api_key or "").strip():
        try:
            return _cerebras_generate(job, question_count, difficulty, resume_skills)
        except Exception as exc:
            logger.warning("Cerebras question generation failed, trying HuggingFace: {!r}", exc)

    if settings.use_hf_llm:
        try:
            return _hf_generate(job, question_count, difficulty)
        except Exception as exc:
            logger.warning("HuggingFace question generation failed, using static bank: {!r}", exc)

    logger.warning("All AI question generation providers failed — using static question bank")
    return _default_questions(job, question_count, difficulty)
