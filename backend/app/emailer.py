from __future__ import annotations

import smtplib
from email.message import EmailMessage

from loguru import logger

from .config import settings


def send_email(*, to_email: str, subject: str, body: str) -> None:
    mode = (settings.email_mode or "log").strip().lower()

    if mode == "log":
        logger.info(
            "Email (log mode): to={} subject={} body={}...",
            to_email,
            subject,
            body[:200],
        )
        return

    if mode != "smtp":
        raise RuntimeError(f"Unsupported EMAIL_MODE: {settings.email_mode!r}")

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

    subject = f"SmartHire assessment link{title_line}"
    code_line = (
        f"Session code: {session_code.strip()}\n\n"
        if session_code and session_code.strip()
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
