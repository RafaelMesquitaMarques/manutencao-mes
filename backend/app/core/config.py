from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://mesadmin:changeme@db:5432/manutencao"

    # Redis
    REDIS_URL: str = "redis://redis:6379"

    # MQTT
    MQTT_BROKER: str = "mqtt"
    MQTT_PORT: int = 1883

    # TODO: set SECRET_KEY environment variable in production — never use this default
    SECRET_KEY: str = "troque-em-producao"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480  # 8 hours

    # Environment
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    # CORS — comma-separated allowed origins. "*" allows all (fine for dev / same-origin
    # behind nginx). In production set explicit origins, e.g. "https://mes.foliot.com".
    CORS_ORIGINS: str = "*"

    # Twilio SMS (leave empty to run in simulation mode)
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    TWILIO_FROM_NUMBER: str = ""

    # Public base URL of the app (e.g. the cloudflared tunnel) — used to build
    # the "I'm on it" ack link in escalation SMS. Empty = no link in the SMS.
    PUBLIC_BASE_URL: str = ""

    # Anthropic API key for the Maintenance Intelligence AI layer.
    # If unset, the module runs in calculator-only mode (structured fallback text).
    anthropic_api_key: Optional[str] = None

    # Upload
    MAX_UPLOAD_MB: int = 200   # allows short SOP videos; override via env if needed
    UPLOAD_DIR: str = "/app/uploads"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()] or ["*"]

    class Config:
        env_file = ".env"


settings = Settings()
