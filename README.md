# Kaizo MES — Industrial Maintenance Management & Monitoring Platform

A complete maintenance platform evolving into an MES (Manufacturing Execution System): multi-plant, multi-user and multilingual. It replaces external sensor-monitoring services by bringing everything into a single platform under in-house control.

## Architecture

```
manutencao-mes/
├── backend/                  # FastAPI API (Python)
│   └── app/
│       ├── api/routes/       # REST endpoints per module
│       ├── core/             # Settings, security, JWT
│       ├── db/               # SQLAlchemy session and base
│       ├── models/           # Database tables (ORM)
│       ├── schemas/          # Pydantic validation (input/output)
│       ├── services/         # Business logic
│       └── workers/
│           └── iot_consumer.py  # Consumes sensor MQTT messages → TimescaleDB
├── frontend/                 # React + Vite + Tailwind
│   └── src/
│       ├── pages/            # Main screens
│       ├── components/       # Reusable components
│       ├── i18n/             # Translations EN | FR | ES
│       └── store/            # Global state (Zustand)
├── nginx/                    # Reverse proxy
├── scripts/
│   ├── init_db.sql           # TimescaleDB hypertable + indexes
│   ├── mosquitto.conf        # MQTT broker (IoT sensors)
│   └── setup.sh              # One-command setup
├── backups/                  # Automatic daily backups
├── docker-compose.yml
└── .env.example
```

## Prerequisites

- Docker Desktop (Windows/Mac) or Docker Engine (Linux)
- Git
- 4 GB of free RAM (8 GB recommended)

## Installation (one command)

```bash
git clone https://github.com/RafaelMesquitaMarques/manutencao-mes.git
cd manutencao-mes
bash scripts/setup.sh
```

After the setup:

| Service | URL |
|---------|-----|
| Platform | http://localhost |
| REST API | http://localhost/api |
| API documentation | http://localhost/docs |
| MQTT broker | localhost:1883 |

## Modules

| Module | Description |
|--------|-------------|
| Work Orders | Corrective, preventive, predictive. Generated automatically from IoT alerts |
| Equipment | Technical data sheet, QR code, hour meter, full history |
| Maintenance Plans | Triggered by calendar, hour meter or cycles |
| Inventory | Lightweight MRP, reorder point, cost per work order |
| IoT / Sensors | MQTT ingestion, time series, automatic alerts |
| KPIs | MTBF, MTTR, OEE, availability per equipment |
| Multilingual | English, French, Spanish |

The platform has since grown well beyond this original core — see [CONTEXT.md](CONTEXT.md) for the current modules, architecture and data model.

## Planned roadmap

```
Phase 1 · Now      → Local CMMS (this repository)
Phase 2 · 3–6 mo   → IoT ingestion from the existing sensors
Phase 3 · 12 mo+   → Full MES + ML-based predictive maintenance + multi-plant cloud
```

## Sensor integration

Sensors publish their readings over MQTT on the topic:
```
usinas/{plant_id}/captores/{sensor_code}/leitura
```
Payload:
```json
{ "valor": 12.5, "timestamp": "2024-01-01T10:00:00Z" }
```

> The topic segments (`usinas`, `captores`, `leitura`) and the `valor` key are Portuguese on purpose: they are the wire contract with the sensor firmware and must not be translated (see `backend/app/workers/iot_consumer.py`).

The `iot_consumer` processes readings in real time, stores them in TimescaleDB and automatically raises alerts and work orders when limits are exceeded — bringing in-house what an external company does today.

## Useful commands

```bash
# Start
docker compose up -d

# Follow the logs in real time
docker compose logs -f

# Stop
docker compose down

# Rebuild after code changes
docker compose up -d --build

# Open a shell on the database
docker exec -it mes_db psql -U mesadmin -d manutencao
```
