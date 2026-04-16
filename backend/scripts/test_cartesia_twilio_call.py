from __future__ import annotations

import argparse
import os
import sys
import tempfile
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


# ---------------------------------------------------------------------------
# Cartesia TTS
# ---------------------------------------------------------------------------

# Some good Cartesia voice IDs (female):
#   Katie   : f786b574-daa5-4673-aa0c-cbe3e8534c02  (American, stable/realistic)
#   Tessa   : 6ccbfb76-1fc6-48f7-b71d-91ac6298247b  (American, expressive)
# Browse more at https://play.cartesia.ai/

CARTESIA_API_URL = "https://api.cartesia.ai/tts/bytes"
CARTESIA_API_VERSION = "2026-03-01"
CARTESIA_MODEL = "sonic-3"
CARTESIA_DEFAULT_VOICE = "95d51f79-c397-46f9-b49a-23763d3eaa2d"


def _generate_cartesia_audio(
    *,
    text: str,
    api_key: str,
    voice_id: str,
    language: str = "en",
    verify_ssl: bool = True,
) -> bytes:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Cartesia-Version": CARTESIA_API_VERSION,
        "Content-Type": "application/json",
    }
    payload = {
        "model_id": CARTESIA_MODEL,
        "transcript": text,
        "voice": {"mode": "id", "id": voice_id},
        "output_format": {
            "container": "mp3",
            "encoding": "pcm_f32le",
            "sample_rate": 24000,
        },
        "language": language,
    }

    timeout = httpx.Timeout(30.0)
    with httpx.Client(timeout=timeout, verify=verify_ssl) as client:
        resp = client.post(CARTESIA_API_URL, headers=headers, json=payload)

    if resp.status_code != 200:
        body = (resp.text or "")[:500]
        raise RuntimeError(
            f"Cartesia TTS failed: status={resp.status_code} body={body}"
        )

    if not resp.content:
        raise RuntimeError("Cartesia TTS returned empty audio")

    return resp.content


def _build_twiml(audio_url: str) -> str:
    vr = VoiceResponse()
    vr.play(audio_url)
    vr.pause(length=1)
    vr.hangup()
    return str(vr)


def _build_audio_url(base_url: str, text: str) -> str:
    safe_base = base_url.rstrip("/")
    return f"{safe_base}/api/calls/voice/audio?text={quote_plus(text)}"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Test Cartesia TTS and optionally place a Twilio call."
    )
    parser.add_argument(
        "--text",
        default=(
            "Hello. This is a Twilio call playing Cartesia generated audio from SmartHire. "
            "If you hear a natural generated voice, the integration is working. Goodbye."
        ),
        help="Text to synthesize.",
    )
    parser.add_argument(
        "--voice",
        default=CARTESIA_DEFAULT_VOICE,
        help=f"Cartesia voice ID. Default: {CARTESIA_DEFAULT_VOICE} (Katie).",
    )
    parser.add_argument(
        "--language",
        default="en",
        help="Language code (en, hi, etc.). Default: en.",
    )
    parser.add_argument(
        "--call",
        action="store_true",
        help="Actually place a Twilio call. Without this flag, only generates and saves audio locally.",
    )
    parser.add_argument(
        "--to",
        default="9157525105",
        help="Target phone number (used with --call).",
    )
    parser.add_argument(
        "--save",
        default=None,
        help="Save generated audio to this file path. If omitted, saves to a temp file.",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable SSL certificate verification.",
    )
    args = parser.parse_args()

    _load_env()

    cartesia_api_key = _require_env("CARTESIA_API_KEY")
    verify_ssl = not (args.insecure or _env_flag("HF_DISABLE_SSL_VERIFY", default=False))

    if not verify_ssl:
        print("SSL verification is disabled.")

    # --- Generate audio locally via Cartesia API ---
    print(f"Generating Cartesia audio (voice={args.voice}, lang={args.language})...")
    audio_bytes = _generate_cartesia_audio(
        text=args.text,
        api_key=cartesia_api_key,
        voice_id=args.voice,
        language=args.language,
        verify_ssl=verify_ssl,
    )
    print(f"Cartesia audio generated: {len(audio_bytes)} bytes")

    # Save to file
    if args.save:
        out_path = Path(args.save)
    else:
        tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        out_path = Path(tmp.name)
        tmp.close()

    out_path.write_bytes(audio_bytes)
    print(f"Audio saved to: {out_path}")

    # --- Place Twilio call ---
    account_sid = _require_env("TWILIO_ACCOUNT_SID")
    auth_token = _require_env("TWILIO_AUTH_TOKEN")
    from_number = _require_env("TWILIO_FROM_NUMBER")
    public_base_url = _require_env("PUBLIC_BASE_URL")

    target_number = _normalize_number(args.to)
    audio_url = _build_audio_url(public_base_url, args.text)

    print(f"Placing Twilio call to {target_number}...")
    print(f"Audio URL: {audio_url}")

    client = Client(account_sid, auth_token)
    twiml = _build_twiml(audio_url)

    call = client.calls.create(
        to=target_number,
        from_=from_number,
        twiml=twiml,
    )

    print(f"Call SID: {call.sid}")
    print(f"To: {target_number}")
    print(f"From: {from_number.strip()}")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
