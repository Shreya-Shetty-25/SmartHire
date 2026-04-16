from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import quote_plus

import httpx
from dotenv import load_dotenv
from twilio.rest import Client
from twilio.twiml.voice_response import VoiceResponse


def _load_env() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    load_dotenv(env_path)


def _require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def _env_flag(name: str, default: bool = False) -> bool:
    value = (os.getenv(name) or "").strip().lower()
    if not value:
        return default
    return value in {"1", "true", "yes", "on"}


def _normalize_number(raw_number: str) -> str:
    digits = "".join(ch for ch in raw_number if ch.isdigit() or ch == "+")
    if digits.startswith("+"):
        return digits

    only_digits = "".join(ch for ch in raw_number if ch.isdigit())
    if len(only_digits) == 10:
        return f"+91{only_digits}"
    if len(only_digits) > 10:
        return f"+{only_digits}"
    raise ValueError(
        "Phone number must be in E.164 format or a 10-digit Indian mobile number"
    )


def _build_audio_url(base_url: str, text: str) -> str:
    safe_base = base_url.rstrip("/")
    return f"{safe_base}/api/calls/voice/audio?text={quote_plus(text)}"


def _preflight_audio(audio_url: str, *, verify_ssl: bool) -> None:
    timeout = httpx.Timeout(30.0)
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True, verify=verify_ssl) as client:
            response = client.get(audio_url)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Audio preflight request failed: {exc}") from exc

    if response.status_code != 200 or not response.content:
        excerpt = ""
        try:
            excerpt = (response.text or "").strip()
        except Exception:
            excerpt = ""
        if excerpt and len(excerpt) > 220:
            excerpt = excerpt[:220] + "..."
        raise RuntimeError(
            "Audio preflight failed: "
            f"status={response.status_code} bytes={len(response.content or b'')}"
            + (f" body={excerpt}" if excerpt else "")
        )


def _build_twiml(audio_url: str) -> str:
    vr = VoiceResponse()
    vr.play(audio_url)
    vr.pause(length=1)
    vr.hangup()
    return str(vr)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Place a Twilio test call that plays gTTS-generated audio."
    )
    parser.add_argument(
        "--to",
        default="9157525105",
        help="Target phone number. Defaults to 9157525105 and normalizes to +91 for 10-digit input.",
    )
    parser.add_argument(
        "--text",
        default=(
            "Hello. This is a Twilio call playing gTTS generated audio from SmartHire. "
            "If you hear a natural generated voice, the integration is working. Goodbye."
        ),
        help="Text to synthesize and play during the test call.",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable SSL certificate verification for the local preflight request.",
    )
    args = parser.parse_args()

    _load_env()

    account_sid = _require_env("TWILIO_ACCOUNT_SID")
    auth_token = _require_env("TWILIO_AUTH_TOKEN")
    from_number = _require_env("TWILIO_FROM_NUMBER")
    public_base_url = _require_env("PUBLIC_BASE_URL")
    verify_ssl = not (args.insecure or _env_flag("HF_DISABLE_SSL_VERIFY", default=False))

    target_number = _normalize_number(args.to)
    audio_url = _build_audio_url(public_base_url, args.text)

    if not verify_ssl:
        print("SSL verification is disabled for the audio preflight request.")
    print(f"Preflighting gTTS audio endpoint: {audio_url}")
    _preflight_audio(audio_url, verify_ssl=verify_ssl)
    print("gTTS audio endpoint returned audio successfully.")

    client = Client(account_sid, auth_token)
    twiml = _build_twiml(audio_url)

    call = client.calls.create(
        to=target_number,
        from_=from_number,
        twiml=twiml,
    )

    print("Twilio test call created.")
    print(f"Call SID: {call.sid}")
    print(f"To: {target_number}")
    print(f"From: {from_number.strip()}")
    print("This call will play gTTS-generated audio via the backend /api/calls/voice/audio endpoint.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)