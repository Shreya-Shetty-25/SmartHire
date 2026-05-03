import json as _json
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
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
from ..rate_limit import limiter

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
    if not settings.azure_openai_api_key or not settings.azure_openai_endpoint:
        raise HTTPException(
            status_code=503,
            detail="AI service is not configured (set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT).",
        )


async def _call_llm(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 1024,
) -> str:
    """Call Azure OpenAI LLM."""
    _verify = not bool(settings.hf_disable_ssl_verify)
    endpoint = str(settings.azure_openai_endpoint or "").rstrip("/")
    deployment = settings.azure_openai_deployment or "gpt-5-mini"
    api_version = settings.azure_openai_api_version or "2024-12-01-preview"
    url = f"{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={api_version}"

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=90.0, write=10.0, pool=5.0), verify=_verify) as client:
            r = await client.post(
                url,
                headers={"api-key": settings.azure_openai_api_key or "", "Content-Type": "application/json"},
                json={"messages": messages, "max_completion_tokens": max_tokens},
            )
            if r.status_code != 200:
                logger.error("Azure OpenAI error {}: {}", r.status_code, r.text)
            r.raise_for_status()
            resp_json = r.json()
            choice = resp_json.get("choices", [{}])[0]
            content = choice.get("message", {}).get("content")
            finish_reason = choice.get("finish_reason", "unknown")
            if not content:
                logger.warning("Azure OpenAI returned empty content. finish_reason={} response={}", finish_reason, _json.dumps(resp_json)[:500])
            return content or ""
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Azure OpenAI call exception: {}", exc)
        raise HTTPException(status_code=502, detail=f"Azure OpenAI call failed: {exc}")


def _strip_json_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
    if cleaned.endswith("```"):
        cleaned = cleaned.rsplit("```", 1)[0]
    return cleaned.strip()




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
@limiter.limit("30/minute")
async def chat_message(
    request: Request,
    payload: ChatRequest,
    response: Response,
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

    raw = await _call_llm(msgs, max_tokens=300)
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

    reply = await _call_llm(msgs, max_tokens=1200)
    logger.info("Create job LLM reply length={}", len(reply) if reply else 0)
    if not reply or not reply.strip():
        # Fallback: build a basic draft from the extracted fields
        if extracted and extracted.get("title"):
            fallback_data = {
                "title": extracted.get("title", "New Role"),
                "description": extracted.get("description", f"We are looking for a {extracted.get('title', 'professional')}."),
                "skills_required": extracted.get("skills_required", []),
                "additional_skills": extracted.get("additional_skills", []),
                "location": extracted.get("location", ""),
                "employment_type": extracted.get("employment_type", "Full-time"),
                "years_experience": extracted.get("years_experience", 0),
                "education": extracted.get("education", ""),
            }
            reply = (
                "Here's the job posting I've prepared:\n\n"
                f"**Title:** {fallback_data['title']}\n"
                f"**Location:** {fallback_data.get('location') or 'Not specified'}\n"
                f"**Type:** {fallback_data.get('employment_type') or 'Full-time'}\n"
                f"**Experience:** {fallback_data.get('years_experience', 0)}+ years\n"
                f"**Education:** {fallback_data.get('education') or 'Not specified'}\n\n"
                f"**Required Skills:**\n" + "\n".join(f"- {s}" for s in fallback_data.get("skills_required", [])) + "\n\n"
                "Would you like me to create this job? You can ask me to modify any field first.\n\n"
                f"```json\n{_json.dumps(fallback_data)}\n```"
            )
        else:
            reply = "I wasn't able to generate a job draft. Please try again with more details (title, skills, location, experience)."
    return ChatResponse(reply=reply, action={"type": "job_draft"})


def _extract_hidden_json_from_text(content: str) -> dict | None:
    json_str = ""
    content = str(content or "")
    try:
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
    except ValueError:
        return None
    if not json_str:
        return None
    try:
        data = _json.loads(json_str)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _is_confirm_message(message: str) -> bool:
    lower_msg = message.strip().lower()
    confirm_words = ["yes", "confirm", "create it", "looks good", "go ahead", "approve", "save", "post it", "lgtm", "yep", "sure", "do it", "ok", "okay", "delete it", "remove it"]
    return any(w in lower_msg for w in confirm_words)


def _job_markdown(job: Job) -> str:
    required = ", ".join(job.skills_required or []) or "Not specified"
    nice = ", ".join(job.additional_skills or []) or "None"
    return (
        f"**ID {job.id}: {job.title}**\n"
        f"- Location: {job.location or 'Not specified'}\n"
        f"- Type: {job.employment_type or 'Not specified'}\n"
        f"- Experience: {job.years_experience if job.years_experience is not None else 0}+ years\n"
        f"- Education: {job.education or 'Not specified'}\n"
        f"- Required skills: {required}\n"
        f"- Nice-to-have: {nice}"
    )


async def _find_job_for_chat(db: AsyncSession, *, job_id: int | None = None, title: str | None = None) -> Job | None:
    if job_id:
        return await db.get(Job, int(job_id))
    title = str(title or "").strip()
    if not title:
        return None
    result = await db.execute(select(Job).where(Job.title.ilike(f"%{title}%")).order_by(Job.id.desc()).limit(1))
    return result.scalar_one_or_none()


async def _handle_confirmed_job_action(history: list[ChatMessage], db: AsyncSession) -> ChatResponse | None:
    for item in reversed(history or []):
        if str(item.role).lower() != "assistant":
            continue
        data = _extract_hidden_json_from_text(item.content)
        if not data:
            continue
        action = str(data.get("action") or "").strip().lower()
        if action == "delete_job":
            job = await db.get(Job, int(data.get("job_id") or 0))
            if not job:
                return ChatResponse(reply="That job is already gone or could not be found.")
            title = job.title
            job_id = job.id
            await db.delete(job)
            await db.commit()
            return ChatResponse(
                reply=f"Removed **{title}** (ID {job_id}) successfully.",
                action={"type": "job_deleted", "job_id": job_id, "title": title},
            )
    return None


# ══════════════════════════════════════════════════════════════════════════════
#  JOBS CHATBOT — PURE LLM TOOL-CALLING APPROACH
# ══════════════════════════════════════════════════════════════════════════════

_JOBS_ROUTER_SYSTEM = """You are the SmartHire Jobs Assistant. You help admins manage job postings.

You have access to these tools. Choose EXACTLY ONE tool per request based on the conversation context.
Return ONLY valid JSON matching the tool schema — no markdown, no explanation.

## Tools:

### 1. read_jobs
Use when admin wants to see, list, search, find, or get details about jobs.
Schema:
{"tool": "read_jobs", "job_id": number | null, "title": string | null, "query": string | null}
- job_id: if admin mentions a specific ID
- title: if admin mentions a job by name
- query: the search query or "all" for listing all jobs

### 2. create_job
Use when admin wants to create, add, draft, or post a new job.
Schema:
{"tool": "create_job", "fields": {"title": "...", "description": "...", "skills_required": [...], "additional_skills": [...], "location": "...", "employment_type": "...", "years_experience": number, "education": "..."}}
- fields: extract any job details mentioned in the message. Include ONLY fields explicitly stated. Leave out fields not mentioned.

### 3. update_job
Use when admin wants to edit, update, change, modify, set, or rename any field of an existing job.
Schema:
{"tool": "update_job", "job_id": number | null, "title": string | null, "fields": {"location": "...", "title": "...", "description": "...", "skills_required": [...], "additional_skills": [...], "employment_type": "...", "years_experience": number, "education": "..."}}
- job_id or title: identifies which job to update (use context from conversation history if not in current message)
- fields: ONLY include fields that should change, with the NEW values

### 4. delete_job
Use when admin wants to delete, remove, or discard a job.
Schema:
{"tool": "delete_job", "job_id": number | null, "title": string | null}

### 5. general
Use for general questions, greetings, or when the intent is unclear.
Schema:
{"tool": "general"}

## IMPORTANT RULES:
- Look at the FULL conversation history to understand context (e.g., which job was discussed).
- If the admin previously asked about a specific job and now says "update location to X", use that job's ID/title.
- Handle typos gracefully (e.g., "chnage" = "change", "udpate" = "update").
- For update_job, extract the new field values from the message.
- Return ONLY the JSON object, nothing else."""


async def _classify_jobs_intent(message: str, history: list[ChatMessage]) -> dict:
    """Use LLM to classify intent and extract parameters."""
    msgs: list[dict[str, Any]] = [{"role": "system", "content": _JOBS_ROUTER_SYSTEM}]
    for h in (history or [])[-8:]:
        r = str(h.role or "user").lower()
        if r in ("user", "assistant"):
            msgs.append({"role": r, "content": str(h.content or "")})
    msgs.append({"role": "user", "content": message})
    raw = await _call_llm(msgs, max_tokens=500)
    logger.info("Jobs classify raw LLM response: {}", raw[:300] if raw else '<empty>')
    if not raw or not raw.strip():
        return {"tool": "general"}
    try:
        data = _json.loads(_strip_json_fences(raw))
        if not isinstance(data, dict):
            logger.warning("Jobs classify: LLM returned non-dict: {}", type(data))
            return {"tool": "general"}
        return data
    except Exception as e:
        logger.warning("Jobs classify: JSON parse failed: {} | raw: {}", e, raw[:200])
        return {"tool": "general"}


async def _handle_read_jobs_chat(message: str, plan: dict, db: AsyncSession) -> ChatResponse:
    """Read/list/search jobs."""
    # Direct lookup by ID or title
    job = await _find_job_for_chat(db, job_id=plan.get("job_id"), title=plan.get("title"))
    if job:
        return ChatResponse(reply=_job_markdown(job))

    # Load all jobs and let LLM summarize based on query
    result = await db.execute(select(Job).order_by(Job.created_at.desc()).limit(50))
    jobs = list(result.scalars().all())
    if not jobs:
        return ChatResponse(reply="There are no job postings yet.")

    jobs_list = "\n".join(
        f"- ID {job.id}: {job.title} | Location: {job.location or 'Not set'} | "
        f"Type: {job.employment_type or 'Not set'} | Experience: {job.years_experience or 0}+ yrs | "
        f"Skills: {', '.join((job.skills_required or [])[:5]) or 'Not specified'}"
        for job in jobs
    )

    query = plan.get("query") or message
    system_prompt = (
        "You are the SmartHire Jobs Assistant. The admin is looking for jobs.\n"
        f"Here are all current jobs:\n{jobs_list}\n\n"
        "Based on the admin's request, show the relevant jobs.\n"
        "Rules:\n"
        "- If they want all jobs or a broad list, show all of them.\n"
        "- If they ask about a specific job (by name, skill, location), show only matching ones.\n"
        "- Use this format for each job: **ID X: Title** — Location, Type, Skills: ...\n"
        "- If asking for details of one job, show full details.\n"
        "- Be concise. Do NOT invent jobs that aren't in the list.\n"
        "- Do NOT say you updated or changed anything."
    )
    msgs: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    msgs.append({"role": "user", "content": query})
    reply = await _call_llm(msgs, max_tokens=800)
    return ChatResponse(reply=reply)


async def _handle_update_job_chat(message: str, plan: dict, history: list[ChatMessage], db: AsyncSession) -> ChatResponse:
    """Update an existing job's fields."""
    job = await _find_job_for_chat(db, job_id=plan.get("job_id"), title=plan.get("title"))
    if not job:
        return ChatResponse(reply="Which job should I edit? Please give me the job ID or title.")

    fields = plan.get("fields") if isinstance(plan.get("fields"), dict) else {}
    clean_fields = {k: v for k, v in fields.items() if v not in (None, "", [])}

    if not clean_fields:
        return ChatResponse(
            reply=f"What would you like to change for **{job.title}** (ID {job.id})?\n\n"
            f"Current details:\n{_job_markdown(job)}\n\n"
            "Tell me what to change, e.g. \"change location to Bangalore\" or \"update skills to Python, React\".",
        )

    # Apply the update directly
    if "title" in clean_fields and str(clean_fields["title"]).strip():
        job.title = str(clean_fields["title"]).strip()
    if "description" in clean_fields and str(clean_fields["description"]).strip():
        job.description = str(clean_fields["description"]).strip()
    if "education" in clean_fields:
        job.education = str(clean_fields["education"]).strip() or None
    if "years_experience" in clean_fields:
        val = clean_fields["years_experience"]
        job.years_experience = int(val) if val not in (None, "") else None
    if "skills_required" in clean_fields and isinstance(clean_fields["skills_required"], list):
        job.skills_required = [str(v).strip() for v in clean_fields["skills_required"] if str(v).strip()]
    if "additional_skills" in clean_fields and isinstance(clean_fields["additional_skills"], list):
        job.additional_skills = [str(v).strip() for v in clean_fields["additional_skills"] if str(v).strip()]
    if "location" in clean_fields:
        job.location = str(clean_fields["location"]).strip() or None
    if "employment_type" in clean_fields:
        job.employment_type = str(clean_fields["employment_type"]).strip() or None

    await db.commit()
    await db.refresh(job)
    logger.info("Jobs chat updated job id={} fields={}", job.id, list(clean_fields.keys()))

    return ChatResponse(
        reply=f"Done — updated job ID {job.id}.\n\n{_job_markdown(job)}\n\nWould you like to change anything else?",
        action={"type": "job_updated", "job_id": job.id, "title": job.title},
    )


async def _handle_delete_job_chat(plan: dict, db: AsyncSession) -> ChatResponse:
    """Delete a job (with confirmation step)."""
    job = await _find_job_for_chat(db, job_id=plan.get("job_id"), title=plan.get("title"))
    if not job:
        return ChatResponse(reply="Which job should I remove? Please give me the job ID or title.")
    hidden = {"action": "delete_job", "job_id": job.id}
    return ChatResponse(
        reply=(
            f"Please confirm you want to remove this job:\n\n{_job_markdown(job)}\n\n"
            "Reply **confirm** to delete it.\n\n"
            f"```json\n{_json.dumps(hidden)}\n```"
        ),
        action={"type": "job_delete_draft", "job_id": job.id},
    )


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

    raw = await _call_llm(msgs, max_tokens=500)
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
    return ChatResponse(reply=reply or "I couldn't find specific details. Try asking about a job by ID or title, or say 'list all jobs'.")


# â”€â”€ Supervisor endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


@router.post("/admin", response_model=ChatResponse)
@limiter.limit("60/minute")
async def admin_chat(
    request: Request,
    payload: ChatRequest,
    response: Response,
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


@router.post("/jobs", response_model=ChatResponse)
@limiter.limit("60/minute")
async def jobs_chat(
    request: Request,
    payload: ChatRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> ChatResponse:
    """Jobs-page assistant restricted to job posting CRUD/read operations."""
    _check_llm_configured()

    if _is_confirm_message(payload.message) and payload.history:
        confirmed = await _handle_confirmed_job_action(payload.history, db)
        if confirmed:
            return confirmed
        for item in reversed(payload.history):
            if item.role == "assistant" and '"title"' in item.content:
                logger.info("Jobs chat: detected confirmation of pending job draft")
                return await _handle_create_job(payload.message, payload.history, {}, db)

    plan = await _classify_jobs_intent(payload.message, payload.history)
    tool = str(plan.get("tool", "general")).strip().lower()
    logger.info("Jobs chat tool={} plan={}", tool, plan)

    if tool == "create_job":
        return await _handle_create_job(payload.message, payload.history, plan.get("fields") or {}, db)
    if tool == "update_job":
        return await _handle_update_job_chat(payload.message, plan, payload.history, db)
    if tool == "delete_job":
        return await _handle_delete_job_chat(plan, db)
    if tool == "read_jobs":
        return await _handle_read_jobs_chat(payload.message, plan, db)

    # General fallback — answer questions but never claim to perform actions
    jobs_result = await db.execute(select(Job).order_by(Job.created_at.desc()).limit(30))
    jobs = list(jobs_result.scalars().all())
    jobs_context = "\n".join(
        f"- ID {job.id}: {job.title} | {job.location or 'Location not set'} | "
        f"{job.employment_type or 'Type not set'} | Skills: {', '.join(job.skills_required or []) or 'Not specified'}"
        for job in jobs
    )
    system_prompt = (
        "You are the SmartHire Jobs Assistant. Only answer questions about job postings.\n\n"
        f"Current jobs:\n{jobs_context or 'No jobs posted.'}\n\n"
        "You can help the admin read/list jobs, draft new jobs, edit jobs, and remove jobs.\n"
        "IMPORTANT: You CANNOT directly create, update, or delete jobs yourself. Never say 'Done' or 'Updated'.\n"
        "Guide the admin to phrase clearly, e.g. 'change location of Data Analyst to Bangalore' or 'delete job 5'."
    )
    msgs: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for h in (payload.history or [])[-8:]:
        r = str(h.role or "user").lower()
        if r in ("user", "assistant"):
            msgs.append({"role": r, "content": str(h.content or "")})
    msgs.append({"role": "user", "content": payload.message})
    reply = await _call_llm(msgs, max_tokens=600)
    return ChatResponse(reply=reply or "I can help you manage job postings. Try asking me to list jobs, create a new job, update an existing one, or delete one.")


# â”€â”€â”€ Job suggestions (existing) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


@router.post("/job-suggestions", response_model=JobSuggestResponse)
@limiter.limit("20/minute")
async def job_suggestions(
    request: Request,
    payload: JobSuggestRequest,
    response: Response,
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


# ══════════════════════════════════════════════════════════════════════════════
#  CANDIDATES PAGE CHATBOT (read-only, for HRs)
# ══════════════════════════════════════════════════════════════════════════════

_CANDIDATES_CHAT_SYSTEM = """You are the SmartHire Candidates Assistant — a read-only name-lookup tool for HR recruiters.

You have the COMPLETE candidate list below. Your ONLY job is to find candidates BY NAME.

When the user gives a name:
- Do a fuzzy name match against the candidate list below.
- Return the FULL profile immediately: Name, Email, Phone, Skills, Experience, Location, Education, Certifications, Work History.
- If multiple candidates match the name, list ALL of them with full profiles.
- If no candidates match, say "No candidates found matching [name]." and list the available candidate names so the user can pick.

RULES:
- You are READ-ONLY. You CANNOT create, modify, delete, or update any data.
- ONLY search by candidate name. If the user asks anything else, politely say you can only look up candidates by name.
- NEVER ask follow-up questions — just find the name and show the profile.
- NEVER say "I don't have that loaded" or "let me search" — you already have ALL the data.
- Use markdown formatting. Be concise and direct.
- Do NOT invent or hallucinate candidate data. Only use what is in the list below.
"""


@router.post("/candidates", response_model=ChatResponse)
@limiter.limit("60/minute")
async def candidates_chat(
    request: Request,
    payload: ChatRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> ChatResponse:
    """Candidates-page assistant — read-only, helps HRs find candidates and match them to roles."""
    _check_llm_configured()

    # Load all candidates (excluding binary resume data)
    cand_result = await db.execute(
        select(
            Candidate.id,
            Candidate.full_name,
            Candidate.email,
            Candidate.phone_number,
            Candidate.skills,
            Candidate.years_experience,
            Candidate.location,
            Candidate.college_details,
            Candidate.certifications,
            Candidate.work_experience,
        ).order_by(Candidate.id.desc()).limit(100)
    )
    candidates_rows = cand_result.all()

    candidates_context = ""
    for c in candidates_rows:
        skills = ", ".join(c.skills or []) if c.skills else "Not specified"
        exp = f"{c.years_experience} yrs" if c.years_experience is not None else "Not specified"
        work = "; ".join(c.work_experience[:2]) if c.work_experience else "Not specified"
        certs = ", ".join(c.certifications[:3]) if c.certifications else "None"
        candidates_context += (
            f"- [ID:{c.id}] {c.full_name} | Email: {c.email} | "
            f"Phone: {c.phone_number or 'Not specified'} | "
            f"Skills: {skills} | Experience: {exp} | "
            f"Location: {c.location or 'Not specified'} | "
            f"Education: {c.college_details or 'Not specified'} | "
            f"Certifications: {certs} | "
            f"Work: {work}\n"
        )

    system_prompt = (
        _CANDIDATES_CHAT_SYSTEM
        + f"\n\nCandidate Database ({len(candidates_rows)} candidates):\n"
        + (candidates_context or "No candidates in the system yet.\n")
    )

    msgs: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for msg in (payload.history or [])[-10:]:
        r = str(msg.role or "user").lower()
        if r in ("user", "assistant"):
            msgs.append({"role": r, "content": str(msg.content or "")})
    msgs.append({"role": "user", "content": payload.message})

    reply = await _call_llm(msgs, max_tokens=800)
    return ChatResponse(
        reply=reply or "I couldn't find that candidate. Please try again with a candidate's name.",
    )
