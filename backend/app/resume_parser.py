import io
import json
import re
from typing import Literal

import httpx
from fastapi import HTTPException, status
from loguru import logger
from pypdf import PdfReader

from .config import settings
from .schemas import CandidateParsed


_URL_RE = re.compile(
    r"(?i)\b((?:https?://)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:/[^\s<>()\"']*)?)"
)

_EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")


def _normalize_url(raw: str) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None

    # Strip common trailing punctuation from PDF text extraction.
    s = s.strip("\"'()[]{}<>.,;:!?")
    if not s:
        return None

    lower = s.lower()
    if lower.startswith("http://") or lower.startswith("https://"):
        return s

    if lower.startswith("www."):
        return f"https://{s}"

    # Domain/path without scheme.
    if "." in s and " " not in s and "@" not in s:
        return f"https://{s}"

    return None


def _extract_urls(text: str) -> list[str]:
    if not text:
        return []
    return [m.group(1) for m in _URL_RE.finditer(text) if m.group(1)]


def _clean_website_links(
    *,
    website_links: list[str] | None,
    resume_text: str,
    pdf_uri_links: list[str] | None = None,
) -> list[str] | None:
    candidates: list[str] = []
    if website_links:
        for item in website_links:
            if not item:
                continue
            # Extract URLs even if the LLM returned "LinkedIn: linkedin.com/...".
            candidates.extend(_extract_urls(str(item)))

    if pdf_uri_links:
        candidates.extend(pdf_uri_links)

    # Also extract directly from resume text (best-effort).
    candidates.extend(_extract_urls(resume_text))

    normalized: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        url = _normalize_url(c)
        if not url:
            continue
        key = url.lower()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(url)

    return normalized or None


def _selected_provider() -> Literal["azure", "gemini", "groq"]:
    enabled = {
        "azure": bool(settings.use_azure_openai),
        "gemini": bool(settings.use_gemini),
        "groq": bool(settings.use_groq),
    }
    enabled_count = sum(enabled.values())
    if enabled_count != 1:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Exactly one resume parser provider must be enabled. "
                "Set one of USE_AZURE_OPENAI=true, USE_GEMINI=true, USE_GROQ=true (and the others false)."
            ),
        )

    for name, on in enabled.items():
        if on:
            return name  # type: ignore[return-value]

    raise HTTPException(status_code=500, detail="No resume parser provider enabled")


def _extract_text_from_pdf(pdf_bytes: bytes) -> str:
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid PDF file") from exc

    chunks: list[str] = []
    for page in reader.pages:
        try:
            chunks.append(page.extract_text() or "")
        except Exception:
            chunks.append("")

    text = "\n".join(chunks).strip()
    if not text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not extract text from PDF (scanned image PDFs are not supported yet)",
        )
    return text


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    return _extract_text_from_pdf(pdf_bytes)


def _extract_uri_links_from_pdf(pdf_bytes: bytes) -> list[str]:
    """Extract hyperlink targets embedded in the PDF (best-effort).

    Resumes often show link text like 'LinkedIn' while the actual URL is stored
    in a link annotation (/Annots -> /A -> /URI). Pull those URIs so we can
    store real URLs even when they aren't visible in the extracted text.
    """

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
    except Exception:
        return []

    urls: list[str] = []
    for page in reader.pages:
        try:
            annots = page.get("/Annots") or []
        except Exception:
            annots = []

        for annot_ref in annots:
            try:
                annot = annot_ref.get_object()
                action = annot.get("/A")
                if action is None:
                    continue
                if hasattr(action, "get_object"):
                    action = action.get_object()
                uri = action.get("/URI") if isinstance(action, dict) else None
                if isinstance(uri, str) and uri.strip():
                    urls.append(uri.strip())
            except Exception:
                continue

    return urls


def _coerce_json_object(text: str) -> dict:
    text = text.strip()

    # If the model returned extra prose, try to find the first JSON object.
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        text = match.group(0)

    try:
        return json.loads(text)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM did not return valid JSON",
        ) from exc


def _coerce_string_list(value) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            if item is None:
                continue
            s = str(item).strip()
            if s:
                out.append(s)
        return out or None
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        parts = re.split(r"[\n,;\u2022]+", raw)
        out = [p.strip() for p in parts if p and p.strip()]
        return out or None
    # Unknown type (dict/number/etc)
    return None


def _extract_email_from_text(text: str) -> str | None:
    if not text:
        return None
    m = _EMAIL_RE.search(text)
    if not m:
        return None
    return m.group(0).strip()


def _guess_name_from_text(text: str) -> str | None:
    if not text:
        return None

    banned = {
        "resume",
        "curriculum vitae",
        "cv",
        "profile",
        "contact",
    }

    for line in (text or "").splitlines()[:20]:
        s = " ".join(line.strip().split())
        if not s:
            continue
        lower = s.lower()
        if "@" in s:
            continue
        if any(b in lower for b in banned):
            continue
        # Avoid lines that look like addresses or headers with lots of punctuation.
        if sum(ch.isdigit() for ch in s) > 0:
            continue
        if len(s) < 2 or len(s) > 80:
            continue
        # Must have at least 2 alphabetic characters.
        if sum(ch.isalpha() for ch in s) < 2:
            continue
        return s

    return None


def _normalize_candidate_obj(obj: dict, *, resume_text: str) -> dict:
    # Map common alternative keys.
    mapped = dict(obj or {})
    if "full_name" not in mapped:
        for k in ("name", "candidate_name", "fullname", "fullName"):
            if k in mapped and mapped.get(k):
                mapped["full_name"] = mapped.get(k)
                break
    if "email" not in mapped:
        for k in ("mail", "email_address", "emailAddress"):
            if k in mapped and mapped.get(k):
                mapped["email"] = mapped.get(k)
                break
    if "phone_number" not in mapped:
        for k in ("phone", "phoneNo", "phone_no", "mobile", "mobile_number"):
            if k in mapped and mapped.get(k):
                mapped["phone_number"] = mapped.get(k)
                break

    # Coerce list-ish fields.
    for key in (
        "projects",
        "skills",
        "work_experience",
        "extra_curricular_activities",
        "website_links",
        "certifications",
    ):
        if key in mapped:
            mapped[key] = _coerce_string_list(mapped.get(key))

    # Coerce primitive strings.
    for key in ("full_name", "email", "phone_number", "college_details", "school_details", "location"):
        if key in mapped and mapped.get(key) is not None:
            s = str(mapped.get(key)).strip()
            mapped[key] = s if s else None

    # If email missing or obviously wrong, fall back to regex extraction.
    email = str(mapped.get("email") or "").strip()
    if not email or "@" not in email:
        extracted = _extract_email_from_text(resume_text)
        if extracted:
            mapped["email"] = extracted

    # If name missing, guess from resume text.
    name = str(mapped.get("full_name") or "").strip()
    if not name:
        guessed = _guess_name_from_text(resume_text)
        if guessed:
            mapped["full_name"] = guessed

    return mapped


def _build_prompt(resume_text: str) -> str:
    return (
        "You are an expert resume parser for recruiting. "
        "Extract the following candidate fields from the resume text. "
        "Return ONLY a single JSON object with these keys (no markdown, no explanations):\n\n"
        "full_name (string, required)\n"
        "email (string, required)\n"
        "phone_number (string or null)\n"
        "college_details (string or null)\n"
        "school_details (string or null)\n"
        "projects (array of strings or null)\n"
        "skills (array of strings or null)\n"
        "work_experience (array of strings or null)\n"
        "extra_curricular_activities (array of strings or null)\n"
        "website_links (array of strings or null)\n"
        "years_experience (integer years or null)\n"
        "location (string or null)\n"
        "certifications (array of strings or null)\n\n"
        "Rules:\n"
        "- Use null when unknown\n"
        "- Do not invent facts\n"
        "- Keep arrays concise\n\n"
        "Website link rules:\n"
        "- website_links must contain actual URLs only (e.g., https://linkedin.com/in/..., github.com/user)\n"
        "- Do NOT include labels like 'LinkedIn' or 'GitHub' unless the URL is present\n"
        "- If only the label text is present and no URL is visible in the resume text, return null for that entry\n\n"
        "Resume text:\n"
        f"{resume_text}"
    )


async def _call_groq(prompt: str) -> str:
    if not settings.groq_api_key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY is missing")

    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {settings.groq_api_key}"}
    payload = {
        "model": settings.groq_model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": "You output strict JSON only."},
            {"role": "user", "content": prompt},
        ],
    }

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            response = await client.post(url, headers=headers, json=payload)
        except httpx.RequestError as exc:
            logger.warning("Groq request failed (network): {}", repr(exc))
            raise HTTPException(status_code=503, detail="Groq is unreachable (network error)") from exc
        if response.status_code >= 400:
            logger.warning("Groq error {}: {}", response.status_code, response.text)
            detail = "Groq request failed"
            try:
                data = response.json()
                error = data.get("error") if isinstance(data, dict) else None
                message = error.get("message") if isinstance(error, dict) else None
                code = error.get("code") if isinstance(error, dict) else None
                if message and code:
                    detail = f"Groq request failed ({code}): {message}"
                elif message:
                    detail = f"Groq request failed: {message}"
            except Exception:
                pass
            raise HTTPException(status_code=502, detail=detail)
        data = response.json()

    return data["choices"][0]["message"]["content"]


async def _call_azure_openai(prompt: str) -> str:
    if not settings.azure_openai_endpoint or not settings.azure_openai_api_key or not settings.azure_openai_deployment:
        raise HTTPException(
            status_code=500,
            detail="Azure OpenAI env vars missing (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT)",
        )

    endpoint = settings.azure_openai_endpoint.rstrip("/")
    url = (
        f"{endpoint}/openai/deployments/{settings.azure_openai_deployment}/chat/completions"
        f"?api-version={settings.azure_openai_api_version}"
    )
    headers = {"api-key": settings.azure_openai_api_key}
    payload = {
        "messages": [
            {"role": "system", "content": "You output strict JSON only."},
            {"role": "user", "content": prompt},
        ],
    }

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            response = await client.post(url, headers=headers, json=payload)
        except httpx.RequestError as exc:
            # Common on dev machines: DNS issues, captive portal, corporate proxy, offline.
            logger.warning("Azure OpenAI request failed (network): {}", repr(exc))
            raise HTTPException(status_code=503, detail="Azure OpenAI is unreachable (network/DNS error)") from exc
        if response.status_code >= 400:
            logger.warning("Azure OpenAI error {}: {}", response.status_code, response.text)
            detail = "Azure OpenAI request failed"
            try:
                data = response.json()
                error = data.get("error") if isinstance(data, dict) else None
                message = error.get("message") if isinstance(error, dict) else None
                code = error.get("code") if isinstance(error, dict) else None
                if message and code:
                    detail = f"Azure OpenAI request failed ({code}): {message}"
                elif message:
                    detail = f"Azure OpenAI request failed: {message}"
            except Exception:
                pass
            raise HTTPException(status_code=502, detail=detail)
        data = response.json()

    return data["choices"][0]["message"]["content"]


async def _call_gemini(prompt: str) -> str:
    if not settings.gemini_api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is missing")

    model = settings.gemini_model
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    params = {"key": settings.gemini_api_key}
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ],
        "generationConfig": {"temperature": 0},
    }

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            response = await client.post(url, params=params, json=payload)
        except httpx.RequestError as exc:
            logger.warning("Gemini request failed (network): {}", repr(exc))
            raise HTTPException(status_code=503, detail="Gemini is unreachable (network error)") from exc
        if response.status_code >= 400:
            logger.warning("Gemini error {}: {}", response.status_code, response.text)
            detail = "Gemini request failed"
            try:
                data = response.json()
                error = data.get("error") if isinstance(data, dict) else None
                message = error.get("message") if isinstance(error, dict) else None
                status_value = error.get("status") if isinstance(error, dict) else None
                if message and status_value:
                    detail = f"Gemini request failed ({status_value}): {message}"
                elif message:
                    detail = f"Gemini request failed: {message}"
            except Exception:
                pass
            raise HTTPException(status_code=502, detail=detail)
        data = response.json()

    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Gemini response format unexpected") from exc


async def parse_resume_pdf(pdf_bytes: bytes, *, resume_text: str | None = None) -> CandidateParsed:
    resume_text = resume_text if resume_text is not None else _extract_text_from_pdf(pdf_bytes)
    pdf_uri_links = _extract_uri_links_from_pdf(pdf_bytes)
    prompt = _build_prompt(resume_text)

    provider = _selected_provider()

    try:
        if provider == "groq":
            llm_text = await _call_groq(prompt)
        elif provider == "azure":
            llm_text = await _call_azure_openai(prompt)
        else:
            llm_text = await _call_gemini(prompt)
    except Exception as exc:
        # Do not fail resume upload if the LLM provider is temporarily unavailable.
        # We will fall back to deterministic extraction (email + best-effort name).
        logger.warning("LLM call failed; falling back to heuristic resume parsing. provider={} err={}", provider, repr(exc))
        llm_text = "{}"

    raw_obj = _coerce_json_object(llm_text)
    normalized_obj = _normalize_candidate_obj(raw_obj if isinstance(raw_obj, dict) else {}, resume_text=resume_text)

    try:
        parsed = CandidateParsed.model_validate(normalized_obj)
        cleaned_links = _clean_website_links(
            website_links=parsed.website_links,
            resume_text=resume_text,
            pdf_uri_links=pdf_uri_links,
        )
        if cleaned_links != parsed.website_links:
            parsed = parsed.model_copy(update={"website_links": cleaned_links})
        return parsed
    except Exception as exc:
        # Final fallback: ensure we have the two required fields.
        fallback_email = _extract_email_from_text(resume_text)
        if not fallback_email:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Could not extract a valid email from resume text",
            ) from exc

        fallback_name = _guess_name_from_text(resume_text) or "Unknown"
        fallback_obj = {
            **{k: normalized_obj.get(k) for k in normalized_obj.keys()},
            "email": fallback_email,
            "full_name": fallback_name,
        }

        try:
            parsed = CandidateParsed.model_validate(fallback_obj)
            cleaned_links = _clean_website_links(
                website_links=parsed.website_links,
                resume_text=resume_text,
                pdf_uri_links=pdf_uri_links,
            )
            if cleaned_links != parsed.website_links:
                parsed = parsed.model_copy(update={"website_links": cleaned_links})
            logger.warning(
                "Resume LLM JSON validation failed; used fallback extraction for email/name. email={} err={}",
                fallback_email,
                exc,
            )
            return parsed
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="LLM output failed Pydantic validation",
            ) from exc


def extract_email_from_pdf_text(pdf_bytes: bytes) -> str | None:
    """Extract an email address from raw PDF text without calling any LLM."""
    try:
        text = _extract_text_from_pdf(pdf_bytes)
    except Exception:
        return None
    return _extract_email_from_text(text)
