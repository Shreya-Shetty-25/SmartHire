from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from rank_bm25 import BM25Okapi

from .models import Candidate


_token_re = re.compile(r"[a-zA-Z0-9+#.]+")


def _tokens(text: str) -> list[str]:
    return [t.lower() for t in _token_re.findall(text or "") if t]


def _tokens_from_list(values: list[str] | None) -> list[str]:
    if not values:
        return []
    out: list[str] = []
    for v in values:
        if not v:
            continue
        out.extend(_tokens(str(v)))
    return out


def _tokens_from_candidate_education(candidate: Candidate) -> list[str]:
    parts: list[str] = []
    if candidate.college_details:
        parts.append(candidate.college_details)
    if candidate.school_details:
        parts.append(candidate.school_details)
    return _tokens("\n".join(parts))


def _tokens_from_candidate_location(candidate: Candidate) -> list[str]:
    loc = getattr(candidate, "location", None)
    return _tokens(str(loc)) if loc else []


def _idf_weighted_coverage(*, bm25: BM25Okapi, query_tokens: list[str], doc_tokens: list[str]) -> float:
    """0..1 similarity: fraction of query 'importance' covered by the doc.

    Uses BM25's learned IDF weights to avoid giving equal credit to common tokens.
    """

    if not query_tokens:
        return 0.0
    doc_set = set(doc_tokens)
    # rank_bm25 idf may contain negative values for ultra-common tokens; clamp at 0.
    weights = [max(float(bm25.idf.get(t, 0.0)), 0.0) for t in query_tokens]
    denom = sum(weights)
    if denom <= 0:
        # Fall back to plain token recall when IDF isn't usable.
        q = set(query_tokens)
        return (len(q & doc_set) / len(q)) if q else 0.0

    numer = 0.0
    for t, w in zip(query_tokens, weights, strict=False):
        if w and t in doc_set:
            numer += w
    return max(0.0, min(1.0, numer / denom))


def _yoe_similarity(*, candidate_years: int | None, job_years: int | None) -> float:
    if job_years is None:
        return 0.0
    if candidate_years is None:
        return 0.0
    if job_years <= 0:
        return 1.0
    return max(0.0, min(1.0, float(candidate_years) / float(job_years)))


@dataclass(frozen=True)
class JobRequirements:
    skills_required: list[str] | None = None
    additional_skills: list[str] | None = None
    education: str | None = None
    location: str | None = None
    years_experience: int | None = None


def bm25_shortlist(
    *,
    job: JobRequirements,
    candidates: Iterable[Candidate],
    limit: int,
    threshold: float = 0.7,
) -> list[tuple[Candidate, float]]:
    """Return top candidates with a 0..1 similarity score.

    Similarity is computed per-field:
    - skills: candidate.skills vs (job.skills_required + job.additional_skills)
    - education: (candidate.college_details + school_details) vs job.education
    - location: candidate.location vs job.location
    - yoe: candidate.years_experience vs job.years_experience

    A weighted average is returned; results below `threshold` are filtered out.
    """

    candidate_list = list(candidates)
    if not candidate_list:
        return []

    # Prepare per-field corpora so BM25 can compute sensible IDF weights.
    skills_docs = [_tokens_from_list(c.skills) for c in candidate_list]
    edu_docs = [_tokens_from_candidate_education(c) for c in candidate_list]
    loc_docs = [_tokens_from_candidate_location(c) for c in candidate_list]

    skills_bm25 = BM25Okapi(skills_docs) if sum(len(d) for d in skills_docs) else None
    edu_bm25 = BM25Okapi(edu_docs) if sum(len(d) for d in edu_docs) else None
    loc_bm25 = BM25Okapi(loc_docs) if sum(len(d) for d in loc_docs) else None

    job_skill_tokens = _tokens_from_list((job.skills_required or []) + (job.additional_skills or []))
    job_edu_tokens = _tokens(job.education or "")
    job_loc_tokens = _tokens(job.location or "")

    # If a requirement is missing on the job, we simply don't include it in the weighting.
    weights: dict[str, float] = {}
    if job_skill_tokens:
        weights["skills"] = 0.55
    if job_edu_tokens:
        weights["education"] = 0.2
    if job_loc_tokens:
        weights["location"] = 0.1
    if job.years_experience is not None:
        weights["yoe"] = 0.15

    weight_sum = sum(weights.values())
    if weight_sum <= 0:
        return []

    scored: list[tuple[Candidate, float]] = []
    for idx, c in enumerate(candidate_list):
        parts: list[tuple[float, float]] = []

        if "skills" in weights:
            if skills_bm25 is None:
                skills_sim = 0.0
            else:
                skills_sim = _idf_weighted_coverage(
                    bm25=skills_bm25,
                    query_tokens=job_skill_tokens,
                    doc_tokens=skills_docs[idx],
                )
            parts.append((skills_sim, weights["skills"]))

        if "education" in weights:
            if edu_bm25 is None:
                edu_sim = 0.0
            else:
                edu_sim = _idf_weighted_coverage(
                    bm25=edu_bm25,
                    query_tokens=job_edu_tokens,
                    doc_tokens=edu_docs[idx],
                )
            parts.append((edu_sim, weights["education"]))

        if "location" in weights:
            if loc_bm25 is None:
                loc_sim = 0.0
            else:
                loc_sim = _idf_weighted_coverage(
                    bm25=loc_bm25,
                    query_tokens=job_loc_tokens,
                    doc_tokens=loc_docs[idx],
                )
            parts.append((loc_sim, weights["location"]))

        if "yoe" in weights:
            yoe_sim = _yoe_similarity(candidate_years=getattr(c, "years_experience", None), job_years=job.years_experience)
            parts.append((yoe_sim, weights["yoe"]))

        combined = sum(sim * w for sim, w in parts) / weight_sum
        if combined >= threshold:
            scored.append((c, float(combined)))

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:limit]
