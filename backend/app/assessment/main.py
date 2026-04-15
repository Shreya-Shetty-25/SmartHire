import asyncio
from datetime import datetime, timedelta, timezone
import json
import re
import time
from urllib.parse import quote_plus
from uuid import uuid4

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from loguru import logger
from sqlalchemy import and_, delete, func, select, text
from sqlalchemy.orm import Session

from .config import settings
from .db import AssessmentSessionLocal, JobsSessionLocal, assessment_engine, get_assessment_db, get_jobs_db, get_optional_jobs_db
from .models import AssessmentBase, ExamSession, Job, ProctorEvent
from .realtime import get_assessment_realtime_events_after, publish_assessment_realtime_event
from .schemas import (
    AdminActionResponse,
    AdminExamDetailOut,
    AdminExamReviewUpdateRequest,
    CandidateExamSessionOut,
    AdminScheduleCallRequest,
    ExamBeginResponse,
    AdminExamSessionOut,
    EnvCheckRequest,
    ExamAccessRequest,
    ExamCreateRequest,
    ExamCreateResponse,
    ExamDetailsResponse,
    ExamQuestion,
    ExamResultResponse,
    ExamSubmitRequest,
    ExamSubmitResponse,
    FaceIdVerificationRequest,
    FaceIdVerificationResponse,
    JobOut,
    ProctorEventRequest,
    ProctorFrameRequest,
    SecondaryRegisterRequest,
    SecondaryStatusResponse,
    SecondaryUploadRequest,
)
from .services.proctoring import (
    analyze_frame,
    analyze_secondary_environment_frame,
    cleanup_session_state,
    detect_audio_anomaly,
    get_secondary_stream_status,
    register_secondary_stream,
)
from .services.question_generator import generate_questions
from ..auth import decode_token as decode_core_token
from ..auth_utils import resolve_access_token
from ..models import Candidate as MainCandidate, JobCandidateProgress as MainJobCandidateProgress
from ..pipeline import append_history_entry, normalize_pipeline_stage

app = FastAPI(title="SmartHire Assessment API")
bearer_scheme = HTTPBearer(auto_error=False)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_current_assessment_admin(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    user = _resolve_assessment_user(
        request=request,
        credentials=credentials,
        require_admin=True,
    )
    user["_auth_token"] = resolve_access_token(request=request, credentials=credentials)
    return user


def _resolve_assessment_user(
    *,
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = None,
    require_admin: bool = False,
) -> dict:
    token = resolve_access_token(request=request, credentials=credentials)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    payload = decode_core_token(token)
    if not payload or not payload.get("user_id"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    if JobsSessionLocal is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Jobs database is unavailable")

    db = JobsSessionLocal()
    try:
        row = db.execute(
            text(
                "SELECT id, email, COALESCE(role, 'candidate') AS role, "
                "COALESCE(is_active, TRUE) AS is_active "
                "FROM users WHERE id = :user_id LIMIT 1"
            ),
            {"user_id": int(payload["user_id"])},
        ).mappings().first()
    finally:
        db.close()

    if not row or not bool(row.get("is_active", True)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if require_admin and str(row.get("role") or "candidate").lower() != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return dict(row)


def get_current_assessment_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    return _resolve_assessment_user(
        request=request,
        credentials=credentials,
        require_admin=False,
    )


def _summarize_payload(payload: object, max_len: int = 420) -> str:
    if payload is None:
        return ""
    try:
        text = str(payload)
    except Exception:
        return ""
    text = " ".join(text.split())
    return text if len(text) <= max_len else f"{text[:max_len]}…"


def _get_jobs_progress(
    *,
    jobs_db: Session | None,
    job_id: int | None,
    candidate_email: str | None,
) -> MainJobCandidateProgress | None:
    if jobs_db is None or not job_id or not candidate_email:
        return None

    candidate = (
        jobs_db.execute(
            select(MainCandidate).where(func.lower(MainCandidate.email) == str(candidate_email).strip().lower())
        )
        .scalars()
        .first()
    )
    if not candidate:
        return None

    progress = (
        jobs_db.execute(
            select(MainJobCandidateProgress).where(
                MainJobCandidateProgress.job_id == int(job_id),
                MainJobCandidateProgress.candidate_id == int(candidate.id),
            )
        )
        .scalars()
        .first()
    )
    if progress:
        return progress

    progress = MainJobCandidateProgress(
        job_id=int(job_id),
        candidate_id=int(candidate.id),
        stage="applied",
        decision_history=append_history_entry(
            [],
            action="created",
            stage="applied",
            actor="assessment_service",
            details={"source": "assessment_sync"},
        ),
    )
    jobs_db.add(progress)
    jobs_db.commit()
    jobs_db.refresh(progress)
    return progress


def _update_jobs_progress(
    *,
    jobs_db: Session | None,
    session: ExamSession,
    action: str,
    stage: str | None = None,
    recruiter_notes: str | None = None,
    manual_assessment_score: float | None = None,
    interview_status: str | None = None,
    interview_scheduled_for: datetime | None = None,
    append_note: str | None = None,
    details: dict | None = None,
) -> MainJobCandidateProgress | None:
    progress = _get_jobs_progress(
        jobs_db=jobs_db,
        job_id=getattr(session, "job_id", None),
        candidate_email=getattr(session, "candidate_email", None),
    )
    if progress is None:
        return None

    if stage:
        progress.stage = normalize_pipeline_stage(stage)
    if recruiter_notes is not None:
        progress.recruiter_notes = recruiter_notes.strip() or None
    if manual_assessment_score is not None:
        progress.manual_assessment_score = float(manual_assessment_score)
    if session.session_code:
        progress.last_assessment_session_code = session.session_code
    progress.assessment_status = session.status
    effective_score = manual_assessment_score if manual_assessment_score is not None else session.percentage
    if effective_score is not None:
        progress.assessment_score = float(effective_score)
    if session.passed is not None:
        progress.assessment_passed = bool(session.passed)
    if interview_status is not None:
        progress.interview_status = interview_status.strip() or None
    if interview_scheduled_for is not None:
        progress.interview_scheduled_for = interview_scheduled_for
    progress.decision_history = append_history_entry(
        progress.decision_history,
        action=action,
        stage=progress.stage,
        actor="assessment_admin",
        note=append_note or recruiter_notes,
        details=details,
    )
    progress.updated_at = datetime.now(timezone.utc)
    jobs_db.add(progress)
    jobs_db.commit()
    jobs_db.refresh(progress)
    return progress


def _event_label(event_type: str) -> str:
    mapping = {
        "exam_created": "Exam created",
        "exam_started": "Exam started",
        "exam_scored": "Exam scored",
        "exam_submitted": "Exam submitted",
        "camera_analysis": "Camera analysis",
        "face_id_verification": "Identity details saved",
        "identity_artifacts_saved": "Identity artifacts saved",
        "devtools_detected": "Developer tools suspected",
        "multiple_tabs_detected": "Multiple exam tabs detected",
        "tab_switched": "Tab switched / page hidden",
        "window_blur": "Window focus lost",
        "fullscreen_exited": "Fullscreen exited",
        "shortcut_burst_detected": "Suspicious shortcut burst",
        "network_offline": "Network went offline",
        "audio_noise_detected": "Background noise detected",
        "audio_check": "Audio check",
        "secondary_environment_analysis": "Secondary environment analysis",
        "suspicious_face_movement": "Suspicious face movement",
        "suspicious_eye_movement": "Suspicious face movement",
        "suspicious_head_movement": "Suspicious head movement",
        "suspicious_object_detected": "Suspicious object (phone/device)",
        "multiple_faces_detected": "Multiple faces detected",
        "no_face_detected": "Face not visible",
        "audio_anomaly_detected": "Audio anomaly detected",
        "voice_activity_detected": "Voice activity detected",
        "speech_detected": "Speech detected",
        "speech_recognition": "Speech recognition",
        "screenshot_captured": "Screenshot captured",
        "calibrating_gaze_baseline": "Gaze calibration",
        "ip_recorded": "IP recorded",
        "ip_changed": "IP changed",
    }
    if event_type in mapping:
        return mapping[event_type]
    return event_type.replace("_", " ").strip() or "event"


def _severity_rank(severity: str | None) -> int:
    s = str(severity or "").lower()
    if s == "high":
        return 3
    if s == "medium":
        return 2
    return 1


def _extract_violation_details(event: ProctorEvent) -> list[str]:
    """Pull human-readable violation specifics from an event's payload."""
    payload = event.payload
    if not payload or not isinstance(payload, dict):
        return []

    details: list[str] = []

    # Camera analysis: flags list contains specific sub-violations
    flag_labels = {
        "no_face_detected": "No face detected in frame",
        "multiple_faces_detected": "Multiple faces detected in frame",
        "suspicious_face_movement": "Suspicious face movement (looking away)",
        "suspicious_eye_movement": "Suspicious face movement (looking away)",
        "suspicious_head_movement": "Suspicious head movement (turned away)",
        "prolonged_offscreen_attention": "Prolonged attention off-screen",
        "suspicious_candidate_identity_change": "Candidate identity appears to have changed",
        "suspicious_object_detected": "Suspicious object detected",
        "cell_phone_detected": "Cell phone detected in frame",
        "book_detected": "Book/notes detected in frame",
        "laptop_detected": "Second laptop/device detected",
        "monitor_detected": "Additional monitor detected",
        "calibrating_gaze_baseline": "Gaze baseline calibration in progress",
        "face_id_mismatch": "Face does not match ID photo",
        "low_face_quality": "Low face image quality",
        "multiple_faces_in_id": "Multiple faces found in ID photo",
        "id_face_not_detected": "No face detected in ID image",
        "government_id_not_uploaded": "Government ID was not uploaded",
        "selfie_not_uploaded": "Selfie was not uploaded",
        "selfie_face_not_detected": "No face detected in selfie image",
        "multiple_faces_in_selfie": "Multiple faces found in selfie image",
        "uploaded_image_not_government_id_like": "Uploaded image did not look like a government ID",
        "unsupported_government_id_type": "Unsupported ID type selected",
        "id_image_appears_like_selfie": "ID image appears to be a selfie",
        "id_image_resolution_too_low": "ID image resolution too low",
        "selfie_image_resolution_too_low": "Selfie image resolution too low",
        "id_face_too_small": "Face is too small in ID image",
        "selfie_face_too_small": "Face is too small in selfie image",
        "face_signature_generation_failed": "Could not extract reliable face signature",
        "invalid_image_payload": "Invalid image data received",
        "secondary_low_light": "Secondary camera: low light conditions",
        "secondary_portrait_view_detected": "Secondary camera: portrait orientation detected",
        "secondary_blurry_or_occluded": "Secondary camera: blurry or occluded view",
        "secondary_camera_too_close_reduce_background_visibility": "Secondary camera: too close, background not visible",
        "secondary_feed_possibly_frozen": "Secondary camera: feed appears frozen",
    }

    single_flag = payload.get("flag")
    if single_flag and isinstance(single_flag, str):
        details.append(flag_labels.get(single_flag, single_flag.replace("_", " ").title()))

    flags = payload.get("flags")
    if isinstance(flags, list):
        for flag in flags:
            if flag and flag != "calibrating_gaze_baseline":
                details.append(flag_labels.get(flag, flag.replace("_", " ").title()))

    # Face-ID verification: similarity info
    similarity = payload.get("similarity")
    if similarity is not None and isinstance(similarity, (int, float)):
        threshold = payload.get("threshold", "N/A")
        details.append(f"Face similarity: {similarity:.0%} (threshold: {threshold})")

    verified = payload.get("verified")
    if verified is False and "similarity" not in str(details):
        details.append("Face-ID verification failed")

    # Object detection counts
    obj_det = payload.get("object_detection") or payload.get("phone_book_detection")
    if isinstance(obj_det, dict):
        counts = obj_det.get("counts") or obj_det
        if isinstance(counts, dict):
            for obj_name, cnt in counts.items():
                if isinstance(cnt, (int, float)) and cnt > 0:
                    details.append(f"{obj_name.replace('_', ' ').title()}: {int(cnt)} detected")

    # Devtools
    width_gap = payload.get("widthGap")
    height_gap = payload.get("heightGap")
    if width_gap is not None or height_gap is not None:
        details.append(f"Window size gap: {width_gap}×{height_gap}px")

    # Shortcut burst
    count_10s = payload.get("count_10s")
    if count_10s is not None:
        details.append(f"{count_10s} shortcuts in 10 seconds")

    # Clipboard
    preview = payload.get("preview")
    if preview:
        details.append(f"Clipboard content: \"{preview}…\"")

    # Typing anomaly
    reason = payload.get("reason")
    if reason:
        details.append(f"Reason: {reason.replace('_', ' ')}")

    # IP changed
    initial_ip = payload.get("initial")
    current_ip = payload.get("current")
    if initial_ip and current_ip:
        details.append(f"IP changed from {initial_ip} to {current_ip}")

    # VM detection
    vm_signals = payload.get("signals")
    if isinstance(vm_signals, list) and vm_signals:
        details.append("VM signals: " + ", ".join(str(s) for s in vm_signals[:5]))

    # Liveness challenge
    expected = payload.get("expected")
    observed = payload.get("observed")
    if expected and observed:
        details.append(f"Expected: {expected}, Observed: {observed}")

    # Browser extensions
    ext_count = payload.get("count")
    if ext_count is not None and event.event_type == "browser_extension_detected":
        details.append(f"{ext_count} browser extension(s) injecting into page")

    return details


def _build_proctor_insights(*, events: list[ProctorEvent]) -> tuple[list[dict], list[dict]]:
    """Convert raw logs into a user-readable green/red signal summary.

    We avoid dumping raw payloads; instead we aggregate by event type and keep
    a couple of key examples (timestamps) for context.
    """

    buckets: dict[str, dict] = {}
    for event in events:
        et = str(event.event_type or "event")
        bucket = buckets.get(et)
        if bucket is None:
            bucket = {
                "event_type": et,
                "label": _event_label(et),
                "count": 0,
                "max_severity": "low",
                "first_at": None,
                "last_at": None,
                "details": set(),
            }
            buckets[et] = bucket

        bucket["count"] += 1
        if _severity_rank(event.severity) > _severity_rank(bucket["max_severity"]):
            bucket["max_severity"] = event.severity

        created_at = getattr(event, "created_at", None)
        if created_at:
            if bucket["first_at"] is None or created_at < bucket["first_at"]:
                bucket["first_at"] = created_at
            if bucket["last_at"] is None or created_at > bucket["last_at"]:
                bucket["last_at"] = created_at

        # Collect specific violation details from the payload.
        for detail in _extract_violation_details(event):
            bucket["details"].add(detail)

    def _as_out(b: dict) -> dict:
        return {
            "event_type": b["event_type"],
            "label": b["label"],
            "count": int(b["count"]),
            "severity": str(b["max_severity"] or "low").lower(),
            "first_at": b["first_at"],
            "last_at": b["last_at"],
            "details": sorted(b["details"]),
        }

    red_keywords = {
        "multiple_tabs_detected",
        "tab_switched",
        "window_blur",
        "fullscreen_exited",
        "audio_noise_detected",
        "shortcut_burst_detected",
        "devtools_detected",
        "secondary_environment_analysis",
        "camera_analysis",
        "face_id_verification",
        "network_offline",
        "suspicious_face_movement",
        "suspicious_eye_movement",
        "suspicious_head_movement",
        "suspicious_object_detected",
        "multiple_faces_detected",
        "no_face_detected",
        "audio_anomaly_detected",
        "voice_activity_detected",
        "speech_detected",
        "speech_recognition",
    }

    green_explicit = {
        "exam_started",
        "exam_submitted",
        "exam_scored",
    }

    # Trivial or noisy events that should not appear in either panel.
    hidden = {
        "exam_created",
        "audio_check",
        "audio_ok",
        "liveness_challenge_passed",
        "liveness_challenge_issued",
        "ip_recorded",
        "ip_changed",
        "env_check",
        "env_checked",
        "env_started",
        "screenshot_captured",
        "calibrating_gaze_baseline",
        "secondary_environment_analysis",
    }

    green: list[dict] = []
    red: list[dict] = []

    for et, bucket in buckets.items():
        if et in hidden:
            continue
        out = _as_out(bucket)
        sev = out["severity"]

        is_red = sev == "high" or et in red_keywords
        # Face-ID verification: only red if failed.
        if et == "face_id_verification":
            # If we have any failed event, it should have been high severity.
            is_red = sev in {"medium", "high"}

        # Camera analysis is noisy: treat as red only when high.
        if et == "camera_analysis":
            is_red = sev == "high"

        if et in green_explicit and not is_red:
            green.append(out)
        elif is_red:
            red.append(out)
        else:
            # Default bucket: medium/high => red; otherwise green.
            (red if sev in {"medium", "high"} else green).append(out)

    red.sort(key=lambda item: (_severity_rank(item.get("severity")), item.get("count", 0)), reverse=True)
    green.sort(key=lambda item: (item.get("count", 0), item.get("label", "")), reverse=True)
    return green, red


def _default_proctor_recommendation(*, score_pct: float | None, red: list[dict]) -> dict:
    blocker_types = {
        "multiple_tabs_detected",
        "fullscreen_exited",
        "camera_analysis",
        "secondary_environment_analysis",
        "face_id_verification",
        "tab_switched",
        "vm_detected",
        "remote_desktop_detected",
        "ip_changed",
        "typing_anomaly_detected",
    }
    has_blocker = any(
        (item.get("event_type") in blocker_types and str(item.get("severity")) in {"high"})
        for item in (red or [])
    )
    pct = float(score_pct) if score_pct is not None else None

    if has_blocker:
        return {
            "recommendation": "hold",
            "risk_level": "high",
            "conclusion": "Proctoring shows high-risk violations; do not proceed without manual review.",
        }
    if pct is not None and pct >= 60:
        return {
            "recommendation": "proceed",
            "risk_level": "low",
            "conclusion": "Assessment passed and no high-risk proctoring blockers were detected.",
        }
    return {
        "recommendation": "hold",
        "risk_level": "medium",
        "conclusion": "Assessment score is below the pass threshold or proctoring signals need review.",
    }


def _extract_first_json_object(text: str) -> dict | None:
    raw = (text or "").strip()
    if not raw:
        return None
    # Try strict JSON first.
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    # Fallback: find first {...} block.
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _json_safe(value):
    """Convert nested Python values into JSON-serializable values.

    SQLite JSON columns and json.dumps() can't handle datetime objects.
    """

    if value is None:
        return None

    if isinstance(value, (str, int, float, bool)):
        return value

    if isinstance(value, datetime):
        # Always serialize as ISO-8601
        try:
            if value.tzinfo is None:
                return value.replace(tzinfo=timezone.utc).isoformat()
            return value.isoformat()
        except Exception:
            return str(value)

    if isinstance(value, list):
        return [_json_safe(v) for v in value]

    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}

    # Fallback for unknown objects
    return str(value)


def _generate_ai_proctor_summary(*, session: ExamSession, severity: dict, green: list[dict], red: list[dict]) -> dict:
    """Generate (and cache) an AI-readable conclusion for admins.

    Returns a dict that is stored in ExamSession.proctor_ai_summary.
    """

    base = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "assessment_type": _normalize_assessment_type(getattr(session, "assessment_type", None)),
        "score": session.score,
        "total": session.total_questions,
        "percentage": session.percentage,
        "severity": severity,
        "recommendation": None,
        "risk_level": None,
        "conclusion": None,
        "highlights": {
            "green": green[:8],
            "red": red[:10],
        },
        "model": None,
    }

    rule_based = _default_proctor_recommendation(score_pct=session.percentage, red=red)
    base.update(rule_based)

    if not (settings.use_azure_openai and settings.azure_openai_endpoint and settings.azure_openai_api_key):
        base["model"] = "rule_based"
        return base

    endpoint = settings.azure_openai_endpoint.strip().rstrip("/")
    deployment = (settings.azure_openai_deployment or "").strip()
    url = f"{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={settings.azure_openai_api_version}"

    system = (
        "You are an assistant helping a recruiter review a proctored technical assessment. "
        "You must produce a concise conclusion and a recommendation. "
        "Output JSON ONLY with keys: recommendation (proceed|hold|review), risk_level (low|medium|high), conclusion (1-3 sentences), rationale (2-4 bullets as strings)."
    )

    user = {
        "candidate": {"name": session.candidate_name, "email": session.candidate_email},
        "assessment": {
            "type": _normalize_assessment_type(getattr(session, "assessment_type", None)),
            "job_title": session.job_title,
            "score": session.score,
            "total": session.total_questions,
            "percentage": session.percentage,
            "status": session.status,
        },
        "proctoring": {
            "severity_counts": severity,
            "red_signals": _json_safe(red[:10]),
            "green_signals": _json_safe(green[:8]),
        },
        "instruction": "Decide whether the candidate should proceed to next round. If there are high-risk cheating signals, prefer hold/review even if score is high.",
    }

    try:
        resp = httpx.post(
            url,
            headers={"api-key": settings.azure_openai_api_key, "Content-Type": "application/json"},
            json={
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps(_json_safe(user))},
                ],
                "max_completion_tokens": 260,
            },
            timeout=25.0,
        )
        if resp.status_code < 400:
            data = resp.json()
            text = str(data["choices"][0]["message"]["content"]).strip()
            parsed = _extract_first_json_object(text)
            if parsed:
                base["recommendation"] = parsed.get("recommendation") or base["recommendation"]
                base["risk_level"] = parsed.get("risk_level") or base["risk_level"]
                base["conclusion"] = parsed.get("conclusion") or base["conclusion"]
                base["rationale"] = parsed.get("rationale")
                base["model"] = deployment or "azure_openai"
                return _json_safe(base)
    except Exception as exc:
        logger.warning("AI proctor summary generation failed: {}", exc)

    base["model"] = "rule_based_fallback"
    return _json_safe(base)


# ---------------------------------------------------------------------------
# Email helper
# ---------------------------------------------------------------------------
import smtplib
from email.message import EmailMessage


def _send_email(*, to_email: str, subject: str, body: str) -> None:
    mode = (settings.email_mode or "auto").strip().lower()
    if mode in {"", "auto"}:
        if settings.smtp_host and settings.smtp_from:
            mode = "smtp"
        else:
            logger.warning("EMAIL_MODE is 'auto' but SMTP not configured — logging email only. Set SMTP_HOST, SMTP_FROM, SMTP_USER, SMTP_PASSWORD in .env.")
            mode = "log"
    if mode == "log":
        logger.info("Email (log mode): to={} subject={} body={}...", to_email, subject, body[:300])
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


def _send_result_email(session: ExamSession) -> str:
    """Send pass/fail email and return the type sent."""
    percentage = float(session.percentage or 0)
    name = (session.candidate_name or "Candidate").strip()
    job_title = (session.job_title or "the role").strip()

    if percentage >= 60:
        subject = f"SmartHire Assessment Result - Congratulations, {name}!"
        body = (
            f"Hi {name},\n\n"
            f"Congratulations! You have successfully passed the assessment for {job_title} "
            f"with a score of {session.score}/{session.total_questions} ({percentage:.0f}%).\n\n"
            f"Our team will call you shortly to proceed with the next round of interviews "
            f"(Technical + HR).\n\n"
            f"Please keep your phone available.\n\n"
            f"Best regards,\nSmartHire HR Team\n"
        )
        email_type = "pass"
    else:
        subject = f"SmartHire Assessment Result - {name}"
        body = (
            f"Hi {name},\n\n"
            f"Thank you for taking the assessment for {job_title}. "
            f"Your score was {session.score}/{session.total_questions} ({percentage:.0f}%).\n\n"
            f"Unfortunately, we will not be moving forward with your application at this time.\n\n"
            f"We appreciate your interest and encourage you to apply again in the future.\n\n"
            f"Best regards,\nSmartHire HR Team\n"
        )
        email_type = "fail"

    try:
        _send_email(to_email=session.candidate_email, subject=subject, body=body)
    except Exception as exc:
        logger.warning("Failed to send result email to {}: {}", session.candidate_email, exc)

    return email_type


# ---------------------------------------------------------------------------
# Azure LLM helper for result analysis and call
# ---------------------------------------------------------------------------
def _generate_result_analysis(session: ExamSession) -> dict:
    """Generate a detailed result analysis using Azure OpenAI or fallback."""
    questions = session.questions_json or []
    answers = session.answers_json or []
    answer_lookup = {item.get("question_id"): item.get("answer") for item in answers}

    correct_topics = []
    incorrect_topics = []
    for q in questions:
        q_text = q.get("question", "")[:100]
        user_ans = answer_lookup.get(q["id"], "")
        correct_ans = q.get("answer", "")
        if user_ans == correct_ans:
            correct_topics.append(q_text)
        else:
            incorrect_topics.append({"question": q_text, "user_answer": user_ans, "correct_answer": correct_ans})

    analysis = {
        "total_questions": len(questions),
        "correct": len(correct_topics),
        "incorrect": len(incorrect_topics),
        "percentage": round((len(correct_topics) / max(len(questions), 1)) * 100, 1),
        "correct_topics": correct_topics,
        "incorrect_details": incorrect_topics,
        "strengths": correct_topics[:5],
        "weaknesses": [i["question"] for i in incorrect_topics[:5]],
    }

    # Try to get LLM-based summary
    if settings.use_azure_openai and settings.azure_openai_endpoint and settings.azure_openai_api_key:
        try:
            endpoint = settings.azure_openai_endpoint.strip().rstrip("/")
            deployment = (settings.azure_openai_deployment or "").strip()
            url = (
                f"{endpoint}/openai/deployments/{deployment}/chat/completions"
                f"?api-version={settings.azure_openai_api_version}"
            )
            prompt = (
                f"Analyze this exam result for a {session.job_title or 'technical'} role:\n"
                f"Score: {session.score}/{len(questions)} ({analysis['percentage']}%)\n"
                f"Correct topics: {', '.join(correct_topics[:5])}\n"
                f"Incorrect topics: {', '.join([i['question'][:50] for i in incorrect_topics[:5]])}\n\n"
                f"Give a brief 2-3 sentence performance summary and key improvement areas."
            )
            resp = httpx.post(
                url,
                headers={"api-key": settings.azure_openai_api_key, "Content-Type": "application/json"},
                json={"messages": [{"role": "user", "content": prompt}], "max_completion_tokens": 300},
                timeout=30.0,
            )
            if resp.status_code < 400:
                data = resp.json()
                analysis["llm_summary"] = data["choices"][0]["message"]["content"].strip()
        except Exception as exc:
            logger.warning("LLM analysis failed: {}", exc)

    return analysis


# ---------------------------------------------------------------------------
# Voice call helpers (Twilio + ElevenLabs + Azure LLM)
# ---------------------------------------------------------------------------
try:
    from twilio.rest import Client as TwilioClient
    from twilio.twiml.voice_response import VoiceResponse
except Exception:
    TwilioClient = None
    VoiceResponse = None


def _initiate_ai_call(session: ExamSession, assessment_db: Session) -> str | None:
    """Start an AI interview call to the candidate after passing the exam."""
    if TwilioClient is None:
        logger.warning("Twilio not installed, skipping AI call")
        return None

    account_sid = (settings.twilio_account_sid or "").strip()
    auth_token = (settings.twilio_auth_token or "").strip()
    from_number = (settings.twilio_from_number or "").strip()

    if not account_sid or not auth_token or not from_number:
        logger.warning("Twilio not configured, skipping AI call")
        return None

    phone = _lookup_candidate_phone_by_email(session.candidate_email)

    if not phone:
        logger.warning("No phone number found for candidate {}, skipping AI call", session.candidate_email)
        return None

    base_url = _public_call_base_url()
    if not base_url:
        logger.warning("PUBLIC_CALL_BASE_URL not configured, skipping AI call")
        return None

    twiml_url = (
        f"{base_url}/api/interview/twiml"
        f"?session_code={quote_plus(session.session_code)}"
        f"&name={quote_plus(session.candidate_name)}"
        f"&position={quote_plus(session.job_title or 'the role')}"
    )

    try:
        client = TwilioClient(account_sid, auth_token)
        call = client.calls.create(
            to=phone,
            from_=from_number,
            url=twiml_url,
            method="GET",
        )
        call_sid = str(call.sid)
        session.call_sid = call_sid
        session.call_status = "initiated"
        assessment_db.commit()
        _publish_call_status_update(
            session=session,
            status_value="initiated",
            source="ai_interview_call",
            extra={"call_sid": call_sid, "to": phone},
        )
        _publish_assessment_dashboard_counters(assessment_db)
        logger.info("AI interview call initiated: sid={} to={}", call_sid, phone)
        return call_sid
    except Exception as exc:
        logger.warning("Failed to initiate AI call: {}", exc)
        return None


async def _generate_interview_line(*, turn: int, candidate_name: str, position: str, job_title: str, user_speech: str | None) -> str:
    """Generate the next AI interviewer utterance for Technical+HR round."""
    safe_name = (candidate_name or "there").strip() or "there"
    safe_pos = (position or "the role").strip()

    if not settings.use_azure_openai or not settings.azure_openai_endpoint:
        # Fallback
        lines = {
            1: f"Hello {safe_name}, this is the SmartHire AI interviewer. Congratulations on passing the assessment for {safe_pos}. Let me ask you a few technical and HR questions. First, can you tell me about your most challenging technical project?",
            2: f"That's interesting, {safe_name}. Now, can you explain how you handle tight deadlines and work pressure in a team environment?",
            3: f"Good answer. Here's a technical question: Can you walk me through how you would design a scalable API for a high-traffic application?",
            4: f"Nice approach, {safe_name}. What are your salary expectations and when would you be available to join?",
            5: f"Thank you {safe_name} for your time. That concludes our AI interview for {safe_pos}. Our team will review your responses and get back to you. Have a great day!",
        }
        return lines.get(turn, lines[5])

    endpoint = settings.azure_openai_endpoint.strip().rstrip("/")
    deployment = (settings.azure_openai_deployment or "").strip()
    url = (
        f"{endpoint}/openai/deployments/{deployment}/chat/completions"
        f"?api-version={settings.azure_openai_api_version}"
    )

    system = (
        "You are a professional AI interviewer conducting a combined Technical + HR phone interview. "
        "You speak naturally and concisely (2-3 sentences max). "
        "Ask one question at a time. Be warm but professional. "
        "Do not mention being an AI. Output plain text only, no emojis."
    )

    turn_instructions = {
        1: f"Greet {safe_name}, congratulate on passing the assessment for {safe_pos}, and ask about their most challenging technical project.",
        2: f"React to their answer: '{user_speech or 'no response'}'. Then ask an HR question about handling pressure and teamwork.",
        3: f"React to: '{user_speech or 'no response'}'. Ask a technical architecture/design question relevant to {safe_pos}.",
        4: f"React to: '{user_speech or 'no response'}'. Ask about salary expectations and availability to join.",
        5: f"React to: '{user_speech or 'no response'}'. Thank them warmly and say the team will review their responses. End the call.",
    }

    user_prompt = turn_instructions.get(turn, turn_instructions[5])

    try:
        resp = httpx.post(
            url,
            headers={"api-key": settings.azure_openai_api_key, "Content-Type": "application/json"},
            json={
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_prompt},
                ],
                "max_completion_tokens": 150,
            },
            timeout=30.0,
        )
        if resp.status_code < 400:
            data = resp.json()
            text = data["choices"][0]["message"]["content"].strip()
            if text:
                return text[:300]
    except Exception as exc:
        logger.warning("Azure interview line generation failed: {}", exc)

    # Fallback to scripted lines (don't recurse — that would retry Azure and loop)
    lines = {
        1: f"Hello {safe_name}, this is the SmartHire AI interviewer. Congratulations on passing the assessment for {safe_pos}. Let me ask you a few technical and HR questions. First, can you tell me about your most challenging technical project?",
        2: f"That's interesting, {safe_name}. Now, can you explain how you handle tight deadlines and work pressure in a team environment?",
        3: f"Good answer. Here's a technical question: Can you walk me through how you would design a scalable API for a high-traffic application?",
        4: f"Nice approach, {safe_name}. What are your salary expectations and when would you be available to join?",
        5: f"Thank you {safe_name} for your time. That concludes our AI interview for {safe_pos}. Our team will review your responses and get back to you. Have a great day!",
    }
    return lines.get(turn, lines[5])


@app.on_event("startup")
def on_startup() -> None:
    AssessmentBase.metadata.create_all(bind=assessment_engine)
    _ensure_assessment_schema()


def init_assessment() -> None:
    on_startup()


def _ensure_assessment_schema() -> None:
    """Best-effort schema evolution for SQLite.

    This project doesn't use Alembic migrations yet, so we keep the assessment
    service resilient by adding missing columns at startup.
    """

    if assessment_engine.dialect.name != "sqlite":
        return

    def _has_column(conn, table: str, column: str) -> bool:
        rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
        return any(str(row[1]) == column for row in rows)

    with assessment_engine.begin() as conn:
        try:
            if not _has_column(conn, "exam_sessions", "assessment_type"):
                conn.execute(
                    text(
                        "ALTER TABLE exam_sessions "
                        "ADD COLUMN assessment_type VARCHAR(32) NOT NULL DEFAULT 'onscreen'"
                    )
                )
            if not _has_column(conn, "exam_sessions", "proctor_ai_summary"):
                conn.execute(
                    text(
                        "ALTER TABLE exam_sessions "
                        "ADD COLUMN proctor_ai_summary JSON NULL"
                    )
                )
            if not _has_column(conn, "exam_sessions", "proctor_ai_generated_at"):
                conn.execute(
                    text(
                        "ALTER TABLE exam_sessions "
                        "ADD COLUMN proctor_ai_generated_at DATETIME NULL"
                    )
                )
            if not _has_column(conn, "exam_sessions", "government_id_image_base64"):
                conn.execute(
                    text(
                        "ALTER TABLE exam_sessions "
                        "ADD COLUMN government_id_image_base64 TEXT NULL"
                    )
                )
            if not _has_column(conn, "exam_sessions", "live_selfie_image_base64"):
                conn.execute(
                    text(
                        "ALTER TABLE exam_sessions "
                        "ADD COLUMN live_selfie_image_base64 TEXT NULL"
                    )
                )
            if not _has_column(conn, "exam_sessions", "identity_status"):
                conn.execute(
                    text(
                        "ALTER TABLE exam_sessions "
                        "ADD COLUMN identity_status VARCHAR(32) NULL"
                    )
                )
            if not _has_column(conn, "exam_sessions", "identity_submitted_at"):
                conn.execute(
                    text(
                        "ALTER TABLE exam_sessions "
                        "ADD COLUMN identity_submitted_at DATETIME NULL"
                    )
                )
            if not _has_column(conn, "proctor_events", "assessment_type"):
                conn.execute(
                    text(
                        "ALTER TABLE proctor_events "
                        "ADD COLUMN assessment_type VARCHAR(32) NOT NULL DEFAULT 'onscreen'"
                    )
                )
        except Exception as exc:
            logger.warning("Schema migration (best-effort) failed: {}", exc)


def _normalize_assessment_type(value: str | None) -> str:
    raw = (value or "").strip().lower()
    return raw or "onscreen"


def _assessment_type_for_session(*, session_code: str, assessment_db: Session, fallback: str = "onscreen") -> str:
    try:
        row = assessment_db.execute(
            select(ExamSession.assessment_type).where(ExamSession.session_code == session_code)
        ).first()
        if row and row[0]:
            return _normalize_assessment_type(str(row[0]))
    except Exception:
        pass
    return _normalize_assessment_type(fallback)


def _latest_session_event(
    *,
    assessment_db: Session,
    session_code: str,
    event_type: str,
    assessment_type: str = "onscreen",
) -> ProctorEvent | None:
    return (
        assessment_db.execute(
            select(ProctorEvent)
            .where(
                ProctorEvent.session_code == session_code,
                ProctorEvent.assessment_type == assessment_type,
                ProctorEvent.event_type == event_type,
            )
            .order_by(ProctorEvent.created_at.desc(), ProctorEvent.id.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )


def _anti_cheat_requirements() -> dict:
    return {
        "requires_fullscreen": True,
        "requires_face_verification": True,
        "blocks_high_risk_environment": True,
        "supports_secondary_camera": True,
    }


def _lookup_candidate_phone_by_email(candidate_email: str) -> str | None:
    email = (candidate_email or "").strip().lower()
    if not email:
        return None

    try:
        from .db import JobsSessionLocal
        if JobsSessionLocal is None:
            return None

        jobs_db = JobsSessionLocal()
        try:
            row = jobs_db.execute(
                text("SELECT phone_number FROM candidates WHERE LOWER(email) = :email LIMIT 1"),
                {"email": email},
            ).first()
            if row and row[0]:
                return str(row[0]).strip()
        finally:
            jobs_db.close()
    except Exception as exc:
        logger.warning("Could not look up phone for {}: {}", candidate_email, exc)

    return None


def _append_call_log(session: ExamSession, entry: dict) -> None:
    logs = list(session.call_responses or [])
    logs.append(_json_safe(entry))
    session.call_responses = logs


def _public_call_base_url() -> str:
    return str(settings.effective_public_call_base_url or "").strip().rstrip("/")


def _build_exam_link(session_code: str) -> str:
    base = (settings.exam_portal_base_url or "").strip() or "http://localhost:5173/assessment"
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}code={quote_plus(session_code)}"


def _require_assessment_admin_from_token(token: str) -> dict:
    payload = decode_core_token(str(token or "").strip())
    if not payload or not payload.get("user_id"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    if JobsSessionLocal is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Jobs database is unavailable")

    db = JobsSessionLocal()
    try:
        row = db.execute(
            text(
                "SELECT id, email, COALESCE(role, 'candidate') AS role, "
                "COALESCE(is_active, TRUE) AS is_active "
                "FROM users WHERE id = :user_id LIMIT 1"
            ),
            {"user_id": int(payload["user_id"])},
        ).mappings().first()
    finally:
        db.close()

    if not row or not bool(row.get("is_active", True)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if str(row.get("role") or "candidate").lower() != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return dict(row)


def _assessment_dashboard_counters_snapshot(assessment_db: Session) -> dict:
    total_exams = int(assessment_db.scalar(select(func.count(ExamSession.id))) or 0)
    total_submitted = int(
        assessment_db.scalar(select(func.count(ExamSession.id)).where(ExamSession.status == "submitted")) or 0
    )
    total_passed = int(assessment_db.scalar(select(func.count(ExamSession.id)).where(ExamSession.passed == 1)) or 0)
    total_failed = int(
        assessment_db.scalar(
            select(func.count(ExamSession.id)).where(
                ExamSession.status == "submitted",
                ExamSession.passed == 0,
            )
        )
        or 0
    )
    active_exams = int(
        assessment_db.scalar(
            select(func.count(ExamSession.id)).where(ExamSession.status.in_(["created", "in_progress"]))
        )
        or 0
    )
    pending_reviews = int(
        assessment_db.scalar(
            select(func.count(ExamSession.id)).where(
                ExamSession.status == "submitted",
                (
                    ExamSession.call_status.is_(None)
                    | (~ExamSession.call_status.in_(["completed", "cancelled"]))
                ),
            )
        )
        or 0
    )
    start_of_day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    interviews_today = int(
        assessment_db.scalar(
            select(func.count(ProctorEvent.id)).where(
                ProctorEvent.assessment_type == "call_interview",
                ProctorEvent.event_type.in_(
                    [
                        "call_interview_email_scheduled",
                        "call_interview_call_initiated",
                        "call_interview_call_status",
                        "call_interview_completed",
                    ]
                ),
                ProctorEvent.created_at >= start_of_day,
            )
        )
        or 0
    )
    avg_score = assessment_db.scalar(
        select(func.avg(ExamSession.percentage)).where(ExamSession.status == "submitted")
    )
    avg_score = round(float(avg_score), 1) if avg_score is not None else 0.0
    high_risk_events = int(
        assessment_db.scalar(
            select(func.count(ProctorEvent.id)).where(
                ProctorEvent.assessment_type == "onscreen",
                ProctorEvent.severity == "high",
            )
        )
        or 0
    )
    sessions_with_high_risk_signals = int(
        assessment_db.scalar(
            select(func.count(func.distinct(ProctorEvent.session_code))).where(
                ProctorEvent.assessment_type == "onscreen",
                ProctorEvent.severity == "high",
            )
        )
        or 0
    )
    verified_identity_sessions = int(
        assessment_db.scalar(
            select(func.count(ExamSession.id)).where(ExamSession.identity_status == "completed")
        )
        or 0
    )
    pending_identity_sessions = max(0, total_exams - verified_identity_sessions)
    identity_reupload_required = int(
        assessment_db.scalar(
            select(func.count(ProctorEvent.id)).where(
                ProctorEvent.assessment_type == "onscreen",
                ProctorEvent.event_type == "face_id_verification",
                ProctorEvent.severity.in_(["medium", "high"]),
            )
        )
        or 0
    )

    return {
        "total_exams": total_exams,
        "total_submitted": total_submitted,
        "total_passed": total_passed,
        "total_failed": total_failed,
        "avg_score": avg_score,
        "active_exams": active_exams,
        "pending_reviews": pending_reviews,
        "interviews_today": interviews_today,
        "security_stats": {
            "high_risk_events": high_risk_events,
            "sessions_with_high_risk_signals": sessions_with_high_risk_signals,
            "verified_identity_sessions": verified_identity_sessions,
            "pending_identity_sessions": pending_identity_sessions,
            "identity_reupload_required": identity_reupload_required,
        },
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _publish_assessment_dashboard_counters(assessment_db: Session) -> None:
    try:
        snapshot = _assessment_dashboard_counters_snapshot(assessment_db)
        publish_assessment_realtime_event("dashboard_counters_updated", snapshot)
    except Exception as exc:
        logger.debug("Could not publish assessment dashboard counters: {}", exc)


def _publish_exam_status_update(*, session: ExamSession, source: str = "assessment_api") -> None:
    publish_assessment_realtime_event(
        "exam_status_updated",
        {
            "session_code": session.session_code,
            "candidate_name": session.candidate_name,
            "candidate_email": session.candidate_email,
            "job_title": session.job_title,
            "status": session.status,
            "score": session.score,
            "total": session.total_questions,
            "percentage": (round(float(session.percentage), 1) if session.percentage is not None else None),
            "passed": (bool(session.passed) if session.passed is not None else None),
            "email_sent": session.email_sent,
            "call_status": session.call_status,
            "identity_status": getattr(session, "identity_status", None),
            "identity_submitted_at": (
                session.identity_submitted_at.isoformat()
                if getattr(session, "identity_submitted_at", None) is not None
                else None
            ),
            "source": source,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )


def _publish_call_status_update(
    *,
    session: ExamSession,
    status_value: str | None = None,
    source: str = "assessment_api",
    extra: dict | None = None,
) -> None:
    payload = {
        "session_code": session.session_code,
        "candidate_name": session.candidate_name,
        "candidate_email": session.candidate_email,
        "job_title": session.job_title,
        "call_sid": session.call_sid,
        "call_status": str(status_value or session.call_status or "").strip().lower() or None,
        "source": source,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if extra:
        payload.update(_json_safe(extra))
    publish_assessment_realtime_event("call_status_updated", payload)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/realtime/stream")
async def assessment_realtime_stream(
    request: Request,
    token: str = Query(..., min_length=8),
    session_code: str | None = Query(default=None),
    event_types: str | None = Query(default=None),
) -> StreamingResponse:
    _require_assessment_admin_from_token(token)
    code_filter = str(session_code or "").strip().upper()
    allowed_types = {
        part.strip()
        for part in str(event_types or "").split(",")
        if part.strip()
    }

    async def _event_generator():
        try:
            last_event_id = int(request.headers.get("last-event-id") or 0)
        except Exception:
            last_event_id = 0
        heartbeat_at = time.monotonic() + 15.0
        yield "retry: 3000\n\n"
        while True:
            emitted = False
            for event in get_assessment_realtime_events_after(last_event_id):
                last_event_id = max(last_event_id, int(event.get("id", 0)))
                event_type = str(event.get("type") or "event")
                if allowed_types and event_type not in allowed_types:
                    continue
                payload = event.get("payload") or {}
                if code_filter:
                    event_code = str(payload.get("session_code") or "").strip().upper()
                    if event_code and event_code != code_filter:
                        continue
                yield (
                    f"id: {int(event.get('id', 0))}\n"
                    f"event: {event_type}\n"
                    f"data: {json.dumps(payload, default=str)}\n\n"
                )
                emitted = True
            now = time.monotonic()
            if not emitted and now >= heartbeat_at:
                heartbeat_at = now + 15.0
                yield ": keepalive\n\n"
            await asyncio.sleep(0.75)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/assessment/stats")
def assessment_stats(
    assessment_db: Session = Depends(get_assessment_db),
    _admin: dict = Depends(get_current_assessment_admin),
) -> dict:
    """Aggregated assessment statistics for the admin dashboard."""
    counters = _assessment_dashboard_counters_snapshot(assessment_db)

    # recent exam sessions with scores
    recent_rows = assessment_db.execute(
        select(
            ExamSession.session_code,
            ExamSession.candidate_name,
            ExamSession.candidate_email,
            ExamSession.job_title,
            ExamSession.score,
            ExamSession.total_questions,
            ExamSession.percentage,
            ExamSession.passed,
            ExamSession.status,
            ExamSession.email_sent,
            ExamSession.call_status,
            ExamSession.identity_status,
            ExamSession.identity_submitted_at,
            ExamSession.submitted_at,
            ExamSession.created_at,
        )
        .order_by(ExamSession.created_at.desc())
        .limit(200)
    ).all()

    recent_exams = [
        {
            "session_code": r.session_code,
            "candidate_name": r.candidate_name,
            "candidate_email": r.candidate_email,
            "job_title": r.job_title,
            "score": r.score,
            "total": r.total_questions,
            "percentage": round(float(r.percentage), 1) if r.percentage is not None else None,
            "passed": bool(r.passed) if r.passed is not None else None,
            "status": r.status,
            "email_sent": r.email_sent,
            "call_status": r.call_status,
            "identity_status": r.identity_status,
            "identity_submitted_at": r.identity_submitted_at.isoformat() if r.identity_submitted_at else None,
            "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in recent_rows
    ]

    return {
        "total_exams": counters["total_exams"],
        "total_submitted": counters["total_submitted"],
        "total_passed": counters["total_passed"],
        "total_failed": counters["total_failed"],
        "avg_score": counters["avg_score"],
        "active_exams": counters["active_exams"],
        "pending_reviews": counters["pending_reviews"],
        "interviews_today": counters["interviews_today"],
        "security_stats": counters.get("security_stats") or {},
        "updated_at": counters["updated_at"],
        "recent_exams": recent_exams,
    }


@app.get("/api/jobs", response_model=list[JobOut])
def list_jobs(db: Session = Depends(get_jobs_db)) -> list[Job]:
    result = db.execute(select(Job).order_by(Job.id.desc()).limit(100))
    return list(result.scalars().all())


@app.post("/api/exams/create", response_model=ExamCreateResponse)
def create_exam(
    payload: ExamCreateRequest,
    jobs_db: Session | None = Depends(get_optional_jobs_db),
    assessment_db: Session = Depends(get_assessment_db),
) -> ExamCreateResponse:
    job_id = int(payload.job_id) if payload.job_id is not None else 0

    job_data: dict
    job: Job | None = None
    if jobs_db is not None and payload.job_id is not None:
        job = jobs_db.get(Job, payload.job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        job_data = {
            "id": job.id,
            "title": job.title,
            "description": job.description,
            "skills_required": job.skills_required,
            "additional_skills": job.additional_skills,
        }
        job_id = job.id
    else:
        title = (payload.job_title or "").strip()
        description = (payload.job_description or "").strip()
        if not title or not description:
            raise HTTPException(
                status_code=400,
                detail="Provide job_title and job_description when JOBS_DATABASE_URL is not configured",
            )
        job_data = {
            "id": job_id,
            "title": title,
            "description": description,
            "skills_required": payload.skills_required,
            "additional_skills": payload.additional_skills,
        }

    # Default to 10 hard questions
    question_count = payload.question_count or 10
    difficulty = payload.difficulty or "hard"

    question_generation_mode = (getattr(payload, "question_generation_mode", "auto") or "auto").strip().lower()
    gen_started = time.perf_counter()
    generated = generate_questions(
        job_data,
        question_count,
        difficulty,
        payload.resume_skills,
        generation_mode=question_generation_mode,
    )
    logger.info(
        "Exam questions generated: session_candidate_email={} mode={} count={} duration_ms={}",
        payload.candidate_email,
        question_generation_mode,
        len(generated),
        int((time.perf_counter() - gen_started) * 1000),
    )

    assessment_type = _normalize_assessment_type(getattr(payload, "assessment_type", None))

    session_code = f"EXAM-{uuid4().hex[:10].upper()}"
    job_title = job_data.get("title", "")
    session = ExamSession(
        session_code=session_code,
        job_id=job_id,
        candidate_name=payload.candidate_name,
        candidate_email=payload.candidate_email,
        assessment_type=assessment_type,
        duration_minutes=payload.duration_minutes,
        status="created",
        questions_json=generated,
        total_questions=len(generated),
        job_title=job_title,
        resume_skills=payload.resume_skills,
        identity_status="pending",
    )
    assessment_db.add(session)

    assessment_db.add(
        ProctorEvent(
            session_code=session_code,
            assessment_type=assessment_type,
            event_type="exam_created",
            severity="low",
            payload={"job_title": job_title, "duration_minutes": payload.duration_minutes},
        )
    )
    assessment_db.commit()
    _publish_exam_status_update(session=session, source="exam_created")
    _publish_assessment_dashboard_counters(assessment_db)
    try:
        _update_jobs_progress(
            jobs_db=jobs_db,
            session=session,
            action="assessment_created",
            stage="assessment_sent",
            details={"session_code": session_code, "job_title": job_title},
        )
    except Exception as exc:
        logger.warning("Failed to sync assessment creation for {}: {}", session_code, exc)

    return ExamCreateResponse(
        session_code=session_code,
        exam_link=_build_exam_link(session_code),
        duration_minutes=payload.duration_minutes,
        questions=[ExamQuestion(id=q["id"], question=q["question"], options=q["options"]) for q in generated],
    )


@app.post("/api/exams/access", response_model=ExamDetailsResponse)
def access_exam(payload: ExamAccessRequest, assessment_db: Session = Depends(get_assessment_db)) -> ExamDetailsResponse:
    session = assessment_db.execute(select(ExamSession).where(ExamSession.session_code == payload.session_code)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    return ExamDetailsResponse(
        session_code=session.session_code,
        candidate_name=session.candidate_name,
        duration_minutes=session.duration_minutes,
        assessment_type=_normalize_assessment_type(getattr(session, "assessment_type", None)),
        status=session.status,
        started_at=session.started_at,
        anti_cheat=_anti_cheat_requirements(),
        questions=[ExamQuestion(id=q["id"], question=q["question"], options=q["options"]) for q in session.questions_json],
    )


@app.post("/api/exams/{session_code}/begin", response_model=ExamBeginResponse)
def begin_exam(
    session_code: str,
    assessment_db: Session = Depends(get_assessment_db),
    jobs_db: Session | None = Depends(get_optional_jobs_db),
) -> ExamBeginResponse:
    session = assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    if session.status == "submitted":
        raise HTTPException(status_code=400, detail="Exam has already been submitted")
    if session.status == "rejected":
        raise HTTPException(status_code=400, detail="Exam session is no longer active")

    assessment_type = _normalize_assessment_type(getattr(session, "assessment_type", None))
    identity_uploaded = bool(
        str(getattr(session, "government_id_image_base64", "") or "").strip()
        and str(getattr(session, "live_selfie_image_base64", "") or "").strip()
    )
    if not identity_uploaded:
        # Backward compatibility for older sessions where only event payload exists.
        face_event = _latest_session_event(
            assessment_db=assessment_db,
            session_code=session_code,
            event_type="face_id_verification",
            assessment_type=assessment_type,
        )
        identity_uploaded = bool(
            face_event
            and isinstance(face_event.payload, dict)
            and bool(face_event.payload.get("verified"))
        )
    if not identity_uploaded:
        raise HTTPException(
            status_code=400,
            detail="Government ID upload and live selfie capture are required before starting the exam",
        )

    env_event = _latest_session_event(
        assessment_db=assessment_db,
        session_code=session_code,
        event_type="env_check",
        assessment_type=assessment_type,
    )
    env_risk_score = None
    env_severity = "low"
    if env_event and isinstance(env_event.payload, dict):
        env_risk_score = env_event.payload.get("risk_score")
        env_severity = str(env_event.severity or env_event.payload.get("severity") or "low").lower()
    if env_event and env_severity == "high":
        raise HTTPException(
            status_code=400,
            detail=(
                "This environment was flagged as high risk for proctored assessment use. "
                "Close virtual machines, remote-desktop tools, or suspicious extensions and try again."
            ),
        )

    if session.status == "created":
        session.status = "in_progress"
    if session.started_at is None:
        session.started_at = datetime.now(timezone.utc)

    assessment_db.add(
        ProctorEvent(
            session_code=session.session_code,
            assessment_type=assessment_type,
            event_type="exam_started",
            severity="low",
            payload={"env_risk_score": env_risk_score},
        )
    )
    assessment_db.commit()
    _publish_exam_status_update(session=session, source="exam_started")
    _publish_assessment_dashboard_counters(assessment_db)
    try:
        _update_jobs_progress(
            jobs_db=jobs_db,
            session=session,
            action="assessment_started",
            stage="assessment_in_progress",
            details={"session_code": session.session_code},
        )
    except Exception as exc:
        logger.warning("Failed to sync assessment start for {}: {}", session.session_code, exc)

    return ExamBeginResponse(
        session_code=session.session_code,
        status=session.status,
        started_at=session.started_at,
    )


@app.post("/api/exams/{session_code}/submit", response_model=ExamSubmitResponse)
def submit_exam(
    session_code: str,
    payload: ExamSubmitRequest,
    background: BackgroundTasks,
    assessment_db: Session = Depends(get_assessment_db),
    jobs_db: Session | None = Depends(get_optional_jobs_db),
) -> ExamSubmitResponse:
    session = assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    answer_lookup = {item.get("question_id"): item.get("answer") for item in payload.answers}
    total = len(session.questions_json)
    score = 0
    for question in session.questions_json:
        if answer_lookup.get(question["id"]) == question.get("answer"):
            score += 1

    percentage = round((score / max(total, 1)) * 100, 1)
    passed = percentage >= 60

    session.answers_json = payload.answers
    session.score = score
    session.total_questions = total
    session.percentage = percentage
    session.passed = 1 if passed else 0
    session.status = "submitted"
    session.submitted_at = datetime.now(timezone.utc)

    # Generate result analysis
    analysis = _generate_result_analysis(session)
    session.result_analysis = analysis

    assessment_db.commit()
    _publish_exam_status_update(session=session, source="exam_submitted")
    _publish_assessment_dashboard_counters(assessment_db)
    try:
        _update_jobs_progress(
            jobs_db=jobs_db,
            session=session,
            action="assessment_scored",
            stage=("assessment_passed" if passed else "assessment_failed"),
            details={"score": score, "percentage": percentage, "passed": passed},
        )
    except Exception as exc:
        logger.warning("Failed to sync assessment result for {}: {}", session_code, exc)

    try:
        assessment_db.add(
            ProctorEvent(
                session_code=session_code,
                assessment_type=_normalize_assessment_type(getattr(session, "assessment_type", None)),
                event_type="exam_scored",
                severity="low",
                payload={
                    "score": score,
                    "total": total,
                    "percentage": percentage,
                    "passed": passed,
                },
            )
        )
        assessment_db.commit()
    except Exception:
        pass

    # Send result email in background
    def _background_post_exam(sc: str):
        db = assessment_db
        try:
            sess = db.execute(select(ExamSession).where(ExamSession.session_code == sc)).scalar_one_or_none()
            if not sess:
                return

            email_type = _send_result_email(sess)
            sess.email_sent = email_type
            db.commit()
            publish_assessment_realtime_event(
                "exam_email_result_updated",
                {
                    "session_code": sess.session_code,
                    "candidate_email": sess.candidate_email,
                    "email_sent": email_type,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            _publish_exam_status_update(session=sess, source="result_email")
            _publish_assessment_dashboard_counters(db)
        except Exception as exc:
            logger.warning("Background post-exam task failed for {}: {}", sc, exc)

    background.add_task(_background_post_exam, session_code)

    # Log proctor report
    try:
        events = (
            assessment_db.execute(
                select(ProctorEvent)
                .where(ProctorEvent.session_code == session_code)
                .order_by(ProctorEvent.created_at.asc())
            )
            .scalars()
            .all()
        )

        severity_count = {"low": 0, "medium": 0, "high": 0}
        for event in events:
            if event.severity in severity_count:
                severity_count[event.severity] += 1

        logger.info(
            "ASSESSMENT PROCTOR REPORT session_code={} total_events={} severity={} score={}/{} percentage={}% passed={}",
            session_code,
            len(events),
            severity_count,
            score,
            total,
            percentage,
            passed,
        )

        for event in events[-25:]:
            logger.info(
                "PROCTOR_EVENT {} {} {} payload={}",
                event.created_at,
                event.severity,
                event.event_type,
                event.payload,
            )
    except Exception as exc:
        logger.warning("Failed to build proctor report for {}: {}", session_code, exc)

    # Free in-memory proctoring state for this session
    try:
        cleanup_session_state(session_code)
    except Exception:
        pass

    return ExamSubmitResponse(
        score=score,
        total=total,
        percentage=percentage,
        passed=passed,
        status=session.status,
        result_analysis=analysis,
    )


@app.get("/api/exams/{session_code}/result", response_model=ExamResultResponse)
def get_exam_result(session_code: str, assessment_db: Session = Depends(get_assessment_db)) -> ExamResultResponse:
    """Get full exam result with analysis, email status, and call info."""
    session = assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    return ExamResultResponse(
        session_code=session.session_code,
        candidate_name=session.candidate_name,
        candidate_email=session.candidate_email,
        job_title=session.job_title,
        score=session.score or 0,
        total=session.total_questions or len(session.questions_json),
        percentage=session.percentage or 0.0,
        passed=bool(session.passed),
        status=session.status,
        result_analysis=session.result_analysis,
        email_sent=session.email_sent,
        call_sid=session.call_sid,
        call_status=session.call_status,
        call_responses=session.call_responses,
        submitted_at=session.submitted_at,
    )


@app.get("/api/exams/mine", response_model=list[CandidateExamSessionOut])
def candidate_list_my_exams(
    assessment_type: str | None = None,
    status_filter: str | None = None,
    limit: int = 50,
    offset: int = 0,
    assessment_db: Session = Depends(get_assessment_db),
    current_user: dict = Depends(get_current_assessment_user),
) -> list[dict]:
    user_email = str(current_user.get("email") or "").strip().lower()
    if not user_email:
        raise HTTPException(status_code=401, detail="User email not found in token context")

    atype = _normalize_assessment_type(assessment_type) if assessment_type else None
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    normalized_status = str(status_filter or "").strip().lower()

    stmt = select(ExamSession).where(func.lower(ExamSession.candidate_email) == user_email)
    if atype:
        stmt = stmt.where(ExamSession.assessment_type == atype)
    if normalized_status:
        stmt = stmt.where(func.lower(ExamSession.status) == normalized_status)
    stmt = stmt.order_by(ExamSession.created_at.desc()).offset(offset).limit(limit)

    sessions = assessment_db.execute(stmt).scalars().all()
    return [
        {
            "session_code": s.session_code,
            "assessment_type": _normalize_assessment_type(getattr(s, "assessment_type", None)),
            "candidate_name": s.candidate_name,
            "candidate_email": s.candidate_email,
            "job_title": s.job_title,
            "status": s.status,
            "score": s.score,
            "total": s.total_questions,
            "percentage": s.percentage,
            "passed": bool(s.passed) if s.passed is not None else None,
            "started_at": s.started_at,
            "submitted_at": s.submitted_at,
            "created_at": s.created_at,
            "call_status": s.call_status,
            "identity_status": getattr(s, "identity_status", None),
        }
        for s in sessions
    ]


@app.get("/api/admin/exams", response_model=list[AdminExamSessionOut])
def admin_list_exams(
    assessment_type: str | None = None,
    candidate_email: str | None = None,
    limit: int = 50,
    offset: int = 0,
    assessment_db: Session = Depends(get_assessment_db),
    _admin: dict = Depends(get_current_assessment_admin),
) -> list[dict]:
    atype = _normalize_assessment_type(assessment_type) if assessment_type else None
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))

    stmt = select(ExamSession)
    if atype:
        stmt = stmt.where(ExamSession.assessment_type == atype)
    if candidate_email:
        stmt = stmt.where(func.lower(ExamSession.candidate_email) == candidate_email.strip().lower())
    stmt = stmt.order_by(ExamSession.created_at.desc()).offset(offset).limit(limit)

    sessions = assessment_db.execute(stmt).scalars().all()
    results: list[dict] = []
    for s in sessions:
        results.append(
            {
                "session_code": s.session_code,
                "assessment_type": _normalize_assessment_type(getattr(s, "assessment_type", None)),
                "candidate_name": s.candidate_name,
                "candidate_email": s.candidate_email,
                "job_title": s.job_title,
                "status": s.status,
                "score": s.score,
                "total": s.total_questions,
                "percentage": s.percentage,
                "passed": bool(s.passed) if s.passed is not None else None,
                "started_at": s.started_at,
                "submitted_at": s.submitted_at,
                "created_at": s.created_at,
            }
        )
    return results


@app.get("/api/admin/exams/{session_code}", response_model=AdminExamDetailOut)
def admin_exam_detail(
    session_code: str,
    assessment_type: str | None = None,
    limit_events: int = 300,
    assessment_db: Session = Depends(get_assessment_db),
    jobs_db: Session | None = Depends(get_optional_jobs_db),
    _admin: dict = Depends(get_current_assessment_admin),
) -> dict:
    session = (
        assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code))
        .scalars()
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    atype = _normalize_assessment_type(assessment_type or getattr(session, "assessment_type", None))
    limit_events = max(1, min(int(limit_events), 2000))

    events = (
        assessment_db.execute(
            select(ProctorEvent)
            .where(ProctorEvent.session_code == session_code, ProctorEvent.assessment_type == atype)
            .order_by(ProctorEvent.created_at.desc())
            .limit(limit_events)
        )
        .scalars()
        .all()
    )
    events = list(reversed(events))

    call_events = (
        assessment_db.execute(
            select(ProctorEvent)
            .where(ProctorEvent.session_code == session_code, ProctorEvent.assessment_type == "call_interview")
            .order_by(ProctorEvent.created_at.desc())
            .limit(limit_events)
        )
        .scalars()
        .all()
    )
    call_events = list(reversed(call_events))

    severity_count = {"low": 0, "medium": 0, "high": 0}
    for event in events:
        if event.severity in severity_count:
            severity_count[event.severity] += 1

    green_signals, red_signals = _build_proctor_insights(events=events)

    # Cached AI summary (generate once if missing)
    ai_summary = getattr(session, "proctor_ai_summary", None)
    if not ai_summary:
        ai_summary = _generate_ai_proctor_summary(
            session=session,
            severity=severity_count,
            green=green_signals,
            red=red_signals,
        )
        try:
            session.proctor_ai_summary = ai_summary
            session.proctor_ai_generated_at = datetime.now(timezone.utc)
            assessment_db.commit()
        except Exception as exc:
            try:
                assessment_db.rollback()
            except Exception:
                pass
            logger.warning("Failed to persist proctor AI summary for {}: {}", session_code, exc)

    progress = _get_jobs_progress(
        jobs_db=jobs_db,
        job_id=getattr(session, "job_id", None),
        candidate_email=getattr(session, "candidate_email", None),
    )

    return {
        "session_code": session.session_code,
        "assessment_type": atype,
        "job_id": session.job_id,
        "candidate_name": session.candidate_name,
        "candidate_email": session.candidate_email,
        "job_title": session.job_title,
        "status": session.status,
        "duration_minutes": session.duration_minutes,
        "score": session.score,
        "total": session.total_questions,
        "percentage": session.percentage,
        "passed": bool(session.passed) if session.passed is not None else None,
        "started_at": session.started_at,
        "submitted_at": session.submitted_at,
        "created_at": session.created_at,
        "questions_json": session.questions_json,
        "answers_json": session.answers_json,
        "result_analysis": session.result_analysis,
        "severity": severity_count,
        "green_signals": green_signals,
        "red_signals": red_signals,
        "ai_summary": ai_summary,
        "call_sid": session.call_sid,
        "call_status": session.call_status,
        "identity_status": getattr(session, "identity_status", None),
        "identity_submitted_at": getattr(session, "identity_submitted_at", None),
        "government_id_image_base64": getattr(session, "government_id_image_base64", None),
        "live_selfie_image_base64": getattr(session, "live_selfie_image_base64", None),
        "pipeline_stage": (progress.stage if progress else None),
        "recruiter_notes": (progress.recruiter_notes if progress else None),
        "manual_assessment_score": (progress.manual_assessment_score if progress else None),
        "interview_scheduled_for": (progress.interview_scheduled_for if progress else None),
        "interview_status": (progress.interview_status if progress else None),
        "decision_history": (progress.decision_history or [] if progress else []),
        "call_interview_logs": [
            {
                "source": "assessment_backend",
                "type": "transcript_turn",
                "timestamp": item.get("timestamp"),
                "payload": item,
            }
            for item in (session.call_responses or [])
        ] + [
            {
                "source": "main_backend",
                "type": event.event_type,
                "severity": event.severity,
                "timestamp": event.created_at,
                "payload": event.payload,
            }
            for event in call_events
        ],
        "events": [
            {
                "assessment_type": _normalize_assessment_type(getattr(event, "assessment_type", None)),
                "event_type": event.event_type,
                "severity": event.severity,
                "payload": event.payload,
                "created_at": event.created_at,
            }
            for event in events
        ],
    }


def _send_call_schedule_email(*, session: ExamSession, delay_seconds: int) -> None:
    name = (session.candidate_name or "Candidate").strip()
    role = (session.job_title or "the role").strip()
    minutes = max(1, int(max(0, delay_seconds) // 60))
    subject = f"SmartHire Interview Call Scheduled - {name}"
    body = (
        f"Hi {name},\n\n"
        f"Your call interview for {role} has been scheduled.\n"
        f"You can expect an automated call in about {minutes} minute(s).\n\n"
        f"Please keep your phone nearby and ensure your network is stable.\n\n"
        f"Best regards,\nSmartHire HR Team\n"
    )
    _send_email(to_email=session.candidate_email, subject=subject, body=body)


def _schedule_interview_call_background(*, session_code: str, delay_seconds: int, auth_token: str | None = None) -> None:
    from .db import AssessmentSessionLocal

    db = AssessmentSessionLocal()
    jobs_db = JobsSessionLocal() if JobsSessionLocal is not None else None
    try:
        session = db.execute(select(ExamSession).where(ExamSession.session_code == session_code)).scalar_one_or_none()
        if not session:
            return

        time.sleep(max(0, int(delay_seconds)))

        phone = _lookup_candidate_phone_by_email(session.candidate_email)
        if not phone:
            session.call_status = "failed_no_phone"
            _append_call_log(
                session,
                {
                    "source": "scheduler",
                    "status": "failed_no_phone",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "message": "No phone number found for candidate email",
                },
            )
            db.add(
                ProctorEvent(
                    session_code=session_code,
                    assessment_type="call_interview",
                    event_type="call_interview_failed_no_phone",
                    severity="high",
                    payload={"candidate_email": session.candidate_email},
                )
            )
            db.commit()
            _publish_call_status_update(
                session=session,
                status_value="failed_no_phone",
                source="call_scheduler",
                extra={"reason": "no_phone"},
            )
            _publish_assessment_dashboard_counters(db)
            try:
                _update_jobs_progress(
                    jobs_db=jobs_db,
                    session=session,
                    action="interview_call_failed",
                    interview_status="failed_no_phone",
                    details={"reason": "no_phone"},
                )
            except Exception as exc:
                logger.warning("Failed to sync failed_no_phone for {}: {}", session_code, exc)
            return

        main_base = (settings.main_backend_base_url or "http://127.0.0.1:8000").strip().rstrip("/")
        url = f"{main_base}/api/calls/voice/demo"
        req_payload = {
            "phone_number": phone,
            "position": session.job_title or "the role",
            "candidate_name": session.candidate_name,
            "session_code": session.session_code,
            "candidate_email": session.candidate_email,
        }

        try:
            headers = {}
            if auth_token:
                headers["Authorization"] = f"Bearer {auth_token}"
            resp = httpx.post(url, json=req_payload, headers=headers, timeout=25.0)
            if resp.status_code >= 400:
                session.call_status = "failed"
                _append_call_log(
                    session,
                    {
                        "source": "main_backend",
                        "status": "failed",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "http_status": resp.status_code,
                        "response": (resp.text or "")[:1200],
                    },
                )
                db.add(
                    ProctorEvent(
                        session_code=session_code,
                        assessment_type="call_interview",
                        event_type="call_interview_call_failed",
                        severity="high",
                        payload={"status_code": resp.status_code, "response": (resp.text or "")[:300]},
                    )
                )
                db.commit()
                _publish_call_status_update(
                    session=session,
                    status_value="failed",
                    source="call_scheduler",
                    extra={"status_code": resp.status_code},
                )
                _publish_assessment_dashboard_counters(db)
                try:
                    _update_jobs_progress(
                        jobs_db=jobs_db,
                        session=session,
                        action="interview_call_failed",
                        interview_status="failed",
                        details={"status_code": resp.status_code},
                    )
                except Exception as exc:
                    logger.warning("Failed to sync failed interview call for {}: {}", session_code, exc)
                return

            call_data = resp.json() if "application/json" in (resp.headers.get("content-type") or "") else {}
            call_sid = str(call_data.get("call_sid") or "")
            session.call_sid = call_sid or session.call_sid
            session.call_status = str(call_data.get("status") or "initiated")
            _append_call_log(
                session,
                {
                    "source": "main_backend",
                    "status": "initiated",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "payload": _json_safe(call_data),
                },
            )
            db.add(
                ProctorEvent(
                    session_code=session_code,
                    assessment_type="call_interview",
                    event_type="call_interview_call_initiated",
                    severity="low",
                    payload={"call_sid": call_sid, "phone": phone, "status": call_data.get("status")},
                )
            )
            db.commit()
            _publish_call_status_update(
                session=session,
                status_value=str(call_data.get("status") or "initiated"),
                source="call_scheduler",
                extra={"call_sid": call_sid, "phone": phone},
            )
            _publish_assessment_dashboard_counters(db)
            try:
                _update_jobs_progress(
                    jobs_db=jobs_db,
                    session=session,
                    action="interview_call_initiated",
                    interview_status="initiated",
                    details={"call_sid": call_sid},
                )
            except Exception as exc:
                logger.warning("Failed to sync initiated interview call for {}: {}", session_code, exc)
        except Exception as exc:
            session.call_status = "failed"
            _append_call_log(
                session,
                {
                    "source": "scheduler",
                    "status": "failed",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "message": str(exc),
                },
            )
            db.add(
                ProctorEvent(
                    session_code=session_code,
                    assessment_type="call_interview",
                    event_type="call_interview_call_exception",
                    severity="high",
                    payload={"error": str(exc)},
                )
            )
            db.commit()
            _publish_call_status_update(
                session=session,
                status_value="failed",
                source="call_scheduler",
                extra={"error": str(exc)},
            )
            _publish_assessment_dashboard_counters(db)
            try:
                _update_jobs_progress(
                    jobs_db=jobs_db,
                    session=session,
                    action="interview_call_failed",
                    interview_status="failed",
                    details={"error": str(exc)},
                )
            except Exception as inner_exc:
                logger.warning("Failed to sync interview call exception for {}: {}", session_code, inner_exc)
    finally:
        if jobs_db is not None:
            jobs_db.close()
        db.close()


@app.post("/api/admin/exams/{session_code}/schedule-call", response_model=AdminActionResponse)
def admin_schedule_call_interview(
    session_code: str,
    payload: AdminScheduleCallRequest,
    background: BackgroundTasks,
    assessment_db: Session = Depends(get_assessment_db),
    jobs_db: Session | None = Depends(get_optional_jobs_db),
    _admin: dict = Depends(get_current_assessment_admin),
) -> dict:
    session = (
        assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code))
        .scalars()
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    pct = float(session.percentage or 0.0)
    if pct < float(payload.threshold_percentage):
        raise HTTPException(
            status_code=400,
            detail=f"Candidate score {pct:.1f}% is below threshold {payload.threshold_percentage:.1f}%",
        )

    if str(session.status or "").lower() == "rejected":
        raise HTTPException(status_code=400, detail="Candidate has already been rejected")

    scheduled_for = payload.scheduled_for
    delay_seconds = int(payload.delay_seconds)
    if scheduled_for is not None:
        target = scheduled_for
        if target.tzinfo is None:
            target = target.replace(tzinfo=timezone.utc)
        delay_seconds = max(15, int((target - datetime.now(timezone.utc)).total_seconds()))
        scheduled_for = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)
    else:
        scheduled_for = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)

    try:
        _send_call_schedule_email(session=session, delay_seconds=delay_seconds)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to send scheduling email: {exc}")

    session.call_status = "scheduled"
    _append_call_log(
        session,
        {
            "source": "admin",
            "status": "scheduled",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "delay_seconds": int(delay_seconds),
            "scheduled_for": scheduled_for.isoformat() if scheduled_for else None,
        },
    )
    assessment_db.add(
        ProctorEvent(
            session_code=session_code,
            assessment_type="call_interview",
            event_type="call_interview_email_scheduled",
            severity="low",
            payload={"delay_seconds": int(delay_seconds), "candidate_email": session.candidate_email},
        )
    )
    assessment_db.commit()
    _publish_call_status_update(
        session=session,
        status_value="scheduled",
        source="schedule_call",
        extra={"delay_seconds": int(delay_seconds), "scheduled_for": scheduled_for.isoformat() if scheduled_for else None},
    )
    _publish_assessment_dashboard_counters(assessment_db)
    try:
        _update_jobs_progress(
            jobs_db=jobs_db,
            session=session,
            action="interview_scheduled",
            stage="interview_scheduled",
            interview_status="scheduled",
            interview_scheduled_for=scheduled_for,
            details={"delay_seconds": delay_seconds},
        )
    except Exception as exc:
        logger.warning("Failed to sync interview schedule for {}: {}", session_code, exc)

    background.add_task(
        _schedule_interview_call_background,
        session_code=session_code,
        delay_seconds=int(delay_seconds),
        auth_token=str(_admin.get("_auth_token") or "").strip() or None,
    )

    return {
        "ok": True,
        "message": f"Interview call scheduled. Email sent and call will be attempted in {int(delay_seconds)} seconds.",
        "session_code": session_code,
    }


@app.post("/api/admin/exams/{session_code}/reject", response_model=AdminActionResponse)
def admin_reject_candidate(
    session_code: str,
    assessment_db: Session = Depends(get_assessment_db),
    jobs_db: Session | None = Depends(get_optional_jobs_db),
    _admin: dict = Depends(get_current_assessment_admin),
) -> dict:
    session = (
        assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code))
        .scalars()
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    session.status = "rejected"
    session.passed = 0
    session.call_status = "cancelled"
    _append_call_log(
        session,
        {
            "source": "admin",
            "status": "rejected",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message": "Candidate rejected from admin modal",
        },
    )

    assessment_db.add(
        ProctorEvent(
            session_code=session_code,
            assessment_type="onscreen",
            event_type="candidate_rejected",
            severity="high",
            payload={"reason": "manual_admin_reject"},
        )
    )
    assessment_db.add(
        ProctorEvent(
            session_code=session_code,
            assessment_type="call_interview",
            event_type="call_interview_cancelled",
            severity="medium",
            payload={"reason": "manual_admin_reject"},
        )
    )
    assessment_db.commit()
    _publish_call_status_update(
        session=session,
        status_value="cancelled",
        source="admin_reject",
        extra={"reason": "manual_admin_reject"},
    )
    _publish_exam_status_update(session=session, source="admin_reject")
    _publish_assessment_dashboard_counters(assessment_db)
    try:
        _update_jobs_progress(
            jobs_db=jobs_db,
            session=session,
            action="candidate_rejected",
            stage="rejected",
            interview_status="cancelled",
            details={"reason": "manual_admin_reject"},
        )
    except Exception as exc:
        logger.warning("Failed to sync rejection for {}: {}", session_code, exc)

    return {
        "ok": True,
        "message": "Candidate rejected successfully",
        "session_code": session_code,
    }


@app.delete("/api/admin/exams/{session_code}", response_model=AdminActionResponse)
def admin_delete_exam(
    session_code: str,
    assessment_db: Session = Depends(get_assessment_db),
    jobs_db: Session | None = Depends(get_optional_jobs_db),
    _admin: dict = Depends(get_current_assessment_admin),
) -> dict:
    session = (
        assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code))
        .scalars()
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    deleted_job_id = getattr(session, "job_id", None)
    deleted_candidate_email = str(getattr(session, "candidate_email", "") or "").strip().lower()
    replacement_session = (
        assessment_db.execute(
            select(ExamSession)
            .where(
                ExamSession.id != session.id,
                ExamSession.job_id == deleted_job_id,
                func.lower(ExamSession.candidate_email) == deleted_candidate_email,
            )
            .order_by(ExamSession.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )

    assessment_db.execute(delete(ProctorEvent).where(ProctorEvent.session_code == session_code))
    assessment_db.delete(session)
    assessment_db.commit()
    cleanup_session_state(session_code)
    _publish_assessment_dashboard_counters(assessment_db)

    try:
        if jobs_db is not None and deleted_job_id and deleted_candidate_email:
            candidate = (
                jobs_db.execute(
                    select(MainCandidate).where(func.lower(MainCandidate.email) == deleted_candidate_email)
                )
                .scalars()
                .first()
            )
            if candidate:
                progress = (
                    jobs_db.execute(
                        select(MainJobCandidateProgress).where(
                            MainJobCandidateProgress.job_id == int(deleted_job_id),
                            MainJobCandidateProgress.candidate_id == int(candidate.id),
                        )
                    )
                    .scalars()
                    .first()
                )
                if progress and str(progress.last_assessment_session_code or "").strip() == session_code:
                    if replacement_session:
                        progress.last_assessment_session_code = replacement_session.session_code
                        progress.assessment_status = replacement_session.status
                        progress.assessment_score = (
                            float(replacement_session.percentage)
                            if replacement_session.percentage is not None
                            else None
                        )
                        progress.assessment_passed = (
                            bool(replacement_session.passed)
                            if replacement_session.passed is not None
                            else None
                        )
                    else:
                        progress.last_assessment_session_code = None
                        progress.assessment_status = None
                        progress.assessment_score = None
                        progress.assessment_passed = None
                        progress.manual_assessment_score = None
                    progress.decision_history = append_history_entry(
                        progress.decision_history,
                        action="assessment_deleted",
                        stage=progress.stage,
                        actor="assessment_admin",
                        details={
                            "deleted_session_code": session_code,
                            "replacement_session_code": (
                                replacement_session.session_code if replacement_session else None
                            ),
                        },
                    )
                    progress.updated_at = datetime.now(timezone.utc)
                    jobs_db.add(progress)
                    jobs_db.commit()
    except Exception as exc:
        logger.warning("Failed to sync jobs progress after deleting {}: {}", session_code, exc)

    return {
        "ok": True,
        "message": "Assessment session deleted successfully",
        "session_code": session_code,
    }


@app.post("/api/admin/exams/{session_code}/review", response_model=AdminActionResponse)
def admin_update_exam_review(
    session_code: str,
    payload: AdminExamReviewUpdateRequest,
    assessment_db: Session = Depends(get_assessment_db),
    jobs_db: Session | None = Depends(get_optional_jobs_db),
    _admin: dict = Depends(get_current_assessment_admin),
) -> dict:
    session = (
        assessment_db.execute(select(ExamSession).where(ExamSession.session_code == session_code))
        .scalars()
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    try:
        _update_jobs_progress(
            jobs_db=jobs_db,
            session=session,
            action="admin_review_updated",
            stage=payload.stage,
            recruiter_notes=payload.recruiter_notes,
            manual_assessment_score=payload.manual_assessment_score,
            interview_status=payload.interview_status,
            interview_scheduled_for=payload.interview_scheduled_for,
            append_note=payload.append_history_note,
            details={"session_code": session_code},
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to update review state: {exc}")

    return {
        "ok": True,
        "message": "Assessment review updated successfully",
        "session_code": session_code,
    }


# ---------------------------------------------------------------------------
# AI Interview Call Endpoints (Twilio TwiML)
# ---------------------------------------------------------------------------
async def _generate_elevenlabs_audio(text: str) -> bytes | None:
    api_key = (settings.elevenlabs_api_key or "").strip()
    voice_id = (settings.elevenlabs_voice_id or "").strip()
    model_id = (settings.elevenlabs_model_id or "").strip() or "eleven_multilingual_v2"

    if not api_key or not voice_id:
        return None

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {"xi-api-key": api_key, "accept": "audio/mpeg", "content-type": "application/json"}
    payload = {"text": text, "model_id": model_id}

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        logger.warning("ElevenLabs TTS failed: {}", resp.status_code)
        return None

    return resp.content


def _build_interview_audio_url(base_url: str, text: str) -> str:
    safe_text = (text or "").strip()[:300]
    return f"{base_url}/api/interview/audio?text={quote_plus(safe_text)}"


def _build_interview_continue_url(base_url: str, turn: int, session_code: str, name: str, position: str) -> str:
    return (
        f"{base_url}/api/interview/continue"
        f"?turn={turn}"
        f"&session_code={quote_plus(session_code)}"
        f"&name={quote_plus(name)}"
        f"&position={quote_plus(position)}"
    )


@app.get("/api/interview/twiml", include_in_schema=False)
async def interview_twiml(session_code: str = "", name: str = "there", position: str = "the role") -> Response:
    try:
        if VoiceResponse is None:
            return Response(
                content="<Response><Say>Sorry, a temporary error occurred.</Say><Hangup/></Response>",
                media_type="application/xml",
            )

        base_url = _public_call_base_url()
        hr_text = await _generate_interview_line(
            turn=1, candidate_name=name, position=position, job_title=position, user_speech=None,
        )

        vr = VoiceResponse()
        gather = vr.gather(
            input="speech",
            action=_build_interview_continue_url(base_url, 2, session_code, name, position),
            method="POST",
            timeout=8,
            speech_timeout="auto",
            language="en-IN",
        )
        gather.say(hr_text, voice=settings.twilio_voice or "Polly.Aditi")
        return Response(content=str(vr), media_type="application/xml")
    except Exception:
        logger.exception("interview_twiml failed")
        vr = VoiceResponse()
        vr.say("Sorry, a temporary error occurred. Please try again later.", voice="Polly.Aditi")
        vr.hangup()
        return Response(content=str(vr), media_type="application/xml")


@app.post("/api/interview/continue", include_in_schema=False)
async def interview_continue(
    request: Request,
    turn: int = 2,
    session_code: str = "",
    name: str = "there",
    position: str = "the role",
) -> Response:
    try:
        if VoiceResponse is None:
            return Response(
                content="<Response><Say>Sorry, a temporary error occurred.</Say><Hangup/></Response>",
                media_type="application/xml",
            )

        speech = ""
        try:
            form = await request.form()
            speech = str(form.get("SpeechResult") or "").strip()
        except Exception:
            pass

        base_url = _public_call_base_url()
        hr_text = await _generate_interview_line(
            turn=int(turn), candidate_name=name, position=position, job_title=position, user_speech=speech or None,
        )

        # Store the call response in DB
        if session_code:
            try:
                from .db import AssessmentSessionLocal
                db = AssessmentSessionLocal()
                try:
                    sess = db.execute(select(ExamSession).where(ExamSession.session_code == session_code)).scalar_one_or_none()
                    if sess:
                        responses = sess.call_responses or []
                        responses.append({
                            "turn": int(turn),
                            "interviewer": hr_text,
                            "candidate_speech": speech or "",
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        })
                        sess.call_responses = responses
                        sess.call_status = "in_progress" if int(turn) < 5 else "completed"
                        db.commit()
                        _publish_call_status_update(
                            session=sess,
                            status_value=sess.call_status,
                            source="interview_continue",
                            extra={"turn": int(turn)},
                        )
                        _publish_assessment_dashboard_counters(db)
                finally:
                    db.close()
            except Exception as exc:
                logger.warning("Failed to store call response: {}", exc)

        use_play = bool(
            (settings.elevenlabs_api_key or "").strip()
            and (settings.elevenlabs_voice_id or "").strip()
        )

        vr = VoiceResponse()
        if int(turn) >= 5:
            vr.say(hr_text, voice=settings.twilio_voice or "Polly.Aditi")
            vr.hangup()
            return Response(content=str(vr), media_type="application/xml")

        gather = vr.gather(
            input="speech",
            action=_build_interview_continue_url(base_url, int(turn) + 1, session_code, name, position),
            method="POST",
            timeout=8,
            speech_timeout="auto",
            language="en-IN",
        )
        gather.say(hr_text, voice=settings.twilio_voice or "Polly.Aditi")
        return Response(content=str(vr), media_type="application/xml")
    except Exception:
        logger.exception("interview_continue failed")
        vr = VoiceResponse()
        vr.say("Sorry, a temporary error occurred. Please try again later.", voice="Polly.Aditi")
        vr.hangup()
        return Response(content=str(vr), media_type="application/xml")


@app.get("/api/interview/audio", include_in_schema=False)
async def interview_audio(text: str | None = None) -> Response:
    if not text or not text.strip():
        text = "Hello, this is SmartHire AI interviewer."

    text = str(text).strip()[:300]

    try:
        audio_bytes = await _generate_elevenlabs_audio(text)
        if audio_bytes:
            return Response(content=audio_bytes, media_type="audio/mpeg")
    except Exception:
        logger.warning("ElevenLabs TTS failed in interview_audio")

    # Fallback: Twilio built-in TTS
    if VoiceResponse is not None:
        vr = VoiceResponse()
        vr.say(text, voice=settings.twilio_voice or "Polly.Aditi")
        return Response(content=str(vr), media_type="application/xml")

    return Response(content=b"", media_type="audio/mpeg", status_code=200)


@app.post("/api/proctor/analyze-frame")
def analyze_proctor_frame(payload: ProctorFrameRequest, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    assessment_type = _assessment_type_for_session(
        session_code=payload.session_code,
        assessment_db=assessment_db,
        fallback=getattr(payload, "assessment_type", None) or "onscreen",
    )
    result = analyze_frame(payload.session_code, payload.camera_type, payload.image_base64)
    event = ProctorEvent(
        session_code=payload.session_code,
        assessment_type=assessment_type,
        event_type="camera_analysis",
        severity=result.get("severity", "low"),
        payload={"camera_type": payload.camera_type, **result},
    )
    assessment_db.add(event)
    assessment_db.commit()

    try:
        flags = result.get("flags") or []
        severity = str(result.get("severity") or "low")
        if flags or severity in {"medium", "high"}:
            logger.info(
                "PROCTOR_CAMERA session_code={} camera_type={} severity={} flags={}",
                payload.session_code,
                payload.camera_type,
                severity,
                list(flags)[:8],
            )
    except Exception:
        pass
    return result


@app.post("/api/proctor/verify-identity", response_model=FaceIdVerificationResponse)
def verify_identity(payload: FaceIdVerificationRequest, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    assessment_type = _assessment_type_for_session(
        session_code=payload.session_code,
        assessment_db=assessment_db,
        fallback=getattr(payload, "assessment_type", None) or "onscreen",
    )
    session = (
        assessment_db.execute(select(ExamSession).where(ExamSession.session_code == payload.session_code))
        .scalars()
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Exam session not found")

    id_image = str(payload.id_image_base64 or "").strip()
    selfie_image = str(payload.selfie_image_base64 or "").strip()
    if not id_image:
        raise HTTPException(status_code=400, detail="Government ID image is required")
    if not selfie_image:
        raise HTTPException(status_code=400, detail="Live selfie image is required")

    accepted_government_id_types = ["aadhaar", "pan", "driving_license", "voter_id"]
    provided_id_type = str(getattr(payload, "government_id_type", "") or "").strip().lower()
    government_id_type_valid = provided_id_type in accepted_government_id_types if provided_id_type else False

    session.government_id_image_base64 = id_image
    session.live_selfie_image_base64 = selfie_image
    session.identity_status = "completed"
    session.identity_submitted_at = datetime.now(timezone.utc)

    result = {
        "verified": True,
        "similarity": None,
        "threshold": 0.0,
        "flags": [],
        "blocking_flags": [],
        "guidance": [],
        "next_steps": [],
        "can_retry": True,
        "id_face_count": 0,
        "selfie_face_count": 0,
        "government_id_uploaded": True,
        "government_id_type": provided_id_type or None,
        "government_id_type_valid": government_id_type_valid,
        "accepted_government_id_types": accepted_government_id_types,
        "id_document_confidence": 0.0,
        "face_quality_score": 0.0,
        "model_source": "manual_upload_only",
        "similarity_breakdown": None,
        "id_document_signals": None,
        "image_meta": None,
    }

    event = ProctorEvent(
        session_code=payload.session_code,
        assessment_type=assessment_type,
        event_type="face_id_verification",
        severity="low",
        payload=result,
    )
    assessment_db.add(session)
    assessment_db.add(event)
    assessment_db.commit()
    _publish_exam_status_update(session=session, source="face_id_verification")
    _publish_assessment_dashboard_counters(assessment_db)

    return result


@app.post("/api/proctor/secondary/register")
def register_secondary(payload: SecondaryRegisterRequest) -> dict:
    return register_secondary_stream(payload.session_code, payload.pairing_token)


@app.post("/api/proctor/secondary/upload")
def upload_secondary_frame(payload: SecondaryUploadRequest, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    assessment_type = _assessment_type_for_session(
        session_code=payload.session_code,
        assessment_db=assessment_db,
        fallback=getattr(payload, "assessment_type", None) or "onscreen",
    )
    result = analyze_secondary_environment_frame(payload.session_code, payload.pairing_token, payload.image_base64)

    if result["flags"]:
        event = ProctorEvent(
            session_code=payload.session_code,
            assessment_type=assessment_type,
            event_type="secondary_environment_analysis",
            severity=result["severity"],
            payload=result,
        )
        assessment_db.add(event)
        assessment_db.commit()

    return result


@app.get("/api/proctor/secondary/status", response_model=SecondaryStatusResponse)
def secondary_status(session_code: str, pairing_token: str) -> dict:
    return get_secondary_stream_status(session_code, pairing_token)


@app.post("/api/proctor/audio")
def analyze_audio(payload: dict, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    session_code = payload.get("session_code")
    rms = float(payload.get("rms", 0.0))

    assessment_type = "onscreen"
    if session_code:
        assessment_type = _assessment_type_for_session(
            session_code=str(session_code),
            assessment_db=assessment_db,
            fallback=str(payload.get("assessment_type") or "onscreen"),
        )

    result = detect_audio_anomaly(rms)
    if session_code:
        event = ProctorEvent(
            session_code=session_code,
            assessment_type=assessment_type,
            event_type=result["event_type"] if result.get("is_anomaly") else "audio_check",
            severity=result.get("severity", "low"),
            payload={"rms": rms, **result},
        )
        assessment_db.add(event)
        assessment_db.commit()
    return result


# ---------------------------------------------------------------------------
# Environment Check Endpoint
# ---------------------------------------------------------------------------
_VM_UA_KEYWORDS = [
    "virtualbox", "vmware", "hyper-v", "qemu", "parallels",
    "xen", "bochs", "bhyve", "kvm",
]

_VM_GPU_KEYWORDS = [
    "swiftshader", "llvmpipe", "virtualbox", "vmware",
    "parallels", "microsoft basic render", "chromium",
    "mesa", "software rasterizer",
]


@app.post("/api/proctor/env-check")
def environment_check(
    payload: EnvCheckRequest,
    assessment_db: Session = Depends(get_assessment_db),
) -> dict:
    """Server-side validation of client environment signals."""
    flags: list[str] = []
    risk_score = 0

    ua = (payload.user_agent or "").lower()
    platform = (payload.platform or "").lower()
    renderer = (payload.webgl_renderer or "").lower()
    vendor = (payload.webgl_vendor or "").lower()

    # --- VM detection ---
    for kw in _VM_UA_KEYWORDS:
        if kw in ua or kw in platform:
            flags.append(f"vm_ua_keyword:{kw}")
            risk_score += 30
            break

    for kw in _VM_GPU_KEYWORDS:
        if kw in renderer or kw in vendor:
            flags.append(f"vm_gpu_keyword:{kw}")
            risk_score += 25
            break

    # Low hardware = suspicious
    cores = payload.hardware_concurrency
    if cores is not None and cores <= 1:
        flags.append("single_cpu_core")
        risk_score += 15

    mem = payload.device_memory
    if mem is not None and mem <= 1:
        flags.append("low_device_memory")
        risk_score += 10

    # --- Remote desktop signals ---
    sw = payload.screen_width or 0
    sh = payload.screen_height or 0
    cd = payload.screen_color_depth or 0

    if sw > 0 and sh > 0 and sw <= 800 and sh <= 600:
        flags.append("low_screen_resolution")
        risk_score += 10

    if cd > 0 and cd < 24:
        flags.append("low_color_depth")
        risk_score += 10

    if not payload.has_pointer:
        flags.append("no_pointer_input")
        risk_score += 10

    # --- Headless / automation ---
    if "headless" in ua:
        flags.append("headless_browser")
        risk_score += 40

    plugins = payload.plugins_count
    if plugins is not None and plugins == 0:
        flags.append("zero_plugins")
        risk_score += 5

    risk_score = min(risk_score, 100)
    severity = "low" if risk_score < 30 else ("medium" if risk_score < 60 else "high")

    # Persist as proctor event
    assessment_type = _assessment_type_for_session(
        session_code=payload.session_code,
        assessment_db=assessment_db,
        fallback="onscreen",
    )
    event = ProctorEvent(
        session_code=payload.session_code,
        assessment_type=assessment_type,
        event_type="env_check",
        severity=severity,
        payload={
            "flags": flags,
            "risk_score": risk_score,
            "user_agent": payload.user_agent[:200],
            "platform": payload.platform,
            "hardware_concurrency": payload.hardware_concurrency,
            "device_memory": payload.device_memory,
            "webgl_renderer": payload.webgl_renderer[:200] if payload.webgl_renderer else "",
            "screen": f"{sw}x{sh}x{cd}",
        },
    )
    assessment_db.add(event)
    assessment_db.commit()

    if severity in {"medium", "high"}:
        logger.warning(
            "ENV_CHECK session_code={} risk_score={} flags={}",
            payload.session_code, risk_score, flags,
        )

    return {
        "ok": True,
        "risk_score": risk_score,
        "severity": severity,
        "flags": flags,
    }


@app.post("/api/proctor/events")
def log_event(payload: ProctorEventRequest, assessment_db: Session = Depends(get_assessment_db)) -> dict:
    explicit_type = (getattr(payload, "assessment_type", None) or "").strip()
    if explicit_type == "call_interview":
        assessment_type = "call_interview"
    else:
        assessment_type = _assessment_type_for_session(
            session_code=payload.session_code,
            assessment_db=assessment_db,
            fallback=explicit_type or "onscreen",
        )
    event = ProctorEvent(
        session_code=payload.session_code,
        assessment_type=assessment_type,
        event_type=payload.event_type,
        severity=payload.severity,
        payload=payload.payload,
    )
    assessment_db.add(event)
    assessment_db.commit()

    if assessment_type == "call_interview":
        event_type = str(payload.event_type or "").strip().lower()
        raw_payload = payload.payload if isinstance(payload.payload, dict) else {}
        status_from_event: str | None = None
        if event_type == "call_interview_call_status":
            status_from_event = str(raw_payload.get("status") or "").strip().lower() or None
        elif event_type == "call_interview_call_initiated":
            status_from_event = str(raw_payload.get("status") or "initiated").strip().lower() or "initiated"
        elif event_type == "call_interview_email_scheduled":
            status_from_event = "scheduled"
        elif event_type == "call_interview_completed":
            status_from_event = "completed"
        elif event_type in {"call_interview_call_failed", "call_interview_call_exception", "call_interview_failed_no_phone"}:
            status_from_event = "failed"
        elif event_type == "call_interview_cancelled":
            status_from_event = "cancelled"

        if status_from_event:
            session = (
                assessment_db.execute(select(ExamSession).where(ExamSession.session_code == payload.session_code))
                .scalars()
                .first()
            )
            if session:
                session.call_status = status_from_event
                if raw_payload.get("call_sid"):
                    session.call_sid = str(raw_payload.get("call_sid"))
                _append_call_log(
                    session,
                    {
                        "source": "proctor_event",
                        "status": status_from_event,
                        "event_type": event_type,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "payload": _json_safe(raw_payload),
                    },
                )
                assessment_db.commit()
                _publish_call_status_update(
                    session=session,
                    status_value=status_from_event,
                    source="proctor_event",
                    extra={"event_type": event_type},
                )
                _publish_assessment_dashboard_counters(assessment_db)

    try:
        severity = str(payload.severity or "medium").lower()
        if severity in {"medium", "high"}:
            logger.warning(
                "PROCTOR_EVENT session_code={} severity={} event_type={} payload={}",
                payload.session_code,
                severity,
                payload.event_type,
                _summarize_payload(payload.payload),
            )
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/exams/{session_code}/proctor-report")
def proctor_report(
    session_code: str,
    assessment_type: str | None = None,
    assessment_db: Session = Depends(get_assessment_db),
) -> dict:
    atype = _assessment_type_for_session(
        session_code=session_code,
        assessment_db=assessment_db,
        fallback=assessment_type or "onscreen",
    )
    events = assessment_db.execute(
        select(ProctorEvent).where(ProctorEvent.session_code == session_code).order_by(ProctorEvent.created_at.asc())
    ).scalars().all()

    if atype:
        events = [event for event in events if _normalize_assessment_type(getattr(event, "assessment_type", None)) == atype]

    severity_count = {"low": 0, "medium": 0, "high": 0}
    for event in events:
        if event.severity in severity_count:
            severity_count[event.severity] += 1

    return {
        "session_code": session_code,
        "assessment_type": atype,
        "total_events": len(events),
        "severity": severity_count,
        "events": [
            {
                "assessment_type": _normalize_assessment_type(getattr(event, "assessment_type", None)),
                "event_type": event.event_type,
                "severity": event.severity,
                "payload": event.payload,
                "created_at": event.created_at,
            }
            for event in events
        ],
    }
