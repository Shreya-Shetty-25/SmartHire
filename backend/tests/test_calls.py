import os
from types import SimpleNamespace

# Avoid DB init during app startup in tests.
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://YOUR_PROJECT_REF:YOUR_PASSWORD@localhost:5432/postgres",
)

# Default Twilio values for tests (can be overridden in individual tests).
os.environ.setdefault("TWILIO_ACCOUNT_SID", "AC_TEST")
os.environ.setdefault("TWILIO_AUTH_TOKEN", "test_token")
os.environ.setdefault("TWILIO_FROM_NUMBER", "+15005550006")
os.environ.setdefault("PUBLIC_BASE_URL", "https://example.ngrok-free.app")

from fastapi.testclient import TestClient
import pytest

from app.deps import get_current_admin
from app.main import app


@pytest.fixture(autouse=True)
def override_admin_dependency():
    app.dependency_overrides[get_current_admin] = lambda: SimpleNamespace(
        id=1,
        email="admin@example.com",
        role="admin",
    )
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_current_admin, None)


def test_demo_voice_call_requires_twilio_config(monkeypatch):
    import app.routes.calls as calls_routes

    # Blank Twilio config should yield 400.
    monkeypatch.setattr(calls_routes.settings, "twilio_account_sid", None, raising=False)
    monkeypatch.setattr(calls_routes.settings, "twilio_auth_token", None, raising=False)
    monkeypatch.setattr(calls_routes.settings, "twilio_from_number", None, raising=False)

    client = TestClient(app)
    resp = client.post(
        "/api/calls/voice/demo",
        json={
            "phone_number": "+14155551212",
            "position": "Software Engineer",
            "candidate_name": "Ava",
        },
    )

    assert resp.status_code == 400
    assert "Twilio not configured" in resp.json()["detail"]


def test_demo_voice_call_creates_call_with_twiml_url(monkeypatch):
    import app.routes.calls as calls_routes

    class FakeCall:
        sid = "CA123"
        status = "queued"

    class FakeCalls:
        def __init__(self):
            self.last_kwargs = None

        def create(self, **kwargs):
            self.last_kwargs = kwargs
            return FakeCall()

    class FakeClient:
        def __init__(self, account_sid, auth_token):
            self.account_sid = account_sid
            self.auth_token = auth_token
            self.calls = FakeCalls()

    # Ensure Twilio config present.
    monkeypatch.setattr(calls_routes.settings, "twilio_account_sid", "AC_TEST", raising=False)
    monkeypatch.setattr(calls_routes.settings, "twilio_auth_token", "test_token", raising=False)
    monkeypatch.setattr(calls_routes.settings, "twilio_from_number", "+15005550006", raising=False)
    monkeypatch.setattr(
        calls_routes.settings,
        "public_base_url",
        "https://example.ngrok-free.app",
        raising=False,
    )

    # Replace Twilio client.
    monkeypatch.setattr(calls_routes, "Client", FakeClient)

    client = TestClient(app)

    payload = {
        "phone_number": "+14155551212",
        "position": "Software Engineer",
        "candidate_name": "Ava",
    }

    resp = client.post(
        "/api/calls/voice/demo",
        json=payload,
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["call_sid"] == "CA123"
    assert body["status"] == "queued"
    assert body["to"] == payload["phone_number"]
    assert body["from_number"] == "+15005550006"
    assert body["twiml_url"].startswith("https://example.ngrok-free.app/api/calls/voice/twiml")


def test_twiml_endpoint_speaks_demo_phrase():
    import app.routes.calls as calls_routes

    async def fake_line(*, hr_turn: int, candidate_name: str, position: str | None, user_speech: str | None) -> str:
        assert hr_turn == 1
        return "hmm hi Ava, quick chat?"

    async def fake_audio(*, text: str) -> bytes | None:
        assert "Ava" in text
        return b"FAKE_PREGENERATED_AUDIO"

    # Avoid real LLM call.
    calls_routes.generate_hr_line = fake_line  # type: ignore
    calls_routes._try_elevenlabs_audio = fake_audio  # type: ignore

    client = TestClient(app)
    resp = client.get("/api/calls/voice/twiml?name=Ava&position=SE")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/xml")
    assert "<Gather" in resp.text
    assert "input=\"speech\"" in resp.text
    assert "/api/calls/voice/continue" in resp.text
    assert "/api/calls/voice/audio" in resp.text


def test_audio_endpoint_returns_mpeg(monkeypatch):
    import app.routes.calls as calls_routes

    async def fake_generate(*, text: str) -> bytes:
        assert "Hi Ava this is a demo call" in text
        return b"FAKE_MP3_BYTES"

    monkeypatch.setattr(calls_routes, "_generate_elevenlabs_audio", fake_generate)

    client = TestClient(app)
    resp = client.get("/api/calls/voice/audio?name=Ava")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("audio/mpeg")
    assert resp.content == b"FAKE_MP3_BYTES"


def test_continue_endpoint_hangs_up_on_final_turn():
    import app.routes.calls as calls_routes

    async def fake_line(*, hr_turn: int, candidate_name: str, position: str | None, user_speech: str | None) -> str:
        assert hr_turn == 6
        return "okayyy thanks, bye"

    calls_routes.generate_hr_line = fake_line  # type: ignore

    client = TestClient(app)
    # Twilio posts SpeechResult in form data.
    resp = client.post(
        "/api/calls/voice/continue?hr_turn=6&name=Ava&position=SE",
        data={"SpeechResult": "yes"},
    )
    assert resp.status_code == 200
    assert "<Hangup" in resp.text
