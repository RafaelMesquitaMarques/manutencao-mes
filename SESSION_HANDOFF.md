# Session Handoff — 2026-06-05

> Drop this file into a new Claude Code session and say: "Read SESSION_HANDOFF.md and continue."

---

## 1. Current State — What Works / What Doesn't

### ✅ Working

| Area | Detail |
|---|---|
| **Login** | `POST /api/auth/login` → JWT in Zustand memory. `admin@foliot.com` / `admin123` |
| **Dashboard** | KPI cards (open/in-progress/critical/completed today), WO by type/status charts, recent WOs table. Handles empty state gracefully (Promise.allSettled). |
| **Work Order CRUD** | Create, list, detail, iniciar (→ in_progress), concluir (→ completed). All 16 new CMMS fields in DB and schema. |
| **Equipment catalog** | 3 seeded items: EQ-001 CNC Router, EQ-002 Edge Banding, EQ-003 Hydraulic Press. |
| **WO sub-resources (API only)** | `GET/POST /api/wo/{id}/labor` — labor records per technician<br>`GET/POST /api/wo/{id}/parts` — parts used<br>`GET/POST /api/wo/{id}/costs` — cost transactions<br>`GET /api/wo/{id}/costs/summary` — aggregated totals<br>`GET/POST /api/wo/{id}/actions` — audit trail / comments |
| **Technicians API** | `GET/POST /api/technicians/`, `GET /api/technicians/{id}`. Returns 0 records (none created yet). |
| **Database** | All 17 tables created and verified. Seed data loaded. TimescaleDB extension active. |
| **Pydantic v2 alias pattern** | Portuguese ORM field names → English JSON output via `validation_alias`. All enum values in English (stored as VARCHAR, `native_enum=False`). |
| **i18n** | EN / FR / ES. All work order types, statuses, priorities translated. |

### ❌ Broken / Not Yet Built

| Area | Status | Detail |
|---|---|---|
| **iot_worker** | **Crashing** (Restarting loop) | `aiomqtt` 1.2.1 changed API: `async for message in client.messages` fails. Fix: `async with client.messages() as messages: async for message in messages:` |
| **WO Detail page frontend** | **Stub only** | `WorkOrderDetail.tsx` exists but shows minimal info. No tabs for Labor / Parts / Costs / Actions. |
| **Technician management UI** | **Missing** | API exists, no frontend pages to create/list technicians. |
| **Inventory UI** | **Stub** | `GET /api/inventory/` returns `[]`. No UI. |
| **KPI endpoints** | **Stub** | `GET /api/kpis/` returns `[]`. MTBF/MTTR/Availability not computed. |
| **Machine stop tracking** | **Not started** | `paradas_maquina` table not yet created. Needed for Availability KPI. |
| **Stock movements** | **Not started** | `movimentacoes_estoque` table not yet created. |

---

## 2. Docker — Start / Stop Commands

```bash
# Start everything (from Z:\manutencao-mes\manutencao-mes)
docker compose up -d

# Rebuild one service after code changes — ALWAYS use up -d, NOT restart
docker compose up --build --no-deps -d backend
docker compose up --build --no-deps -d frontend

# View logs
docker compose logs -f backend
docker compose logs -f iot_worker

# DB shell
docker exec -it mes_db psql -U mesadmin -d manutencao

# Re-run seed (idempotent — safe to run again)
docker exec mes_backend sh -c 'python /app/scripts/seed.py'

# FULL DB RESET (nuclear — only if schema changes break existing tables)
docker exec mes_db psql -U mesadmin -d manutencao -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker exec mes_db psql -U mesadmin -d manutencao -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"
docker compose up --build --no-deps -d backend
docker exec mes_backend sh -c 'python /app/scripts/seed.py'
```

### Service map
| Service | Container | Exposed |
|---|---|---|
| nginx (reverse proxy) | `mes_nginx` | `:80` → everything |
| FastAPI backend | `mes_backend` | `:8000` (internal) |
| React frontend | `mes_frontend` | `:3000` (internal) |
| PostgreSQL + TimescaleDB | `mes_db` | `:5432` |
| Redis | `mes_redis` | `:6379` |
| Mosquitto MQTT | `mes_mqtt` | `:1883` |
| IoT consumer worker | `mes_iot_worker` | — (currently crashing, see bugs) |

### URLs
- App: http://localhost
- Swagger: http://localhost/docs
- MQTT: localhost:1883

---

## 3. Next 3 Tasks — Priority Order

### Priority 1 — WO Detail Page (frontend)

**Why first:** This is the most visible gap. Users can create WOs but the detail view is a stub. All the backend sub-resources are ready.

**What to build:**
- Tabbed layout: **Overview** | **Labor** | **Parts** | **Costs** | **Timeline**
- Overview tab: all WO fields (type, priority, status, equipment, description, diagnostic, resolution, execution_mode, classification, failure_code, tag, cost_center, downtime_minutes, completion_ratio)
- Status action buttons: "Start WO" (if open), "Complete WO" (if in_progress), "Hold" / "Resume"
- Labor tab: list from `GET /api/wo/{id}/labor`, form to add `POST /api/wo/{id}/labor` (pick technician, date, hours, activity)
- Parts tab: list from `GET /api/wo/{id}/parts`, form to add (description, part_number, quantity, unit_cost)
- Costs tab: list + summary card from `/costs` and `/costs/summary`
- Timeline tab: action log from `GET /api/wo/{id}/actions`; form to add comment (`action_type: "comment"`)

**Files to touch:**
- `frontend/src/pages/WorkOrders/WorkOrderDetail.tsx` — full rewrite
- `frontend/src/api/workOrders.ts` — add `fetchWOLabor`, `addWOLabor`, `fetchWOParts`, `addWOPart`, `fetchWOCosts`, `addWOCost`, `fetchWOCostSummary`, `fetchWOActions`, `addWOAction`
- `frontend/src/types/index.ts` — add `LaborRecord`, `WOPart`, `WOCost`, `WOCostSummary`, `WOAction` interfaces

---

### Priority 2 — Fix iot_worker (1-line fix)

**Why second:** Low effort, stops the container from restarting every 30 seconds. Noise in `docker compose ps`.

**File:** `backend/app/workers/iot_consumer.py` around line 92

**Current (broken):**
```python
async with aiomqtt.Client(...) as client:
    await client.subscribe("usinas/+/captores/+/leitura")
    async for message in client.messages:   # ← TypeError in aiomqtt 1.2.1
        ...
```

**Fix:**
```python
async with aiomqtt.Client(...) as client:
    await client.subscribe("usinas/+/captores/+/leitura")
    async with client.messages() as messages:   # aiomqtt 1.x API
        async for message in messages:
            ...
```

After edit: `docker compose up --build --no-deps -d iot_worker`

---

### Priority 3 — Technician Management UI

**Why third:** Required before labor records can be entered on WO detail. Without it the "Labor" tab on the WO detail page has an empty technician dropdown.

**What to build:**

Backend (already done):
- `GET /api/technicians/` → `{ total, items: TecnicoOut[] }`
- `POST /api/technicians/` → `TecnicoOut`
- `TecnicoOut` includes `full_name` and `email` (joined from `usuarios`)

Frontend:
1. New page: `frontend/src/pages/Technicians/TechnicianList.tsx`
   - Table: name, employee_number, specialty, shift, hourly_rate, active
   - "New Technician" button → modal or `/technicians/new`
2. New page: `frontend/src/pages/Technicians/NewTechnician.tsx`
   - Form: pick user from `/api/users/`, employee_number, specialty (dropdown), shift (dropdown), hourly_rate
   - `POST /api/technicians/`
3. Add route to `App.tsx`: `/technicians` and `/technicians/new`
4. Add nav link in `Sidebar.tsx` under "Maintenance" group
5. Add API helpers to `workOrders.ts`: `fetchTechnicians()` (already exists, update to use `/api/technicians/` not `/api/users/`), `createTechnician()`

Specialty options: `electromechanical | mechanical | electrical | instrumentation | welding | hydraulics`
Shift options: `day | evening | night | rotating`

---

## 4. Known Bugs

| Bug | Severity | Location | Fix |
|---|---|---|---|
| `iot_worker` crashes on start | Medium | `backend/app/workers/iot_consumer.py:92` | See Priority 2 above — aiomqtt 1.x API change |
| `fetchTechnicians()` calls `/api/users/` and maps `nome→full_name` | Low | `frontend/src/api/workOrders.ts` | Update to call `/api/technicians/` directly |
| `WorkOrderDetail.tsx` is a stub | High (UX) | `frontend/src/pages/WorkOrders/WorkOrderDetail.tsx` | See Priority 1 above |
| `docker-compose.yml` has deprecated `version:` attribute | Info | `docker-compose.yml` line 1 | Remove the `version: "3.9"` line |

---

## 5. DB Credentials & Seed Data

```
DB user:     mesadmin
DB password: troque-em-producao
DB name:     manutencao
DB host:     db (inside Docker) / localhost:5432 (from host)
```

**Seeded data:**
- Plant: `Foliot Furniture - Plant 1` (code: `PLT1`)
- Equipment: `CNC Router Line 3` (EQ-001, Production Line 3, criticality: alta)
- Equipment: `Edge Banding Machine` (EQ-002, Production Line 1, criticality: media)
- Equipment: `Hydraulic Press A` (EQ-003, Press Room, criticality: critica)
- Admin user: `admin@foliot.com` / `admin123`

---

## 6. Architecture Quick-Reference

```
JWT token → Zustand memory only (never localStorage) — security requirement
axios baseURL: ''  + explicit /api/ prefix on every call
All list endpoints → { total: number, items: T[] }  (never bare array)
All enum values stored as VARCHAR (native_enum=False) — avoids Postgres ENUM migration pain
Pydantic v2: validation_alias reads Portuguese ORM attrs, outputs English JSON keys
WO number format: WO-YYYY-NNNNN (server-generated)
UUID PKs everywhere (string in frontend, UUID(as_uuid=True) in SQLAlchemy)
```

---

## 7. File Locations

```
Project root:    Z:\manutencao-mes\manutencao-mes\
Backend:         backend/app/
  Models:        backend/app/models/models.py        ← all ORM + enums
  WO routes:     backend/app/api/routes/ordens_servico.py
  Technicians:   backend/app/api/routes/tecnicos.py
  WO schemas:    backend/app/schemas/ordem_servico.py
  Sub-resources: backend/app/schemas/wo_subresources.py
  Tech schemas:  backend/app/schemas/tecnico.py
  Seed:          backend/scripts/seed.py

Frontend:        frontend/src/
  Types:         frontend/src/types/index.ts
  API helpers:   frontend/src/api/workOrders.ts
  WO detail:     frontend/src/pages/WorkOrders/WorkOrderDetail.tsx  ← STUB
  i18n EN:       frontend/src/i18n/locales/en.json

Context:         CONTEXT.md           ← full project reference
Handoff:         SESSION_HANDOFF.md   ← this file
```
