"""API routes for AI-powered candidate insights.

- /api/insights/red-flags/{candidate_id}         – resume credibility analysis
- /api/insights/skill-decay/{candidate_id}        – skill freshness analysis
- /api/insights/candidate-memory/{candidate_id}   – longitudinal cross-cycle intelligence
- /api/insights/{candidate_id}/summary            – combined badge data for cards
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from loguru import logger
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ai_insights import (
    analyze_red_flags,
    analyze_reapplicant,
    analyze_skill_decay,
    build_candidate_snapshot,
)
from ..db import get_db
from ..deps import get_current_admin
from ..models import (
    Candidate,
    CandidateMemory,
    CandidateRedFlag,
    CandidateSkillDecay,
    Job,
    JobCandidateProgress,
    User,
)

router = APIRouter(prefix="/api/insights", tags=["insights"])


# ── 1. Red-Flag Detector ─────────────────────────────────────────────────────


@router.post("/red-flags/{candidate_id}")
async def run_red_flag_analysis(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    """Run LLM-powered resume credibility analysis on a candidate."""
    candidate = await db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    result = await analyze_red_flags(candidate)

    # Upsert: delete old, insert new
    await db.execute(
        delete(CandidateRedFlag).where(CandidateRedFlag.candidate_id == candidate_id)
    )
    record = CandidateRedFlag(
        candidate_id=candidate_id,
        credibility_score=result["credibility_score"],
        flags=result["flags"],
        summary=result["summary"],
        raw_llm_response=result.get("raw_llm_response"),
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)

    return {
        "candidate_id": candidate_id,
        "credibility_score": record.credibility_score,
        "flags": record.flags,
        "summary": record.summary,
        "analyzed_at": record.updated_at.isoformat() if record.updated_at else record.created_at.isoformat(),
    }


@router.get("/red-flags/{candidate_id}")
async def get_red_flag_analysis(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    """Get the latest red-flag analysis for a candidate (if available)."""
    row = (
        await db.execute(
            select(CandidateRedFlag)
            .where(CandidateRedFlag.candidate_id == candidate_id)
            .order_by(CandidateRedFlag.updated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    if not row:
        return {"candidate_id": candidate_id, "available": False}

    return {
        "candidate_id": candidate_id,
        "available": True,
        "credibility_score": row.credibility_score,
        "flags": row.flags,
        "summary": row.summary,
        "analyzed_at": row.updated_at.isoformat() if row.updated_at else row.created_at.isoformat(),
    }


# ── 2. Skills Decay Analyzer ─────────────────────────────────────────────────


@router.post("/skill-decay/{candidate_id}")
async def run_skill_decay_analysis(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    """Run LLM-powered skill-freshness analysis on a candidate."""
    candidate = await db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    result = await analyze_skill_decay(candidate)

    # Upsert
    await db.execute(
        delete(CandidateSkillDecay).where(CandidateSkillDecay.candidate_id == candidate_id)
    )
    record = CandidateSkillDecay(
        candidate_id=candidate_id,
        stale_skills=result["stale_skills"],
        evergreen_skills=result["evergreen_skills"],
        overall_freshness_score=result["overall_freshness_score"],
        raw_llm_response=result.get("raw_llm_response"),
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)

    return {
        "candidate_id": candidate_id,
        "stale_skills": record.stale_skills,
        "evergreen_skills": record.evergreen_skills,
        "overall_freshness_score": record.overall_freshness_score,
        "analyzed_at": record.updated_at.isoformat() if record.updated_at else record.created_at.isoformat(),
    }


@router.get("/skill-decay/{candidate_id}")
async def get_skill_decay_analysis(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    """Get the latest skill-decay analysis for a candidate (if available)."""
    row = (
        await db.execute(
            select(CandidateSkillDecay)
            .where(CandidateSkillDecay.candidate_id == candidate_id)
            .order_by(CandidateSkillDecay.updated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    if not row:
        return {"candidate_id": candidate_id, "available": False}

    return {
        "candidate_id": candidate_id,
        "available": True,
        "stale_skills": row.stale_skills,
        "evergreen_skills": row.evergreen_skills,
        "overall_freshness_score": row.overall_freshness_score,
        "analyzed_at": row.updated_at.isoformat() if row.updated_at else row.created_at.isoformat(),
    }


# ── 3. Longitudinal Candidate Memory ─────────────────────────────────────────


@router.get("/candidate-memory/{candidate_id}")
async def get_candidate_memory(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    """Get all stored cross-cycle memories for a candidate."""
    rows = (
        await db.execute(
            select(CandidateMemory)
            .where(CandidateMemory.candidate_id == candidate_id)
            .order_by(CandidateMemory.created_at.asc())
        )
    ).scalars().all()

    return {
        "candidate_id": candidate_id,
        "total_cycles": len(rows),
        "memories": [
            {
                "id": m.id,
                "job_id": m.job_id,
                "cycle_number": m.cycle_number,
                "outcome": m.outcome,
                "gaps_identified": m.gaps_identified,
                "strengths_noted": m.strengths_noted,
                "rejection_reasons": m.rejection_reasons,
                "snapshot": m.snapshot,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in rows
        ],
    }


@router.post("/candidate-memory/{candidate_id}/record")
async def record_candidate_memory(
    candidate_id: int,
    job_id: int,
    outcome: str = "rejected",
    gaps: str | None = None,
    rejection_reasons: str | None = None,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    """Record a candidate's application outcome for future cross-cycle intelligence.

    This should be called when a candidate is rejected or hired — it saves a
    snapshot of their current profile + the identified gaps/reasons so the AI
    can compare if they reapply later.
    """
    candidate = await db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Determine cycle number
    existing_count = (
        await db.execute(
            select(CandidateMemory)
            .where(CandidateMemory.candidate_id == candidate_id)
        )
    ).scalars().all()
    cycle = len(existing_count) + 1

    # Run red-flag analysis to capture gap data automatically
    red_flag_result = await analyze_red_flags(candidate)
    skill_decay_result = await analyze_skill_decay(candidate)

    gaps_list = [g.strip() for g in (gaps or "").split(",") if g.strip()] or None
    rejection_list = [r.strip() for r in (rejection_reasons or "").split(",") if r.strip()] or None

    # Merge auto-detected gaps
    auto_gaps: list[str] = []
    for flag in red_flag_result.get("flags") or []:
        if isinstance(flag, dict):
            auto_gaps.append(f"[{flag.get('type', 'unknown')}] {flag.get('explanation', '')}")
    for stale in skill_decay_result.get("stale_skills") or []:
        if isinstance(stale, dict):
            auto_gaps.append(f"[stale_skill] {stale.get('skill', '')} — {stale.get('reason', '')}")

    all_gaps = (gaps_list or []) + auto_gaps or None

    # Build strengths from current profile
    strengths = []
    if candidate.skills:
        strengths.append(f"Skills: {', '.join(candidate.skills[:10])}")
    if candidate.certifications:
        strengths.append(f"Certifications: {', '.join(candidate.certifications[:5])}")
    if candidate.projects:
        strengths.append(f"{len(candidate.projects)} project(s) listed")

    memory = CandidateMemory(
        candidate_id=candidate_id,
        job_id=job_id,
        cycle_number=cycle,
        outcome=outcome,
        gaps_identified=all_gaps,
        strengths_noted=strengths or None,
        rejection_reasons=rejection_list,
        snapshot=build_candidate_snapshot(candidate),
    )
    db.add(memory)
    await db.commit()
    await db.refresh(memory)

    return {
        "ok": True,
        "memory_id": memory.id,
        "cycle_number": cycle,
        "gaps_identified": all_gaps,
        "strengths_noted": strengths,
    }


@router.post("/candidate-memory/{candidate_id}/analyze-reapplication")
async def analyze_reapplication(
    candidate_id: int,
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    """Analyze a returning candidate against their previous application history.

    Checks if they've addressed past gaps and recommends whether to fast-track.
    """
    candidate = await db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    past_memories = (
        await db.execute(
            select(CandidateMemory)
            .where(CandidateMemory.candidate_id == candidate_id)
            .order_by(CandidateMemory.created_at.asc())
        )
    ).scalars().all()

    if not past_memories:
        return {
            "candidate_id": candidate_id,
            "is_returning": False,
            "message": "No previous application history found. This appears to be a first-time applicant.",
        }

    result = await analyze_reapplicant(
        candidate=candidate,
        job=job,
        past_memories=list(past_memories),
    )

    return {
        "candidate_id": candidate_id,
        "job_id": job_id,
        "is_returning": True,
        "previous_cycles": len(past_memories),
        **result,
    }


# ── Combined summary for candidate cards ──────────────────────────────────────


@router.get("/{candidate_id}/summary")
async def get_insights_summary(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    """Lightweight endpoint returning badge-level data for candidate cards."""
    red_flag = (
        await db.execute(
            select(CandidateRedFlag)
            .where(CandidateRedFlag.candidate_id == candidate_id)
            .order_by(CandidateRedFlag.updated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    skill_decay = (
        await db.execute(
            select(CandidateSkillDecay)
            .where(CandidateSkillDecay.candidate_id == candidate_id)
            .order_by(CandidateSkillDecay.updated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    memory_count_result = await db.execute(
        select(CandidateMemory).where(CandidateMemory.candidate_id == candidate_id)
    )
    memory_count = len(memory_count_result.scalars().all())

    return {
        "candidate_id": candidate_id,
        "red_flags": {
            "available": red_flag is not None,
            "credibility_score": red_flag.credibility_score if red_flag else None,
            "flag_count": len(red_flag.flags) if red_flag and red_flag.flags else 0,
        },
        "skill_decay": {
            "available": skill_decay is not None,
            "freshness_score": skill_decay.overall_freshness_score if skill_decay else None,
            "stale_count": len(skill_decay.stale_skills) if skill_decay and skill_decay.stale_skills else 0,
        },
        "memory": {
            "is_returning": memory_count > 0,
            "previous_cycles": memory_count,
        },
    }


# ── Bulk analysis (run all insights for a candidate) ──────────────────────────


@router.post("/{candidate_id}/analyze-all")
async def run_all_analyses(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
) -> dict:
    """Run both red-flag and skill-decay analyses in one call."""
    candidate = await db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    red_flag_result = await analyze_red_flags(candidate)
    skill_decay_result = await analyze_skill_decay(candidate)

    # Upsert red flags
    await db.execute(
        delete(CandidateRedFlag).where(CandidateRedFlag.candidate_id == candidate_id)
    )
    rf = CandidateRedFlag(
        candidate_id=candidate_id,
        credibility_score=red_flag_result["credibility_score"],
        flags=red_flag_result["flags"],
        summary=red_flag_result["summary"],
        raw_llm_response=red_flag_result.get("raw_llm_response"),
    )
    db.add(rf)

    # Upsert skill decay
    await db.execute(
        delete(CandidateSkillDecay).where(CandidateSkillDecay.candidate_id == candidate_id)
    )
    sd = CandidateSkillDecay(
        candidate_id=candidate_id,
        stale_skills=skill_decay_result["stale_skills"],
        evergreen_skills=skill_decay_result["evergreen_skills"],
        overall_freshness_score=skill_decay_result["overall_freshness_score"],
        raw_llm_response=skill_decay_result.get("raw_llm_response"),
    )
    db.add(sd)

    await db.commit()

    return {
        "candidate_id": candidate_id,
        "red_flags": {
            "credibility_score": rf.credibility_score,
            "flag_count": len(rf.flags) if rf.flags else 0,
            "flags": rf.flags,
            "summary": rf.summary,
        },
        "skill_decay": {
            "freshness_score": sd.overall_freshness_score,
            "stale_count": len(sd.stale_skills) if sd.stale_skills else 0,
            "stale_skills": sd.stale_skills,
            "evergreen_skills": sd.evergreen_skills,
        },
    }
