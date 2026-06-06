# Session Handoff — 2026-06-06

> Drop this file into a new Claude Code session and say: "Read SESSION_HANDOFF.md and continue."

---

## 1. Current State — What Works / What Doesn't

### ✅ Working

| Area | Detail |
|---|---|
| **Login** | `POST /api/auth/login` → JWT in Zustand memory. `admin@foliot.com` / `admin123` |
| **Dashboard** | KPI cards (open/in-progress/critical/completed today), WO by type/status charts, recent WOs table. |
| **Work Order CRUD** | Create, list, detail, start (→ in_progress via POST /iniciar), complete (→ completed via POST /concluir), hold, cancel. |
| **WO Detail — full tabbed UI** | 5 tabs: Overview / Labor / Parts / Costs / Timeline. All sub-resources load on mount via Promise.allSettled. Forms to add labor records, parts, costs, comments. |
| **WO sub-resources (API + UI)** | `GET/POST /api/wo/{id}/labor` — labor records per technician<br>`GET/POST /api/wo/{id}/parts` — parts used<br>`GET/POST /api/wo/{id}/costs` — cost transactions<br>`GET /api/wo/{id}/costs/summary` — aggregated totals<br>`GET/POST /api/wo/{id}/actions` — audit trail / comments |
| **Technician management** | List page at `/technicians`, create page at `/technicians/new`. API: `GET/POST /api/technicians/`. |
| **iot_worker** | **FIXED** — aiomqtt 1.x API fix applied. Worker is running and subscribed to MQTT. No more crash loop. |
| **Equipment catalog** | 3 seeded items: EQ-001/002/003 |
| **Database** | All 17 tables created. Seed data loaded. TimescaleDB extension active. |
| **i18n** | EN / FR / ES. All WO tabs, fields, technician pages, specialties, shifts translated. |

### ❌ Not Yet Built

| Area | Status | Detail |
|---|---|---|
| **Inventory UI** | Stub | `GET /api/inventory/` returns `[]`. No UI. |
| **KPI endpoints** | Stub | `GET /api/kpis/` returns `[]`. MTBF/MTTR/Availability not computed. |
| **Machine stop tracking** | Not started | `paradas_maquina` table not yet created. Needed for Availability KPI. |
| **Stock movements** | Not started | `movimentacoes_estoque` table not yet created. |

---

## 2. Docker — Start / Stop Commands

```bash
# Start everything (from Z:\manutencao-mes\manutencao-mes)
docker compose up -d

# Rebuild one service after code changes — ALWAYS use up -d, NOT restart
docker compose up --build --no-deps -d backend
docker compose up --build --no-deps -d frontend
docker compose up --build --no-deps -d iot_worker

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
| IoT consumer worker | `mes_iot_worker` | — (running, subscribed to MQTT) |

### URLs
- App: http://localhost
- Swagger: http://localhost/docs
- MQTT: localhost:1883

---

## 3. Next Tasks — Priority Order

### Priority 1 — KPI Backend + Dashboard

**Why first:** High business value. The `paradas_maquina` table and MTBF/MTTR/Availability calculations are the core of the maintenance module. Backend stub exists at `kpis.py`.

**What to build:**
1. `paradas_maquina` table (add to `models/models.py`, schema migration)
2. Expand `kpis.py` from stub:
   - `GET /api/kpis/mttr?equipamento_id=&periodo_dias=90`
   - `GET /api/kpis/availability?equipamento_id=&periodo_dias=30`
   - `GET /api/kpis/backlog` (open WOs by age bucket)
   - `GET /api/kpis/pm-compliance`
3. Frontend KPI page or expand Dashboard

**MTTR formula:** `AVG(tempo_reparo_h)` from `ordens_servico WHERE tipo='corrective' AND status='completed'` — can implement immediately without `paradas_maquina`

### Priority 2 — Inventory Management UI

**Why second:** Parts catalog exists but there's no UI. Technicians need to record parts on WOs.

**What to build:**
1. New page: `frontend/src/pages/Inventory/InventoryList.tsx`
   - Table: code, name, location, quantity (with low-stock highlight), min_qty, unit_cost
2. The stock movements (`movimentacoes_estoque`) table needs to be created first if we want movement history
3. Add route `/inventory` to App.tsx and Sidebar

**Backend:**
- `GET /api/inventory/` stub exists at `estoque.py` — expand it
- Need `GET /api/inventory/low-stock` — items at or below reorder point

### Priority 3 — Machine Stop Tracking

**Why third:** Required for Availability KPI. Sets up the MTBF calculation.

**What to build:**
1. `paradas_maquina` table in `models/models.py`
2. New route: `/api/stops/` (GET list, POST create, PATCH /{id} to set fim)
3. Auto-link to WO when stop creates a corrective WO

---

## 4. Known Minor Issues

| Issue | Severity | Location | Fix |
|---|---|---|---|
| `docker-compose.yml` deprecated `version:` attribute | Info | `docker-compose.yml` line 1 | Remove `version: "3.9"` line |
| Labor tab shows `tecnico_id` UUID instead of name | Low | `WorkOrderDetail.tsx` LaborTab | Join technician name when fetching labor records, or add `technician_name` to LaborOut schema |
| WO assigned_to shows UUID slice, not name | Low | `WorkOrderDetail.tsx` quick-bar | Add `assigned_to_name` to OSOut via join in route |

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
- Equipment: `CNC Router Line 3` (EQ-001), `Edge Banding Machine` (EQ-002), `Hydraulic Press A` (EQ-003)
- Admin user: `admin@foliot.com` / `admin123`

---

## 6. Architecture Quick-Reference

```
JWT token → Zustand memory only (never localStorage) — security requirement
axios baseURL: ''  + explicit /api/ prefix on every call
All list endpoints → { total: number, items: T[] }  (never bare array)
  EXCEPT: /api/users/ returns plain List[UsuarioOut] (not paginated)
All enum values stored as VARCHAR (native_enum=False) — avoids Postgres ENUM migration pain
Pydantic v2: validation_alias reads Portuguese ORM attrs, outputs English JSON keys
WO number format: WO-YYYY-NNNNN (server-generated)
UUID PKs everywhere (string in frontend, UUID(as_uuid=True) in SQLAlchemy)
concluir endpoint: POST /api/wo/{id}/concluir?tempo_reparo_h=X  (query param, not body)
iniciar endpoint: POST /api/wo/{id}/iniciar  (no body needed)
```

---

## 7. File Locations

```
Project root:    Z:\manutencao-mes\manutencao-mes\
Backend:         backend/app/
  Models:        backend/app/models/models.py        ← all ORM + enums
  WO routes:     backend/app/api/routes/ordens_servico.py
  Technicians:   backend/app/api/routes/tecnicos.py
  KPIs (stub):   backend/app/api/routes/kpis.py
  Inventory(stub):backend/app/api/routes/estoque.py
  WO schemas:    backend/app/schemas/ordem_servico.py
  Sub-resources: backend/app/schemas/wo_subresources.py
  Tech schemas:  backend/app/schemas/tecnico.py
  Seed:          backend/scripts/seed.py
  iot worker:    backend/app/workers/iot_consumer.py  ← FIXED

Frontend:        frontend/src/
  Types:         frontend/src/types/index.ts
  API helpers:   frontend/src/api/workOrders.ts
  WO detail:     frontend/src/pages/WorkOrders/WorkOrderDetail.tsx  ← full tabs
  Tech list:     frontend/src/pages/Technicians/TechnicianList.tsx
  New tech:      frontend/src/pages/Technicians/NewTechnician.tsx
  i18n EN:       frontend/src/i18n/locales/en.json

Context:         CONTEXT.md           ← full project reference
Handoff:         SESSION_HANDOFF.md   ← this file
```
