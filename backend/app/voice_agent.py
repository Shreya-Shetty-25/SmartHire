from __future__ import annotations

import re

import httpx
from fastapi import HTTPException, status
from loguru import logger

from .config import settings


def _selected_provider_optional() -> str | None:
    enabled = {
        "azure": bool(settings.use_azure_openai),
        "gemini": bool(settings.use_gemini),
        "groq": bool(settings.use_groq),
    }
    on = [k for k, v in enabled.items() if v]
    if len(on) != 1:
        return None
    return on[0]


def _sanitize_spoken_text(text: str) -> str:
    s = (text or "").strip()
    if not s:
        return ""

    # Remove surrounding quotes/backticks that models sometimes add.
    s = s.strip("`\"' ")

    # Collapse whitespace.
    s = re.sub(r"\s+", " ", s)

    # Keep it short for phone TTS.
    if len(s) > 240:
        s = s[:240].rsplit(" ", 1)[0].strip() or s[:240]

    return s


def _fallback_line(*, hr_turn: int, candidate_name: str, position: str | None, user_speech: str | None) -> str:
    safe_name = (candidate_name or "there").strip() or "there"
    safe_pos = (position or "the role").strip() or "the role"
    user = (user_speech or "").strip()

    if hr_turn == 1:
        return f"Hii {safe_name}... hmm, I’m calling about {safe_pos}. How are you doing today?"
    if hr_turn == 2:
        if user:
            return f"Okayyy, that’s great. Quick one — are you currently open to new opportunities for {safe_pos}?"
        return f"Hmm, got it. Are you currently open to new opportunities for {safe_pos}?"
    return "Alrighty, thanks for your time. We’ll follow up soon. Byee!"


async def _chat_groq(*, system: str, user: str) -> str:
    if not settings.groq_api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY is missing")

    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {settings.groq_api_key}"}
    payload = {
        "model": settings.groq_model,
        "temperature": 0.7,
        "max_tokens": 120,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, headers=headers, json=payload)

    if response.status_code >= 400:
        logger.warning("Groq error {}: {}", response.status_code, response.text)
        raise HTTPException(status_code=502, detail="Groq request failed")

    data = response.json()
    return data["choices"][0]["message"]["content"]


async def _chat_azure(*, system: str, user: str) -> str:
    if not settings.azure_openai_endpoint or not settings.azure_openai_api_key or not settings.azure_openai_deployment:
        raise HTTPException(
            status_code=500,
            detail="Azure OpenAI env vars missing (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT)",
        )

    endpoint = settings.azure_openai_endpoint.rstrip("/")
    url = (
        f"{endpoint}/openai/deployments/{settings.azure_openai_deployment}/chat/completions"
        f"?api-version={settings.azure_openai_api_version}"
    )
    headers = {"api-key": settings.azure_openai_api_key}
    payload = {
        "temperature": 0.7,
        "max_tokens": 120,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, headers=headers, json=payload)

    if response.status_code >= 400:
        logger.warning("Azure OpenAI error {}: {}", response.status_code, response.text)
        raise HTTPException(status_code=502, detail="Azure OpenAI request failed")

    data = response.json()
    return data["choices"][0]["message"]["content"]


async def _chat_gemini(*, system: str, user: str) -> str:
    if not settings.gemini_api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is missing")

    model = settings.gemini_model
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    params = {"key": settings.gemini_api_key}

    # Gemini doesn't have a strict system role; put system as first text chunk.
    prompt = f"{system}\n\nUser:\n{user}"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 140},
    }

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, params=params, json=payload)

    if response.status_code >= 400:
        logger.warning("Gemini error {}: {}", response.status_code, response.text)
        raise HTTPException(status_code=502, detail="Gemini request failed")

    data = response.json()
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Gemini response format unexpected") from exc


async def generate_hr_line(
    *,
    hr_turn: int,
    candidate_name: str,
    position: str | None,
    user_speech: str | None,
) -> str:
    """Generate the next HR utterance.

    Expected sequence (5 steps):
    - HR1 -> user -> HR2 -> user -> HR3 (hang up)

    hr_turn is 1..3.
    """

    if hr_turn not in (1, 2, 3):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid hr_turn")

    provider = _selected_provider_optional()
    if provider is None:
        # No LLM configured; still allow the call to proceed with a deterministic fallback.
        return _fallback_line(
            hr_turn=hr_turn,
            candidate_name=candidate_name,
            position=position,
            user_speech=user_speech,
        )

    safe_name = (candidate_name or "there").strip() or "there"
    safe_pos = (position or "the role").strip() or "the role"
    user_text = (user_speech or "").strip()

    system = (
        "You are a friendly human HR recruiter speaking on a phone call. "
        "Write exactly what you will SAY out loud. "
        "Style rules: 1-2 short sentences, warm and casual, one question max, "
        "use small human fillers occasionally spelled like 'hmm', 'okayyy', 'ahh', 'got it', 'that's great'. "
        "Do not mention being an AI. Do not use emojis. Output plain text only."
    )

    if hr_turn == 1:
        user = (
            f"Candidate name: {safe_name}\n"
            f"Position: {safe_pos}\n\n"
            "Task: Start the call with a greeting and ask how they are."
        )
    elif hr_turn == 2:
        user = (
            f"Candidate name: {safe_name}\n"
            f"Position: {safe_pos}\n"
            f"Candidate just said: {user_text or '[no response]'}\n\n"
            "Task: React politely to what they said and ask if they're open to opportunities."
        )
    else:
        user = (
            f"Candidate name: {safe_name}\n"
            f"Position: {safe_pos}\n"
            f"Candidate just said: {user_text or '[no response]'}\n\n"
            "Task: Give a friendly closing line and say you'll follow up soon, then say goodbye. No question."
        )

    try:
        if provider == "groq":
            raw = await _chat_groq(system=system, user=user)
        elif provider == "azure":
            raw = await _chat_azure(system=system, user=user)
        else:
            raw = await _chat_gemini(system=system, user=user)
    except HTTPException:
        # If the LLM fails mid-call, keep the call flowing.
        return _fallback_line(
            hr_turn=hr_turn,
            candidate_name=candidate_name,
            position=position,
            user_speech=user_speech,
        )

    cleaned = _sanitize_spoken_text(raw)
    return cleaned or _fallback_line(
        hr_turn=hr_turn,
        candidate_name=candidate_name,
        position=position,
        user_speech=user_speech,
    )
