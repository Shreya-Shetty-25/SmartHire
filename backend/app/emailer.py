from __future__ import annotations

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
        return "log"
    return raw


def send_email(*, to_email: str, subject: str, body: str) -> None:
    mode = _resolve_email_mode()

    logger.info(
        "Email dispatch requested: mode={} to={} subject={} body_preview={}...",
        mode,
        to_email,
        subject,
        (body or "")[:240],
    )

    if mode == "log":
        logger.info(
            "Email (log mode): to={} subject={} body={}...",
            to_email,
            subject,
            body[:200],
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
    msg["From"] = from_addr
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)

    with smtplib.SMTP(host=host, port=port, timeout=15) as server:
        if settings.smtp_tls:
            server.starttls()
        if username and password:
            server.login(username, password)
        server.send_message(msg)


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
