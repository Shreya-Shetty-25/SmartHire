from __future__ import annotations

import hashlib
from urllib.parse import quote_plus

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status
from loguru import logger

try:
    from twilio.rest import Client  # type: ignore
    from twilio.twiml.voice_response import VoiceResponse  # type: ignore
    from twilio.base.exceptions import TwilioRestException  # type: ignore
except Exception:  # pragma: no cover
    Client = None  # type: ignore
    VoiceResponse = None  # type: ignore
    TwilioRestException = None  # type: ignore

from ..config import settings
from ..schemas import VoiceDemoCallRequest, VoiceDemoCallResponse
from ..voice_agent import generate_hr_line

router = APIRouter(prefix="/api/calls", tags=["calls"])

_TWILIO_VOICE = "Polly.Aditi"


def _elevenlabs_configured() -> bool:
    return bool(
        (settings.elevenlabs_api_key or "").strip()
        and (settings.elevenlabs_voice_id or "").strip()
    )


def _safe_twiml_error(text: str = "Sorry, a temporary error occurred. Please try again.") -> Response:
    """Return a valid TwiML <Say> response so Twilio never gets an HTTP error."""
    if VoiceResponse is None:
        return Response(content="<Response><Say>Error</Say></Response>", media_type="application/xml")
    vr = VoiceResponse()
    vr.say(text, voice=_TWILIO_VOICE)
    vr.hangup()
    return Response(content=str(vr), media_type="application/xml")


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


async def _generate_elevenlabs_audio(*, text: str) -> bytes:
    api_key, voice_id, model_id = _get_elevenlabs_config()

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {
        "xi-api-key": api_key,
        "accept": "audio/mpeg",
        "content-type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": model_id,
    }

    logger.info("ElevenLabs TTS request: voice_id={} model_id={} text_len={}", voice_id, model_id, len(text))
    timeout = httpx.Timeout(30.0)
    verify = not bool(settings.hf_disable_ssl_verify)
    async with httpx.AsyncClient(timeout=timeout, verify=verify) as client:
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        err_detail: dict | str
        try:
            err_detail = resp.json()
        except Exception:
            err_detail = (resp.text or "")[:500]

        # Avoid dumping huge response bodies.
        body_snippet = (resp.text[:500] if resp.text else "")
        logger.warning(
            "ElevenLabs TTS failed: status={} body_snippet={}...",
            resp.status_code,
            body_snippet,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "message": "ElevenLabs TTS generation failed",
                "status_code": resp.status_code,
                "elevenlabs": err_detail,
            },
        )

    return resp.content


async def _try_elevenlabs_audio(*, text: str) -> bytes | None:
    """Attempt ElevenLabs TTS. Returns audio bytes or None on failure."""
    if not _elevenlabs_configured():
        return None
    try:
        return await _generate_elevenlabs_audio(text=text)
    except Exception as exc:
        logger.warning("ElevenLabs TTS failed, will use Twilio <Say> fallback: {}", exc)
        return None


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


def _speak(vr_or_gather, text: str, audio_url: str | None) -> None:
    """Add <Play> (if audio URL available) or <Say> to a VoiceResponse/Gather."""
    if audio_url:
        vr_or_gather.play(audio_url)
    else:
        vr_or_gather.say(text, voice=_TWILIO_VOICE)


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
    code = (session_code or "").strip()
    if not code:
        return

    base = (settings.assessment_api_base_url or "").strip().rstrip("/")
    if not base:
        return

    url = f"{base}/api/proctor/events"
    body = {
        "session_code": code,
        "assessment_type": "call_interview",
        "event_type": event_type,
        "severity": severity,
        "payload": payload or {},
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(url, json=body)
    except Exception:
        logger.warning("Failed to mirror call event to assessment backend: {}", event_type)


@router.post("/voice/demo", response_model=VoiceDemoCallResponse)
async def create_demo_voice_call(
    payload: VoiceDemoCallRequest,
    request: Request,
) -> VoiceDemoCallResponse:
    if Client is None:
        raise HTTPException(
            status_code=500,
            detail="Twilio dependency is not installed. Install 'twilio' in the backend environment.",
        )

    account_sid, auth_token, from_number = _get_twilio_credentials()

    base_url = _compute_public_base_url(request=request)
    twiml_url = (
        f"{base_url}/api/calls/voice/twiml"
        f"?name={quote_plus(payload.candidate_name)}"
        f"&position={quote_plus(payload.position)}"
        f"&session_code={quote_plus(payload.session_code or '')}"
    )

    try:
        client = Client(account_sid, auth_token)
        call = client.calls.create(
            to=payload.phone_number,
            from_=from_number,
            url=twiml_url,
            method="GET",
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
        },
    )

    return VoiceDemoCallResponse(
        call_sid=str(getattr(call, "sid", "")),
        status=(getattr(call, "status", None) if call is not None else None),
        to=payload.phone_number,
        from_number=from_number,
        twiml_url=twiml_url,
    )


@router.get("/voice/twiml", include_in_schema=False)
async def voice_twiml(
    request: Request,
    name: str = "there",
    position: str | None = None,
    session_code: str | None = None,
) -> Response:
    try:
        safe_name = (name or "there").strip() or "there"
        safe_name = safe_name[:100]

        if VoiceResponse is None:
            return _safe_twiml_error()

        base_url = _compute_public_base_url(request=request)
        hr_text = await generate_hr_line(
            hr_turn=1,
            candidate_name=safe_name,
            position=position,
            user_speech=None,
        )

        await _log_assessment_call_event(
            session_code=session_code,
            event_type="call_interview_hr_prompt",
            severity="low",
            payload={"hr_turn": 1, "interviewer_text": hr_text},
        )

        audio_url = None
        audio_bytes = await _try_elevenlabs_audio(text=hr_text)
        if audio_bytes:
            cache_key = _cache_audio(hr_text, audio_bytes)
            audio_url = f"{base_url}/api/calls/voice/audio/{cache_key}"

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
        _speak(gather, hr_text, audio_url)
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

        base_url = _compute_public_base_url(request=request)
        hr_text = await generate_hr_line(
            hr_turn=int(hr_turn),
            candidate_name=safe_name,
            position=position,
            user_speech=speech or None,
        )

        await _log_assessment_call_event(
            session_code=session_code,
            event_type="call_interview_candidate_response",
            severity="low",
            payload={
                "hr_turn": int(hr_turn),
                "candidate_speech": speech,
                "interviewer_text": hr_text,
            },
        )

        audio_url = None
        audio_bytes = await _try_elevenlabs_audio(text=hr_text)
        if audio_bytes:
            cache_key = _cache_audio(hr_text, audio_bytes)
            audio_url = f"{base_url}/api/calls/voice/audio/{cache_key}"

        vr = VoiceResponse()
        if int(hr_turn) >= 6:
            await _log_assessment_call_event(
                session_code=session_code,
                event_type="call_interview_completed",
                severity="low",
                payload={"hr_turn": int(hr_turn)},
            )
            _speak(vr, hr_text, audio_url)
            vr.hangup()
            return Response(content=str(vr), media_type="application/xml")

        gather = vr.gather(
            input="speech",
            action=_build_continue_url(
                base_url=base_url,
                hr_turn=int(hr_turn) + 1,
                name=safe_name,
                position=position,
                session_code=session_code,
            ),
            method="POST",
            timeout=10,
            speech_timeout="auto",
            language="en-IN",
        )
        _speak(gather, hr_text, audio_url)
        # If candidate doesn't speak, advance to the next turn anyway
        vr.redirect(
            _build_continue_url(
                base_url=base_url,
                hr_turn=int(hr_turn) + 1,
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
    """Serve pre-generated ElevenLabs audio from in-memory cache."""
    audio = _audio_cache.pop(cache_key, None)
    if audio:
        return Response(content=audio, media_type="audio/mpeg")
    return Response(content=b"", media_type="audio/mpeg", status_code=404)


@router.get("/voice/audio", include_in_schema=False)
async def voice_audio(text: str | None = None, name: str = "there") -> Response:
    """Direct ElevenLabs TTS endpoint (for testing)."""
    if text is None or not str(text).strip():
        safe_name = (name or "there").strip() or "there"
        safe_name = safe_name[:100]
        text = f"Hi {safe_name} this is a demo call"

    text = str(text).strip()
    text = text[:240]

    try:
        audio_bytes = await _generate_elevenlabs_audio(text=text)
        return Response(content=audio_bytes, media_type="audio/mpeg")
    except Exception as exc:
        logger.warning("ElevenLabs TTS failed for audio endpoint: {}", exc)
        return Response(content=b"", media_type="audio/mpeg", status_code=502)
