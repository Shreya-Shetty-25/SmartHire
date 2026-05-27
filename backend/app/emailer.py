from __future__ import annotations

import asyncio
import smtplib
from email.message import EmailMessage
import re
from urllib.parse import parse_qs, urlparse

from loguru import logger

from .config import settings


def _extract_session_code_from_link(test_link: str | None) -> str | None:
    raw = (test_link or "").strip()
    if not raw:
        return None

    # 1) Try query-string fields first.
    try:
        parsed = urlparse(raw)
        qs = parse_qs(parsed.query or "")
        val = (qs.get("code") or qs.get("session_code") or [""])[0]
        val = str(val or "").strip().upper()
        if val:
            return val
    except Exception:
        pass

    # 2) Fallback: regex scan anywhere in the link text.
    match = re.search(r"EXAM-[A-Z0-9]{6,20}", raw.upper())
    if match:
        return match.group(0)
    return None


def _resolve_email_mode() -> str:
    raw = (settings.email_mode or "").strip().lower()
    if raw in {"", "auto"}:
        # If SMTP appears configured, prefer real email delivery.
        if settings.smtp_host and settings.smtp_from:
            return "smtp"
        logger.warning("EMAIL_MODE is 'auto' but SMTP_HOST/SMTP_FROM are not set — falling back to log-only mode. Set SMTP_HOST, SMTP_FROM, SMTP_USER, SMTP_PASSWORD in .env to send real emails.")
        return "log"
    return raw


def _redact_email(addr: str | None) -> str:
    """Return a partially-redacted email for logs: ``j***@example.com``."""
    raw = str(addr or "").strip()
    if not raw or "@" not in raw:
        return "<unset>"
    local, _, domain = raw.partition("@")
    if not local:
        return f"<unset>@{domain}"
    if len(local) <= 1:
        return f"{local}***@{domain}"
    return f"{local[0]}***@{domain}"


def send_email(*, to_email: str, subject: str, body: str) -> None:
    mode = _resolve_email_mode()

    logger.info(
        "Email dispatch requested: mode={} to={} subject={} body_len={}",
        mode,
        _redact_email(to_email),
        subject,
        len(body or ""),
    )

    if mode == "log":
        logger.info(
            "Email (log mode): to={} subject={}",
            _redact_email(to_email),
            subject,
        )
        return

    if mode != "smtp":
        raise RuntimeError(f"Unsupported EMAIL_MODE: {settings.email_mode!r} (resolved={mode!r})")

    host = settings.smtp_host
    port = int(settings.smtp_port or 587)
    from_addr = settings.smtp_from
    username = settings.smtp_user
    password = settings.smtp_password

    if not host or not from_addr:
        raise RuntimeError("SMTP not configured (SMTP_HOST/SMTP_FROM missing)")

    msg = EmailMessage()
    from_name = (settings.smtp_from_name or "Smart Hire").strip()
    msg["From"] = f"{from_name} <{from_addr}>" if from_name else from_addr
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)

    try:
        with smtplib.SMTP(host=host, port=port, timeout=15) as server:
            if settings.smtp_tls:
                server.starttls()
            if username and password:
                server.login(username, password)
            server.send_message(msg)
    except smtplib.SMTPAuthenticationError as exc:
        logger.error("SMTP auth failed for {}: {}", host, exc.smtp_code)
        raise RuntimeError("SMTP authentication failed") from exc
    except smtplib.SMTPException as exc:
        logger.exception("SMTP send failed for to={}", _redact_email(to_email))
        raise RuntimeError(f"SMTP send failed: {type(exc).__name__}") from exc
    except OSError as exc:
        logger.exception("SMTP network error for host={}", host)
        raise RuntimeError(f"SMTP network error: {exc.__class__.__name__}") from exc


def send_test_link_email(
    *,
    to_email: str,
    candidate_name: str | None,
    job_title: str | None,
    test_link: str,
    session_code: str | None = None,
) -> None:
    name = (candidate_name or "Candidate").strip() or "Candidate"
    title_line = f" for {job_title.strip()}" if job_title and job_title.strip() else ""

    resolved_code = (session_code or "").strip().upper() or _extract_session_code_from_link(test_link)

    subject = f"SmartHire assessment link{title_line}"
    code_line = (
        f"Session code: {resolved_code}\n\n"
        if resolved_code
        else ""
    )
    body = (
        f"Hi {name},\n\n"
        f"Please complete the assessment using the link below:\n\n"
        f"{test_link}\n\n"
        f"{code_line}"
        "Thanks,\n"
        "HR Team\n"
    )

    send_email(to_email=to_email, subject=subject, body=body)


async def send_test_link_email_async(
    *,
    to_email: str,
    candidate_name: str | None,
    job_title: str | None,
    test_link: str,
    session_code: str | None = None,
) -> None:
    """Non-blocking wrapper — runs the synchronous SMTP send in a thread."""
    await asyncio.to_thread(
        send_test_link_email,
        to_email=to_email,
        candidate_name=candidate_name,
        job_title=job_title,
        test_link=test_link,
        session_code=session_code,
    )
