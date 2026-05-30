from __future__ import annotations

from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_BACKEND_ENV_FILE = _BACKEND_ROOT / ".env"


def _default_assessment_db_url() -> str:
    # Default to SQLite for local dev; set ASSESSMENT_DATABASE_URL in .env to use
    # a cloud PostgreSQL (e.g. Neon: postgresql+psycopg://user:pass@host/db)
    db_path = (_BACKEND_ROOT / "assessment_data.db").resolve()
    return f"sqlite:///{db_path.as_posix()}"


def _default_exam_portal_base_url() -> str:
    return "http://localhost:5173/assessment"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_BACKEND_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    jobs_database_url: str | None = Field(default=None, validation_alias=AliasChoices("JOBS_DATABASE_URL"))
    assessment_database_url: str = Field(
        default_factory=_default_assessment_db_url,
        validation_alias=AliasChoices("ASSESSMENT_DATABASE_URL"),
    )
    allowed_origins: str = Field(
        default="http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174",
        validation_alias=AliasChoices("ALLOWED_ORIGINS", "CORS_ALLOW_ORIGINS"),
    )
    exam_portal_base_url: str = Field(
        default_factory=_default_exam_portal_base_url,
        validation_alias=AliasChoices("EXAM_PORTAL_BASE_URL"),
    )
    main_backend_base_url: str = Field(
        default="http://127.0.0.1:8000",
        validation_alias=AliasChoices("MAIN_BACKEND_BASE_URL"),
    )

    use_hf_llm: bool = Field(default=False, validation_alias=AliasChoices("USE_HF_LLM"))
    hf_api_token: str | None = Field(default=None, validation_alias=AliasChoices("HF_API_TOKEN", "HF_TOKEN"))
    hf_model: str = Field(default="google/flan-t5-base", validation_alias=AliasChoices("HF_MODEL"))
    hf_disable_ssl_verify: bool = Field(default=False, validation_alias=AliasChoices("HF_DISABLE_SSL_VERIFY"))

    # Azure OpenAI settings
    use_azure_openai: bool = Field(default=False, validation_alias=AliasChoices("USE_AZURE_OPENAI"))

    # Groq settings
    use_groq: bool = Field(default=False, validation_alias=AliasChoices("USE_GROQ"))
    groq_api_key: str | None = Field(default=None, validation_alias=AliasChoices("GROQ_API_KEY"))
    groq_model: str = Field(default="llama-3.1-8b-instant", validation_alias=AliasChoices("GROQ_MODEL"))

    # Cerebras settings
    use_cerebras: bool = Field(default=False, validation_alias=AliasChoices("USE_CEREBRAS"))
    cerebras_api_key: str | None = Field(default=None, validation_alias=AliasChoices("CEREBRAS_API_KEY"))
    cerebras_model: str = Field(default="llama-3.1-8b", validation_alias=AliasChoices("CEREBRAS_MODEL"))
    azure_openai_endpoint: str | None = None
    azure_openai_api_key: str | None = None
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str = "2024-12-01-preview"

    # SMTP email settings
    email_mode: str = Field(default="auto", validation_alias=AliasChoices("EMAIL_MODE"))
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SMTP_USER", "SMTP_USERNAME"),
    )
    smtp_password: str | None = None
    smtp_from: str | None = Field(
        default=None,
        validation_alias=AliasChoices("SMTP_FROM", "SMTP_FROM_EMAIL"),
    )
    smtp_tls: bool = Field(
        default=True,
        validation_alias=AliasChoices("SMTP_TLS", "SMTP_USE_STARTTLS"),
    )

    # Twilio voice call settings
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    twilio_voice: str = "Polly.Aditi"
    public_call_base_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("PUBLIC_CALL_BASE_URL"),
    )

    # ElevenLabs TTS
    elevenlabs_api_key: str | None = None
    elevenlabs_voice_id: str | None = None
    elevenlabs_model_id: str = "eleven_multilingual_v2"

    # Cartesia TTS
    cartesia_api_key: str | None = None
    cartesia_voice_id: str = "95d51f79-c397-46f9-b49a-23763d3eaa2d"
    cartesia_model_id: str = "sonic-3"

    # ── Proctoring thresholds (overridable via env) ──
    # Conservative defaults match the values previously hard-coded in
    # services/proctoring.py. Tune via PROCTOR_* env vars when calibrating
    # the system to a specific camera/lighting environment.
    proctor_horizontal_threshold: float = Field(
        default=0.09, validation_alias=AliasChoices("PROCTOR_HORIZONTAL_THRESHOLD")
    )
    proctor_vertical_threshold: float = Field(
        default=0.08, validation_alias=AliasChoices("PROCTOR_VERTICAL_THRESHOLD")
    )
    proctor_offscreen_seconds: float = Field(
        default=4.0, validation_alias=AliasChoices("PROCTOR_OFFSCREEN_SECONDS")
    )
    proctor_head_yaw_threshold: float = Field(
        default=0.22, validation_alias=AliasChoices("PROCTOR_HEAD_YAW_THRESHOLD")
    )
    proctor_head_pitch_threshold: float = Field(
        default=0.20, validation_alias=AliasChoices("PROCTOR_HEAD_PITCH_THRESHOLD")
    )
    proctor_identity_similarity_threshold: float = Field(
        default=0.72, validation_alias=AliasChoices("PROCTOR_IDENTITY_SIMILARITY_THRESHOLD")
    )
    proctor_identity_mismatch_streak_threshold: int = Field(
        default=3, validation_alias=AliasChoices("PROCTOR_IDENTITY_MISMATCH_STREAK_THRESHOLD")
    )
    proctor_face_id_verification_threshold: float = Field(
        default=0.68, validation_alias=AliasChoices("PROCTOR_FACE_ID_VERIFICATION_THRESHOLD")
    )
    proctor_facenet_identity_similarity_threshold: float = Field(
        default=0.63, validation_alias=AliasChoices("PROCTOR_FACENET_IDENTITY_SIMILARITY_THRESHOLD")
    )
    proctor_state_ttl_seconds: int = Field(
        default=4 * 60 * 60,
        validation_alias=AliasChoices("PROCTOR_STATE_TTL_SECONDS"),
    )

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @property
    def effective_public_call_base_url(self) -> str | None:
        explicit = (self.public_call_base_url or "").strip().rstrip("/")
        if explicit:
            return explicit

        base = (self.main_backend_base_url or "").strip().rstrip("/")
        if base:
            return f"{base}/assessment-api"
        return None


settings = Settings()

# Startup diagnostics
from loguru import logger as _logger  # noqa: E402

_logger.info(
    "Assessment config loaded from backend env={}",
    _BACKEND_ENV_FILE,
)
_logger.info(
    "Azure OpenAI: enabled={}, endpoint={}, deployment={}",
    settings.use_azure_openai,
    (settings.azure_openai_endpoint or "")[:50],
    settings.azure_openai_deployment,
)
