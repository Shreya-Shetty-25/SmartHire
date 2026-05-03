from __future__ import annotations

import secrets

from pydantic import AliasChoices, AnyHttpUrl, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_jwt_secret() -> str:
    # Used ONLY in non-production environments where JWT_SECRET_KEY is not set.
    # In production we refuse to start without an explicit secret (see model_validator).
    return secrets.token_urlsafe(48)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        enable_decoding=False,
    )

    app_name: str = "SmartHire API"
    # Set ENVIRONMENT=production in deployments to enforce strict validation.
    environment: str = "dev"

    # PostgreSQL connection string (asyncpg DSN). Must be supplied in production.
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/postgres"

    # JWT secret for auth tokens. In dev a random secret is generated at startup;
    # in production this MUST be set explicitly (validated below).
    jwt_secret_key: str = Field(default_factory=_default_jwt_secret)
    # Access tokens are short-lived (default 60 minutes). Refresh / re-login as needed.
    access_token_expire_minutes: int = Field(default=60, ge=5, le=24 * 60)

    admin_emails: str = ""
    bootstrap_admin_enabled: bool = False
    bootstrap_admin_name: str = "Admin"
    bootstrap_admin_email: str | None = None
    bootstrap_admin_password: str | None = None

    # Resume parsing (LLM) provider selection. Exactly one of these should be true.
    use_openai: bool = False
    use_azure_openai: bool = False
    use_gemini: bool = False
    use_groq: bool = False

    # OpenAI
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"

    # Azure OpenAI
    azure_openai_endpoint: str | None = None
    azure_openai_api_key: str | None = None
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str = "2024-02-01"

    # Google Gemini
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-2.0-flash"

    # Groq (OpenAI-compatible)
    groq_api_key: str | None = None
    groq_model: str = "llama-3.1-8b-instant"

    # Cerebras (OpenAI-compatible, fast inference)
    use_cerebras: bool = False
    cerebras_api_key: str | None = None
    cerebras_model: str = "llama-3.1-8b"

    # Optional: use these when you start integrating Supabase auth/storage directly
    supabase_url: AnyHttpUrl | None = None
    supabase_anon_key: str | None = None

    # Twilio (voice calling)
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    twilio_voice: str = "Polly.Raveena"
    # Verify X-Twilio-Signature on inbound webhooks. Disable only in tests.
    twilio_validate_signature: bool = True

    # Public URL where Twilio can reach this API (e.g., an ngrok URL)
    public_base_url: AnyHttpUrl | None = Field(
        default=None,
        validation_alias=AliasChoices("PUBLIC_CALL_BASE_URL", "PUBLIC_BASE_URL"),
    )

    # ElevenLabs (TTS for more natural voice)
    elevenlabs_api_key: str | None = None
    elevenlabs_voice_id: str | None = None
    elevenlabs_model_id: str = "eleven_multilingual_v2"
    elevenlabs_stt_model_id: str = "scribe_v2"

    # Cartesia TTS
    cartesia_api_key: str | None = None
    cartesia_voice_id: str = "6fee5993-e60e-4656-b0eb-2a9f1a0cb6e8"
    cartesia_model_id: str = "sonic-3"

    # STT provider: "elevenlabs" | "azure_whisper" | "none"
    stt_provider: str = "elevenlabs"
    azure_whisper_deployment: str | None = None

    # Email (for sending test links). EMAIL_MODE: "auto" | "log" | "smtp".
    email_mode: str = "auto"
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

    # CORS origins for frontend (comma-separated string).
    # Default kept friendly for dev; production deployments MUST set explicitly.
    cors_allow_origins: str = Field(
        default="http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174",
        validation_alias=AliasChoices("CORS_ALLOW_ORIGINS", "CORS_ORIGINS"),
    )

    # Assessment service (used to create exam sessions and generate EXAM- codes)
    assessment_api_base_url: str = "http://127.0.0.1:8000/assessment-api"
    exam_portal_base_url: str = "http://localhost:5173/assessment"
    assessment_question_generation_mode: str = Field(
        default="auto",
        validation_alias=AliasChoices("ASSESSMENT_QUESTION_GENERATION_MODE"),
    )

    # Global embeddings toggle.
    embeddings_enabled: bool = True
    shortlist_strategy: str = "auto"

    # When True, skip SSL certificate verification for HuggingFace model
    # downloads. Useful behind corporate proxies with self-signed CAs.
    # WARNING: never enable in production unless you have explicit egress controls.
    hf_disable_ssl_verify: bool = False

    # Maximum size (bytes) accepted for resume / document uploads.
    max_upload_bytes: int = Field(default=10 * 1024 * 1024, ge=1024)
    # Maximum size accepted for inbound realtime/event payloads.
    max_realtime_payload_bytes: int = Field(default=64 * 1024, ge=512)

    # ── Validators ──────────────────────────────────────────────────────────

    @property
    def is_production(self) -> bool:
        return str(self.environment or "").strip().lower() in {"prod", "production"}

    @model_validator(mode="after")
    def _validate_security(self) -> "Settings":
        if self.is_production:
            problems: list[str] = []

            db = (self.database_url or "").lower()
            if (
                "postgres:postgres@localhost" in db
                or "your_password" in db
                or "your_project_ref" in db
                or "your_local_postgres_password" in db
            ):
                problems.append(
                    "DATABASE_URL is using a default/placeholder value. Set a real DSN."
                )

            if not self.jwt_secret_key or len(self.jwt_secret_key) < 32:
                problems.append("JWT_SECRET_KEY is missing or too short (need >= 32 chars).")

            if self.bootstrap_admin_enabled:
                pwd = (self.bootstrap_admin_password or "").strip()
                email = (self.bootstrap_admin_email or "").strip()
                if not email or not pwd:
                    problems.append(
                        "BOOTSTRAP_ADMIN_ENABLED is true but admin email/password are not set."
                    )
                if pwd in {"admin@123", "admin", "password", "changeme"}:
                    problems.append("BOOTSTRAP_ADMIN_PASSWORD is a known weak/default value.")
                if pwd and len(pwd) < 12:
                    problems.append("BOOTSTRAP_ADMIN_PASSWORD must be >= 12 characters in production.")

            if (self.email_mode or "").lower() == "log":
                problems.append("EMAIL_MODE=log is not allowed in production; configure SMTP.")
            if (self.email_mode or "").lower() in {"smtp", "auto"} and self.smtp_host:
                if not self.smtp_from:
                    problems.append("SMTP_FROM must be set when SMTP delivery is enabled.")

            origins = [o.strip() for o in (self.cors_allow_origins or "").split(",") if o.strip()]
            if "*" in origins:
                problems.append("CORS_ALLOW_ORIGINS may not contain '*' in production.")
            if any("localhost" in o or "127.0.0.1" in o for o in origins):
                problems.append("CORS_ALLOW_ORIGINS must not include localhost in production.")

            if self.hf_disable_ssl_verify:
                problems.append("HF_DISABLE_SSL_VERIFY=true is not allowed in production.")

            if problems:
                raise ValueError(
                    "Invalid production configuration:\n  - " + "\n  - ".join(problems)
                )

        # Enforce: at most one resume-parsing LLM provider flag set to True.
        flags = [
            ("use_openai", self.use_openai),
            ("use_azure_openai", self.use_azure_openai),
            ("use_gemini", self.use_gemini),
            ("use_groq", self.use_groq),
            ("use_cerebras", self.use_cerebras),
        ]
        enabled = [name for name, v in flags if v]
        if len(enabled) > 1:
            raise ValueError(
                f"At most one LLM provider flag can be enabled at once; got: {enabled}"
            )

        return self


settings = Settings()
