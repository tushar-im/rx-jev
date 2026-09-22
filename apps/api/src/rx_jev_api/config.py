from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, read from the environment or apps/api/.env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    typesafe_api_key: SecretStr | None = None
    typesafe_model: str = "jev-latest"
    openfda_base_url: str = "https://api.fda.gov"
    dailymed_base_url: str = "https://dailymed.nlm.nih.gov/dailymed/services/v2"
    rxnorm_base_url: str = "https://rxnav.nlm.nih.gov/REST"
    cors_origins: list[str] = ["http://localhost:5173"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
