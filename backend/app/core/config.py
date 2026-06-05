from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Banco
    DATABASE_URL: str = "postgresql+asyncpg://mesadmin:changeme@db:5432/manutencao"

    # Redis
    REDIS_URL: str = "redis://redis:6379"

    # MQTT
    MQTT_BROKER: str = "mqtt"
    MQTT_PORT: int = 1883

    # Segurança
    SECRET_KEY: str = "troque-em-producao"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480  # 8 horas

    # Ambiente
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    # Upload
    MAX_UPLOAD_MB: int = 20
    UPLOAD_DIR: str = "/app/uploads"

    class Config:
        env_file = ".env"


settings = Settings()
