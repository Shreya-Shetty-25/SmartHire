from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(_ENV_FILE), env_file_encoding="utf-8", extra="ignore")

    jobs_database_url: str | None = None
    assessment_database_url: str = "sqlite:///./assessment_data.db"
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"
    public_base_url: str = "http://localhost:5173"
    main_backend_base_url: str = "http://127.0.0.1:8001"

    use_hf_llm: bool = False
    hf_api_token: str | None = None
    hf_model: str = "google/flan-t5-base"

    # Azure OpenAI settings
    use_azure_openai: bool = False
    azure_openai_endpoint: str | None = None
    azure_openai_api_key: str | None = None
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str = "2024-12-01-preview"

    # SMTP email settings
    email_mode: str = "auto"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None
    smtp_tls: bool = True

    # Twilio voice call settings
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    twilio_voice: str = "Polly.Aditi"
    public_call_base_url: str | None = None

    # ElevenLabs TTS
    elevenlabs_api_key: str | None = None
    elevenlabs_voice_id: str | None = None
    elevenlabs_model_id: str = "eleven_multilingual_v2"

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


settings = Settings()

# Startup diagnostics
from loguru import logger as _logger  # noqa: E402

_logger.info("Assessment config loaded from: {}", _ENV_FILE)
_logger.info(
    "Azure OpenAI: enabled={}, endpoint={}, deployment={}",
    settings.use_azure_openai,
    (settings.azure_openai_endpoint or "")[:50],
    settings.azure_openai_deployment,
)
