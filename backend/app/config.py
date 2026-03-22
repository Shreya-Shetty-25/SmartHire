from __future__ import annotations

from pydantic import AliasChoices, AnyHttpUrl, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        enable_decoding=False,
    )

    app_name: str = "SmartHire API"
    environment: str = "dev"

    # PostgreSQL connection string (asyncpg DSN)
    # Local dev default: uses the default "postgres" database.
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/postgres"

    # JWT secret for auth tokens
    jwt_secret_key: str = "change-this-to-a-random-secret-key-in-production"

    # Resume parsing (LLM) provider selection. Exactly one of these should be true.
    use_azure_openai: bool = False
    use_gemini: bool = False
    use_groq: bool = False

    # Azure OpenAI
    azure_openai_endpoint: str | None = None
    azure_openai_api_key: str | None = None
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str = "2024-02-01"

    # Google Gemini
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-1.5-flash"

    # Groq (OpenAI-compatible)
    groq_api_key: str | None = None
    groq_model: str = "llama-3.1-8b-instant"

    # Optional: use these when you start integrating Supabase auth/storage directly
    supabase_url: AnyHttpUrl | None = None
    supabase_anon_key: str | None = None

    # Twilio (voice calling)
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    twilio_voice: str = "Polly.Raveena"

    # Public URL where Twilio can reach this API (e.g., an ngrok URL)
    public_base_url: AnyHttpUrl | None = None

    # ElevenLabs (TTS for more natural voice)
    elevenlabs_api_key: str | None = None
    elevenlabs_voice_id: str | None = None
    elevenlabs_model_id: str = "eleven_multilingual_v2"

    # Email (for sending test links)
    # EMAIL_MODE: "log" (default, no real email) or "smtp".
    email_mode: str = "log"
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

    # CORS origins for frontend (comma-separated string)
    # Note: pydantic-settings 2.4.x JSON-decodes list env vars by default,
    # so we keep this as a string and split in app startup.
    cors_allow_origins: str = Field(
        default="http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174",
        validation_alias=AliasChoices("CORS_ALLOW_ORIGINS", "CORS_ORIGINS"),
    )

    # Assessment service (used to create exam sessions and generate EXAM- codes)
    assessment_api_base_url: str = "http://127.0.0.1:8100"

    # Global embeddings toggle. Disable in environments where model downloads
    # are blocked and shortlisting should rely on BM25 instead.
    embeddings_enabled: bool = True

    # Shortlisting strategy: "auto" prefers embeddings and falls back to BM25,
    # "bm25" skips embedding/model download attempts entirely.
    shortlist_strategy: str = "auto"

    # When True, skip SSL certificate verification for HuggingFace model
    # downloads. Useful behind corporate proxies with self-signed CAs.
    hf_disable_ssl_verify: bool = False

settings = Settings()
