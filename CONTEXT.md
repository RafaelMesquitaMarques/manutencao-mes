# Kaizo MES — Project Context

> **Purpose of this file:** Single source of truth for AI coding sessions and onboarding.
> Read this before touching any module. Keep it updated as architecture evolves.
> **Last full sync: 2026-06-21.** Sections 0, 3, 5, 6, 9, 14 reflect the current code; older
> sections may still describe the original 06-06 baseline — trust the code when they disagree.
>
> ⚠️ **Project location (2026-06-21):** the repo now lives at **`C:\KAIZO`** (moved off the
> network drive `Z:\manutencao-mes\manutencao-mes`, whose per-folder quota filled up). **Build and
> run Docker from `C:\KAIZO`.** The Compose project name is pinned (`name: manutencao-mes` in
> `docker-compose.yml`) so the existing data volumes (`manutencao-mes_db_data`, etc.) are reused —
> do NOT run compose from a differently-named folder or it creates empty volumes. See Section 4.

---

## 0. Current State (2026-06-20) — What's Live Now

The platform is **branded "Kaizo"** (ninja logo + wordmark; logo asset is `frontend/public/mirai-icon.png`,
the AI/Intelligence module keeps the "Mirai" naming). Built for **Foliot Furniture** (plant TZ America/Toronto).
Since the 06-06 baseline below, the codebase roughly **tripled**: ~70 ORM tables, ~30 API routers,
~17 backend services, and ~25 frontend page groups.

**Modules live today (beyond CMMS core):**
- **Maintenance flow** — Alerts ↔ Tickets ↔ Work Orders fully linked; alert auto-created with each ticket; SLA escalation engine with configurable `escalation_settings`/`escalation_contacts`.
- **WO Approval** (formerly "Parts Approval") — supervisor/director signs off **every completed work order** (floor `MachineIntervention` + office `work_orders`), work done + parts, in one action. Queue de-duplicates the intervention/WO twin; `/api/wo-approval`, page `/maintenance/wo-approval`.
- **Machine / MES operator** — **unified per-machine kiosk** at `/machines/:slug` (the old `/machine/:id` intervention page now redirects here; `MachineOperatorPage`'s flow is embedded as `<MaintenancePanel embedded>`). One screen for operator + mechanic: status/timer, OF/job, stop justification (stop categories/subcategories, "call maintenance" is a stop reason), reject logging, production, availability gauge, and the full intervention flow. **Supervisor+ can drag/resize the panels** ("Éditer la disposition" → `react-grid-layout`, saved per machine in `machines.kiosk_layout`).
- **Intervention workflow** — intervention types per machine, safety checklist on start, parts consumed during intervention, supervisor approval, voice transcription on closing note.
- **PM / TPM** — PM templates (reusable SOPs with photo/video/link steps), recurring plans → `plan_occurrences`, PM calendar, PM dashboard. Driven by `pm_service` + `_pm_loop` cron.
- **Inventory** — full catalog + `inventory_movements` (stock deduction on intervention), low-stock; parts sign-off folded into WO Approval (above).
- **Suppliers & Purchasing** — suppliers + purchase orders (`/api/suppliers`, `/api/supplier-orders`).
- **Factory Map / digital twin base** — React Flow 2D + Three.js 3D editable map of production assets with live status (`/factory-map`), `factory_zones` + `map_props`, asset positions on `equipment`. Per-machine card shows live **OEE / Availability / Parts-per-hour / Quality / Status / Operator** (from `/api/kpis/summary` + `machine_production_logs`).
- **Robot Cells** — read-only telemetry for FANUC CRX cobots (`robot_cells` + states/samples/alarms), ingest service + simulator. 16 placed cobots registered as cells with per-cell `ingest_token` (transport/auth to finalize with integrator).
- **Intelligence (Mirai)** — tool-use AI agent (`/api/intelligence`, anthropic SDK opus-4-8) + `intelligence_ai`/`intelligence_calculator`; AI insights/recommendations/risk-score tables; `_intelligence_cron`.
- **Identity & access** — user invitations, password reset / forced first-login change, **permissions enforcement** (allow-list override or role default; backend `resource_guard`, frontend `RequireView`/`can()`).
- **Reports** — `/api/reports`, machine reports page.

**Backend cron tasks (in lifespan):** `_escalation_loop`, `_pm_loop`, `_intelligence_cron`.

> The detailed module notes in Sections 1–14 below predate most of the above. They remain useful
> for the core CMMS but are NOT exhaustive of current functionality. Use Section 0 + the code as truth.

---

## 1. What This System Is

**Kaizo MES** (internal product name; built for **Foliot Furniture**) — an industrial maintenance and
manufacturing execution platform built to replace an external monitoring vendor. Multi-plant, multi-user,
multi-language (EN / FR / ES).

**Primary use case today:** CMMS (Computerized Maintenance Management System) for a furniture
manufacturing plant, now extended with shop-floor MES operator flows, PM/TPM, inventory, suppliers,
factory map, robot-cell telemetry, and an AI intelligence assistant. IoT sensor data from physical
sensors feeds in via MQTT. The roadmap extends this into a full MES with OEE, predictive maintenance,
and SAP integration.

**Company context:** Foliot Furniture. Three plants, official codes **QS** (Saint-Jérôme,
America/Toronto, CAD), **QM** (Mirabel, America/Toronto, CAD) and **NL** (Las Vegas,
America/Los_Angeles, USD). QS+QM form the shared Quebec group (`plants.group_code='QC'` — one
maintenance team, one inventory/supplier pool, one shared calendar/escalation config). NL is fully
segregated. **This is now a single multi-plant app with real backend segregation — NOT separate
instances (the old note here is superseded).** See **Section 15** for the full model.

---

## 2. Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript, Tailwind CSS (dark), Zustand, Axios, Recharts, echarts-for-react, react-i18next, react-router-dom v6, lucide-react |
| Backend | FastAPI (Python 3.12), SQLAlchemy async (asyncpg), Pydantic v2 |
| Database | TimescaleDB (PostgreSQL 16 extension, `timescale/timescaledb:latest-pg16`) — hypertable on `sensor_readings` |
| Cache / Queue | Redis |
| IoT Broker | Mosquitto MQTT |
| Proxy | nginx:alpine (inline config via heredoc — no file mounts, Z: network drive) |
| Container | Docker Compose, all services in one stack |
| Auth | JWT (Bearer), FastAPI OAuth2, bcrypt 4.1.3 direct (no passlib); permission enforcement (`resource_guard` backend, `RequireView`/`can()` frontend) |
| AI | Anthropic SDK (`claude-opus-4-8`) — Intelligence tool-use agent + insights/risk cron |
| Backups | `prodrigestivill/postgres-backup-local` (`mes_backup` service) |

---

## 3. Repository Layout

```
manutencao-mes/
├── backend/
│   └── app/
│       ├── api/routes/              # One file per domain (~30 routers — see Section 6 for full list)
│       │   ├── auth.py              # POST /api/auth/login → {access_token, user_id, name, language}
│       │   ├── work_orders.py       # /api/wo/  (list, dashboard, CRUD, start, complete, sub-resources)
│       │   ├── technicians.py       # /api/technicians/
│       │   ├── equipment.py         # /api/equipment/   (+ machine auto-sync)
│       │   ├── machines.py          # /api/machines/    (production-floor machines, MES panel)
│       │   ├── machine_operator.py  # /api/machine-operator/  (kiosk: call/start/complete, stops, rejects)
│       │   ├── maintenance_plans.py # /api/plans/
│       │   ├── pm_template_settings.py  # /api/pm-templates/ (reusable SOP templates)
│       │   ├── inventory.py         # /api/inventory/   (full: catalog + movements + low-stock)
│       │   ├── suppliers.py         # /api/suppliers/ + /api/supplier-orders/ (POs)
│       │   ├── parts_approval.py    # /api/.../parts-approval (supervisor approval flow)
│       │   ├── kpis.py              # /api/kpis/
│       │   ├── reports.py           # /api/reports/
│       │   ├── alerts.py            # /api/alerts/ + /api/alerts/machines
│       │   ├── tickets.py           # /api/tickets/
│       │   ├── maintenance_dashboard.py  # /api/maintenance/dashboard
│       │   ├── escalation.py        # /api/escalation/ (settings + contacts)
│       │   ├── stop_categories.py   # /api/stop-categories/
│       │   ├── intervention_type_settings.py  # intervention types per machine
│       │   ├── safety_checklist_settings.py   # safety checklists per machine
│       │   ├── job_orders.py        # /api/job-orders/ (OF)
│       │   ├── factory_map.py       # /api/factory-map/ (zones, props, asset positions)
│       │   ├── robot_cells.py       # /api/robot-cells/ (FANUC CRX telemetry, read-only)
│       │   ├── intelligence.py      # /api/intelligence/ (Mirai tool-use AI agent)
│       │   ├── uploads.py           # /api/uploads → /api/media (photo/video/links)
│       │   ├── iot.py               # /api/iot/
│       │   ├── users.py             # /api/users/ (+ invitations, password reset, permissions)
│       │   └── plants.py            # /api/plants/
│       ├── core/
│       │   ├── config.py            # Settings from .env
│       │   ├── security.py          # JWT encode/decode, bcrypt, get_current_user
│       │   └── permissions.py       # resource_guard / role + allow-list enforcement
│       ├── db/
│       │   ├── base.py              # Base = declarative_base()
│       │   └── session.py           # async engine + get_db dependency
│       ├── models/models.py         # All ORM models — ~70 tables (see Section 5)
│       ├── schemas/                 # work_order, wo_subresources, technician, equipment, user,
│       │                            #   maintenance, pm, robot_cell, intelligence
│       ├── services/                # ~17 services — see below
│       │   ├── alert_service.py / ticket_service.py / escalation_service.py / notification_service.py
│       │   ├── email_service.py            # real email (invites, reset)
│       │   ├── equipment_machine_sync.py   # ensure_machine_for_equipment (auto-sync)
│       │   ├── mes_service.py / machine_history_service.py / intervention_sync.py
│       │   ├── inventory_service.py / numbering.py
│       │   ├── pm_service.py               # PM template → occurrences, PM cron logic
│       │   ├── robot_cell_ingest.py        # cobot telemetry ingestion
│       │   └── intelligence_ai.py / intelligence_calculator.py / intelligence_chat.py
│       ├── workers/
│       │   └── iot_consumer.py      # MQTT → TimescaleDB ingestor (mes_iot_worker service)
│       └── main.py                  # FastAPI app, CORS, router registration; 3 crons in lifespan
│                                    #   (_escalation_loop, _pm_loop, _intelligence_cron)
├── frontend/
│   └── src/
│       ├── api/
│       │   ├── axios.ts             # baseURL:'', Bearer interceptor, auto-logout on 401
│       │   ├── auth.ts              # POST /api/auth/login (JSON body)
│       │   ├── workOrders.ts        # All WO + inventory + equipment API calls
│       │   └── maintenance.ts       # All maintenance module API calls (alerts, tickets, dashboard)
│       ├── pages/                   # ~25 page groups — key ones:
│       │   ├── Login.tsx / ForgotPassword.tsx / ResetPassword.tsx / AcceptInvite.tsx
│       │   ├── Dashboard.tsx        # KPI cards + recent WOs (Promise.allSettled)
│       │   ├── WorkOrders/          # List (AG Grid) / Detail / NewWorkOrder
│       │   ├── Alerts/              # AlertList / NewAlert (QR ?machineId=) / AlertDetail
│       │   ├── Tickets/             # TicketList / NewTicket / TicketDetail
│       │   ├── MaintenanceDashboard/ + Supervisor/  # KPI dashboards
│       │   ├── Equipment/           # List / Detail (Config tab: stop cats, intervention types, ops) / NewEquipment
│       │   ├── Machines/ + MachineView/  # MES machine page + operator kiosk (/machine/:id)
│       │   ├── MaintenancePlans/ + PMCalendar/   # recurring plans + PM templates + calendar
│       │   ├── Inventory/ + Suppliers/ + PurchaseOrders/   # stock, vendors, POs
│       │   ├── Schedule/            # LaborScheduler (@dnd-kit)
│       │   ├── FactoryMap/          # React Flow editable asset map, live status
│       │   ├── Intelligence/        # Mirai AI chat + insights dashboard
│       │   ├── KPIs/                # KPIDashboard + MachineReport
│       │   ├── MyWork/              # per-technician work queue
│       │   └── Settings/            # users, escalation, profile, change-password, intervention types
│       ├── components/
│       │   ├── ui/                  # Badge, Spinner, etc.
│       │   ├── charts/              # WOBarChart, WODonutChart (Recharts) + ECharts usage
│       │   └── layout/              # Sidebar (Core/Maintenance/Inventory/Analytics/Settings groups), Layout
│       ├── pages/ProtectedRoute.tsx + RequireView.tsx   # auth + permission gating
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

> **Run all of this from `C:\KAIZO`** (the repo's new home — see header note). `docker-compose.yml`
> pins `name: manutencao-mes`, so containers stay `mes_*` and volumes stay `manutencao-mes_*`
> regardless of the folder name. The old `Z:\manutencao-mes\manutencao-mes` copy is stale — ignore it.

```bash
# Start everything (from C:\KAIZO)
docker compose up -d

# Rebuild one service after code changes
docker compose up --build --no-deps -d frontend
docker compose up --build --no-deps -d backend

# IMPORTANT: use `up -d`, NOT `restart` — restart reuses old container config
# (command: overrides in docker-compose.yml are only picked up on `up`)
# After recreating mes_frontend, ALSO restart nginx (stale upstream IP → 502):
docker compose restart nginx

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

### Maintenance Alerts & Tickets tables

| Table | Key fields | Notes |
|---|---|---|
| `machines` | id, name, department, location, is_active | Production floor machines (separate from `equipment` asset catalog) |
| `maintenance_alerts` | id, alert_number(ALT-YYYY-NNNNN), machine_id, problem_type, priority, status, created_by, shift, assigned_to_id, escalation_level, is_overdue | Operator-reported issues; priority: low\|medium\|high\|critical; status: new_alert\|assigned\|in_progress\|resolved\|cancelled |
| `maintenance_tickets` | id, ticket_number(TKT-YYYY-NNNNN), alert_id(nullable), machine_id, priority, status, assigned_to_id, opened_at, started_at, completed_at, diagnosis, corrective_action, parts_used(JSON), estimated_downtime_minutes, total_intervention_minutes | status: open\|in_progress\|on_hold_parts\|on_hold_ext\|completed\|cancelled |
| `notification_logs` | id, alert_id(nullable), ticket_id(nullable), notification_type, recipient_role, message, status | Audit log of all escalation notifications sent |
| `ticket_comments` | id, ticket_id, author, comment, created_at | Freetext comments on tickets |

**SLA thresholds (escalation engine):**
- Critical → 10 min; High → 30 min; Medium → 2 h; Low → 8 h
- L1 escalation: Shift Supervisor; L2: Maintenance Director; L3: Plant Manager
- Background task runs every 60s (`asyncio.create_task` in FastAPI lifespan)

**Note on naming:** `machines` = production floor assets for alerts/tickets. `equipment` = asset catalog linked to work orders and maintenance plans. They are separate models by design.

### Tables added since 06-06 (now live — ~70 tables total)

> The original schema above is the CMMS core. The model has since grown substantially.
> Authoritative list lives in `backend/app/models/models.py` (~1750 lines). Grouped summary:

**Identity & access**
- `permissions` — per-user allow-list overrides (resource + action)
- `user_invitations` — email invite flow (AcceptInvite page)
- `password_reset_tokens` — forgot/reset + forced first-login change

**PM / TPM**
- `pm_templates`, `pm_template_tasks`, `pm_task_media` — reusable SOPs with photo/video/link steps
- `plan_occurrences` — generated recurring PM events (status + compliance)
- `plan_recommended_parts` — parts suggested per plan

**Machines / MES floor**
- `machines` (expanded: status, MES panel), `machine_operators`, `machine_production_logs`
- `stop_categories`, `stop_subcategories`, `machine_stops` — stop justification taxonomy
- `reject_categories`, `reject_subcategories`, `reject_logs` — scrap/reject tracking
- `machine_history` — per-machine event log
- `job_orders` — production OF / job orders

**Intervention workflow**
- `intervention_types`, `machine_interventions`
- `safety_checklists`, `safety_checklist_items`, `intervention_checklist_responses`
- `intervention_parts` — parts consumed during an intervention

**Inventory & purchasing**
- `inventory_movements` — stock in/out (quantity derived from movements; deduction on intervention)
- `suppliers`, `purchase_orders`, `purchase_order_items`
- `cost_audit_log` — audit trail for cost changes

**Escalation / notifications**
- `escalation_settings`, `escalation_contacts` — configurable SLA + recipients (replaces hard-coded thresholds)

**Factory map / digital twin**
- `factory_zones`, `map_props` — editable 2D map; asset positions stored on `equipment` (pos_*)

**Robot cells (FANUC CRX telemetry, read-only)**
- `robot_cells`, `robot_cell_states`, `robot_cell_samples`, `robot_cell_alarms`

**Intelligence (AI)**
- `ai_insights`, `ai_recommendations`, `machine_risk_scores`, `spare_parts_risk`

**WO additions**
- `work_order_technicians` — many-to-many techs per WO (alongside `executor_id` + `labor_records`)

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

### Maintenance Alerts — /api/alerts/
```
GET    /api/alerts/machines          → { total, items: MachineOut[] }
GET    /api/alerts/                  → { total, items: AlertOut[] }   (filter: machine_id, priority, status, overdue_only)
GET    /api/alerts/{id}              → AlertOut
POST   /api/alerts/                  → AlertOut (201)  body: AlertCreate
PATCH  /api/alerts/{id}/assign       → AlertOut  body: { assigned_to_id }
PATCH  /api/alerts/{id}/convert      → AlertOut  (creates MaintenanceTicket, sets status=in_progress)
```

AlertOut enriched fields (not DB columns, computed at query time):
- `machine_name` — joined from `machines` table
- `assigned_to_name` — joined from `users` table
- `ticket_id` — subquery on `maintenance_tickets.alert_id`

### Maintenance Tickets — /api/tickets/
```
GET    /api/tickets/                 → { total, items: TicketOut[] }   (filter: status, machine_id, assigned_to_id)
GET    /api/tickets/{id}             → TicketOut (includes comments)
POST   /api/tickets/                 → TicketOut (201)
PATCH  /api/tickets/{id}/status      → TicketOut  body: TicketUpdate (status, diagnosis, parts_used, etc.)
PATCH  /api/tickets/{id}/close       → TicketOut  body: TicketClose (diagnosis, corrective_action, total_intervention_minutes required)
POST   /api/tickets/{id}/comments    → CommentOut (201)  body: { author, comment }
```

**Async lazy-load gotcha:** `TicketOut` has a `comments` field. Route's `_enrich()` must build a dict
from `sa_inspect(type(ticket)).mapper.column_attrs` (column values only) before calling
`TicketOut.model_validate(d)` — otherwise Pydantic with `from_attributes=True` triggers a lazy
relationship load and raises `MissingGreenlet`.

### Maintenance Dashboard — /api/maintenance/
```
GET    /api/maintenance/dashboard    → { open_alerts, open_tickets, critical_tickets, overdue_alerts,
                                         avg_resolution_hours, by_machine[], by_problem_type[],
                                         by_technician[], by_escalation[], by_ticket_status[] }
```

### Full router registration (main.py, 2026-06-20)

All registered under `/api`. Guarded routers use `resource_guard(<resource>)`:

```
/api/auth            /api/plants            /api/equipment*        /api/wo*
/api/plans           /api/inventory         /api/alerts            /api/tickets
/api/maintenance     /api/iot               /api/users             /api/kpis
/api/reports         /api/escalation        /api/technicians*      /api/machines
/api/factory-map     /api/robot-cells       /api/stop-categories   /api/job-orders
/api/suppliers       /api/supplier-orders   /api/machine-operator  /api/intervention-types
/api/safety-checklist  /api/wo-approval     /api/pm-templates      /api/intelligence
/api/uploads (→ /api/media)
```
*= permission-guarded: `equipment`, `work_orders`, `technicians`.

Notable: `/api/inventory` and `/api/iot` are **no longer stubs** — inventory is a full
catalog + movements module; KPIs has `/summary`, `/backlog`, `/mttr`, `/cost` (+ machine reports).

```
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
  ✅ KPI backend endpoints (MTTR, backlog, PM compliance, cost by type) — /api/kpis/*
  ✅ Maintenance plans API expanded (GET list with equipment name, POST create) — /api/plans/
  ✅ Frontend: Equipment list + detail page (/equipment, /equipment/:id) — tabs: overview/WOs/plans
  ✅ Frontend: KPI Dashboard with ECharts (/kpis) — 4 KPI cards + 3 charts
  ✅ Frontend: PM Calendar with FullCalendar (/pm-calendar) — plans + preventive WOs as events
  ✅ Frontend: Labor Scheduler with @dnd-kit (/schedule) — drag WOs to technician columns
  ✅ Frontend: Work Orders upgraded to AG Grid (/work-orders) — sortable, filterable, paginated
  ✅ Sidebar reorganized into 4 groups (Core / Maintenance / Planning / Analytics)
  ✅ executor_id added to WorkOrderUpdate schema (used by labor scheduler)
  ✅ Maintenance Alerts module — /alerts + /alerts/new (operator form, QR-ready)
  ✅ Maintenance Tickets module — /tickets + /tickets/:id (3-tab detail: Details/Comments/Parts)
  ✅ Maintenance Dashboard — /maintenance/dashboard (5 KPI cards + 5 ECharts)
  ✅ SLA escalation engine — 60s background task, Critical=10min, High=30min, Medium=2h, Low=8h
  ✅ New DB tables: machines, maintenance_alerts, maintenance_tickets, notification_logs, ticket_comments
  ✅ New roles: operator, maintenance_director
  ✅ i18n: alertStatus, ticketStatus, problemType, alerts, tickets, maintenanceDash keys in en/fr/es
  ✅ Inventory management UI (catalog + movements + low-stock + parts approval)
  ✅ Machine stop tracking (machine_stops + stop categories/subcategories)

Phase 2 — Full Maintenance + IoT (LARGELY DELIVERED 06-07 → 06-20)
  ✅ machine_stops table + stop registration flow (operator kiosk)
  ✅ Stock movements + low-stock alerts + inventory deduction on intervention
  ✅ Frontend: Inventory + Suppliers + Purchase Orders modules
  ✅ Equipment create/edit form (+ Config tab with stop cats / intervention types / operators)
  ✅ PM/TPM module (templates, recurring plans, occurrences, calendar, dashboard)
  ✅ Machine/MES operator page (call/start/complete, stop justification, rejects, production logs)
  ✅ Intervention workflow (types, safety checklist, parts, supervisor approval, voice note)
  ✅ Factory map / digital-twin base (React Flow, live status)
  ✅ Robot-cell telemetry (FANUC CRX, read-only) + simulator
  ✅ Intelligence (Mirai) AI assistant + insights/risk cron
  ✅ Permissions enforcement (resource_guard + RequireView) + user invites/password reset
  ⬜ Auto-corrective WO from IoT alert (machine_stops links exist; auto-create not wired)
  ⬜ MTBF / Availability KPI endpoints (machine_stops now exists — compute pending)

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
| `machines` vs `equipment` as separate models | `equipment` = asset catalog for WOs/plans/IoT. `machines` = simpler lookup for alert/ticket creation. Operator on floor selects a machine; technician manages a work order against equipment. |
| `SAEnum(native_enum=False)` on all new enums | Stores as VARCHAR — adding new enum values never requires a DB migration |
| `_ticket_to_dict()` in tickets route | Pydantic `from_attributes=True` eagerly accesses SQLAlchemy relationships; extracting column attrs via `sa_inspect` before `model_validate()` prevents `MissingGreenlet` on async sessions |
| Escalation loop as `asyncio.create_task` in lifespan | No Celery/Beat dependency; single-process, cancels cleanly on shutdown |
| `notification_logs` table for mock notifications | Tracks all escalation events even before real email/SMS is wired; UI can display notification history |

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
| `docker-compose.yml` deprecated `version:` key | `docker-compose.yml` | ✅ Done — replaced with `name: manutencao-mes` (pins Compose project so volumes are reused after the move to `C:\KAIZO`). |
| `process is not defined` breaks any `react-grid-layout`/`react-draggable` drag & resize under Vite | `frontend/index.html` | ✅ Fixed — `<script>window.process = window.process \|\| { env: {} };</script>` in `<head>`. RGL's debug `log()` reads `process.env.*`, which throws in the browser (Vite has no `process`) and silently aborts every drag/resize. Keep this shim. NOTE: synthetic `dispatchEvent` mouse events do NOT reliably drive react-draggable — verify drag with real input or by calling the element's `onMouseDown` prop directly. |

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

### Session 2026-06-06 — Maintenance Alerts & Tickets Module

**Completed:**
- New DB tables: `machines`, `maintenance_alerts`, `maintenance_tickets`, `notification_logs`, `ticket_comments`
- New enums: `AlertPriority`, `AlertStatus`, `AlertProblemType`, `AlertShift`, `TicketStatus`; all with `SAEnum(native_enum=False)`
- New roles added to `UserRole`: `operator`, `maintenance_director`
- New schema file: `backend/app/schemas/maintenance.py` — MachineOut, AlertCreate/Out/Update, TicketCreate/Out/Update/Close, CommentCreate/Out
- New service: `alert_service.py` — AlertService (create, assign, convert_to_ticket)
- New service: `ticket_service.py` — TicketService (create, close, add_comment, number generator TKT-YYYY-NNNNN)
- New service: `escalation_service.py` — EscalationService.check_overdue_alerts() — marks is_overdue, increments escalation_level, calls NotificationService
- New service: `notification_service.py` — mock email/SMS/Teams, logs to notification_logs table
- Replaced stub `alerts.py` with full implementation including `/api/alerts/machines` sub-route
- New route: `tickets.py` — full CRUD + close + comments
- New route: `maintenance_dashboard.py` — aggregated KPI response
- `main.py` updated: escalation `asyncio.create_task` in lifespan, 3 new routers registered
- `seed.py` updated: seeds 5 machines + 3 alerts (ALT-2026-00001/00002/00003) + 2 tickets (TKT-2026-00001/00002)
- Bug fixed: `MissingGreenlet` on `GET /api/tickets/` — `_ticket_to_dict()` extracts column attrs via `sa_inspect` before `TicketOut.model_validate()`
- New frontend API file: `api/maintenance.ts`
- New pages: `Alerts/AlertList.tsx`, `Alerts/NewAlert.tsx`, `Tickets/TicketList.tsx`, `Tickets/TicketDetail.tsx`, `MaintenanceDashboard/MaintenanceDashboard.tsx`
- `App.tsx`: 5 new routes — `/alerts`, `/alerts/new`, `/tickets`, `/tickets/:id`, `/maintenance/dashboard`
- `Sidebar.tsx`: new "Maintenance" nav group (Bell/Ticket/Activity icons); v0.3.0
- `types/index.ts`: Machine, MaintenanceAlert, MaintenanceTicket, TicketComment, MaintenanceDashboardData interfaces
- i18n: `alertStatus`, `ticketStatus`, `problemType`, `alerts`, `tickets`, `maintenanceDash` sections in en/fr/es
- Commit: `f7f7117`

### Session 2026-06-06 — Full Maintenance Module UI

**Completed:**
- New npm packages: `@dnd-kit/core|sortable|utilities`, `@fullcalendar/react|daygrid|timegrid|interaction|core`, `ag-grid-community`, `ag-grid-react`, `echarts`, `echarts-for-react`
- Backend: Expanded `kpis.py` — `GET /api/kpis/summary`, `/backlog`, `/mttr`, `/cost` (all query-param driven, real SQL)
- Backend: Expanded `maintenance_plans.py` — `GET /api/plans/` with equipment_name join, `POST /api/plans/`
- Backend: Added `executor_id: Optional[UUID]` to `WorkOrderUpdate` schema
- Frontend `types/index.ts`: Added `MaintenancePlan`, `KPISummary`, `BacklogData`, `MTTRItem`, `CostItem`
- Frontend `api/workOrders.ts`: Added `fetchEquipmentById`, `fetchMaintenancePlans`, `createMaintenancePlan`, `fetchKPISummary`, `fetchBacklog`, `fetchMTTR`, `fetchCostByType`, `updateWorkOrder`
- New page: `pages/KPIs/KPIDashboard.tsx` — ECharts charts (backlog bar, MTTR bar, PM compliance gauge, cost donut)
- New page: `pages/Equipment/EquipmentList.tsx` — equipment card grid with status/criticality
- New page: `pages/Equipment/EquipmentDetail.tsx` — tabs: Overview specs | WO history table | PM plans list
- New page: `pages/PMCalendar/PMCalendar.tsx` — FullCalendar month/week view, plans + preventive WOs as events
- New page: `pages/Schedule/LaborScheduler.tsx` — @dnd-kit drag-and-drop board, unassigned column + per-technician columns, PATCH executor_id on drop
- Upgraded: `pages/WorkOrders/WorkOrderList.tsx` — AG Grid community with custom cell renderers, sorting, filtering, pagination
- Updated: `App.tsx` — 5 new routes (`/kpis`, `/equipment`, `/equipment/:id`, `/pm-calendar`, `/schedule`)
- Updated: `Sidebar.tsx` — 3 nav groups (Core / Planning / Analytics), all new links active
- Updated: `en.json`, `fr.json`, `es.json` — new keys for `equipment.*`, `kpis.*`, `schedule.*`, `pmCalendar.*`, `nav.kpis|schedule|pmCalendar`

### Sessions 2026-06-07 → 2026-06-20 — Major expansion (condensed from git history)

Brand changed to **Kaizo** (logo `mirai-icon.png`; Intelligence module keeps "Mirai" name).
Roughly tripled the codebase. Key feature commits, newest first:

- **TPM / PM module** (`1105b13`): PM templates with media steps, recurring plans → `plan_occurrences`, PM calendar, PM dashboard; `pm_service` + `_pm_loop` cron.
- **Intervention workflow** (`40d0bc1`, `cfe41ec`, `f102bd3`, `a34780b`): safety checklist on start, parts consumed during intervention, supervisor approval, inventory deduction, intervention types per machine, voice transcription on closing note, intervention timings + history tab + KPIs.
- **Parts visibility & search** (`c1bc42f`, `470ad3e`): parts used shown on ticket + WO detail; parts search by code + description + stock.
- **QA audit pass** (`4edadd9`, `1bbdbf2`): fixed broken connections, UUID displays, data-sync issues, P0–P4 bugs.
- **Machine / MES operator** (`1aef7a9`, `16ca484`, `f8749c4`, `89859c0`, `192a0ab`): operator kiosk page, MES panel, stop/reject categories per machine, OF, machine history, simplified ticket↔WO flow with auto inventory deduction. Note: Equipment has **no** `department` field (`1f1a9f5`).
- **Alert ↔ ticket sync** (`31c0c90`, `3f20657`, `aadefe3`, `67e24da`, `dce34a2`): auto-create alert when ticket created, backfill missing alerts, force `plant_id`, 30s auto-refresh + live sidebar badges, Zustand persist for session-across-refresh.
- **Suppliers & POs** (`8e541c8`): supplier management + purchase orders module.
- **Inventory** (`aa0f808`, `49d3fd5`): full inventory table (fixed field-mapping render bugs); imported from `Inventory.xml`.
- **Users & permissions** (`e849186`, `594cc33`): complete user + permissions management, admin password reset + forced first-login change.
- **Labor & costs** (`f7d4acc`, `ee4a747`, `c70703e`): labor cost from technician hourly rate, labor record creation + time calc, resume-after-hold fix.
- **Equipment config** (`3f4cf9a`, `251b1a7`): Equipment Configuration tab always accessible; Stop Categories + Intervention Types moved into it (removed from sidebar).
- **Not yet committed to git** (working tree, per CONTEXT 06-20): Factory Map, Robot Cells (FANUC CRX) telemetry, Intelligence (Mirai) AI assistant + `ai_insights`/`ai_recommendations`/`machine_risk_scores`/`spare_parts_risk` tables, `_intelligence_cron`. Verify with `git status` before assuming committed.

> This entry is reconstructed from commit messages + current code, not a live session log.
> When in doubt, the code in `backend/app/models/models.py` and `frontend/src/App.tsx` is authoritative.

### Session 2026-06-21 — WO Approval, ticket fix, cobot cells, OEE card, brand font

**Completed:**
- **Brand wordmark** — KAIZO switched from Saira SemiCondensed to **Oxanium** (`font-brand` token in `tailwind.config.js` + Google Fonts import); the "A" is a gradient peaked SVG glyph (Sidebar + Login).
- **Parts Approval → WO Approval** — supervisor/director now approves the whole completed work order (work done + parts), across **both** sources: floor `MachineIntervention` and office `work_orders`.
  - Approval columns (`approval_status`/`approved_by_id`/`approved_at`/`approval_note`/`rejection_reason`) added to **both** `machine_interventions` and `work_orders` (migration in `main.py _run_migrations`).
  - Completion sets `approval_status='pending'` (intervention complete; `work_orders` complete + PATCH→completed paths).
  - Queue = completed+pending interventions ∪ work_orders, **de-duplicated** by `ticket_id` (machine-linked WO spawns an intervention twin → shown once). Intervention approve consumes pending parts' stock; WO approve is a pure sign-off (`wo_parts` already deducted on add).
  - **One-time grandfather** guarded by new marker table `_kaizo_migrations` (key `grandfather_approval_2026_06_21`) — marked all already-completed interventions + ~7944 imported WOs as `approved` so the queue isn't flooded; the marker prevents re-approving genuinely-pending items on reboot.
  - Backend `api/routes/wo_approval.py` (replaced `parts_approval.py`); frontend `pages/Supervisor/WOApproval.tsx` at `/maintenance/wo-approval` (legacy `/parts-approval` still routes there); nav `nav.woApproval` + `woApproval.*` i18n (en/fr/es).
- **Ticket creation bug fixed** — `ticket_service.create_ticket` received an *equipment* id, missed the auto-synced Machine (own PK + `equipment_id` link) and tried to insert a Machine with a duplicate `code` (`machines_code_key` violation → "Error creating ticket"). Now resolves the existing Machine by `equipment_id`/`code` before creating and repoints `data.machine_id`.
- **Robot cells** — the **16 cobots already placed on the factory map** registered as `robot_cells` via `POST /api/robot-cells/`, each with a per-cell `ingest_token` (deliverable for the integrator). No telemetry injected; end-to-end verified then cleaned (16 cells, 0 states/samples). Real IP/model/line + 2 unplaced cobots pending.
- **Factory-map machine card** — replaced Open WOs/MTTR/PM/Cost with **OEE / Availability / Parts-per-hour / Quality / Status / Operator** (3D `KpiBillboard` + 2D panel). `/api/kpis/summary?machine_id=` gained `parts_per_hour`, `quality_pct`, `oee_pct`, `current_status`, `operator` (OEE = Avail×Perf×Qual from `machine_production_logs`; reads 0 until the plant feeds production, then lights up automatically).

### Session 2026-06-21 (cont.) — Unified kiosk + draggable layout, the `process` Vite bug, project moved to C:\KAIZO

**Unified operator kiosk.** Merged the two operator pages into one: `/machines/:slug` (`MachinePage`) is
now the single kiosk; the mechanic flow from `MachineOperatorPage` is exported as
`MaintenancePanel({ machineId, embedded })` and embedded. `/machine/:id` redirects to `/machines/:id`
(backend resolves a machine by id **or** slug). "Call maintenance" became a stop-justification reason.

**Per-machine layout editor.** Supervisor+ ("Éditer la disposition") can drag/resize the 8 kiosk panels
(status, job, stop, timeline, production, gauge, rejects, maintenance) via **react-grid-layout**
(`RGL = WidthProvider(GridLayout)`, 12 cols, `compactType="vertical"`, `isBounded`, full-width
`.kiosk-drag` bar handle, enlarged se/e/s resize handles). Saved per machine in **`machines.kiosk_layout`**
(JSON column; migration in `main.py`; `MachinePageData.kiosk_layout` + `MachinePatch.kiosk_layout`;
persisted via `PATCH /api/machines/{id}`). No saved layout → `DEFAULT_KIOSK_LAYOUT`.

**THE bug that made drag/resize do nothing (now fixed):** `ReferenceError: process is not defined`.
react-grid-layout/react-draggable's internal `log()` reads `process.env.*`; under Vite `process` is
undefined, so `handleDragStart` threw at the start of every drag/resize and silently aborted — drag AND
resize dead, everything else rendering fine, no obvious console error during normal use. **Fix:**
`<script>window.process = window.process || { env: {} };</script>` in `frontend/index.html <head>`.
Verified live (real kiosk panel dragged; nginx serves the shim). Diagnosed with the preview-browser MCP
running a local Vite against the Docker backend. (See Section 13.)

**Smaller kiosk fixes:** reject modal now says **CONFIRMER LE REJET** (was "…L'ARRÊT") with a working
Retour and a `t.quantity` label; a machine in intervention shows **maintenance** instead of "EN MARCHE"
(`call_maintenance` sets `current_status=maintenance`, `complete_intervention` resets to `running`, and
`_machine_to_page_data` forces effective status to maintenance whenever an open ticket exists — covers
office-created tickets too).

**Project moved Z: → C:\KAIZO.** The network drive `Z:` hit a per-folder quota (writes failed `ENOSPC`
despite TBs of raw free space; trigger was a partial local `node_modules` I created, since removed).
Copied the repo to **`C:\KAIZO`** (no `node_modules`; added `frontend/.dockerignore`). Pinned
**`name: manutencao-mes`** in `docker-compose.yml` (removed obsolete `version:`) so the same containers
and data volumes are reused — verified all 8 `mes_*` containers + volumes intact. **Build/run from
`C:\KAIZO` from now on.**

### Session 2026-06-21 (cont.) — Shift-aware stop timeline with type colors

Rebuilt the kiosk's **CHRONOLOGIE** panel (`StopTimeline` in `MachinePage.tsx`) to match the old vendor's
shift view:
- **Colors are by stop `type`** (so they're always consistent): running=green `#22c55e`, planned=blue
  `#3b82f6`, unplanned=red `#ef4444`, maintenance=yellow `#eab308`. A stop with **no category yet**
  (MES-detected, not justified) = **pink `#ec4899`**. Helper `stopColor()` + `STOP_TYPE_COLORS`.
  Backend migration (`main.py`) also forces the **global** stop categories' stored `color` to match by
  type, so the config page + stop modal agree (per-machine custom categories keep their color).
- **Axis = ONE shift window** (start→end) from the machine's `shifts_config` (Configuration → Work
  Shifts). It follows the clock (live "now" marker, green fill over elapsed time) and auto-switches when
  a shift boundary passes. `buildShiftWindows()` builds yesterday→tomorrow windows; overnight shifts roll
  past midnight; falls back to a full-day 00:00–24:00 "Journée" window when `shifts_config` is empty.
  Header shows shift name + date + range; hourly ticks (3-h step when span > 12 h).
- **Navigation ◀ ▶ is supervisor-only** (`useRole`); operators see only the current shift live and can't
  go back. Can step to past shifts/days; "next" is disabled at the current shift (no future).
- Plumbing: `MachinePageData` now returns `shifts_config`; `GET /api/machines/{ref}/stops/today` accepts
  optional `start`/`end` ISO params (overlap query) for the navigation fetch; `fetchTodayStops(ref, range?)`.
- Verified end-to-end in a headless browser (local Vite → Docker backend): injected one stop of each type
  + one with no category → bar showed green/blue/red/yellow/**pink** correctly, now-marker, ticks,
  shift header, and ◀ ▶ stepping days; test data cleaned up after.

### Session 2026-06-21 (cont.) — Unified status palette everywhere

The status palette now has **one source of truth**: `frontend/src/utils/statusColors.ts`
(`STATUS_HEX` + `statusColor()` + `STATUS_LABEL`). Same colors wherever color reflects machine status:
- **3D map** (`Factory3D.tsx`) floor mats / blocks / beacons / KPI card, and **2D map**
  (`FactoryMap.tsx`) nodes + legend + minimap — both now `import { STATUS_HEX as STATUS_COLORS }`
  (were local maps with maintenance/planned both amber). Legend no longer hides `planned_stop`.
- **Kiosk** (`MachinePage.tsx`): status pill + dot rewritten to the palette, and a **colored frame
  around the whole page** (`fixed inset-0`, `box-shadow: inset 0 0 0 7px <statusColor>`, z-55,
  pointer-events-none) that follows `current_status`. Accent (gauge, buttons) also follows status.
- Palette: running=green `#22c55e`, planned_stop=blue `#3b82f6`, stopped=red `#ef4444`,
  maintenance=yellow `#eab308`, **unjustified=pink `#ec4899`**, idle=gray `#6b7280`.
- **Backend now sets `current_status` by stop type** (`machines.py` create-stop): maintenance→
  `maintenance`, planned→`planned_stop`, unplanned→`stopped`, **no category → `unjustified`** (pink).
  New `MachineStatus.unjustified` enum value (VARCHAR col, no DB migration). The "unjustified" state is
  the hook for the future MES auto-stop feed (operator then justifies → status flips to the chosen type).
- Verified in-browser: kiosk frame+pill+accent green when running, and **pink** when status set to
  `unjustified` (pill "NON JUSTIFIÉ"). Machine restored to running after.

### Session 2026-06-22 — Clickable timeline: reclassify a stop's cause

The kiosk timeline bar is now **thicker** (`h-14`, ~56px; default `timeline` panel height bumped to 6) and
its **stop segments are clickable** to change the stop's cause:
- Click a segment → "Changer la cause" modal (reuses the stop categories → subcategories grid). Picking a
  cause calls `PATCH /api/machines/{ref}/stops/{stop_id}/reclassify` (`reclassifyStop()` in `api/machines.ts`).
- **Anti-cheat:** a stop is NEVER turned back into running — there's no "running" option, only causes. The
  reclassify endpoint only updates `stop_category_id`/`stop_subcategory_id`; if the stop is still **open** it
  re-derives `current_status` from the new type (planned→blue, unplanned→red, maintenance→yellow, none→pink),
  but it does **NOT** create a maintenance ticket (relabel only).
- **Scope (by visibility, not a role check):** operator reclassifies only current-shift stops (all they can
  see); supervisor+ reaches past shifts via the ◀ ▶ nav, so they can reclassify those too. `onSegmentClick`
  is disabled while the layout editor is on (so dragging a panel doesn't fire a click).
- i18n keys `changeCause` / `noSubcategory` (en/fr/es).
- **Gotcha re-confirmed:** the local Vite preview went blank after many HMR cycles (stale optimized-deps,
  surfaced as a `<StopTimeline>` runtime throw) — NOT a code bug. The freshly-built **Docker** frontend
  rendered fine; verified the full click→reclassify→persist round-trip on `http://localhost` (port 80).
  When the preview blanks mid-session, rebuild/restart Vite or test against Docker rather than chasing it.

### Session 2026-06-22 — Maintenance wait time + purple intervention + MTTA

The maintenance lifecycle now has two distinct colors and tracks the response (wait) time:
- **maintenance = yellow** while the call waits for a technician; **intervention = purple** (`#a855f7`,
  new `MachineStatus.intervention`) once the technician starts. `start_intervention` sets the machine to
  `intervention`; `complete_intervention` resets `maintenance`|`intervention` → `running`. Purple
  propagates everywhere via `statusColors.ts` (kiosk frame/pill, 3D mats, 2D nodes).
- **Timeline splits a maintenance stop** into the yellow wait (call→start) and the purple intervention
  (start→end). The stops endpoint (`/stops/today`) now joins the intervention by `ticket_id` and returns
  `intervention_started_at` / `intervention_completed_at` / `wait_minutes` on each `MachineStopOut`; the
  kiosk renders two sub-segments when a maintenance stop has a started intervention.
- **Response/wait time** was already stored (`machine_interventions.response_time_minutes`, set at start).
  Surfaced as **MTTA** in `/api/kpis/summary` (`mtta_minutes` = avg call→start) + a "Response time" card on
  the KPI dashboard.
- Verified the full flow end-to-end via the API on a throwaway machine (call→maintenance/yellow →
  start→intervention/purple with `intervention_started_at`+`wait_minutes` populated → complete→running),
  then deleted the test stop/ticket/intervention and confirmed the machine was restored.

### Session 2026-06-22 — Rejects feed Quality/OEE + per-shift history; planned-stop sub-reason fix

- **Sub-reason step bug:** `handleCategorySelect` only opened the subcategories step for `unplanned`
  categories, so a **planned** stop (or any category with sub-reasons) skipped straight to confirm. Now
  any category with subcategories shows the sub-reason step first; the chosen sub is saved in
  `machine_stops.stop_subcategory_id` (was always wired — the UI just never let you pick it).
- **Rejects → Quality/OEE storage (where it's recorded):**
  - `reject_logs` = granular per-event history (machine/date/shift/job/category/sub/qty/operator/ts). The
    kiosk +1 → `POST /reject-logs` (`log_reject`) always writes here → detailed reject reports/dashboards.
  - `machine_production_logs` (machine × date × shift) = the OEE rollup the dashboards read; `increment_rejects`
    bumps `reject_count` (creates the row if missing) and now calls `_recompute_oee` to **persist
    performance/quality/oee on that shift row** → per-shift history for trend dashboards (not just the live
    aggregate in `/api/kpis/summary`).
  - quality = (actual − rejects) / actual; OEE = Availability × Performance × Quality. Needs `actual_count`
    (produced pieces) from the future plant production feed — until then a reject is stored but quality stays
    0 (no denominator), then lights up automatically. Verified actual=100/reject=4/target=120/avail=80 →
    perf 83.3, quality 96, OEE 64; test data cleaned up. (No `reject_categories` seeded yet → "uncategorized".)

---

## 15. Multi-Plant Architecture (QS / QM / NL) — 2026-07-10

The platform runs **three plants from one app + one database**, with segregation
enforced in the backend data-access path (not by login redirection or frontend
filtering). Full design + phase-by-phase log: `docs/multi-plant-architecture-assessment.md`.

**Plants & grouping**
- `plants.code` ∈ {`QS` Saint-Jérôme, `QM` Mirabel, `NL` Las Vegas}; `plants.timezone`,
  `plants.currency` (QC=CAD, NL=USD), `plants.group_code` (`QC` for QS+QM; NULL = isolated).
- **Group-scoped** resources pool across a group (QS+QM share them): `stock_items`, `suppliers`.
  Everything else is **plant-scoped** (owned by exactly one plant).

**Access model** — `user_plants(user_id, plant_id, role, is_default)` is the authoritative
source of plant access AND the role held there. `User.role` is only: `admin` = corporate
(all active plants), and the default role template at invite time. No membership → no access.
Login + `GET /api/auth/me/plants` return the memberships; the frontend `plantStore` drives the
header plant selector (shown only when >1 membership; switching reloads so no cached page/list
survives).

**Enforcement (the choke points)**
- `core/plant_context.py` — `PlantContext` dependency. Frontend sends `X-Plant-Id`; the backend
  validates it against memberships (403 `errors.plantNotAuthorized` on a foreign plant; missing
  header → the user's default plant, never "all"). Exposes `plant_id`, `role` (at that plant),
  `allowed_plant_ids`, `group_plant_ids`, `allowed_group_plant_ids`, `is_corporate`.
- `core/plant_scope.py` — the reusable helpers every read path uses (NO hand-written per-route
  plant filters): `plant_scoped(stmt, Model, ctx)`, `plant_condition(Model, ctx)`,
  `ensure_same_plant(obj, ctx)` (**404** on a wrong-plant record — never 403, no existence leak),
  `path_plant_guard(Model, param)` (router-level guard covering every member route by id — used on
  `/api/wo`, `/api/plans`, `/api/settings/pm-templates`), and `require_technician_in_plant` (blocks
  cross-plant assignment/scheduling). Group-scoped models auto-widen to the group.
- New records are stamped at creation from their parent (equipment/machine → plant), in the routes
  AND the services (kiosk, cron, ticket/alert/WO generators) — so nothing depends on the idempotent
  boot-time backfills (which stay as a safety net).
- **RLS (defense-in-depth):** `plant_isolation` policies (ENABLE + FORCE) on ~38 tables, FAIL-OPEN
  when the `app.plant_ids` GUC is unset — so normal app sessions, crons, workers and migrations are
  unaffected (PlantContext is the primary control). The GUC is set ONLY inside Ask Ninja's raw-SQL
  path, which runs under the non-superuser read-only role `kaizo_ninja` (the app's own `mesadmin`
  login is a superuser and bypasses RLS). Group tables read a second GUC `app.plant_ids_grouped`.

**Per-plant configuration** (own row wins, else the shared legacy NULL row that QS+QM edit together):
escalation settings + contacts + shift reports, working calendar + holidays, document numbering
series (ungrouped plants get a `<CODE>-` prefix → `NL-WO-2026-…`), AI insights (cron generates one
per plant; NULL-plant legacy insights visible to grouped plants only). Costs still separate QS/QM by
the cost-center **name** rule (`_site_of`), now locked to the caller's memberships via `_resolve_site`;
the name→`plant_id` repartition refactor is deferred pending business sign-off (WO-derived actuals
where the name and the equipment plant can legitimately disagree).

**Kiosk** — historically token-less shop-floor endpoints. `machines.kiosk_token` +
`POST /api/machines/{ref}/kiosk-token`; `core/kiosk_guard.py` router guard requires the token OR a
bearer user with membership in the machine's plant. **Gated by `KIOSK_ENFORCE_TOKEN` (default
FALSE)** — QC tablets keep working until re-bookmarked to `/machines/:slug?k=<token>`. Live WS
(`/api/live/ws`, `/api/factory-map/ws/{plant}`) filters events by the token-user's plants. Media
(`/api/media`) stays unauthenticated by accepted risk (uuid4 filenames; `<img>` can't send headers).

**Tests** — `backend/tests/test_plant_context.py` (context resolution) +
`backend/tests/test_plant_segregation.py` (8-persona matrix: scoping, guards, notifications,
numbering, calendar, RLS fence, kiosk guard) run in-container, rollback-only. HTTP-level negative
battery: `backend/scripts/plant_security_check.py` (needs the running API + the standing QM-only
persona `test-mira-only@kaizo-test.com`). Backfill/ambiguity report: `scripts/plant_backfill_report.sql`.

**NL go-live is an OPS task, not code** (checklist in the assessment doc §Phase 6): create NL users +
memberships, register NL equipment/machines (born NL via the active context), provision kiosk tokens
+ enable enforcement, add Nevada holidays, configure NL escalation contacts then enable SMS, wire NL
cost centers/SAP when its GL exists.
