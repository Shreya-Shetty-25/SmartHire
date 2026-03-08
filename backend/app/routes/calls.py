from __future__ import annotations

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

    timeout = httpx.Timeout(30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
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


def _build_audio_url(*, base_url: str, text: str) -> str:
    # Keep URLs short/safe.
    safe_text = (text or "").strip()
    safe_text = safe_text[:240]
    return f"{base_url}/api/calls/voice/audio?text={quote_plus(safe_text)}"


def _build_continue_url(*, base_url: str, hr_turn: int, name: str, position: str | None) -> str:
    pos = position or ""
    return (
        f"{base_url}/api/calls/voice/continue"
        f"?hr_turn={hr_turn}"
        f"&name={quote_plus(name)}"
        f"&position={quote_plus(pos)}"
    )


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
    )

    try:
        client = Client(account_sid, auth_token)
        call = client.calls.create(
            to=payload.phone_number,
            from_=from_number,
            url=twiml_url,
            method="GET",
        )
    except Exception as exc:
        if TwilioRestException is not None and isinstance(exc, TwilioRestException):
            # Trial accounts commonly hit 21219 (unverified number).
            code = getattr(exc, "code", None)
            msg = getattr(exc, "msg", None) or str(exc)
            detail = {"twilio_code": code, "message": msg}
            raise HTTPException(status_code=400, detail=detail)
    except HTTPException:
        raise
    except Exception:
        logger.exception("Twilio call creation failed")
        raise HTTPException(status_code=502, detail="Twilio call creation failed")

    return VoiceDemoCallResponse(
        call_sid=str(getattr(call, "sid", "")),
        status=(getattr(call, "status", None) if call is not None else None),
        to=payload.phone_number,
        from_number=from_number,
        twiml_url=twiml_url,
    )


@router.get("/voice/twiml", include_in_schema=False)
async def voice_twiml(request: Request, name: str = "there", position: str | None = None) -> Response:
    safe_name = (name or "there").strip() or "there"
    safe_name = safe_name[:100]

    if VoiceResponse is None:
        raise HTTPException(
            status_code=500,
            detail="Twilio dependency is not installed. Install 'twilio' in the backend environment.",
        )

    base_url = _compute_public_base_url(request=request)
    # HR1 (LLM-generated)
    hr_text = await generate_hr_line(
        hr_turn=1,
        candidate_name=safe_name,
        position=position,
        user_speech=None,
    )

    vr = VoiceResponse()
    gather = vr.gather(
        input="speech",
        action=_build_continue_url(base_url=base_url, hr_turn=2, name=safe_name, position=position),
        method="POST",
        timeout=6,
        speech_timeout="auto",
        language="en-IN",
    )
    gather.play(_build_audio_url(base_url=base_url, text=hr_text))
    return Response(content=str(vr), media_type="application/xml")


@router.post("/voice/continue", include_in_schema=False)
async def voice_continue(
    request: Request,
    hr_turn: int = 2,
    name: str = "there",
    position: str | None = None,
) -> Response:
    safe_name = (name or "there").strip() or "there"
    safe_name = safe_name[:100]

    if VoiceResponse is None:
        raise HTTPException(
            status_code=500,
            detail="Twilio dependency is not installed. Install 'twilio' in the backend environment.",
        )

    form = await request.form()
    speech = str(form.get("SpeechResult") or "").strip()

    base_url = _compute_public_base_url(request=request)
    hr_text = await generate_hr_line(
        hr_turn=int(hr_turn),
        candidate_name=safe_name,
        position=position,
        user_speech=speech or None,
    )

    vr = VoiceResponse()
    if int(hr_turn) >= 3:
        # Final HR line, then end the call.
        vr.play(_build_audio_url(base_url=base_url, text=hr_text))
        vr.hangup()
        return Response(content=str(vr), media_type="application/xml")

    gather = vr.gather(
        input="speech",
        action=_build_continue_url(base_url=base_url, hr_turn=int(hr_turn) + 1, name=safe_name, position=position),
        method="POST",
        timeout=6,
        speech_timeout="auto",
        language="en-IN",
    )
    gather.play(_build_audio_url(base_url=base_url, text=hr_text))
    return Response(content=str(vr), media_type="application/xml")


@router.get("/voice/audio", include_in_schema=False)
async def voice_audio(text: str | None = None, name: str = "there") -> Response:
    # Prefer explicit text (from the LLM), but keep a fallback.
    if text is None or not str(text).strip():
        safe_name = (name or "there").strip() or "there"
        safe_name = safe_name[:100]
        text = f"Hi {safe_name} this is a demo call"

    text = str(text).strip()
    text = text[:240]
    audio_bytes = await _generate_elevenlabs_audio(text=text)
    return Response(content=audio_bytes, media_type="audio/mpeg")
