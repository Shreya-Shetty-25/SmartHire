from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from loguru import logger
from sqlalchemy import select

# Ensure `backend/` is on sys.path so `import app...` works when running this
# file directly (e.g., `python scripts/backfill_embeddings.py`).
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Ensure the working directory is the backend root so `app.config.settings`
# can reliably find `.env` (it is configured as a relative env_file).
os.chdir(BACKEND_ROOT)

from app.db import SessionLocal, init_db
from app.embeddings import (
    DEFAULT_EMBEDDING_MODEL,
    upsert_candidate_embeddings,
    upsert_job_embeddings,
)
from app.models import (
    Base,
    Candidate,
    CandidateEmbeddingChunk,
    Job,
    JobEmbeddingChunk,
)
from app.resume_parser import extract_text_from_pdf


async def _existing_candidate_ids(*, model_name: str) -> set[int]:
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(CandidateEmbeddingChunk.candidate_id)
                .where(CandidateEmbeddingChunk.model_name == model_name)
                .distinct()
            )
        ).scalars().all()
        return {int(x) for x in rows if x is not None}


async def _existing_job_ids(*, model_name: str) -> set[int]:
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(JobEmbeddingChunk.job_id).where(JobEmbeddingChunk.model_name == model_name).distinct()
            )
        ).scalars().all()
        return {int(x) for x in rows if x is not None}


async def backfill_embeddings(
    *,
    model_name: str,
    include_candidates: bool,
    include_jobs: bool,
    only_missing: bool,
    limit: int | None,
) -> None:
    # Ensure tables exist (same behavior as API startup).
    await init_db(Base.metadata)

    existing_candidates: set[int] = set()
    existing_jobs: set[int] = set()

    if only_missing and include_candidates:
        existing_candidates = await _existing_candidate_ids(model_name=model_name)
        logger.info("Found {} candidates already embedded for model '{}'", len(existing_candidates), model_name)

    if only_missing and include_jobs:
        existing_jobs = await _existing_job_ids(model_name=model_name)
        logger.info("Found {} jobs already embedded for model '{}'", len(existing_jobs), model_name)

    async with SessionLocal() as db:
        if include_jobs:
            stmt = select(Job).order_by(Job.id.asc())
            if limit is not None:
                stmt = stmt.limit(int(limit))
            jobs = list((await db.execute(stmt)).scalars().all())

            ok = skipped = failed = 0
            for job in jobs:
                if only_missing and job.id in existing_jobs:
                    skipped += 1
                    continue
                try:
                    await upsert_job_embeddings(db=db, job=job, model_name=model_name)
                    ok += 1
                except Exception as exc:
                    failed += 1
                    logger.exception("Job embedding failed for job_id={}: {}", job.id, exc)

            logger.info(
                "Jobs backfill done: ok={} skipped={} failed={} total_scanned={}",
                ok,
                skipped,
                failed,
                len(jobs),
            )

        if include_candidates:
            stmt = select(Candidate).order_by(Candidate.id.asc())
            if limit is not None:
                stmt = stmt.limit(int(limit))
            candidates = list((await db.execute(stmt)).scalars().all())

            ok = skipped = failed = no_text = 0
            for candidate in candidates:
                if only_missing and candidate.id in existing_candidates:
                    skipped += 1
                    continue

                try:
                    resume_text = extract_text_from_pdf(candidate.resume_pdf)
                except Exception as exc:
                    no_text += 1
                    logger.warning("Skipping candidate_id={} (text extraction failed): {}", candidate.id, exc)
                    continue

                if not resume_text or not resume_text.strip():
                    no_text += 1
                    logger.warning("Skipping candidate_id={} (empty extracted text)", candidate.id)
                    continue

                try:
                    await upsert_candidate_embeddings(
                        db=db,
                        candidate=candidate,
                        resume_text=resume_text,
                        model_name=model_name,
                    )
                    ok += 1
                except Exception as exc:
                    failed += 1
                    logger.exception("Candidate embedding failed for candidate_id={}: {}", candidate.id, exc)

            logger.info(
                "Candidates backfill done: ok={} skipped={} no_text={} failed={} total_scanned={}",
                ok,
                skipped,
                no_text,
                failed,
                len(candidates),
            )


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Backfill SmartHire embeddings for existing jobs/candidates")
    p.add_argument("--model", default=DEFAULT_EMBEDDING_MODEL, help="Embedding model name")
    p.add_argument("--all", action="store_true", help="Backfill both jobs and candidates")
    p.add_argument("--jobs", action="store_true", help="Backfill jobs")
    p.add_argument("--candidates", action="store_true", help="Backfill candidates")
    p.add_argument(
        "--only-missing",
        action="store_true",
        default=True,
        help="Skip rows that already have embeddings (default: true)",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional limit for how many jobs/candidates to scan (for testing)",
    )
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    include_jobs = args.all or args.jobs
    include_candidates = args.all or args.candidates

    if not include_jobs and not include_candidates:
        include_jobs = True
        include_candidates = True

    logger.info(
        "Starting embeddings backfill: model='{}' jobs={} candidates={} only_missing={} limit={}",
        args.model,
        include_jobs,
        include_candidates,
        args.only_missing,
        args.limit,
    )

    asyncio.run(
        backfill_embeddings(
            model_name=args.model,
            include_candidates=include_candidates,
            include_jobs=include_jobs,
            only_missing=bool(args.only_missing),
            limit=args.limit,
        )
    )


if __name__ == "__main__":
    main()
