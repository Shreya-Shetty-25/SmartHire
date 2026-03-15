from pydantic import AnyHttpUrl
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
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
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None
    smtp_tls: bool = True

    # Assessment service (used to create exam sessions and generate EXAM- codes)
    assessment_api_base_url: str = "http://127.0.0.1:8100"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
