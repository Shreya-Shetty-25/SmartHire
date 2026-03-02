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
        "website_links (array of strings or null)\n\n"
        "Rules:\n"
        "- Use null when unknown\n"
        "- Do not invent facts\n"
        "- Keep arrays concise\n\n"
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
        response = await client.post(url, headers=headers, json=payload)
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
        "temperature": 0,
        "messages": [
            {"role": "system", "content": "You output strict JSON only."},
            {"role": "user", "content": prompt},
        ],
    }

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(url, headers=headers, json=payload)
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
        response = await client.post(url, params=params, json=payload)
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


async def parse_resume_pdf(pdf_bytes: bytes) -> CandidateParsed:
    resume_text = _extract_text_from_pdf(pdf_bytes)
    prompt = _build_prompt(resume_text)

    provider = _selected_provider()

    if provider == "groq":
        llm_text = await _call_groq(prompt)
    elif provider == "azure":
        llm_text = await _call_azure_openai(prompt)
    else:
        llm_text = await _call_gemini(prompt)

    obj = _coerce_json_object(llm_text)
    try:
        return CandidateParsed.model_validate(obj)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="LLM output failed Pydantic validation",
        ) from exc
