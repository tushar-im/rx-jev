from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# Agreed at Gate 1: a category is shown only when both its stance and evidence confidence
# reach this. At 0.9 the blind second read agreed with Jev's stance on 81 of 83 rows.
GATE_1_MIN_CONFIDENCE = 0.9
# The Jev version those thresholds were validated on. Runs reporting another version are
# flagged by the batch script until the thresholds are re-checked for it.
GATE_1_MODEL_VERSION = "jev-1.13.0"


class Settings(BaseSettings):
    """Runtime configuration, read from the environment or apps/api/.env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    typesafe_api_key: SecretStr | None = None
    typesafe_model: str = "jev-latest"
    openfda_base_url: str = "https://api.fda.gov"
    openfda_api_key: SecretStr | None = None
    dailymed_base_url: str = "https://dailymed.nlm.nih.gov/dailymed/services/v2"
    rxnorm_base_url: str = "https://rxnav.nlm.nih.gov/REST"
    cors_origins: list[str] = ["http://localhost:5173"]
    database_url: str = "sqlite:///rx_jev.db"
    display_min_confidence: float = GATE_1_MIN_CONFIDENCE
    validated_model_version: str = GATE_1_MODEL_VERSION


@lru_cache
def get_settings() -> Settings:
    return Settings()
