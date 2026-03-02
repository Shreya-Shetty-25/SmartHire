from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field

from .models import Candidate, Job
from .resume_parser import _call_azure_openai, _call_gemini, _call_groq, _coerce_json_object, _selected_provider


class RankedCandidate(BaseModel):
    candidate_id: int
    score: float = Field(ge=0.0, le=100.0)
    passed: bool
    strengths: list[str] = Field(default_factory=list)
    concerns: list[str] = Field(default_factory=list)
    summary: str = ""


class RankResponse(BaseModel):
    results: list[RankedCandidate]


def _job_to_text(job: Job) -> str:
    parts: list[str] = [f"Title: {job.title}", f"Description: {job.description}"]
    if job.education:
        parts.append(f"Education: {job.education}")
    if job.years_experience is not None:
        parts.append(f"Years of experience: {job.years_experience}")
    if job.skills_required:
        parts.append("Skills required: " + ", ".join(job.skills_required))
    if job.additional_skills:
        parts.append("Additional skills: " + ", ".join(job.additional_skills))
    if job.location:
        parts.append(f"Location: {job.location}")
    if job.employment_type:
        parts.append(f"Employment type: {job.employment_type}")
    return "\n".join(parts)


def _candidate_to_compact(candidate: Candidate) -> dict[str, Any]:
    return {
        "id": candidate.id,
        "full_name": candidate.full_name,
        "email": candidate.email,
        "phone_number": candidate.phone_number,
        "college_details": candidate.college_details,
        "school_details": candidate.school_details,
        "skills": candidate.skills,
        "projects": candidate.projects,
        "work_experience": candidate.work_experience,
        "extra_curricular_activities": candidate.extra_curricular_activities,
        "website_links": candidate.website_links,
    }


async def rank_candidates_with_llm(*, job: Job, candidates: list[Candidate], threshold_score: float) -> list[RankedCandidate]:
    if not candidates:
        return []

    provider = _selected_provider()

    job_text = _job_to_text(job)
    candidate_payload = [_candidate_to_compact(c) for c in candidates]

    prompt = (
        "You are an expert technical recruiter.\n"
        "Rank candidates for the job below.\n\n"
        f"JOB\n{job_text}\n\n"
        "CANDIDATES (JSON)\n"
        + json.dumps(candidate_payload, ensure_ascii=False)
        + "\n\n"
        "Return ONLY a JSON object with this shape:\n"
        "{\n"
        '  "results": [\n'
        "    {\n"
        '      "candidate_id": 123,\n'
        '      "score": 0-100,\n'
        '      "passed": true|false,\n'
        '      "strengths": ["..."],\n'
        '      "concerns": ["..."],\n'
        '      "summary": "short 1-2 sentence justification"\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        f"Set passed=true only when score >= {threshold_score}.\n"
        "Be strict, do not hallucinate degrees/years; if missing, mention it as a concern."
    )

    if provider == "groq":
        raw = await _call_groq(prompt)
    elif provider == "azure_openai":
        raw = await _call_azure_openai(prompt)
    elif provider == "gemini":
        raw = await _call_gemini(prompt)
    else:
        raise HTTPException(status_code=500, detail="No LLM provider configured")

    try:
        obj = _coerce_json_object(raw)
        parsed = RankResponse.model_validate(obj)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM returned invalid ranking JSON: {exc}")

    # De-duplicate and keep only candidates we asked for.
    allowed_ids = {c.id for c in candidates}
    out: list[RankedCandidate] = []
    seen: set[int] = set()
    for item in parsed.results:
        if item.candidate_id not in allowed_ids:
            continue
        if item.candidate_id in seen:
            continue
        seen.add(item.candidate_id)
        out.append(item)

    # Ensure every candidate has a result (fallback score 0)
    missing = [c for c in candidates if c.id not in seen]
    for c in missing:
        out.append(
            RankedCandidate(
                candidate_id=c.id,
                score=0.0,
                passed=False,
                strengths=[],
                concerns=["No ranking produced by model"],
                summary="",
            )
        )

    out.sort(key=lambda x: x.score, reverse=True)
    return out
