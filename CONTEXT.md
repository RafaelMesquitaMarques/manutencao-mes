# Foliot MES — Project Context

> **Purpose of this file:** Single source of truth for AI coding sessions and onboarding.
> Read this before touching any module. Keep it updated as architecture evolves.

---

## 1. What This System Is

**Foliot Furniture MES** — an industrial maintenance and manufacturing execution platform
built to replace an external monitoring vendor. Multi-plant, multi-user, multi-language (EN / FR / ES).

**Primary use case today:** CMMS (Computerized Maintenance Management System) for a furniture
manufacturing plant. IoT sensor data from physical captors already on the shop floor feeds in
via MQTT. The roadmap extends this into a full MES with OEE, predictive maintenance, and SAP
integration.

**Company context:** Foliot Furniture. Plant timezone: America/Toronto.

---

## 2. Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript, Tailwind CSS (dark), Zustand, Axios, Recharts, react-i18next, react-router-dom v6, lucide-react |
| Backend | FastAPI (Python 3.12), SQLAlchemy async (asyncpg), Pydantic v2 |
| Database | TimescaleDB (PostgreSQL 15 extension) — hypertable on `leituras_iot` |
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
│       ├── api/routes/          # One file per domain
│       │   ├── auth.py          # POST /api/auth/login → {access_token, user_id, nome, idioma}
│       │   ├── ordens_servico.py  # /api/wo/  (list, dashboard, CRUD, iniciar, concluir, sub-resources)
│       │   ├── tecnicos.py      # /api/technicians/
│       │   ├── equipamentos.py  # /api/equipment/
│       │   ├── planos_manutencao.py  # /api/plans/
│       │   ├── estoque.py       # /api/inventory/   ← stub only
│       │   ├── kpis.py          # /api/kpis/        ← stub only
│       │   ├── alertas.py       # /api/alerts/
│       │   ├── iot.py           # /api/iot/
│       │   ├── usuarios.py      # /api/users/
│       │   └── usinas.py        # /api/plants/
│       ├── core/
│       │   ├── config.py        # Settings from .env
│       │   └── security.py      # JWT encode/decode, bcrypt, get_current_user
│       ├── db/
│       │   ├── base.py          # Base = declarative_base()
│       │   └── session.py       # async engine + get_db dependency
│       ├── models/models.py     # All ORM models (see Section 5)
│       ├── schemas/
│       │   ├── ordem_servico.py    # OSCreate, OSUpdate, OSOut, OSListResponse
│       │   ├── wo_subresources.py  # LaborCreate/Out, WOPartCreate/Out, WOCostCreate/Out, WOActionCreate/Out
│       │   ├── tecnico.py          # TecnicoCreate, TecnicoOut, TecnicoListResponse
│       │   └── equipamento.py      # EquipamentoOut (validation_alias for EN field names)
│       ├── services/            # Business logic (mostly stubs)
│       ├── workers/
│       │   └── iot_consumer.py  # MQTT → TimescaleDB ingestor
│       └── main.py              # FastAPI app, CORS, router registration
├── frontend/
│   └── src/
│       ├── api/
│       │   ├── axios.ts         # baseURL:'', Bearer interceptor, auto-logout on 401
│       │   ├── auth.ts          # POST /api/auth/login (JSON body)
│       │   └── workOrders.ts    # All WO + inventory + equipment API calls
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── Dashboard.tsx    # KPI cards + recent WOs (Promise.allSettled)
│       │   └── WorkOrders/
│       │       ├── WorkOrderList.tsx
│       │       ├── WorkOrderDetail.tsx
│       │       └── NewWorkOrder.tsx
│       ├── components/
│       │   ├── ui/              # Badge, Spinner, etc.
│       │   ├── charts/          # WOBarChart, WODonutChart (Recharts)
│       │   └── layout/          # Sidebar, Layout wrapper
│       ├── store/
│       │   └── authStore.ts     # Zustand — token in memory ONLY (never localStorage)
│       ├── i18n/
│       │   └── locales/         # en.json, fr.json, es.json
│       └── types/index.ts       # All shared TypeScript interfaces
├── nginx/                       # Reference only — config is embedded in docker-compose.yml command
├── scripts/
│   ├── init_db.sql              # Creates hypertable, indexes
│   └── mosquitto.conf
├── docker-compose.yml
├── .env.example
├── README.md
└── CONTEXT.md                   # ← this file
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

All PKs are UUID. TimescaleDB hypertable on `leituras_iot(timestamp)`.

### Core tables

| Table | Key fields | Notes |
|---|---|---|
| `usinas` | id, codigo, nome, timezone, ativa | Multi-plant root |
| `usuarios` | id, nome, email, senha_hash, idioma, ativo | idioma: pt\|en\|fr |
| `usuario_usinas` | usuario_id, usina_id, papel | papel enum: tecnico\|supervisor\|gestor_usina\|diretor\|admin |
| `equipamentos` | id, usina_id, codigo, nome, localizacao, status, criticidade, hora_metro, especificacoes(JSON) | status enum: operando\|em_manutencao\|parado\|sucateado |
| `planos_manutencao` | id, equipamento_id, nome, tipo_gatilho, intervalo_dias, intervalo_horas, ultima_exec, proxima_exec, checklist(JSON) | Triggers preventive WOs |
| `itens_estoque` | id, usina_id, codigo, nome, unidade, quantidade, quantidade_min, localizacao, custo_unitario, fornecedor | Parts catalog |
| `itens_os` | id, ordem_id, item_estoque_id, quantidade, custo_unitario | Legacy parts consumed per WO |
| `captores` | id, equipamento_id, codigo, tipo, unidade, limite_min, limite_max | Physical IoT sensors |
| `leituras_iot` | id, captor_id, equipamento_id, timestamp, valor, qualidade | **Hypertable** — time-series |
| `alertas` | id, captor_id, equipamento_id, tipo, severidade, valor_lido, mensagem, reconhecido, os_gerada_id | IoT threshold breach |

### `ordens_servico` — full field mapping

| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| numero | VARCHAR(20) UNIQUE | Format: `WO-YYYY-NNNNN` |
| equipamento_id | UUID FK | |
| criado_por_id | UUID FK → usuarios | |
| executado_por_id | UUID FK → usuarios | Primary assigned user |
| executor_id | UUID FK → tecnicos | Primary executing technician profile |
| plano_id | UUID FK → planos_manutencao | nullable |
| tipo | ENUM(TipoOS) | corrective\|preventive\|predictive\|inspection\|improvement |
| prioridade | ENUM(PrioridadeOS) | low\|medium\|high\|critical |
| status | ENUM(StatusOS) | open\|in_progress\|on_hold\|completed\|cancelled |
| titulo | VARCHAR(500) | |
| short_description | VARCHAR(200) | One-liner for lists/notifications |
| descricao | TEXT | Full description |
| causa_raiz | TEXT | Root cause analysis |
| solucao_aplicada | TEXT | Solution applied |
| diagnostic | TEXT | Technical diagnostic notes |
| resolution | TEXT | Resolution steps taken |
| data_abertura | TIMESTAMPTZ | Server default: now() |
| data_prevista | TIMESTAMPTZ | Due date |
| data_inicio | TIMESTAMPTZ | When work actually started |
| data_conclusao | TIMESTAMPTZ | When WO was completed |
| close_date | DATE | Calendar date of close (may differ from data_conclusao TZ) |
| tempo_parada_h | FLOAT | Equipment downtime in hours |
| downtime_minutes | INTEGER | Equipment downtime in minutes (alternative precision) |
| tempo_reparo_h | FLOAT | Labor hours |
| completion_ratio | FLOAT | 0.0–1.0 progress indicator |
| custo_total | FLOAT | Aggregated total cost |
| execution_mode | ENUM(ModoExecucao) | internal\|external\|contract |
| classification | VARCHAR(100) | Maintenance classification code |
| failure_code | VARCHAR(50) | Equipment failure mode code |
| componente | VARCHAR(200) | Specific component/subassembly |
| tag | VARCHAR(100) | Equipment tag / asset label |
| project_number | VARCHAR(100) | Capital project number if applicable |
| cost_center | VARCHAR(100) | Accounting cost center |
| counter_open | FLOAT | Equipment counter reading when WO opened |
| counter_close | FLOAT | Equipment counter reading when WO closed |
| origem_iot | BOOLEAN | Auto-generated from IoT alert |
| alerta_id | UUID FK → alertas | nullable |

### CMMS sub-resource tables (implemented)

| Table | Key fields | Notes |
|---|---|---|
| `tecnicos` | id, user_id(FK unique), employee_number, specialty, shift, hourly_rate, certifications(JSON), active | specialty enum: electromechanical\|mechanical\|electrical\|instrumentation\|welding\|hydraulics; shift: day\|evening\|night\|rotating |
| `labor_records` | id, ordem_id(FK), tecnico_id(FK), date, hours_worked, hourly_rate, labor_cost, activity, notes | Hours per technician per WO |
| `wo_parts` | id, ordem_id(FK), item_estoque_id(FK nullable), part_number, description, quantity, unit, unit_cost, total_cost, supplier | Parts used on WO (richer than itens_os) |
| `wo_costs` | id, ordem_id(FK), transaction_type, description, amount, currency, reference, date | transaction_type enum: local_parts\|labor\|external_parts\|contracts\|rentals\|other |
| `wo_actions` | id, ordem_id(FK), author_id(FK), action_type, content, old_value, new_value | Audit trail: comment\|status_change\|assignment\|attachment |
| `supplier_orders` | id, ordem_id(FK nullable), supplier_name, po_number, amount, currency, status, ordered_at, expected_at, received_at | status enum: pending\|partial\|received\|cancelled |

### Tables to add (next phase)

| Table | Purpose |
|---|---|
| `movimentacoes_estoque` | Stock in/out movements linked to WOs |
| `paradas_maquina` | Machine stop events → corrective WO linkage |

---

## 6. API Routes (current)

### Authentication
```
POST /api/auth/login
  body: { email, password }   ← JSON, not form-encoded
  response: { access_token, token_type, user_id, nome, idioma }
```

### Work Orders — /api/wo/
```
GET    /api/wo/              → { total, items: OSOut[] }   (paginated, filter by status/tipo/prioridade/search)
GET    /api/wo/dashboard     → { total_open, in_progress, on_hold, critical, completed_today, by_type[], by_status[] }
GET    /api/wo/{id}          → OSOut
POST   /api/wo/              → OSOut (201)
PATCH  /api/wo/{id}          → OSOut
POST   /api/wo/{id}/iniciar  → OSOut  (sets status=in_progress, data_inicio)
POST   /api/wo/{id}/concluir → OSOut  (sets status=completed, data_conclusao)

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

### Technicians — /api/technicians/
```
GET    /api/technicians/           → { total, items: TecnicoOut[] }
GET    /api/technicians/{id}       → TecnicoOut
POST   /api/technicians/           → TecnicoOut (201)  body: { user_id, employee_number, specialty, shift, hourly_rate, certifications[] }
```

### Other active routes
```
GET/POST/PATCH /api/equipment/
GET/POST/PATCH /api/plans/
GET/POST       /api/alerts/
GET/POST       /api/iot/
GET/POST/PATCH /api/users/
GET/POST/PATCH /api/plants/
GET            /api/inventory/   ← stub, returns []
GET            /api/kpis/        ← stub, returns []
GET            /api/health
```

---

## 7. Frontend — Key Conventions

### Auth flow
- Login → `POST /api/auth/login` → response contains `{access_token, user_id, nome, idioma}`
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
- `tecnicos` table: extends `usuarios` with `especialidade`, `turno` (morning/afternoon/night), `taxa_horaria` ($/h)
- `registros_labor` table: `(tecnico_id, os_id, horas, data, observacao)` — multiple records per WO (multiple techs)
- API endpoints: assign technician to WO, log hours, calculate labor cost per WO
- Frontend: technician selector on WO form, labor hours entry on WO detail page

**Implementation note:** `executado_por_id` on `ordens_servico` captures primary technician. `registros_labor`
handles the full multi-technician labor record. Both coexist.

### 8.2 Parts Inventory

**Goal:** Full traceability: part → WO → equipment. SAP-ready field mapping.

Current state: `itens_estoque` (catalog) + `itens_os` (consumed per WO) already exist.

Additions needed:
- `movimentacoes_estoque` table: `(item_id, os_id, quantidade, tipo: entrada|saida, data, usuario_id, sap_doc_num)`
  - Every stock change must be recorded here — `itens_estoque.quantidade` is derived from movements
  - `sap_doc_num` field reserved for future SAP integration (goods receipt / goods issue)
- Minimum stock alert: cron job or trigger when `quantidade <= quantidade_min`
- `GET /api/inventory/low-stock` — items below reorder point
- `POST /api/inventory/{id}/movement` — record entry or exit
- Frontend: parts catalog page, stock movement history per part, WO parts consumption tab

**SAP integration note:** When SAP integration is built, `movimentacoes_estoque` maps to SAP MIGO transactions.
Field `sap_material_code` on `itens_estoque` will link to SAP material master. Keep this in mind when
designing the inventory schema — add `sap_material_code VARCHAR(40)` from the start.

### 8.3 KPIs & Reports

**Goal:** Real maintenance performance metrics, not vanity counts.

| KPI | Formula | Source data |
|---|---|---|
| MTBF | Total operating time ÷ number of failures | `paradas_maquina` (operating intervals between stops) |
| MTTR | Total repair time ÷ number of repairs | `ordens_servico.tempo_reparo_h` grouped by equipment |
| Availability % | (Total time − downtime) ÷ Total time × 100 | `paradas_maquina.duracao_h` per equipment per period |
| Cost per equipment | Sum(labor cost + parts cost) | `registros_labor` + `itens_os` grouped by equipment |
| PM compliance % | WOs completed on time ÷ total PMs scheduled × 100 | `ordens_servico` where tipo=preventiva, data_conclusao vs data_prevista |
| Backlog | Open WOs by age bucket (0-7d, 7-30d, 30d+) | `ordens_servico` where status in (aberta, em_andamento) |

**Required new table:**
```sql
paradas_maquina (
  id UUID PK,
  equipamento_id UUID FK → equipamentos,
  os_id UUID FK → ordens_servico NULL,   -- linked corrective WO
  tipo_parada  VARCHAR(30),              -- falha | manutencao_programada | setup | falta_material
  inicio       TIMESTAMPTZ NOT NULL,
  fim          TIMESTAMPTZ,              -- NULL = ongoing
  duracao_h    FLOAT GENERATED,          -- computed from fim - inicio
  origem       VARCHAR(20),             -- manual | iot_alerta | plano_manutencao
  observacao   TEXT
)
```

KPI endpoints (expand `kpis.py` from stub):
```
GET /api/kpis/mtbf?equipamento_id=&periodo_dias=90
GET /api/kpis/mttr?equipamento_id=&periodo_dias=90
GET /api/kpis/availability?equipamento_id=&periodo_dias=30
GET /api/kpis/cost?equipamento_id=&periodo_dias=30
GET /api/kpis/pm-compliance?periodo_dias=30
GET /api/kpis/backlog
```

### 8.4 MES Integration

**Goal:** Maintenance events affect production KPIs. Stops are tracked end-to-end.

**Machine stop → corrective WO flow:**
1. IoT alerta fires (limit exceeded on captor) OR operator manually registers stop
2. System creates `paradas_maquina` record with `inicio = now()`
3. System auto-creates `ordens_servico` (tipo=corretiva, origem_iot=True, prioridade=critica)
4. `paradas_maquina.os_id` links to the generated WO
5. When WO is concluded → `paradas_maquina.fim = data_conclusao`, duration computed
6. This stop feeds MTBF / MTTR / Availability KPIs

**Hour meter → preventive WO trigger:**
- `planos_manutencao.tipo_gatilho = 'horametro'` with `intervalo_horas`
- When `equipamento.hora_metro` crosses threshold → auto-generate preventive WO
- Worker: poll equipment hour meters vs plan thresholds (scheduled task, every 15 min)

**OEE impact:**
- OEE = Availability × Performance × Quality
- Availability component directly derived from `paradas_maquina` per shift
- Performance and Quality come from production counters (future: separate production module)

**Future integrations (don't build yet, design for):**
- Real-time sensor data dashboards (captors already publishing to MQTT)
- SAP MM integration: when inventory reaches reorder point → create SAP PR (purchase requisition)
  via REST API. Field mapping: `itens_estoque.sap_material_code` → SAP material, `usinas.codigo` → SAP plant

---

## 9. Development Phases

```
Phase 1 — CMMS Core (current)
  ✅ Auth, JWT, multi-plant users
  ✅ Work order CRUD (open/start/close lifecycle)
  ✅ Equipment catalog
  ✅ Maintenance plans (calendar + hour-meter triggers)
  ✅ Parts catalog + WO parts consumption
  ✅ IoT ingestion (MQTT → TimescaleDB)
  ✅ Alert generation from sensor limits
  ✅ Frontend: Login, Dashboard, WO list/detail/create
  ✅ Technician profiles (tecnicos table + /api/technicians/)
  ✅ Labor records per WO (/api/wo/{id}/labor)
  ✅ WO parts sub-resource (/api/wo/{id}/parts)
  ✅ WO costs sub-resource (/api/wo/{id}/costs + /costs/summary)
  ✅ WO actions/audit trail (/api/wo/{id}/actions)
  ✅ Supplier orders table
  ✅ 16 new OrdemServico fields (short_description, execution_mode, classification, failure_code, tag, componente, project_number, cost_center, counter_open/close, downtime_minutes, completion_ratio, diagnostic, resolution, close_date)
  ⬜ Inventory management UI (stub backend exists)
  ⬜ KPI calculations (stub backend exists)
  ⬜ Machine stop tracking (paradas_maquina table)

  ⬜ WO Detail page — full tabbed UI (Labor / Parts / Costs / Timeline) [backend ready, frontend stub only]
  ⬜ Technician management UI (create/list technicians) [backend ready]
  ⬜ Fix iot_worker crash — aiomqtt 1.x API change (see Section 13)
  ⬜ Inventory management UI (stub backend exists)
  ⬜ KPI calculations (stub backend exists)
  ⬜ Machine stop tracking (paradas_maquina table)

Phase 2 — Full Maintenance + IoT (3-6 months)
  ⬜ paradas_maquina table + stop registration flow
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
| TimescaleDB hypertable on leituras_iot | IoT time-series queries need time-bucketing and compression — native TimescaleDB feature |
| `docker compose up -d` not `restart` | `restart` reuses existing container config; `command:` overrides only take effect on `up` |

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

- **Backend:** Portuguese table/field names (`ordens_servico`, `equipamento_id`, `data_abertura`). English route paths (`/api/wo/`, `/api/equipment/`). English Python identifiers in business logic.
- **New tables** (tecnicos, labor_records, wo_parts, wo_costs, wo_actions, supplier_orders) use English column names directly — no alias needed.
- **Frontend:** English TypeScript identifiers. Enum values match backend string values exactly (`'open'`, `'in_progress'`, `'corrective'`, etc.).
- **WO number format:** `WO-YYYY-NNNNN` (zero-padded to 5 digits), generated server-side.
- **API responses:** list endpoints always return `{ total: number, items: T[] }`. Single-item endpoints return the object directly. Never a bare array at top level.

---

## 13. Known Bugs (as of 2026-06-05)

| Bug | File | Fix |
|---|---|---|
| `iot_worker` crashes — `TypeError: 'async for' requires an object with __aiter__ method` | `backend/app/workers/iot_consumer.py:92` | `aiomqtt` 1.2.1 changed API. Change `async for message in client.messages:` → `async with client.messages() as messages:` then `async for message in messages:` |
| `fetchTechnicians()` calls `/api/users/` and manually maps `nome→full_name` | `frontend/src/api/workOrders.ts` | Update to call `/api/technicians/` which already returns `full_name` and `email` |
| `WorkOrderDetail.tsx` is a stub — shows only basic fields | `frontend/src/pages/WorkOrders/WorkOrderDetail.tsx` | Full rewrite with Labor / Parts / Costs / Timeline tabs (all backend endpoints ready) |
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
