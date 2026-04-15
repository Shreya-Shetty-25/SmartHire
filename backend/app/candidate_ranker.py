from __future__ import annotations

import json
import math
from typing import Any

from fastapi import HTTPException
from loguru import logger
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
    breakdown: dict[str, Any] | None = None


class RankResponse(BaseModel):
    results: list[RankedCandidate]


def _tokenize(value: str | None) -> set[str]:
    if not value:
        return set()
    out: set[str] = set()
    for raw in str(value).replace("/", " ").replace("-", " ").split():
        token = raw.strip().lower().strip(".,()[]{}:;")
        if token:
            out.add(token)
    return out


def _list_tokens(values: list[str] | None) -> set[str]:
    out: set[str] = set()
    for value in values or []:
        out.update(_tokenize(value))
    return out


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
        "years_experience": getattr(candidate, "years_experience", None),
        "location": getattr(candidate, "location", None),
        "certifications": getattr(candidate, "certifications", None),
        "resume_filename": getattr(candidate, "resume_filename", None),
    }


def _heuristic_rank_candidates(*, job: Job, candidates: list[Candidate], threshold_score: float) -> list[RankedCandidate]:
    required_skills = [str(skill).strip() for skill in (job.skills_required or []) if str(skill).strip()]
    additional_skills = [str(skill).strip() for skill in (job.additional_skills or []) if str(skill).strip()]
    required_tokens = _list_tokens(required_skills)
    additional_tokens = _list_tokens(additional_skills)
    job_location_tokens = _tokenize(job.location)
    job_education_tokens = _tokenize(job.education)

    ranked: list[RankedCandidate] = []
    for candidate in candidates:
        candidate_skill_tokens = _list_tokens(candidate.skills)
        required_overlap = len(candidate_skill_tokens & required_tokens)
        additional_overlap = len(candidate_skill_tokens & additional_tokens)

        required_score = 40.0 if not required_tokens else min(40.0, (required_overlap / max(len(required_tokens), 1)) * 40.0)
        additional_score = 15.0 if not additional_tokens else min(15.0, (additional_overlap / max(len(additional_tokens), 1)) * 15.0)

        experience_score = 15.0
        experience_notes = "Job did not specify a required experience threshold."
        if job.years_experience is not None:
            candidate_years = float(candidate.years_experience or 0)
            ratio = candidate_years / max(float(job.years_experience or 1), 1.0)
            experience_score = max(0.0, min(15.0, ratio * 15.0))
            if candidate.years_experience is None:
                experience_notes = "Candidate resume does not clearly state years of experience."
            elif candidate_years >= float(job.years_experience):
                experience_notes = f"Candidate meets the {job.years_experience}+ years expectation."
            else:
                experience_notes = f"Candidate appears below the {job.years_experience}+ years expectation."

        location_score = 10.0
        location_notes = "Location requirement is flexible or not specified."
        if job_location_tokens:
            candidate_location_tokens = _tokenize(candidate.location)
            overlap = len(candidate_location_tokens & job_location_tokens)
            if overlap:
                location_score = 10.0
                location_notes = "Candidate location appears aligned with the role."
            else:
                location_score = 4.0 if candidate.location else 2.0
                location_notes = "Candidate location does not clearly match the job location."

        education_score = 10.0 if not job_education_tokens else 3.0
        education_notes = "Education requirement not specified."
        if job_education_tokens:
            candidate_education_tokens = _tokenize(candidate.college_details) | _tokenize(candidate.school_details)
            overlap = len(candidate_education_tokens & job_education_tokens)
            if overlap:
                education_score = 10.0
                education_notes = "Candidate education details align with the stated requirement."
            elif candidate.college_details or candidate.school_details:
                education_score = 6.0
                education_notes = "Candidate has education history, but the exact requirement match is unclear."
            else:
                education_score = 2.0
                education_notes = "Candidate education details are missing."

        cert_project_score = 10.0
        cert_project_notes = "Candidate has supporting project or certification evidence."
        evidence_count = len(candidate.projects or []) + len(candidate.certifications or [])
        if evidence_count <= 0:
            cert_project_score = 3.0
            cert_project_notes = "Resume does not show many projects or certifications."
        elif evidence_count == 1:
            cert_project_score = 6.0
            cert_project_notes = "Resume shows limited project or certification evidence."

        total_score = round(required_score + additional_score + experience_score + location_score + education_score + cert_project_score, 1)
        total_score = max(0.0, min(100.0, total_score))

        strengths: list[str] = []
        concerns: list[str] = []
        if required_overlap:
            strengths.append(f"Matched {required_overlap} required skill area(s).")
        if additional_overlap:
            strengths.append(f"Matched {additional_overlap} additional skill area(s).")
        if candidate.years_experience and (job.years_experience is None or candidate.years_experience >= job.years_experience):
            strengths.append("Experience level looks strong for the role.")
        if len(candidate.projects or []) > 0:
            strengths.append("Resume includes project work relevant for screening.")

        if required_tokens and required_overlap == 0:
            concerns.append("No direct overlap found with the core required skills.")
        elif required_tokens and required_overlap < max(1, math.ceil(len(required_tokens) / 2)):
            concerns.append("Only a partial match was found against the required skills.")
        if job.years_experience is not None and (candidate.years_experience or 0) < job.years_experience:
            concerns.append("Years of experience appear below the target.")
        if job_location_tokens and not (_tokenize(candidate.location) & job_location_tokens):
            concerns.append("Candidate location may need recruiter review.")
        if not (candidate.college_details or candidate.school_details):
            concerns.append("Education details are limited in the resume.")

        summary = (
            "Heuristic fallback ranking used because the configured LLM provider was unavailable. "
            f"Candidate matched {required_overlap} required skill area(s) and scored {total_score:.1f}/100."
        )

        ranked.append(
            RankedCandidate(
                candidate_id=candidate.id,
                score=total_score,
                passed=bool(total_score >= float(threshold_score)),
                strengths=strengths[:4],
                concerns=concerns[:4],
                summary=summary,
                breakdown={
                    "skills_score": round(required_score + additional_score, 1),
                    "skills_notes": (
                        f"Required matches: {required_overlap}/{max(len(required_tokens), 1)}; "
                        f"additional matches: {additional_overlap}/{max(len(additional_tokens), 1)}."
                    ),
                    "experience_score": round(experience_score, 1),
                    "experience_notes": experience_notes,
                    "education_score": round(education_score, 1),
                    "education_notes": education_notes,
                    "location_score": round(location_score, 1),
                    "location_notes": location_notes,
                    "supporting_evidence_score": round(cert_project_score, 1),
                    "supporting_evidence_notes": cert_project_notes,
                },
            )
        )

    ranked.sort(key=lambda item: item.score, reverse=True)
    return ranked


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
        '      "breakdown": {\n'
        '        "skills_score": 0-100,\n'
        '        "skills_notes": "...",\n'
        '        "experience_score": 0-100,\n'
        '        "experience_notes": "...",\n'
        '        "education_score": 0-100,\n'
        '        "education_notes": "...",\n'
        '        "location_score": 0-100,\n'
        '        "location_notes": "..."\n'
        "      },\n"
        '      "strengths": ["..."],\n'
        '      "concerns": ["..."],\n'
        '      "summary": "short 1-2 sentence justification"\n'
        "    }\n"
        "  ]\n"
        "}\n\n"
        f"Set passed=true only when score >= {threshold_score}.\n"
        "Be strict, do not hallucinate degrees/years; if missing, mention it as a concern.\n"
        "Breakdown rules: scores must be numbers 0-100; notes must be short and factual."
    )

    try:
        if provider == "groq":
            raw = await _call_groq(prompt)
        elif provider == "azure":
            raw = await _call_azure_openai(prompt)
        elif provider == "gemini":
            raw = await _call_gemini(prompt)
        else:
            raise HTTPException(status_code=500, detail="No LLM provider configured")
    except HTTPException as exc:
        # Keep ranking usable even when the configured model endpoint is down.
        if exc.status_code >= 500:
            logger.warning(
                "LLM ranking fallback engaged for provider={} status={} detail={}",
                provider,
                exc.status_code,
                getattr(exc, "detail", None),
            )
            return _heuristic_rank_candidates(job=job, candidates=candidates, threshold_score=threshold_score)
        raise
    except Exception as exc:
        logger.warning("Unexpected ranking provider error for provider={}: {}", provider, repr(exc))
        return _heuristic_rank_candidates(job=job, candidates=candidates, threshold_score=threshold_score)

    try:
        obj = _coerce_json_object(raw)
        parsed = RankResponse.model_validate(obj)
    except Exception as exc:
        return _heuristic_rank_candidates(job=job, candidates=candidates, threshold_score=threshold_score)

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
