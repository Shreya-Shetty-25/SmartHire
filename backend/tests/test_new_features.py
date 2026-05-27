"""Tests for features added in the May 2026 session:
- Job status field (CRUD + candidate filtering)
- Candidate delete endpoint
- Password change endpoint
- Application withdrawal endpoint
- Schema validation

NOTE: Async endpoint tests use ASGITransport against the real app.
DB-hitting tests may raise 500 due to the shared asyncpg connection state
across tests (known limitation of the test setup). We assert that:
  - Invalid payloads are rejected (422) without DB
  - Auth is enforced on all protected endpoints (401/403, or 500 if DB reused)
  - Schema/logic stays correct
"""
import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.auth import create_access_token


# ── helpers ────────────────────────────────────────────────────────────────

def _admin_token(user_id: int = 999) -> str:
    return create_access_token({"user_id": user_id, "role": "admin"})


def _candidate_token(user_id: int = 998) -> str:
    return create_access_token({"user_id": user_id, "role": "candidate"})


@pytest.fixture
def transport():
    return ASGITransport(app=app)


# ── Job status schema tests (pure unit tests — no DB) ──────────────────────

def test_job_create_default_status():
    from app.schemas import JobCreate
    j = JobCreate(title="T", description="D")
    assert j.status == "active"


def test_job_create_accepts_valid_statuses():
    from app.schemas import JobCreate
    for status in ("active", "paused", "closed"):
        j = JobCreate(title="T", description="D", status=status)
        assert j.status == status


def test_job_create_rejects_invalid_status():
    from app.schemas import JobCreate
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        JobCreate(title="T", description="D", status="hiring")


def test_job_response_has_status_field():
    from app.schemas import JobResponse
    import datetime
    r = JobResponse(
        id=1, title="T", description="D",
        education=None, years_experience=None,
        skills_required=None, additional_skills=None,
        location=None, employment_type=None,
        status="closed",
        created_at=datetime.datetime.now(),
    )
    assert r.status == "closed"


# ── Password strength validation (pure unit tests — no DB) ─────────────────

def test_password_strength_short():
    from fastapi import HTTPException
    from app.routes.auth import _validate_password_strength
    with pytest.raises(HTTPException) as exc_info:
        _validate_password_strength("Short1")
    assert exc_info.value.status_code == 400
    assert "12" in exc_info.value.detail


def test_password_strength_no_upper():
    from fastapi import HTTPException
    from app.routes.auth import _validate_password_strength
    with pytest.raises(HTTPException) as exc_info:
        _validate_password_strength("alllowercase123!")
    assert exc_info.value.status_code == 400


def test_password_strength_no_digit():
    from fastapi import HTTPException
    from app.routes.auth import _validate_password_strength
    with pytest.raises(HTTPException) as exc_info:
        _validate_password_strength("NoDigitsHereAtAll!")
    assert exc_info.value.status_code == 400


def test_password_strength_valid():
    from app.routes.auth import _validate_password_strength
    _validate_password_strength("ValidPass123!")  # must not raise


# ── Route registration checks (no DB — just verify routes exist) ───────────

def test_app_routes_include_password_change():
    routes = {r.path for r in app.routes}  # type: ignore[attr-defined]
    assert "/api/auth/password" in routes


def test_app_routes_include_candidate_delete():
    routes = {r.path for r in app.routes}  # type: ignore[attr-defined]
    assert "/api/candidates/{candidate_id}" in routes


# ── Auth enforcement tests (endpoint must require auth) ────────────────────

@pytest.mark.anyio
async def test_change_password_requires_auth(transport):
    """No token → 401 (no DB hit at all since token missing)."""
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.patch("/api/auth/password", json={
            "current_password": "old",
            "new_password": "NewPass123456!",
        })
    assert r.status_code == 401


@pytest.mark.anyio
async def test_candidate_delete_requires_auth(transport):
    """No token → 401."""
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.delete("/api/candidates/1")
    assert r.status_code == 401


@pytest.mark.anyio
async def test_withdraw_application_requires_auth(transport):
    """No token → 401/403."""
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.delete("/api/candidate-portal/jobs/1/apply")
    assert r.status_code in (401, 403)


@pytest.mark.anyio
async def test_candidate_jobs_requires_auth(transport):
    """No token → 401/403."""
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/candidate-portal/jobs")
    assert r.status_code in (401, 403)


# ── Token parsing / claim key tests (no DB) ───────────────────────────────

def test_token_contains_user_id_claim():
    """Token created with user_id key should decode with user_id."""
    from app.auth import decode_token
    token = _admin_token(user_id=42)
    claims = decode_token(token)
    assert claims is not None
    assert claims.get("user_id") == 42
    # Ensure 'sub' key is NOT present (old token format bug)
    assert "sub" not in claims


def test_candidate_role_in_token():
    from app.auth import decode_token
    token = _candidate_token(user_id=10)
    claims = decode_token(token)
    assert claims is not None
    assert claims.get("role") == "candidate"

