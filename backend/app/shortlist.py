from __future__ import annotations

import math
import re
from typing import Iterable

from rank_bm25 import BM25Okapi

from .models import Candidate


_token_re = re.compile(r"[a-zA-Z0-9+#.]+")


def _tokens(text: str) -> list[str]:
    return [t.lower() for t in _token_re.findall(text or "") if t]


def candidate_to_text(candidate: Candidate) -> str:
    parts: list[str] = [candidate.full_name or "", candidate.email or "", candidate.phone_number or ""]

    if candidate.college_details:
        parts.append(candidate.college_details)
    if candidate.school_details:
        parts.append(candidate.school_details)

    for arr in (
        candidate.skills,
        candidate.projects,
        candidate.work_experience,
        candidate.extra_curricular_activities,
        candidate.website_links,
    ):
        if arr:
            parts.extend([str(x) for x in arr if x])

    return "\n".join([p for p in parts if p]).strip()


def bm25_shortlist(
    *,
    query: str,
    candidates: Iterable[Candidate],
    limit: int,
) -> list[tuple[Candidate, float]]:
    candidate_list = list(candidates)
    corpus_tokens = [_tokens(candidate_to_text(c)) for c in candidate_list]

    if not corpus_tokens or sum(len(t) for t in corpus_tokens) == 0:
        return []

    query_tokens = _tokens(query)
    if not query_tokens:
        # If the query has no usable tokens, return candidates with 0 scores.
        return [(c, 0.0) for c in candidate_list[:limit]]

    bm25 = BM25Okapi(corpus_tokens)
    scores = bm25.get_scores(query_tokens)

    # Guard against NaN/inf scores (e.g., if avgdl is 0 due to empty docs).
    safe_scores: list[float] = []
    for s in scores:
        fs = float(s)
        safe_scores.append(fs if math.isfinite(fs) else 0.0)

    # Normalize to a 0-100 range for UI convenience (BM25 can be negative/unbounded).
    max_score = max(safe_scores) if safe_scores else 0.0
    min_score = min(safe_scores) if safe_scores else 0.0

    if not safe_scores or max_score == min_score:
        scored = [(candidate_list[i], 0.0) for i in range(len(candidate_list))]
    else:
        denom = (max_score - min_score)
        scored = [
            (candidate_list[i], (safe_scores[i] - min_score) / denom * 100.0)
            for i in range(len(candidate_list))
        ]

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:limit]
