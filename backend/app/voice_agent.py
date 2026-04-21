from __future__ import annotations

import asyncio
import re
import time
from typing import Any

import httpx
from fastapi import HTTPException, status
from loguru import logger

from .config import settings

_VOICE_LLM_TIMEOUT = 25.0
_VERIFY_SSL = not bool(settings.hf_disable_ssl_verify)

# ── Per-call conversation history ─────────────────────────────────────────────
# Keyed by session_code → list of {"role": "assistant"|"user", "content": "..."}
_CONVERSATION_STORE: dict[str, list[dict[str, str]]] = {}
_CONV_STORE_MAX = 200  # max concurrent tracked calls


def get_conversation(session_code: str) -> list[dict[str, str]]:
    return list(_CONVERSATION_STORE.get(session_code, []))


def append_to_conversation(session_code: str, role: str, content: str) -> None:
    if not session_code:
        return
    if len(_CONVERSATION_STORE) >= _CONV_STORE_MAX and session_code not in _CONVERSATION_STORE:
        oldest = next(iter(_CONVERSATION_STORE))
        _CONVERSATION_STORE.pop(oldest, None)
    _CONVERSATION_STORE.setdefault(session_code, []).append({"role": role, "content": content})


def clear_conversation(session_code: str) -> None:
    _CONVERSATION_STORE.pop(session_code, None)


def _available_providers() -> list[str]:
    """Return all configured LLM providers, ordered by preference."""
    providers: list[str] = []
    az_ready = (
        bool(settings.use_azure_openai)
        and bool((settings.azure_openai_endpoint or "").strip())
        and bool((settings.azure_openai_api_key or "").strip())
        and bool((settings.azure_openai_deployment or "").strip())
    )
    if az_ready:
        providers.append("azure")
    if bool(settings.use_groq) and (settings.groq_api_key or "").strip():
        providers.append("groq")
    if bool(settings.use_cerebras) and (settings.cerebras_api_key or "").strip():
        providers.append("cerebras")
    if bool(settings.use_openai) and (settings.openai_api_key or "").strip():
        providers.append("openai")
    if bool(settings.use_gemini) and (settings.gemini_api_key or "").strip():
        providers.append("gemini")
    # Last resort: any key present without a USE_* flag
    if "azure" not in providers and (
        (settings.azure_openai_endpoint or "").strip()
        and (settings.azure_openai_api_key or "").strip()
        and (settings.azure_openai_deployment or "").strip()
    ):
        providers.append("azure")
    if "openai" not in providers and (settings.openai_api_key or "").strip():
        providers.append("openai")
    return providers


def _sanitize_spoken_text(text: str) -> str:
    s = (text or "").strip()
    if not s:
        return ""
    s = s.strip("`\"' ")
    s = re.sub(r"\s+", " ", s)
    if len(s) > 260:
        s = s[:260].rsplit(" ", 1)[0].strip() or s[:260]
    return s


def _fallback_line(
    *, hr_turn: int, candidate_name: str, position: str | None, user_speech: str | None
) -> str:
    """Deterministic fallback used ONLY when all LLM providers are unavailable."""
    safe_name = (candidate_name or "there").strip() or "there"
    safe_pos = (position or "the role").strip() or "the role"
    if hr_turn == 1:
        return (
            f"Hi {safe_name}, this is Priya calling from SmartHire about the {safe_pos} position. "
            "Are you still interested in this opportunity?"
        )
    if hr_turn == 2:
        return f"Great! Could you briefly introduce yourself and walk me through your experience relevant to {safe_pos}?"
    if hr_turn == 3:
        return "Can you describe a challenging project you worked on and how you handled it?"
    if hr_turn == 4:
        return f"What specific skills or experience do you bring that make you a strong fit for the {safe_pos} role?"
    return (
        "Thank you so much for your time today. It was great speaking with you. "
        "The team will review your profile and reach out soon. Have a wonderful day, goodbye!"
    )


# ── Single dynamic system prompt used for all turns ───────────────────────────

_INTERVIEW_SYSTEM = (
    "You are Priya, a warm and professional recruiter at SmartHire conducting a live phone interview. "
    "The interview has exactly 5 turns. Keep every response to 1-2 short spoken sentences — this is a phone call, not a text chat. "
    "Ask exactly ONE question per turn. "
    "ALWAYS react to what the candidate just said: probe for specifics (project names, metrics, timelines, "
    "trade-offs, challenges, decisions). If their answer is short or vague, ask them to elaborate on that "
    "specific point — do NOT skip to a generic topic. "
    "Turn 1 (opening): greet warmly, introduce yourself as Priya calling from SmartHire for the stated role, "
    "and confirm whether they are still interested in the opportunity. "
    "Turns 2-4: ask focused role-relevant questions about their background, key experience, and fit for the role. "
    "Turn 5 (closing): thank them warmly for their time, say the team will review their profile and be in touch soon, "
    "wish them well and say goodbye — NO more questions. "
    "Plain text only. No markdown, no bullet points, no asterisks. Do not mention AI."
)


# ── LLM chat functions (all accept a full messages list) ──────────────────────

async def _chat_azure(*, messages: list[dict[str, str]]) -> str:
    endpoint = (settings.azure_openai_endpoint or "").strip().rstrip("/")
    api_key = (settings.azure_openai_api_key or "").strip()
    deployment = (settings.azure_openai_deployment or "").strip()
    api_version = (settings.azure_openai_api_version or "2024-02-01").strip()

    if not endpoint or not api_key or not deployment:
        raise HTTPException(
            status_code=500,
            detail="Azure OpenAI env vars missing (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT)",
        )

    url = f"{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={api_version}"
    headers: dict[str, str] = {"api-key": api_key, "Content-Type": "application/json"}
    payload: dict[str, Any] = {
        "messages": messages,
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(_VOICE_LLM_TIMEOUT), verify=_VERIFY_SSL) as client:
        response = await client.post(url, headers=headers, json=payload)

    if response.status_code >= 400:
        logger.warning("Azure OpenAI error {}: {}", response.status_code, response.text[:400])
        raise HTTPException(status_code=502, detail="Azure OpenAI request failed")

    data = response.json()
    return data["choices"][0]["message"]["content"]


async def _chat_openai(*, messages: list[dict[str, str]]) -> str:
    api_key = (settings.openai_api_key or "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is missing")

    url = "https://api.openai.com/v1/chat/completions"
    headers: dict[str, str] = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload: dict[str, Any] = {
        "model": settings.openai_model,
        "temperature": 0.85,
        "max_tokens": 130,
        "messages": messages,
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(_VOICE_LLM_TIMEOUT), verify=_VERIFY_SSL) as client:
        response = await client.post(url, headers=headers, json=payload)

    if response.status_code >= 400:
        logger.warning("OpenAI error {}: {}", response.status_code, response.text[:400])
        raise HTTPException(status_code=502, detail="OpenAI request failed")

    data = response.json()
    return data["choices"][0]["message"]["content"]


async def _chat_groq(*, messages: list[dict[str, str]]) -> str:
    if not settings.groq_api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY is missing")

    url = "https://api.groq.com/openai/v1/chat/completions"
    headers: dict[str, str] = {"Authorization": f"Bearer {settings.groq_api_key}"}
    payload: dict[str, Any] = {
        "model": settings.groq_model,
        "temperature": 0.85,
        "max_tokens": 130,
        "messages": messages,
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(_VOICE_LLM_TIMEOUT), verify=_VERIFY_SSL) as client:
        response = await client.post(url, headers=headers, json=payload)

    if response.status_code >= 400:
        logger.warning("Groq error {}: {}", response.status_code, response.text[:400])
        raise HTTPException(status_code=502, detail="Groq request failed")

    data = response.json()
    return data["choices"][0]["message"]["content"]


async def _chat_cerebras(*, messages: list[dict[str, str]]) -> str:
    if not settings.cerebras_api_key:
        raise HTTPException(status_code=500, detail="CEREBRAS_API_KEY is missing")

    url = "https://api.cerebras.ai/v1/chat/completions"
    headers: dict[str, str] = {"Authorization": f"Bearer {settings.cerebras_api_key}"}
    payload: dict[str, Any] = {
        "model": settings.cerebras_model,
        "temperature": 0.85,
        "max_tokens": 130,
        "messages": messages,
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(_VOICE_LLM_TIMEOUT), verify=_VERIFY_SSL) as client:
        response = await client.post(url, headers=headers, json=payload)

    if response.status_code >= 400:
        logger.warning("Cerebras error {}: {}", response.status_code, response.text[:400])
        raise HTTPException(status_code=502, detail="Cerebras request failed")

    data = response.json()
    return data["choices"][0]["message"]["content"]


async def _chat_gemini(*, messages: list[dict[str, str]]) -> str:
    if not settings.gemini_api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is missing")

    model = settings.gemini_model
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    params = {"key": settings.gemini_api_key}

    # Gemini requires alternating user/model turns; merge system into first user message
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

    payload: dict[str, Any] = {
        "contents": gemini_contents,
        "generationConfig": {"temperature": 0.85, "maxOutputTokens": 130},
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(_VOICE_LLM_TIMEOUT), verify=_VERIFY_SSL) as client:
        response = await client.post(url, params=params, json=payload)

    if response.status_code >= 400:
        logger.warning("Gemini error {}: {}", response.status_code, response.text[:400])
        raise HTTPException(status_code=502, detail="Gemini request failed")

    data = response.json()
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Gemini response format unexpected") from exc


_CHAT_FN: dict[str, Any] = {
    "azure": _chat_azure,
    "openai": _chat_openai,
    "groq": _chat_groq,
    "cerebras": _chat_cerebras,
    "gemini": _chat_gemini,
}


async def _race_providers(
    providers: list[str],
    messages: list[dict[str, str]],
    hr_turn: int,
    session_code: str | None,
) -> str | None:
    """Fire multiple LLM providers concurrently; return the first successful response."""
    if not providers:
        return None

    started = time.perf_counter()
    tasks: dict[asyncio.Task, str] = {
        asyncio.create_task(_CHAT_FN[p](messages=messages)): p for p in providers
    }
    pending = set(tasks.keys())
    winner: str | None = None

    try:
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                prov = tasks[t]
                try:
                    result = t.result()
                    text = (result or "").strip()
                    if not text:
                        logger.warning("{} returned empty response for turn={}", prov, hr_turn)
                        continue
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    logger.info(
                        "Voice agent reply via {} in {}ms (turn={}, session={})",
                        prov, elapsed_ms, hr_turn, session_code or "?",
                    )
                    winner = text
                    # Cancel remaining tasks — we have our answer
                    for p_task in pending:
                        p_task.cancel()
                    return winner
                except Exception as exc:
                    logger.warning("Voice agent LLM provider {} failed: {}", prov, exc)
    finally:
        for t in pending:
            t.cancel()
        # Suppress CancelledError warnings
        await asyncio.gather(*pending, return_exceptions=True)

    return winner


def _build_messages(
    *,
    hr_turn: int,
    candidate_name: str,
    position: str | None,
    conversation_history: list[dict[str, str]],
) -> list[dict[str, str]]:
    """Build the full messages list for the LLM, including stored conversation history."""
    safe_name = (candidate_name or "there").strip() or "there"
    safe_pos = (position or "the role").strip() or "the role"

    system_content = (
        f"{_INTERVIEW_SYSTEM}\n\n"
        f"Candidate name: {safe_name}\n"
        f"Role being interviewed for: {safe_pos}\n"
        f"Current turn: {hr_turn} of 5"
    )

    messages: list[dict[str, str]] = [{"role": "system", "content": system_content}]

    if conversation_history:
        # Full history already contains the candidate's latest response appended before this call
        messages.extend(conversation_history)
    else:
        # Turn 1 — no history yet, just trigger the greeting
        messages.append({"role": "user", "content": "Begin the interview."})

    return messages


# ── Public API ─────────────────────────────────────────────────────────────────

async def generate_hr_line(
    *,
    hr_turn: int,
    candidate_name: str,
    position: str | None,
    user_speech: str | None,
    session_code: str | None = None,
) -> str:
    """Generate the next HR interviewer utterance.

    When *session_code* is supplied the full conversation history is used so
    every question is genuinely contextual to what the candidate has said.
    The static fallback is only used when ALL configured LLM providers fail.
    """
    if hr_turn not in range(1, 6):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid hr_turn")

    providers = _available_providers()
    if not providers:
        logger.warning("No LLM provider configured — using deterministic fallback for turn {}", hr_turn)
        return _fallback_line(
            hr_turn=hr_turn,
            candidate_name=candidate_name,
            position=position,
            user_speech=user_speech,
        )

    logger.info("Available LLM providers for turn={}: {}", hr_turn, providers)

    # Build the race pool: Azure + Groq run in parallel.
    # If both fail, Cerebras is tried as a sequential fallback.
    race_pool = [p for p in providers if p in ("azure", "groq")]

    # Append candidate's speech to history BEFORE building the messages for this turn
    if session_code and hr_turn > 1:
        speech_text = (user_speech or "").strip()
        if speech_text:
            append_to_conversation(session_code, "user", speech_text)
        else:
            # Empty/short STT result — tell the LLM to ask the candidate to repeat
            append_to_conversation(
                session_code,
                "user",
                "[The candidate did not respond clearly — gently ask them to repeat or continue.]",
            )

    history = get_conversation(session_code) if session_code else []

    messages = _build_messages(
        hr_turn=hr_turn,
        candidate_name=candidate_name,
        position=position,
        conversation_history=history,
    )

    # Race Azure + Groq in parallel — first success wins
    raw = await _race_providers(race_pool, messages, hr_turn, session_code)

    # If both failed, try Cerebras as sequential fallback
    if raw is None and "cerebras" in providers:
        logger.info("Azure+Groq race failed; falling back to Cerebras for turn={}", hr_turn)
        try:
            cerebras_result = await _chat_cerebras(messages=messages)
            text = (cerebras_result or "").strip()
            if text:
                raw = text
                logger.info("Cerebras fallback succeeded for turn={}", hr_turn)
        except Exception as exc:
            logger.warning("Cerebras fallback also failed for turn={}: {}", hr_turn, exc)

    if raw is None:
        logger.warning("All LLM providers failed for turn={} — using deterministic fallback", hr_turn)
        return _fallback_line(
            hr_turn=hr_turn,
            candidate_name=candidate_name,
            position=position,
            user_speech=user_speech,
        )

    cleaned = _sanitize_spoken_text(raw)
    print("#"*20)
    print(f"Raw LLM output for turn {hr_turn}:\n{raw}\nCleaned output:\n{cleaned}")
    if not cleaned:
        return _fallback_line(
            hr_turn=hr_turn,
            candidate_name=candidate_name,
            position=position,
            user_speech=user_speech,
        )

    # Store the assistant reply in history for the next turn
    if session_code:
        append_to_conversation(session_code, "assistant", cleaned)

    return cleaned
