from __future__ import annotations

from datetime import datetime, timezone


PIPELINE_STAGES = [
    "applied",
    "shortlisted",
    "assessment_sent",
    "assessment_in_progress",
    "assessment_passed",
    "assessment_failed",
    "interview_scheduled",
    "interview_completed",
    "rejected",
    "hired",
]

DEFAULT_PIPELINE_STAGE = "applied"


def normalize_pipeline_stage(value: str | None) -> str:
    stage = str(value or "").strip().lower()
    if stage in PIPELINE_STAGES:
        return stage
    return DEFAULT_PIPELINE_STAGE


def append_history_entry(
    history: list[dict] | None,
    *,
    action: str,
    stage: str | None = None,
    actor: str | None = None,
    note: str | None = None,
    details: dict | None = None,
) -> list[dict]:
    next_history = list(history or [])
    entry: dict[str, object] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": str(action or "updated").strip() or "updated",
    }
    normalized_stage = normalize_pipeline_stage(stage) if stage else None
    if normalized_stage:
        entry["stage"] = normalized_stage
    if actor:
        entry["actor"] = str(actor).strip()
    if note:
        cleaned_note = str(note).strip()
        if cleaned_note:
            entry["note"] = cleaned_note
    if details:
        safe_details = {str(k): v for k, v in details.items() if v is not None}
        if safe_details:
            entry["details"] = safe_details
    next_history.append(entry)
    return next_history
