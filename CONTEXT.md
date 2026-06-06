# Foliot MES — Project Context

> **Purpose of this file:** Single source of truth for AI coding sessions and onboarding.
> Read this before touching any module. Keep it updated as architecture evolves.

---

## 1. What This System Is

**Foliot Furniture MES** — an industrial maintenance and manufacturing execution platform
built to replace an external monitoring vendor. Multi-plant, multi-user, multi-language (EN / FR / ES).

**Primary use case today:** CMMS (Computerized Maintenance Management System) for a furniture
manufacturing plant. IoT sensor data from physical sensors already on the shop floor feeds in
via MQTT. The roadmap extends this into a full MES with OEE, predictive maintenance, and SAP
integration.

**Company context:** Foliot Furniture. Plant timezone: America/Toronto.

---

## 2. Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript, Tailwind CSS (dark), Zustand, Axios, Recharts, react-i18next, react-router-dom v6, lucide-react |
| Backend | FastAPI (Python 3.12), SQLAlchemy async (asyncpg), Pydantic v2 |
| Database | TimescaleDB (PostgreSQL 15 extension) — hypertable on `sensor_readings` |
| Cache / Queue | Redis |
| IoT Broker | Mosquitto MQTT |
| Proxy | nginx:alpine (inline config via heredoc — no file mounts, Z: network drive) |
| Container | Docker Compose, all services in one stack |
| Auth | JWT (Bearer), FastAPI OAuth2, bcrypt 4.1.3 direct (no passlib) |

---

## 3. Repository Layout

```
manutencao-mes/
├── backend/
│   └── app/
│       ├── api/routes/              # One file per domain
│       │   ├── auth.py              # POST /api/auth/login → {access_token, user_id, name, language}
│       │   ├── work_orders.py       # /api/wo/  (list, dashboard, CRUD, start, complete, sub-resources)
│       │   ├── technicians.py       # /api/technicians/
│       │   ├── equipment.py         # /api/equipment/
│       │   ├── maintenance_plans.py # /api/plans/
│       │   ├── inventory.py         # /api/inventory/   ← stub only
│       │   ├── kpis.py              # /api/kpis/        ← stub only
│       │   ├── alerts.py            # /api/alerts/
│       │   ├── iot.py               # /api/iot/
│       │   ├── users.py             # /api/users/
│       │   └── plants.py            # /api/plants/
│       ├── core/
│       │   ├── config.py            # Settings from .env
│       │   └── security.py          # JWT encode/decode, bcrypt, get_current_user
│       ├── db/
│       │   ├── base.py              # Base = declarative_base()
│       │   └── session.py           # async engine + get_db dependency
│       ├── models/models.py         # All ORM models (see Section 5)
│       ├── schemas/
│       │   ├── work_order.py        # WorkOrderCreate, WorkOrderUpdate, WorkOrderOut, WorkOrderListResponse
│       │   ├── wo_subresources.py   # LaborCreate/Out, WOPartCreate/Out, WOCostCreate/Out, WOActionCreate/Out
│       │   ├── technician.py        # TechnicianCreate, TechnicianOut, TechnicianListResponse
│       │   ├── equipment.py         # EquipmentCreate, EquipmentOut, EquipmentListResponse
│       │   └── user.py              # UserCreate, UserOut, LoginRequest, TokenResponse
│       ├── services/                # Business logic (mostly stubs)
│       ├── workers/
│       │   └── iot_consumer.py      # MQTT → TimescaleDB ingestor
│       └── main.py                  # FastAPI app, CORS, router registration
├── frontend/
│   └── src/
│       ├── api/
│       │   ├── axios.ts             # baseURL:'', Bearer interceptor, auto-logout on 401
│       │   ├── auth.ts              # POST /api/auth/login (JSON body)
│       │   └── workOrders.ts        # All WO + inventory + equipment API calls
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── Dashboard.tsx        # KPI cards + recent WOs (Promise.allSettled)
│       │   └── WorkOrders/
│       │       ├── WorkOrderList.tsx
│       │       ├── WorkOrderDetail.tsx
│       │       └── NewWorkOrder.tsx
│       ├── components/
│       │   ├── ui/                  # Badge, Spinner, etc.
│       │   ├── charts/              # WOBarChart, WODonutChart (Recharts)
│       │   └── layout/              # Sidebar, Layout wrapper
│       ├── store/
│       │   └── authStore.ts         # Zustand — token in memory ONLY (never localStorage)
│       ├── i18n/
│       │   └── locales/             # en.json, fr.json, es.json
│       └── types/index.ts           # All shared TypeScript interfaces
├── nginx/                           # Reference only — config is embedded in docker-compose.yml command
├── scripts/
│   ├── init_db.sql                  # Creates hypertable on sensor_readings, indexes
│   └── mosquitto.conf
├── docker-compose.yml
├── .env.example
├── README.md
└── CONTEXT.md                       # ← this file
```

---

## 4. Running the Stack

```bash
# Start everything
docker compose up -d

# Rebuild one service after code changes
docker compose up --build --no-deps -d frontend
docker compose up --build --no-deps -d backend

# IMPORTANT: use `up -d`, NOT `restart` — restart reuses old container config
# (command: overrides in docker-compose.yml are only picked up on `up`)

# Logs
docker compose logs -f backend
docker compose logs -f frontend

# DB shell
docker exec -it mes_db psql -U mesadmin -d manutencao

# Re-seed after DB reset
docker exec mes_backend python /app/scripts/seed.py
```

URLs (all through nginx on port 80):

| Endpoint | URL |
|---|---|
| App | http://localhost |
| API | http://localhost/api |
| Swagger docs | http://localhost/docs |
| MQTT | localhost:1883 |

---

## 5. Database — Current Model

All PKs are UUID. TimescaleDB hypertable on `sensor_readings(timestamp)`.

### Core tables

| Table | Key fields | Notes |
|---|---|---|
| `plants` | id, code, name, timezone, active | Multi-plant root |
| `users` | id, name, email, password_hash, language, active | language: en\|fr\|es |
| `user_plants` | user_id, plant_id, role | role enum: technician\|supervisor\|plant_manager\|director\|admin |
| `equipment` | id, plant_id, code, name, location, status, criticality, hour_meter, specifications(JSON) | status enum: running\|in_maintenance\|stopped\|scrapped |
| `maintenance_plans` | id, equipment_id, name, trigger_type, interval_days, interval_hours, last_executed_at, next_execution_at | Triggers preventive WOs |
| `stock_items` | id, plant_id, code, name, unit, quantity, min_quantity, location, unit_cost, supplier | Parts catalog |
| `work_order_stock_items` | id, work_order_id, stock_item_id, quantity, unit_cost | Legacy parts consumed per WO |
| `sensors` | id, equipment_id, code, name, type, unit, min_limit, max_limit, active | Physical IoT sensors |
| `sensor_readings` | id, sensor_id, equipment_id, timestamp, value, quality | **Hypertable** — time-series |
| `alerts` | id, sensor_id, equipment_id, type, severity, value_read, message, acknowledged, work_order_id | IoT threshold breach |

### `work_orders` — full field mapping

| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| wo_number | VARCHAR(20) UNIQUE | Format: `WO-YYYY-NNNNN` |
| equipment_id | UUID FK | |
| created_by_id | UUID FK → users | |
| assigned_to_id | UUID FK → users | Primary assigned user |
| executor_id | UUID FK → technicians | Primary executing technician profile |
| plan_id | UUID FK → maintenance_plans | nullable |
| type | ENUM(WorkOrderType) | corrective\|preventive\|predictive\|inspection\|improvement |
| priority | ENUM(WorkOrderPriority) | low\|medium\|high\|critical |
| status | ENUM(WorkOrderStatus) | open\|in_progress\|on_hold\|completed\|cancelled |
| title | VARCHAR(500) | |
| short_description | VARCHAR(200) | One-liner for lists/notifications |
| description | TEXT | Full description |
| root_cause | TEXT | Root cause analysis |
| solution_applied | TEXT | Solution applied |
| opened_at | TIMESTAMPTZ | Server default: now() |
| due_date | TIMESTAMPTZ | Due date |
| started_at | TIMESTAMPTZ | When work actually started |
| completed_at | TIMESTAMPTZ | When WO was completed |
| downtime_hours | FLOAT | Equipment downtime in hours |
| repair_hours | FLOAT | Labor hours |
| total_cost | FLOAT | Aggregated total cost |
| execution_mode | ENUM(ExecutionMode) | internal\|external\|contract |
| classification | VARCHAR(100) | Maintenance classification code |
| failure_code | VARCHAR(50) | Equipment failure mode code |
| component | VARCHAR(200) | Specific component/subassembly |
| tag | VARCHAR(100) | Equipment tag / asset label |
| project_number | VARCHAR(100) | Capital project number if applicable |
| cost_center | VARCHAR(100) | Accounting cost center |
| from_iot | BOOLEAN | Auto-generated from IoT alert |
| alert_id | UUID FK → alerts | nullable |

### CMMS sub-resource tables (implemented)

| Table | Key fields | Notes |
|---|---|---|
| `technicians` | id, user_id(FK unique), employee_number, specialty, shift, hourly_rate, certifications(JSON), active | specialty enum: electromechanical\|mechanical\|electrical\|instrumentation\|welding\|hydraulics; shift: day\|evening\|night\|rotating |
| `labor_records` | id, work_order_id(FK), technician_id(FK), date, hours_worked, hourly_rate, labor_cost, activity, notes | Hours per technician per WO |
| `wo_parts` | id, work_order_id(FK), stock_item_id(FK nullable), part_number, description, quantity, unit, unit_cost, total_cost, supplier | Parts used on WO |
| `wo_costs` | id, work_order_id(FK), transaction_type, description, amount, currency, reference, date | transaction_type enum: local_parts\|labor\|external_parts\|contracts\|rentals\|other |
| `wo_actions` | id, work_order_id(FK), author_id(FK), action_type, content, old_value, new_value | Audit trail: comment\|status_change\|assignment\|attachment |
| `supplier_orders` | id, work_order_id(FK nullable), supplier_name, po_number, amount, currency, status, ordered_at, expected_at, received_at | status enum: pending\|partial\|received\|cancelled |

### Tables to add (next phase)

| Table | Purpose |
|---|---|
| `stock_movements` | Stock in/out movements linked to WOs |
| `machine_stops` | Machine stop events → corrective WO linkage |

---

## 6. API Routes (current)

### Authentication
```
POST /api/auth/login
  body: { email, password }   ← JSON, not form-encoded
  response: { access_token, token_type, user_id, name, language }
```

### Work Orders — /api/wo/
```
GET    /api/wo/              → { total, items: WorkOrderOut[] }   (paginated, filter by status/type/priority/search)
GET    /api/wo/dashboard     → { total_open, in_progress, on_hold, critical, completed_today, by_type[], by_status[] }
GET    /api/wo/{id}          → WorkOrderOut
POST   /api/wo/              → WorkOrderOut (201)
PATCH  /api/wo/{id}          → WorkOrderOut
POST   /api/wo/{id}/start    → WorkOrderOut  (sets status=in_progress, started_at)
POST   /api/wo/{id}/complete → WorkOrderOut  (sets status=completed, completed_at)

# Sub-resources
GET    /api/wo/{id}/labor              → { total, items: LaborOut[] }
POST   /api/wo/{id}/labor              → LaborOut (201)
GET    /api/wo/{id}/parts              → { total, items: WOPartOut[] }
POST   /api/wo/{id}/parts              → WOPartOut (201)
GET    /api/wo/{id}/costs              → { total, items: WOCostOut[] }
POST   /api/wo/{id}/costs              → WOCostOut (201)
GET    /api/wo/{id}/costs/summary      → { labor_total, parts_total, other_total, grand_total }
GET    /api/wo/{id}/actions            → { total, items: WOActionOut[] }
POST   /api/wo/{id}/actions            → WOActionOut (201)
```

### Equipment — /api/equipment/
```
GET    /api/equipment/           → { total, items: EquipmentOut[] }
GET    /api/equipment/{id}       → EquipmentOut
POST   /api/equipment/           → EquipmentOut (201)
PATCH  /api/equipment/{id}       → EquipmentOut
DELETE /api/equipment/{id}       → 204
PATCH  /api/equipment/{id}/hour-meter  → EquipmentOut  (body: { value: float })
```

### Technicians — /api/technicians/
```
GET    /api/technicians/           → { total, items: TechnicianOut[] }
GET    /api/technicians/{id}       → TechnicianOut
POST   /api/technicians/           → TechnicianOut (201)  body: { user_id, employee_number, specialty, shift, hourly_rate, certifications[] }
```

### Users — /api/users/
```
GET    /api/users/                 → UserOut[]
GET    /api/users/{id}             → UserOut
PATCH  /api/users/{id}             → UserOut
POST   /api/users/{id}/plants/{plant_id}  → assigns user to plant with role
```

### Other active routes
```
GET /api/plants/     ← stub, returns []
GET /api/alerts/     ← stub, returns []
GET /api/plans/      ← stub, returns []
GET /api/inventory/  ← stub, returns []
GET /api/kpis/       ← stub, returns []
GET /api/iot/        ← stub
GET /api/health
```

---

## 7. Frontend — Key Conventions

### Auth flow
- Login → `POST /api/auth/login` → response contains `{access_token, user_id, name, language}`
- Token stored **in Zustand memory only** — never in localStorage. Security requirement.
- All API calls use `baseURL: ''` with explicit `/api/` prefixes on every path
- axios interceptor auto-attaches `Authorization: Bearer <token>` from store
- axios interceptor auto-calls `logout()` on any 401

### API response shapes
- Work order list: `GET /api/wo/` returns `{ total: number, items: WorkOrder[] }` — **not a plain array**
- `fetchWorkOrders()` in `api/workOrders.ts` handles both: `Array.isArray(data) ? data : data.items ?? []`
- Dashboard: `GET /api/wo/dashboard` returns status count object directly (not paginated)

### Error handling philosophy
- Dashboard and WorkOrderList use `Promise.allSettled` — API failures show empty/zero state, never full-page error
- When `workOrders.length === 0` (empty or failed fetch): show "Create First Work Order" CTA linking to `/work-orders/new`
- KPI cards use `?? 0` fallbacks; chart panels use `{t('common.noData')}` placeholder

### i18n
- Three locales: en / fr / es (note: originally had PT but switched to EN/FR/ES for Foliot Canada)
- LanguageDetector from react-i18next, stored in localStorage
- All display text goes through `t()` — no hardcoded English in JSX

---

## 8. Maintenance Module — Full Scope

### 8.1 Technician Management (Workforce)

**Goal:** Track who does what, when, and at what cost.

Specialties: `electromechanical | mechanical | electrical | instrumentation | welding | hydraulics`

Required additions:
- `technicians` table: extends `users` with `specialty`, `shift` (day/evening/night/rotating), `hourly_rate` ($/h)
- `labor_records` table: `(technician_id, work_order_id, hours_worked, date, notes)` — multiple records per WO (multiple techs)
- API endpoints: assign technician to WO, log hours, calculate labor cost per WO
- Frontend: technician selector on WO form, labor hours entry on WO detail page

**Implementation note:** `assigned_to_id` on `work_orders` captures primary technician. `labor_records`
handles the full multi-technician labor record. Both coexist.

### 8.2 Parts Inventory

**Goal:** Full traceability: part → WO → equipment. SAP-ready field mapping.

Current state: `stock_items` (catalog) + `work_order_stock_items` (consumed per WO) already exist.

Additions needed:
- `stock_movements` table: `(item_id, work_order_id, quantity, type: in|out, date, user_id, sap_doc_num)`
  - Every stock change must be recorded here — `stock_items.quantity` is derived from movements
  - `sap_doc_num` field reserved for future SAP integration (goods receipt / goods issue)
- Minimum stock alert: cron job or trigger when `quantity <= min_quantity`
- `GET /api/inventory/low-stock` — items below reorder point
- `POST /api/inventory/{id}/movement` — record entry or exit
- Frontend: parts catalog page, stock movement history per part, WO parts consumption tab

**SAP integration note:** When SAP integration is built, `stock_movements` maps to SAP MIGO transactions.
Field `sap_material_code` on `stock_items` will link to SAP material master. Keep this in mind when
designing the inventory schema — add `sap_material_code VARCHAR(40)` from the start.

### 8.3 KPIs & Reports

**Goal:** Real maintenance performance metrics, not vanity counts.

| KPI | Formula | Source data |
|---|---|---|
| MTBF | Total operating time ÷ number of failures | `machine_stops` (operating intervals between stops) |
| MTTR | Total repair time ÷ number of repairs | `work_orders.repair_hours` grouped by equipment |
| Availability % | (Total time − downtime) ÷ Total time × 100 | `machine_stops.duration_hours` per equipment per period |
| Cost per equipment | Sum(labor cost + parts cost) | `labor_records` + `wo_parts` grouped by equipment |
| PM compliance % | WOs completed on time ÷ total PMs scheduled × 100 | `work_orders` where type=preventive, completed_at vs due_date |
| Backlog | Open WOs by age bucket (0-7d, 7-30d, 30d+) | `work_orders` where status in (open, in_progress) |

**Required new table:**
```sql
machine_stops (
  id UUID PK,
  equipment_id UUID FK → equipment,
  work_order_id UUID FK → work_orders NULL,  -- linked corrective WO
  stop_type    VARCHAR(30),                  -- failure | scheduled_maintenance | setup | material_shortage
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ,                  -- NULL = ongoing
  duration_hours FLOAT GENERATED,            -- computed from ended_at - started_at
  source       VARCHAR(20),                  -- manual | iot_alert | maintenance_plan
  notes        TEXT
)
```

KPI endpoints (expand `kpis.py` from stub):
```
GET /api/kpis/mtbf?equipment_id=&period_days=90
GET /api/kpis/mttr?equipment_id=&period_days=90
GET /api/kpis/availability?equipment_id=&period_days=30
GET /api/kpis/cost?equipment_id=&period_days=30
GET /api/kpis/pm-compliance?period_days=30
GET /api/kpis/backlog
```

### 8.4 MES Integration

**Goal:** Maintenance events affect production KPIs. Stops are tracked end-to-end.

**Machine stop → corrective WO flow:**
1. IoT alert fires (limit exceeded on sensor) OR operator manually registers stop
2. System creates `machine_stops` record with `started_at = now()`
3. System auto-creates `work_orders` (type=corrective, from_iot=True, priority=critical)
4. `machine_stops.work_order_id` links to the generated WO
5. When WO is completed → `machine_stops.ended_at = completed_at`, duration computed
6. This stop feeds MTBF / MTTR / Availability KPIs

**Hour meter → preventive WO trigger:**
- `maintenance_plans.trigger_type = 'hour_meter'` with `interval_hours`
- When `equipment.hour_meter` crosses threshold → auto-generate preventive WO
- Worker: poll equipment hour meters vs plan thresholds (scheduled task, every 15 min)

**OEE impact:**
- OEE = Availability × Performance × Quality
- Availability component directly derived from `machine_stops` per shift
- Performance and Quality come from production counters (future: separate production module)

**Future integrations (don't build yet, design for):**
- Real-time sensor data dashboards (sensors already publishing to MQTT)
- SAP MM integration: when inventory reaches reorder point → create SAP PR (purchase requisition)
  via REST API. Field mapping: `stock_items.sap_material_code` → SAP material, `plants.code` → SAP plant

---

## 9. Development Phases

```
Phase 1 — CMMS Core (current)
  ✅ Auth, JWT, multi-plant users
  ✅ Work order CRUD (open/start/complete lifecycle)
  ✅ Equipment catalog
  ✅ Maintenance plans (calendar + hour-meter triggers)
  ✅ Parts catalog + WO parts consumption
  ✅ IoT ingestion (MQTT → TimescaleDB)
  ✅ Alert generation from sensor limits
  ✅ Frontend: Login, Dashboard, WO list/detail/create
  ✅ Technician profiles (technicians table + /api/technicians/)
  ✅ Labor records per WO (/api/wo/{id}/labor)
  ✅ WO parts sub-resource (/api/wo/{id}/parts)
  ✅ WO costs sub-resource (/api/wo/{id}/costs + /costs/summary)
  ✅ WO actions/audit trail (/api/wo/{id}/actions)
  ✅ Supplier orders table
  ✅ Full codebase translation to English (all vars, columns, functions, comments)
  ⬜ Inventory management UI (stub backend exists)
  ⬜ KPI calculations (stub backend exists)
  ⬜ Machine stop tracking (machine_stops table)

Phase 2 — Full Maintenance + IoT (3-6 months)
  ⬜ machine_stops table + stop registration flow
  ⬜ Auto-corrective WO from IoT alert
  ⬜ MTBF / MTTR / Availability KPI endpoints
  ⬜ PM compliance and backlog reports
  ⬜ Stock movements + low-stock alerts
  ⬜ Frontend: KPI dashboard, inventory module

Phase 3 — MES + Predictive (12+ months)
  ⬜ OEE calculation (needs production counters)
  ⬜ Multi-plant dashboard
  ⬜ SAP integration (inventory reorder → SAP PR)
  ⬜ ML anomaly detection on IoT time series
  ⬜ Mobile app for technicians (scan QR → open WO)
```

---

## 10. Key Architectural Decisions

| Decision | Rationale |
|---|---|
| JWT token in Zustand memory only (never localStorage) | Security requirement — XSS cannot steal token |
| nginx inline config via heredoc in docker-compose.yml | Z: network drive (Windows) doesn't support Docker volume mounts |
| bcrypt 4.1.3 direct (no passlib) | passlib had compatibility issues with newer bcrypt |
| `baseURL: ''` on axios, explicit `/api/` on every path | Avoids double-prefix bugs; all requests go through nginx on :80 |
| `Promise.allSettled` on Dashboard | API stubs return errors; dashboard must not crash before endpoints are built |
| `fetchWorkOrders` extracts `.items` from `{ total, items }` | `/api/wo/` returns paginated envelope; callers get `WorkOrder[]` directly |
| UUID PKs everywhere | Multi-plant merges and future cloud sync require globally unique IDs |
| TimescaleDB hypertable on sensor_readings | IoT time-series queries need time-bucketing and compression — native TimescaleDB feature |
| `docker compose up -d` not `restart` | `restart` reuses existing container config; `command:` overrides only take effect on `up` |
| All code in English | Codebase fully translated from Portuguese in session 2026-06-06 — all vars, columns, functions, routes, comments |

---

## 11. Environment Variables (.env)

```
DATABASE_URL=postgresql+asyncpg://mesadmin:mespassword@db:5432/manutencao
REDIS_URL=redis://redis:6379
SECRET_KEY=<random 64-char hex>
ACCESS_TOKEN_EXPIRE_MINUTES=480
MQTT_HOST=mosquitto
MQTT_PORT=1883
```

---

## 12. Naming Conventions

- **Backend:** All English — table names, column names, ORM attribute names, function names, class names, route paths.
- **API routes:** English paths (`/api/wo/`, `/api/equipment/`, `/api/wo/{id}/start`, `/api/wo/{id}/complete`).
- **Frontend:** English TypeScript identifiers. Enum values match backend string values exactly (`'open'`, `'in_progress'`, `'corrective'`, etc.).
- **WO number format:** `WO-YYYY-NNNNN` (zero-padded to 5 digits), generated server-side.
- **API responses:** list endpoints always return `{ total: number, items: T[] }`. Single-item endpoints return the object directly. Never a bare array at top level.
- **MQTT topics:** `usinas/+/captores/+/leitura` — kept unchanged (device firmware constraint; only Python variable names around it are English).
- **i18n files:** `en.json`, `fr.json`, `es.json` in `frontend/src/i18n/locales/` — display strings only, not changed by the English translation refactor.

---

## 13. Known Issues

| Issue | File | Fix |
|---|---|---|
| DB needs reset after English column rename | Run: `docker exec mes_db psql -U mesadmin -d manutencao -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"` then rebuild backend + seed | Run this manually — auto-mode blocked it |
| `docker-compose.yml` has deprecated `version:` key | `docker-compose.yml` line 1 | Remove `version: "3.9"` line |

---

## 14. Session History

### Session 2026-06-05 — Interal CMMS Mapping + DB Expansion

**Completed:**
- Fixed Dashboard: `Promise.allSettled`, zero-state KPI cards, `GET /api/wo/dashboard`, `GET /api/wo/?limit=5`
- Fixed `recentWOs.map is not a function` — API returns `{ total, items }` not bare array
- Migrated all enums from Portuguese to English values; added `native_enum=False` everywhere
- Applied Pydantic v2 `validation_alias` pattern: ORM reads Portuguese attrs, JSON outputs English keys
- Fixed UUID vs Number cast on equipment_id
- Seeded: Plant PLT1, EQ-001/002/003, admin@foliot.com/admin123
- New Work Order form: loads equipment from API, submits to `POST /api/wo/`, redirects on success
- Mapped Interal CMMS field spec → 16 new `ordens_servico` columns
- Added 5 new enums: `EspecialidadeTecnico`, `TurnoTecnico`, `ModoExecucao`, `TipoTransacaoCusto`, `StatusPedidoFornecedor`
- Created 6 new tables: `tecnicos`, `labor_records`, `wo_parts`, `wo_costs`, `wo_actions`, `supplier_orders`
- Full sub-resource API: `/api/wo/{id}/labor|parts|costs|costs/summary|actions`
- New route: `/api/technicians/` (GET list, GET by id, POST create)
- Updated `CONTEXT.md` with full field mapping, new tables, new endpoints
- Created `SESSION_HANDOFF.md`
- Git repo initialized, `.gitignore` created, initial commit `ade20a7`

### Session 2026-06-06 — Full Codebase Translation to English

**Completed:**
- Rewrote `backend/app/models/models.py` — all ORM classes, table names, column names, enum classes translated to English
- New route files: `work_orders.py`, `equipment.py`, `plants.py`, `alerts.py`, `maintenance_plans.py`, `inventory.py`, `users.py`, `technicians.py`
- New schema files: `work_order.py`, `equipment.py`, `user.py`, `technician.py`; updated `wo_subresources.py`
- Updated `auth.py`, `main.py`, `security.py`, `config.py`, `iot_consumer.py`, `seed.py`
- Updated `scripts/init_db.sql` — hypertable now `sensor_readings`, all indexes renamed
- Deleted all Portuguese-named route/schema files
- Frontend: updated `types/index.ts` (all interfaces), `workOrders.ts` (endpoints + field names), `Login.tsx`, `WorkOrderDetail.tsx`, `Header.tsx`, `NewTechnician.tsx`
- Fixed WO start/complete endpoints: `/iniciar` → `/start`, `/concluir` → `/complete`
- Zero Portuguese words remain in `.py` and `.tsx` files (grep confirmed)
- **Pending:** DB reset required — run manually: `docker exec mes_db psql -U mesadmin -d manutencao -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"` then `docker compose up --build --no-deps -d backend` then seed
