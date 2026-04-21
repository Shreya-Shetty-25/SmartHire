"""AI-powered candidate insight engines.

1. Resume Red-Flag Detector   – credibility analysis
2. Skills Decay Analyzer      – recency-based skill freshness
3. Longitudinal Candidate Memory – cross-cycle intelligence
"""

from __future__ import annotations

import json
from typing import Any

from loguru import logger

from .models import Candidate, CandidateMemory, Job
from .resume_parser import _call_azure_openai, _call_cerebras, _call_gemini, _call_groq, _coerce_json_object, _selected_provider


# ── LLM helper ────────────────────────────────────────────────────────────────

async def _llm_json(prompt: str) -> dict[str, Any]:
    """Call LLM with fallback chain: Azure > Groq > Cerebras > Gemini."""
    call_fn = {
        "azure": _call_azure_openai,
        "groq": _call_groq,
        "cerebras": _call_cerebras,
        "gemini": _call_gemini,
    }
    fallback_order = ["azure", "groq", "cerebras", "gemini"]

    provider = _selected_provider()
    ordered = [provider] + [p for p in fallback_order if p != provider]

    last_exc: Exception | None = None
    for prov in ordered:
        fn = call_fn.get(prov)
        if fn is None:
            continue
        try:
            raw = await fn(prompt)
            obj = _coerce_json_object(raw)
            if obj is None:
                raise RuntimeError(f"LLM returned non-JSON response: {raw[:300]}")
            return obj
        except Exception as exc:
            logger.warning("AI insights LLM call failed for provider={}: {}", prov, repr(exc))
            last_exc = exc
            continue

    raise RuntimeError(f"All LLM providers failed for AI insights. Last error: {last_exc}")


def _candidate_text(c: Candidate) -> str:
    """Build a compact text representation of a candidate's resume data."""
    parts: list[str] = [
        f"Name: {c.full_name}",
        f"Email: {c.email}",
    ]
    if c.phone_number:
        parts.append(f"Phone: {c.phone_number}")
    if c.college_details:
        parts.append(f"College: {c.college_details}")
    if c.school_details:
        parts.append(f"School: {c.school_details}")
    if c.years_experience is not None:
        parts.append(f"Years of experience: {c.years_experience}")
    if c.location:
        parts.append(f"Location: {c.location}")
    if c.skills:
        parts.append(f"Skills: {', '.join(c.skills)}")
    if c.work_experience:
        parts.append("Work experience:\n" + "\n".join(f"  - {w}" for w in c.work_experience))
    if c.projects:
        parts.append("Projects:\n" + "\n".join(f"  - {p}" for p in c.projects))
    if c.certifications:
        parts.append("Certifications:\n" + "\n".join(f"  - {cert}" for cert in c.certifications))
    if c.extra_curricular_activities:
        parts.append("Extra-curricular:\n" + "\n".join(f"  - {a}" for a in c.extra_curricular_activities))
    return "\n".join(parts)


# ── 1. Resume Red-Flag Detector ──────────────────────────────────────────────

_RED_FLAG_PROMPT = """\
You are an expert resume fraud-detection analyst. Analyze the following resume data
and look for deception signals. Check for ALL of the following:

1. **Employment gaps** – unexplained time gaps between roles
2. **Inflated titles** – job titles that seem inflated relative to described responsibilities
3. **Suspiciously round numbers** – "10 years of everything", "5 projects" with no detail
4. **Overlapping dates** – employment dates that overlap impossibly
5. **Certification mismatches** – certifications that don't match claimed experience level or timeline
6. **Vague descriptions** – roles with no measurable outcomes or specific contributions
7. **Skill count inflation** – claiming mastery of an unrealistic number of technologies

Return a JSON object with exactly these keys:
{{
  "credibility_score": <float 0-100, where 100 = fully credible>,
  "flags": [
    {{
      "type": "<gap|inflated_title|round_numbers|overlap|cert_mismatch|vague|skill_inflation>",
      "severity": "<low|medium|high>",
      "excerpt": "<the specific resume text that triggered this flag>",
      "explanation": "<why this is suspicious>"
    }}
  ],
  "summary": "<2-3 sentence overall credibility assessment>"
}}

If no flags are found, return credibility_score=100 and an empty flags array.

RESUME DATA:
{resume_text}
"""


async def analyze_red_flags(candidate: Candidate) -> dict[str, Any]:
    """Run the red-flag detector on a single candidate."""
    resume_text = _candidate_text(candidate)
    prompt = _RED_FLAG_PROMPT.format(resume_text=resume_text)

    try:
        result = await _llm_json(prompt)
    except Exception as exc:
        logger.warning("Red-flag analysis failed for candidate {}: {}", candidate.id, exc)
        return {
            "credibility_score": -1,
            "flags": [],
            "summary": f"Analysis failed: {exc}",
            "raw_llm_response": None,
        }

    score = float(result.get("credibility_score", -1))
    flags = result.get("flags") or []
    summary = str(result.get("summary") or "")

    return {
        "credibility_score": max(0.0, min(100.0, score)),
        "flags": flags if isinstance(flags, list) else [],
        "summary": summary,
        "raw_llm_response": result,
    }


# ── 2. Skills Decay Analyzer ─────────────────────────────────────────────────

_SKILL_DECAY_PROMPT = """\
You are a technical recruiter and skills-recency analyst. Given the resume data below,
analyze each claimed skill for recency and relevance.

Rules:
- A skill mentioned ONLY in old work experience (e.g. a 2018 role) and never in recent
  projects/roles is "stale".
- Framework-specific skills (e.g. AngularJS 1.x, jQuery, Struts) decay fast.
- Evergreen skills (SQL, algorithms, data structures, system design, communication) don't decay.
- If the resume lacks dates, estimate based on ordering (first = oldest).

Return a JSON object with exactly these keys:
{{
  "stale_skills": [
    {{
      "skill": "<skill name>",
      "last_seen_context": "<where it was last mentioned, e.g. 'Infosys role (2018)'>",
      "decay_rate": "<fast|medium|slow>",
      "reason": "<why it's considered stale>"
    }}
  ],
  "evergreen_skills": ["<skill1>", "<skill2>"],
  "overall_freshness_score": <float 0-100, where 100 = all skills are current>
}}

If all skills are current, return an empty stale_skills array and score=100.

RESUME DATA:
{resume_text}
"""


async def analyze_skill_decay(candidate: Candidate) -> dict[str, Any]:
    """Run the skill-decay analyzer on a single candidate."""
    resume_text = _candidate_text(candidate)
    prompt = _SKILL_DECAY_PROMPT.format(resume_text=resume_text)

    try:
        result = await _llm_json(prompt)
    except Exception as exc:
        logger.warning("Skill-decay analysis failed for candidate {}: {}", candidate.id, exc)
        return {
            "stale_skills": [],
            "evergreen_skills": [],
            "overall_freshness_score": -1,
            "raw_llm_response": None,
        }

    stale = result.get("stale_skills") or []
    evergreen = result.get("evergreen_skills") or []
    freshness = float(result.get("overall_freshness_score", -1))

    return {
        "stale_skills": stale if isinstance(stale, list) else [],
        "evergreen_skills": evergreen if isinstance(evergreen, list) else [],
        "overall_freshness_score": max(0.0, min(100.0, freshness)),
        "raw_llm_response": result,
    }


# ── 3. Longitudinal Candidate Memory ─────────────────────────────────────────

_REAPPLICANT_PROMPT = """\
You are an HR intelligence analyst. A candidate who was previously evaluated is reapplying.

PREVIOUS APPLICATION HISTORY:
{history_json}

CURRENT RESUME DATA:
{resume_text}

JOB BEING APPLIED FOR:
{job_text}

Analyze:
1. What gaps were identified in previous applications?
2. Has the candidate addressed those gaps (new skills, certifications, projects, experience)?
3. What new strengths have they developed since last application?
4. Should this candidate be fast-tracked, given standard review, or flagged for concern?

Return a JSON object:
{{
  "gaps_addressed": [
    {{
      "gap": "<what was missing before>",
      "addressed": <true|false>,
      "evidence": "<what in the current resume addresses this gap, or 'Not addressed'>"
    }}
  ],
  "new_strengths": ["<new skill/cert/project not present in previous application>"],
  "recommendation": "<fast_track|standard_review|flag_concern>",
  "recommendation_reason": "<2-3 sentence explanation>",
  "growth_score": <float 0-100, measuring improvement since last application>
}}
"""


def _build_history_json(memories: list[CandidateMemory]) -> str:
    """Serialize past application memories into a compact JSON string."""
    entries: list[dict[str, Any]] = []
    for m in memories:
        entries.append({
            "cycle": m.cycle_number,
            "job_id": m.job_id,
            "outcome": m.outcome,
            "gaps": m.gaps_identified or [],
            "strengths": m.strengths_noted or [],
            "rejection_reasons": m.rejection_reasons or [],
            "applied_at": m.created_at.isoformat() if m.created_at else None,
            "snapshot": m.snapshot or {},
        })
    return json.dumps(entries, default=str, indent=2)


def _job_text(job: Job) -> str:
    parts: list[str] = [f"Title: {job.title}", f"Description: {job.description}"]
    if job.education:
        parts.append(f"Education: {job.education}")
    if job.years_experience is not None:
        parts.append(f"Years of experience required: {job.years_experience}")
    if job.skills_required:
        parts.append("Required skills: " + ", ".join(job.skills_required))
    if job.additional_skills:
        parts.append("Additional skills: " + ", ".join(job.additional_skills))
    if job.location:
        parts.append(f"Location: {job.location}")
    return "\n".join(parts)


async def analyze_reapplicant(
    *,
    candidate: Candidate,
    job: Job,
    past_memories: list[CandidateMemory],
) -> dict[str, Any]:
    """Analyze a returning candidate against their previous application history."""
    resume_text = _candidate_text(candidate)
    history_json = _build_history_json(past_memories)
    job_desc = _job_text(job)

    prompt = _REAPPLICANT_PROMPT.format(
        history_json=history_json,
        resume_text=resume_text,
        job_text=job_desc,
    )

    try:
        result = await _llm_json(prompt)
    except Exception as exc:
        logger.warning("Reapplicant analysis failed for candidate {}: {}", candidate.id, exc)
        return {
            "gaps_addressed": [],
            "new_strengths": [],
            "recommendation": "standard_review",
            "recommendation_reason": f"Analysis failed: {exc}",
            "growth_score": -1,
            "raw_llm_response": None,
        }

    return {
        "gaps_addressed": result.get("gaps_addressed") or [],
        "new_strengths": result.get("new_strengths") or [],
        "recommendation": str(result.get("recommendation") or "standard_review"),
        "recommendation_reason": str(result.get("recommendation_reason") or ""),
        "growth_score": float(result.get("growth_score", -1)),
        "raw_llm_response": result,
    }


def build_candidate_snapshot(candidate: Candidate) -> dict[str, Any]:
    """Create a point-in-time snapshot of a candidate for memory storage."""
    return {
        "skills": candidate.skills or [],
        "work_experience": candidate.work_experience or [],
        "projects": candidate.projects or [],
        "certifications": candidate.certifications or [],
        "years_experience": candidate.years_experience,
        "college_details": candidate.college_details,
        "location": candidate.location,
    }


# ── 4. Call Interview Transcript Analyzer ────────────────────────────────────

_CALL_ANALYSIS_PROMPT = """\
You are an expert technical recruiter evaluating a candidate's AI voice interview.
You will receive the full transcript of a phone interview between an AI interviewer and a candidate.

Analyze the transcript and evaluate the candidate across these dimensions:

1. **Communication** – clarity, fluency, structure of responses (0-100)
2. **Technical depth** – accuracy and depth of technical answers (0-100)
3. **Confidence** – vocal confidence, assertiveness, self-presentation (0-100)
4. **Overall score** – weighted average holistic score (0-100)

Also assess:
- **Sentiment** – overall tone: "positive", "neutral", or "negative"
- **Recommendation** – "hire", "consider", or "reject"
- **Key strengths** – 3-5 bullet points of what stood out positively
- **Concerns** – 2-4 bullet points of areas to probe further or weaknesses
- **Topic coverage** – list of key topics/skills that came up in the interview
- **Summary** – 3-4 sentence narrative of the interview performance

Return a JSON object with EXACTLY these keys:
{{
  "overall_score": <0-100 float>,
  "communication_score": <0-100 float>,
  "technical_score": <0-100 float>,
  "confidence_score": <0-100 float>,
  "sentiment": "<positive|neutral|negative>",
  "recommendation": "<hire|consider|reject>",
  "summary": "<3-4 sentence narrative>",
  "key_strengths": ["<strength 1>", "<strength 2>", ...],
  "concerns": ["<concern 1>", "<concern 2>", ...],
  "topic_coverage": ["<topic 1>", "<topic 2>", ...]
}}

INTERVIEW TRANSCRIPT:
{transcript}

ROLE: {role}
"""


async def analyze_call_transcript(
    *,
    transcript: str,
    role: str | None = None,
    candidate_name: str | None = None,
) -> dict[str, Any]:
    """Analyse an AI voice interview transcript and return structured scores + insights."""
    if not transcript or len(transcript.strip()) < 50:
        raise ValueError("Transcript is too short to analyze (minimum 50 characters)")

    role_label = (role or "the role").strip()
    prompt = _CALL_ANALYSIS_PROMPT.format(
        transcript=transcript[:8000],  # cap to avoid token limits
        role=role_label,
    )

    result = await _llm_json(prompt)

    # Normalise score fields to float 0-100
    for key in ("overall_score", "communication_score", "technical_score", "confidence_score"):
        val = result.get(key)
        if val is not None:
            try:
                result[key] = max(0.0, min(100.0, float(val)))
            except (TypeError, ValueError):
                result[key] = None

    # Normalise enum fields
    sentiment = str(result.get("sentiment") or "neutral").lower()
    if sentiment not in {"positive", "neutral", "negative"}:
        sentiment = "neutral"
    result["sentiment"] = sentiment

    recommendation = str(result.get("recommendation") or "consider").lower()
    if recommendation not in {"hire", "consider", "reject"}:
        recommendation = "consider"
    result["recommendation"] = recommendation

    # Ensure list fields
    for key in ("key_strengths", "concerns", "topic_coverage"):
        val = result.get(key)
        if not isinstance(val, list):
            result[key] = [str(val)] if val else []

    return result

