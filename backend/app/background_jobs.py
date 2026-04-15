from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from uuid import uuid4

from loguru import logger

from .db import SessionLocal
from .embeddings import upsert_candidate_embeddings, upsert_job_embeddings
from .models import Candidate, Job
from .resume_parser import extract_text_from_pdf


_jobs: dict[str, dict] = {}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def list_background_jobs() -> list[dict]:
    return sorted(_jobs.values(), key=lambda item: item.get("created_at") or "", reverse=True)


def _start_background_task(*, name: str, coro_factory) -> str:
    job_id = uuid4().hex[:12]
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
        _jobs[job_id]["status"] = "running"
        _jobs[job_id]["started_at"] = _utc_now()
        try:
            await coro_factory()
            _jobs[job_id]["status"] = "completed"
        except Exception as exc:
            logger.warning("Background job {} failed: {}", name, exc)
            _jobs[job_id]["status"] = "failed"
            _jobs[job_id]["error"] = str(exc)
        finally:
            _jobs[job_id]["finished_at"] = _utc_now()

    asyncio.create_task(runner())
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
