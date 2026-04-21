from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, quote_plus, urlparse

import io

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from loguru import logger
from pydantic import ValidationError

try:
    from twilio.rest import Client  # type: ignore
    from twilio.twiml.voice_response import VoiceResponse  # type: ignore
    from twilio.base.exceptions import TwilioRestException  # type: ignore
except Exception:  # pragma: no cover
    Client = None  # type: ignore
    VoiceResponse = None  # type: ignore
    TwilioRestException = None  # type: ignore

from ..config import settings
from ..db import SessionLocal
from ..deps import get_current_admin
from ..models import CallAnalysis, CallRecording, User
from ..schemas import VoiceDemoCallRequest, VoiceDemoCallResponse
from ..voice_agent import generate_hr_line, clear_conversation
from ..ai_insights import analyze_call_transcript

router = APIRouter(prefix="/api/calls", tags=["calls"])

_RECORDINGS_DIR = Path(__file__).resolve().parents[2] / "logs" / "call_recordings"
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_VOICE_DEMO_FIELDS = {"phone_number", "position", "candidate_name", "session_code", "candidate_email"}


def _tts_configured() -> bool:
    """Cartesia TTS requires an API key."""
    return bool((settings.cartesia_api_key or "").strip())


def _safe_twiml_error(_text: str | None = None) -> Response:
    """Return a valid silent TwiML hangup so Twilio never speaks fallback audio."""
    if VoiceResponse is None:
        return Response(content="<Response><Hangup/></Response>", media_type="application/xml")
    vr = VoiceResponse()
    vr.hangup()
    return Response(content=str(vr), media_type="application/xml")


def _sanitize_text_value(value: object) -> object:
    if value is None:
        return None
    text = str(value)
    return _CONTROL_CHARS_RE.sub(" ", text).strip()


def _extract_voice_demo_payload_loose(decoded: str) -> dict | None:
    text = str(decoded or "")
    if not text.strip():
        return None

    # 1) application/x-www-form-urlencoded fallback
    try:
        qs = parse_qs(text, keep_blank_values=True)
        candidate = {k: (v[0] if isinstance(v, list) and v else v) for k, v in qs.items() if k in _VOICE_DEMO_FIELDS}
        if candidate:
            return candidate
    except Exception:
        pass

    # 2) Tolerate "almost JSON" / key-value text with missing commas.
    kv_pattern = re.compile(
        r'["\']?(phone_number|position|candidate_name|session_code|candidate_email)["\']?\s*[:=]\s*["\']([^"\']*)["\']',
        re.IGNORECASE,
    )
    candidate: dict[str, str] = {}
    for match in kv_pattern.finditer(text):
        key = str(match.group(1) or "").strip()
        value = str(match.group(2) or "").strip()
        if key:
            candidate[key] = value
    return candidate or None


async def _parse_voice_demo_request(request: Request) -> VoiceDemoCallRequest:
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=422, detail="Request body is required")

    decoded = raw.decode("utf-8", errors="ignore")
    payload_obj: dict | None = None
    try:
        parsed = json.loads(decoded)
        payload_obj = parsed if isinstance(parsed, dict) else None
    except Exception as json_exc:
        # Tolerate raw control characters from brittle clients.
        try:
            parsed = json.loads(decoded, strict=False)
            payload_obj = parsed if isinstance(parsed, dict) else None
            logger.warning("Recovered malformed JSON payload for /api/calls/voice/demo using strict=False parser")
        except Exception:
            payload_obj = _extract_voice_demo_payload_loose(decoded)
            if payload_obj:
                logger.warning("Recovered non-standard payload format for /api/calls/voice/demo")
            else:
                raise HTTPException(status_code=422, detail=f"Invalid JSON payload: {json_exc}") from json_exc

    if payload_obj is None:
        raise HTTPException(status_code=422, detail="JSON object payload is required")

    for key in ("phone_number", "position", "candidate_name", "session_code", "candidate_email"):
        if key in payload_obj:
            payload_obj[key] = _sanitize_text_value(payload_obj.get(key))

    try:
        return VoiceDemoCallRequest.model_validate(payload_obj)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc


def _get_twilio_credentials() -> tuple[str, str, str]:
    account_sid = (settings.twilio_account_sid or "").strip()
    auth_token = (settings.twilio_auth_token or "").strip()
    from_number = (settings.twilio_from_number or "").strip()

    if not account_sid or not auth_token or not from_number:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, "
                "and TWILIO_FROM_NUMBER in backend/.env"
            ),
        )

    # Common misconfiguration: using an API key SID (starts with SK) as account SID.
    # The current flow expects a Twilio Account SID (starts with AC) + auth token.
    if account_sid.upper().startswith("SK"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Invalid TWILIO_ACCOUNT_SID. It looks like an API key SID (SK...). "
                "Use your Twilio Account SID (AC...) with TWILIO_AUTH_TOKEN."
            ),
        )

    return account_sid, auth_token, from_number


def _compute_public_base_url(*, request: Request) -> str:
    if settings.public_base_url:
        return str(settings.public_base_url).rstrip("/")
    return str(request.base_url).rstrip("/")


def _get_elevenlabs_config() -> tuple[str, str, str]:
    api_key = (settings.elevenlabs_api_key or "").strip()
    voice_id = (settings.elevenlabs_voice_id or "").strip()
    model_id = (settings.elevenlabs_model_id or "").strip() or "eleven_multilingual_v2"

    if not api_key or not voice_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "ElevenLabs not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in backend/.env"
            ),
        )

    return api_key, voice_id, model_id


def _generate_gtts_audio(*, text: str) -> bytes:
    """Generate TTS audio using Cartesia (custom voice)."""
    api_key = (settings.cartesia_api_key or "").strip()
    voice_id = (settings.cartesia_voice_id or "").strip()
    model_id = (settings.cartesia_model_id or "").strip() or "sonic-3"

    if not api_key:
        raise RuntimeError("CARTESIA_API_KEY not configured in .env")

    url = "https://api.cartesia.ai/tts/bytes"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Cartesia-Version": "2026-03-01",
        "Content-Type": "application/json",
    }
    payload = {
        "model_id": model_id,
        "transcript": text,
        "voice": {"mode": "id", "id": voice_id},
        "output_format": {
            "container": "mp3",
            "encoding": "pcm_f32le",
            "sample_rate": 24000,
        },
        "language": "en",
    }

    timeout = httpx.Timeout(30.0)
    verify = not bool(settings.hf_disable_ssl_verify)
    with httpx.Client(timeout=timeout, verify=verify) as client:
        resp = client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        body = (resp.text or "")[:500]
        raise RuntimeError(f"Cartesia TTS failed: status={resp.status_code} body={body}")

    if not resp.content:
        raise RuntimeError("Cartesia TTS returned empty audio")

    return resp.content


def _normalize_recording_url(recording_url: str) -> str:
    url = str(recording_url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="Missing recording URL")

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Invalid recording URL")

    host = str(parsed.netloc or "").lower()
    if "twilio.com" not in host:
        raise HTTPException(status_code=400, detail="Recording URL host is not allowed")

    path = str(parsed.path or "")
    if not path.lower().endswith(".mp3"):
        path = f"{path}.mp3"
        parsed = parsed._replace(path=path)
        url = parsed.geturl()
    return url


async def _transcribe_elevenlabs_recording(*, file_path: Path) -> dict | None:
    api_key = (settings.elevenlabs_api_key or "").strip()
    if not api_key:
        return None

    model_id = (settings.elevenlabs_stt_model_id or "").strip() or "scribe_v2"
    if not file_path.exists() or not file_path.is_file():
        return None

    try:
        file_bytes = file_path.read_bytes()
    except Exception:
        return None
    if not file_bytes:
        return None

    headers = {
        "xi-api-key": api_key,
        "accept": "application/json",
    }
    data = {
        "model_id": model_id,
    }
    files = {
        "file": (file_path.name, file_bytes, "audio/mpeg"),
    }

    timeout = httpx.Timeout(60.0)
    verify = not bool(settings.hf_disable_ssl_verify)
    async with httpx.AsyncClient(timeout=timeout, verify=verify) as client:
        response = await client.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            headers=headers,
            data=data,
            files=files,
        )

    if response.status_code != 200:
        snippet = (response.text or "")[:300]
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs STT failed ({response.status_code}): {snippet}",
        )

    payload = response.json() if response.content else {}
    text = str(payload.get("text") or "").strip()
    if not text:
        return None

    words = payload.get("words")
    word_count = len(words) if isinstance(words, list) else len(text.split())
    return {
        "text": text,
        "model_id": model_id,
        "provider": "elevenlabs",
        "language_code": payload.get("language_code"),
        "language_probability": payload.get("language_probability"),
        "word_count": int(word_count),
    }


async def _transcribe_azure_whisper(*, file_path: Path) -> dict | None:
    """Transcribe an audio file using Azure OpenAI Whisper deployment."""
    endpoint = (settings.azure_openai_endpoint or "").strip().rstrip("/")
    api_key = (settings.azure_openai_api_key or "").strip()
    deployment = (settings.azure_whisper_deployment or "").strip()
    api_version = (settings.azure_openai_api_version or "2024-06-01").strip()

    if not endpoint or not api_key or not deployment:
        return None
    if not file_path.exists() or not file_path.is_file():
        return None

    try:
        file_bytes = file_path.read_bytes()
    except Exception:
        return None
    if not file_bytes:
        return None

    url = f"{endpoint}/openai/deployments/{deployment}/audio/transcriptions?api-version={api_version}"
    headers = {"api-key": api_key}
    files = {"file": (file_path.name, file_bytes, "audio/mpeg")}
    data = {"response_format": "json"}

    timeout = httpx.Timeout(60.0)
    verify = not bool(settings.hf_disable_ssl_verify)
    async with httpx.AsyncClient(timeout=timeout, verify=verify) as client:
        response = await client.post(url, headers=headers, data=data, files=files)

    if response.status_code != 200:
        snippet = (response.text or "")[:300]
        raise HTTPException(
            status_code=502,
            detail=f"Azure Whisper STT failed ({response.status_code}): {snippet}",
        )

    payload = response.json() if response.content else {}
    text = str(payload.get("text") or "").strip()
    if not text:
        return None

    return {
        "text": text,
        "model_id": deployment,
        "provider": "azure_whisper",
        "language_code": payload.get("language"),
        "language_probability": None,
        "word_count": len(text.split()),
    }


async def _transcribe_groq_whisper(*, file_path: Path) -> dict | None:
    """Transcribe an audio file using Groq's Whisper API."""
    api_key = (settings.groq_api_key or "").strip()
    if not api_key:
        return None
    if not file_path.exists() or not file_path.is_file():
        return None

    try:
        file_bytes = file_path.read_bytes()
    except Exception:
        return None
    if not file_bytes:
        return None

    url = "https://api.groq.com/openai/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {api_key}"}
    files = {"file": (file_path.name, file_bytes, "audio/mpeg")}
    data = {"model": "whisper-large-v3", "response_format": "json"}

    timeout = httpx.Timeout(60.0)
    verify = not bool(settings.hf_disable_ssl_verify)
    async with httpx.AsyncClient(timeout=timeout, verify=verify) as client:
        response = await client.post(url, headers=headers, data=data, files=files)

    if response.status_code != 200:
        snippet = (response.text or "")[:300]
        raise HTTPException(
            status_code=502,
            detail=f"Groq Whisper STT failed ({response.status_code}): {snippet}",
        )

    payload = response.json() if response.content else {}
    text = str(payload.get("text") or "").strip()
    if not text:
        return None

    return {
        "text": text,
        "model_id": "whisper-large-v3",
        "provider": "groq_whisper",
        "language_code": payload.get("language"),
        "language_probability": None,
        "word_count": len(text.split()),
    }


async def _transcribe_recording(*, file_path: Path) -> dict | None:
    """Transcribe a call recording.

    Provider order: azure_whisper → groq_whisper → elevenlabs
    The configured STT_PROVIDER is tried first; remaining providers are tried as fallbacks.
    """
    provider = (settings.stt_provider or "azure_whisper").strip().lower()

    if provider == "none":
        return None

    # Build ordered list: configured provider first, then remaining as fallbacks
    _ALL_PROVIDERS = ["azure_whisper", "groq_whisper", "elevenlabs"]
    ordered = [provider] + [p for p in _ALL_PROVIDERS if p != provider]

    for prov in ordered:
        try:
            if prov == "azure_whisper":
                result = await _transcribe_azure_whisper(file_path=file_path)
            elif prov == "groq_whisper":
                result = await _transcribe_groq_whisper(file_path=file_path)
            elif prov == "elevenlabs":
                result = await _transcribe_elevenlabs_recording(file_path=file_path)
            else:
                continue
            if result:
                logger.info("Transcription succeeded via provider={} words={}", prov, result.get("word_count"))
                return result
        except Exception as exc:
            logger.warning("STT provider {} failed ({}), trying next", prov, exc)
            continue

    logger.warning("All STT providers exhausted — no transcript")
    return None


async def _generate_elevenlabs_tts_audio(*, text: str) -> bytes:
    """Generate TTS audio using ElevenLabs TTS API."""
    api_key = (settings.elevenlabs_api_key or "").strip()
    voice_id = (settings.elevenlabs_voice_id or "").strip()
    model_id = (settings.elevenlabs_model_id or "eleven_multilingual_v2").strip()
    if not api_key or not voice_id:
        raise RuntimeError("ElevenLabs TTS not configured")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    payload = {
        "text": text,
        "model_id": model_id,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }
    timeout = httpx.Timeout(30.0)
    verify = not bool(settings.hf_disable_ssl_verify)
    async with httpx.AsyncClient(timeout=timeout, verify=verify) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code != 200:
        raise RuntimeError(f"ElevenLabs TTS failed: status={resp.status_code} body={(resp.text or '')[:300]}")
    if not resp.content:
        raise RuntimeError("ElevenLabs TTS returned empty audio")
    return resp.content


async def _generate_elevenlabs_audio(*, text: str) -> bytes:
    """Generate TTS audio: Cartesia first, ElevenLabs as fallback."""
    logger.info("Cartesia TTS request: text_len={}", len(text))
    try:
        return _generate_gtts_audio(text=text)
    except Exception as exc:
        logger.warning("Cartesia TTS failed ({}), trying ElevenLabs TTS", exc)

    try:
        return await _generate_elevenlabs_tts_audio(text=text)
    except Exception as exc:
        logger.warning("ElevenLabs TTS also failed: {}", exc)
        raise HTTPException(
            status_code=502,
            detail={"message": "All TTS providers failed", "error": str(exc)},
        ) from exc


async def _try_elevenlabs_audio(*, text: str) -> bytes:
    """Generate TTS audio: Cartesia → ElevenLabs → raise."""
    try:
        return _generate_gtts_audio(text=text)
    except Exception as exc:
        logger.warning("Cartesia TTS unavailable ({}), trying ElevenLabs TTS", exc)

    try:
        return await _generate_elevenlabs_tts_audio(text=text)
    except Exception as exc:
        logger.warning("ElevenLabs TTS also unavailable: {}", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _recording_file_path(*, call_sid: str, recording_sid: str) -> Path:
    safe_call_sid = "".join(ch for ch in str(call_sid or "") if ch.isalnum() or ch in {"-", "_"})
    safe_recording_sid = "".join(ch for ch in str(recording_sid or "") if ch.isalnum() or ch in {"-", "_"})
    if not safe_call_sid:
        safe_call_sid = "unknown-call"
    if not safe_recording_sid:
        safe_recording_sid = "unknown-recording"
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    _RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    return _RECORDINGS_DIR / f"{ts}_{safe_call_sid}_{safe_recording_sid}.mp3"


def _resolve_recording_file(file_name: str) -> Path:
    safe_name = str(file_name or "").strip()
    if not safe_name or safe_name != Path(safe_name).name:
        raise HTTPException(status_code=400, detail="Invalid recording filename")

    base = _RECORDINGS_DIR.resolve()
    path = (base / safe_name).resolve()
    if base not in path.parents and path != base:
        raise HTTPException(status_code=400, detail="Invalid recording filename")
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Recording not found")
    return path


async def _download_twilio_recording(*, recording_url: str, call_sid: str, recording_sid: str) -> Path:
    account_sid, auth_token, _ = _get_twilio_credentials()
    url = _normalize_recording_url(recording_url)

    timeout = httpx.Timeout(25.0)
    async with httpx.AsyncClient(timeout=timeout, auth=(account_sid, auth_token)) as client:
        response = await client.get(url)
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to download recording from Twilio ({response.status_code})",
        )

    file_path = _recording_file_path(call_sid=call_sid, recording_sid=recording_sid)
    file_path.write_bytes(response.content)
    return file_path


# In-memory cache for pre-generated ElevenLabs audio (keyed by content hash).
_audio_cache: dict[str, bytes] = {}
_AUDIO_CACHE_MAX = 50


def _cache_audio(text: str, audio: bytes) -> str:
    """Store audio bytes and return a cache key."""
    key = hashlib.sha256(text.encode()).hexdigest()[:16]
    if len(_audio_cache) >= _AUDIO_CACHE_MAX:
        oldest = next(iter(_audio_cache))
        _audio_cache.pop(oldest, None)
    _audio_cache[key] = audio
    return key


def _speak(vr_or_gather, audio_url: str) -> None:
    """Add ElevenLabs-generated audio to a VoiceResponse/Gather."""
    if not audio_url:
        raise ValueError("Audio URL is required for strict ElevenLabs voice flow")
    vr_or_gather.play(audio_url)


async def _log_tts_failure_event(*, session_code: str | None, hr_turn: int, error: str) -> None:
    await _log_assessment_call_event(
        session_code=session_code,
        event_type="call_interview_tts_failed",
        severity="high",
        payload={
            "provider": "elevenlabs",
            "hr_turn": hr_turn,
            "error": error,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )


def _build_continue_url(*, base_url: str, hr_turn: int, name: str, position: str | None, session_code: str | None = None) -> str:
    pos = position or ""
    code = session_code or ""
    return (
        f"{base_url}/api/calls/voice/continue"
        f"?hr_turn={hr_turn}"
        f"&name={quote_plus(name)}"
        f"&position={quote_plus(pos)}"
        f"&session_code={quote_plus(code)}"
    )


async def _log_assessment_call_event(
    *,
    session_code: str | None,
    event_type: str,
    severity: str,
    payload: dict | None,
) -> None:
    """Write a call interview proctor event directly to the assessment DB."""
    code = (session_code or "").strip()
    if not code:
        return

    raw_payload = payload or {}

    def _write() -> None:
        from ..assessment.db import AssessmentSessionLocal as _AssessmentSL
        from ..assessment.models import ExamSession as _ExamSession, ProctorEvent as _ProctorEvent
        from sqlalchemy import select as _select

        _NOT_PICKED = {"no-answer", "busy", "failed", "canceled"}
        db = _AssessmentSL()
        try:
            event = _ProctorEvent(
                session_code=code,
                assessment_type="call_interview",
                event_type=event_type,
                severity=severity,
                payload=raw_payload,
            )
            db.add(event)
            db.commit()

            # Derive call status to update on ExamSession
            status_from_event: str | None = None
            if event_type == "call_interview_call_status":
                twilio_status = str(raw_payload.get("status") or "").strip().lower()
                status_from_event = "not_picked" if twilio_status in _NOT_PICKED else (twilio_status or None)
            elif event_type == "call_interview_call_initiated":
                status_from_event = str(raw_payload.get("status") or "initiated").strip().lower() or "initiated"
            elif event_type == "call_interview_email_scheduled":
                status_from_event = "scheduled"
            elif event_type == "call_interview_completed":
                status_from_event = "completed"
            elif event_type in {
                "call_interview_call_failed",
                "call_interview_call_exception",
                "call_interview_failed_no_phone",
            }:
                status_from_event = "failed"
            elif event_type == "call_interview_cancelled":
                status_from_event = "cancelled"

            if status_from_event:
                session_obj = db.execute(
                    _select(_ExamSession).where(_ExamSession.session_code == code)
                ).scalars().first()
                if session_obj:
                    if status_from_event == "not_picked":
                        session_obj.call_attempt_count = (session_obj.call_attempt_count or 0) + 1
                    session_obj.call_status = status_from_event
                    if raw_payload.get("call_sid"):
                        session_obj.call_sid = str(raw_payload["call_sid"])
                    db.commit()
        finally:
            db.close()

    try:
        await asyncio.to_thread(_write)
    except Exception:
        logger.warning("Failed to log call event to DB: {}", event_type)


@router.post(
    "/voice/demo",
    response_model=VoiceDemoCallResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": VoiceDemoCallRequest.model_json_schema(),
                    "examples": {
                        "basic": {
                            "summary": "Create a call",
                            "value": {
                                "phone_number": "+919999999999",
                                "position": "Machine Learning Engineer",
                                "candidate_name": "Ava Patel",
                                "session_code": "EXAM-1234567890",
                                "candidate_email": "ava@example.com",
                            },
                        }
                    },
                }
            },
        }
    },
)
async def create_demo_voice_call(
    request: Request,
    _user: User = Depends(get_current_admin),
) -> VoiceDemoCallResponse:
    payload = await _parse_voice_demo_request(request)

    if Client is None:
        raise HTTPException(
            status_code=500,
            detail="Twilio dependency is not installed. Install 'twilio' in the backend environment.",
        )

    account_sid, auth_token, from_number = _get_twilio_credentials()

    try:
        first_hr_text = await generate_hr_line(
            hr_turn=1,
            candidate_name=payload.candidate_name,
            position=payload.position,
            user_speech=None,
            session_code=payload.session_code,
        )
    except Exception as exc:
        logger.warning("create_demo_voice_call: generate_hr_line failed ({}), using generic opener", exc)
        first_hr_text = f"Hello {payload.candidate_name}, this is SmartHire. Let's begin your interview for the {payload.position} role."

    first_audio: bytes | None = None
    try:
        first_audio = await _try_elevenlabs_audio(text=first_hr_text)
    except HTTPException as exc:
        logger.warning(
            "create_demo_voice_call: TTS unavailable ({}), placing call without pre-fetched audio — TwiML will fall back to <Say>",
            exc.detail,
        )
        await _log_tts_failure_event(session_code=payload.session_code, hr_turn=1, error=str(exc.detail))

    prefetched_audio_key = _cache_audio(first_hr_text, first_audio) if first_audio else ""

    base_url = _compute_public_base_url(request=request)
    twiml_url = (
        f"{base_url}/api/calls/voice/twiml"
        f"?name={quote_plus(payload.candidate_name)}"
        f"&position={quote_plus(payload.position)}"
        f"&session_code={quote_plus(payload.session_code or '')}"
        f"&prefetched_audio_key={quote_plus(prefetched_audio_key)}"
        f"&prefetched_text={quote_plus(first_hr_text)}"
    )
    status_callback_url = (
        f"{base_url}/api/calls/voice/status"
        f"?session_code={quote_plus(payload.session_code or '')}"
    )
    recording_callback_url = (
        f"{base_url}/api/calls/voice/recording"
        f"?session_code={quote_plus(payload.session_code or '')}"
    )

    try:
        client = Client(account_sid, auth_token)
        call = client.calls.create(
            to=payload.phone_number,
            from_=from_number,
            url=twiml_url,
            method="GET",
            record=True,
            recording_status_callback=recording_callback_url,
            recording_status_callback_method="POST",
            recording_status_callback_event=["completed"],
            status_callback=status_callback_url,
            status_callback_method="POST",
            status_callback_event=["initiated", "ringing", "answered", "completed"],
        )
    except HTTPException:
        raise
    except Exception as exc:
        if TwilioRestException is not None and isinstance(exc, TwilioRestException):
            code = getattr(exc, "code", None)
            msg = getattr(exc, "msg", None) or str(exc)
            await _log_assessment_call_event(
                session_code=payload.session_code,
                event_type="call_interview_call_failed",
                severity="high",
                payload={"twilio_code": code, "message": msg},
            )
            raise HTTPException(status_code=400, detail={"twilio_code": code, "message": msg})
        logger.exception("Twilio call creation failed")
        await _log_assessment_call_event(
            session_code=payload.session_code,
            event_type="call_interview_call_failed",
            severity="high",
            payload={"message": "Twilio call creation failed"},
        )
        raise HTTPException(status_code=502, detail="Twilio call creation failed")

    await _log_assessment_call_event(
        session_code=payload.session_code,
        event_type="call_interview_call_initiated",
        severity="low",
        payload={
            "call_sid": str(getattr(call, "sid", "")),
            "status": getattr(call, "status", None),
            "to": payload.phone_number,
            "candidate_email": str(payload.candidate_email) if payload.candidate_email else None,
            "recording_enabled": True,
        },
    )

    return VoiceDemoCallResponse(
        call_sid=str(getattr(call, "sid", "")),
        status=(getattr(call, "status", None) if call is not None else None),
        to=payload.phone_number,
        from_number=from_number,
        twiml_url=twiml_url,
    )


@router.post("/voice/status", include_in_schema=False)
async def voice_status_callback(request: Request, session_code: str | None = None) -> dict:
    """Twilio status callback webhook mirrored to assessment events for live tracking."""
    try:
        form = await request.form()
    except Exception:
        form = {}

    call_sid = str(form.get("CallSid") or "").strip()
    raw_status = str(form.get("CallStatus") or "").strip().lower()
    if not raw_status:
        return {"ok": True}

    await _log_assessment_call_event(
        session_code=session_code,
        event_type="call_interview_call_status",
        severity="low",
        payload={
            "call_sid": call_sid,
            "status": raw_status,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )
    return {"ok": True}


async def _run_call_analysis(*, session_code: str, transcript: str) -> None:
    """Background task: run LLM analysis on interview transcript and persist to DB."""
    try:
        # Fetch job title for context if available via assessment events
        role: str | None = None
        try:
            from ..assessment.db import AssessmentSessionLocal as _AssessmentSLSync
            from ..assessment.models import ExamSession as _ExamSessionSync
            from sqlalchemy import select as _sel_sync

            def _fetch_role() -> str | None:
                db = _AssessmentSLSync()
                try:
                    exam = db.execute(
                        _sel_sync(_ExamSessionSync).where(_ExamSessionSync.session_code == session_code)
                    ).scalars().first()
                    return exam.job_title if exam else None
                finally:
                    db.close()

            role = await asyncio.to_thread(_fetch_role)
        except Exception:
            pass

        result = await analyze_call_transcript(transcript=transcript, role=role)
        async with SessionLocal() as db_sess:
            from sqlalchemy import select as _select
            existing = (await db_sess.execute(
                _select(CallAnalysis).where(CallAnalysis.session_code == session_code)
            )).scalar_one_or_none()

            if existing:
                existing.overall_score = result.get("overall_score")
                existing.communication_score = result.get("communication_score")
                existing.technical_score = result.get("technical_score")
                existing.confidence_score = result.get("confidence_score")
                existing.sentiment = result.get("sentiment")
                existing.recommendation = result.get("recommendation")
                existing.summary = result.get("summary")
                existing.key_strengths = result.get("key_strengths")
                existing.concerns = result.get("concerns")
                existing.topic_coverage = result.get("topic_coverage")
                existing.raw_llm_response = result
            else:
                db_sess.add(CallAnalysis(
                    session_code=session_code,
                    overall_score=result.get("overall_score"),
                    communication_score=result.get("communication_score"),
                    technical_score=result.get("technical_score"),
                    confidence_score=result.get("confidence_score"),
                    sentiment=result.get("sentiment"),
                    recommendation=result.get("recommendation"),
                    summary=result.get("summary"),
                    key_strengths=result.get("key_strengths"),
                    concerns=result.get("concerns"),
                    topic_coverage=result.get("topic_coverage"),
                    raw_llm_response=result,
                ))
            await db_sess.commit()
        logger.info("Call analysis saved for session_code={}", session_code)

        await _log_assessment_call_event(
            session_code=session_code,
            event_type="call_interview_analysis_ready",
            severity="low",
            payload={
                "session_code": session_code,
                "overall_score": result.get("overall_score"),
                "recommendation": result.get("recommendation"),
                "sentiment": result.get("sentiment"),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
    except Exception as exc:
        logger.warning("Call transcript analysis failed for session_code={}: {}", session_code, exc)


@router.post("/voice/recording", include_in_schema=False)
async def voice_recording_callback(request: Request, session_code: str | None = None) -> dict:
    """Twilio recording callback webhook to persist MP3 locally and mirror the event."""
    try:
        form = await request.form()
    except Exception:
        form = {}

    call_sid = str(form.get("CallSid") or "").strip()
    recording_sid = str(form.get("RecordingSid") or "").strip()
    recording_url = str(form.get("RecordingUrl") or "").strip()
    recording_status = str(form.get("RecordingStatus") or "").strip().lower()
    recording_duration = str(form.get("RecordingDuration") or "").strip()

    local_path: str | None = None
    local_file_name: str | None = None
    recording_fetch_url: str | None = None
    download_error: str | None = None
    transcript_generated = False
    transcript_provider: str | None = None
    transcript_language_code: str | None = None
    transcript_word_count: int | None = None
    transcript_text: str = ""

    if recording_url:
        try:
            saved_path = await _download_twilio_recording(
                recording_url=recording_url,
                call_sid=call_sid,
                recording_sid=recording_sid,
            )
            local_path = str(saved_path)
            local_file_name = saved_path.name
            base_url = _compute_public_base_url(request=request)
            recording_fetch_url = f"{base_url}/api/calls/voice/recordings/{quote_plus(local_file_name)}"
            logger.info("Saved call recording: call_sid={} recording_sid={} path={}", call_sid, recording_sid, local_path)
        except Exception as exc:
            download_error = str(exc)
            logger.warning("Failed to persist call recording: call_sid={} recording_sid={} err={}", call_sid, recording_sid, download_error)

    if local_path:
        try:
            transcription = await _transcribe_recording(file_path=Path(local_path))
            transcript_text = str((transcription or {}).get("text") or "").strip()
            if transcript_text:
                transcript_generated = True
                transcript_provider = str((transcription or {}).get("provider") or "elevenlabs")
                transcript_language_code = str((transcription or {}).get("language_code") or "") or None
                transcript_word_count = int((transcription or {}).get("word_count") or len(transcript_text.split()))
                await _log_assessment_call_event(
                    session_code=session_code,
                    event_type="call_interview_transcript_ready",
                    severity="low",
                    payload={
                        "call_sid": call_sid,
                        "recording_sid": recording_sid,
                        "provider": transcript_provider,
                        "model_id": (transcription or {}).get("model_id"),
                        "language_code": transcript_language_code,
                        "language_probability": (transcription or {}).get("language_probability"),
                        "word_count": transcript_word_count,
                        "transcript_text": transcript_text,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    },
                )
        except Exception as exc:
            logger.warning("STT transcription failed for call_sid={} recording_sid={} err={}", call_sid, recording_sid, exc)
            await _log_assessment_call_event(
                session_code=session_code,
                event_type="call_interview_transcript_failed",
                severity="medium",
                payload={
                    "call_sid": call_sid,
                    "recording_sid": recording_sid,
                    "error": str(exc),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )

    # ── Run LLM analysis on transcript (background, non-blocking) ──
    if transcript_generated and transcript_text and session_code:
        asyncio.create_task(
            _run_call_analysis(session_code=session_code, transcript=transcript_text)
        )

    db_recording_id: int | None = None
    if local_path:
        try:
            audio_bytes = Path(local_path).read_bytes()
            if audio_bytes:
                async with SessionLocal() as db_sess:
                    rec = CallRecording(
                        call_sid=call_sid or None,
                        recording_sid=recording_sid or None,
                        session_code=session_code or None,
                        file_name=local_file_name or Path(local_path).name,
                        duration_seconds=(int(recording_duration) if recording_duration.isdigit() else None),
                        audio_data=audio_bytes,
                        transcript_text=(transcript_text if transcript_generated else None),
                    )
                    db_sess.add(rec)
                    await db_sess.commit()
                    await db_sess.refresh(rec)
                    db_recording_id = rec.id
                    logger.info("Saved call recording to DB: id={} call_sid={}", db_recording_id, call_sid)
        except Exception as exc:
            logger.warning("Failed to save recording to DB: call_sid={} err={}", call_sid, exc)

    await _log_assessment_call_event(
        session_code=session_code,
        event_type="call_interview_recording_ready",
        severity=("low" if local_path else "medium"),
        payload={
            "call_sid": call_sid,
            "recording_sid": recording_sid,
            "recording_status": recording_status or None,
            "recording_duration_seconds": (int(recording_duration) if recording_duration.isdigit() else None),
            "recording_url": (f"{recording_url}.mp3" if recording_url and not recording_url.endswith(".mp3") else recording_url or None),
            "local_file": local_path,
            "recording_file_name": local_file_name,
            "recording_fetch_url": recording_fetch_url,
            "download_error": download_error,
            "transcript_generated": transcript_generated,
            "transcript_provider": transcript_provider,
            "transcript_language_code": transcript_language_code,
            "transcript_word_count": transcript_word_count,
            "db_recording_id": db_recording_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )

    return {"ok": True}


# ── Recording CRUD (DB-backed) ───────────────────────────────────────────────

@router.get("/voice/db-recordings", include_in_schema=False)
async def list_db_recordings(
    session_code: str | None = None,
    _user: User = Depends(get_current_admin),
) -> list[dict]:
    """List all call recordings stored in the database (metadata only, no audio bytes)."""
    from sqlalchemy import select
    async with SessionLocal() as db_sess:
        stmt = select(CallRecording).order_by(CallRecording.created_at.desc())
        if session_code:
            stmt = stmt.where(CallRecording.session_code == session_code)
        rows = (await db_sess.execute(stmt)).scalars().all()
        return [
            {
                "id": r.id,
                "call_sid": r.call_sid,
                "recording_sid": r.recording_sid,
                "session_code": r.session_code,
                "file_name": r.file_name,
                "duration_seconds": r.duration_seconds,
                "has_transcript": bool(r.transcript_text),
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]


@router.get("/voice/db-recordings/{recording_id}", include_in_schema=False)
async def get_db_recording_audio(
    recording_id: int,
    _user: User = Depends(get_current_admin),
) -> Response:
    """Serve a call recording's audio from the database."""
    async with SessionLocal() as db_sess:
        rec = await db_sess.get(CallRecording, recording_id)
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")
        return Response(
            content=rec.audio_data,
            media_type="audio/mpeg",
            headers={"Content-Disposition": f'inline; filename="{rec.file_name}"'},
        )


@router.delete("/voice/db-recordings/{recording_id}", include_in_schema=False)
async def delete_db_recording(
    recording_id: int,
    _user: User = Depends(get_current_admin),
) -> dict:
    """Delete a call recording from the database."""
    async with SessionLocal() as db_sess:
        rec = await db_sess.get(CallRecording, recording_id)
        if not rec:
            raise HTTPException(status_code=404, detail="Recording not found")
        await db_sess.delete(rec)
        await db_sess.commit()
        logger.info("Deleted call recording id={} call_sid={}", recording_id, rec.call_sid)
        return {"ok": True, "deleted_id": recording_id}


@router.get("/voice/recordings-proxy", include_in_schema=False)
async def voice_recording_proxy(recording_url: str, _user: User = Depends(get_current_admin)) -> Response:
    """Proxy a Twilio-hosted recording for admins when local file save is unavailable."""
    account_sid, auth_token, _ = _get_twilio_credentials()
    url = _normalize_recording_url(recording_url)

    timeout = httpx.Timeout(25.0)
    async with httpx.AsyncClient(timeout=timeout, auth=(account_sid, auth_token)) as client:
        response = await client.get(url)

    if response.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Failed to fetch recording ({response.status_code})")

    media_type = response.headers.get("content-type") or "audio/mpeg"
    return Response(content=response.content, media_type=media_type)


@router.get("/voice/recordings/{file_name}", include_in_schema=False)
async def voice_recording_file(file_name: str, _user: User = Depends(get_current_admin)) -> Response:
    """Serve stored call recordings for authenticated admins."""
    path = _resolve_recording_file(file_name)
    return FileResponse(
        path=path,
        media_type="audio/mpeg",
        filename=path.name,
    )


@router.get("/voice/analysis/{session_code}", include_in_schema=False)
async def get_call_analysis(
    session_code: str,
    _user: User = Depends(get_current_admin),
) -> dict:
    """Return LLM-generated analysis for a voice interview session."""
    from sqlalchemy import select as _select
    async with SessionLocal() as db_sess:
        analysis = (await db_sess.execute(
            _select(CallAnalysis).where(CallAnalysis.session_code == session_code.strip().upper())
        )).scalar_one_or_none()
    if not analysis:
        raise HTTPException(status_code=404, detail="No analysis found for this session")
    return {
        "session_code": analysis.session_code,
        "overall_score": analysis.overall_score,
        "communication_score": analysis.communication_score,
        "technical_score": analysis.technical_score,
        "confidence_score": analysis.confidence_score,
        "sentiment": analysis.sentiment,
        "recommendation": analysis.recommendation,
        "summary": analysis.summary,
        "key_strengths": analysis.key_strengths or [],
        "concerns": analysis.concerns or [],
        "topic_coverage": analysis.topic_coverage or [],
        "created_at": analysis.created_at.isoformat() if analysis.created_at else None,
    }


@router.post("/voice/analysis/{session_code}/trigger", include_in_schema=False)
async def trigger_call_analysis(
    session_code: str,
    _user: User = Depends(get_current_admin),
) -> dict:
    """Run LLM analysis for a session that already has a transcript; waits and returns the result."""
    from sqlalchemy import select as _select
    sc = session_code.strip().upper()

    # 1. Check CallRecording table (preferred — full fidelity transcript)
    transcript_text: str | None = None
    async with SessionLocal() as db_sess:
        rec = (await db_sess.execute(
            _select(CallRecording).where(CallRecording.session_code == sc, CallRecording.transcript_text.isnot(None))
        )).scalars().first()
        if rec:
            transcript_text = rec.transcript_text

    # 2. Fall back to transcript stored in proctor events (call_interview_transcript_ready)
    if not transcript_text:
        try:
            def _fetch_transcript_from_events() -> str | None:
                from ..assessment.db import AssessmentSessionLocal as _ASL
                from ..assessment.models import ProctorEvent as _PE
                from sqlalchemy import select as _sel
                db = _ASL()
                try:
                    events = db.execute(
                        _sel(_PE)
                        .where(_PE.session_code == sc, _PE.event_type == "call_interview_transcript_ready")
                        .order_by(_PE.created_at.desc())
                    ).scalars().all()
                    for ev in events:
                        txt = (ev.payload or {}).get("transcript_text", "") if isinstance(ev.payload, dict) else ""
                        if txt:
                            return str(txt)
                    return None
                finally:
                    db.close()
            transcript_text = await asyncio.to_thread(_fetch_transcript_from_events)
        except Exception:
            pass

    # 3. Reconstruct transcript from candidate_response events (call succeeded but recording never saved)
    if not transcript_text:
        try:
            def _reconstruct_from_responses() -> str | None:
                from ..assessment.db import AssessmentSessionLocal as _ASL
                from ..assessment.models import ProctorEvent as _PE
                from sqlalchemy import select as _sel
                db = _ASL()
                try:
                    # Get all response/prompt events ordered by time, pick most recent call session
                    events = db.execute(
                        _sel(_PE)
                        .where(
                            _PE.session_code == sc,
                            _PE.event_type.in_([
                                "call_interview_candidate_response",
                                "call_interview_hr_prompt",
                            ])
                        )
                        .order_by(_PE.created_at.asc())
                    ).scalars().all()
                    if not events:
                        return None
                    # Deduplicate: keep only the most recent call session's turns
                    # (there may be multiple attempts; take the last continuous block)
                    lines: list[str] = []
                    seen_turns: set[int] = set()
                    for ev in reversed(events):
                        p = ev.payload if isinstance(ev.payload, dict) else {}
                        turn = p.get("hr_turn", 0)
                        if turn in seen_turns:
                            continue
                        seen_turns.add(turn)
                        if ev.event_type == "call_interview_candidate_response":
                            hr_text = str(p.get("interviewer_text") or "").strip()
                            candidate_text = str(p.get("candidate_speech") or "").strip()
                            if hr_text:
                                lines.append(f"Interviewer: {hr_text}")
                            if candidate_text:
                                lines.append(f"Candidate: {candidate_text}")
                        elif ev.event_type == "call_interview_hr_prompt":
                            hr_text = str(p.get("interviewer_text") or "").strip()
                            if hr_text and turn == 1:
                                lines.append(f"Interviewer: {hr_text}")
                    if not lines:
                        return None
                    lines.reverse()
                    return "\n".join(lines)
                finally:
                    db.close()
            transcript_text = await asyncio.to_thread(_reconstruct_from_responses)
            if transcript_text:
                logger.info("trigger_call_analysis: reconstructed transcript from candidate_response events for {}", sc)
        except Exception:
            pass

    if not transcript_text:
        raise HTTPException(status_code=404, detail="No transcript found for this session. Complete a voice call first.")

    # Run synchronously so the response carries the analysis result
    await _run_call_analysis(session_code=sc, transcript=transcript_text)
    async with SessionLocal() as db_sess:
        analysis = (await db_sess.execute(
            _select(CallAnalysis).where(CallAnalysis.session_code == sc)
        )).scalar_one_or_none()
    if not analysis:
        return {"ok": True, "message": "Analysis triggered but no result yet"}
    return {
        "ok": True,
        "session_code": analysis.session_code,
        "overall_score": analysis.overall_score,
        "communication_score": analysis.communication_score,
        "technical_score": analysis.technical_score,
        "confidence_score": analysis.confidence_score,
        "sentiment": analysis.sentiment,
        "recommendation": analysis.recommendation,
        "summary": analysis.summary,
        "key_strengths": analysis.key_strengths or [],
        "concerns": analysis.concerns or [],
        "topic_coverage": analysis.topic_coverage or [],
        "created_at": analysis.created_at.isoformat() if analysis.created_at else None,
    }


@router.get("/voice/twiml", include_in_schema=False)
async def voice_twiml(
    request: Request,
    name: str = "there",
    position: str | None = None,
    session_code: str | None = None,
    prefetched_audio_key: str | None = None,
    prefetched_text: str | None = None,
) -> Response:
    try:
        safe_name = (name or "there").strip() or "there"
        safe_name = safe_name[:100]

        if VoiceResponse is None:
            return _safe_twiml_error()

        base_url = _compute_public_base_url(request=request)
        cached_audio_key = str(prefetched_audio_key or "").strip() or None
        hr_text = str(prefetched_text or "").strip()
        if not hr_text:
            hr_text = await generate_hr_line(
                hr_turn=1,
                candidate_name=safe_name,
                position=position,
                user_speech=None,
                session_code=session_code,
            )

        await _log_assessment_call_event(
            session_code=session_code,
            event_type="call_interview_hr_prompt",
            severity="low",
            payload={"hr_turn": 1, "interviewer_text": hr_text},
        )

        if cached_audio_key and cached_audio_key in _audio_cache:
            audio_url = f"{base_url}/api/calls/voice/audio/{cached_audio_key}"
        else:
            try:
                audio_bytes = await _try_elevenlabs_audio(text=hr_text)
                cache_key = _cache_audio(hr_text, audio_bytes)
                audio_url = f"{base_url}/api/calls/voice/audio/{cache_key}"
            except HTTPException as exc:
                logger.warning("voice_twiml TTS unavailable (turn=1), falling back to <Say>: {}", exc.detail)
                await _log_tts_failure_event(session_code=session_code, hr_turn=1, error=str(exc.detail))
                audio_url = None

        vr = VoiceResponse()
        gather = vr.gather(
            input="speech",
            action=_build_continue_url(
                base_url=base_url,
                hr_turn=2,
                name=safe_name,
                position=position,
                session_code=session_code,
            ),
            method="POST",
            timeout=10,
            speech_timeout="auto",
            language="en-IN",
        )
        if audio_url:
            _speak(gather, audio_url)
        else:
            gather.say(hr_text, voice="Polly.Aditi", language="en-IN")
        # If candidate doesn't speak, redirect back to the same turn
        vr.redirect(
            _build_continue_url(
                base_url=base_url,
                hr_turn=2,
                name=safe_name,
                position=position,
                session_code=session_code,
            ),
            method="POST",
        )
        return Response(content=str(vr), media_type="application/xml")
    except Exception:
        logger.exception("voice_twiml failed")
        return _safe_twiml_error()


@router.post("/voice/continue", include_in_schema=False)
async def voice_continue(
    request: Request,
    hr_turn: int = 2,
    name: str = "there",
    position: str | None = None,
    session_code: str | None = None,
) -> Response:
    try:
        safe_name = (name or "there").strip() or "there"
        safe_name = safe_name[:100]

        if VoiceResponse is None:
            return _safe_twiml_error()

        form = await request.form()
        speech = str(form.get("SpeechResult") or "").strip()
        current_turn = int(hr_turn)

        base_url = _compute_public_base_url(request=request)
        hr_text = await generate_hr_line(
            hr_turn=current_turn,
            candidate_name=safe_name,
            position=position,
            user_speech=speech or None,
            session_code=session_code,
        )

        await _log_assessment_call_event(
            session_code=session_code,
            event_type="call_interview_candidate_response",
            severity="low",
            payload={
                "hr_turn": current_turn,
                "candidate_speech": speech,
                "interviewer_text": hr_text,
            },
        )

        try:
            audio_bytes = await _try_elevenlabs_audio(text=hr_text)
            cache_key = _cache_audio(hr_text, audio_bytes)
            audio_url = f"{base_url}/api/calls/voice/audio/{cache_key}"
        except HTTPException as exc:
            logger.warning(
                "voice_continue TTS unavailable (turn={}), falling back to <Say>: {}",
                current_turn,
                exc.detail,
            )
            await _log_tts_failure_event(session_code=session_code, hr_turn=current_turn, error=str(exc.detail))
            audio_url = None

        vr = VoiceResponse()
        if current_turn >= 6:
            await _log_assessment_call_event(
                session_code=session_code,
                event_type="call_interview_completed",
                severity="low",
                payload={"hr_turn": current_turn},
            )
            if session_code:
                clear_conversation(session_code)
            if audio_url:
                _speak(vr, audio_url)
            else:
                vr.say(hr_text, voice="Polly.Aditi", language="en-IN")
            vr.hangup()
            return Response(content=str(vr), media_type="application/xml")

        gather = vr.gather(
            input="speech",
            action=_build_continue_url(
                base_url=base_url,
                hr_turn=current_turn + 1,
                name=safe_name,
                position=position,
                session_code=session_code,
            ),
            method="POST",
            timeout=10,
            speech_timeout="auto",
            language="en-IN",
        )
        if audio_url:
            _speak(gather, audio_url)
        else:
            gather.say(hr_text, voice="Polly.Aditi", language="en-IN")
        # If candidate doesn't speak, advance to the next turn anyway
        vr.redirect(
            _build_continue_url(
                base_url=base_url,
                hr_turn=current_turn + 1,
                name=safe_name,
                position=position,
                session_code=session_code,
            ),
            method="POST",
        )
        return Response(content=str(vr), media_type="application/xml")
    except Exception:
        logger.exception("voice_continue failed")
        return _safe_twiml_error()


@router.get("/voice/audio/{cache_key}", include_in_schema=False)
async def voice_audio_cached(cache_key: str) -> Response:
    """Serve pre-generated audio from in-memory cache."""
    audio = _audio_cache.get(cache_key)
    if audio:
        return Response(content=audio, media_type="audio/mpeg")
    return Response(content=b"", media_type="audio/mpeg", status_code=404)


@router.get("/voice/audio", include_in_schema=False)
async def voice_audio(text: str | None = None, name: str = "there") -> Response:
    """Cartesia TTS endpoint."""
    if text is None or not str(text).strip():
        safe_name = (name or "there").strip() or "there"
        safe_name = safe_name[:100]
        text = f"Hi {safe_name} this is a demo call"

    text = str(text).strip()
    text = text[:240]

    try:
        audio_bytes = _generate_gtts_audio(text=text)
        return Response(content=audio_bytes, media_type="audio/mpeg")
    except Exception as exc:
        logger.warning("Cartesia TTS failed for audio endpoint: {}", exc)
        return Response(content=b"", media_type="audio/mpeg", status_code=502)
