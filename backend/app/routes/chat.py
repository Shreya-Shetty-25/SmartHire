from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import httpx

from ..db import get_db
from ..auth import decode_token
from ..auth_utils import resolve_access_token
from ..models import Candidate, Job, User
from ..config import settings

router = APIRouter(prefix="/api/chat", tags=["chat"])
bearer_scheme = HTTPBearer(auto_error=False)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str = Field(..., max_length=2000)
    history: list[ChatMessage] = Field(default_factory=list)


class ChatResponse(BaseModel):
    reply: str


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


@router.post("/message", response_model=ChatResponse)
async def chat_message(
    payload: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(_get_optional_user),
) -> ChatResponse:
    if not settings.groq_api_key and not settings.openai_api_key and not settings.azure_openai_api_key:
        raise HTTPException(status_code=503, detail="Chat service is not configured (set GROQ_API_KEY, OPENAI_API_KEY, or AZURE_OPENAI_API_KEY).")

    # Fetch available jobs
    jobs_result = await db.execute(select(Job).order_by(Job.id.desc()).limit(30))
    jobs: list[Job] = list(jobs_result.scalars().all())

    jobs_context = ""
    for job in jobs:
        skills = ", ".join(job.skills_required or []) if job.skills_required else "Not specified"
        jobs_context += (
            f"- **{job.title}** | Location: {job.location or 'Remote'} | "
            f"Type: {job.employment_type or 'N/A'} | "
            f"Experience: {job.years_experience or 0}+ yrs | Skills: {skills}\n"
        )

    # Fetch candidate profile if user is a logged-in candidate
    profile_context = ""
    if current_user:
        role = str(getattr(current_user, "role", "candidate") or "candidate").strip().lower()
        if role == "candidate":
            cand_result = await db.execute(
                select(Candidate).where(Candidate.email == current_user.email)
            )
            candidate = cand_result.scalar_one_or_none()
            if candidate:
                skills = ", ".join(candidate.skills or []) if candidate.skills else "Not specified"
                profile_context = (
                    f"\nCandidate Profile:\n"
                    f"- Name: {candidate.full_name or 'Unknown'}\n"
                    f"- Skills: {skills}\n"
                    f"- Experience: {candidate.years_experience or 0} years\n"
                    f"- Location: {candidate.location or 'Not specified'}\n"
                )

    system_prompt = (
        "You are a helpful career advisor for SmartHire, an AI-powered recruitment platform. "
        "Your job is to help candidates discover suitable job openings and guide them through the application process.\n\n"
        f"Available Jobs on SmartHire:\n{jobs_context if jobs_context else 'No jobs are currently posted.'}\n"
        f"{profile_context}"
        "\nGuidelines:\n"
        "- Suggest relevant jobs from the list based on the candidate's profile and interests.\n"
        "- Answer questions about job requirements, needed skills, career paths, and application steps.\n"
        "- Be concise, friendly, and encouraging.\n"
        "- Only suggest jobs that exist in the provided list — never invent new ones.\n"
        "- If no jobs match, advise the candidate to update their profile or check back later.\n"
        "- Keep responses under 200 words unless more detail is clearly needed."
    )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for msg in (payload.history or [])[-8:]:  # keep last 8 messages for context
        role = str(msg.role or "user").lower()
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": str(msg.content or "")})
    messages.append({"role": "user", "content": payload.message})

    async def _call_openai_compatible(
        client: httpx.AsyncClient,
        base_url: str,
        api_key: str,
        model: str,
        extra_headers: dict | None = None,
    ) -> str:
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        if extra_headers:
            headers.update(extra_headers)
        r = await client.post(
            f"{base_url.rstrip('/')}/chat/completions",
            headers=headers,
            json={"model": model, "messages": messages, "max_tokens": 512, "temperature": 0.7},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

    async def _call_azure_openai(client: httpx.AsyncClient) -> str:
        endpoint = str(settings.azure_openai_endpoint or "").rstrip("/")
        deployment = settings.azure_openai_deployment or "gpt-4o-mini"
        api_version = settings.azure_openai_api_version or "2024-12-01-preview"
        url = f"{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={api_version}"
        r = await client.post(
            url,
            headers={
                "api-key": settings.azure_openai_api_key or "",
                "Content-Type": "application/json",
            },
            json={"messages": messages, "max_tokens": 512, "temperature": 0.7},
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]

    last_error: str = ""
    async with httpx.AsyncClient(timeout=30.0) as client:
        # 1. Try Groq
        if settings.groq_api_key:
            try:
                reply = await _call_openai_compatible(
                    client,
                    "https://api.groq.com/openai/v1",
                    settings.groq_api_key,
                    settings.groq_model or "llama-3.1-8b-instant",
                )
                return ChatResponse(reply=reply)
            except Exception as exc:
                last_error = str(exc)

        # 2. Fallback: Azure OpenAI
        if settings.azure_openai_api_key and settings.azure_openai_endpoint:
            try:
                reply = await _call_azure_openai(client)
                return ChatResponse(reply=reply)
            except Exception as exc:
                last_error = str(exc)

        # 3. Fallback: OpenAI
        if settings.openai_api_key:
            try:
                reply = await _call_openai_compatible(
                    client,
                    "https://api.openai.com/v1",
                    settings.openai_api_key,
                    settings.openai_model or "gpt-4o-mini",
                )
                return ChatResponse(reply=reply)
            except Exception as exc:
                last_error = str(exc)

    raise HTTPException(status_code=502, detail=f"All chat providers failed. Last error: {last_error}")
