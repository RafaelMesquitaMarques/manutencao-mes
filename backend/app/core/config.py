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

    # ElevenLabs premium text-to-speech for the Ask Ninja voice (optional).
    # If unset, the frontend silently sticks to the browser's built-in voices.
    elevenlabs_api_key: Optional[str] = None
    # Premade "Adam" — present on every ElevenLabs account; multilingual via Flash.
    elevenlabs_voice_id: str = "pNInz6obpgDQGcFmaJgB"

    # Local, token-free LLM (Ollama) used to tidy up / organize dictated notes.
    # Runs on-prem with no per-token cost. If the server is unreachable, the note
    # organizer degrades to a light local text cleanup (no AI). Set OLLAMA_BASE_URL
    # empty to disable the AI path entirely.
    OLLAMA_BASE_URL: str = "http://ollama:11434"
    OLLAMA_MODEL: str = "llama3.2"

    # Upload
    MAX_UPLOAD_MB: int = 200   # allows short SOP videos; override via env if needed
    UPLOAD_DIR: str = "/app/uploads"

    # Yokogawa Sushi Sensor (LoRaWAN) ingest. The network server's HTTP
    # integration must send this value in the X-Ingest-Token header; while
    # empty the /api/sushi/uplink endpoint answers 503 (ingest disabled).
    SUSHI_INGEST_TOKEN: str = ""

    # Cortex INBOUND push (/api/v1/cortex/events — cobot OF reads). Cortex sends
    # the token as `Authorization: Bearer <token>` (or X-Ingest-Token). While
    # empty the endpoint answers 503 (ingest disabled). Comma-separated values
    # are all accepted, so a token can be rotated without a coordinated cutover;
    # each environment (dev/test/prod) sets its own value in its .env.
    CORTEX_INGEST_TOKEN: str = ""

    @property
    def cortex_ingest_tokens(self) -> list[str]:
        return [t.strip() for t in self.CORTEX_INGEST_TOKEN.split(",") if t.strip()]
    # Payload byte order — the Yokogawa manuals list fields MSB-first but never
    # name an endianness. "big" (default) is the assumption to validate against
    # the first real uplink; set "little" if values decode to nonsense.
    SUSHI_BYTE_ORDER: str = "big"

    # Multi-plant phase 4 — kiosk hardening. False (default) keeps the historic
    # open shop-floor kiosk endpoints (QC tablets bookmark /machines/:slug with
    # no token). Flip to true only after provisioning per-machine kiosk tokens
    # and updating tablet bookmarks to /machines/:slug?k=<token>.
    KIOSK_ENFORCE_TOKEN: bool = False

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()] or ["*"]

    class Config:
        env_file = ".env"


settings = Settings()
