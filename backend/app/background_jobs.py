from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from threading import Lock
from uuid import uuid4

from loguru import logger

from .db import SessionLocal
from .embeddings import upsert_candidate_embeddings, upsert_job_embeddings
from .models import Candidate, Job
from .resume_parser import extract_text_from_pdf


_jobs: dict[str, dict] = {}
_jobs_lock = Lock()
_JOB_RETENTION_SECONDS = 60 * 60 * 6   # keep terminal jobs for 6 hours
_JOB_MAX = 500                          # hard upper bound


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _purge_old_jobs_locked() -> None:
    now = time.time()
    expired: list[str] = []
    for job_id, info in _jobs.items():
        finished_at = info.get("_finished_epoch")
        if finished_at and (now - finished_at) > _JOB_RETENTION_SECONDS:
            expired.append(job_id)
    for job_id in expired:
        _jobs.pop(job_id, None)

    # Hard cap (drop oldest finished jobs first).
    if len(_jobs) > _JOB_MAX:
        finished = sorted(
            (k for k, v in _jobs.items() if v.get("_finished_epoch")),
            key=lambda k: _jobs[k].get("_finished_epoch", 0),
        )
        while len(_jobs) > _JOB_MAX and finished:
            _jobs.pop(finished.pop(0), None)


def list_background_jobs() -> list[dict]:
    with _jobs_lock:
        _purge_old_jobs_locked()
        snapshot = [
            {k: v for k, v in info.items() if not k.startswith("_")}
            for info in _jobs.values()
        ]
    return sorted(snapshot, key=lambda item: item.get("created_at") or "", reverse=True)


def _start_background_task(*, name: str, coro_factory) -> str:
    job_id = uuid4().hex[:12]
    with _jobs_lock:
        _purge_old_jobs_locked()
        _jobs[job_id] = {
            "id": job_id,
            "name": name,
            "status": "queued",
            "created_at": _utc_now(),
            "started_at": None,
            "finished_at": None,
            "error": None,
        }

    async def runner() -> None:
        with _jobs_lock:
            entry = _jobs.get(job_id)
            if entry is not None:
                entry["status"] = "running"
                entry["started_at"] = _utc_now()
        try:
            await coro_factory()
            with _jobs_lock:
                entry = _jobs.get(job_id)
                if entry is not None:
                    entry["status"] = "completed"
        except Exception as exc:
            logger.exception("Background job {} failed", name)
            with _jobs_lock:
                entry = _jobs.get(job_id)
                if entry is not None:
                    entry["status"] = "failed"
                    entry["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            with _jobs_lock:
                entry = _jobs.get(job_id)
                if entry is not None:
                    entry["finished_at"] = _utc_now()
                    entry["_finished_epoch"] = time.time()

    task = asyncio.create_task(runner())
    # Keep a reference so the GC can't collect the task before it runs.
    task.add_done_callback(lambda _t: None)
    return job_id


def schedule_job_embeddings(job_id: int) -> str:
    async def task() -> None:
        async with SessionLocal() as db:
            job = await db.get(Job, int(job_id))
            if not job:
                return
            await upsert_job_embeddings(db=db, job=job)

    return _start_background_task(name=f"job-embeddings:{job_id}", coro_factory=task)


def schedule_candidate_embeddings(candidate_id: int) -> str:
    async def task() -> None:
        async with SessionLocal() as db:
            candidate = await db.get(Candidate, int(candidate_id))
            if not candidate:
                return
            resume_text = extract_text_from_pdf(candidate.resume_pdf)
            await upsert_candidate_embeddings(db=db, candidate=candidate, resume_text=resume_text)

    return _start_background_task(name=f"candidate-embeddings:{candidate_id}", coro_factory=task)
