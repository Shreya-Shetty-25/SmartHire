from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Iterable

from fastapi import HTTPException
from loguru import logger
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Candidate, CandidateEmbeddingChunk, Job, JobEmbeddingChunk
from .resume_parser import extract_text_from_pdf


DEFAULT_EMBEDDING_MODEL = "all-MiniLM-L6-v2"


_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F]")


def _sanitize_text_for_db(text: str) -> str:
    if not text:
        return ""

    # Postgres TEXT/VARCHAR cannot contain NUL bytes (\x00).
    # Also strip other control chars that commonly appear from PDF extraction.
    text = _CONTROL_CHARS_RE.sub(" ", text)

    # Ensure no lone surrogates/unencodable chars remain.
    text = text.encode("utf-8", "ignore").decode("utf-8", "ignore")

    return text


@dataclass(frozen=True)
class ChunkingConfig:
    chunk_words: int = 200
    overlap_words: int = 40


def _normalize(vec: list[float]) -> list[float]:
    # L2 normalize.
    s = 0.0
    for x in vec:
        s += float(x) * float(x)
    if s <= 0:
        return vec
    denom = math.sqrt(s)
    return [float(x) / denom for x in vec]


def chunk_text(text: str, *, config: ChunkingConfig = ChunkingConfig()) -> list[str]:
    text = _sanitize_text_for_db(text or "")
    words = [w for w in text.split() if w]
    if not words:
        return []

    chunk_words = max(1, int(config.chunk_words))
    overlap_words = max(0, min(int(config.overlap_words), chunk_words - 1))

    chunks: list[str] = []
    start = 0
    while start < len(words):
        end = min(len(words), start + chunk_words)
        chunk = " ".join(words[start:end]).strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(words):
            break
        start = max(0, end - overlap_words)

    return chunks


def _load_sentence_transformer(model_name: str):
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except ModuleNotFoundError as exc:  # pragma: no cover
        # True missing package.
        if getattr(exc, "name", None) in {"sentence_transformers", "sentence-transformers"}:
            raise HTTPException(
                status_code=500,
                detail="sentence-transformers is not installed. Install backend requirements to enable embeddings.",
            ) from exc
        # A dependency inside sentence-transformers (often torch) is missing.
        raise HTTPException(
            status_code=500,
            detail=(
                "Failed to import sentence-transformers dependencies. "
                f"Missing module: {getattr(exc, 'name', None) or str(exc)}"
            ),
        ) from exc
    except Exception as exc:  # pragma: no cover
        # Any other import-time error (binary incompat, etc.)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to import sentence-transformers: {exc}",
        ) from exc

    try:
        return SentenceTransformer(model_name)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to load embedding model '{model_name}'. "
                "Ensure the server can download HuggingFace models or pre-cache the model locally."
            ),
        ) from exc


# Global singleton model (loaded on first use).
_MODEL = None
_MODEL_NAME = None


def _get_model(model_name: str):
    global _MODEL, _MODEL_NAME
    if _MODEL is None or _MODEL_NAME != model_name:
        _MODEL = _load_sentence_transformer(model_name)
        _MODEL_NAME = model_name
    return _MODEL


def embed_texts(texts: list[str], *, model_name: str = DEFAULT_EMBEDDING_MODEL) -> list[list[float]]:
    model = _get_model(model_name)

    # normalize_embeddings=True gives unit vectors (cosine similarity = dot product).
    vectors = model.encode(texts, normalize_embeddings=True)

    # Convert to plain Python lists for JSONB storage.
    try:
        return [list(map(float, v.tolist())) for v in vectors]
    except Exception:
        return [list(map(float, v)) for v in vectors]


def _mean_vector(vectors: list[list[float]]) -> list[float] | None:
    if not vectors:
        return None
    dim = len(vectors[0])
    if dim <= 0:
        return None

    acc = [0.0] * dim
    count = 0
    for v in vectors:
        if not v or len(v) != dim:
            continue
        for i, x in enumerate(v):
            acc[i] += float(x)
        count += 1

    if count <= 0:
        return None
    mean = [x / count for x in acc]
    return _normalize(mean)


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    for x, y in zip(a, b, strict=False):
        dot += float(x) * float(y)
    return float(dot)


def job_to_embedding_text(job: Job) -> str:
    parts: list[str] = [job.title or "", job.description or ""]
    if job.skills_required:
        parts.append("Skills required: " + ", ".join(job.skills_required))
    if job.additional_skills:
        parts.append("Additional skills: " + ", ".join(job.additional_skills))
    if job.education:
        parts.append("Education: " + job.education)
    if job.years_experience is not None:
        parts.append(f"Years of experience: {job.years_experience}")
    if job.location:
        parts.append("Location: " + job.location)
    if job.employment_type:
        parts.append("Employment type: " + job.employment_type)
    return "\n".join([p for p in parts if p]).strip()


def candidate_to_embedding_text(candidate: Candidate, *, resume_text: str | None) -> str:
    parts: list[str] = []
    if resume_text:
        parts.append(str(resume_text))

    # Add structured fields too (so similarity works even if resume text is noisy).
    if candidate.full_name:
        parts.append("Name: " + candidate.full_name)
    if candidate.email:
        parts.append("Email: " + candidate.email)
    if getattr(candidate, "location", None):
        parts.append("Location: " + str(getattr(candidate, "location")))
    if getattr(candidate, "years_experience", None) is not None:
        parts.append("Years of experience: " + str(getattr(candidate, "years_experience")))

    skills = getattr(candidate, "skills", None)
    if skills:
        parts.append("Skills: " + ", ".join([str(s) for s in skills if s]))

    certifications = getattr(candidate, "certifications", None)
    if certifications:
        parts.append("Certifications: " + ", ".join([str(c) for c in certifications if c]))

    if candidate.college_details:
        parts.append("College: " + candidate.college_details)
    if candidate.school_details:
        parts.append("School: " + candidate.school_details)

    work = getattr(candidate, "work_experience", None)
    if work:
        parts.append("Work experience: " + " | ".join([str(w) for w in work if w]))

    projects = getattr(candidate, "projects", None)
    if projects:
        parts.append("Projects: " + " | ".join([str(p) for p in projects if p]))

    extra = getattr(candidate, "extra_curricular_activities", None)
    if extra:
        parts.append("Extra curricular: " + " | ".join([str(e) for e in extra if e]))

    links = getattr(candidate, "website_links", None)
    if links:
        parts.append("Links: " + ", ".join([str(u) for u in links if u]))

    return "\n".join([p for p in parts if p]).strip()


async def upsert_candidate_embeddings(
    *,
    db: AsyncSession,
    candidate: Candidate,
    resume_text: str,
    model_name: str = DEFAULT_EMBEDDING_MODEL,
    chunking: ChunkingConfig = ChunkingConfig(),
) -> None:
    text = _sanitize_text_for_db(candidate_to_embedding_text(candidate, resume_text=resume_text))
    chunks = chunk_text(text, config=chunking)
    if not chunks:
        return

    vectors = embed_texts(chunks, model_name=model_name)

    await db.execute(
        delete(CandidateEmbeddingChunk).where(
            CandidateEmbeddingChunk.candidate_id == candidate.id,
            CandidateEmbeddingChunk.model_name == model_name,
        )
    )

    for idx, (chunk, vec) in enumerate(zip(chunks, vectors, strict=False)):
        chunk = _sanitize_text_for_db(chunk)
        db.add(
            CandidateEmbeddingChunk(
                candidate_id=candidate.id,
                model_name=model_name,
                chunk_index=idx,
                text=chunk,
                embedding=vec,
            )
        )

    await db.commit()


async def upsert_job_embeddings(
    *,
    db: AsyncSession,
    job: Job,
    model_name: str = DEFAULT_EMBEDDING_MODEL,
    chunking: ChunkingConfig = ChunkingConfig(),
) -> None:
    text = _sanitize_text_for_db(job_to_embedding_text(job))
    chunks = chunk_text(text, config=chunking)
    if not chunks:
        return

    vectors = embed_texts(chunks, model_name=model_name)

    await db.execute(
        delete(JobEmbeddingChunk).where(JobEmbeddingChunk.job_id == job.id, JobEmbeddingChunk.model_name == model_name)
    )

    for idx, (chunk, vec) in enumerate(zip(chunks, vectors, strict=False)):
        chunk = _sanitize_text_for_db(chunk)
        db.add(
            JobEmbeddingChunk(
                job_id=job.id,
                model_name=model_name,
                chunk_index=idx,
                text=chunk,
                embedding=vec,
            )
        )

    await db.commit()


async def _get_job_vector(db: AsyncSession, job: Job, *, model_name: str) -> list[float] | None:
    rows = (
        await db.execute(
            select(JobEmbeddingChunk.embedding)
            .where(JobEmbeddingChunk.job_id == job.id, JobEmbeddingChunk.model_name == model_name)
            .order_by(JobEmbeddingChunk.chunk_index.asc())
        )
    ).scalars().all()

    vectors = [r for r in rows if isinstance(r, list) and r]
    if vectors:
        return _mean_vector(vectors)

    try:
        await upsert_job_embeddings(db=db, job=job, model_name=model_name)
    except Exception as exc:
        logger.warning("Failed to upsert job embeddings (job_id={}): {}", job.id, exc)
        return None

    rows = (
        await db.execute(
            select(JobEmbeddingChunk.embedding)
            .where(JobEmbeddingChunk.job_id == job.id, JobEmbeddingChunk.model_name == model_name)
            .order_by(JobEmbeddingChunk.chunk_index.asc())
        )
    ).scalars().all()

    vectors = [r for r in rows if isinstance(r, list) and r]
    return _mean_vector(vectors)


async def _get_candidate_vector(db: AsyncSession, candidate: Candidate, *, model_name: str) -> list[float] | None:
    rows = (
        await db.execute(
            select(CandidateEmbeddingChunk.embedding)
            .where(
                CandidateEmbeddingChunk.candidate_id == candidate.id,
                CandidateEmbeddingChunk.model_name == model_name,
            )
            .order_by(CandidateEmbeddingChunk.chunk_index.asc())
        )
    ).scalars().all()

    vectors = [r for r in rows if isinstance(r, list) and r]
    if vectors:
        return _mean_vector(vectors)

    # Lazy backfill for older candidates that don't have embeddings yet.
    resume_text: str | None = None
    try:
        resume_text = extract_text_from_pdf(candidate.resume_pdf)
    except Exception as exc:
        # Fall back to details-only embeddings.
        logger.warning("Could not extract PDF text for candidate {} (using details-only): {}", candidate.id, exc)

    try:
        await upsert_candidate_embeddings(db=db, candidate=candidate, resume_text=resume_text or "", model_name=model_name)
    except Exception as exc:
        logger.warning("Failed to upsert candidate embeddings (candidate_id={}): {}", candidate.id, exc)
        return None

    rows = (
        await db.execute(
            select(CandidateEmbeddingChunk.embedding)
            .where(
                CandidateEmbeddingChunk.candidate_id == candidate.id,
                CandidateEmbeddingChunk.model_name == model_name,
            )
            .order_by(CandidateEmbeddingChunk.chunk_index.asc())
        )
    ).scalars().all()

    vectors = [r for r in rows if isinstance(r, list) and r]
    return _mean_vector(vectors)


async def cosine_shortlist(
    *,
    db: AsyncSession,
    job: Job,
    candidates: Iterable[Candidate],
    limit: int = 5,
    model_name: str = DEFAULT_EMBEDDING_MODEL,
) -> list[tuple[Candidate, float]]:
    job_vec = await _get_job_vector(db, job, model_name=model_name)
    if not job_vec:
        return []

    scored: list[tuple[Candidate, float]] = []
    for c in candidates:
        cand_vec = await _get_candidate_vector(db, c, model_name=model_name)
        if not cand_vec:
            continue
        scored.append((c, cosine_similarity(job_vec, cand_vec)))

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[: max(1, int(limit))]
