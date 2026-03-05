from pydantic import AnyHttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_ignore_empty=True,
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

    @field_validator("supabase_url", mode="before")
    @classmethod
    def _empty_supabase_url_to_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

settings = Settings()
