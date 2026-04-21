from __future__ import annotations

import json as _json
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import decode_token
from ..auth_utils import resolve_access_token
from ..config import settings
from ..db import get_db
from ..deps import get_current_admin
from ..models import Candidate, Job, User

router = APIRouter(prefix="/api/chat", tags=["chat"])
bearer_scheme = HTTPBearer(auto_error=False)

# â”€â”€â”€ Schemas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str = Field(..., max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list)


class ChatResponse(BaseModel):
    reply: str
    action: dict | None = None


class JobSuggestRequest(BaseModel):
    title: str = Field(..., max_length=255)
    description: str = Field(default="", max_length=5000)
    skills_required: list[str] = Field(default_factory=list)
    additional_skills: list[str] = Field(default_factory=list)
    location: str | None = None
    employment_type: str | None = None
    years_experience: int | None = None
    education: str | None = None


class JobSuggestResponse(BaseModel):
    suggested_skills: list[str] = Field(default_factory=list)
    suggested_additional_skills: list[str] = Field(default_factory=list)
    suggested_description: str = ""
    tips: list[str] = Field(default_factory=list)


# â”€â”€â”€ Shared LLM caller â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def _check_llm_configured() -> None:
    if not settings.azure_openai_api_key and not settings.groq_api_key and not getattr(settings, "cerebras_api_key", None) and not getattr(settings, "gemini_api_key", None):
        raise HTTPException(
            status_code=503,
            detail="AI service is not configured (set AZURE_OPENAI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, or GEMINI_API_KEY).",
        )


async def _call_llm(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 1024,
    temperature: float = 0.7,
) -> str:
    """Call LLM with automatic provider fallback: Azure OpenAI -> Groq -> Cerebras -> Gemini."""

    async def _openai_compat(
        client: httpx.AsyncClient, base_url: str, api_key: str, model: str,
    ) -> str:
        r = await client.post(
            f"{base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

    async def _azure(client: httpx.AsyncClient) -> str:
        endpoint = str(settings.azure_openai_endpoint or "").rstrip("/")
        deployment = settings.azure_openai_deployment or "gpt-5-mini"
        api_version = settings.azure_openai_api_version or "2024-12-01-preview"
        url = f"{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={api_version}"
        r = await client.post(
            url,
            headers={"api-key": settings.azure_openai_api_key or "", "Content-Type": "application/json"},
            json={"messages": messages, "max_tokens": max_tokens, "temperature": temperature},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

    async def _gemini(client: httpx.AsyncClient) -> str:
        model = getattr(settings, "gemini_model", "gemini-1.5-flash")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        # Convert chat messages to Gemini format
        gemini_contents: list[dict[str, Any]] = []
        system_text = ""
        for msg in messages:
            if msg["role"] == "system":
                system_text = msg["content"]
                continue
            role = "model" if msg["role"] == "assistant" else "user"
            content = msg["content"]
            if role == "user" and not gemini_contents and system_text:
                content = system_text + "\n\n" + content
            gemini_contents.append({"role": role, "parts": [{"text": content}]})
        r = await client.post(
            url,
            params={"key": settings.gemini_api_key},
            json={"contents": gemini_contents, "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens}},
        )
        r.raise_for_status()
        return r.json()["candidates"][0]["content"]["parts"][0]["text"]

    last_error = ""
    _verify = not bool(settings.hf_disable_ssl_verify)
    if settings.azure_openai_api_key and settings.azure_openai_endpoint:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=90.0, write=10.0, pool=5.0), verify=_verify) as _az_client:
                return await _azure(_az_client)
        except Exception as exc:
            last_error = str(exc)

    async with httpx.AsyncClient(timeout=30.0, verify=_verify) as client:
        if settings.azure_openai_api_key and settings.azure_openai_endpoint:
            pass  # already tried above

        if settings.groq_api_key:
            try:
                return await _openai_compat(
                    client, "https://api.groq.com/openai/v1",
                    settings.groq_api_key, settings.groq_model or "llama-3.1-8b-instant",
                )
            except Exception as exc:
                last_error = str(exc)

        if getattr(settings, "cerebras_api_key", None):
            try:
                return await _openai_compat(
                    client, "https://api.cerebras.ai/v1",
                    settings.cerebras_api_key, getattr(settings, "cerebras_model", "llama-3.1-8b"),
                )
            except Exception as exc:
                last_error = str(exc)

        if getattr(settings, "gemini_api_key", None):
            try:
                return await _gemini(client)
            except Exception as exc:
                last_error = str(exc)

    raise HTTPException(status_code=502, detail=f"All AI providers failed. Last error: {last_error}")


def _strip_json_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
    if cleaned.endswith("```"):
        cleaned = cleaned.rsplit("```", 1)[0]
    return cleaned.strip()


# â”€â”€â”€ Auth helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


async def _get_optional_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    token = resolve_access_token(request=request, credentials=credentials)
    if not token:
        return None
    payload = decode_token(token)
    if not payload:
        return None
    user_id = payload.get("user_id")
    if not user_id:
        return None
    user = await db.get(User, int(user_id))
    return user if user and user.is_active else None


# â”€â”€â”€ Candidate chatbot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


@router.post("/message", response_model=ChatResponse)
async def chat_message(
    payload: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(_get_optional_user),
) -> ChatResponse:
    """Candidate-facing career assistant chatbot with job links."""
    _check_llm_configured()

    jobs_result = await db.execute(select(Job).order_by(Job.id.desc()).limit(30))
    jobs: list[Job] = list(jobs_result.scalars().all())

    jobs_context = ""
    for job in jobs:
        skills = ", ".join(job.skills_required or []) if job.skills_required else "Not specified"
        jobs_context += (
            f"- [JOB_ID:{job.id}] **{job.title}** | Location: {job.location or 'Remote'} | "
            f"Type: {job.employment_type or 'N/A'} | "
            f"Experience: {job.years_experience or 0}+ yrs | Skills: {skills}\n"
        )

    profile_context = ""
    if current_user:
        role = str(getattr(current_user, "role", "candidate") or "candidate").strip().lower()
        if role == "candidate":
            cand_result = await db.execute(
                select(Candidate).where(Candidate.email == current_user.email),
            )
            candidate = cand_result.scalar_one_or_none()
            if candidate:
                cskills = ", ".join(candidate.skills or []) if candidate.skills else "Not specified"
                profile_context = (
                    f"\nCandidate Profile:\n"
                    f"- Name: {candidate.full_name or 'Unknown'}\n"
                    f"- Skills: {cskills}\n"
                    f"- Experience: {candidate.years_experience or 0} years\n"
                    f"- Location: {candidate.location or 'Not specified'}\n"
                )

    system_prompt = (
        "You are a helpful career advisor for SmartHire, an AI-powered recruitment platform. "
        "Help candidates discover job openings and guide them through the application process.\n\n"
        f"Available Jobs on SmartHire:\n{jobs_context or 'No jobs are currently posted.'}\n"
        f"{profile_context}"
        "\nGuidelines:\n"
        "- Suggest relevant jobs from the list based on the candidate's profile and interests.\n"
        "- When mentioning a job, ALWAYS include the link in this exact format: [Job Title](/careers?highlight=JOB_ID)\n"
        "  For example: [AI Engineer](/careers?highlight=5)\n"
        "- Answer questions about job requirements, skills, career paths, and application steps.\n"
        "- Be concise, friendly, and encouraging.\n"
        "- Only suggest jobs that exist in the provided list â€” never invent new ones.\n"
        "- If no jobs match, advise the candidate to update their profile or check back later.\n"
        "- Keep responses under 200 words unless more detail is clearly needed.\n"
        "- Use markdown formatting for readability."
    )

    msgs: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for msg in (payload.history or [])[-10:]:
        r = str(msg.role or "user").lower()
        if r in ("user", "assistant"):
            msgs.append({"role": r, "content": str(msg.content or "")})
    msgs.append({"role": "user", "content": payload.message})

    reply = await _call_llm(msgs, max_tokens=600)
    return ChatResponse(reply=reply)


# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
#  ADMIN SUPERVISOR AGENT
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

_SUPERVISOR_SYSTEM = """You are an AI supervisor agent for SmartHire's admin panel.
Classify the admin's intent into one of these actions:

1. "create_job" - Admin wants to create/draft a new job description.
2. "schedule_interviews" - Admin wants to schedule call interviews for candidates.
3. "general" - General conversation, questions, or anything else.

Respond ONLY with valid JSON:
{"intent": "create_job" | "schedule_interviews" | "general", "extracted_info": {}}

For "create_job" extract any mentioned: title, description, skills, location, experience, education, employment_type.
For "schedule_interviews" extract any mentioned: candidate names, emails, "all", time preferences.
Respond ONLY with JSON. No markdown, no explanation."""


async def _classify_admin_intent(message: str, history: list[ChatMessage]) -> dict:
    msgs: list[dict[str, Any]] = [{"role": "system", "content": _SUPERVISOR_SYSTEM}]
    for h in (history or [])[-4:]:
        r = str(h.role or "user").lower()
        if r in ("user", "assistant"):
            msgs.append({"role": r, "content": str(h.content or "")})
    msgs.append({"role": "user", "content": message})

    raw = await _call_llm(msgs, max_tokens=300, temperature=0.1)
    try:
        return _json.loads(_strip_json_fences(raw))
    except _json.JSONDecodeError:
        return {"intent": "general", "extracted_info": {}}


# â”€â”€ Tool: create_job â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


async def _handle_create_job(
    message: str, history: list[ChatMessage], extracted: dict, db: AsyncSession,
) -> ChatResponse:
    lower_msg = message.strip().lower()
    is_confirm = any(
        w in lower_msg
        for w in ["yes", "confirm", "create it", "looks good", "go ahead", "approve", "save", "post it", "lgtm"]
    )

    # If confirming, look for the last job JSON draft in history
    if is_confirm and history:
        for h in reversed(history):
            if h.role != "assistant" or '"title"' not in h.content:
                continue
            content = h.content
            json_str = ""
            if "```json" in content:
                start = content.index("```json") + 7
                end = content.index("```", start)
                json_str = content[start:end].strip()
            elif "```" in content:
                start = content.index("```") + 3
                end = content.index("```", start)
                json_str = content[start:end].strip()
            else:
                brace_s = content.find("{")
                brace_e = content.rfind("}")
                if brace_s != -1 and brace_e != -1:
                    json_str = content[brace_s : brace_e + 1]
            if not json_str:
                continue
            try:
                job_data = _json.loads(json_str)
            except _json.JSONDecodeError:
                continue
            if not job_data.get("title"):
                continue

            new_job = Job(
                title=str(job_data["title"]),
                description=str(job_data.get("description", "")),
                skills_required=job_data.get("skills_required") or job_data.get("skills", []),
                additional_skills=job_data.get("additional_skills", []),
                location=str(job_data.get("location", "")) or None,
                employment_type=str(job_data.get("employment_type", "")) or None,
                years_experience=int(job_data.get("years_experience") or 0) or None,
                education=str(job_data.get("education", "")) or None,
            )
            db.add(new_job)
            await db.commit()
            await db.refresh(new_job)
            logger.info("Admin chatbot created job id={} title={}", new_job.id, new_job.title)
            return ChatResponse(
                reply=f"Job **{new_job.title}** has been created successfully! (ID: {new_job.id})\n\nIt's now live on the careers page.",
                action={"type": "job_created", "job_id": new_job.id, "title": new_job.title},
            )

    # Generate a job description draft
    existing_result = await db.execute(select(Job.title).order_by(Job.id.desc()).limit(10))
    existing_titles = [t for (t,) in existing_result.all()]
    existing_ctx = "\n".join(f"- {t}" for t in existing_titles) if existing_titles else "None"

    gen_prompt = (
        "You are an expert HR/recruitment AI. The admin wants to create a new job posting.\n"
        "Generate a complete job description based on their prompt.\n\n"
        f"Existing jobs on the platform:\n{existing_ctx}\n\n"
        "Return your response in this EXACT format (use bold markdown with **):\n\n"
        "Here's the job posting I've prepared:\n\n"
        "**Title:** [job title]\n"
        "**Location:** [location]\n"
        "**Type:** [employment type]\n"
        "**Experience:** [X]+ years\n"
        "**Education:** [education requirement]\n\n"
        "**Description:**\n[3-5 detailed sentences]\n\n"
        "**Required Skills:**\n- [skill 1]\n- [skill 2]\n...\n\n"
        "**Nice to Have:**\n- [skill 1]\n- [skill 2]\n...\n\n"
        "Then on the VERY LAST LINE, include a hidden JSON block like this:\n"
        "```json\n{\"title\": \"...\", \"description\": \"...\", \"skills_required\": [\"...\"], "
        "\"additional_skills\": [\"...\"], \"location\": \"...\", \"employment_type\": \"Full-time\", "
        "\"years_experience\": 0, \"education\": \"...\"}\n```\n\n"
        "After the formatted details (but BEFORE the json block), ask:\n"
        "'Would you like me to create this job? You can ask me to modify any field first.'\n\n"
        "IMPORTANT: The user will see everything EXCEPT the json block. The json block is used internally."
    )

    msgs: list[dict[str, Any]] = [{"role": "system", "content": gen_prompt}]
    for h in (history or [])[-6:]:
        r = str(h.role or "user").lower()
        if r in ("user", "assistant"):
            msgs.append({"role": r, "content": str(h.content or "")})
    msgs.append({"role": "user", "content": message})

    reply = await _call_llm(msgs, max_tokens=800)
    return ChatResponse(reply=reply, action={"type": "job_draft"})


# â”€â”€ Tool: schedule_interviews â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


async def _handle_schedule_interviews(
    message: str, history: list[ChatMessage], extracted: dict, db: AsyncSession,
) -> ChatResponse:
    assessment_base = (settings.assessment_api_base_url or "").strip().rstrip("/")
    if not assessment_base:
        return ChatResponse(reply="Assessment service URL is not configured. Cannot schedule interviews.")

    # Fetch eligible sessions
    sessions: list[dict] = []
    try:
        _verify = not bool(settings.hf_disable_ssl_verify)
        async with httpx.AsyncClient(timeout=15.0, verify=_verify) as client:
            r = await client.get(
                f"{assessment_base}/api/admin/exams",
                params={"assessment_type": "onscreen", "limit": "100"},
            )
            if r.status_code == 200:
                data = r.json()
                sessions = data if isinstance(data, list) else []
    except Exception as exc:
        logger.warning("Failed to fetch sessions for scheduling: {}", exc)

    eligible = []
    for s in sessions:
        status = str(s.get("status", "")).lower()
        call_status = str(s.get("call_status", "") or "").lower()
        passed = s.get("passed")
        if status == "submitted" and passed and call_status not in ("completed", "in-progress"):
            eligible.append({
                "session_code": s.get("session_code"),
                "candidate_name": s.get("candidate_name"),
                "candidate_email": s.get("candidate_email"),
                "job_title": s.get("job_title", "Unknown"),
                "score": s.get("percentage"),
                "call_status": call_status or "not_scheduled",
            })

    if not eligible:
        return ChatResponse(
            reply="No candidates are currently eligible for interview scheduling. "
            "Candidates must have passed their assessment first.",
        )

    eligible_text = "\n".join(
        f"- {e['candidate_name']} ({e['candidate_email']}) â€” Job: {e['job_title']}, "
        f"Score: {e['score']}%, Session: {e['session_code']}, Call: {e['call_status']}"
        for e in eligible
    )

    sched_prompt = (
        "You are an admin assistant for SmartHire. The admin wants to schedule call interviews.\n\n"
        f"Eligible candidates (passed assessment, not yet interviewed):\n{eligible_text}\n\n"
        "Based on the admin's request, determine which candidates to schedule.\n"
        "Return ONLY valid JSON:\n"
        '{"schedule": [{"session_code": "...", "candidate_name": "...", "delay_seconds": 60}], '
        '"summary": "Human-readable summary"}\n\n'
        "Rules:\n"
        "- If admin says 'all', schedule all eligible.\n"
        "- If admin mentions names/emails, match them.\n"
        "- Default delay_seconds = 60. Adjust if admin specifies timing.\n"
        "Respond ONLY with JSON."
    )

    msgs: list[dict[str, Any]] = [{"role": "system", "content": sched_prompt}]
    msgs.append({"role": "user", "content": message})

    raw = await _call_llm(msgs, max_tokens=500, temperature=0.1)
    try:
        plan = _json.loads(_strip_json_fences(raw))
    except _json.JSONDecodeError:
        return ChatResponse(
            reply=f"I found {len(eligible)} eligible candidates but couldn't parse the scheduling plan. "
            "Could you rephrase your request?",
        )

    to_schedule = plan.get("schedule", [])
    summary = plan.get("summary", "")

    if not to_schedule:
        return ChatResponse(
            reply=f"I found **{len(eligible)}** eligible candidates but none matched your criteria.\n\n"
            f"**Eligible candidates:**\n{eligible_text}\n\n"
            "Please specify which candidates to schedule or say **'schedule all'**.",
        )

    # Execute scheduling
    scheduled: list[str] = []
    failed: list[str] = []
    _verify = not bool(settings.hf_disable_ssl_verify)
    for item in to_schedule:
        code = str(item.get("session_code", "")).strip()
        delay = int(item.get("delay_seconds", 60))
        name = item.get("candidate_name", code)
        if not code:
            continue
        try:
            async with httpx.AsyncClient(timeout=20.0, verify=_verify) as client:
                r = await client.post(
                    f"{assessment_base}/api/admin/exams/{code}/schedule-call",
                    json={"threshold_percentage": 60, "delay_seconds": delay},
                )
                if r.status_code == 200:
                    scheduled.append(f"- **{name}** â€” scheduled (delay: {delay}s)")
                else:
                    detail = ""
                    try:
                        detail = r.json().get("detail", "")
                    except Exception:
                        pass
                    failed.append(f"- **{name}** â€” failed: {detail or r.status_code}")
        except Exception as exc:
            failed.append(f"- **{name}** â€” error: {exc}")

    parts = []
    if summary:
        parts.append(summary)
    if scheduled:
        parts.append(f"\n**Successfully scheduled ({len(scheduled)}):**\n" + "\n".join(scheduled))
    if failed:
        parts.append(f"\n**Failed ({len(failed)}):**\n" + "\n".join(failed))

    return ChatResponse(
        reply="\n".join(parts) or "No candidates were scheduled.",
        action={"type": "interviews_scheduled", "scheduled_count": len(scheduled), "failed_count": len(failed)},
    )


# â”€â”€ General admin chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


async def _handle_general_admin(
    message: str, history: list[ChatMessage], db: AsyncSession,
) -> ChatResponse:
    from sqlalchemy import func as sa_func

    job_count_r = await db.execute(select(sa_func.count(Job.id)))
    job_count = job_count_r.scalar() or 0
    cand_count_r = await db.execute(select(sa_func.count(Candidate.id)))
    cand_count = cand_count_r.scalar() or 0

    system_prompt = (
        "You are an AI assistant for SmartHire's admin panel.\n\n"
        f"Platform stats: {job_count} jobs posted, {cand_count} candidates registered.\n\n"
        "You can help with:\n"
        "1. **Creating job descriptions** â€” ask the admin to describe the role.\n"
        "2. **Scheduling interview calls** â€” for candidates who passed assessments.\n"
        "3. **General questions** about the platform.\n\n"
        "Be concise, professional, and helpful. Use markdown."
    )

    msgs: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for h in (history or [])[-8:]:
        r = str(h.role or "user").lower()
        if r in ("user", "assistant"):
            msgs.append({"role": r, "content": str(h.content or "")})
    msgs.append({"role": "user", "content": message})

    reply = await _call_llm(msgs, max_tokens=600)
    return ChatResponse(reply=reply)


# â”€â”€ Supervisor endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


@router.post("/admin", response_model=ChatResponse)
async def admin_chat(
    payload: ChatRequest,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> ChatResponse:
    """Admin supervisor agent â€” classifies intent and routes to the right tool."""
    _check_llm_configured()
    # Pre-check: if user is confirming a pending job draft, skip LLM classification
    _lower_msg = payload.message.strip().lower()
    _confirm_words = ["yes", "confirm", "create it", "looks good", "go ahead", "approve", "save", "post it", "lgtm", "yep", "sure", "do it", "ok", "okay"]
    _is_confirm = any(w in _lower_msg for w in _confirm_words)
    if _is_confirm and payload.history:
        for _h in reversed(payload.history):
            if _h.role == "assistant" and '"title"' in _h.content:
                logger.info("Admin chat: detected confirmation of pending job draft — routing to create_job")
                return await _handle_create_job(payload.message, payload.history, {}, db)
    classification = await _classify_admin_intent(payload.message, payload.history)
    intent = str(classification.get("intent", "general")).strip().lower()
    extracted = classification.get("extracted_info", {})
    logger.info("Admin chat intent={} extracted={}", intent, extracted)

    if intent == "create_job":
        return await _handle_create_job(payload.message, payload.history, extracted, db)
    elif intent == "schedule_interviews":
        return await _handle_schedule_interviews(payload.message, payload.history, extracted, db)
    else:
        return await _handle_general_admin(payload.message, payload.history, db)


# â”€â”€â”€ Job suggestions (existing) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


@router.post("/job-suggestions", response_model=JobSuggestResponse)
async def job_suggestions(
    payload: JobSuggestRequest,
    _user: User = Depends(_get_optional_user),
) -> JobSuggestResponse:
    _check_llm_configured()

    current_skills = ", ".join(payload.skills_required) if payload.skills_required else "None"
    current_extra = ", ".join(payload.additional_skills) if payload.additional_skills else "None"

    system_prompt = (
        "You are an expert recruitment AI assistant. Given a job posting draft, suggest improvements.\n"
        "Return a JSON object with exactly these keys:\n"
        '  "suggested_skills": list of 3-6 additional required skills not already listed\n'
        '  "suggested_additional_skills": list of 2-4 nice-to-have skills\n'
        '  "suggested_description": improved description (2-3 sentences) or empty string if current is good\n'
        '  "tips": list of 1-3 short tips to improve the posting\n'
        "Respond ONLY with valid JSON, no markdown fences or extra text."
    )

    user_prompt = (
        f"Job Title: {payload.title}\n"
        f"Description: {payload.description or 'Not provided'}\n"
        f"Current Required Skills: {current_skills}\n"
        f"Current Nice-to-have Skills: {current_extra}\n"
        f"Location: {payload.location or 'Not specified'}\n"
        f"Type: {payload.employment_type or 'Not specified'}\n"
        f"Experience: {payload.years_experience or 0}+ years\n"
        f"Education: {payload.education or 'Not specified'}"
    )

    msgs: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    raw_reply = await _call_llm(msgs, max_tokens=512)
    cleaned = _strip_json_fences(raw_reply)

    try:
        data = _json.loads(cleaned)
    except _json.JSONDecodeError:
        return JobSuggestResponse(tips=["AI returned an unexpected format. Please try again."])

    return JobSuggestResponse(
        suggested_skills=data.get("suggested_skills", [])[:8],
        suggested_additional_skills=data.get("suggested_additional_skills", [])[:6],
        suggested_description=str(data.get("suggested_description", "")),
        tips=data.get("tips", [])[:5],
    )
