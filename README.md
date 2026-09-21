# Kaizo MES — Industrial Maintenance Management & Monitoring Platform

A maintenance platform (CMMS) that has grown into an MES (Manufacturing Execution System): multi-plant, multi-user and multilingual. It replaces external sensor-monitoring services by bringing maintenance, shop-floor execution and machine monitoring into a single platform under in-house control.

## Architecture

```
manutencao-mes/
├── backend/                  # FastAPI API (Python)
│   ├── app/
│   │   ├── api/routes/       # REST endpoints per module
│   │   ├── core/             # Settings, security, JWT, permissions, plant scoping
│   │   ├── db/               # SQLAlchemy session and base
│   │   ├── models/           # Database tables (ORM)
│   │   ├── schemas/          # Pydantic validation (input/output)
│   │   ├── services/         # Business logic
│   │   └── workers/
│   │       ├── iot_consumer.py   # Consumes sensor MQTT messages → TimescaleDB
│   │       ├── adam_gateway.py   # Polls Advantech ADAM I/O modules (Modbus/TCP) → API
│   │       └── cortex_poller.py  # Pulls end-of-line label scans from the Cortex API → API
│   ├── scripts/              # Data imports, seeds and simulators
│   └── tests/                # pytest suite
├── frontend/                 # React + Vite + Tailwind
│   └── src/
│       ├── pages/            # Main screens
│       ├── components/       # Reusable components
│       ├── i18n/             # Translations EN | FR | ES
│       └── store/            # Global state (Zustand)
├── docs/                     # Integration contracts and design notes
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

### Maintenance

| Module | What it does |
|--------|--------------|
| Work Orders | Corrective, preventive, predictive, inspection and improvement work orders, with parts, labor, costs, actions and attachments |
| WO Management | Alerts, open tickets and work orders in one triage view |
| Tickets | Maintenance requests from the office or from the machine kiosk ("call maintenance"); each one raises an alert that escalates by SLA |
| WO Approval | Supervisor sign-off of every completed job — work done and parts — from the floor or the office; parts used at the kiosk leave stock on approval |
| My Work | Each technician's own queue, with "on break / back" presence |
| Labor Scheduler | Drag work orders onto technicians |
| Maintenance Plans · PM Calendar | Preventive plans triggered by calendar, hour meter or cycles; reusable PM templates with photo/video steps; calendar of upcoming PMs |
| SOPs | Standard operating procedures (operation, maintenance, safety) with guided execution, also available at the machine kiosk |
| Predictive Health | Explainable machine-health risk from sensors and failure history (baselines, trends, MTBF, failure patterns), rolled out silent → active per plant and machine, with technician feedback and backtesting |
| Maintenance Dashboard · WO Reports | Maintenance KPIs, trends and a real-time overview |

### Shop floor (MES)

| Module | What it does |
|--------|--------------|
| Machine kiosk | One page per machine for operator and mechanic: status and timers, OF scan, stop justification, rejects, production, cleaning and safety checklists, the full intervention flow and voice notes tidied up by AI; supervisors can rearrange its panels |
| Manufacturing Orders | Time, cost and WIP per production order (OF), built from every pass of an OF through a machine |
| Factory Map | 2D/3D digital twin of the plant: live machine status and OEE, technicians at work, map editor, temperature sensors and outdoor weather, OF tracking, assembly-line TVs, and replay of any past shift |
| Pit Stop | The buffer between fabrication and assembly: OF stacks per lane, completeness per component group and an OTIF board |
| Assembly lines | Production counted from end-of-line label scans (Cortex) and run state from ADAM signals, against per-line objectives (cadence, shifts, pauses) |
| Robot cells | Telemetry ingest for FANUC CRX cobots |
| Dashboards | Custom card dashboards, readable on shop-floor TVs |

### Inventory & purchasing

| Module | What it does |
|--------|--------------|
| Inventory | Parts catalog with a stock-movement ledger, weighted-average cost, low-stock tracking and retired parts |
| Suppliers | Supplier directory shared by inventory and purchasing |
| Purchase Orders | Orders with line items, receiving into stock and quote attachments |

### Analytics & AI

| Module | What it does |
|--------|--------------|
| KPIs | MTBF, MTTR, OEE and availability per machine or department, counted over the factory's working calendar |
| Machine Reports | Per-machine report (availability/OEE trend, downtime Pareto, cost by type), side-by-side comparison, and productivity by machine, operator, shift or department |
| Costs | Budget vs actual (OPEX/CAPEX), S-curve and forecast, commitments, reconciliation and supplier insights, fed by the SAP GL import |
| Ask Ninja | AI assistant (Claude) that answers questions about any platform data, generates maintenance reports and has a hands-free voice mode ("Hey Ninja") |
| Home | Live insights detected automatically from plant data |

### Platform

| Module | What it does |
|--------|--------------|
| Multi-plant | One app for several plants, with data segregated per plant across the whole data path |
| Users & permissions | Invitations, password reset, roles, per-page permissions and plant access |
| Notifications | SLA escalation over SMS (Twilio) and Microsoft Teams |
| Settings | Technicians, shifts & breaks, departments, factory calendar, escalation, devices, line objectives |
| Multilingual | English, French, Spanish; °C/°F per user |

## Integrations

| System | How it connects |
|--------|-----------------|
| IoT sensors | MQTT → `iot_consumer` (see [Sensor integration](#sensor-integration-mqtt)) |
| Yokogawa Sushi Sensor | LoRaWAN uplinks pushed by the network server to `/api/sushi/uplink` → Condition tab per asset — [contract](docs/sushi-sensor-contract.md) |
| Advantech ADAM | I/O modules polled over Modbus/TCP by `adam_gateway` → production counts and run signals |
| Cortex | Push API for cobot OF reads (`/api/v1/cortex/events`) + `cortex_poller` for end-of-line label scans |
| FANUC CRX cobots | Telemetry ingest per robot cell — [contract](docs/robot-cell-telemetry-contract.md) |
| SAP | Monthly GL cost extract imported on the Costs page; Pit Stop feed — [contract draft](docs/pit-stop-sap-contract.md) |
| Interal (legacy CMMS) | Import scripts for the work-order history, the inventory catalog and the purchase orders (`backend/scripts/`) |
| Twilio · Microsoft Teams | SMS and channel notifications |
| Open-Meteo | Outdoor weather per plant |
| Anthropic Claude · ElevenLabs | Ask Ninja and AI note organizing; optional premium voice |

## Sensor integration (MQTT)

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

## Roadmap

```
Phase 1 · Local CMMS                                    → built
Phase 2 · IoT ingestion (MQTT, LoRaWAN, Modbus/TCP)     → built; field rollout in progress
Phase 3 · Full MES + ML predictive + multi-plant cloud  → MES layer and multi-plant built;
                                                          ML models wait for enough sensor history;
                                                          runs on-prem today
```

## Useful commands

```bash
# Start
docker compose up -d

# Follow the logs in real time
docker compose logs -f

# Stop
docker compose down

# Rebuild after backend changes (the frontend hot-reloads through docker-compose.override.yml)
docker compose up -d --build backend

# Rebuild everything
docker compose up -d --build

# Open a shell on the database
docker exec -it mes_db psql -U mesadmin -d manutencao
```

## Documentation

- [CONTEXT.md](CONTEXT.md) — architecture, data model and module notes
- [CLAUDE.md](CLAUDE.md) — conventions for AI coding agents (English-only repository, i18n rules)
- [docs/](docs/) — integration contracts and design notes
- [docs/backup-restore.md](docs/backup-restore.md) — database backups: check them, rehearse a restore, restore production
