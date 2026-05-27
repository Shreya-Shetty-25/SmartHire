"""Bulk resume import — accept a ZIP containing up to 100 PDF/image resumes."""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..background_jobs import schedule_candidate_embeddings
from ..db import get_db
from ..deps import get_current_admin
from ..models import Candidate, User
from ..resume_parser import extract_text_from_pdf, parse_resume_pdf

router = APIRouter(prefix="/api/hire/bulk-import", tags=["bulk_import"])

_ALLOWED_EXTS = {".pdf", ".png", ".jpg", ".jpeg"}
_MAX_FILES = 100
_MAX_ZIP_BYTES = 200 * 1024 * 1024  # 200 MB


@dataclass
class ImportResult:
    filename: str
    status: str  # "created" | "duplicate" | "failed"
    candidate_id: int | None = None
    email: str | None = None
    error: str | None = None


def _normalize_phone(phone: str | None) -> str | None:
    if not phone:
        return None
    digits = "".join(c for c in phone if c.isdigit())
    return digits[-10:] if len(digits) >= 10 else (digits or None)


async def _import_single(
    filename: str,
    raw: bytes,
    db: AsyncSession,
) -> ImportResult:
    """Parse and upsert one resume file. Returns an ImportResult."""
    try:
        text = extract_text_from_pdf(raw)
        if not text or len(text.strip()) < 30:
            return ImportResult(filename=filename, status="failed", error="Could not extract text")

        parsed = await parse_resume_pdf(raw)
        email = str(parsed.get("email") or "").strip().lower()
        if not email or "@" not in email:
            return ImportResult(filename=filename, status="failed", error="No valid email found")

        # Duplicate detection by email
        existing = await db.scalar(select(Candidate).where(Candidate.email == email))
        if existing:
            return ImportResult(filename=filename, status="duplicate", candidate_id=existing.id, email=email)

        # Normalize phone for future duplicate detection
        phone_raw = parsed.get("phone_number") or None
        phone_norm = _normalize_phone(phone_raw)

        cand = Candidate(
            full_name=str(parsed.get("full_name") or "Unknown").strip() or "Unknown",
            email=email,
            phone_number=phone_raw,
            phone_normalized=phone_norm,
            college_details=parsed.get("college_details"),
            school_details=parsed.get("school_details"),
            projects=parsed.get("projects") or [],
            skills=parsed.get("skills") or [],
            work_experience=parsed.get("work_experience") or [],
            extra_curricular_activities=parsed.get("extra_curricular_activities") or [],
            website_links=parsed.get("website_links") or [],
            years_experience=parsed.get("years_experience"),
            location=parsed.get("location"),
            certifications=parsed.get("certifications") or [],
            resume_filename=filename,
            resume_pdf=raw,
        )
        db.add(cand)
        await db.flush()  # get cand.id

        try:
            schedule_candidate_embeddings(cand.id)
        except Exception as exc:
            logger.warning("Failed to schedule embeddings for bulk import candidate {}: {}", cand.id, exc)

        return ImportResult(filename=filename, status="created", candidate_id=cand.id, email=email)

    except Exception as exc:
        logger.warning("Bulk import failed for {}: {}", filename, exc)
        return ImportResult(filename=filename, status="failed", error=str(exc)[:200])


@router.post("", status_code=status.HTTP_200_OK)
async def bulk_import_resumes(
    zip_file: UploadFile = File(..., description="ZIP archive containing PDF/image resumes"),
    source_tag: str = Query(default="bulk_import", max_length=64),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> dict:
    """
    Upload a ZIP file containing up to 100 PDF/image resumes.
    Each resume is parsed, a Candidate record is created (or marked duplicate),
    and embeddings are scheduled in the background.
    Returns a summary with per-file results.
    """
    if not zip_file.content_type or "zip" not in (zip_file.content_type or ""):
        # also accept octet-stream
        if zip_file.filename and not zip_file.filename.lower().endswith(".zip"):
            raise HTTPException(status_code=400, detail="Only ZIP files are accepted")

    raw_zip = await zip_file.read()
    if len(raw_zip) > _MAX_ZIP_BYTES:
        raise HTTPException(status_code=413, detail=f"ZIP file too large (max {_MAX_ZIP_BYTES // 1024 // 1024} MB)")

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_zip))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Invalid or corrupted ZIP file")

    entries = [
        n for n in zf.namelist()
        if not n.endswith("/")
        and any(n.lower().endswith(ext) for ext in _ALLOWED_EXTS)
        and not n.startswith("__MACOSX")
    ]

    if not entries:
        raise HTTPException(status_code=400, detail="ZIP contains no supported resume files (.pdf, .png, .jpg, .jpeg)")

    if len(entries) > _MAX_FILES:
        raise HTTPException(status_code=400, detail=f"ZIP contains {len(entries)} files — maximum allowed is {_MAX_FILES}")

    results: list[ImportResult] = []
    for name in entries:
        try:
            file_bytes = zf.read(name)
        except Exception as exc:
            results.append(ImportResult(filename=name, status="failed", error=f"Could not read file: {exc}"))
            continue

        result = await _import_single(name, file_bytes, db)
        results.append(result)

    await db.commit()

    created = [r for r in results if r.status == "created"]
    duplicates = [r for r in results if r.status == "duplicate"]
    failed = [r for r in results if r.status == "failed"]

    return {
        "total_files": len(entries),
        "created": len(created),
        "duplicates": len(duplicates),
        "failed": len(failed),
        "source_tag": source_tag,
        "results": [
            {
                "filename": r.filename,
                "status": r.status,
                "candidate_id": r.candidate_id,
                "email": r.email,
                "error": r.error,
            }
            for r in results
        ],
    }
