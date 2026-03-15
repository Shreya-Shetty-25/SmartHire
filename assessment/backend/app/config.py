from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    jobs_database_url: str | None = None
    assessment_database_url: str = "sqlite:///./assessment_data.db"
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"
    public_base_url: str = "http://localhost:5173"

    use_hf_llm: bool = False
    hf_api_token: str | None = None
    hf_model: str = "google/flan-t5-base"

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


settings = Settings()
