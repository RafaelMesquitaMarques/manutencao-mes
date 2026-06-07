# Audit Report — Foliot MES
**Date:** 2026-06-07  
**Scope:** Full end-to-end audit of backend routes, frontend pages, API connections, DB model, and flow integrations  
**Status:** Audit only — no fixes applied

---

## Feature/Page Status Table

| Module / Page | Status | Notes |
|---|---|---|
| **Auth — Login** | ✅ Working | JWT flow, Zustand store, 401 auto-logout |
| **Auth — Register / Invite** | ⚠️ Partial | Token shown raw in UI; Plant Access tab is "coming soon" stub |
| **Auth — Forgot/Reset Password** | ✅ Working | Flow intact |
| **Auth — Change Password** | ✅ Working | |
| **Dashboard** | ❌ Broken | `GET /api/wo/dashboard` never reached — route ordering bug; 422 returned |
| **Work Order — List** | ⚠️ Partial | No server-side filters or pagination; all client-side; slow at scale |
| **Work Order — Detail** | ⚠️ Partial | Labor tab shows UUID not name; start/complete return unenriched response |
| **Work Order — New** | ⚠️ Partial | Form silently drops `estimated_hours` and `notes` fields |
| **Tickets — List** | ✅ Working | Auto-refresh, status filters working |
| **Tickets — Detail** | ⚠️ Partial | Comment author is free-text (not auto-filled from auth user); Generate WO crashes if problem_type is null |
| **Ticket → Generate WO flow** | ❌ Broken | `ticket_service.generate_work_order` crashes with `AttributeError` when `problem_type` is `None` (all machine-stop tickets) |
| **Supervisor Dashboard** | ⚠️ Partial | Backend enrichment correct; shows "None" string for problem_type on machine-stop tickets |
| **Labour Scheduler** | ✅ Working | Drag-and-drop assignment, WO detail panel functional |
| **My Work (Technician)** | ⚠️ Partial | `GET /api/technicians/me` unreachable (route ordering bug); `status_not` filter likely ignored by backend |
| **Machines — List** | ✅ Working | Authenticated list with links to kiosk |
| **Machine Page (Kiosk)** | ✅ Working | No auth, stop/restart flow, reject logging, maintenance request |
| **Machine Stop → Maintenance Alert → Ticket flow** | ⚠️ Partial | Stop creates ticket correctly; ticket has `problem_type=None`; Generate WO from such ticket crashes |
| **Alerts — List** | ⚠️ Partial | No alert detail page (no route in App.tsx); assign-to-self only |
| **Alerts — New** | ⚠️ Partial | `created_by` is free-text, not auto-filled from auth user |
| **Alerts → Ticket flow** | ⚠️ Partial | Convert to ticket works, but created ticket has no `problem_type` or `description` from `alert_service` |
| **Maintenance Dashboard (KPI panel)** | ⚠️ Partial | Non-null assertion `data!` can crash if fetch fails silently |
| **KPI Dashboard** | ✅ Working | Endpoints exist, ECharts renders; no plant/equipment filters |
| **PM Calendar** | ❌ Broken | Calls `GET /api/maintenance-plans/` but backend serves at `/api/plans/` — always 404 |
| **Equipment — List** | ⚠️ Partial | "New Equipment" button links `/equipment/new` — no route registered → redirected to /dashboard |
| **Equipment — Detail** | ⚠️ Partial | Plans tab broken (same URL mismatch as PM Calendar); Shifts tab cosmetic only; Indicators tab stub |
| **Equipment Config (stop/reject categories, operators)** | ⚠️ Partial | Operators tab: load uses UUID, add uses page_slug — inconsistent; reorder endpoints unreachable (route ordering bug) |
| **Technicians — List** | ⚠️ Partial | Display only; no edit/delete/detail page |
| **Technicians — New** | ⚠️ Partial | Missing `certifications` field in form |
| **Settings — Users** | ⚠️ Partial | "Deactivate" calls DELETE (hard delete), not PATCH soft-deactivate |
| **Settings — User Detail** | ⚠️ Partial | Plant Access tab is "coming soon"; Permission editor functional |
| **Settings — Stop Categories (global)** | ⚠️ Partial | No delete button; reorder endpoint unreachable (route ordering bug); new categories not flagged `is_global=True` |
| **Settings — My Profile** | ✅ Working | |
| **Settings — Machine Config / Setup** | 🔗 Not connected | Routes redirect to `/equipment`; actual config lives inside EquipmentDetail |
| **Plants management** | ❌ Broken | Entire `/api/plants` router is a stub returning `[]`; no CRUD |
| **Inventory management** | ❌ Broken | Entire `/api/inventory` router is a stub returning `[]`; model exists |
| **IoT / Sensors** | ❌ Broken | Entire `/api/iot` router is a stub returning `[]`; model exists |
| **MES production data** | ❌ Broken | All MES metrics return 0 (mock stubs wired into production endpoint) |
| **Machine CRUD** | ❌ Broken | No POST/PATCH/DELETE `/api/machines` — machines can only be created via seed script |
| **Maintenance Plans CRUD** | ⚠️ Partial | List + create only; no update, delete, or single-record fetch |

---

## Critical Bugs (Will 500 or 422 at runtime)

### 1. Route Ordering Bugs — 6 Endpoints Unreachable

FastAPI matches routes top-to-bottom. When a parameterized route (e.g. `/{id}`) is defined **before** a literal route (e.g. `/dashboard`), the literal is treated as an ID and fails validation.

| Broken Endpoint | Router File | What Happens |
|---|---|---|
| `GET /api/wo/dashboard` | `work_orders.py` | `"dashboard"` matched as `work_order_id` UUID → 422 |
| `GET /api/technicians/me` | `technicians.py` | `"me"` matched as `technician_id` UUID → 422 |
| `PATCH /api/machines/{ref}/stop-categories/reorder` | `machines.py` | `"reorder"` matched as `cat_id` UUID → 422 |
| `PATCH /api/machines/{ref}/reject-categories/reorder` | `machines.py` | same → 422 |
| `PATCH /api/stop-categories/reorder` | `stop_categories.py` | `"reorder"` matched as `cat_id` UUID → 422 |
| `PATCH /api/stop-categories/subcategories/reorder` | `stop_categories.py` | same → 422 |

**Fix:** Move each literal route definition **above** the parameterized one in the same router file.

**Impact:** Dashboard page broken entirely. My Work page broken for technicians. All reorder drag-drop broken in category editors.

---

### 2. `generate_work_order` Crashes on Machine-Stop Tickets

**File:** `backend/app/services/ticket_service.py`, line ~130  
**Code:** `ticket.problem_type.value`  
**Problem:** `problem_type` is `None` for all tickets created from machine stops (set by `machines.py` stop handler). Calling `.value` on `None` raises `AttributeError`.

**Impact:** The entire "Generate WO" button in Supervisor Dashboard crashes with HTTP 500 for every ticket that originated from a machine stop — which is the primary intended flow.

---

### 3. Maintenance Plans URL Mismatch (Frontend vs Backend)

| Side | URL |
|---|---|
| Backend registered prefix | `/api/plans` |
| Frontend API calls | `/api/maintenance-plans/` |

**Affected files:** `frontend/src/api/workOrders.ts` (`fetchMaintenancePlans`), `PMCalendar.tsx`, `EquipmentDetail.tsx`

**Impact:** PM Calendar is always blank. Equipment detail Plans tab always empty. These pages silently fail.

---

### 4. `RejectLog` Column Name Mismatch (ORM vs Migration DDL)

**Migration DDL** (`main.py`) creates `reject_logs` with columns: `category_id`, `subcategory_id`, `comment`  
**ORM model** (`models.py`) maps to: `reject_category_id`, `reject_subcategory_id`, `comments`

**Impact:** When the DB is initialized via `Base.metadata.create_all` (ORM wins) the table gets the ORM names. But if any migration run created it first, inserts will reference non-existent columns.

---

### 5. Seed Script Creates Admin with `role='operator'`

**File:** `backend/scripts/seed.py`  
**Problem:** The `User` object is created without explicitly setting `role='admin'`. The DB default is `'operator'`. The seeded `admin@foliot.com` account cannot access any admin-protected endpoints until the DB is manually patched.

**Impact:** After a fresh seed + reset, the system has no usable admin account.

---

## High-Impact Bugs (Feature Broken or Data Silent-Dropped)

### 6. Three Fully Stubbed Routers

| Router | Prefix | Status |
|---|---|---|
| `plants.py` | `/api/plants` | Returns `[]` — no implementation |
| `inventory.py` | `/api/inventory` | Returns `[]` — StockItem model exists but no CRUD |
| `iot.py` | `/api/iot` | Returns `[]` — Sensor/SensorReading models exist but no CRUD |

---

### 7. No Machine CRUD

There is no `POST /api/machines`, `PATCH /api/machines/{id}`, or `DELETE /api/machines/{id}`. The `GET /api/machines/{ref}/config` PATCH exists for display settings only. Machines can only be created via `seed.py`.

**Impact:** Admin cannot onboard new machines without direct DB access.

---

### 8. `POST /api/stop-categories/` Does Not Set `is_global=True`

**File:** `backend/app/api/routes/stop_categories.py`  
New global categories created via this endpoint have `is_global=False`. The machine kiosk page fallback logic filters `is_global==True` — so newly created categories never appear on any machine page.

---

### 9. `NewWorkOrder.tsx` Silently Drops Form Fields

Form collects `estimated_hours` and `notes` but the `createWorkOrder()` call does not include them. Data is silently discarded on submit.

---

### 10. `WorkOrderDetail.tsx` LaborTab Shows UUIDs Not Names

`LaborRecord` has no `technician_name` field. The tab renders `r.technician_id.slice(0, 8)…`. Technician names are completely invisible.

---

### 11. `MyWorkPage` — `status_not` Filter Likely Ignored

The WO fetch uses `status_not=completed,cancelled` as a query parameter. Backend `GET /api/wo/` has no `status_not` filter implemented. All WOs are returned including completed/cancelled ones. Technicians see a cluttered list with all historical orders.

---

### 12. "New Equipment" Button Has No Route

`EquipmentList.tsx` links to `/equipment/new`. `App.tsx` has no such route. React Router wildcard catches it and redirects to `/dashboard`. The button appears functional but does nothing useful.

---

### 13. `alert_service.convert_to_ticket` Creates Incomplete Tickets

`alert_service.py` creates a `TicketCreate` without `problem_type` or `description`. Tickets converted from alerts always have `problem_type=None`. This then propagates the crash in `generate_work_order` described in Bug #2.

---

## Medium Bugs (Degraded Behavior / UX Issues)

### 14. Work Order Mutations Return Unenriched Responses

`PATCH /api/wo/{id}`, `POST /api/wo/{id}/start`, and `POST /api/wo/{id}/complete` all return `return wo` directly without calling `_enrich_wo()`. Responses are missing `equipment_name`, `executor_name`, and `ticket_number`. Frontend detail page must re-fetch to show updated names.

### 15. `completeWorkOrder` Sends Fields as Query Params

`repair_hours`, `root_cause`, `solution_applied`, `downtime_hours` are passed as query params on `POST /api/wo/{id}/complete`. Backend also expects these as query params (not body). The pattern is unusual and fragile — a proxy or firewall may strip query params from POST requests.

### 16. N+1 Query Patterns (Performance)

Individual `db.get()` calls inside loops in: `GET /api/tickets/`, `GET /api/maintenance/dashboard`, `GET /api/maintenance/supervisor`, `GET /api/machines/{ref}/page`. Will degrade severely as data grows.

### 17. Supervisor Dashboard Shows `"None"` as String for Problem Type

When `problem_type` is `None`, `supervisor_overview` emits `str(None) = "None"` as the problem type string. Frontend renders this literally as the text "None" in the ticket cards.

### 18. Maintenance Dashboard Non-Null Assertion Risk

`MaintenanceDashboard.tsx` line ~99 uses `const d = data!`. If data fetch fails silently (network error caught but state left as `null`), the non-null assertion causes a runtime crash instead of an error state.

### 19. Comment/Alert Author Not Auto-Populated

`TicketDetail.tsx` — comment `author` is a free-text input field, not populated from the auth user.  
`NewAlert.tsx` — `created_by` is a free-text input, not populated from the auth user.  
Both allow attribution to any name.

### 20. EquipmentDetail OperatorsTab Uses Inconsistent Path Param

Load operators: `GET /api/machines/{machineId}/operators` (UUID)  
Add operator: `addMachineOperator(machineRef, ...)` where `machineRef = machine.page_slug || machine.id`  
If `page_slug` is set, load uses UUID while add uses slug — one will 404.

### 21. `DELETE /api/users/{id}` Used as "Deactivate"

`UsersSetup.tsx` calls `deleteUser` for a button labeled "Deactivate". The backend `DELETE /api/users/{id}` sets `active=False` (soft delete), but a hard-delete label in the UI may confuse admins.

### 22. Duplicate User-Plant Assignment Possible

`POST /api/users/{id}/plants/{plant_id}` doesn't check for existing rows — calling it twice creates duplicate `user_plants` entries.

### 23. `PlanCreate` Raises 500 on Invalid UUID

`maintenance_plans.py` catches `ValueError` from `UUID(data.equipment_id)` unhandled — invalid equipment_id input returns HTTP 500 instead of 422.

---

## Not Connected / Stub Features

| Feature | Location | Notes |
|---|---|---|
| Alert detail page | `AlertList.tsx` | No route `/alerts/:id` in `App.tsx` — clicking a row has no destination |
| Technician edit/delete/detail | `TechnicianList.tsx` | List is read-only; no detail page |
| `certifications` field on technician | `NewTechnician.tsx` | Field in type but absent from form |
| Plant Access tab | `UserDetail.tsx` | "Plant assignment management coming soon" |
| Activity tab (real log) | `UserDetail.tsx` | Only shows `last_login_at` + `invited_at` |
| Equipment Indicators sub-tab | `EquipmentDetail.tsx` | "coming soon" stub |
| Equipment Shifts sub-tab | `EquipmentDetail.tsx` | UI only — no save, no API call; data never persisted |
| PM Plan click → navigation | `PMCalendar.tsx` | Plan event click does nothing; only WO events navigate |
| Create PM Plan from calendar | `PMCalendar.tsx` | No button or action exists |
| MES production counts | `MachinePage.tsx` | `get_mock_production_count()` always returns 0; no production recording endpoint |
| Historical stops per machine | `machines.py` | Only `GET /{ref}/stops/today` — no historical view |
| Supplier orders | `models.py` | `SupplierOrder` model exists; no routes |
| RBAC on sidebar nav | `Sidebar.tsx` | All roles see all nav items; only user management is admin-gated |
| Language persistence | `Header.tsx` | Language dropdown changes client locale but doesn't call PATCH `/api/auth/me` to persist |
| `workOrderStore.ts` | Store | `upsertWorkOrder`/`addWorkOrder` methods are dead code — never called by any page |
| Invite list for admins | `auth.py` | Admin cannot view or revoke pending invitations |

---

## Missing API Endpoints (Frontend Needs, Backend Lacks)

| Endpoint | Needed By |
|---|---|
| `POST /api/machines` | Admin machine onboarding |
| `PATCH /api/machines/{id}` (general) | Machine name/settings management |
| `DELETE /api/machines/{id}` | Machine deactivation |
| `GET /api/machines/{id}/stops` (historical) | Machine maintenance history |
| `PATCH /api/technicians/{id}` | Technician profile editing |
| `DELETE /api/technicians/{id}` | Technician deactivation |
| `PATCH /api/plans/{id}` | Edit maintenance plan |
| `DELETE /api/plans/{id}` | Deactivate plan |
| `GET /api/plans/{id}` | Single plan fetch |
| `GET /api/alerts/{id}` | Alert detail page |
| `PATCH /api/alerts/{id}` | Edit alert priority/status directly |
| All CRUD for `/api/inventory` | Inventory management UI |
| All CRUD for `/api/plants` | Multi-plant management |
| `GET /api/wo/` filter `status_not` | My Work technician view |
| `GET /api/wo/{id}/labor` — technician names | Labor tab on WO Detail |

---

## Prioritized Fix List

| Priority | Fix | Impact |
|---|---|---|
| **P0** | Fix 6 route ordering bugs (literal routes before parameterized) | Dashboard broken, My Work broken, all reorder broken |
| **P0** | Guard `problem_type` for `None` in `ticket_service.generate_work_order` | Generate WO crashes for all machine-stop tickets |
| **P0** | Change frontend API base for maintenance plans: `/api/maintenance-plans/` → `/api/plans/` | PM Calendar and Equipment plans tab always blank |
| **P0** | Set `role='admin'` explicitly in `seed.py` | Fresh deploy has no working admin account |
| **P1** | Fix `stop_categories.py` POST to set `is_global=True` | New global categories invisible on kiosk |
| **P1** | Fix `alert_service.convert_to_ticket` to pass `problem_type` and `description` | Alert→Ticket→WO full chain broken |
| **P1** | Add `estimated_hours` and `notes` to `createWorkOrder()` call in `NewWorkOrder.tsx` | Form fields silently dropped |
| **P1** | Enrich WO response on start/complete/patch mutations (`_enrich_wo`) | Frontend shows stale/incomplete data |
| **P1** | Fix EquipmentList "New Equipment" route (`/equipment/new`) or add the route | Button is dead |
| **P1** | Align RejectLog ORM column names with DDL migration | Reject log inserts may fail |
| **P2** | Add `technician_name` to `LaborRecord` response schema | Labor tab shows raw UUIDs |
| **P2** | Implement `status_not` filter on `GET /api/wo/` | My Work loads all WOs including completed |
| **P2** | Auto-populate comment author and alert `created_by` from auth user | Security + UX |
| **P2** | Add `POST /api/machines`, `PATCH /api/machines/{id}` | Admin cannot create/edit machines |
| **P2** | Implement full `/api/inventory` CRUD | Inventory module is a stub |
| **P2** | Implement full `/api/plants` CRUD | Multi-plant is non-functional |
| **P2** | Fix OperatorsTab to use consistent path param (slug or UUID, pick one) | Operator add may 404 |
| **P2** | Fix `MaintenanceDashboard.tsx` non-null assertion → show error state | Silent crash possible |
| **P3** | Add `PATCH /api/plans/{id}`, `DELETE /api/plans/{id}`, `GET /api/plans/{id}` | Plans cannot be edited |
| **P3** | Add alert detail route `/alerts/:id` | Alert rows are unclickable |
| **P3** | Add technician edit/detail page | Technician list is read-only |
| **P3** | Fix duplicate user-plant assignment (check before insert) | Data integrity |
| **P3** | Add `no plant_id` FK on machines — or document intentional global scope | Design gap |
| **P3** | Resolve N+1 query patterns with JOIN-based queries | Performance at scale |
| **P3** | Implement `/api/iot` CRUD | IoT module is a stub |
| **P4** | Wire language change in Header to PATCH `/api/auth/me` | Language preference not persisted |
| **P4** | Add RBAC filtering on sidebar nav items | All users see all modules |
| **P4** | Implement Equipment WorkShiftsTab save API | Shifts UI is cosmetic only |
| **P4** | Add plant_id filters to KPI endpoints | KPIs are globally unscoped |
| **P4** | Add production recording endpoint for MES panel | Production count always 0 |
| **P4** | Replace `datetime.utcnow()` with `datetime.now(timezone.utc)` throughout | Python 3.12 deprecation warning |
